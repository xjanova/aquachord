# 09 — GPU Transcribe: ถอดคอร์ด + เนื้อร้องไทย + ทำนอง ผ่านระบบเช่า GPU ของ aixman

> สถานะ: สเปกกลาง (contract) ของงาน 2026-09-24 — ทุกส่วนต้องยึดไฟล์นี้ ถ้าต้องเปลี่ยนสัญญา แก้ที่นี่ก่อน
> การตัดสินใจของเจ้าของ: (1) ใช้ระบบเช่า GPU ของ aixman โดยเพิ่ม **เมนูแยก "AquaChord"** ในหลังบ้าน aixman
> (2) โมเดลสองชุดสลับได้ — `open` (ไลเซนส์ใช้เชิงพาณิชย์ได้, ค่าเริ่มต้น) / `sheetsage2` (CC-BY-NC, แอดมินเลือกเปิด)
> (3) เฟสแรก **เปิดให้แอดมิน AquaChord ใช้เท่านั้น** — ผู้ใช้ทั่วไปยังใช้ engine ในเบราว์เซอร์ (analyze.js)

## 0. ภาพรวม

```
[AquaChord PWA (admin)] --multipart--> [AquaChord PHP /api/gpu/*] --HTTPS + partner key--> [aixman /api/partner/v1/*]
                                                                                               |
                                                   GenerationService + GpuQueue (เช่าเครื่อง Vast/SimplePod/RunPod)
                                                                                               |
                                                    ComfyUI v0.36.0 worker + custom node pack "comfyui-aquachord"
                                                    (LoadAudio -> AquaChordTranscribe -> ui.text = result JSON)
                                                                                               |
                                              aixman เก็บผล JSON ขึ้น R2 -> partner GET คืน resultUrl
[AquaChord PHP] ดึง result JSON (server-side) เก็บลง MySQL -> PWA แปลงเป็น SongDoc v2 -> คลังเพลง
```

หลักการ:
- **aixman ไม่รู้จัก SongDoc** — มันส่ง `TranscriptionResult` (§4) กลับมาเท่านั้น การประกอบ ChordPro/โน้ตทำใน JS ของ AquaChord (ที่เดียว ใช้ร่วมกับ engine ในเครื่อง)
- เบราว์เซอร์ไม่เคยคุยกับ aixman ตรง ๆ (ไม่มี CORS, key อยู่ฝั่ง PHP เท่านั้น)
- ทุกขั้นเป็น **ร่างให้ผู้ใช้แก้** — UI ต้องบอกเสมอว่าเป็นผลจาก AI

---

## 1. Custom node pack — `worker/comfyui-aquachord/` (อยู่ใน repo AquaChord)

aixman โคลน repo `https://github.com/xjanova/aquachord` ที่ commit ที่ pin ไว้ แล้วใช้เฉพาะโฟลเดอร์ย่อย
(`customNodes: [{ repo, ref, subdir: 'worker/comfyui-aquachord' }]` — aixman ต้องรองรับ `subdir` เพิ่ม ดู §2.4)

### 1.1 Node `AquaChordTranscribe` (สัญญาที่ aixman ใช้สร้างกราฟ — ห้ามเปลี่ยนชื่อ/ชนิดโดยไม่อัปเดตไฟล์นี้)

| | ชื่อ | ชนิด | ค่า |
|---|---|---|---|
| required | `audio` | `AUDIO` | จาก `LoadAudio` |
| required | `mode` | combo | `["open", "sheetsage2"]` default `open` |
| required | `language` | combo | `["th", "auto", "en"]` default `th` |
| required | `lyrics` | `STRING` (multiline) | default `""` — เนื้อเพลงที่ผู้ใช้วาง ว่าง = ให้ ASR ถอดเอง |
| required | `options` | `STRING` | default `"{}"` — JSON: `{"stages":["separate","beats","chords","lyrics","melody"], "maxSeconds":600}` (key ที่ไม่รู้จักให้ข้าม) |
| optional | `sheetsage_encoder` | `AUDIO_ENCODER` (ชนิดจริงตาม ComfyUI v0.36.0 — ตรวจจาก source) | ต่อเฉพาะ mode=`sheetsage2` |

