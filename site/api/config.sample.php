<?php
/**
 * ตัวอย่างไฟล์ตั้งค่าฐานข้อมูล — คัดลอกไปวางเป็น  <โดเมน>/private/config.php
 * (นอก webroot! db.php อ่านจาก ../../../private/config.php) แล้วใส่ค่าจริง + chmod 600
 * ⚠️ ห้าม commit config.php จริง (อยู่ใน .gitignore แล้ว)
 *
 * เตรียมก่อน: สร้าง database + user ใน MySQL/MariaDB ด้วย charset utf8mb4
 *   CREATE DATABASE admin_aquachord CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 *   CREATE USER 'admin_aquachord'@'127.0.0.1' IDENTIFIED BY '<รหัสผ่าน>';
 *   GRANT ALL PRIVILEGES ON admin_aquachord.* TO 'admin_aquachord'@'127.0.0.1';
 */
return [
    'db_host' => '127.0.0.1',
    'db_port' => 3306,
    'db_name' => 'admin_aquachord',
    'db_user' => 'admin_aquachord',
    'db_pass' => 'CHANGE_ME',
];
