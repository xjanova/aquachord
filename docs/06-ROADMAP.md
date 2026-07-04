# 06 — Roadmap & แผนงาน

> ประมาณการสำหรับทีม 2–3 คน (FE 1, BE/ML 1, +PM/QA ครึ่งตัว) — ปรับตามจริงได้ หัวใจคือ**ลำดับ**และ**เกณฑ์ตรวจรับ**

## เฟส 0 — ตั้งฐาน (2–3 วัน)

- [ ] repo: โครงโฟลเดอร์ตาม README §4, branch protection `main`, CI เปล่า (build + typecheck)
- [ ] ตกลง `SongDoc` ร่วมกัน (docs/04) — **ทุกทีมเซ็นรับก่อนเขียนโค้ด**
- [ ] แปลง UI/UX ที่มีเป็น component inventory + ชื่อ route

**ตรวจรับ:** เปิด PR แรกแล้ว CI เขียว

## เฟส 1 — PWA + ประสบการณ์หลัก (โหมดเดโม) — 2–3 สัปดาห์

- [ ] โครงแอป + ธีม + ฟองอากาศ + ทุก route
- [ ] Demo mode ใน `api/client.ts` (docs/05 §3) + เพลงเดโมแต่งเอง
- [ ] SongView: ChordPro render, แตะคอร์ดฟังเสียง (Karplus-Strong), chord diagram, transpose, autoscroll, ปรับขนาดตัวอักษร
- [ ] Library: บันทึก/โปรด/เล่นบ่อย (Dexie), ค้นหา, ลบแบบมี confirm
- [ ] Copyright modal ครั้งแรก (ข้อความจาก docs/07 §4)
- [ ] PWA ครบ: ติดตั้งได้จริงบน Android + iOS + แท็บเล็ต, เปิดออฟไลน์ได้

**ตรวจรับ:** ติดตั้งบนมือถือจริง เปิดโหมดเครื่องบิน → เปิดเพลงเดโม เปลี่ยนคีย์ ฟังเสียงคอร์ดได้ครบ · Lighthouse PWA ผ่าน

## เฟส 2 — Backend + Editor (ต่อ API จริงด้วย fake pipeline) — 1–2 สัปดาห์

- [ ] FastAPI: `/api/jobs*`, `/api/health` + `PIPELINE_MODE=fake` (docs/02 §10)
- [ ] Validation + rate limit + error codes ตาม docs/03 (รวม SSRF/upload guard ตาม docs/01 §6)
- [ ] FE สลับ demo → API จริงด้วย env เดียว (`VITE_API_URL`)
- [ ] Editor: แก้ chordpro + metadata + พรีวิวสด + บันทึก
- [ ] Export/Import `.aquachord.json`
- [ ] docker-compose (api+redis) + deploy dev server

**ตรวจรับ:** มือถือส่ง URL → progress วิ่งครบ 6 stage → ได้เพลงเดโมกลับมาบันทึกอัตโนมัติ · แก้คอร์ดแล้ว reload ยังอยู่

## เฟส 3 — AI จริง: คอร์ด + เนื้อเพลง — 3–4 สัปดาห์ (ทำคู่ขนานกับเฟส 1-2 ได้)

- [ ] Worker (Docker/Linux): ingest → demucs → beat → chords (madmom) → whisper → assemble (docs/02 §1-6, 9)
- [ ] ชุดทดสอบ 20 เพลง + ตัววัด (docs/02 §11) — chord accuracy ≥ 70%
- [ ] คิว Redis + ยกเลิก job ได้ + TTL ไฟล์ 24 ชม.
- [ ] confidence → UI แสดง "ควรตรวจทานคอร์ดท่อนนี้"

**ตรวจรับ:** เพลงป๊อปไทยจริง 5 เพลง แกะแล้วมือกีตาร์ยืนยัน "เล่นตามได้" (แก้เล็กน้อยใน Editor ยอมรับได้)

## เฟส 3.5 — แท็บ + โน้ตรายแทร็ก — 2 สัปดาห์

- [ ] basic-pitch ต่อ stem + MIDI→Tab (DP, docs/02 §7-8)
- [ ] TabView SVG + แตะโน้ตฟังเสียง + เลือกแทร็ก (กีตาร์/เบส/ร้อง)

**ตรวจรับ:** เพลงบรรเลงง่าย ๆ ได้แท็บที่เล่นตามแล้ว "ใช่เพลงนั้น"

## เฟส 4 — Polish + Beta — 1–2 สัปดาห์

- [ ] จูนแอนิเมชัน/perf (จอ 60fps บนมือถือกลาง ๆ), เสียงกีตาร์ soundfont (option)
- [ ] จัดการ edge cases: เพลงบรรเลง, เพลงยาวเกิน, เน็ตหลุดกลาง job (resume polling), พื้นที่ IndexedDB เต็ม
- [ ] Beta test ผู้ใช้จริง 10-20 คน + เก็บ feedback

## เฟส 5 — บัญชี + สารบัญกลาง + เผยแพร่ — 2–3 สัปดาห์

- [ ] Auth (แนะนำ Supabase Auth) + sync เพลงขึ้น server (`PUT /api/songs`)
- [ ] สารบัญสาธารณะ: default private, กด "เผยแพร่" ต้องผ่าน modal ลิขสิทธิ์ (docs/07 §4.3), แสดงชื่อผู้สร้าง, report/takedown
- [ ] Deploy production (docs/01 §5 แบบ B) + monitoring

## ความเสี่ยงหลัก & แผนรับ

| ความเสี่ยง | ผลกระทบ | แผนรับ |
|---|---|---|
| ความแม่นคอร์ดเพลงไทย (คอร์ดแตก/ทางเดินซับซ้อน) ต่ำกว่าเป้า | ผู้ใช้ผิดหวัง | Editor ต้องดีตั้งแต่เฟส 2 · แสดง confidence · อัปเกรดโมเดลเป็น BTC ภายหลัง |
| YouTube บล็อก yt-dlp / ประเด็น ToS | ช่องทาง URL ใช้ไม่ได้ | ออกแบบ "อัปโหลดไฟล์" เป็นทางหลักตั้งแต่แรก · feature flag ปิด URL ได้ทันที (docs/02 §1) |
| ค่า GPU สูงเกินคาด | ต้นทุน/เพลงแพง | เริ่ม serverless GPU จ่ายราย job (docs/01 §5B) · จำกัดความยาวเพลง · คิวฟรี+แผนจ่ายภายหลัง |
| madmom/torch ติดตั้งยากบน Windows dev | ทีม BE เสียเวลา | worker พัฒนาใน Docker ตั้งแต่วันแรก — ห้ามติดตั้งตรงบน Windows |
| ขอบเขตบวม (โซเชียล, comment, playlist ฯลฯ) | MVP ไม่เสร็จ | ทุกฟีเจอร์ใหม่ต้องเข้า backlog เฟส 5+ เท่านั้น — ห้ามแทรกกลางเฟส |
