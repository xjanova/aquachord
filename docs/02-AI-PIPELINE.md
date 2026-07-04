# 02 — AI Pipeline: แกะคอร์ด/เนื้อเพลง/แท็บ ทีละขั้น

> สำหรับทีม Backend/ML — ผลลัพธ์สุดท้ายของ pipeline คือ `SongDoc` (สเปกใน [04-DATA-FORMAT.md](04-DATA-FORMAT.md))
> ทุกขั้นรายงาน progress: `{stage, percent, message_th}`

## 0. สภาพแวดล้อม

- **Python 3.11** (เครื่อง dev ปัจจุบันเป็น 3.9 — ต้องตั้ง venv/conda ใหม่), **ffmpeg** ใน PATH
- GPU: ใช้ได้ทั้ง CPU (ช้ากว่า ~5–10 เท่า) และ CUDA — VRAM ที่พอ: demucs ~7GB, whisper large-v3 ~10GB (หรือใช้ `medium` ~5GB)
- แยก dependencies เป็น 2 ไฟล์: `requirements.txt` (FastAPI — เบา) และ `requirements-ml.txt` (torch, demucs, faster-whisper, basic-pitch, madmom, librosa, yt-dlp)
- เวลารวมต่อเพลง 4 นาที: **GPU ~1–2 นาที / CPU ~8–15 นาที**

## 1. Ingest — รับไฟล์เสียงเข้า

**จาก URL (yt-dlp):**
```python
import yt_dlp
opts = {
    "format": "bestaudio/best",
    "outtmpl": str(job_dir / "source.%(ext)s"),
    "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
    "postprocessor_args": ["-ar", "44100", "-ac", "2"],
    "max_filesize": 200 * 1024 * 1024,
    "noplaylist": True,
}
with yt_dlp.YoutubeDL(opts) as ydl:
    info = ydl.extract_info(url, download=True)   # info["title"], info["duration"]
```
- เช็ค `info["duration"] <= 720` (12 นาที) **ก่อน** ดาวน์โหลด (`extract_info(url, download=False)` รอบแรก)
- SSRF guard + domain allowlist ตาม [01 §6](01-ARCHITECTURE.md)
- ⚠️ ประเด็น ToS ของ YouTube — อ่าน [07-COPYRIGHT-POLICY.md](07-COPYRIGHT-POLICY.md) และเตรียมปิดช่องทาง URL ได้ด้วย feature flag (`ENABLE_URL_INGEST=false`)

**จากไฟล์อัปโหลด:** ตรวจ magic bytes → แปลงเป็น WAV 44.1kHz stereo ด้วย ffmpeg (`subprocess` แบบ list เท่านั้น):
```python
subprocess.run(["ffmpeg", "-y", "-i", src, "-ar", "44100", "-ac", "2", wav], check=True, timeout=300)
```

## 2. Source Separation — แยกแทร็ก (Demucs v4)

```python
# วิธีที่เสถียรสุด: เรียกผ่าน CLI ของ demucs
subprocess.run(["python", "-m", "demucs", "-n", "htdemucs_ft", "-o", str(stems_dir), wav], check=True)
# ได้ stems: vocals.wav / drums.wav / bass.wav / other.wav (กีตาร์/คีย์บอร์ดรวมอยู่ใน other)
```
- ใช้ `htdemucs_ft` (fine-tuned, ดีสุด) — ถ้าช้าไปให้ลด shift/overlap หรือใช้ `htdemucs`
- ผลลัพธ์ที่ขั้นถัดไปใช้: `vocals` → ถอดเนื้อเพลง, `other` → แท็บกีตาร์/เมโลดี้, `bass` → แท็บเบส, mix เดิม → ตรวจคอร์ด

## 3. Beat / Downbeat / Tempo (madmom)

```python
from madmom.features.downbeats import RNNDownBeatProcessor, DBNDownBeatTrackingProcessor
act = RNNDownBeatProcessor()(wav)
beats = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100)(act)
# beats = [(เวลาวินาที, ตำแหน่งในห้อง 1..4), ...] → bpm = 60 / ค่าเฉลี่ยช่วงห่าง
```
- ให้ **bar grid** สำหรับ: จัดคอร์ดลงห้อง, quantize โน้ตแท็บ, และแสดง | คั่นห้องใน ChordPro
- fallback ง่าย: `librosa.beat.beat_track` (ไม่มี downbeat แต่พอใช้)
- ⚠️ madmom ติดตั้งยากบน Windows — worker ควรรันใน Docker (Linux) เสมอ

