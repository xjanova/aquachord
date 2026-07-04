# 08 — Contributing: กติกาการทำงานร่วมกัน

## 1. เตรียมเครื่อง

| เครื่องมือ | เวอร์ชัน | หมายเหตุ |
|---|---|---|
| Node.js | ≥ 20 | frontend |
| Python | **3.11** | backend/ML — อย่าใช้ system python (เครื่อง dev บางเครื่องเป็น 3.9) |
| Docker Desktop | ล่าสุด | **worker ML รันใน Docker เท่านั้น** (madmom/torch บน Windows ตรง ๆ = หายนะ) |
| ffmpeg | ล่าสุด | ใน PATH สำหรับ dev ฝั่ง server |

```bash
git clone https://github.com/xjanova/aquachord.git
# frontend
cd web && npm install && npm run dev            # http://localhost:5173 (demo mode — ไม่ต้องมี backend)
# backend (เมื่อโค้ดเฟส 2 เข้าแล้ว)
cd server && python -m venv .venv && .venv/Scripts/activate
pip install -r requirements.txt && uvicorn app.main:app --reload    # http://localhost:8000 (PIPELINE_MODE=fake)
```

## 2. Branch & Commit

- `main` = protected, deployable เสมอ — เข้าได้ทาง PR เท่านั้น (review ≥ 1 คน + CI เขียว)
- branch: `feat/<เรื่อง>` `fix/<เรื่อง>` `docs/<เรื่อง>` เช่น `feat/chord-diagram`
- commit แบบ Conventional Commits (ข้อความไทยได้): `feat(web): เพิ่มปุ่ม transpose ในหน้าเพลง`
- PR เล็ก ๆ (< ~400 บรรทัด diff) — ฟีเจอร์ใหญ่ให้ซอยเป็นหลาย PR หลัง feature flag

## 3. มาตรฐานโค้ด

- **web:** TypeScript `strict: true` · ESLint + Prettier (config กลางใน repo) · ห้าม `any` ยกเว้นมีคอมเมนต์เหตุผล
- **server:** ruff + black · type hints ทุก public function · Pydantic ทุก boundary
- ข้อความ UI **ภาษาไทยเป็นหลัก** และรวมศูนย์ (เตรียม i18n เฟสหลัง) — ห้าม hardcode error อังกฤษหลุดถึงผู้ใช้
- ทุกตัวเลขเวลา/วันที่ที่**บันทึก** = epoch ms UTC (docs/04 §6)

## 4. Testing

| ชั้น | เครื่องมือ | ขั้นต่ำที่ต้องมี |
|---|---|---|
| unit (web) | Vitest | `chordpro parser` · `transpose` (รวมเคส capo!) · `chord→notes` |
| unit (server) | pytest | validators (URL/SSRF/file) · assemble (รวมคอร์ด+เนื้อ) · MIDI→Tab DP |
| e2e (เฟส 2+) | Playwright | flow: วาง URL → progress → เปิดเพลง → transpose → บันทึก |
| pipeline | ชุด 20 เพลง (docs/02 §11) | รันก่อน merge ทุก PR ที่แตะ `pipeline/` |

## 5. CI (GitHub Actions — `.github/workflows/ci.yml`)

ทุก PR: `web` → typecheck + lint + test + build · `server` → ruff + pytest · secret scan (gitleaks) · **ห้าม merge ถ้าแดง**

## 6. Checklist ตอน Review (ผู้ review ไล่ตามนี้)

**ทั่วไป:** ตรงกับ SongDoc spec หรือไม่ · มี test ครอบ logic ใหม่ · ข้อความ UI เป็นไทย/สุภาพ/ไม่มี jargon

**UX (บังคับเช็คทุก PR ฝั่ง web):**
1. จอว่าง (ไม่มีข้อมูล) render ถูก + มี CTA
2. กดปุ่มรัว ๆ ไม่ยิงซ้ำ
3. ยกเลิก/ออกกลางทาง async → ไม่ crash, ไม่มี setState หลัง unmount
4. เน็ตหลุด/timeout → ข้อความไทย + ปุ่มลองใหม่
5. ลบ/เขียนทับ → มี confirm เสมอ

**Security (บังคับเช็คทุก PR ฝั่ง server):**
1. input ภายนอกทุกตัวผ่าน validation (URL, ไฟล์, query)
2. subprocess เป็น list เสมอ ไม่มี string concat / `shell=True`
3. error ที่ตอบ client ไม่มี stack trace/path/เวอร์ชัน lib
4. ไม่มี secret ในโค้ด/log (`grep` ก่อน approve)
5. endpoint ใหม่มี rate limit + คิดเสมอว่า "ถ้าคนยิง 1000 ครั้ง/นาทีจะเกิดอะไร"

## 7. Secrets & Env

- `.env` ห้าม commit — อัปเดต `.env.example` ทุกครั้งที่เพิ่มตัวแปร พร้อมคอมเมนต์อธิบาย
- ตัวแปรหลัก: `VITE_API_URL` (web) · `PIPELINE_MODE=fake|real`, `MAX_UPLOAD_MB`, `ENABLE_URL_INGEST`, `DATA_DIR`, `REDIS_URL` (server)
- production secrets อยู่ใน GitHub Environments / เครื่อง deploy เท่านั้น

## 8. นิยาม "เสร็จ" (Definition of Done)

โค้ด merge แล้ว + CI เขียว + ทดสอบบน**มือถือจริงอย่างน้อย 1 เครื่อง** (ฟีเจอร์ UI) + เอกสารที่เกี่ยวข้องใน `docs/` อัปเดตแล้ว + ไม่มี TODO ที่ไม่มีเลข issue กำกับ
