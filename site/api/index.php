<?php
/* AquaChord API — front controller (PHP 8.3 + SQLite)
   ทุก request ผ่านไฟล์นี้ (ดู .htaccess) */
declare(strict_types=1);
define('AQUA', 1);

require __DIR__ . '/lib/util.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/auth.php';

set_error_handler(function ($no, $str, $file, $line) {
    error_log("[aquachord] $str @ $file:$line");
    return true;
});
set_exception_handler(function (Throwable $e) {
    error_log('[aquachord] uncaught: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    fail('SERVER_ERROR', 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง', 500);
});

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
// path หลัง /api
$uri  = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$path = preg_replace('#^.*/api#', '', $uri);   // ตัด prefix ถึง /api
$path = '/' . trim($path, '/');
$b = ($method === 'POST' || $method === 'PUT' || $method === 'DELETE') ? body() : [];

function route(string $m, string $pattern, string $method, string $path, callable $fn): void {
    if ($m !== $method) return;
    $rx = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[^/]+)', $pattern) . '$#';
    if (preg_match($rx, $path, $mm)) {
        $args = array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY);
        $fn($args);
    }
}

/* ---------------- system ---------------- */
route($method, '/health', 'GET', $path, function () {
    $ver = '1.0.0';
    $vf = ($_SERVER['DOCUMENT_ROOT'] ?? '') . '/version.json';
    if (is_file($vf)) {
        $j = json_decode((string) @file_get_contents($vf), true);
        if (!empty($j['version'])) $ver = $j['version'];
    }
    send_json(['status' => 'ok', 'service' => 'aquachord-api', 'version' => $ver, 'needs_setup' => admin_count() === 0]);
});

route($method, '/setup-status', 'GET', $path, function () {
    send_json(['needs_setup' => admin_count() === 0]);
});

