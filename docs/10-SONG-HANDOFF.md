# 10 — ส่งเพลงจาก X-DREAMER / aixman มาแกะใน AquaChord (Song Handoff v1)

> สถานะ: **ฝั่ง AquaChord รับได้แล้ว** (`site/assets/js/handoff.js` + เส้นทาง `#/import` ใน `app.js`, เทสต์ `tools/test-handoff.cjs`)
> ฝั่ง aixman (ai.xman4289.com) **ยังไม่ได้ทำ** — เอกสารนี้คือสเปกให้ทำตาม

## 1. ภาพรวม

ผู้ใช้สร้างเพลงในสตูดิโอ X-DREAMER (aixman) → กดปุ่ม **"แกะคอร์ดใน AquaChord"** → แท็บใหม่เปิด AquaChord
→ AquaChord ดึงไฟล์เสียง (+ ชื่อเพลง + เนื้อร้อง) มาใส่ช่องไฟล์ให้ → ผู้ใช้เลือกตัวเลือกแล้วกด "เริ่มแกะเพลง" เอง

```
X-DREAMER (ล็อกอินอยู่)                       aixman server                         AquaChord (เบราว์เซอร์ผู้ใช้)
  กดปุ่ม ──POST /api/studio/aquachord-handoff──▶ ตรวจเจ้าของ row → ออก token อายุสั้น
          ◀──────────── { url } ───────────────
  window.open(url) ──────────────────────────────────────────────────────────▶ #/import?m=<manifest URL>
                                                 GET manifest ◀──────────────── fetch (credentials: omit)
                                                 GET audio    ◀──────────────── fetch (credentials: omit)
                                                                               → File ใส่ช่องไฟล์ + เนื้อร้องใส่ช่อง "เนื้อที่ถูกต้อง"
```

ทำไมต้องมี token: ไฟล์อยู่บน R2 ซึ่ง **ไม่ส่ง CORS** (เบราว์เซอร์เล่นได้แต่อ่านไบต์ไม่ได้) และ `/api/studio/audio/[id]`
ใช้ cookie ของ aixman ซึ่ง AquaChord (คนละโดเมน) ส่งไปไม่ได้ จึงต้องมีลิงก์ที่ **พกสิทธิ์มาเอง อายุสั้น และเปิด CORS ให้ AquaChord เท่านั้น**

## 2. ลิงก์ที่ AquaChord รับ

| แบบ | ลิงก์ | ใช้เมื่อ |
|---|---|---|
| หลัก | `https://aquachord.online/#/import?m=<encodeURIComponent(manifestUrl)>` | ส่งชื่อเพลง + เนื้อร้อง + ไฟล์ |
| สั้น | `https://aquachord.online/#/import?src=<encodeURIComponent(audioUrl)>&title=<ชื่อ>` | ไฟล์อย่างเดียว |

- ข้อมูลอยู่หลัง `#` → ไม่ถูกส่งถึงเซิร์ฟเวอร์ AquaChord/Cloudflare และไม่ติด access log
- AquaChord ลบ `#/import?...` ออกจากแถบที่อยู่และประวัติทันทีที่อ่าน (กดย้อนกลับไม่ดึงซ้ำ)
- **allowlist** (`Handoff.ORIGINS`): `https://ai.xman4289.com`, `https://xman4289.com`, `https://www.xman4289.com` — https เท่านั้น
  ทั้ง manifest URL และ `audio.url` ต้องอยู่ในรายการนี้ · ตอนรัน AquaChord บน `localhost` รับ `http://localhost|127.0.0.1:*` เพิ่ม (ไว้ทดสอบ)
  เพิ่มโดเมนใหม่ = แก้ `ORIGINS` ใน `handoff.js` + เทสต์
- AquaChord **ไม่เริ่มแกะอัตโนมัติ** — ผู้ใช้ต้องยอมรับเงื่อนไขลิขสิทธิ์และกดเริ่มเอง

## 3. Manifest v1 (`GET <manifestUrl>`)

```json
{
  "type": "aquachord.handoff",
  "v": 1,
  "title": "ฝนตกที่หน้าต่าง",
  "lyrics": "บรรทัดที่ 1\nบรรทัดที่ 2",
  "lang": "th",
  "source": { "app": "aixman", "name": "X-DREAMER" },
  "audio": {
    "url": "https://ai.xman4289.com/api/partner/aquachord/handoff/<token>/audio",
    "mime": "audio/mpeg",
    "bytes": 4123456,
    "filename": "song-123.mp3"
  },
  "expiresAt": "2026-10-29T10:15:00Z"
}
```

