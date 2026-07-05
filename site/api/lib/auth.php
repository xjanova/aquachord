<?php
if (!defined('AQUA')) { http_response_code(403); exit('forbidden'); }

const SESSION_TTL_MS   = 7 * 24 * 60 * 60 * 1000;  // 7 วัน
const THROTTLE_WINDOW  = 15 * 60 * 1000;           // 15 นาที
const THROTTLE_MAX     = 8;                          // ล็อกอินผิดได้ 8 ครั้ง/หน้าต่าง

function admin_count(): int {
    return (int) db()->query('SELECT COUNT(*) FROM admins')->fetchColumn();
}

/* ---- validation ---- */
function valid_username(string $u): bool { return (bool) preg_match('/^[a-zA-Z0-9_.]{3,32}$/', $u); }
function valid_password(string $p): bool { return mb_strlen($p) >= 8 && mb_strlen($p) <= 200; }

/* ---- login throttle (per IP) ---- */
function throttle_check(): void {
    $ip = client_ip();
    $since = now_ms() - THROTTLE_WINDOW;
    $st = db()->prepare('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND ts > ?');
    $st->execute([$ip, $since]);
    if ((int) $st->fetchColumn() >= THROTTLE_MAX) {
        header('Retry-After: 900');
        fail('RATE_LIMITED', 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่', 429);
    }
}
function throttle_hit(): void {
    $st = db()->prepare('INSERT INTO login_attempts(ip, ts) VALUES(?, ?)');
    $st->execute([client_ip(), now_ms()]);
    // เก็บกวาดของเก่า
    db()->prepare('DELETE FROM login_attempts WHERE ts < ?')->execute([now_ms() - THROTTLE_WINDOW]);
}
function throttle_clear(): void {
    db()->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([client_ip()]);
}

/* ---- token ---- */
function issue_token(int $adminId): string {
    $token = bin2hex(random_bytes(32));
    $st = db()->prepare('INSERT INTO sessions(token, admin_id, created_at, expires_at, ip) VALUES(?,?,?,?,?)');
    $st->execute([$token, $adminId, now_ms(), now_ms() + SESSION_TTL_MS, client_ip()]);
    return $token;
}

function bearer_token(): ?string {
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if ($h === '' && function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $k => $v) {
            if (strcasecmp($k, 'Authorization') === 0) { $h = $v; break; }
        }
    }
    if (preg_match('/Bearer\s+([a-f0-9]{64})/i', $h, $m)) return $m[1];
    return null;
}

/** คืน admin record ถ้า token ใช้ได้ ไม่งั้น null */
function current_admin(): ?array {
    $token = bearer_token();
    if (!$token) return null;
    $st = db()->prepare(
        'SELECT a.* FROM sessions s JOIN admins a ON a.id = s.admin_id
         WHERE s.token = ? AND s.expires_at > ?'
    );
    $st->execute([$token, now_ms()]);
    $a = $st->fetch();
    return $a ?: null;
}

/** บังคับต้องล็อกอิน — ไม่งั้นตอบ 401 แล้วหยุด */
function require_admin(): array {
    $a = current_admin();
    if (!$a) fail('UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ', 401);
    return $a;
}

function admin_public(array $a): array {
    return [
        'id'         => (int) $a['id'],
        'username'   => $a['username'],
        'role'       => $a['role'],
        'created_at' => (int) $a['created_at'],
        'last_login' => $a['last_login'] !== null ? (int) $a['last_login'] : null,
    ];
}

function revoke_token(): void {
    $token = bearer_token();
    if ($token) db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([$token]);
}