## 4. Key Detection

```python
import librosa, numpy as np
chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
# เทียบกับ Krumhansl-Schmuckler profile 24 คีย์ → คีย์ที่ correlation สูงสุด
```
หรือ `essentia.standard.KeyExtractor` (แม่นกว่าเล็กน้อย) — เก็บผลลง `SongDoc.key` เช่น `"C"` / `"Am"`

## 5. Chord Recognition — หัวใจของแอป

**ตัวเลือก (เรียงตามคุณภาพ):**

| ตัวเลือก | คุณภาพ | ความยาก | หมายเหตุ |
|---|---|---|---|
| **madmom CNN+CRF** ✅ แนะนำ | ดี, smooth | ปานกลาง | 24 คอร์ด maj/min + N (ไม่มีคอร์ด) |
| autochord | พอใช้ | ง่ายมาก (pip เดียว) | ใช้ prototype ให้ระบบวิ่งครบก่อน |
| BTC (Bi-directional Transformer) | ดีสุด + คอร์ด 7th | ยาก (โหลด checkpoint จาก repo วิจัย) | เฟสอัปเกรด |

```python
from madmom.audio.chroma import DeepChromaProcessor
from madmom.features.chords import DeepChromaChordRecognitionProcessor
chords = DeepChromaChordRecognitionProcessor()(DeepChromaProcessor()(wav))
# [(start_sec, end_sec, "C:maj"), (..., "A:min"), ...]  → แปลง label เป็น "C", "Am"
```

**Post-processing (จำเป็น — ทำเสมอไม่ว่าใช้โมเดลไหน):**
1. **Snap ขอบคอร์ดเข้ากับ beat** ที่ใกล้ที่สุด (จากขั้น 3)
2. **รวมคอร์ดสั้นกว่า 1 จังหวะ** เข้ากับเพื่อนบ้านที่ยาวกว่า (ตัด noise)
3. แปลงชื่อตามคีย์: คีย์แฟลตใช้ Bb ไม่ใช่ A# (กติกาใน docs/04 §3)
4. เก็บ `confidence` ต่อ segment ถ้าโมเดลให้มา → UI ใช้ทำไฮไลต์ "คอร์ดไม่ชัวร์" ให้ผู้ใช้ตรวจ

## 6. Lyrics — ถอดเนื้อเพลง (faster-whisper)

```python
from faster_whisper import WhisperModel
model = WhisperModel("large-v3", device="cuda", compute_type="float16")  # CPU: compute_type="int8"
segments, info = model.transcribe(
    str(stems_dir / "vocals.wav"),
    word_timestamps=True, vad_filter=True, beam_size=5,
)   # language ปล่อย auto-detect (รองรับไทยดี) — ได้ word.start/end/text
```
- **ต้องถอดจากสเต็ม vocals** (ไม่ใช่ mix) — WER ดีขึ้นมาก
- เพลงไทย: whisper ถอดไทยได้ดีแต่สะกดชื่อเฉพาะอาจเพี้ยน → UI ต้องแก้ง่าย (Editor คือฟีเจอร์บังคับ ไม่ใช่ของแถม)
- เพลงไม่มีเนื้อร้อง (บรรเลง): ถ้า vocals stem เงียบ (RMS ต่ำ) ให้ข้ามขั้นนี้ → SongDoc ไม่มีเนื้อร้อง มีแต่คอร์ด/แท็บ

## 7. Melody → MIDI (basic-pitch)

```python
from basic_pitch.inference import predict
model_output, midi_data, note_events = predict(str(stems_dir / "other.wav"))
# note_events = [(start, end, midi_pitch, confidence, ...)] → กรอง confidence < 0.5 → quantize เข้ากับ beat grid
```
รันแยกต่อ stem ที่ต้องการแท็บ: `other` (กีตาร์/เมโลดี้), `bass`, และ `vocals` (แนวร้อง→โน้ต) — ข้าม drums

## 8. MIDI → Tab — จัดโน้ตลงสาย/เฟรต (เขียนเอง ~80 บรรทัด ไม่มี lib สำเร็จ)

Dynamic programming ต่อโน้ตหนึ่งตัวมีตำแหน่งเล่นได้หลายแบบ (สาย,เฟรต) — เลือกเส้นทางที่ "มือขยับน้อยสุด":

