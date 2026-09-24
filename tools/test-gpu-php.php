<?php
/**
 * เทสต์ฟังก์ชันล้วนของ site/api/lib/gpu.php (ไม่ต้องมี DB/เครือข่าย)
 *   php tools/test-gpu-php.php
 * ครอบ: magic bytes, URL allowlist/SSRF (userinfo@host, http://, IP literal, host อื่น), IP สาธารณะ,
 *       ตรวจผล TranscriptionResult, keyHint, รูปแบบ key, แปลง error, ไฟล์ตั้งค่า (atomic + ตรวจซ้ำตอนอ่าน)
 */
declare(strict_types=1);
define('AQUA', 1);
require __DIR__ . '/../site/api/lib/util.php';
require __DIR__ . '/../site/api/lib/gpu.php';

$pass = 0; $failN = 0;
function ok(bool $cond, string $name): void {
    global $pass, $failN;
    if ($cond) { $pass++; return; }
    $failN++;
    fwrite(STDERR, "FAIL: $name\n");
}
function eq($a, $b, string $name): void {
    ok($a === $b, $name . ($a === $b ? '' : ' — got ' . var_export($a, true) . ' want ' . var_export($b, true)));
}
$pad = fn(string $s) => str_pad($s, 64, "\0");

/* ---------------- magic bytes ---------------- */
eq(gpu_sniff_audio($pad('ID3' . "\x04\x00"))['ext'] ?? null, 'mp3', 'sniff ID3');
eq(gpu_sniff_audio($pad("\xFF\xFB\x90\x00"))['ext'] ?? null, 'mp3', 'sniff mpeg1 layer3 frame sync');
eq(gpu_sniff_audio($pad("\xFF\xF3\x48\x00"))['ext'] ?? null, 'mp3', 'sniff mpeg2 layer3 frame sync');
eq(gpu_sniff_audio($pad("\xFF\xF1\x50\x80")), null, 'reject ADTS AAC (layer 00)');
eq(gpu_sniff_audio($pad("\xFF\xFB\xF0\x00")), null, 'reject bad bitrate index 1111');
eq(gpu_sniff_audio($pad("\xFF\xEB\x90\x00")), null, 'reject reserved mpeg version');
eq(gpu_sniff_audio($pad('RIFF' . "\x24\x00\x00\x00" . 'WAVE' . 'fmt '))['type'] ?? null, 'audio/wav', 'sniff wav');
eq(gpu_sniff_audio($pad('RIFF' . "\x24\x00\x00\x00" . 'AVI ')), null, 'reject RIFF AVI');
eq(gpu_sniff_audio($pad('fLaC' . "\x00\x00\x00\x22"))['ext'] ?? null, 'flac', 'sniff flac');
eq(gpu_sniff_audio($pad('OggS' . "\x00\x02"))['ext'] ?? null, 'ogg', 'sniff ogg');
eq(gpu_sniff_audio($pad("\x00\x00\x00\x20" . 'ftypM4A ' . "\x00\x00\x02\x00"))['type'] ?? null, 'audio/mp4', 'sniff m4a ftyp');
eq(gpu_sniff_audio($pad("\x00\x00\x00\x18" . 'ftypheic')), null, 'reject HEIC ftyp');
eq(gpu_sniff_audio($pad("\x89PNG\r\n\x1a\n")), null, 'reject png');
eq(gpu_sniff_audio($pad('<?php echo 1;')), null, 'reject php text');
eq(gpu_sniff_audio('ID3'), null, 'reject too-short header');
eq(gpu_sniff_audio(''), null, 'reject empty');

