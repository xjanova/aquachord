# 05 — Frontend Implementation Guide

> สำหรับทีม Frontend — **UI/UX ออกแบบเสร็จแล้ว** เอกสารนี้บอก "ต่อสายไฟยังไง": แต่ละจอใช้ข้อมูลอะไร เรียกอะไร และ logic เฉพาะทาง (เสียงโน้ต, ChordPro, transpose, แท็บ, PWA) ทำอย่างไร

## 1. Stack & โครงการเริ่มต้น

```bash
npm create vite@latest web -- --template react-ts
cd web
npm i zustand dexie dexie-react-hooks react-router-dom
npm i -D vite-plugin-pwa
# ฟอนต์ไทย self-host (ออฟไลน์ได้): เลือกตามที่ทีม UI กำหนด เช่น
npm i @fontsource/mitr @fontsource/anuphan @fontsource/jetbrains-mono
```

## 2. แต่ละจอ: ข้อมูลเข้า/ออก

| จอ | route | อ่านจาก | เขียนไป | จุดระวัง |
|---|---|---|---|---|
| แกะเพลง (Home) | `/` | เพลงล่าสุด (Dexie: `lastPlayedAt` desc) | `POST /api/jobs*` → ได้ SongDoc → `db.songs.put` | debounce ปุ่มส่ง · แสดง copyright modal ครั้งแรก · validate URL/ไฟล์ก่อนส่ง |
| ความคืบหน้า | overlay ใน Home | `GET /api/jobs/{id}` ทุก 1.5s | — | ผู้ใช้กดยกเลิก → `DELETE /api/jobs/{id}` + AbortController · ห้าม setState หลัง unmount |
| ดูเพลง (SongView) | `/song/:id` | `db.songs.get(id)` | `playCount++`, `lastPlayedAt` (ครั้งเดียวตอน mount) | id ไม่พบ → หน้า "ไม่พบเพลง" ไม่ crash |
| แก้ไข (Editor) | `/edit/:id` (`new` = สร้างใหม่) | SongDoc | `db.songs.put` (อัปเดต `updatedAt`) | ออกโดยไม่บันทึก → confirm · พรีวิวสด parse ทุก keystroke ได้ (parser เร็วพอ) แต่ debounce 150ms กันกระตุก |
| สารบัญ (Library) | `/library` | `useLiveQuery` ทั้งตาราง + filter ในหน่วยความจำ | toggle favorite, ลบ (ต้อง confirm) | empty state ต้องมี CTA "แกะเพลงแรก" |
| ตั้งค่า | `/settings` | Zustand persist | export/import `.aquachord.json` | import ต้อง validate (docs/04 §6) |

## 3. Demo Mode (ทำก่อนทุกอย่าง — ปลดล็อกทีม FE จาก backend)

`src/api/client.ts` มีทางเดียวที่ทั้งแอปใช้เรียก backend:

```ts
export async function createTranscriptionJob(
  input: { kind: 'url' | 'file'; url?: string; file?: File },
  onProgress: (p: JobStatus) => void,
  signal?: AbortSignal,
): Promise<SongDoc>
```
- ถ้า `import.meta.env.VITE_API_URL` ว่าง → **จำลอง**: ไล่ stage ละ 1–3 วิ (ingest→separate→chords→lyrics→tabs→assemble) แล้ว resolve ด้วยเพลงเดโมจาก `src/data/demo.ts`
- ถ้ามีค่า → เรียก API จริงตาม [03-API-SPEC.md](03-API-SPEC.md)
- เพลงเดโมให้ใช้**เพลงแต่งเอง** (กันปัญหาลิขสิทธิ์ตั้งแต่ใน repo) — มีตัวอย่างใน docs/04 §2

## 4. เสียงโน้ต/คอร์ด — Web Audio + Karplus-Strong (ไม่ต้องมีไฟล์เสียง)

เสียง "ดีดสายกีตาร์" สังเคราะห์สด ๆ ในเครื่อง ออฟไลน์ได้ 100%:

```ts
let ctx: AudioContext | null = null
export function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()   // iOS: ต้องเรียกใน user gesture แรก
  return ctx
}

export function pluck(midi: number, when = 0, dur = 1.8, vol = 0.4) {
  const c = audio(), sr = c.sampleRate
  const freq = 440 * Math.pow(2, (midi - 69) / 12)
  const N = Math.round(sr / freq)
  const buf = c.createBuffer(1, Math.floor(sr * dur), sr)
  const out = buf.getChannelData(0)
  const ring = new Float32Array(N)
  for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1     // noise burst
  for (let i = 0; i < out.length; i++) {                           // Karplus-Strong
    const j = i % N
    out[i] = ring[j]
    ring[j] = (ring[j] + ring[(j + 1) % N]) * 0.4965               // low-pass + decay
  }
  const src = c.createBufferSource(); src.buffer = buf
  const g = c.createGain(); g.gain.value = vol
  src.connect(g).connect(c.destination)
  src.start(c.currentTime + when)
}

export function strum(midis: number[], gapMs = 35) {
  midis.forEach((m, i) => pluck(m, (i * gapMs) / 1000))
}
```
- **คอร์ด → โน้ต:** parse สัญลักษณ์ (docs/04 §3) → intervals (maj `[0,4,7]`, m `[0,3,7]`, 7 `[0,4,7,10]`, maj7 `[0,4,7,11]`, m7 `[0,3,7,10]`, sus4 `[0,5,7]`, dim `[0,3,6]`, add9 `[0,4,7,14]` ...) → วาง root ที่ octave 3 (`48 + pitchClass`)
- **โน้ตในแท็บ:** `midi = noteNameToMidi(tuning[s]) + f + capo`
- อยากได้เสียงกีตาร์จริง (เฟสหลัง): [`smplr`](https://github.com/danigb/smplr) โหลด soundfont — ต้อง precache เพิ่ม ~2MB
- ปุ่ม/คอร์ดที่กดแล้วมีเสียง ให้เพิ่มแอนิเมชันเด้งรับ (ตาม motion spec ของทีม UI)

## 5. ChordPro: parse + render + คลิกฟังเสียง

**Parser (เขียนเอง ~60 บรรทัด — อย่าลาก lib ใหญ่เข้ามา):** แตกเป็นโครงสร้าง `Section → Line → Segment{chord?, text}` ด้วย regex `/\[([^\]]+)\]/` ต่อบรรทัด + จัดการ directives ตามตาราง docs/04 §2

**Render คอร์ดเหนือเนื้อร้อง (เทคนิคหลัก):**
```html
<span class="seg"><span class="seg-chord">Am</span><span class="seg-text">ฟองคลื่น</span></span>
```
```css
.seg { display: inline-flex; flex-direction: column; vertical-align: bottom; }
.seg-chord { font-weight: 600; cursor: pointer; /* สีตามธีม */ }
.line { white-space: pre-wrap; }   /* รักษาช่องว่าง + ตัดบรรทัดบนจอแคบ */
```
- แทรกกลางคำ (`ทะ[G]เล`) ได้เองโดยธรรมชาติ — segment ต่อกันไม่มีช่องว่าง
- แตะคอร์ด → `strum(chordToMidis(chord))` + เปิด bottom sheet แสดง ChordDiagram (มือถือ) / popover (จอใหญ่)

## 6. Chord Diagram (SVG)

- Dictionary รูปคอร์ดพื้นฐาน ~25 ตัว: `{ "C": { frets: [-1,3,2,0,1,0] }, "G": { frets: [3,2,0,0,0,3] }, "F": { frets: [1,3,3,2,1,1], barre: 1 }, ... }` (index 0 = สาย E ต่ำ, `-1` = mute)
- วาด SVG: เส้นสาย 6 เส้น × เฟรต 4-5 ช่อง, จุดนิ้ว, X/O เหนือ nut, `baseFret` เมื่อรูปอยู่สูง
- คอร์ดที่ไม่มีใน dictionary (เช่นหลัง transpose เป็น `D#m7`): แสดงชื่อ + ปุ่มฟังเสียง (คำนวณโน้ตจากสัญลักษณ์ได้เสมอ) — **ห้าม crash**

## 7. Transpose & Capo

- ปุ่ม ±1 semitone: เดินทุก `[chord]` ใน chordpro ด้วย regex → parse → เลื่อน root/bass → ชื่อใหม่ตามกติกา sharp/flat (docs/04 §3) — **เก็บ offset ไว้ต่างหาก อย่าเขียนทับต้นฉบับ** จนกว่าผู้ใช้กด "บันทึกในคีย์นี้"
- capo: แสดง "Capo 2" + ลดเสียง synth ลงตามจริง (`midi - capo`... จริง ๆ คือ**บวก** fret แต่ชื่อคอร์ดลด — เขียน unit test เรื่องนี้ ทีมสับสนบ่อย)

## 8. Autoscroll (โหมดเล่นตาม)

```ts
useEffect(() => {
  if (!playing) return
  let raf = 0, last = performance.now()
  const step = (now: number) => {
    el.scrollBy(0, ((now - last) / 1000) * speedPxPerSec); last = now
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => cancelAnimationFrame(raf)      // cleanup เสมอ — กัน scroll ผีหลังออกจากหน้า
}, [playing, speedPxPerSec])
```
speed ตั้งได้ 20–150 px/s (persist ใน settings) + แตะหน้าจอ = pause

## 9. Tab Renderer

- **MVP:** SVG เอง — 6 เส้นนอน ต่อระบบละ 3-4 ห้อง (จอมือถือ) เลข fret วางตาม `t` (beat→x) แตะเลข → เล่นโน้ต + ไฮไลต์; แนวตั้งพอสำหรับอ่าน ไม่ต้อง interaction ซับซ้อน
- **เฟส 3+:** [alphaTab](https://alphatab.net) ถ้าต้องการ playback ทั้งเพลง / export Guitar Pro — เขียน converter `TrackTab → alphaTex` (ตรงไปตรงมาเพราะเราเก็บเป็น beat อยู่แล้ว)

## 10. PWA Checklist

- [ ] `vite-plugin-pwa`: `registerType: 'autoUpdate'`, precache `**/*.{js,css,html,svg,png,woff2}`
- [ ] manifest: `name`, `short_name: "AquaChord"`, `display: "standalone"`, `theme_color`/`background_color` ตามธีม, `lang: "th"`, icons **192 + 512 + maskable-512** (PNG) + `apple-touch-icon` 180 (PNG — iOS ไม่รับ SVG)
- [ ] `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` + รองรับ `env(safe-area-inset-*)` (จอมีติ่ง/แท็บเล็ต)
- [ ] iOS ไม่มี `beforeinstallprompt` → ทำหน้าแนะนำ "แชร์ → เพิ่มลงหน้าจอโฮม" · Android/desktop ดัก `beforeinstallprompt` ทำปุ่มติดตั้งเอง
- [ ] AudioContext ต้อง resume ใน user gesture แรก (ดู §4)
- [ ] ทดสอบ Lighthouse PWA ผ่านทุกข้อ บน HTTPS จริง

## 11. กับดักที่ต้องกันตั้งแต่แรก (จะโดน review ตามนี้)

1. `setState` หลัง `await` → เช็ค mounted/`signal.aborted` เสมอ (จอ JobProgress เสี่ยงสุด)
2. ปุ่ม "เริ่มแกะเพลง" ต้อง disabled ระหว่างมี job วิ่ง (กันกดรัว)
3. ยกเลิก job → ต้อง abort ทั้ง polling และแจ้ง `DELETE /api/jobs/{id}` + คืน UI
4. error ทุกจุดแสดงข้อความไทยที่มนุษย์อ่านรู้เรื่อง — ห้ามโชว์ `Exception:` / raw message จาก lib
5. ทุกหน้ามี empty state ที่ตั้งใจออกแบบ (ไม่ใช่หน้าขาว)
6. ตัวเลข/วันที่ในข้อมูลบันทึกเป็น UTC epoch — format เป็นไทยเฉพาะตอนแสดงผล
7. รายการเพลงยาว ๆ ใช้ `useLiveQuery` + index ของ Dexie — อย่า `toArray()` แล้ว filter ใน JS เมื่อเกินพันรายการ
8. แอนิเมชันฟองอากาศ: `canvas` เดียว + `requestAnimationFrame` + หยุดเมื่อ `document.hidden` + เคารพ `prefers-reduced-motion` — ห้ามทำด้วย DOM element ลอยหลายสิบตัว