/* ---------------- first-admin setup ---------------- */
route($method, '/setup', 'POST', $path, function () use ($b) {
    // อนุญาตเฉพาะตอนยังไม่มีแอดมินเลย (กัน race ด้วย transaction + เช็คซ้ำ)
    if (admin_count() > 0) fail('SETUP_DONE', 'ระบบตั้งค่าผู้ดูแลแล้ว', 409);
    $u = field($b, 'username', 32);
    $p = field($b, 'password', 200);
    if (!valid_username($u)) fail('BAD_USERNAME', 'ชื่อผู้ใช้ต้องเป็น a-z, 0-9, _ หรือ . ยาว 3–32 ตัว');
    if (!valid_password($p)) fail('BAD_PASSWORD', 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');

    $db = db();
    $db->beginTransaction();
    try {
        if ((int) $db->query('SELECT COUNT(*) FROM admins')->fetchColumn() > 0) {
            $db->rollBack();
            fail('SETUP_DONE', 'ระบบตั้งค่าผู้ดูแลแล้ว', 409);
        }
        $st = $db->prepare('INSERT INTO admins(username, pass_hash, role, created_at) VALUES(?,?,?,?)');
        $st->execute([$u, password_hash($p, PASSWORD_DEFAULT), 'owner', now_ms()]);
        $id = (int) $db->lastInsertId();
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        error_log('[aquachord] setup failed: ' . $e->getMessage());
        fail('SETUP_FAILED', 'สร้างผู้ดูแลไม่สำเร็จ', 500);
    }
    db()->prepare('UPDATE admins SET last_login = ? WHERE id = ?')->execute([now_ms(), $id]);
    audit($id, 'setup', 'first admin created: ' . $u);
    $token = issue_token($id);
    send_json(['token' => $token, 'admin' => admin_public(['id' => $id, 'username' => $u, 'role' => 'owner', 'created_at' => now_ms(), 'last_login' => now_ms()])], 201);
});

/* ---------------- login / logout / me ---------------- */
route($method, '/login', 'POST', $path, function () use ($b) {
    throttle_check();
    $u = field($b, 'username', 32);
    $p = field($b, 'password', 200);
    $st = db()->prepare('SELECT * FROM admins WHERE username = ?');
    $st->execute([$u]);
    $a = $st->fetch();
    if (!$a || !password_verify($p, $a['pass_hash'])) {
        throttle_hit();
        audit($a['id'] ?? null, 'login_fail', 'user=' . $u);
        fail('BAD_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    // rehash ถ้าอัลกอริทึมเปลี่ยน
    if (password_needs_rehash($a['pass_hash'], PASSWORD_DEFAULT)) {
        db()->prepare('UPDATE admins SET pass_hash = ? WHERE id = ?')
            ->execute([password_hash($p, PASSWORD_DEFAULT), $a['id']]);
    }
    throttle_clear();
    db()->prepare('UPDATE admins SET last_login = ? WHERE id = ?')->execute([now_ms(), $a['id']]);
    audit((int) $a['id'], 'login', 'user=' . $u);
    $token = issue_token((int) $a['id']);
    send_json(['token' => $token, 'admin' => admin_public($a)]);
});

route($method, '/logout', 'POST', $path, function () {
    revoke_token();
    send_json(['ok' => true]);
});

route($method, '/me', 'GET', $path, function () {
    $a = require_admin();
    send_json(['admin' => admin_public($a)]);
});

route($method, '/change-password', 'POST', $path, function () use ($b) {
    $a = require_admin();
    $cur = field($b, 'current', 200);
    $new = field($b, 'new', 200);
    if (!password_verify($cur, $a['pass_hash'])) fail('BAD_CREDENTIALS', 'รหัสผ่านเดิมไม่ถูกต้อง', 401);
    if (!valid_password($new)) fail('BAD_PASSWORD', 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร');
    db()->prepare('UPDATE admins SET pass_hash = ? WHERE id = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $a['id']]);
    // เพิกถอน session อื่นทั้งหมด (คงไว้เฉพาะอันปัจจุบัน)
    $cur_token = bearer_token();
    db()->prepare('DELETE FROM sessions WHERE admin_id = ? AND token <> ?')->execute([$a['id'], $cur_token]);
    audit((int) $a['id'], 'change_password', '');
    send_json(['ok' => true]);
});

/* ---------------- admins ---------------- */
route($method, '/admins', 'GET', $path, function () {
    require_admin();
    $rows = db()->query('SELECT * FROM admins ORDER BY created_at ASC')->fetchAll();
    send_json(['admins' => array_map('admin_public', $rows)]);
});

route($method, '/admins', 'POST', $path, function () use ($b) {
    require_admin();
    $u = field($b, 'username', 32);
    $p = field($b, 'password', 200);
    if (!valid_username($u)) fail('BAD_USERNAME', 'ชื่อผู้ใช้ต้องเป็น a-z, 0-9, _ หรือ . ยาว 3–32 ตัว');
    if (!valid_password($p)) fail('BAD_PASSWORD', 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
    $exists = db()->prepare('SELECT 1 FROM admins WHERE username = ?');
    $exists->execute([$u]);
    if ($exists->fetch()) fail('USERNAME_TAKEN', 'มีชื่อผู้ใช้นี้แล้ว', 409);
    $st = db()->prepare('INSERT INTO admins(username, pass_hash, role, created_at) VALUES(?,?,?,?)');
    $st->execute([$u, password_hash($p, PASSWORD_DEFAULT), 'admin', now_ms()]);
    $id = (int) db()->lastInsertId();
    $me = current_admin();
    audit((int) $me['id'], 'add_admin', $u);
    send_json(['admin' => admin_public(['id' => $id, 'username' => $u, 'role' => 'admin', 'created_at' => now_ms(), 'last_login' => null])], 201);
});

route($method, '/admins/{id}', 'DELETE', $path, function ($a) {
    $me = require_admin();
    $id = (int) $a['id'];
    if ($id === (int) $me['id']) fail('CANNOT_DELETE_SELF', 'ลบบัญชีตัวเองไม่ได้', 400);
    if (admin_count() <= 1) fail('LAST_ADMIN', 'ต้องมีผู้ดูแลอย่างน้อย 1 คน', 400);
    db()->prepare('DELETE FROM admins WHERE id = ?')->execute([$id]);
    audit((int) $me['id'], 'delete_admin', 'id=' . $id);
    send_json(['ok' => true]);
});

/* ---------------- dashboard stats ---------------- */
route($method, '/stats', 'GET', $path, function () {
    require_admin();
    $db = db();
    send_json(['stats' => [
        'songs'     => (int) $db->query('SELECT COUNT(*) FROM songs')->fetchColumn(),
        'published' => (int) $db->query('SELECT COUNT(*) FROM songs WHERE is_public = 1')->fetchColumn(),
        'admins'    => admin_count(),
        'recent'    => $db->query('SELECT id, title, artist, is_public, updated_at FROM songs ORDER BY updated_at DESC LIMIT 6')->fetchAll(),
    ]]);
});

/* ---------------- songs (admin) ---------------- */
function song_public(array $r): array {
    return [
        'id' => $r['id'], 'title' => $r['title'], 'artist' => $r['artist'], 'creator' => $r['creator'],
        'key' => $r['song_key'], 'bpm' => $r['bpm'] !== null ? (float) $r['bpm'] : null,
        'capo' => (int) $r['capo'], 'chordpro' => $r['chordpro'],
        'tabs' => json_decode($r['tabs'] ?: '[]', true), 'source' => $r['source'] ? json_decode($r['source'], true) : null,
        'isPublic' => (int) $r['is_public'] === 1, 'schemaVersion' => 1,
        'createdAt' => (int) $r['created_at'], 'updatedAt' => (int) $r['updated_at'],
    ];
}

function song_from_body(array $b): array {
    return [
        'title'    => field($b, 'title', 200) ?: 'Untitled',
        'artist'   => field($b, 'artist', 200),
        'creator'  => field($b, 'creator', 120),
        'song_key' => field($b, 'key', 12),
        'bpm'      => isset($b['bpm']) && is_numeric($b['bpm']) ? (float) $b['bpm'] : null,
        'capo'     => isset($b['capo']) ? max(0, min(11, (int) $b['capo'])) : 0,
        'chordpro' => field($b, 'chordpro', 60000),
        'tabs'     => json_encode(is_array($b['tabs'] ?? null) ? $b['tabs'] : [], JSON_UNESCAPED_UNICODE),
        'is_public'=> !empty($b['isPublic']) ? 1 : 0,
    ];
}

route($method, '/songs', 'GET', $path, function () {
    require_admin();
    $rows = db()->query('SELECT * FROM songs ORDER BY updated_at DESC')->fetchAll();
    send_json(['songs' => array_map('song_public', $rows)]);
});

route($method, '/songs', 'POST', $path, function () use ($b) {
    $me = require_admin();
    $s = song_from_body($b);
    $id = uid();
    $st = db()->prepare('INSERT INTO songs(id,title,artist,creator,song_key,bpm,capo,chordpro,tabs,source,is_public,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    $st->execute([$id, $s['title'], $s['artist'], $s['creator'], $s['song_key'], $s['bpm'], $s['capo'],
        $s['chordpro'], $s['tabs'], json_encode(['kind' => 'admin'], JSON_UNESCAPED_UNICODE), $s['is_public'], now_ms(), now_ms()]);
    audit((int) $me['id'], 'song_create', $s['title']);
    $row = db()->prepare('SELECT * FROM songs WHERE id = ?'); $row->execute([$id]);
    send_json(['song' => song_public($row->fetch())], 201);
});

route($method, '/songs/{id}', 'GET', $path, function ($a) {
    require_admin();
    $st = db()->prepare('SELECT * FROM songs WHERE id = ?'); $st->execute([$a['id']]);
    $r = $st->fetch();
    if (!$r) fail('NOT_FOUND', 'ไม่พบเพลงนี้', 404);
    send_json(['song' => song_public($r)]);
});

route($method, '/songs/{id}', 'PUT', $path, function ($a) use ($b) {
    $me = require_admin();
    $st = db()->prepare('SELECT id FROM songs WHERE id = ?'); $st->execute([$a['id']]);
    if (!$st->fetch()) fail('NOT_FOUND', 'ไม่พบเพลงนี้', 404);
    $s = song_from_body($b);
    db()->prepare('UPDATE songs SET title=?,artist=?,creator=?,song_key=?,bpm=?,capo=?,chordpro=?,tabs=?,is_public=?,updated_at=? WHERE id=?')
        ->execute([$s['title'], $s['artist'], $s['creator'], $s['song_key'], $s['bpm'], $s['capo'], $s['chordpro'], $s['tabs'], $s['is_public'], now_ms(), $a['id']]);
    audit((int) $me['id'], 'song_update', $a['id']);
    $row = db()->prepare('SELECT * FROM songs WHERE id = ?'); $row->execute([$a['id']]);
    send_json(['song' => song_public($row->fetch())]);
});

route($method, '/songs/{id}/publish', 'POST', $path, function ($a) use ($b) {
    $me = require_admin();
    $pub = !empty($b['isPublic']) ? 1 : 0;
    $st = db()->prepare('UPDATE songs SET is_public = ?, updated_at = ? WHERE id = ?');
    $st->execute([$pub, now_ms(), $a['id']]);
    if ($st->rowCount() === 0) fail('NOT_FOUND', 'ไม่พบเพลงนี้', 404);
    audit((int) $me['id'], 'song_publish', $a['id'] . ' -> ' . $pub);
    send_json(['ok' => true, 'isPublic' => $pub === 1]);
});

route($method, '/songs/{id}', 'DELETE', $path, function ($a) {
    $me = require_admin();
    db()->prepare('DELETE FROM songs WHERE id = ?')->execute([$a['id']]);
    audit((int) $me['id'], 'song_delete', $a['id']);
    send_json(['ok' => true]);
});

/* ---------------- settings ---------------- */
const SETTING_KEYS = ['site_name', 'copyright_email', 'enable_url_ingest', 'announcement_th', 'announcement_en'];

function all_settings(): array {
    $out = [];
    foreach (db()->query('SELECT `key`, `value` FROM settings')->fetchAll() as $r) $out[$r['key']] = $r['value'];
    return $out;
}

route($method, '/settings', 'GET', $path, function () {
    require_admin();
    send_json(['settings' => all_settings()]);
});

route($method, '/settings', 'PUT', $path, function () use ($b) {
    $me = require_admin();
    $st = db()->prepare('INSERT INTO settings(`key`,`value`) VALUES(?,?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)');
    foreach (SETTING_KEYS as $k) {
        if (array_key_exists($k, $b)) $st->execute([$k, is_string($b[$k]) ? mb_substr($b[$k], 0, 2000) : '']);
    }
    audit((int) $me['id'], 'settings_update', '');
    send_json(['settings' => all_settings()]);
});

/* ---------------- public (สำหรับ frontend) ---------------- */
route($method, '/catalog', 'GET', $path, function () {
    $rows = db()->query('SELECT * FROM songs WHERE is_public = 1 ORDER BY updated_at DESC LIMIT 200')->fetchAll();
    send_json(['songs' => array_map('song_public', $rows)]);
});

route($method, '/site', 'GET', $path, function () {
    $s = all_settings();
    send_json(['site' => [
        'site_name'         => $s['site_name'] ?? 'AquaChord',
        'enable_url_ingest' => ($s['enable_url_ingest'] ?? '1') === '1',
        'announcement_th'   => $s['announcement_th'] ?? '',
        'announcement_en'   => $s['announcement_en'] ?? '',
    ]]);
});

/* ---------------- 404 ---------------- */
fail('NOT_FOUND', 'ไม่พบปลายทางนี้', 404);
