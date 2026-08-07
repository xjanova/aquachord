# AquaChord — เว็บแอป (static PWA + หลังบ้าน PHP/MySQL)

โปรโตไทป์ที่ใช้งานจริงบน **https://aquachord.online** — ฝั่งหน้าเว็บเป็น static ล้วน (ไม่มี build step) ฝั่งหลังบ้านเป็น PHP 8.3 + MySQL/MariaDB
(พิมพ์เขียว/สถาปัตยกรรมฉบับเต็มอยู่ที่ [`../docs/`](../docs/))

## โครงสร้าง
```
site/
├── index.html · assets/ · manifest.webmanifest · sw.js   ← PWA แอปหลัก
│   └── assets/js: i18n · music (Web Audio) · chordpro · store
│                  · dsp (เอนจินวิเคราะห์คอร์ด — มีเทสต์ใน ../tools/test-dsp.cjs)
│                  · lyrics + lyrics-worker (Whisper ในเบราว์เซอร์) · analyze · app
├── api/            ← REST API (PHP): index.php + lib/(util,db,auth)
│   └── config.sample.php   ← คัดลอกเป็น ../private/config.php (ใส่รหัส DB จริง)
└── admin/          ← หน้าหลังบ้าน (SPA): index.html · admin.css · admin.js
```

## ฟีเจอร์หน้าเว็บ
**แกะคอร์ดจากไฟล์เสียงจริงในเครื่อง 100%** (DSP: ชดเชยจูนเพี้ยน · แยกเบสช่วยหา root · คอร์ด maj/min/7/m7/maj7 · Viterbi รู้คีย์ 2 รอบ) · **ถอดเนื้อร้องไทย/อังกฤษด้วย Whisper ในเบราว์เซอร์ (Beta — เลือกเปิดได้ ไม่อัปโหลดเสียง)** พร้อมจัดคอร์ดวางเหนือเนื้อร้องตามจังหวะ · แสดง ChordPro + เปลี่ยนคีย์/คาโป้ · เล่นเสียงคอร์ด/โน้ตด้วย Web Audio (Karplus-Strong, ออฟไลน์ได้) · คลังเพลง (localStorage) · แก้ไข/นำเข้า-ส่งออก · **สองภาษา ไทย/อังกฤษ** · **โหมดมืด (ฟองอากาศม่วงเรืองแสง)** · ติดตั้งเป็นแอป (PWA)

## หลังบ้าน (`api/` + `admin/`)
- **ล็อกอินครั้งแรกสร้างแอดมิน** (owner) — ป้องกันสร้างซ้ำ, bearer token, จำกัดล็อกอินผิดต่อ IP
- จัดการสารบัญเพลง (เพิ่ม/แก้/ลบ/เผยแพร่) · ผู้ดูแลหลายคน · ตั้งค่าเว็บ · สถิติ
- endpoint สาธารณะ `/api/catalog`, `/api/site` สำหรับหน้าเว็บดึงไปใช้
- ความปลอดภัย: `password_hash`, PDO prepared statements, `no-store`, รหัส DB อยู่นอก webroot

## ติดตั้งหลังบ้าน (สรุป)
1. สร้าง MySQL database + user (**charset utf8mb4** สำคัญ ไม่งั้นภาษาไทยเพี้ยน)
2. คัดลอก `api/config.sample.php` → `<โดเมน>/private/config.php` (นอก webroot) ใส่ค่าจริง + `chmod 600`
3. ตาราง migrate อัตโนมัติเมื่อเรียก API ครั้งแรก
4. เปิด `/admin/` → สร้างบัญชีผู้ดูแลคนแรก

## Deploy
เป็น static + PHP → ก๊อปไฟล์ใน `site/` ไปที่ `public_html` ได้เลย (ต้องเป็น HTTPS สำหรับ PWA/Service Worker)
บัมป์ `VERSION`/`CACHE` ใน `sw.js` ทุกครั้งที่แก้ asset เพื่อให้เครื่องผู้ใช้โหลดของใหม่

> ⚠️ ห้าม commit `config.php` หรือไฟล์ `.sqlite` — กันไว้ใน `.gitignore` แล้ว