/* ---------------- URL parsing / SSRF ---------------- */
$u = gpu_parse_https_url('https://pub-abc.r2.dev/uploads/svc/audio/1.mp3');
eq($u['host'] ?? null, 'pub-abc.r2.dev', 'parse ok host');
eq($u['url'] ?? null, 'https://pub-abc.r2.dev/uploads/svc/audio/1.mp3', 'parse ok rebuilt url');
eq(gpu_parse_https_url('HTTPS://PUB-ABC.R2.DEV/x')['url'] ?? null, 'https://pub-abc.r2.dev/x', 'scheme/host case normalised');
eq(gpu_parse_https_url('https://pub-abc.r2.dev:443/x')['host'] ?? null, 'pub-abc.r2.dev', 'explicit :443 ok');
eq(gpu_parse_https_url('https://pub-abc.r2.dev/x?sig=a%2Fb&e=1')['url'] ?? null, 'https://pub-abc.r2.dev/x?sig=a%2Fb&e=1', 'query kept');
foreach ([
    'http://pub-abc.r2.dev/x'                 => 'plain http',
    'ftp://pub-abc.r2.dev/x'                  => 'ftp scheme',
    'javascript:alert(1)'                     => 'javascript scheme',
    '//pub-abc.r2.dev/x'                      => 'scheme-relative',
    'https://user@pub-abc.r2.dev/x'           => 'userinfo',
    'https://user:pw@pub-abc.r2.dev/x'        => 'userinfo with password',
    'https://pub-abc.r2.dev@evil.com/x'       => 'allowed-host@evil userinfo trick',
    'https://evil.com#@pub-abc.r2.dev/'       => 'fragment @ trick',
    'https://evil.com\\@pub-abc.r2.dev/'      => 'backslash trick',
    'https://pub-abc.r2.dev:8443/x'           => 'non-443 port',
    'https://pub-abc.r2.dev:0/x'              => 'port 0',
    'https://127.0.0.1/x'                     => 'IPv4 literal',
    'https://[::1]/x'                         => 'IPv6 literal',
    'https://2130706433/x'                    => 'decimal IP',
    'https://0x7f.0.0.1/x'                    => 'hex IP',
    'https://127.1/x'                         => 'short IP',
    'https://localhost/x'                     => 'localhost',
    'https://pub-abc.r2.dev./x'               => 'trailing dot host',
    'https://%70ub-abc.r2.dev/x'              => 'percent-encoded host',
    'https://pub-abc.r2.dev/a b'              => 'space in path',
    "https://pub-abc.r2.dev/x\r\nHost: evil"  => 'CRLF injection',
    'https://pub-abc.r2.dev/../etc/passwd'    => 'dot-dot segment',
    'https://pub-abc.r2.dev/x/./y'            => 'dot segment',
    'https://pub-abc.r2.dev/x<script>'        => 'angle brackets in path',
    'https://ไทย.com/x'                        => 'IDN unicode host',
    ''                                        => 'empty',
    'https://' . str_repeat('a', 2100) . '.com/' => 'too long',
] as $bad => $why) {
    eq(gpu_parse_https_url($bad), null, 'reject url: ' . $why);
}

$allowed = ['pub-abc.r2.dev', 'ai.xman4289.com'];
ok(gpu_check_result_url('https://pub-abc.r2.dev/generations/u/g/result.json', $allowed) !== null, 'result url on learned host ok');
ok(gpu_check_result_url('https://ai.xman4289.com/files/r.json', $allowed) !== null, 'result url on base host ok');
eq(gpu_check_result_url('https://pub-other.r2.dev/generations/r.json', $allowed), null, 'result url other r2 host rejected');
eq(gpu_check_result_url('https://sub.pub-abc.r2.dev/r.json', $allowed), null, 'result url subdomain rejected');
eq(gpu_check_result_url('https://ai.xman4289.com.evil.com/r.json', $allowed), null, 'result url suffix-host rejected');
eq(gpu_check_result_url('https://pub-abc.r2.dev@169.254.169.254/latest', $allowed), null, 'result url userinfo@metadata rejected');
eq(gpu_check_result_url('http://pub-abc.r2.dev/r.json', $allowed), null, 'result url http rejected');
eq(gpu_check_result_url('https://pub-abc.r2.dev/r.json', []), null, 'no learned hosts → rejected');

