<?php
if (!defined('AQUA')) { http_response_code(403); exit('forbidden'); }

/**
 * GPU transcribe — AquaChord ↔ aixman partner API (docs/09 §3 + §6)
 *
 * - ตั้งค่าการเชื่อมต่อเก็บที่ <domain>/private/aixman.json (นอก webroot, 0600, ไม่ commit)
 *   public_html/api/lib/gpu.php → ../../../private/aixman.json (แบบเดียวกับ db.php)
 * - เรียก aixman ด้วย cURL เท่านั้น: https + host allowlist, ไม่ตาม redirect, timeout ชัดเจน
 * - ดึงผล JSON เฉพาะ host ที่เรียนรู้จาก aixman (R2 public host) + IP สาธารณะเท่านั้น (กัน SSRF)
 * - ห้าม log/คืน partner key, body ดิบ หรือ URL ภายในให้ client — error เป็นข้อความไทยทั่วไป
 * - ฟังก์ชันที่ไม่แตะ DB/เครือข่าย (sniff/URL/validate/keyHint) แยกไว้ให้ tools/test-gpu-php.php เทสต์ได้
 */

const GPU_ALLOWED_HOSTS        = ['ai.xman4289.com'];
const GPU_DEFAULT_BASE         = 'https://ai.xman4289.com';
const GPU_API_PREFIX           = '/api/partner/v1';
const GPU_MODES                = ['open', 'sheetsage2'];
const GPU_LANGS                = ['th', 'auto', 'en'];
const GPU_MAX_UPLOAD_BYTES     = 64 * 1024 * 1024;   // เพดานฝั่งเรา (ต่ำกว่านี้ถ้า ping บอกเพดาน aixman)
const GPU_MAX_RESULT_BYTES     = 5 * 1024 * 1024;
const GPU_MAX_API_BYTES        = 1024 * 1024;        // response JSON ของ partner API
const GPU_MAX_LYRICS           = 5000;
const GPU_MAX_TITLE            = 200;
const GPU_MAX_ACTIVE_PER_ADMIN = 2;
const GPU_ACTIVE_WINDOW_MS     = 6 * 3600 * 1000;    // งานค้างเกิน 6 ชม. ไม่นับเป็น active (กันงานที่ไม่มีใคร poll ล็อกโควต้าถาวร)
const GPU_UPLOAD_STALE_MS      = 15 * 60 * 1000;     // แถว 'uploading' ที่ไม่มี remote_id เกิน 15 นาที = request ตายกลางทาง
const GPU_POLL_MIN_MS          = 3000;               // poll aixman ได้ไม่ถี่กว่า 3 วิ/งาน
const GPU_PING_CACHE_MS        = 15000;              // GET /gpu/config ใช้ผล ping เดิมถ้ายังไม่เกิน 15 วิ
const GPU_DEDUPE_MS            = 120000;             // กดส่งซ้ำ (ไฟล์+โหมด+เนื้อเดิม) ภายใน 2 นาที = คืนงานเดิม
const GPU_TIMEOUT_CONNECT      = 5;
const GPU_TIMEOUT_UPLOAD       = 120;
const GPU_TIMEOUT_DEFAULT      = 20;
const GPU_MAX_RESULT_HOSTS     = 4;
// สถานะในแถวของเรา: 'uploading' (ก่อนได้ remote id) + สถานะของ aixman ด้านล่าง
const GPU_REMOTE_STATUSES     = ['queued', 'starting', 'rendering', 'completed', 'failed', 'cancelled'];

/** error ที่ส่งต่อให้ client ได้ (ข้อความไทยทั่วไป ไม่มี URL/body/key) */
final class GpuError extends RuntimeException {
    public function __construct(
        public readonly string $errCode,
        string $message,
        public readonly int $http = 502,
        public readonly bool $transient = false
    ) {
        parent::__construct($message);
    }
}

/* ======================================================================
 *  pure helpers (ไม่มี I/O) — เทสต์ใน tools/test-gpu-php.php
 * ====================================================================== */

