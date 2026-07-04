# 03 — API Specification (v1)

> Base URL: `/api` · ทุก response เป็น JSON UTF-8 · ตัวข้อมูลหลัก `SongDoc` ดู [04-DATA-FORMAT.md](04-DATA-FORMAT.md)

## 1. หลักการ

- **MVP ไม่มี auth** (anonymous + rate limit ต่อ IP) — เฟส 5 ค่อยเพิ่ม Bearer token โดย endpoint เดิมไม่เปลี่ยน
- ทุก error ใช้รูปแบบเดียว และ `message` เป็น**ภาษาไทยพร้อมแสดงผล** (frontend ไม่ต้อง map เอง):

```json
{ "error": { "code": "JOB_URL_BLOCKED", "message": "ไม่รองรับลิงก์จากเว็บไซต์นี้" } }
```

## 2. Endpoints

### Jobs (งานแกะเพลง)

| Method | Path | ทำอะไร | ตอบ |
|---|---|---|---|
| `POST` | `/api/jobs` | สร้าง job จาก URL — body: `{"url": "https://..."}` | `202` + `JobStatus` |
| `POST` | `/api/jobs/upload` | สร้าง job จากไฟล์ — `multipart/form-data` field `file` | `202` + `JobStatus` |
| `GET` | `/api/jobs/{id}` | ดูสถานะ + ผลลัพธ์เมื่อเสร็จ | `200` + `JobStatus` |
| `GET` | `/api/jobs/{id}/events` | (อัปเกรด) SSE stream ของ `JobStatus` | `text/event-stream` |
| `DELETE` | `/api/jobs/{id}` | ยกเลิก job ที่กำลังวิ่ง | `200` |

**`JobStatus`:**
```json
{
  "id": "j_9f2c1e",
  "stage": "chords",
  "percent": 55,
  "message": "กำลังวิเคราะห์คอร์ดและจังหวะ...",
  "result": null,
  "error": null
}
```
- `stage`: `queued | ingest | separate | chords | lyrics | tabs | assemble | done | error | cancelled`
- เมื่อ `stage == "done"` → `result` = `SongDoc` เต็ม
- เมื่อ `stage == "error"` → `error` = ข้อความไทยทั่วไป (ห้ามมี stack trace / path / รายละเอียดระบบ)
- Polling ที่แนะนำ: ทุก 1.5 วินาที · job ที่จบแล้วเก็บสถานะไว้ให้ดึงได้อย่างน้อย 1 ชั่วโมง

### Songs (สารบัญกลาง — เฟส 5; MVP ใช้ IndexedDB ฝั่ง client ล้วน)

| Method | Path | ทำอะไร |
|---|---|---|
| `GET` | `/api/songs?q=&sort=updated&page=1&limit=20` | ค้นหา/เรียกดูสารบัญ (เฉพาะเพลง `is_public`) — คืนเฉพาะ metadata |
| `GET` | `/api/songs/{id}` | ดู SongDoc เต็ม |
| `PUT` | `/api/songs/{id}` | สร้าง/อัปเดต (upsert) — ใช้ sync จากเครื่องผู้ใช้ |
| `DELETE` | `/api/songs/{id}` | ลบ (เฉพาะเจ้าของ) |

### ระบบ

| Method | Path | ทำอะไร |
|---|---|---|
| `GET` | `/api/health` | `{"status":"ok","pipeline_mode":"fake","version":"0.1.0"}` — ใช้เช็ค deploy + FE ใช้ตัดสินใจเข้า demo mode |

## 3. Error Codes

| code | HTTP | ความหมาย (message ตัวอย่าง) |
|---|---|---|
| `JOB_URL_INVALID` | 400 | "ลิงก์ไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง" |
| `JOB_URL_BLOCKED` | 400 | "ไม่รองรับลิงก์จากเว็บไซต์นี้" (ไม่อยู่ใน allowlist / IP ภายใน) |
| `JOB_FILE_TYPE` | 415 | "รองรับเฉพาะไฟล์เสียง mp3, wav, m4a, flac, ogg, opus" |
| `JOB_FILE_TOO_LARGE` | 413 | "ไฟล์ใหญ่เกิน 100MB" |
| `JOB_TOO_LONG` | 400 | "รองรับเพลงยาวไม่เกิน 12 นาที" |
| `JOB_NOT_FOUND` | 404 | "ไม่พบงานนี้ (อาจหมดอายุแล้ว)" |
| `RATE_LIMITED` | 429 | "ส่งงานถี่เกินไป กรุณารอสักครู่" (+ header `Retry-After`) |
| `PIPELINE_FAILED` | 500 | "แกะเพลงไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" |

## 4. Rate Limits (MVP)

- `POST /api/jobs*`: **5 ครั้ง/ชั่วโมง/IP** และวิ่งพร้อมกันได้ **1 job/IP**
- endpoint อื่น: 120 ครั้ง/นาที/IP
- ตอบ `429` + `Retry-After` เสมอ — frontend ต้องแสดงเวลารอ

## 5. Versioning & ความเข้ากันได้

- ยังไม่ใส่ `/v1` ใน path จนกว่าจะมี breaking change จริง — ใช้ field `version` ใน `/api/health`
- กติกา: **เพิ่ม field ใหม่ได้เสมอ / ห้ามลบ-เปลี่ยนความหมาย field เดิม** (SongDoc มี `schemaVersion` อยู่แล้ว)
- FE ต้อง ignore field ที่ไม่รู้จัก (forward-compatible)