- `RETURN_TYPES = ("STRING",)`, `RETURN_NAMES = ("result_json",)`, **`OUTPUT_NODE = True`**
- คืน `{"ui": {"text": [result_json]}, "result": (result_json,)}` — aixman อ่าน bucket `text` จาก `/history`
- `CATEGORY = "audio/aquachord"`
- รายงานความคืบหน้าผ่าน `comfy.utils.ProgressBar` (aixman มี listener อยู่แล้ว)
- ถ้าขั้นใดล้ม (เช่น ASR) ให้ **ใส่ `warnings[]` แล้วไปต่อ** — ล้มทั้งงานเฉพาะเมื่ออ่านเสียงไม่ได้/ยาวเกิน/ไม่มีขั้นไหนสำเร็จเลย (ข้อความ error ภาษาอังกฤษสั้น ๆ ห้ามมี path/secret)

### 1.2 กราฟที่ aixman สร้าง (inject-only, ไม่มี UI template)

```js
'1': { class_type: 'LoadAudio', inputs: { audio: p.audioFilename } }
// เฉพาะ mode === 'sheetsage2':
'2': { class_type: 'AudioEncoderLoader', inputs: { audio_encoder_name: 'sheetsage2_bf16.safetensors' } }
'3': { class_type: 'AquaChordTranscribe', inputs: {
        audio: ['1', 0], mode, language, lyrics, options,
        sheetsage_encoder: ['2', 0] /* เฉพาะ sheetsage2 */ } }
```
(ชื่อ input ของ `AudioEncoderLoader` ให้ตรวจกับ `D:\Temp\audio-in\comfy036` / baseline schema ของ aixman)

### 1.3 Pipeline ภายใน node

| ขั้น | `open` (ค่าเริ่มต้น — ไลเซนส์เปิด) | `sheetsage2` |
|---|---|---|
| แยกเสียงร้อง | Mel-Band RoFormer (Kim, weights MIT `KimberleyJSN/melbandroformer`; โค้ดสถาปัตยกรรม vendored จาก lucidrains/BS-RoFormer MIT) | เหมือน open (ต้องใช้กับเนื้อร้อง) |
| จังหวะ/ห้อง | `beat-this` (MIT) final0 → beats + downbeats | SheetSage2 events |
| คอร์ด | `lv-chordia` (MIT, large vocab) → map เป็น grammar AquaChord (docs/04 §3) | SheetSage2 events (chords) |
| คีย์ | Krumhansl บน chroma + ตัดสินด้วยคอร์ด | SheetSage2 key |
| ทำนอง | f0 จาก vocal stem (`torchfcpe` MIT) → ตัดโน้ต (เสถียร + onset + พยางค์) | SheetSage2 melody (voice Vocal) |
| เนื้อร้อง (มี lyrics) | forced alignment CTC `airesearch/wav2vec2-large-xlsr-53-th` (CC-BY-SA, ใช้ inference ได้) + Viterbi เขียนเอง (ไม่พึ่ง torchaudio.forced_align ที่ deprecated) | เหมือน open |
| เนื้อร้อง (ไม่มี lyrics) | ASR `Qwen/Qwen3-ASR-1.7B` (Apache-2.0, รองรับไทย + เสียงร้องมีดนตรี) → จัดเวลาด้วย CTC เดียวกัน | เหมือน open |
| พยางค์ไทย | `pythainlp` `syllable_tokenize` (engine ที่ติดตั้งได้จริง — han_solo ถ้าได้) | เหมือน open |

ข้อบังคับ:
- **ห้ามใส่ `torch`/`torchaudio`/`torchvision`/`triton` ใน `requirements.txt`** (worker ล็อกด้วย `PIP_CONSTRAINT`, image = torch 2.13 cu130, Python 3.12, Ubuntu 24.04)
- **ห้ามใช้**: madmom models, Essentia models, MMS (NC), yuvraj108c/ComfyUI-Whisper (NC-SA), โค้ด NNLS-Chroma (GPL)
- โหลดโมเดลทีละตัวแล้วปล่อย VRAM (`del` + `torch.cuda.empty_cache()`) — เป้า VRAM ≤ 12 GB
- น้ำหนักโหลดตอน runtime ด้วย `huggingface_hub` ลง `<ComfyUI>/models/aquachord/` (+ เริ่ม prefetch เป็น background thread ตอน import node) — node ต้องรอ prefetch ถ้ายังไม่เสร็จ
- ต้องรันได้ทั้ง CUDA (Ampere+, bf16/fp16 ได้) และ CPU/Pascal (fp32 เท่านั้น) — เลือก dtype จาก `torch.cuda.get_device_capability()`
- มี CLI สำหรับทดสอบนอก ComfyUI: `python -m aquachord_pipeline <audio> [--lyrics file.txt] [--mode open|sheetsage2] [--out result.json]`
- ความยาวสูงสุด 600 วินาที (ตัดส่วนเกิน + warning)