/** ตรวจ magic bytes ของไฟล์เสียง (ไม่เชื่อ MIME/นามสกุลจาก client) → ['ext','type'] หรือ null */
function gpu_sniff_audio(string $head): ?array {
    if (strlen($head) < 12) return null;
    if (strncmp($head, 'ID3', 3) === 0) return ['ext' => 'mp3', 'type' => 'audio/mpeg'];
    if (strncmp($head, 'RIFF', 4) === 0 && substr($head, 8, 4) === 'WAVE') return ['ext' => 'wav', 'type' => 'audio/wav'];
    if (strncmp($head, 'fLaC', 4) === 0) return ['ext' => 'flac', 'type' => 'audio/flac'];
    if (strncmp($head, 'OggS', 4) === 0) return ['ext' => 'ogg', 'type' => 'audio/ogg'];
    if (substr($head, 4, 4) === 'ftyp') {
        // MP4/M4A container — กันรูป HEIF/AVIF ที่ใช้ ftyp เหมือนกัน
        $brand = substr($head, 8, 4);
        if (in_array($brand, ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis', 'crx '], true)) return null;
        if (!preg_match('/^[\x20-\x7e]{4}$/', $brand)) return null;
        return ['ext' => 'm4a', 'type' => 'audio/mp4'];
    }
    // MPEG audio frame sync (ไม่มี ID3): 11 bit sync, version != reserved, layer != 00 (00 = ADTS AAC)
    $b0 = ord($head[0]); $b1 = ord($head[1]); $b2 = ord($head[2]);
    if ($b0 === 0xFF && ($b1 & 0xE0) === 0xE0) {
        $ver = ($b1 >> 3) & 0x3; $layer = ($b1 >> 1) & 0x3;
        $br = ($b2 >> 4) & 0xF; $sr = ($b2 >> 2) & 0x3;
        if ($ver !== 1 && $layer !== 0 && $br !== 0xF && $sr !== 0x3) return ['ext' => 'mp3', 'type' => 'audio/mpeg'];
    }
    return null;
}

/** hostname DNS ปกติ (ตัวเล็ก, มีจุด, TLD เป็นตัวอักษร) — ไม่รับ IP literal/localhost/IDN/%-encode */
function gpu_valid_hostname(string $h): bool {
    if ($h === '' || strlen($h) > 253) return false;
    if (filter_var($h, FILTER_VALIDATE_IP) !== false) return false;
    return (bool) preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/', $h);
}

/**
 * แยก + ตรวจ URL แบบเข้ม แล้ว "ประกอบใหม่เอง" (กัน parser differential ระหว่าง parse_url กับ cURL)
 * ต้องเป็น https, ไม่มี userinfo, port ว่างหรือ 443, host เป็นชื่อ DNS, path/query เป็นอักขระ RFC 3986 เท่านั้น
 * @return array{url:string,host:string,path:string}|null
 */
function gpu_parse_https_url(string $url): ?array {
    if ($url === '' || strlen($url) > 2048) return null;
    if (preg_match('/[\x00-\x20\x7f\\\\]/', $url)) return null;          // ช่องว่าง/control/backslash
    if (!preg_match('#^https://#i', $url)) return null;
    $p = parse_url($url);
    if (!is_array($p) || strtolower($p['scheme'] ?? '') !== 'https') return null;
    if (isset($p['user']) || isset($p['pass']) || isset($p['fragment'])) return null;
    if (isset($p['port']) && (int) $p['port'] !== 443) return null;
    $host = strtolower($p['host'] ?? '');
    if (!gpu_valid_hostname($host)) return null;
    // authority ต้องเป็น host[:443] ตรง ๆ เท่านั้น (กัน @ และ trick แปลก ๆ ที่ parse_url มองไม่เห็น)
    if (!preg_match('#^https://([^/?\#]*)#i', $url, $m)) return null;
    $auth = strtolower($m[1]);
    if ($auth !== $host && $auth !== $host . ':443') return null;
    $path = $p['path'] ?? '';
    if ($path !== '' && !preg_match('#^/[A-Za-z0-9\-._~!$&\'()*+,;=:@/%]*$#', $path)) return null;
    if (preg_match('#(^|/)\.\.?(/|$)#', $path)) return null;             // ห้าม dot-segment
    $query = $p['query'] ?? null;
    if ($query !== null && !preg_match('#^[A-Za-z0-9\-._~!$&\'()*+,;=:@/?%]*$#', $query)) return null;
    $rebuilt = 'https://' . $host . ($path === '' ? '/' : $path) . ($query !== null && $query !== '' ? '?' . $query : '');
    return ['url' => $rebuilt, 'host' => $host, 'path' => $path === '' ? '/' : $path];
}

/** baseUrl ที่อนุญาต → คืนรูปมาตรฐาน 'https://host' หรือ null */
function gpu_normalize_base_url(string $u): ?string {
    $u = trim($u);
    $u = rtrim($u, '/');
    $p = gpu_parse_https_url($u === '' ? '' : $u . '/');
    if (!$p || $p['path'] !== '/' || str_contains($p['url'], '?')) return null;
    if (!in_array($p['host'], GPU_ALLOWED_HOSTS, true)) return null;
    return 'https://' . $p['host'];
}

/** ตรวจ resultUrl: https + host ต้องอยู่ในชุดที่เรียนรู้จาก aixman → คืน parsed หรือ null */
function gpu_check_result_url(string $url, array $allowedHosts): ?array {
    $p = gpu_parse_https_url($url);
    if (!$p) return null;
    $ok = array_map('strtolower', array_filter($allowedHosts, 'is_string'));
    return in_array($p['host'], $ok, true) ? $p : null;
}

/** IP สาธารณะเท่านั้น (ไม่ใช่ private/loopback/link-local/reserved/CGNAT) */
function gpu_ip_is_public(string $ip): bool {
    $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
    if (defined('FILTER_FLAG_GLOBAL_RANGE')) $flags |= FILTER_FLAG_GLOBAL_RANGE;
    if (filter_var($ip, FILTER_VALIDATE_IP, $flags) === false) return false;
    // กันช่วงที่ filter บางเวอร์ชันไม่ครอบ: 0/8, 100.64/10 (CGNAT), 198.18/15 (benchmark)
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        $n = ip2long($ip);
        foreach ([['0.0.0.0', 8], ['100.64.0.0', 10], ['198.18.0.0', 15], ['169.254.0.0', 16], ['127.0.0.0', 8]] as [$net, $bits]) {
            $mask = -1 << (32 - $bits);
            if (($n & $mask) === (ip2long($net) & $mask)) return false;
        }
    }
    return true;
}

/** partner key: อักขระปลอดภัยสำหรับ header เท่านั้น (กัน header injection) */
function gpu_valid_partner_key(string $k): bool {
    return (bool) preg_match('/^[A-Za-z0-9._~+\/=-]{20,256}$/', $k);
}

/** โชว์แค่ 4 ตัวท้าย */
function gpu_key_hint(string $k): ?string {
    if ($k === '') return null;
    return '…' . substr($k, -4);
}

/** ข้อความสั้นบรรทัดเดียวจาก remote/ผู้ใช้: UTF-8 ถูกต้อง, ตัด control char, ยุบช่องว่าง, จำกัดความยาว */
function gpu_clean_text($s, int $max): ?string {
    if (!is_string($s) || !mb_check_encoding($s, 'UTF-8')) return null;
    $s = preg_replace('/[\x00-\x08\x0B-\x1F\x7F]/u', '', $s) ?? '';
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    return $s === '' ? null : mb_substr($s, 0, $max);
}

/** ข้อความ error จาก aixman — ตัด URL/path ภายในทิ้งก่อนเก็บ/โชว์ */
function gpu_clean_error($s): ?string {
    $s = gpu_clean_text($s, 600);
    if ($s === null) return null;
    $s = preg_replace('#\b[a-z][a-z0-9+.\-]*://\S+#i', '[ลิงก์]', $s) ?? '';
    $s = preg_replace('#(?:[A-Za-z]:\\\\|/)[\w.\-]+(?:[\\\\/][\w.\-]+)+#u', '[path]', $s) ?? '';
    return mb_substr(trim($s), 0, 300);
}

/** เนื้อเพลงจากผู้ใช้: คง \n/\t, ตัด control อื่น, CRLF→LF — คืน null ถ้า encoding เสีย */
function gpu_clean_lyrics($s): ?string {
    if ($s === null || $s === '') return '';
    if (!is_string($s) || !mb_check_encoding($s, 'UTF-8')) return null;
    $s = str_replace(["\r\n", "\r"], "\n", $s);
    $s = preg_replace('/[\x00-\x08\x0B-\x1F\x7F]/u', '', $s) ?? '';
    return trim($s);
}

/** ชื่อไฟล์เพื่อแสดงผลเท่านั้น (ไม่เคยใช้เป็น path) */
function gpu_display_filename($name): string {
    $n = is_string($name) ? $name : '';
    $n = str_replace('\\', '/', $n);
    $n = basename($n);
    return gpu_clean_text($n, 200) ?? 'audio';
}

/** ค่า ini แบบ 64M → bytes */
function gpu_ini_bytes($v): int {
    $v = trim((string) $v);
    if ($v === '') return 0;
    $n = (float) $v;
    switch (strtolower(substr($v, -1))) {
        case 'g': $n *= 1024;
        case 'm': $n *= 1024;
        case 'k': $n *= 1024;
    }
    return (int) $n;
}

/**
 * ตรวจผลลัพธ์ TranscriptionResult v1 (docs/09 §4)
 * decode เป็น object (คง {} ว่างไว้ไม่ให้กลายเป็น []) + จำกัดความลึก
 */
function gpu_validate_result(string $raw): ?stdClass {
    if ($raw === '' || strlen($raw) > GPU_MAX_RESULT_BYTES) return null;
    try {
        $d = json_decode($raw, false, 32, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        return null;
    }
    if (!($d instanceof stdClass)) return null;
    if (($d->format ?? null) !== 'aquachord-transcription') return null;
    if (($d->version ?? null) !== 1) return null;
    if (isset($d->mode) && !in_array($d->mode, GPU_MODES, true)) return null;
    foreach (['beats', 'downbeats', 'chords', 'sections', 'warnings'] as $k) {
        if (isset($d->$k) && !is_array($d->$k)) return null;
    }
    return $d;
}

/** แปลง job ของ aixman เป็น field ที่ผ่านการตรวจแล้ว (ไม่เชื่อชนิดข้อมูลจาก remote) */
function gpu_remote_job($j): ?array {
    if (!is_array($j)) return null;
    $id = $j['id'] ?? null;
    if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $id)) return null;
    $num = fn($v) => is_int($v) || is_float($v) ? $v : null;
    $st = $j['status'] ?? null;
    $progress = $num($j['progress'] ?? null);
    $eta = $num($j['etaSeconds'] ?? null);
    $qp = $num($j['queuePosition'] ?? null);
    $gs = $num($j['gpuSeconds'] ?? null);
    return [
        'id'            => $id,
        'status'        => is_string($st) && in_array($st, GPU_REMOTE_STATUSES, true) ? $st : null,
        'stageLabel'    => gpu_clean_text($j['stageLabel'] ?? null, 200),
        'progress'      => $progress === null ? null : max(0.0, min(1.0, (float) $progress)),
        'etaSeconds'    => $eta === null ? null : (int) max(0, min(7 * 86400, $eta)),
        'queuePosition' => $qp === null ? null : (int) max(0, min(100000, $qp)),
        'resultUrl'     => is_string($j['resultUrl'] ?? null) ? $j['resultUrl'] : null,
        'errorMessage'  => gpu_clean_error($j['errorMessage'] ?? null),
        'gpuSeconds'    => $gs === null ? null : max(0.0, min(1e7, (float) $gs)),
    ];
}