/* ---------------- base URL allowlist ---------------- */
eq(gpu_normalize_base_url('https://ai.xman4289.com'), 'https://ai.xman4289.com', 'base ok');
eq(gpu_normalize_base_url(' https://ai.xman4289.com/ '), 'https://ai.xman4289.com', 'base trailing slash/space ok');
eq(gpu_normalize_base_url('https://AI.xman4289.com:443'), 'https://ai.xman4289.com', 'base :443 + case ok');
foreach (['http://ai.xman4289.com', 'https://ai.xman4289.com/api', 'https://evil.com', 'https://ai.xman4289.com@evil.com',
          'https://evil.com@ai.xman4289.com', 'https://ai.xman4289.com?x=1', 'https://ai.xman4289.com:8443', 'https://xai.xman4289.com',
          'https://ai.xman4289.com.evil.com', '', 'ai.xman4289.com'] as $bad) {
    eq(gpu_normalize_base_url($bad), null, 'reject base: ' . $bad);
}

/* ---------------- public IP check ---------------- */
foreach (['8.8.8.8' => true, '104.18.2.3' => true, '2606:4700::1111' => true,
          '10.0.0.1' => false, '172.16.5.4' => false, '192.168.1.1' => false, '127.0.0.1' => false, '127.8.8.8' => false,
          '169.254.169.254' => false, '100.64.0.1' => false, '0.0.0.0' => false, '198.18.0.1' => false,
          '::1' => false, 'fc00::1' => false, 'fe80::1' => false, '::ffff:127.0.0.1' => false, 'not-an-ip' => false] as $ip => $want) {
    eq(gpu_ip_is_public((string) $ip), $want, 'ip public? ' . $ip);
}

/* ---------------- key ---------------- */
$key = 'aqc_' . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
ok(gpu_valid_partner_key($key), 'valid aqc_ base64url key');
ok(!gpu_valid_partner_key("aqc_abcdefghijklmnopqrstu\r\nX-Evil: 1"), 'reject CRLF in key');
ok(!gpu_valid_partner_key('aqc_abc def ghi jkl mno pqr'), 'reject space in key');
ok(!gpu_valid_partner_key('short'), 'reject short key');
ok(!gpu_valid_partner_key(str_repeat('a', 257)), 'reject over-long key');
eq(gpu_key_hint($key), '…' . substr($key, -4), 'keyHint = last 4');
eq(gpu_key_hint(''), null, 'keyHint empty');
ok(strlen(gpu_key_tag($key)) === 8 && !str_contains($key, gpu_key_tag($key)), 'key tag is short digest');

/* ---------------- result validation ---------------- */
$okRes = '{"format":"aquachord-transcription","version":1,"mode":"open","beats":[0.5,1.0],"chords":[{"t0":0,"t1":2.5,"label":"Gm7","conf":0.8}],"timings":{},"lyrics":null}';
$v = gpu_validate_result($okRes);
ok($v instanceof stdClass, 'valid result accepted');
ok($v !== null && str_contains(json_encode($v), '"timings":{}'), 'empty object stays {} after decode/encode');
eq(gpu_validate_result('{"format":"aquachord-transcription","version":"1"}'), null, 'version string rejected');
eq(gpu_validate_result('{"format":"aquachord-transcription","version":2}'), null, 'version 2 rejected');
eq(gpu_validate_result('{"format":"other","version":1}'), null, 'wrong format rejected');
eq(gpu_validate_result('[{"format":"aquachord-transcription","version":1}]'), null, 'top-level array rejected');
eq(gpu_validate_result('{"format":"aquachord-transcription","version":1,"mode":"evil"}'), null, 'unknown mode rejected');
eq(gpu_validate_result('{"format":"aquachord-transcription","version":1,"beats":"x"}'), null, 'beats not array rejected');
eq(gpu_validate_result('<html>nope</html>'), null, 'html rejected');
eq(gpu_validate_result(''), null, 'empty rejected');
eq(gpu_validate_result("{\"format\":\"aquachord-transcription\",\"version\":1,\"x\":\"\xC3\x28\"}"), null, 'invalid utf-8 rejected');
$deep = '{"format":"aquachord-transcription","version":1,"x":' . str_repeat('[', 40) . str_repeat(']', 40) . '}';
eq(gpu_validate_result($deep), null, 'depth > 32 rejected');
$big = '{"format":"aquachord-transcription","version":1,"pad":"' . str_repeat('a', GPU_MAX_RESULT_BYTES) . '"}';
eq(gpu_validate_result($big), null, '> 5 MB rejected');