### 1.4 License/attribution
`worker/comfyui-aquachord/LICENSE` = MIT (ของเรา) + `THIRD_PARTY.md` ระบุโมเดล/โค้ดที่ใช้ทุกตัวพร้อม license และบอกชัดว่า mode `sheetsage2` ใช้น้ำหนัก CC-BY-NC-4.0

---

## 2. aixman — สิ่งที่ต้องเพิ่ม (repo `D:\Code\aixman`, commit ตรง main = deploy prod)

### 2.1 รับผลลัพธ์แบบข้อความ
- `worker-client.ts` `collectComfyOutputs`/`pollComfy`: อ่าน bucket `text` (array ของ string) จาก `/history` outputs → `PollOutcome.texts: string[]`
- งานที่มีแต่ `texts` ต้อง **สำเร็จ** (ไม่ใช่ "produced no video output")
- `GpuQueue.settleSuccess`: ถ้ามี texts → อัปโหลดขึ้น R2 เป็น `application/json; charset=utf-8` (นามสกุล `.json`) ใต้ `generations/<userId>/<generationId>/` → `resultUrl`
- `CatalogEntry.outputKind` เพิ่ม `'text'` (และ `extensionFor`/`mediaKindOf` รู้จัก json) — ของเดิมห้ามเปลี่ยนพฤติกรรม

### 2.2 Catalog entry `aquachord-transcribe`
- `kind: 'audio'`, `outputKind: 'text'`, **`partnerOnly: true`** (flag ใหม่: ซ่อนจาก `/api/models`, studio, community/GPUxMINE dispatch; `GenerationService` ปฏิเสธถ้าไม่ได้มาจาก partner route)
- `customNodes: [{ repo: 'https://github.com/xjanova/aquachord', ref: '<commit sha>', subdir: 'worker/comfyui-aquachord' }]`
- `downloads`: `sheetsage2_bf16.safetensors` (ตัวเดียวกับ yue2-cover, dest `audio_encoders`) — โมเดลอื่น node โหลดเอง
- `hardware: { minVramMb: 16384, diskGb: 60, gpuModels: [], minArch: 'ampere', minCudaVersion: '13.0' }`
- `needs: { audio: true }`, `inject` ตาม §1.2, `bind: () => []` (ค่าทั้งหมดอยู่ใน inject)
- `pricing: { creditsPerUnit: 0, costPerUnit: 0.03 }` (ไม่หักเครดิต — คุมเงินด้วยเพดานใน §2.3)
- `baselineSecondsPerUnit`: ประมาณ (งานเดียวต่อเพลง) ~150
- `limits: { maxDuration: 600 }`

### 2.3 เมนูแยก "AquaChord" ในหลังบ้าน aixman — `/admin/aquachord`
ตั้งค่าเก็บใน `ai_settings` group `aquachord` (อ่านสดทุกครั้ง):

| key | default | ความหมาย |
|---|---|---|
| `aquachord_enabled` | `false` | ปิด = partner API ตอบ 503 |
| `aquachord_partner_key_sha256` | — | เก็บเฉพาะ digest; key จริงแสดง **ครั้งเดียว** ตอนสร้าง/หมุนใหม่ |
| `aquachord_service_user_id` | admin ที่กดตั้งค่า | ผู้ถือ generation rows |
| `aquachord_default_mode` | `open` | |
| `aquachord_allow_sheetsage2` | `false` | ปิด = mode sheetsage2 ถูกปฏิเสธ 403 |
| `aquachord_max_jobs_per_day` | `20` | นับตาม UTC วัน |
| `aquachord_max_active_jobs` | `2` | queued+running พร้อมกัน |
| `aquachord_max_audio_mb` | `40` | เพดานอัปโหลด partner (แยกจาก 12 MB ของลูกค้า) |
| `aquachord_max_seconds` | `600` | |
| `aquachord_retention_days` | `7` | อายุไฟล์เสียง + ผล JSON บน R2 |

หน้า admin แสดง: สถานะ (เปิด/ปิด, มี key, readiness ของโมเดล, ping ล่าสุดจาก AquaChord), ปุ่ม "สร้างคีย์ใหม่" (ยืนยันก่อน, โชว์ครั้งเดียว + ปุ่มคัดลอก), ฟอร์มตั้งค่าข้างบน, ตารางงานล่าสุด 50 งาน (เวลา, externalRef/title, mode, สถานะ, GPU-วินาที, costUsd, error), ลิงก์ไป `/admin/gpu` และเมนูใน sidebar หลังบ้าน (ภาษาไทย)