/** ผล ping → เฉพาะ field ที่ whitelist (ไม่ส่ง body ดิบต่อ) */
function gpu_remote_ping($p): array {
    $p = is_array($p) ? $p : [];
    $int = fn($v, $max) => is_int($v) || is_float($v) ? (int) max(0, min($max, $v)) : null;
    $lim = is_array($p['limits'] ?? null) ? $p['limits'] : [];
    $use = is_array($p['usage'] ?? null) ? $p['usage'] : [];
    $model = is_array($p['model'] ?? null) ? $p['model'] : [];
    $dm = $p['defaultMode'] ?? 'open';
    return [
        'enabled'         => ($p['enabled'] ?? false) === true,
        'model'           => ['key' => gpu_clean_text($model['key'] ?? null, 64), 'readiness' => gpu_clean_text($model['readiness'] ?? null, 32)],
        'allowSheetSage2' => ($p['allowSheetSage2'] ?? false) === true,
        'defaultMode'     => in_array($dm, GPU_MODES, true) ? $dm : 'open',
        'limits'          => [
            'maxAudioMb'    => $int($lim['maxAudioMb'] ?? null, 4096),
            'maxSeconds'    => $int($lim['maxSeconds'] ?? null, 86400),
            'maxJobsPerDay' => $int($lim['maxJobsPerDay'] ?? null, 100000),
            'maxActiveJobs' => $int($lim['maxActiveJobs'] ?? null, 1000),
        ],
        'usage'           => [
            'jobsToday'  => $int($use['jobsToday'] ?? null, 1000000),
            'activeJobs' => $int($use['activeJobs'] ?? null, 100000),
        ],
        'pingedAt'        => now_ms(),
    ];
}

/** แปลง HTTP status + error.code ของ aixman → GpuError ข้อความไทย (ไม่แนบ body) */
function gpu_remote_error(int $status, $code): GpuError {
    $c = is_string($code) ? strtoupper($code) : '';
    if ($c === 'BAD_KEY' || $status === 401)
        return new GpuError('GPU_BAD_KEY', 'Partner key ไม่ถูกต้องหรือถูกยกเลิกแล้ว — ตั้งค่าการเชื่อมต่อ GPU ใหม่ในหลังบ้าน', 502);
    if ($c === 'DISABLED' || $c === 'PAUSED' || $status === 503)
        return new GpuError('GPU_DISABLED', 'ระบบ GPU ของ aixman ปิดให้บริการชั่วคราว กรุณาลองใหม่ภายหลัง', 503, true);
    if ($c === 'MODE_NOT_ALLOWED')
        return new GpuError('GPU_MODE_NOT_ALLOWED', 'โหมด SheetSage2 ยังไม่ได้เปิดใช้ที่ฝั่ง aixman', 403);
    if ($c === 'DAILY_LIMIT')
        return new GpuError('GPU_DAILY_LIMIT', 'ใช้งาน GPU ครบโควต้าของวันนี้แล้ว (นับตามวัน UTC)', 429);
    if ($c === 'ACTIVE_LIMIT')
        return new GpuError('GPU_ACTIVE_LIMIT', 'เซิร์ฟเวอร์ GPU มีงานของเราทำอยู่เต็มจำนวนแล้ว รอให้งานก่อนหน้าเสร็จก่อน', 429);
    if ($status === 429)
        return new GpuError('GPU_RATE_LIMITED', 'ส่งคำขอถี่เกินไป กรุณารอสักครู่', 429, true);
    if ($c === 'TOO_LARGE' || $status === 413)
        return new GpuError('GPU_TOO_LARGE', 'ไฟล์เสียงใหญ่เกินเพดานของเซิร์ฟเวอร์ GPU', 413);
    if ($c === 'NOT_FOUND' || $status === 404)
        return new GpuError('GPU_NOT_FOUND', 'ไม่พบงานนี้บนเซิร์ฟเวอร์ GPU (อาจหมดอายุแล้ว)', 404);
    if ($status === 409)
        return new GpuError('GPU_CONFLICT', 'งานเริ่มประมวลผลแล้ว ยกเลิกไม่ได้', 409);
    if ($c === 'BAD_INPUT' || $status === 400 || $status === 422)
        return new GpuError('GPU_BAD_INPUT', 'เซิร์ฟเวอร์ GPU ไม่รับข้อมูลนี้ (ไฟล์เสียงหรือข้อความไม่ถูกต้อง)', 400);
    if ($status === 403)
        return new GpuError('GPU_FORBIDDEN', 'เซิร์ฟเวอร์ GPU ปฏิเสธคำขอนี้', 403);
    if ($status >= 500)
        return new GpuError('GPU_REMOTE_ERROR', 'เซิร์ฟเวอร์ GPU ขัดข้องชั่วคราว กรุณาลองใหม่', 502, true);
    return new GpuError('GPU_BAD_RESPONSE', 'เซิร์ฟเวอร์ GPU ตอบกลับผิดรูปแบบ', 502);
}

/* ======================================================================
 *  config file — <domain>/private/aixman.json
 * ====================================================================== */

function gpu_config_path(): string {
    return dirname(__DIR__, 3) . '/private/aixman.json';
}

/** อ่าน + ตรวจซ้ำทุกครั้ง (ไฟล์ถูกแก้มือ/ถูกดัดแปลง → ค่าที่ไม่ผ่านถูกทิ้ง) */
function gpu_config_read(?string $path = null): array {
    $path = $path ?? gpu_config_path();
    if (!is_file($path)) return [];
    $raw = @file_get_contents($path, false, null, 0, 65536);
    if (!is_string($raw) || $raw === '') return [];
    $j = json_decode($raw, true, 8);
    if (!is_array($j)) return [];
    $out = [];
    $base = is_string($j['baseUrl'] ?? null) ? gpu_normalize_base_url($j['baseUrl']) : null;
    $out['baseUrl'] = $base ?? GPU_DEFAULT_BASE;
    $out['baseUrlValid'] = $base !== null || !isset($j['baseUrl']);
    $key = is_string($j['partnerKey'] ?? null) ? $j['partnerKey'] : '';
    $out['partnerKey'] = gpu_valid_partner_key($key) ? $key : '';
    $out['defaultMode'] = in_array($j['defaultMode'] ?? '', GPU_MODES, true) ? $j['defaultMode'] : 'open';
    $out['updatedAt'] = is_int($j['updatedAt'] ?? null) ? $j['updatedAt'] : null;
    $hosts = [];
    foreach ((is_array($j['resultHosts'] ?? null) ? $j['resultHosts'] : []) as $h) {
        if (is_string($h) && gpu_valid_hostname($h) && count($hosts) < GPU_MAX_RESULT_HOSTS) $hosts[] = $h;
    }
    $out['resultHosts'] = array_values(array_unique($hosts));
    $out['remote'] = is_array($j['remote'] ?? null) ? gpu_remote_snapshot_clean($j['remote']) : null;
    return $out;
}

/** snapshot ของ ping ล่าสุดที่เก็บในไฟล์ (ตรวจชนิดซ้ำตอนอ่าน) */
function gpu_remote_snapshot_clean(array $r): array {
    $s = gpu_remote_ping($r);
    $s['pingedAt'] = is_int($r['pingedAt'] ?? null) ? $r['pingedAt'] : 0;
    $s['keyTag'] = is_string($r['keyTag'] ?? null) ? substr($r['keyTag'], 0, 16) : '';
    return $s;
}

/** tag สั้นของ key (ผูก snapshot กับ key ที่ใช้ ping — ไม่ใช่ความลับ: 8 hex ของ sha256) */
function gpu_key_tag(string $key): string {
    return $key === '' ? '' : substr(hash('sha256', $key), 0, 8);
}

function gpu_configured(array $cfg): bool {
    return ($cfg['partnerKey'] ?? '') !== '' && ($cfg['baseUrlValid'] ?? true) === true;
}

/** เขียนแบบ atomic: temp file (0600) ในโฟลเดอร์เดียวกัน → rename ทับ */
function gpu_config_write(array $cfg, ?string $path = null): bool {
    $path = $path ?? gpu_config_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) return false;
    $data = [
        'baseUrl'     => $cfg['baseUrl'] ?? GPU_DEFAULT_BASE,
        'partnerKey'  => $cfg['partnerKey'] ?? '',
        'defaultMode' => $cfg['defaultMode'] ?? 'open',
        'updatedAt'   => $cfg['updatedAt'] ?? now_ms(),
        'resultHosts' => array_values($cfg['resultHosts'] ?? []),
        'remote'      => $cfg['remote'] ?? null,
    ];
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) return false;
    $tmp = $dir . '/.aixman.' . bin2hex(random_bytes(6)) . '.tmp';
    $old = umask(0077);
    try {
        $ok = @file_put_contents($tmp, $json, LOCK_EX) === strlen($json);
        if ($ok) { @chmod($tmp, 0600); $ok = @rename($tmp, $path); }
    } finally {
        umask($old);
        if (is_file($tmp)) @unlink($tmp);
    }
    if ($ok) @chmod($path, 0600);
    return (bool) $ok;
}