```
tuning = [40, 45, 50, 55, 59, 64]           # E2 A2 D3 G3 B3 E4 (midi), เลื่อนตาม capo
candidates(pitch) = [(s, pitch - tuning[s]) for s in 0..5 if 0 <= fret <= 15]

cost(prev, cur) = |cur.fret - prev.fret| * 1.0      # ขยับมือตามคอ
               + |cur.string - prev.string| * 0.3   # ข้ามสาย
               + (2.0 if cur.fret > 12 else 0)      # เลี่ยงเฟรตสูงถ้าไม่จำเป็น
               + (0 if cur.fret == 0 else 0.2)      # สายเปล่าถูกสุด

DP: best[i][c] = min(best[i-1][p] + cost(p, c))  → ย้อน path ได้ (string, fret) ทุกโน้ต
```
- โน้ตพร้อมกัน (คอร์ด): บังคับคนละสาย + ช่วงเฟรตกว้างไม่เกิน 4
- ผลลัพธ์เขียนเป็น `TrackTab` (docs/04 §4) — เวลาเป็น "จังหวะ" (beat) ไม่ใช่วินาที เพื่อให้ render/แก้ไขง่าย

## 9. Assemble — ประกอบเป็น SongDoc

อัลกอริทึมรวมคอร์ด+เนื้อร้อง (pure python, เขียนเองได้เลย):
1. แบ่งคำจาก whisper เป็น "บรรทัด" — ตัดเมื่อเว้นช่วงเงียบ ≥ 0.8 วิ หรือขึ้นห้องใหม่กลุ่มละ ~2 ห้อง
2. เดินคอร์ด segment กับคำคู่กันตามเวลา: คอร์ดที่เริ่มในช่วงคำใด → แทรก `[คอร์ด]` หน้าคำนั้นในบรรทัด ChordPro
3. ช่วงไม่มีเนื้อร้อง (intro/solo): สร้างบรรทัดคอร์ดเปล่า `[C] [G] [Am] [F]` ตามห้อง พร้อม `{c: Intro}`
4. ใส่ metadata: `{title}` (จาก yt-dlp/ชื่อไฟล์ — ผู้ใช้แก้ได้), `{key}`, `{tempo}`
5. แนบ `tabs[]` จากขั้น 8 + `confidence` รวม → ได้ `SongDoc` ครบ

## 10. โหมดพัฒนา & แผนสำรอง

**`PIPELINE_MODE=fake` (สำคัญมากต่อความเร็วทีม):** job วิ่งครบทุก stage (sleep ขั้นละ 1–3 วิ, progress จริง) แล้วคืน `server/data/demo_song.json` → FE ต่อ API จริงได้ตั้งแต่สัปดาห์แรก, ใช้ใน CI ได้, เดโมลูกค้าได้

**Managed API (ถ้าไม่ทำ ML เอง):**

| บริการ | ได้อะไร | ราคาโดยประมาณ |
|---|---|---|
| Music.AI (Moises) | separation + chords + beats + lyrics ครบสุด | ~$0.1–0.4/เพลง |
| Klangio (guitar2tabs) | chords + tab + MusicXML/GP | ตาม plan |
| Replicate (demucs, whisper) | ยกโมเดล OSS ขึ้น cloud — โค้ดฝั่งเราเหมือนเดิม | ~$0.01–0.05/นาทีเสียง |

โครงสร้างโค้ดรองรับอยู่แล้ว: แต่ละขั้นเป็นโมดูลแยก (`pipeline/separate.py`, `pipeline/chords.py`, ...) — จะสลับ implementation เป็นการเรียก API ก็เปลี่ยนแค่ในโมดูลนั้น

## 11. การวัดคุณภาพ (ก่อนปล่อยจริง)

- ชุดทดสอบ ~20 เพลง (ไทย 10 / สากล 10, แนวหลากหลาย) พร้อมคอร์ดเฉลยที่มือกีตาร์ตรวจแล้ว
- ตัววัด: **chord accuracy แบบ weighted overlap** (ใช้ `mir_eval.chord`), **WER เนื้อเพลง** (ไทยตัดคำด้วย `pythainlp` ก่อน), เวลาประมวลผล/เพลง
- เกณฑ์ผ่าน MVP: chord accuracy ≥ 70% (maj/min), เพลงป๊อปโครงสร้างชัดควรได้ 80%+ — ต่ำกว่านี้ให้ผู้ใช้แก้ใน Editor ได้เสมอ (นี่คือเหตุผลที่ Editor อยู่เฟสต้น)