### 2.4 `customNodes.subdir`
`provision.ts`: ถ้ามี `subdir` → clone ไปที่ temp แล้ว checkout ref → ย้าย/ลิงก์ `<tmp>/<subdir>` ไปเป็น `custom_nodes/<basename(subdir)>` → pip install `requirements.txt` ของ subdir นั้น (ภายใต้ `PIP_CONSTRAINT` เดิม)

### 2.5 Partner API — `/api/partner/v1/*`
Auth: header **`X-Aixman-Partner-Key`** → sha256 → เทียบ constant-time กับ `aquachord_partner_key_sha256` (ห้ามใช้ `Authorization: Bearer` เพราะ `resolveUserId` ตีความเป็น mobile JWT) · ห้าม log key · ทุก response `Cache-Control: no-store`
ข้อผิดพลาดใช้รูป `{ "error": { "code": "...", "message": "ภาษาไทยสั้น ๆ" } }`

| method | path | body | ผล |
|---|---|---|---|
| GET | `/api/partner/v1/ping` | — | `200 {ok:true, partner:'aquachord', enabled, model:{key, readiness}, allowSheetSage2, defaultMode, limits:{maxAudioMb,maxSeconds,maxJobsPerDay,maxActiveJobs}, usage:{jobsToday, activeJobs}}` (บันทึกเวลา ping ล่าสุด) |
| POST | `/api/partner/v1/uploads` | multipart field `file` (mp3/wav/flac/ogg/m4a ตรวจ magic bytes) | `201 {url, bytes, contentType}` — เก็บ R2 key `uploads/<serviceUserId>/audio/<uuid>.<ext>` ให้ผ่าน gate `keyFromPublicUrl` เดิม |
| POST | `/api/partner/v1/jobs` | JSON `{inputAudio, mode?, language?, lyrics? (≤5000), title? (≤200), externalRef? (≤64), durationSec?}` + header **`Idempotency-Key`** (บังคับ, ≤64) | `202 {job}` — key ซ้ำ = คืนงานเดิม (ไม่สร้างซ้ำ) |
| GET | `/api/partner/v1/jobs/{id}` | — | `200 {job}` |
| DELETE | `/api/partner/v1/jobs/{id}` | — | ยกเลิกได้เฉพาะ queued → `200 {job}` / `409` |

`job` = `{ id, externalRef, status: 'queued'|'starting'|'rendering'|'completed'|'failed'|'cancelled', stageLabel (ไทย), progress (0–1|null), etaSeconds|null, etaLabel|null, queuePosition|null, mode, createdAt, completedAt|null, resultUrl|null, errorMessage|null, expiresAt|null, gpuSeconds|null }`

รหัสผิดพลาด: 401 `BAD_KEY` · 503 `DISABLED`/`PAUSED` · 403 `MODE_NOT_ALLOWED` · 429 `DAILY_LIMIT`/`ACTIVE_LIMIT` · 413 `TOO_LARGE` · 400 `BAD_INPUT` · 404 `NOT_FOUND`
- partner job ข้าม readiness gate ได้ (โมเดลอยู่ `tuning` ได้ — งานสำเร็จแรกเลื่อนเป็น `ready` ตามกลไกเดิม) แต่ **ไม่ใช้สิทธิ์ admin อื่น** (ไม่ใช้ adminRun overrides)
- idempotency: ตารางใหม่ `ai_partner_jobs` (`db/migrations/*.sql`, `CREATE TABLE IF NOT EXISTS`, prefix `ai_`) — `partner`, `idempotency_key` (unique คู่กับ partner), `external_ref`, `generation_id`, `mode`, `title`, `created_at`
- ความผิดพลาดจากเสียงของผู้ใช้ (อ่านไฟล์ไม่ได้/ยาวเกิน) **ไม่นับ** failure streak ของโมเดล
- retention: ผลและไฟล์เสียงของ partner ใช้ `aquachord_retention_days`

---

## 3. AquaChord PHP — `/api/gpu/*` (admin bearer token เท่านั้นในเฟสนี้)

