<?php
if (!defined('AQUA')) { http_response_code(403); exit('forbidden'); }

/**
 * สมาชิก AquaChord = บัญชี XMAN ID (xman4289.com) — ไม่มีรหัสผ่านของตัวเอง
 * ล็อกอินครั้งแรกด้วย XMAN ID → สร้างสมาชิกให้ทันที (ไม่ต้องสมัครแยก) · ครั้งต่อไป → อัปเดตชื่อ/อีเมล/รูป
 *
 * ทางเดิน (เหมือน aixman src/app/api/auth/xman/* ทุกขั้น):
 *   GET /api/auth/xman/start     → PKCE verifier + state ใส่ cookie httpOnly → ส่งไป xman4289.com/auth/xdreamer/authorize
 *   xmanstudio                   → ล็อกอินอยู่แล้วเด้งกลับทันที / ยังไม่ล็อกอิน → หน้า login (มีลิงก์สมัคร) → กลับมาพร้อม ?code&state
 *   GET /api/auth/xman/callback  → ตรวจ state → แลก code+verifier แบบ server-to-server → upsert สมาชิก → ticket ใช้ครั้งเดียว 60 วิ
 *   /#/signed-in?ticket=…        → หน้าเว็บ POST /api/member/redeem → ได้ token (Bearer) เก็บในเครื่อง
 *
 * ตั้งค่าใน private/config.php: xman_sso_secret (= XDREAMER_SSO_SECRET ของ xmanstudio), xman_url, public_url
 * xmanstudio ต้องมี "<public_url>/api/auth/xman/callback" ใน XDREAMER_SSO_REDIRECT_URIS (ตรงทุกตัวอักษร)
 */

const MEMBER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 วัน
const SSO_TICKET_TTL_MS     = 60 * 1000;
const SSO_COOKIE            = 'aq_sso';
const SSO_COOKIE_PATH       = '/api/auth/xman';
const SSO_COOKIE_MAX_AGE    = 10 * 60;

function app_config(): array {
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $p = dirname(__DIR__, 3) . '/private/config.php';
    $c = is_file($p) ? require $p : [];
    $cfg = is_array($c) ? $c : [];
    return $cfg;
}
function xman_url(): string   { return rtrim((string) (app_config()['xman_url'] ?? 'https://xman4289.com'), '/'); }
// ที่อยู่สาธารณะจาก config ไม่ใช่จาก Host header — กัน host header injection พาผู้ใช้ไปโดเมนอื่น
function public_url(): string { return rtrim((string) (app_config()['public_url'] ?? 'https://aquachord.online'), '/'); }
function sso_redirect_uri(): string { return public_url() . '/api/auth/xman/callback'; }

function b64url(string $bin): string { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }

function redirect_to(string $url): void {
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    header('Location: ' . $url, true, 302);
    exit;
}

function sso_cookie(string $value, int $maxAge): void {
    setcookie(SSO_COOKIE, $value, [
        'expires'  => $maxAge > 0 ? time() + $maxAge : time() - 3600,
        'path'     => SSO_COOKIE_PATH,
        'secure'   => str_starts_with(public_url(), 'https://'),
        'httponly' => true,
        // lax ไม่ใช่ strict: ผู้ใช้กลับมาจาก xman4289.com ด้วย top-level redirect — strict จะไม่ส่ง cookie = ล็อกอินพังทุกครั้ง
        'samesite' => 'Lax',
    ]);
}

/** จบทางล็อกอินที่หน้าเว็บ (ข้อมูลอยู่หลัง # ไม่ถึง log ของเซิร์ฟเวอร์) */
function sso_finish(array $q): void {
    sso_cookie('', 0);
    redirect_to(public_url() . '/#/signed-in?' . http_build_query($q));
}

