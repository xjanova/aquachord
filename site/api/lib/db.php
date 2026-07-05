<?php
if (!defined('AQUA')) { http_response_code(403); exit('forbidden'); }

/**
 * MySQL/MariaDB (PDO) — เชื่อมด้วยค่าจาก private/config.php (นอก webroot, ไม่ commit)
 * public_html/api/lib/db.php  →  ../../../private/config.php
 * ⚠️ charset=utf8mb4 บังคับ (server default = latin1 → ภาษาไทยจะเพี้ยนถ้าไม่ตั้ง)
 */
function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $cfgPath = dirname(__DIR__, 3) . '/private/config.php';
    if (!is_file($cfgPath)) {
        error_log('[aquachord] missing config.php at ' . $cfgPath);
        fail('DB_ERROR', 'ระบบยังไม่ได้ตั้งค่าฐานข้อมูล', 500);
    }
    $cfg = require $cfgPath;
    if (!is_array($cfg)) { fail('DB_ERROR', 'ระบบขัดข้องชั่วคราว', 500); }

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        $cfg['db_host'] ?? '127.0.0.1', (int)($cfg['db_port'] ?? 3306), $cfg['db_name'] ?? ''
    );
    try {
        $pdo = new PDO($dsn, $cfg['db_user'] ?? '', $cfg['db_pass'] ?? '', [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
            PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci",
        ]);
    } catch (Throwable $e) {
        error_log('[aquachord] db connect failed: ' . $e->getMessage());
        fail('DB_ERROR', 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่', 500);
    }
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $db): void {
    $db->exec("CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(32) NOT NULL UNIQUE,
        pass_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'admin',
        created_at BIGINT NOT NULL,
        last_login BIGINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $db->exec("CREATE TABLE IF NOT EXISTS sessions (
        token CHAR(64) PRIMARY KEY,
        admin_id INT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        ip VARCHAR(45),
        INDEX idx_sess_admin (admin_id),
        CONSTRAINT fk_sess_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $db->exec("CREATE TABLE IF NOT EXISTS login_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        ts BIGINT NOT NULL,
        INDEX idx_attempts_ip (ip, ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $db->exec("CREATE TABLE IF NOT EXISTS songs (
        id VARCHAR(40) PRIMARY KEY,
        title VARCHAR(300) NOT NULL,
        artist VARCHAR(300) NULL,
        creator VARCHAR(160) NULL,
        song_key VARCHAR(16) NULL,
        bpm DOUBLE NULL,
        capo INT NOT NULL DEFAULT 0,
        chordpro MEDIUMTEXT NOT NULL,
        tabs MEDIUMTEXT NOT NULL,
        source TEXT NULL,
        is_public TINYINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_songs_pub (is_public, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $db->exec("CREATE TABLE IF NOT EXISTS settings (
        `key` VARCHAR(64) PRIMARY KEY,
        `value` TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $db->exec("CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NULL,
        action VARCHAR(64),
        detail VARCHAR(600),
        ip VARCHAR(45),
        ts BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $defaults = [
        'site_name'         => 'AquaChord',
        'copyright_email'   => '',
        'enable_url_ingest' => '1',
        'announcement_th'   => '',
        'announcement_en'   => '',
    ];
    $ins = $db->prepare('INSERT IGNORE INTO settings(`key`, `value`) VALUES(?, ?)');
    foreach ($defaults as $k => $v) $ins->execute([$k, $v]);
}

function audit(?int $adminId, string $action, string $detail = ''): void {
    try {
        $st = db()->prepare('INSERT INTO audit_log(admin_id, action, detail, ip, ts) VALUES(?,?,?,?,?)');
        $st->execute([$adminId, $action, mb_substr($detail, 0, 500), client_ip(), now_ms()]);
    } catch (Throwable $e) { /* audit ล้มเหลวไม่ทำให้ request พัง */ }
}