ตั้งค่าการเชื่อมต่อเก็บที่ `<domain>/private/aixman.json` (นอก webroot, chmod 600, **ไม่ commit**, ไม่อยู่ใน `/settings` GET):
`{ "baseUrl": "https://ai.xman4289.com", "partnerKey": "...", "defaultMode": "open", "updatedAt": <ms> }`
- `baseUrl` ต้องเป็น https และ host อยู่ใน allowlist (`ai.xman4289.com`) — กัน SSRF
- เรียก aixman ด้วย cURL: timeout ชัดเจน, `User-Agent: AquaChord/<ver>` (WAF ของ aixman บล็อก UA แปลก ๆ), ห้ามตาม redirect

| method | path | body | ผล |
|---|---|---|---|
| GET | `/api/gpu/config` | — | `{configured, baseUrl, keyHint:'…abcd', defaultMode, remote: ping result|null, error?}` |
| PUT | `/api/gpu/config` | `{baseUrl?, partnerKey?, defaultMode?}` | ทดสอบ ping ก่อนบันทึก → `{configured, remote}` |
| POST | `/api/gpu/jobs` | multipart: `file` (บังคับ), `lyrics?`, `mode?`, `title?`, `language?` | ตรวจ magic bytes/ขนาด → ส่งต่อ `/uploads` → `/jobs` (Idempotency-Key = id งานของเรา) → ลบไฟล์ temp → `201 {job}` |
| GET | `/api/gpu/jobs` | — | งานล่าสุด 50 งาน (ไม่มี result) |
| GET | `/api/gpu/jobs/{id}` | — | poll aixman (cache ≥3 วิ) → อัปเดตแถว → ถ้า completed และยังไม่มีผล: ดึง `resultUrl` (host R2 ของ aixman เท่านั้น, ≤5 MB, ต้อง parse เป็น JSON ที่ `format === 'aquachord-transcription'`) → `{job, result?}` |
| DELETE | `/api/gpu/jobs/{id}` | — | ยกเลิก |

- ตาราง `gpu_jobs` (migrate แบบเดิมใน `db.php`): `id` (uid), `remote_id`, `status`, `stage_label`, `progress`, `eta_seconds`, `queue_position`, `mode`, `title`, `file_name`, `lyrics` (MEDIUMTEXT), `result_json` (MEDIUMTEXT), `error`, `created_by`, `created_at`, `updated_at`, `polled_at`
- ขนาดอัปโหลด: ตั้ง `site/api/.user.ini` → `upload_max_filesize=64M`, `post_max_size=70M` (+ ตรวจค่าจริงบนเซิร์ฟเวอร์) และเช็คฝั่ง PHP ≤ เพดานจาก ping
- audit log ทุกการตั้งค่า/สร้างงาน (ฟังก์ชัน `audit()` เดิม)

---

## 4. `TranscriptionResult` v1 — ผลจาก node (JSON string)

```jsonc
{
  "format": "aquachord-transcription",
  "version": 1,
  "mode": "open",                       // หรือ "sheetsage2"
  "engine": { "node": "comfyui-aquachord@0.1.0", "models": { "separation": "...", "beats": "...", "chords": "...", "asr": "...", "align": "...", "pitch": "..." } },
  "durationSec": 112.5,
  "tempo": 96.2,                        // BPM ประมาณจาก beats
  "timeSig": [4, 4],
  "beats": [0.52, 1.14],                // วินาที (ทุก beat)
  "downbeats": [0.52, 3.02],            // วินาที (ต้นห้อง)
  "key": "Gm",                          // grammar AquaChord: root + "m"?; สะกด b/# ตามคีย์
  "chords": [ { "t0": 0.0, "t1": 2.5, "label": "Gm7", "conf": 0.82 }, { "t0": 2.5, "t1": 3.0, "label": null } ],  // null = N.C.
  "sections": [ { "t": 0.0, "label": "intro" } ],                // อาจว่าง
  "lyrics": null | {
    "source": "user" | "asr",
    "language": "th",
    "text": "ข้อความเต็ม",
    "lines": [ { "t0": 12.1, "t1": 16.8, "text": "จากทุ่งนามาไกลหลายร้อยโล",
                 "syllables": [ { "t0": 12.1, "t1": 12.4, "text": "จาก" } ] } ]
  },
  "melody": null | { "source": "fcpe" | "sheetsage2", "notes": [ { "t0": 12.1, "t1": 12.4, "pitch": 62, "conf": 0.9 } ] },  // pitch = MIDI
  "warnings": [ "asr: ..." ],
  "timings": { "separate": 12.3, "beats": 2.1 }   // วินาทีต่อขั้น (debug)
}
```
กติกา: เวลาทั้งหมดเป็นวินาที (float, 3 ตำแหน่ง), เรียงตามเวลา, ไม่ซ้อนกันใน `chords`; label คอร์ดต้อง parse ได้ด้วย `Music.parseChord` (grammar docs/04 §3; `m(maj7)` → ใช้ `m` แทนพร้อม warning)

