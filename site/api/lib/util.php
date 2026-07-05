<?php
if (!defined('AQUA')) { http_response_code(403); exit('forbidden'); }

/* ---- response helpers (ทุก response = no-store กัน edge/proxy cache) ---- */
function send_json($data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('Pragma: no-cache');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

/** error ที่ปลอดภัย — ข้อความไทยทั่วไป ไม่หลุด stack trace */
function fail(string $code, string $message, int $http = 400): void {
    send_json(['error' => ['code' => $code, 'message' => $message]], $http);
}

/** อ่าน JSON body */
function body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}

function esc(?string $s): string {
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}

function now_ms(): int { return (int) round(microtime(true) * 1000); }

/** client ip (หลัง AWS proxy → ใช้ XFF ตัวซ้ายสุด ถ้ามี) */
function client_ip(): string {
    $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if ($xff !== '') {
        $first = trim(explode(',', $xff)[0]);
        if (filter_var($first, FILTER_VALIDATE_IP)) return $first;
    }
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

/** อ่าน field string จาก body พร้อม trim + จำกัดความยาว */
function field(array $b, string $key, int $max = 5000): string {
    $v = $b[$key] ?? '';
    if (!is_string($v)) $v = '';
    $v = trim($v);
    if (mb_strlen($v) > $max) $v = mb_substr($v, 0, $max);
    return $v;
}

function uid(string $prefix = 'sg_'): string {
    return $prefix . bin2hex(random_bytes(9));
}