/**
 * read-modify-write ภายใต้ flock (กัน GET ที่อัปเดต snapshot ทับ PUT ที่เพิ่งเปลี่ยน key)
 * $fn รับ config ปัจจุบัน → คืน config ใหม่ หรือ null = ไม่ต้องเขียน
 */
function gpu_config_mutate(callable $fn, ?string $path = null): bool {
    $path = $path ?? gpu_config_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) return false;
    $old = umask(0077);
    $lk = @fopen($path . '.lock', 'c');
    umask($old);
    if (!$lk) return false;
    try {
        if (!flock($lk, LOCK_EX)) return false;
        $next = $fn(gpu_config_read($path));
        if ($next === null) return true;
        return gpu_config_write($next, $path);
    } finally {
        @flock($lk, LOCK_UN);
        fclose($lk);
    }
}

function gpu_config(): array {
    static $cfg = null;
    if ($cfg === null) $cfg = gpu_config_read();
    return $cfg;
}

/** เพดานอัปโหลดจริง = min(64 MB, เพดาน aixman จาก ping ล่าสุด, upload_max_filesize ของ PHP) */
function gpu_upload_cap(array $cfg): int {
    $cap = GPU_MAX_UPLOAD_BYTES;
    $mb = $cfg['remote']['limits']['maxAudioMb'] ?? null;
    if (is_int($mb) && $mb > 0) $cap = min($cap, $mb * 1024 * 1024);
    $ini = gpu_ini_bytes(ini_get('upload_max_filesize'));
    if ($ini > 0) $cap = min($cap, $ini);
    return $cap;
}

function gpu_config_public(array $cfg): array {
    return [
        'configured'   => gpu_configured($cfg),
        'baseUrl'      => $cfg['baseUrl'] ?? GPU_DEFAULT_BASE,
        'keyHint'      => gpu_key_hint($cfg['partnerKey'] ?? ''),
        'defaultMode'  => $cfg['defaultMode'] ?? 'open',
        'updatedAt'    => $cfg['updatedAt'] ?? null,
        'uploadCapMb'  => round(gpu_upload_cap($cfg) / 1048576, 1),
        'allowedHosts' => GPU_ALLOWED_HOSTS,
    ];
}

/** snapshot ของ remote สำหรับตอบ client (ตัด keyTag ภายในออก) */
function gpu_remote_public(?array $snap): ?array {
    if (!$snap) return null;
    unset($snap['keyTag']);
    return $snap;
}

/* ======================================================================
 *  HTTP (cURL) — aixman + result fetch
 * ====================================================================== */

/** hook สำหรับเทสต์ E2E เท่านั้น: มีผลเฉพาะ `php -S` (cli-server) + router ใน tools/ define ค่าคงที่ไว้ */
function gpu_test_hook(): array {
    static $h = null;
    if ($h !== null) return $h;
    $h = [];
    if (PHP_SAPI === 'cli-server' && defined('AQUA_GPU_TEST')) {
        $v = constant('AQUA_GPU_TEST');
        if (is_array($v)) $h = $v;
    }
    return $h;
}

function gpu_user_agent(): string {
    static $ua = null;
    if ($ua !== null) return $ua;
    $ver = '1.0.0';
    $vf = dirname(__DIR__, 2) . '/version.json';
    if (is_file($vf)) {
        $j = json_decode((string) @file_get_contents($vf, false, null, 0, 4096), true);
        if (is_array($j) && is_string($j['version'] ?? null) && preg_match('/^[0-9A-Za-z.+\-]{1,32}$/', $j['version'])) $ver = $j['version'];
    }
    return $ua = 'AquaChord/' . $ver;
}

/**
 * ยิง HTTPS หนึ่งครั้ง (ไม่ตาม redirect, https เท่านั้น, จำกัดขนาด response)
 * $o: headers[], json(array), multipart(array), timeout(int), maxBytes(int), resolve(string[])
 * @return array{status:int,body:string}
 */