---

## 5. SongDoc v2 (อัปเดต docs/04 — `schemaVersion: 2`)

เพิ่ม field (ทั้งหมด optional — เอกสาร v1 ยัง valid, store อัปเกรดเลขเวอร์ชันตอนอ่าน)
**ต้องคง field ที่ v1.3.x ใช้อยู่จริงแม้ docs/04 เดิมไม่มี:** `timeline` (`[{t, chord}]`), `lyricsText`, `lyricsError`, `lyricsEmpty`, `tempo` (string) — ห้ามลบ/เปลี่ยนความหมาย
ตัวถอดเนื้อในเบราว์เซอร์ (lyrics.js + Whisper tiny/base/small) คงไว้เป็นโหมดสำหรับผู้ใช้ทั่วไป — โหมด GPU เป็นของแอดมินในเฟสนี้:

```ts
interface SongDoc {
  schemaVersion: 2
  // ...field เดิมทั้งหมด...
  melody?: MelodyTrack            // ทำนอง/โน้ต (แก้ไขได้ในหน้าโน้ต)
  analysis?: {
    engine: 'device' | 'gpu'
    mode?: 'open' | 'sheetsage2'
    durationSec?: number
    beats?: number[]              // วินาที — map beat index -> เวลาเสียงจริง
    downbeats?: number[]
    sections?: { t: number; label: string }[]
    warnings?: string[]
  }
}
interface MelodyTrack {
  name: string                    // "ทำนองร้อง"
  timeSig: [number, number]       // [4,4]
  keySig?: string                 // สำหรับ ABC K: เช่น "C", "Gm"
  tempo?: number
  pickup?: number                 // จำนวน beat ก่อนห้องแรก (anacrusis)
  notes: MelodyNote[]
}
interface MelodyNote {
  t: number        // beat จากต้นเพลง (0 = ต้นห้องแรกหลัง pickup)
  d: number        // ความยาว (beat) — ค่าที่ใช้ได้: 4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25
  p: number | null // MIDI pitch, null = ตัวหยุด
  syl?: string     // พยางค์เนื้อร้องใต้โน้ต ("_" = ลากเสียงต่อจากโน้ตก่อน)
  chord?: string   // คอร์ดที่เริ่ม ณ โน้ตนี้ (ใช้ตอน render lead sheet)
  tie?: boolean    // ผูกกับโน้ตถัดไป
}
```
แปลงเวลา: วินาที → beat ด้วย `analysis.beats` (interpolate เชิงเส้นระหว่าง beat, นอกช่วงใช้ tempo) แล้ว quantize เป็น 1/4 beat (เขบ็ต 2 ชั้น)

---

## 6. ความปลอดภัย (เช็คลิสต์ที่ reviewer จะตรวจ)
- partner key: สุ่ม ≥32 bytes (`aqc_` + base64url), เก็บ digest เท่านั้น, เทียบ constant-time, ไม่ log, หมุนได้
- AquaChord: key อยู่ใน `private/aixman.json` 600 นอก webroot; `/api/gpu/*` ต้อง `require_admin()`; ไม่คืน key เต็มใน response ใด ๆ
- SSRF: AquaChord ยิงเฉพาะ `baseUrl` ที่ allowlist + ดึงผลเฉพาะ host R2 ที่ aixman ใช้ (ตรวจจาก prefix ของ `resultUrl` ที่ aixman ส่ง — ต้อง https) · aixman รับ `inputAudio` เฉพาะ URL ใน R2 ของตัวเอง (gate เดิม)
- อัปโหลด: ตรวจ magic bytes ไม่เชื่อ MIME/นามสกุล, เพดานขนาดทั้งสองฝั่ง, ชื่อไฟล์ไม่ใช้เป็น path
- rate limit/เพดาน: §2.3 ฝั่ง aixman + ฝั่ง AquaChord จำกัดงานพร้อมกันต่อแอดมิน
- ข้อความ error ที่ผู้ใช้เห็นเป็นภาษาไทยทั่วไป ไม่มี stack/path/URL ภายใน
- ลิขสิทธิ์: ผลเป็นของผู้ใช้ส่วนตัว (คลังในเครื่อง) — ไม่เผยแพร่อัตโนมัติ; retention สั้น (7 วัน)
