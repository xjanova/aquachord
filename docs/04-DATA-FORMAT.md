# 04 — Data Format: SongDoc / ChordPro / TabDoc (สัญญากลางของทั้งระบบ)

> **ไฟล์นี้คือสัญญาศักดิ์สิทธิ์** — pipeline, API, viewer, editor, export ทุกตัวอิงโครงสร้างนี้
> เปลี่ยนอะไรที่นี่ = ต้องอัปเดต `schemaVersion` + เขียน migration + แจ้งทุกทีม

## 1. SongDoc (TypeScript interface — ฝั่ง Python ใช้ Pydantic ให้ field ตรงกันเป๊ะ)

```ts
interface SongDoc {
  schemaVersion: 1
  id: string                    // UUID v4
  title: string
  artist?: string               // ศิลปินเดิม
  creator?: string              // ผู้แกะ/ผู้สร้างในระบบเรา — โชว์ในสารบัญ
  key?: string                  // "C" | "Am" | "F#m" ...
  bpm?: number
  capo?: number                 // 0-11
  chordpro: string              // เนื้อเพลง+คอร์ด (ดู §2)
  tabs: TrackTab[]              // แท็บรายแทร็ก (ดู §4) — ว่างได้
  source?: { kind: 'url' | 'upload' | 'manual'; ref?: string; durationSec?: number }
  confidence?: { chords?: number; lyrics?: number }   // 0-1 จาก AI — UI ใช้เตือน "ควรตรวจทาน"
  isPublic?: boolean            // default false — เผยแพร่ต้องผ่าน modal ลิขสิทธิ์
  createdAt: number             // epoch ms (UTC เสมอ — ห้าม locale format)
  updatedAt: number
}
```

**ฝั่ง client เก็บเพิ่ม (เฉพาะใน IndexedDB ไม่ส่งขึ้น server):**
```ts
interface SavedSong extends SongDoc {
  favorite: 0 | 1               // ใช้ number เพราะ IndexedDB index boolean ไม่ได้
  playCount: number
  lastPlayedAt?: number
}
```

## 2. ChordPro (subset ที่รองรับ)

เนื้อเพลง+คอร์ดเก็บเป็นข้อความ ChordPro — มาตรฐานเปิด แก้ไขด้วยมือได้ แลกเปลี่ยนกับแอปอื่นได้

```
{title: คลื่นใส}
{artist: AquaChord Demo}
{key: C}
{tempo: 92}

{c: Intro}
[C] [G] [Am] [F]

{sov}
[C]มองทะเลสีคราม [G]ลมพัดผ่านหัวใจ
[Am]ฟองคลื่นขาวละไม [F]ลอยไปตามสายน้ำ
{eov}

{soc}
[F]ปล่อยใจ[G]ล่องลอย [Em]ไปกับ[Am]คลื่น
[Dm]ให้ทะเลนำ[G]ทาง กลับ[C]บ้าน
{eoc}
```

**Directives ที่ parser ต้องรองรับ (เท่านี้พอ — เจออย่างอื่นให้ข้ามเงียบ ๆ):**

| directive | ความหมาย |
|---|---|
| `{title:}` `{t:}` / `{artist:}` / `{key:}` / `{tempo:}` / `{capo:}` | metadata (ซ้ำกับ SongDoc — ให้ SongDoc ชนะเมื่อขัดกัน) |
| `{c: ...}` | ป้ายกำกับท่อน (Intro, Solo, ...) |
| `{sov}`/`{eov}`, `{soc}`/`{eoc}`, `{sob}`/`{eob}` | verse / chorus / bridge เริ่ม-จบ |
| `[Xxx]` ในบรรทัด | คอร์ด ณ ตำแหน่งนั้น — แทรกกลางคำได้ เช่น `ทะ[G]เล` |

**กติกาบรรทัด:** บรรทัดที่มีแต่คอร์ด (`[C] [G]`) = ท่อนบรรเลง · บรรทัดว่าง = เว้นวรรคท่อน

## 3. ไวยากรณ์สัญลักษณ์คอร์ด