function sso_start(): void {
    if ((string) (app_config()['xman_sso_secret'] ?? '') === '') {
        error_log('[aquachord] xman_sso_secret is not set — XMAN ID sign-in unavailable');
        sso_finish(['error' => 'unavailable']);
    }
    $verifier = b64url(random_bytes(32));
    $state    = b64url(random_bytes(16));
    sso_cookie(json_encode(['v' => $verifier, 's' => $state]), SSO_COOKIE_MAX_AGE);
    redirect_to(xman_url() . '/auth/xdreamer/authorize?' . http_build_query([
        'redirect_uri'   => sso_redirect_uri(),
        'state'          => $state,
        'code_challenge' => b64url(hash('sha256', $verifier, true)),
    ]));
}

/** POST JSON ไป xmanstudio → [httpStatus, array|null] */
function xman_post(string $path, array $payload, string $secret): array {
    $url  = xman_url() . $path;
    $body = json_encode($payload);
    $hdr  = ['Content-Type: application/json', 'Accept: application/json', 'X-Sso-Secret: ' . $secret];
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $hdr,
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 12, CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $raw  = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($raw === false) return [0, null];
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST', 'header' => implode("\r\n", $hdr), 'content' => $body,
            'timeout' => 12, 'ignore_errors' => true, 'follow_location' => 0,
        ]]);
        $raw = @file_get_contents($url, false, $ctx);
        if ($raw === false) return [0, null];
        $code = 0;
        foreach ($http_response_header ?? [] as $h) if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $code = (int) $m[1];
    }
    $j = json_decode((string) $raw, true);
    return [$code, is_array($j) ? $j : null];
}

function sso_callback(): void {
    $secret = (string) (app_config()['xman_sso_secret'] ?? '');
    if ($secret === '') sso_finish(['error' => 'unavailable']);

    $code  = (string) ($_GET['code'] ?? '');
    $state = (string) ($_GET['state'] ?? '');
    if ($code === '' || $state === '' || strlen($code) > 256 || strlen($state) > 256) sso_finish(['error' => 'invalid']);

    $stored = json_decode((string) ($_COOKIE[SSO_COOKIE] ?? ''), true);
    if (!is_array($stored) || !is_string($stored['v'] ?? null) || !is_string($stored['s'] ?? null)) sso_finish(['error' => 'expired']);
    // state ผูกคำตอบนี้กับทางที่ "เบราว์เซอร์นี้" เริ่มเอง — ไม่ตรวจ = ผู้ไม่หวังดีส่ง code ของตัวเองให้เหยื่อล็อกอินเข้าบัญชีเขาได้
    if (!hash_equals($stored['s'], $state)) sso_finish(['error' => 'invalid']);

    [$http, $j] = xman_post('/api/v1/auth/sso/exchange', ['code' => $code, 'code_verifier' => $stored['v']], $secret);
    if ($http === 403) sso_finish(['error' => 'inactive']);
    $u = is_array($j) && !empty($j['success']) && is_array($j['user'] ?? null) ? $j['user'] : null;
    if ($http !== 200 || !$u || !is_int($u['id'] ?? null) || $u['id'] <= 0) {
        if ($http === 0 || $http >= 500) error_log('[aquachord] xman sso exchange failed http=' . $http);
        sso_finish(['error' => ($http === 0 || $http >= 500) ? 'upstream' : 'invalid']);
    }

    $memberId = member_upsert($u);
    $ticket = bin2hex(random_bytes(32));
    db()->prepare('DELETE FROM member_tickets WHERE expires_at < ?')->execute([now_ms()]);
    db()->prepare('INSERT INTO member_tickets(ticket, member_id, expires_at) VALUES(?,?,?)')
        ->execute([hash('sha256', $ticket), $memberId, now_ms() + SSO_TICKET_TTL_MS]);
    sso_finish(['ticket' => $ticket]);
}

function clean_text($v, int $max): string {
    if (!is_string($v)) return '';
    $v = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $v) ?? '');
    return mb_substr($v, 0, $max);
}