/* ---------------- remote job / ping / errors ---------------- */
$j = gpu_remote_job(['id' => 'gen_123-ab', 'status' => 'rendering', 'progress' => 1.7, 'etaSeconds' => -5, 'queuePosition' => '3',
    'stageLabel' => "กำลังแยกเสียง\n\x07", 'errorMessage' => 'boom at /workspace/ComfyUI/custom_nodes/x.py see https://int.example/x?key=1']);
eq($j['progress'] ?? null, 1.0, 'progress clamped');
eq($j['etaSeconds'] ?? 'x', 0, 'eta clamped');
ok(array_key_exists('queuePosition', $j) && $j['queuePosition'] === null, 'string queuePosition ignored');
eq($j['stageLabel'] ?? null, 'กำลังแยกเสียง', 'stage label cleaned');
ok(!str_contains((string) $j['errorMessage'], '/workspace') && !str_contains((string) $j['errorMessage'], 'https://'), 'error message stripped of path/url');
eq(gpu_remote_job(['id' => '../../x', 'status' => 'queued']), null, 'bad remote id rejected');
$j2 = gpu_remote_job(['id' => 'abc', 'status' => 'hacked']);
ok(is_array($j2) && $j2['status'] === null, 'unknown status ignored');
eq(gpu_remote_job('nope'), null, 'non-array job rejected');
$p = gpu_remote_ping(['ok' => true, 'enabled' => true, 'secret' => 'x', 'limits' => ['maxAudioMb' => 40, 'maxSeconds' => '600'], 'usage' => ['jobsToday' => 3], 'defaultMode' => 'weird']);
ok(!array_key_exists('secret', $p) && $p['limits']['maxAudioMb'] === 40 && $p['limits']['maxSeconds'] === null && $p['defaultMode'] === 'open', 'ping whitelisted + typed');
foreach ([[401, null, 'GPU_BAD_KEY'], [401, 'BAD_KEY', 'GPU_BAD_KEY'], [503, 'DISABLED', 'GPU_DISABLED'], [503, 'PAUSED', 'GPU_DISABLED'],
          [403, 'MODE_NOT_ALLOWED', 'GPU_MODE_NOT_ALLOWED'], [429, 'DAILY_LIMIT', 'GPU_DAILY_LIMIT'], [429, 'ACTIVE_LIMIT', 'GPU_ACTIVE_LIMIT'],
          [413, 'TOO_LARGE', 'GPU_TOO_LARGE'], [400, 'BAD_INPUT', 'GPU_BAD_INPUT'], [404, 'NOT_FOUND', 'GPU_NOT_FOUND'],
          [409, null, 'GPU_CONFLICT'], [500, null, 'GPU_REMOTE_ERROR'], [302, null, 'GPU_BAD_RESPONSE'], [200, null, 'GPU_BAD_RESPONSE']] as [$s, $c, $want]) {
    $e = gpu_remote_error($s, $c);
    eq($e->errCode, $want, "error map $s/" . ($c ?? '-'));
    ok($e->http !== 401, "error map $s never returns 401 (admin SPA would log out)");
    ok(preg_match('/[\x{0E00}-\x{0E7F}]/u', $e->getMessage()) === 1, "error map $s message is Thai");
}
ok(gpu_remote_error(500, null)->transient && !gpu_remote_error(400, 'BAD_INPUT')->transient, 'transient flag');

