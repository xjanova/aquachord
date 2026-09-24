<?php
/**
 * router ของ `php -S` สำหรับเทสต์ E2E ของ /api/gpu/* เท่านั้น (อยู่นอก site/ → ไม่ถูก deploy)
 * - ส่ง /api/* เข้า index.php เหมือน .htaccess บนเซิร์ฟเวอร์จริง
 * - define AQUA_GPU_TEST จาก env AQUA_GPU_TEST_JSON → gpu.php ใช้ CURLOPT_CONNECT_TO + CA ของ mock
 *   (hook นี้มีผลเฉพาะ PHP_SAPI === 'cli-server' — PHP-FPM บนเซิร์ฟเวอร์จริงไม่มีทางเปิด)
 * ใช้โดย tools/test-gpu-e2e.cjs
 */
$hook = getenv('AQUA_GPU_TEST_JSON');
if (is_string($hook) && $hook !== '') {
    $v = json_decode($hook, true);
    if (is_array($v)) define('AQUA_GPU_TEST', $v);
}
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if ($uri === '/api' || strncmp($uri, '/api/', 5) === 0) {
    require $_SERVER['DOCUMENT_ROOT'] . '/api/index.php';
    return true;
}
return false;