| field | บังคับ | หมายเหตุ |
|---|---|---|
| `type` | ✓ | ต้องเป็น `aquachord.handoff` |
| `v` | ✓ | `1` · รุ่นอื่น AquaChord แจ้ง "รีเฟรชเพื่ออัปเดตแอป" |
| `audio.url` | ✓ | ต้องอยู่ใน allowlist |
| `title` | | ตัดที่ 200 ตัวอักษร · ใช้เป็นชื่อเพลงใน AquaChord (กลายเป็นชื่อไฟล์) |
| `lyrics` | | ตัดที่ 20,000 ตัวอักษร · ใส่ช่อง "เนื้อร้องที่ถูกต้อง" → AI จัดเนื้อให้ตรงเพลง (LyricFix) และเปิดถอดเนื้อให้ |
| `lang` | | `th` / `en` / `auto` · อื่น ๆ ไม่สนใจ |
| `source.name` | | แสดงในข้อความ "รับเพลงจาก …" (ค่าเริ่มต้น X-DREAMER) |
| `audio.bytes` | | ถ้าเกิน 80 MB AquaChord ปฏิเสธก่อนโหลด |
| `audio.mime`, `audio.filename` | | ใช้เดานามสกุลเมื่อ response ไม่บอกชนิด |
| `expiresAt` | | ISO 8601 · หมดแล้ว → "ลิงก์หมดอายุ" |

## 4. สิ่งที่ฝั่ง aixman ต้องทำ

### 4.1 ออกลิงก์ — `POST /api/studio/aquachord-handoff`
- auth: `getCurrentUserId()` (cookie หรือ Bearer ของแอป xdreamerapp ก็ได้) · body `{ "generationId": 123 }`
- ตรวจเหมือน `/api/studio/audio/[id]`: row เป็นของผู้ใช้ (หรือแอดมิน), `type === 'audio'`, มี `resultUrl`, `mediaDeletedAt` ว่าง, นามสกุลเป็นเสียง
- token แนะนำแบบ **stateless HMAC** (ไม่ต้องมี migration): `base64url(genId.exp).base64url(HMAC-SHA256(secret, genId.exp))`
  secret ใหม่ `AQUACHORD_HANDOFF_SECRET` · อายุ 15 นาที · ตรวจด้วย `timingSafeEqual`
- ตอบ `{ "url": "https://aquachord.online/#/import?m=" + encodeURIComponent(manifestUrl) }` แล้วฝั่ง UI `window.open(url, '_blank', 'noopener')`
  (แอป Flutter เปิด url เดียวกันในเบราว์เซอร์)

### 4.2 Manifest — `GET /api/partner/aquachord/handoff/[token]`
- ตรวจ token → อ่าน row → ตอบ JSON ตามข้อ 3 (`title` จากชื่อเพลง/พรอมต์, `lyrics` จาก `params.lyrics`)
- ห้ามคืน `resultUrl` ของ R2 ออกไป — `audio.url` ชี้ route ข้อ 4.3 เท่านั้น
- token ผิด/หมดอายุ/ไฟล์ถูกลบ → **410** (AquaChord แจ้ง "ลิงก์หมดอายุ — ส่งใหม่")

### 4.3 ไฟล์เสียง — `GET /api/partner/aquachord/handoff/[token]/audio`
- สตรีมจาก R2 แบบเดียวกับ `/api/studio/audio/[id]` (ไม่ต้องรองรับ Range — AquaChord โหลดทั้งไฟล์)
- `content-type` ชนิดเสียงจริง + `content-length`

### 4.4 Header ของทั้ง 4.2 และ 4.3
```
Access-Control-Allow-Origin: https://aquachord.online
Vary: Origin
Cache-Control: no-store
Access-Control-Expose-Headers: Content-Length, Content-Type
```
- AquaChord ยิงแบบ `credentials: 'omit'` ไม่มี header พิเศษ → เป็น simple GET **ไม่มี preflight ไม่ต้องทำ OPTIONS**
- ห้ามใส่ `Access-Control-Allow-Credentials` · ห้ามใช้ `*` (จำกัดเฉพาะ AquaChord)
- ไม่ต้อง log token

### 4.5 ปุ่มใน UI
`src/components/xdreamer/audio.tsx` → `AudioResult` (มี `genId`, `title`) เป็นจุดที่ดีที่สุด — ปุ่มแสดงเฉพาะเมื่อมี `genId`

## 5. ทดสอบ
- `node tools/test-handoff.cjs` — แยกลิงก์, allowlist (โดเมนปลอม/http/user:pass), manifest, หมดอายุ, 410, HTML แทนเสียง, เกินขนาดระหว่างสตรีม, timeout, ไม่ส่ง cookie
- ทดสอบปลายทางจริงบนเครื่อง: เสิร์ฟ AquaChord ที่ `http://localhost:<port>` แล้วเปิด `#/import?m=http://127.0.0.1:<port2>/manifest.json`
  (เซิร์ฟเวอร์ทดสอบต้องตอบ `Access-Control-Allow-Origin` ด้วย)