```
chord   := root quality? ("/" bass)?
root    := [A-G] ("#" | "b")?
quality := "" | "m" | "7" | "m7" | "maj7" | "m7b5" | "dim" | "dim7" | "aug"
         | "sus2" | "sus4" | "6" | "m6" | "9" | "add9" | "7sus4" | "11" | "13"
bass    := root                       // เช่น C/G, Am/F#
```
- **Transpose**: เลื่อน root และ bass ทีละครึ่งเสียง — คีย์ที่มีแฟลต (F, Bb, Eb, Ab, Db, Gb และ minor คู่ขนาน) แสดงชื่อแบบแฟลต นอกนั้นใช้ชาร์ป
- parse ไม่ออก (เช่น `[Intro]` หลุดมา) → แสดงเป็นข้อความเฉย ๆ ห้าม crash, ห้าม transpose มัน

## 4. TrackTab — แท็บรายแทร็ก

```ts
interface TrackTab {
  name: string                  // "กีตาร์ (จาก AI)" | "เบส" | "เมโลดี้ร้อง"
  tuning: string[]              // ["E2","A2","D3","G3","B3","E4"] — index 0 = สายเบสสุด (สาย 6)
  bars: TabBar[]
}
interface TabBar { notes: TabNote[] }        // 1 ห้อง
interface TabNote {
  s: number                     // สาย 0-5 (0 = E ต่ำ)
  f: number                     // เฟรต 0-24
  t: number                     // จังหวะในห้อง (0 = ต้นห้อง, 0.5, 1, 1.5 ... หน่วย = beat)
  d?: number                    // ความยาว (beat) — ไม่ใส่ = สั้น
  tech?: 'h' | 'p' | 'b' | 's' | 'v'   // hammer/pull/bend/slide/vibrato (เฟสหลัง)
}
```
- **เวลาเป็น beat ไม่ใช่วินาที** — render/แก้ไข/เปลี่ยน tempo ได้โดยไม่คำนวณใหม่
- โน้ตพร้อมกัน (คอร์ด) = หลาย TabNote ที่ `t` เท่ากัน
- การเล่นเสียง: `midi = noteNameToMidi(tuning[s]) + f (+ capo)` → ส่งเข้า synth

## 5. Schema ฐานข้อมูล

**ฝั่ง client — Dexie (IndexedDB):**
```ts
db.version(1).stores({
  songs: 'id, title, artist, creator, updatedAt, favorite, playCount, lastPlayedAt'
})
```

**ฝั่ง server — PostgreSQL (เฟส 5):**
```sql
CREATE TABLE songs (
  id          uuid PRIMARY KEY,
  owner_id    uuid REFERENCES users(id),
  title       text NOT NULL,
  artist      text,
  creator     text,
  key         text,
  bpm         real,
  capo        int DEFAULT 0,
  chordpro    text NOT NULL DEFAULT '',
  tabs        jsonb NOT NULL DEFAULT '[]',
  source      jsonb,
  confidence  jsonb,
  is_public   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX songs_public_idx ON songs (is_public, updated_at DESC);
CREATE INDEX songs_search_idx ON songs USING gin (to_tsvector('simple', title || ' ' || coalesce(artist,'')));
```

## 6. Export / Import (ทำงานข้ามเครื่องโดยไม่ต้องมีบัญชี)

ไฟล์ `*.aquachord.json`:
```json
{ "format": "aquachord-export", "version": 1, "exportedAt": 1751700000000, "songs": [ /* SongDoc[] */ ] }
```
- Import: ตรวจ `format`+`version` → validate ทีละเพลง (เพลงเสียให้ข้ามพร้อมรายงาน ไม่ล้มทั้งไฟล์) → ถ้า `id` ซ้ำให้ถามผู้ใช้ (เขียนทับ/เก็บทั้งคู่)
- ⚠️ กติกาข้ามเครื่อง: ตัวเลขทั้งหมดเป็น epoch ms UTC, ข้อความ UTF-8 เสมอ — **ห้าม**ใช้ format ตาม locale (เช่น `toLocaleString`) ในข้อมูลที่บันทึก