/* ---------------- misc cleaners ---------------- */
eq(gpu_display_filename('../../etc/passwd'), 'passwd', 'filename path stripped');
eq(gpu_display_filename('C:\\music\\song.mp3'), 'song.mp3', 'windows path stripped');
eq(gpu_display_filename("a\x00b.mp3"), 'ab.mp3', 'filename control chars stripped');
eq(gpu_display_filename(null), 'audio', 'filename default');
eq(gpu_clean_lyrics("บรรทัด1\r\nบรรทัด2\x07\r"), "บรรทัด1\nบรรทัด2", 'lyrics CRLF + control');
eq(gpu_clean_lyrics("\xC3\x28"), null, 'lyrics invalid utf-8');
eq(gpu_ini_bytes('64M'), 64 * 1024 * 1024, 'ini 64M');
eq(gpu_ini_bytes('1G'), 1024 * 1024 * 1024, 'ini 1G');
eq(gpu_ini_bytes('512K'), 512 * 1024, 'ini 512K');
eq(gpu_ini_bytes('100'), 100, 'ini bytes');
eq(gpu_valid_job_id('gj_' . str_repeat('a', 18)), true, 'job id ok');
eq(gpu_valid_job_id("gj_' OR 1=1 --"), false, 'job id injection rejected');

/* ---------------- config file (atomic write + re-validate on read) ---------------- */
$dir = sys_get_temp_dir() . '/aq-gpu-test-' . bin2hex(random_bytes(4)) . '/private';
$path = $dir . '/aixman.json';
ok(gpu_config_write(['baseUrl' => 'https://ai.xman4289.com', 'partnerKey' => $key, 'defaultMode' => 'sheetsage2',
    'resultHosts' => ['pub-abc.r2.dev', 'bad host!', '10.0.0.1'], 'updatedAt' => 123], $path), 'config write');
$c = gpu_config_read($path);
eq($c['partnerKey'] ?? null, $key, 'config key roundtrip');
eq($c['defaultMode'] ?? null, 'sheetsage2', 'config mode roundtrip');
eq($c['resultHosts'] ?? null, ['pub-abc.r2.dev'], 'config drops invalid result hosts');
ok(gpu_configured($c), 'configured');
eq(array_values(array_filter(scandir($dir), fn($f) => str_ends_with($f, '.tmp'))), [], 'no temp files left behind');
if (DIRECTORY_SEPARATOR === '/') eq(fileperms($path) & 0777, 0600, 'config file mode 0600');
$pub = json_encode(gpu_config_public($c));
ok(!str_contains($pub, $key) && !str_contains($pub, substr($key, 4, 20)), 'public config never contains the key');
ok(gpu_config_mutate(function (array $x) { $x['defaultMode'] = 'open'; return $x; }, $path), 'mutate');
eq(gpu_config_read($path)['defaultMode'], 'open', 'mutate persisted');
ok(gpu_config_mutate(fn(array $x) => null, $path), 'mutate no-op');
file_put_contents($path, json_encode(['baseUrl' => 'https://evil.com', 'partnerKey' => $key]));
ok(!gpu_configured(gpu_config_read($path)), 'tampered baseUrl → not configured');
file_put_contents($path, json_encode(['baseUrl' => 'https://ai.xman4289.com', 'partnerKey' => "aqc_abcdefghijklmnopqrst\r\nX: 1"]));
ok(!gpu_configured(gpu_config_read($path)), 'tampered key with CRLF → not configured');
file_put_contents($path, '{not json');
eq(gpu_config_read($path), [], 'invalid json → empty config');
eq(gpu_config_read($dir . '/missing.json'), [], 'missing file → empty config');
foreach (glob($dir . '/{,.}*', GLOB_BRACE) ?: [] as $f) if (is_file($f)) @unlink($f);
@rmdir($dir); @rmdir(dirname($dir));

echo "gpu php tests: $pass passed, $failN failed\n";
exit($failN === 0 ? 0 : 1);