/** สร้างสมาชิกใหม่ถ้ายังไม่เคยเห็น XMAN ID นี้ · เคยเห็นแล้ว → อัปเดตข้อมูลล่าสุด */
function member_upsert(array $u): int {
    $avatar = is_string($u['avatar'] ?? null) && preg_match('#^https://[^\s"<>]+$#', $u['avatar']) ? mb_substr($u['avatar'], 0, 500) : null;
    $now = now_ms();
    $st = db()->prepare(
        'INSERT INTO members(xman_user_id, name, email, avatar, created_at, last_login) VALUES(?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email), avatar = VALUES(avatar), last_login = VALUES(last_login)'
    );
    $st->execute([$u['id'], clean_text($u['name'] ?? '', 160), clean_text($u['email'] ?? '', 255), $avatar, $now, $now]);
    $q = db()->prepare('SELECT id, created_at FROM members WHERE xman_user_id = ?');
    $q->execute([$u['id']]);
    $row = $q->fetch();
    if ((int) $row['created_at'] === $now) audit(null, 'member_join', 'xman_user_id=' . $u['id']);
    return (int) $row['id'];
}

function member_redeem(array $b): void {
    $ticket = field($b, 'ticket', 64);
    if (!preg_match('/^[a-f0-9]{64}$/', $ticket)) fail('BAD_TICKET', 'ลิงก์เข้าสู่ระบบไม่ถูกต้อง', 400);
    $db = db();
    $h = hash('sha256', $ticket);
    $st = $db->prepare('SELECT member_id, expires_at FROM member_tickets WHERE ticket = ?');
    $st->execute([$h]);
    $row = $st->fetch();
    // ลบทันทีที่อ่าน ไม่ว่าจะหมดอายุหรือไม่ — ticket ที่หลุดไปใช้ซ้ำไม่ได้
    $db->prepare('DELETE FROM member_tickets WHERE ticket = ?')->execute([$h]);
    if (!$row || (int) $row['expires_at'] <= now_ms()) fail('TICKET_EXPIRED', 'ลิงก์เข้าสู่ระบบหมดอายุ กรุณาลองใหม่', 410);
    $token = bin2hex(random_bytes(32));
    $db->prepare('INSERT INTO member_sessions(token, member_id, created_at, expires_at, ip) VALUES(?,?,?,?,?)')
        ->execute([hash('sha256', $token), (int) $row['member_id'], now_ms(), now_ms() + MEMBER_SESSION_TTL_MS, client_ip()]);
    $db->prepare('DELETE FROM member_sessions WHERE expires_at < ?')->execute([now_ms()]);
    send_json(['token' => $token, 'member' => member_public(member_by_id((int) $row['member_id']))]);
}

function member_by_id(int $id): array {
    $st = db()->prepare('SELECT * FROM members WHERE id = ?');
    $st->execute([$id]);
    return $st->fetch() ?: [];
}

function current_member(): ?array {
    $token = bearer_token();
    if (!$token) return null;
    $st = db()->prepare('SELECT m.* FROM member_sessions s JOIN members m ON m.id = s.member_id WHERE s.token = ? AND s.expires_at > ?');
    $st->execute([hash('sha256', $token), now_ms()]);
    return $st->fetch() ?: null;
}

function member_public(array $m): array {
    return [
        'id'         => (int) ($m['id'] ?? 0),
        'name'       => (string) ($m['name'] ?? ''),
        'email'      => (string) ($m['email'] ?? ''),
        'avatar'     => $m['avatar'] ?? null,
        'provider'   => 'xman',
        'created_at' => (int) ($m['created_at'] ?? 0),
    ];
}

function member_logout(): void {
    $token = bearer_token();
    if ($token) db()->prepare('DELETE FROM member_sessions WHERE token = ?')->execute([hash('sha256', $token)]);
    send_json(['ok' => true]);
}