function gpu_http(string $method, string $url, array $o = []): array {
    if (!function_exists('curl_init')) throw new GpuError('GPU_NO_CURL', 'เซิร์ฟเวอร์ไม่มี cURL สำหรับเชื่อมต่อ GPU', 500);
    $max = (int) ($o['maxBytes'] ?? GPU_MAX_API_BYTES);
    $buf = ''; $over = false;
    $headers = array_merge(['Accept: application/json', 'Expect:'], $o['headers'] ?? []);
    $ch = curl_init();
    $opts = [
        CURLOPT_URL            => $url,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_MAXREDIRS      => 0,
        CURLOPT_CONNECTTIMEOUT => GPU_TIMEOUT_CONNECT,
        CURLOPT_TIMEOUT        => (int) ($o['timeout'] ?? GPU_TIMEOUT_DEFAULT),
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT      => gpu_user_agent(),
        CURLOPT_NOSIGNAL       => true,
        CURLOPT_WRITEFUNCTION  => function ($c, string $chunk) use (&$buf, &$over, $max): int {
            if (strlen($buf) + strlen($chunk) > $max) { $over = true; return 0; }
            $buf .= $chunk;
            return strlen($chunk);
        },
    ];
    if (defined('CURLOPT_PROTOCOLS_STR')) {
        $opts[constant('CURLOPT_PROTOCOLS_STR')] = 'https';
    } else {
        $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
    }
    if ($method === 'GET') {
        $opts[CURLOPT_HTTPGET] = true;
    } elseif ($method === 'POST') {
        $opts[CURLOPT_POST] = true;
        if (isset($o['multipart'])) {
            $opts[CURLOPT_POSTFIELDS] = $o['multipart'];          // array + CURLFile → multipart/form-data
        } else {
            $opts[CURLOPT_POSTFIELDS] = json_encode($o['json'] ?? new stdClass(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $headers[] = 'Content-Type: application/json; charset=utf-8';
        }
    } else {
        $opts[CURLOPT_CUSTOMREQUEST] = $method;
    }
    if (!empty($o['resolve'])) {
        $opts[CURLOPT_RESOLVE] = $o['resolve'];
        $opts[CURLOPT_IPRESOLVE] = CURL_IPRESOLVE_V4;
    }
    $t = gpu_test_hook();
    if (!empty($t['connect_to']) && is_array($t['connect_to'])) $opts[CURLOPT_CONNECT_TO] = $t['connect_to'];
    if (!empty($t['cainfo']) && is_string($t['cainfo'])) $opts[CURLOPT_CAINFO] = $t['cainfo'];
    $opts[CURLOPT_HTTPHEADER] = $headers;
    curl_setopt_array($ch, $opts);
    $ok = curl_exec($ch);
    $errno = curl_errno($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($over) throw new GpuError('GPU_RESPONSE_TOO_LARGE', 'ข้อมูลจากเซิร์ฟเวอร์ GPU ใหญ่เกินกำหนด', 502);
    if ($ok === false || $errno !== 0) {
        // log แค่เลข errno (ข้อความ cURL มี host/URL ปนได้)
        error_log('[aquachord] gpu http failed: errno=' . $errno);
        if ($errno === 28) throw new GpuError('GPU_TIMEOUT', 'เซิร์ฟเวอร์ GPU ตอบช้าเกินไป (หมดเวลา) กรุณาลองใหม่', 504, true);
        throw new GpuError('GPU_UNREACHABLE', 'เชื่อมต่อเซิร์ฟเวอร์ GPU ไม่ได้ กรุณาลองใหม่', 502, true);
    }
    return ['status' => $status, 'body' => $buf];
}

/** เรียก partner API ของ aixman → array JSON (2xx) หรือ throw GpuError ที่แปลงแล้ว */
function gpu_api(array $cfg, string $method, string $endpoint, array $o = []): array {
    if (!gpu_configured($cfg)) throw new GpuError('GPU_NOT_CONFIGURED', 'ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์ GPU — ตั้งค่าในหลังบ้านก่อน', 409);
    $base = gpu_normalize_base_url($cfg['baseUrl'] ?? '');
    if ($base === null) throw new GpuError('GPU_NOT_CONFIGURED', 'ที่อยู่เซิร์ฟเวอร์ GPU ไม่อยู่ในรายการที่อนุญาต', 409);
    $o['headers'] = array_merge($o['headers'] ?? [], ['X-Aixman-Partner-Key: ' . $cfg['partnerKey']]);
    $res = gpu_http($method, $base . GPU_API_PREFIX . $endpoint, $o);
    $j = json_decode($res['body'], true, 32);
    if ($res['status'] >= 200 && $res['status'] < 300) {
        if (!is_array($j)) {
            error_log('[aquachord] gpu api bad json: ' . $method . ' ' . gpu_endpoint_label($endpoint) . ' http=' . $res['status']);
            throw new GpuError('GPU_BAD_RESPONSE', 'เซิร์ฟเวอร์ GPU ตอบกลับผิดรูปแบบ', 502, true);
        }
        return $j;
    }
    $code = is_array($j) && is_array($j['error'] ?? null) ? ($j['error']['code'] ?? null) : null;
    $code = is_string($code) && preg_match('/^[A-Z_]{1,40}$/', $code) ? $code : null;
    error_log('[aquachord] gpu api error: ' . $method . ' ' . gpu_endpoint_label($endpoint) . ' http=' . $res['status'] . ' code=' . ($code ?? '-'));
    throw gpu_remote_error($res['status'], $code);
}

/** ชื่อ endpoint สำหรับ log (ตัด id ออก) */
function gpu_endpoint_label(string $ep): string {
    return preg_replace('#^/jobs/[^/]+#', '/jobs/:id', $ep) ?? '/?';
}

/** ping aixman → snapshot (whitelist field) */
function gpu_ping(array $cfg): array {
    try {
        $p = gpu_api($cfg, 'GET', '/ping');
    } catch (GpuError $e) {
        if ($e->errCode !== 'GPU_NOT_FOUND') throw $e;
        throw new GpuError('GPU_NO_PARTNER_API', 'ไม่พบ partner API ของ AquaChord ที่ aixman (ยังไม่เปิดใช้งาน)', 502);
    }
    if (($p['ok'] ?? null) !== true) throw new GpuError('GPU_BAD_RESPONSE', 'เซิร์ฟเวอร์ GPU ตอบกลับผิดรูปแบบ', 502);
    $snap = gpu_remote_ping($p);
    $snap['keyTag'] = gpu_key_tag($cfg['partnerKey'] ?? '');
    return $snap;
}

/** resolve host → IPv4 สาธารณะหนึ่งตัว (ใช้ pin ด้วย CURLOPT_RESOLVE กัน DNS rebinding) */
function gpu_resolve_public(string $host): string {
    $t = gpu_test_hook();
    if (is_array($t['resolve'] ?? null) && isset($t['resolve'][$host])) {
        $ips = [(string) $t['resolve'][$host]];
    } else {
        $ips = @gethostbynamel($host) ?: [];
    }
    if (!$ips) throw new GpuError('GPU_UNREACHABLE', 'หาที่อยู่เซิร์ฟเวอร์ผลลัพธ์ไม่พบ กรุณาลองใหม่', 502, true);
    foreach ($ips as $ip) {
        if (!gpu_ip_is_public($ip)) {
            error_log('[aquachord] gpu result host resolves to non-public ip — blocked');
            throw new GpuError('GPU_BAD_RESULT_URL', 'ที่อยู่ผลลัพธ์จากเซิร์ฟเวอร์ GPU ไม่ปลอดภัย จึงไม่ดาวน์โหลด', 502);
        }
    }
    return $ips[0];
}

/** host ที่ยอมให้ดึงผล: ที่เรียนรู้จาก URL อัปโหลดของ aixman + host ของ baseUrl เอง */
function gpu_result_hosts(array $cfg): array {
    $hosts = $cfg['resultHosts'] ?? [];
    $base = gpu_normalize_base_url($cfg['baseUrl'] ?? '');
    if ($base !== null) $hosts[] = substr($base, strlen('https://'));
    return array_values(array_unique($hosts));
}

/** จำ host ของ R2 ที่ aixman ใช้ (จาก url ที่ /uploads ตอบกลับ) */
function gpu_learn_result_host(string $host): void {
    if (!gpu_valid_hostname($host)) return;
    if (in_array($host, gpu_config()['resultHosts'] ?? [], true)) return;
    gpu_config_mutate(function (array $c) use ($host) {
        if (!gpu_configured($c)) return null;
        $hosts = array_values(array_filter($c['resultHosts'] ?? [], fn($h) => $h !== $host));
        array_unshift($hosts, $host);
        $c['resultHosts'] = array_slice($hosts, 0, GPU_MAX_RESULT_HOSTS);
        return $c;
    });
}

/** ดึงผล JSON (server-side) → [raw JSON string ที่ผ่านการตรวจ] — ไม่ส่ง partner key ไปที่ host ผลลัพธ์ */
function gpu_fetch_result(array $cfg, string $resultUrl): string {
    $u = gpu_check_result_url($resultUrl, gpu_result_hosts($cfg));
    if (!$u) {
        error_log('[aquachord] gpu resultUrl rejected by allowlist');
        throw new GpuError('GPU_BAD_RESULT_URL', 'ที่อยู่ผลลัพธ์จากเซิร์ฟเวอร์ GPU ไม่อยู่ในรายการที่อนุญาต จึงไม่ดาวน์โหลด', 502);
    }
    $ip = gpu_resolve_public($u['host']);
    $res = gpu_http('GET', $u['url'], [
        'maxBytes' => GPU_MAX_RESULT_BYTES,
        'resolve'  => [$u['host'] . ':443:' . $ip],
        'timeout'  => GPU_TIMEOUT_DEFAULT,
    ]);
    if ($res['status'] >= 500 || $res['status'] === 429) throw new GpuError('GPU_REMOTE_ERROR', 'ดาวน์โหลดผลลัพธ์ไม่สำเร็จชั่วคราว กรุณาลองใหม่', 502, true);
    if ($res['status'] !== 200) {
        error_log('[aquachord] gpu result fetch http=' . $res['status']);
        throw new GpuError('GPU_RESULT_GONE', 'ดาวน์โหลดผลลัพธ์ไม่ได้ (ไฟล์อาจหมดอายุแล้ว)', 502);
    }
    if (gpu_validate_result($res['body']) === null) {
        error_log('[aquachord] gpu result failed validation (bytes=' . strlen($res['body']) . ')');
        throw new GpuError('GPU_BAD_RESULT', 'ผลลัพธ์จากเซิร์ฟเวอร์ GPU ไม่ถูกต้อง', 502);
    }
    return $res['body'];
}

/* ======================================================================
 *  jobs (DB)
 * ====================================================================== */

function gpu_valid_job_id(string $id): bool {
    return (bool) preg_match('/^gj_[a-f0-9]{18}$/', $id);
}

function gpu_job_row(string $id): ?array {
    if (!gpu_valid_job_id($id)) return null;
    $st = db()->prepare('SELECT j.*, a.username AS created_by_name FROM gpu_jobs j LEFT JOIN admins a ON a.id = j.created_by WHERE j.id = ?');
    $st->execute([$id]);
    $r = $st->fetch();
    return $r ?: null;
}

/** งานจบแล้ว (ไม่ต้อง poll อีก) */
function gpu_job_done(array $r): bool {
    return $r['status'] === 'failed' || $r['status'] === 'cancelled'
        || ($r['status'] === 'completed' && $r['result_json'] !== null);
}

function gpu_job_public(array $r): array {
    return [
        'id'            => $r['id'],
        'status'        => $r['status'],
        'stageLabel'    => $r['stage_label'],
        'progress'      => $r['progress'] !== null ? (float) $r['progress'] : null,
        'etaSeconds'    => $r['eta_seconds'] !== null ? (int) $r['eta_seconds'] : null,
        'queuePosition' => $r['queue_position'] !== null ? (int) $r['queue_position'] : null,
        'mode'          => $r['mode'],
        'language'      => $r['language'],
        'title'         => $r['title'],
        'fileName'      => $r['file_name'],
        'fileBytes'     => $r['file_bytes'] !== null ? (int) $r['file_bytes'] : null,
        'errorMessage'  => $r['error'],
        'gpuSeconds'    => $r['gpu_seconds'] !== null ? (float) $r['gpu_seconds'] : null,
        'hasResult'     => $r['result_json'] !== null,
        'createdBy'     => $r['created_by_name'] ?? null,
        'createdAt'     => (int) $r['created_at'],
        'updatedAt'     => (int) $r['updated_at'],
    ];
}

/** ตั้งงานเป็น failed — ไม่ทับงานที่ผู้ใช้ยกเลิกไปแล้ว (เช่น กดยกเลิกระหว่างอัปโหลดแล้วการส่งต่อล้มทีหลัง) */
function gpu_job_fail(string $id, string $message): void {
    db()->prepare("UPDATE gpu_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status <> 'cancelled'")
        ->execute([mb_substr($message, 0, 500), now_ms(), $id]);
}

/** เก็บสถานะจาก remote ลงแถว */
function gpu_job_apply_remote(string $id, array $j): void {
    $sets = ['updated_at = ?'];
    $vals = [now_ms()];
    if ($j['status'] !== null) { $sets[] = 'status = ?'; $vals[] = $j['status']; }
    foreach (['stage_label' => 'stageLabel', 'progress' => 'progress', 'eta_seconds' => 'etaSeconds', 'queue_position' => 'queuePosition', 'gpu_seconds' => 'gpuSeconds'] as $col => $k) {
        $sets[] = $col . ' = ?';
        $vals[] = $j[$k];
    }
    if ($j['status'] === 'failed') { $sets[] = 'error = ?'; $vals[] = $j['errorMessage'] ?? 'งานบนเซิร์ฟเวอร์ GPU ล้มเหลว'; }
    $vals[] = $id;
    db()->prepare('UPDATE gpu_jobs SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($vals);
}

/**
 * poll aixman (ไม่ถี่กว่า 3 วิ/งาน — claim ด้วย UPDATE แบบมีเงื่อนไขกันหลาย request poll พร้อมกัน)
 * คืน [row ล่าสุด, ข้อความเตือนชั่วคราว|null]
 */
function gpu_job_refresh(array $row): array {
    if (!$row['remote_id'] && $row['status'] === 'uploading' && now_ms() - (int) $row['created_at'] > GPU_UPLOAD_STALE_MS) {
        db()->prepare("UPDATE gpu_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'uploading' AND remote_id IS NULL")
            ->execute(['การส่งไฟล์ไปเซิร์ฟเวอร์ GPU ค้างหรือถูกตัดกลางทาง กรุณาส่งใหม่', now_ms(), $row['id']]);
        return [gpu_job_row($row['id']) ?? $row, null];
    }
    if (!$row['remote_id'] || gpu_job_done($row)) return [$row, null];
    $now = now_ms();
    $claim = db()->prepare('UPDATE gpu_jobs SET polled_at = ? WHERE id = ? AND (polled_at IS NULL OR polled_at <= ?)');
    $claim->execute([$now, $row['id'], $now - GPU_POLL_MIN_MS]);
    if ($claim->rowCount() === 0) return [$row, null];

    $cfg = gpu_config();
    $notice = null;
    try {
        $r = gpu_api($cfg, 'GET', '/jobs/' . rawurlencode($row['remote_id']));
        $j = gpu_remote_job($r['job'] ?? null);
        if ($j === null || $j['id'] !== $row['remote_id']) throw new GpuError('GPU_BAD_RESPONSE', 'เซิร์ฟเวอร์ GPU ตอบกลับผิดรูปแบบ', 502, true);
        gpu_job_apply_remote($row['id'], $j);
        if ($j['status'] === 'completed' && $row['result_json'] === null) {
            if ($j['resultUrl'] === null) throw new GpuError('GPU_BAD_RESPONSE', 'เซิร์ฟเวอร์ GPU ยังไม่ส่งที่อยู่ผลลัพธ์', 502, true);
            $raw = gpu_fetch_result($cfg, $j['resultUrl']);
            db()->prepare('UPDATE gpu_jobs SET result_json = ?, error = NULL, updated_at = ? WHERE id = ? AND result_json IS NULL')
                ->execute([$raw, now_ms(), $row['id']]);
        }
    } catch (GpuError $e) {
        if ($e->errCode === 'GPU_NOT_FOUND') {
            gpu_job_fail($row['id'], $e->getMessage());
        } elseif ($e->transient || in_array($e->errCode, ['GPU_BAD_KEY', 'GPU_NOT_CONFIGURED', 'GPU_FORBIDDEN'], true)) {
            $notice = $e->getMessage();                    // ชั่วคราว/ปัญหาการตั้งค่า → poll ใหม่ได้
        } else {
            gpu_job_fail($row['id'], $e->getMessage());    // ผลเสีย/host ไม่อนุญาต/หมดอายุ → จบงาน
        }
    }
    return [gpu_job_row($row['id']) ?? $row, $notice];
}

/* ======================================================================
 *  route handlers (เรียกจาก index.php)
 * ====================================================================== */

/** GET /api/gpu/config[?ping=0|fresh=1] */
function gpu_route_get_config(): void {
    require_admin();
    $cfg = gpu_config();
    $out = gpu_config_public($cfg);
    $out['remote'] = null;
    if (!($cfg['baseUrlValid'] ?? true)) $out['error'] = 'ที่อยู่เซิร์ฟเวอร์ในไฟล์ตั้งค่าไม่อยู่ในรายการที่อนุญาต — บันทึกการตั้งค่าใหม่';
    if (!$out['configured'] || ($_GET['ping'] ?? '') === '0') {
        if ($out['configured']) $out['remote'] = gpu_remote_public($cfg['remote'] ?? null);
        send_json($out);
    }
    $snap = $cfg['remote'] ?? null;
    $tag = gpu_key_tag($cfg['partnerKey']);
    $fresh = ($_GET['fresh'] ?? '') === '1';
    // ?fresh=1 ยังโดนเพดาน 3 วิ (กดตรวจรัว ๆ ไม่ยิง ping ไป aixman ทุกครั้ง)
    $maxAge = $fresh ? GPU_POLL_MIN_MS : GPU_PING_CACHE_MS;
    if ($snap && ($snap['keyTag'] ?? '') === $tag && now_ms() - (int) $snap['pingedAt'] < $maxAge) {
        $out['remote'] = gpu_remote_public($snap);
        send_json($out);
    }
    try {
        $snap = gpu_ping($cfg);
        gpu_config_mutate(function (array $c) use ($snap, $tag) {
            if (gpu_key_tag($c['partnerKey'] ?? '') !== $tag) return null;   // key ถูกเปลี่ยนระหว่างนั้น — ไม่ทับ
            $c['remote'] = $snap;
            return $c;
        });
        $cfg['remote'] = $snap;
        $out = gpu_config_public($cfg);
        $out['remote'] = gpu_remote_public($snap);
    } catch (GpuError $e) {
        $out['error'] = $e->getMessage();
        $out['errorCode'] = $e->errCode;
    }
    send_json($out);
}

/** PUT /api/gpu/config {baseUrl?, partnerKey?, defaultMode?} — ทดสอบ ping ก่อนบันทึก */
function gpu_route_put_config(array $b): void {
    $me = require_admin();
    $cur = gpu_config_read();

    $baseIn = field($b, 'baseUrl', 300);
    $base = $baseIn === '' ? ($cur['baseUrl'] ?? GPU_DEFAULT_BASE) : gpu_normalize_base_url($baseIn);
    if ($base === null) fail('BAD_BASE_URL', 'อนุญาตเฉพาะ https://' . GPU_ALLOWED_HOSTS[0] . ' เท่านั้น');

    $keyIn = is_string($b['partnerKey'] ?? null) ? trim($b['partnerKey']) : '';
    if ($keyIn !== '' && !gpu_valid_partner_key($keyIn)) fail('BAD_KEY_FORMAT', 'รูปแบบ Partner key ไม่ถูกต้อง (คัดลอกจากหลังบ้าน aixman เมนู AquaChord)');
    $key = $keyIn !== '' ? $keyIn : ($cur['partnerKey'] ?? '');
    if ($key === '') fail('NO_KEY', 'กรุณาใส่ Partner key จากหลังบ้าน aixman');

    $modeIn = field($b, 'defaultMode', 20);
    $mode = $modeIn === '' ? ($cur['defaultMode'] ?? 'open') : $modeIn;
    if (!in_array($mode, GPU_MODES, true)) fail('BAD_MODE', 'โหมดไม่ถูกต้อง');

    $keyChanged = $key !== ($cur['partnerKey'] ?? '');
    $cand = [
        'baseUrl'     => $base,
        'baseUrlValid'=> true,
        'partnerKey'  => $key,
        'defaultMode' => $mode,
        'resultHosts' => $cur['resultHosts'] ?? [],          // host R2 เป็นของ aixman ไม่ขึ้นกับ key
        'remote'      => null,
    ];

    $warning = null;
    try {
        $cand['remote'] = gpu_ping($cand);
    } catch (GpuError $e) {
        if ($e->errCode !== 'GPU_DISABLED') {
            audit((int) $me['id'], 'gpu_config_fail', 'code=' . $e->errCode);
            fail($e->errCode, 'ทดสอบการเชื่อมต่อไม่ผ่าน — ' . $e->getMessage(), $e->http === 401 ? 502 : $e->http);
        }
        $warning = 'บันทึกแล้ว แต่ระบบ GPU ของ aixman ปิดอยู่ จึงยังตรวจคีย์ไม่ได้ — เปิดที่หลังบ้าน aixman แล้วกดตรวจสถานะอีกครั้ง';
    }
    $cand['updatedAt'] = now_ms();
    $saved = gpu_config_mutate(fn(array $c) => $cand);
    if (!$saved) {
        error_log('[aquachord] gpu config write failed');
        fail('CONFIG_WRITE', 'บันทึกการตั้งค่าไม่สำเร็จ (โฟลเดอร์ private เขียนไม่ได้)', 500);
    }
    audit((int) $me['id'], 'gpu_config_update',
        'host=' . parse_url($base, PHP_URL_HOST) . ' key=' . ($keyChanged ? 'new ' . gpu_key_hint($key) : 'kept') . ' mode=' . $mode . ($warning ? ' remote=disabled' : ''));
    $out = gpu_config_public($cand);
    $out['remote'] = gpu_remote_public($cand['remote']);
    if ($warning) $out['warning'] = $warning;
    send_json($out);
}

/** GET /api/gpu/jobs — 50 งานล่าสุด (ไม่มีผลลัพธ์/เนื้อเพลง) */
function gpu_route_list_jobs(): void {
    require_admin();
    $rows = db()->query('SELECT j.id, j.status, j.stage_label, j.progress, j.eta_seconds, j.queue_position, j.mode, j.language, j.title,
            j.file_name, j.file_bytes, j.error, j.gpu_seconds, j.created_at, j.updated_at, (j.result_json IS NOT NULL) AS has_result,
            a.username AS created_by_name
        FROM gpu_jobs j LEFT JOIN admins a ON a.id = j.created_by ORDER BY j.created_at DESC LIMIT 50')->fetchAll();
    $jobs = array_map(function ($r) {
        $r['result_json'] = ((int) $r['has_result']) === 1 ? '' : null;   // gpu_job_public ใช้แค่เช็ค null
        return gpu_job_public($r);
    }, $rows);
    send_json(['jobs' => $jobs]);
}

/** GET /api/gpu/jobs/{id}[?result=0] → {job, result?, notice?} (result=0 = ไม่แนบผล ใช้ตอน poll สถานะ) */
function gpu_route_get_job(string $id): void {
    require_admin();
    $row = gpu_job_row($id);
    if (!$row) fail('NOT_FOUND', 'ไม่พบงานนี้', 404);
    [$row, $notice] = gpu_job_refresh($row);
    $out = ['job' => gpu_job_public($row)];
    if ($row['result_json'] !== null && ($_GET['result'] ?? '1') !== '0') {
        $res = json_decode($row['result_json'], false, 32);
        if ($res !== null) $out['result'] = $res;
    }
    if ($notice) $out['notice'] = $notice;
    send_json($out);
}

/** DELETE /api/gpu/jobs/{id} — ยกเลิก (aixman ยกเลิกได้เฉพาะงานที่ยังรอคิว) */
function gpu_route_cancel_job(string $id): void {
    $me = require_admin();
    $row = gpu_job_row($id);
    if (!$row) fail('NOT_FOUND', 'ไม่พบงานนี้', 404);
    if (in_array($row['status'], ['completed', 'failed', 'cancelled'], true)) fail('JOB_DONE', 'งานนี้จบแล้ว ยกเลิกไม่ได้', 409);
    if (!$row['remote_id']) {
        // ยังอัปโหลดอยู่ — ตั้งเป็น cancelled; request ที่อัปโหลดจะเห็นแล้วยกเลิกงานฝั่ง aixman เอง
        db()->prepare("UPDATE gpu_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND remote_id IS NULL")->execute([now_ms(), $id]);
    } else {
        try {
            $r = gpu_api(gpu_config(), 'DELETE', '/jobs/' . rawurlencode($row['remote_id']));
            $j = gpu_remote_job($r['job'] ?? null);
            if ($j) gpu_job_apply_remote($id, $j);
            if (!$j || $j['status'] !== 'cancelled') db()->prepare("UPDATE gpu_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?")->execute([now_ms(), $id]);
        } catch (GpuError $e) {
            if ($e->errCode === 'GPU_NOT_FOUND') {
                db()->prepare("UPDATE gpu_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?")->execute([now_ms(), $id]);
            } else {
                fail($e->errCode, $e->getMessage(), $e->http);
            }
        }
    }
    audit((int) $me['id'], 'gpu_job_cancel', $id);
    send_json(['job' => gpu_job_public(gpu_job_row($id) ?? $row)]);
}

/**
 * POST /api/gpu/jobs (multipart: file, lyrics?, mode?, title?, language?)
 * ตรวจไฟล์ → จองแถว (จำกัดงานพร้อมกัน/แอดมิน) → /uploads → /jobs (Idempotency-Key = id ของเรา) → 201 {job}
 */
function gpu_route_create_job(): void {
    $me = require_admin();
    $tmp = null;
    try {
        [$code, $payload] = gpu_create_job_inner($me, $tmp);
    } catch (GpuError $e) {
        [$code, $payload] = [$e->http, ['error' => ['code' => $e->errCode, 'message' => $e->getMessage()]]];
    } finally {
        if ($tmp !== null && is_file($tmp)) @unlink($tmp);
    }
    send_json($payload, $code);
}

/** @param-out string|null $tmp temp upload path (ให้ caller ลบใน finally) */
function gpu_create_job_inner(array $me, ?string &$tmp): array {
    $cfg = gpu_config();
    if (!gpu_configured($cfg)) throw new GpuError('NOT_CONFIGURED', 'ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์ GPU — ตั้งค่าในหลังบ้านก่อน', 409);

    $cap = gpu_upload_cap($cfg);
    $capMb = round($cap / 1048576);
    $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    $postMax = gpu_ini_bytes(ini_get('post_max_size'));
    if (empty($_FILES) && $postMax > 0 && $len > $postMax) throw new GpuError('FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน ' . $capMb . ' MB', 413);

    $f = $_FILES['file'] ?? null;
    if (!is_array($f) || is_array($f['error'] ?? null)) throw new GpuError('NO_FILE', 'กรุณาเลือกไฟล์เสียง 1 ไฟล์', 400);
    $err = (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) throw new GpuError('FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน ' . $capMb . ' MB', 413);
    if ($err === UPLOAD_ERR_NO_FILE) throw new GpuError('NO_FILE', 'กรุณาเลือกไฟล์เสียง', 400);
    if ($err !== UPLOAD_ERR_OK) throw new GpuError('UPLOAD_FAILED', 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่', 400);
    $path = (string) ($f['tmp_name'] ?? '');
    if ($path === '' || !is_uploaded_file($path)) throw new GpuError('UPLOAD_FAILED', 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่', 400);
    $tmp = $path;

    $size = (int) @filesize($path);
    if ($size <= 0) throw new GpuError('NO_FILE', 'ไฟล์ว่างเปล่า', 400);
    if ($size > $cap) throw new GpuError('FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน ' . $capMb . ' MB', 413);
    $fh = @fopen($path, 'rb');
    $head = $fh ? (string) fread($fh, 64) : '';
    if ($fh) fclose($fh);
    $kind = gpu_sniff_audio($head);
    if (!$kind) throw new GpuError('BAD_AUDIO', 'รองรับเฉพาะไฟล์เสียง MP3, WAV, FLAC, OGG หรือ M4A', 400);

    $lyrics = gpu_clean_lyrics($_POST['lyrics'] ?? '');
    if ($lyrics === null) throw new GpuError('BAD_LYRICS', 'เนื้อเพลงมีอักขระที่อ่านไม่ได้ (ต้องเป็น UTF-8)', 400);
    if (mb_strlen($lyrics) > GPU_MAX_LYRICS) throw new GpuError('LYRICS_TOO_LONG', 'เนื้อเพลงยาวเกิน ' . number_format(GPU_MAX_LYRICS) . ' ตัวอักษร', 400);
    $fileName = gpu_display_filename($f['name'] ?? '');
    $title = gpu_clean_text($_POST['title'] ?? null, GPU_MAX_TITLE)
        ?? (gpu_clean_text(preg_replace('/\.[A-Za-z0-9]{1,5}$/', '', $fileName), GPU_MAX_TITLE) ?? 'audio');
    $modeIn = is_string($_POST['mode'] ?? null) ? trim($_POST['mode']) : '';
    $mode = $modeIn === '' ? ($cfg['defaultMode'] ?? 'open') : $modeIn;
    if (!in_array($mode, GPU_MODES, true)) throw new GpuError('BAD_MODE', 'โหมดไม่ถูกต้อง (open หรือ sheetsage2)', 400);
    $langIn = is_string($_POST['language'] ?? null) ? trim($_POST['language']) : '';
    $lang = $langIn === '' ? 'th' : $langIn;
    if (!in_array($lang, GPU_LANGS, true)) throw new GpuError('BAD_LANGUAGE', 'ภาษาไม่ถูกต้อง (th, auto หรือ en)', 400);
    $sha = hash_file('sha256', $path) ?: '';

    // ---- จองแถว: lock แถวแอดมิน → เช็คซ้ำ/เพดานงานพร้อมกัน → insert (กันกดรัว/สองแท็บ) ----
    $id = uid('gj_');
    $now = now_ms();
    $db = db();
    $db->beginTransaction();
    try {
        $db->prepare('SELECT id FROM admins WHERE id = ? FOR UPDATE')->execute([$me['id']]);
        $dup = $db->prepare("SELECT id FROM gpu_jobs WHERE created_by = ? AND file_sha256 = ? AND mode = ? AND language = ?
            AND lyrics = ? AND created_at > ? AND status NOT IN ('failed','cancelled') ORDER BY created_at DESC LIMIT 1");
        $dup->execute([$me['id'], $sha, $mode, $lang, $lyrics, $now - GPU_DEDUPE_MS]);
        $dupId = $dup->fetchColumn();
        if ($dupId) {
            $db->commit();
            return [200, ['job' => gpu_job_public(gpu_job_row((string) $dupId)), 'deduped' => true]];
        }
        $cnt = $db->prepare("SELECT COUNT(*) FROM gpu_jobs WHERE created_by = ? AND (
                (status IN ('queued','starting','rendering') AND created_at > ?)
             OR (status = 'uploading' AND remote_id IS NULL AND created_at > ?))");
        $cnt->execute([$me['id'], $now - GPU_ACTIVE_WINDOW_MS, $now - GPU_UPLOAD_STALE_MS]);
        if ((int) $cnt->fetchColumn() >= GPU_MAX_ACTIVE_PER_ADMIN) {
            $db->rollBack();
            throw new GpuError('ACTIVE_LIMIT', 'คุณมีงาน GPU ที่กำลังทำอยู่ครบ ' . GPU_MAX_ACTIVE_PER_ADMIN . ' งานแล้ว รอให้เสร็จหรือยกเลิกก่อน', 429);
        }
        $db->prepare('INSERT INTO gpu_jobs(id, status, mode, language, title, file_name, file_bytes, file_sha256, lyrics, created_by, created_at, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([$id, 'uploading', $mode, $lang, $title, $fileName, $size, $sha, $lyrics, $me['id'], $now, $now]);
        $db->commit();
    } catch (GpuError $e) {
        throw $e;
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    audit((int) $me['id'], 'gpu_job_create', $id . ' mode=' . $mode . ' bytes=' . $size);

    // ---- ส่งต่อ aixman (นอก transaction) — client หลุดกลางทางก็ทำต่อจนจบ ----
    ignore_user_abort(true);
    @set_time_limit(GPU_TIMEOUT_UPLOAD + GPU_TIMEOUT_DEFAULT * 2 + 30);
    try {
        $up = gpu_api($cfg, 'POST', '/uploads', [
            'multipart' => ['file' => new CURLFile($path, $kind['type'], 'audio.' . $kind['ext'])],   // ไม่ส่งชื่อไฟล์ของผู้ใช้
            'timeout'   => GPU_TIMEOUT_UPLOAD,
        ]);
        $u = is_string($up['url'] ?? null) ? gpu_parse_https_url($up['url']) : null;
        if (!$u) throw new GpuError('GPU_BAD_RESPONSE', 'เซิร์ฟเวอร์ GPU ตอบกลับผิดรูปแบบ (ที่อยู่ไฟล์)', 502);
        gpu_learn_result_host($u['host']);

        $body = ['inputAudio' => $u['url'], 'mode' => $mode, 'language' => $lang, 'title' => $title, 'externalRef' => $id];
        if ($lyrics !== '') $body['lyrics'] = $lyrics;
        $opt = ['json' => $body, 'headers' => ['Idempotency-Key: ' . $id]];
        try {
            $r = gpu_api($cfg, 'POST', '/jobs', $opt);
        } catch (GpuError $e) {
            if (!$e->transient || $e->errCode === 'GPU_DISABLED') throw $e;
            $r = gpu_api($cfg, 'POST', '/jobs', $opt);       // Idempotency-Key เดิม → ลองซ้ำได้ปลอดภัย
        }
        $j = gpu_remote_job($r['job'] ?? null);
        if (!$j) throw new GpuError('GPU_BAD_RESPONSE', 'เซิร์ฟเวอร์ GPU ตอบกลับผิดรูปแบบ', 502);

        if ($j['status'] === null) $j['status'] = 'queued';
        $st = db()->prepare("UPDATE gpu_jobs SET remote_id = ?, status = ?, updated_at = ? WHERE id = ? AND status = 'uploading'");
        $st->execute([$j['id'], $j['status'], now_ms(), $id]);
        if ($st->rowCount() === 0) {
            // ถูกยกเลิกระหว่างอัปโหลด → ยกเลิกฝั่ง aixman ด้วย (best effort)
            db()->prepare('UPDATE gpu_jobs SET remote_id = ? WHERE id = ?')->execute([$j['id'], $id]);
            try { gpu_api($cfg, 'DELETE', '/jobs/' . rawurlencode($j['id'])); } catch (GpuError $e) { /* งานเริ่มแล้ว — ปล่อยตามเดิม */ }
        } else {
            gpu_job_apply_remote($id, $j);
        }
    } catch (GpuError $e) {
        gpu_job_fail($id, $e->getMessage());
        throw $e;
    } catch (Throwable $e) {
        gpu_job_fail($id, 'ระบบขัดข้องระหว่างส่งงาน');
        throw $e;
    }
    return [201, ['job' => gpu_job_public(gpu_job_row($id))]];
}
