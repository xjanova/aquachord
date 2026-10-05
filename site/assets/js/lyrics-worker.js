/* lyrics-worker.js — ถอดเนื้อร้องด้วย Whisper (transformers.js) ใน Web Worker
   - รันแยกเธรด: UI ไม่ค้างระหว่างโหลดโมเดล/ถอดเสียง และยกเลิกได้ด้วย terminate()
   - โมเดลถูกดาวน์โหลดจาก CDN ครั้งแรกครั้งเดียว (เบราว์เซอร์แคชไว้) — ตัว"เสียงเพลง"
     ไม่ถูกส่งออกจากเครื่องผู้ใช้ วิเคราะห์ในเครื่องทั้งหมดตามปรัชญาเดิมของแอป
   - ลอง WebGPU ก่อน (เร็วกว่ามากบน Chrome เดสก์ท็อป/Android) ตกลงมา WASM อัตโนมัติ
   - ก่อนโหลด Whisper: ตรวจว่ามีเสียงร้องไหมด้วย Silero VAD (~2 MB) — เพลงบรรเลงข้าม Whisper ทั้งหมด
   - ระหว่างถอด: กันลูป (Whisper บนดนตรีล้วนวนสร้างคำเดิมจนเต็ม 448 token ทุกช่วง 30 วินาที)
     + งบเวลา — เกินงบหยุดช่วงที่เหลือแล้วคืนเท่าที่ถอดได้ */

// หลัก: v3 (มี WebGPU) แบบ range 3.3.x — jsDelivr resolve patch ล่าสุดให้ฝั่งเซิร์ฟเวอร์
// สำรอง: v2 ที่เสถียรมานาน (jsDelivr แล้วค่อย unpkg เผื่อ CDN ล่มทั้งเจ้า)
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3/dist/transformers.min.js',
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js',
  'https://unpkg.com/@xenova/transformers@2.17.2/dist/transformers.min.js',
];

let libPromise = null;
const pipes = new Map();

function post(m) { self.postMessage(m); }

function loadLib() {
  if (libPromise) return libPromise;
  libPromise = (async () => {
    let lastErr = null;
    for (const url of CDN_URLS) {
      try { return await import(url); } catch (e) { lastErr = e; }
    }
    libPromise = null; // ครั้งหน้าให้ลองใหม่ (เน็ตอาจกลับมา)
    const err = new Error(String((lastErr && lastErr.message) || 'import failed'));
    err.code = 'load';
    throw err;
  })();
  return libPromise;
}

// รวม progress ดาวน์โหลดหลายไฟล์ (encoder/decoder/tokenizer) เป็น % เดียว
function mkProgress(id) {
  const files = new Map();
  return (ev) => {
    if (!ev || !ev.file) return;
    const cur = files.get(ev.file) || { loaded: 0, total: 0 };
    if (ev.total) cur.total = ev.total;
    if (ev.loaded != null) cur.loaded = ev.loaded;
    if (ev.status === 'done' && cur.total) cur.loaded = cur.total;
    files.set(ev.file, cur);
    let L = 0, T = 0;
    files.forEach((f) => { L += f.loaded; T += f.total; });
    if (T > 0) post({ type: 'dl', id, pct: Math.min(99, Math.round((L / T) * 100)) });
  };
}

// โมเดลที่ต้องใช้ GPU: ถ้า WebGPU ใช้ไม่ได้ → ถอยไป whisper-small บน CPU (ไม่ปล่อยให้ค้างนานบน CPU)
const CPU_FALLBACK = 'Xenova/whisper-small';

// ต้องได้ adapter จริงก่อนค่อยลอง WebGPU: ถ้าลองแล้ว onnxruntime หา backend ไม่ได้ มันจะจำผลนั้นไว้
// แล้วรอบ WASM ที่ตามมาก็ล้มด้วย ("no available backend found") → โหลดโมเดลไม่ได้เลย
// (เจอจริงบน Chrome ที่มี navigator.gpu แต่ไม่มี GPU ที่ใช้ได้ เช่นไดรเวอร์ซอฟต์แวร์ / GPU ติด blocklist)
async function gpuAdapter() {
  try {
    return (typeof navigator !== 'undefined' && navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) || null;
  } catch (e) { return null; }
}

async function getPipe(repo, id, gpuOnly) {
  const key = repo + (gpuOnly ? '#gpu' : '');
  if (pipes.has(key)) { const p = pipes.get(key); post({ type: 'device', id, device: p._aqDevice, model: p._aqRepo }); return p; }
  const lib = await loadLib();
  const ver = (lib.env && lib.env.version) || '3';
  const major = parseInt(String(ver).split('.')[0], 10) || 3;
  const progress_callback = mkProgress(id);
  let pipe = null, device = 'wasm', usedRepo = repo;
  try {
    if (major >= 3 && gpuOnly) {
      const adapter = await gpuAdapter();
      if (adapter) {
        const dt = adapter.features && adapter.features.has('shader-f16') ? 'q4f16' : 'q4';
        try {
          pipe = await lib.pipeline('automatic-speech-recognition', repo, {
            device: 'webgpu', dtype: { encoder_model: dt, decoder_model_merged: dt }, progress_callback,
          });
          device = 'webgpu';
        } catch (e) { pipe = null; }
      }
      if (!pipe) {
        usedRepo = CPU_FALLBACK;
        pipe = await lib.pipeline('automatic-speech-recognition', CPU_FALLBACK, { dtype: 'q8', progress_callback });
        device = 'wasm-fallback';
      }
    } else if (major >= 3) {
      // WebGPU: encoder fp32 (ชัวร์สุดเรื่อง op support) + decoder q8 (เล็ก/ไฟล์เดียวกับ WASM)
      if (await gpuAdapter()) {
        try {
          pipe = await lib.pipeline('automatic-speech-recognition', repo, {
            device: 'webgpu',
            dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
            progress_callback,
          });
          device = 'webgpu';
        } catch (e) { pipe = null; /* webgpu ใช้ไม่ได้ → wasm */ }
      }
      if (!pipe) {
        pipe = await lib.pipeline('automatic-speech-recognition', repo, {
          dtype: 'q8', progress_callback,
        });
      }
    } else {
      pipe = await lib.pipeline('automatic-speech-recognition', repo, {
        quantized: true, progress_callback,
      });
    }
  } catch (e) {
    const err = new Error(String((e && e.message) || e));
    err.code = 'load';
    throw err;
  }
  pipe._aqDevice = device; pipe._aqRepo = usedRepo; pipe._aqMajor = major;
  pipes.set(key, pipe);
  post({ type: 'device', id, device, model: usedRepo });
  return pipe;
}

/* ---------- ตรวจว่ามีเสียงร้องไหม (Silero VAD v5, MIT) ----------
   ค่าความน่าจะเป็น "เสียงพูด/ร้อง" ทุก 32 ms → เฉลี่ยเคลื่อนที่ 1 วินาที → เอาค่าสูงสุดทั้งเพลง (peak)
   วัดจริง (เสียงร้องหลังดึงเสียงกลาง): เพลงคอร์ดล้วน 0.16 · ดนตรีมีลีดเมโลดี้ 0.30–0.38 ·
   ร้องดังเท่าดนตรี 0.88–0.98 · ร้องเบากว่าดนตรี 6 dB 0.55–0.66 · เบากว่า 12 dB 0.33–0.41
   (ช่วงสุดท้ายนี้ Whisper ยังถอดได้ดี → ตัดสินด้วย VAD อย่างเดียวไม่ได้ ต้องให้ Whisper ลองฟังก่อน)
   peak < VAD_SKIP → ไม่มีเสียงร้องแน่ ข้าม Whisper · VAD_SKIP..VAD_SURE → ลองถอดช่วงที่น่าจะมีเสียงร้องที่สุด 30 วินาทีก่อน */
const VAD_REPO = 'onnx-community/silero-vad';
const VAD_REV = 'e71cae966052b992a7eca6b17738916ce0eca4ec'; // ปักหมุด commit — ไฟล์ใต้ revision นี้เปลี่ยนไม่ได้
const VAD_SKIP = 0.25;
const VAD_SURE = 0.6;   // ถึงค่านี้ = มีเสียงร้องแน่ หยุดสแกนส่วนที่เหลือได้เลย
const VAD_WIN = 31;     // 31 × 32 ms ≈ 1 วินาที
const VAD_MAYBE = 0.45; // ช่วงทดลองฟังไม่ออกแต่ VAD สูงกว่านี้ = น่าจะมีเสียงร้องที่โมเดลนี้ฟังไม่ออก (แนะนำโมเดลใหญ่ขึ้น)
// ช่วงทดลองต้องได้ข้อความจริง (หลังกรองคำหลอน/ลูปด้วย DSP.cleanChunks) อย่างน้อยเท่านี้ถึงจะถอดทั้งเพลง
// ความหลากหลายรวมของทั้งช่วง (DSP.textDiversity): เนื้อร้องจริง ≥ 0.74 · เศษลูปที่หลุดตัวกรองรายบรรทัด ≤ 0.16
const PROBE_MIN_LETTERS = 12;
const PROBE_MIN_DIV = 0.35;
// ช่วงทดลองถอดแค่นี้พอตัดสิน (ไทย ~75 ตัวอักษร / อังกฤษ ~250) — ลูปหลอนโดนตัวกันลูปตัดที่ ~60 token อยู่แล้ว
const PROBE_TOKENS = 64;
let vadPromise = null;

function getVad(lib) {
  if (!vadPromise) {
    vadPromise = lib.AutoModel.from_pretrained(VAD_REPO, { revision: VAD_REV, config: { model_type: 'custom' }, dtype: 'fp32' })
      .catch((e) => { vadPromise = null; throw e; });
  }
  return vadPromise;
}

// คืน { peak, at (วินาทีกลางช่วง 1 วินาทีที่ได้ peak), cands, frac, ms } หรือ null ถ้าตรวจไม่ได้ (ไลบรารี v2 / โหลดโมเดลไม่ได้) → ถอดตามปกติ
// cands = จุดที่น่าลองฟัง ≤ 2 จุดจากคนละช่วง 30 วินาที (เผื่อจุดสูงสุดเป็นโซโล่เครื่องดนตรีที่เสียงคล้ายคน
// แต่เสียงร้องจริงที่มิกซ์ไว้เบาอยู่อีกช่วง)
async function vocalPresence(pcm, id) {
  const t0 = Date.now();
  try {
    const lib = await loadLib();
    if (!lib.AutoModel || !lib.Tensor || !(lib.env && /^3\./.test(String(lib.env.version || '')))) return null;
    const vad = await getVad(lib);
    const T = lib.Tensor;
    let state = new T('float32', new Float32Array(2 * 128), [2, 1, 128]);
    const sr = new T('int64', BigInt64Array.from([16000n]), []);
    const buf = new Float32Array(512), ring = new Float32Array(VAD_WIN);
    const total = Math.floor(pcm.length / 512);
    const blocks = []; // ค่าสูงสุดต่อช่วง 30 วินาที
    let sum = 0, peak = 0, peakAt = 0, on = 0, n = 0, lastPost = 0;
    for (let i = 0; i + 512 <= pcm.length; i += 512) {
      buf.set(pcm.subarray(i, i + 512));
      const o = await vad({ input: new T('float32', buf, [1, 512]), sr, state });
      state = o.stateN;
      const p = o.output.data[0];
      sum += p - ring[n % VAD_WIN]; ring[n % VAD_WIN] = p; n++;
      if (n >= VAD_WIN) {
        const m = sum / VAD_WIN, at = ((n - VAD_WIN / 2) * 512) / 16000;
        const b = Math.floor(at / 30);
        if (!blocks[b] || m > blocks[b].peak) blocks[b] = { peak: m, at };
        if (m > peak) { peak = m; peakAt = at; }
      }
      if (p > 0.5) on++;
      if (peak >= VAD_SURE) break;
      if (n - lastPost >= 600) { lastPost = n; post({ type: 'vad', id, pct: Math.round((n / total) * 100) }); }
    }
    const r3 = (x) => Math.round(x * 1000) / 1000;
    // จุดรองต้องห่างจุดแรก ≥ 20 วินาที (ช่วง 30 วินาทีซ้อนกันไม่เกิน 1/3) ไม่งั้นเท่ากับฟังซ้ำที่เดิม
    const cands = [];
    for (const b of blocks.filter((x) => x && x.peak >= VAD_SKIP).sort((x, y) => y.peak - x.peak)) {
      if (cands.every((c) => Math.abs(c.at - b.at) >= 20)) cands.push({ peak: r3(b.peak), at: Math.round(b.at * 10) / 10 });
      if (cands.length === 2) break;
    }
    return {
      peak: r3(peak), at: Math.round(peakAt * 10) / 10, cands,
      frac: n ? r3(on / n) : 0, ms: Date.now() - t0, scanned: Math.round((n / Math.max(1, total)) * 100),
    };
  } catch (e) {
    return null; // ตรวจไม่ได้ไม่ใช่เหตุให้ข้ามเนื้อร้อง
  }
}

/* ---------- ตัวกันลูปตอนถอด ----------
   ทำงานเป็น logits processor (transformers.js 3.3 ส่ง logits_processor ต่อให้ generate ของ Whisper
   แต่ทิ้ง stopping_criteria) ดูเฉพาะ token ข้อความ (ไม่นับ timestamp) ของช่วงที่กำลังถอด:
   - ท้ายข้อความเป็นหน่วยเดียวกันซ้ำติดกัน ≥ 4 รอบ (ยาวรวม ≥ 16 token) หรือ ≥ 10 รอบ → ห้าม token ที่จะวนต่อ
   - โดนห้ามแล้วยังวนกลับมาอีกเกิน LOOP_BANS ครั้ง → จบช่วงนี้ (EOS)
   - ข้อความยาวเกินเพดานของภาษา หรือเลยงบเวลา → จบช่วงนี้
   เพลงจริงร้องท่อนซ้ำได้ แต่ซ้ำเป๊ะ ๆ ≥ 4 รอบติดกันแทบไม่มี — ส่วนการหลอนของ Whisper วนเป็นร้อยรอบ */
const LOOP_MAX_P = 48;
const LOOP_BANS = 2;
// เพดาน token ข้อความต่อช่วง 30 วินาที: อังกฤษแร็ปเร็วมากวัดได้ ~8 token/วินาที (TTS +60%) → 320
// ไทยกิน token มาก (~0.84 token/ตัวอักษร · พูดเร็ว 20 token/วินาที) → ใช้เพดานของโมเดลเอง (448)
const MAX_TEXT = { en: 320 };

function findLoop(t) {
  const n = t.length;
  for (let p = 1; p <= LOOP_MAX_P && p * 4 <= n; p++) {
    let reps = 1;
    while ((reps + 1) * p <= n) {
      let same = true;
      for (let k = 1; k <= p; k++) if (t[n - k] !== t[n - k - reps * p]) { same = false; break; }
      if (!same) break;
      reps++;
    }
    if ((reps >= 4 && reps * p >= 16) || reps >= 10) return t[n - p]; // token ที่จะวนต่อ
  }
  return -1;
}

function makeGuard(run) {
  let lastLen = Infinity, init = 0, bans = 0, lastTrig = -1;
  const forceEos = (d) => { d.fill(-Infinity); d[run.eos] = 0; };
  return (input_ids, logits) => {
    for (let b = 0; b < input_ids.length; b++) {
      const ids = input_ids[b];
      if (ids.length <= lastLen) { init = ids.length; bans = 0; lastTrig = -1; } // เริ่มช่วงใหม่
      lastLen = ids.length;
      run.st.steps++;
      const d = logits[b].data;
      if (run.over()) { forceEos(d); continue; }
      const txt = [];
      for (let i = init; i < ids.length; i++) { const v = Number(ids[i]); if (v < run.eos) txt.push(v); }
      if (run.maxText && txt.length >= run.maxText) { run.st.capped++; forceEos(d); continue; }
      const next = findLoop(txt);
      if (next < 0) continue;
      if (txt.length !== lastTrig) { bans++; lastTrig = txt.length; run.st.loops++; }
      if (bans > LOOP_BANS) { run.st.cut++; forceEos(d); continue; }
      d[next] = -Infinity;
    }
    return logits;
  };
}

// รายการ logits processor ที่ Whisper.generate จะ push ของมันเพิ่มทุกช่วง 30 วินาที (pipeline ใช้ object เดิมซ้ำ)
// → เก็บแค่ตัวล่าสุดของแต่ละชนิด ไม่ให้สะสมจนช้าลงเรื่อย ๆ ในเพลงยาว · ตัวกันลูปรันท้ายสุดเสมอ
function procList(guard) {
  const items = [];
  const kind = (p) => (p && 'timestamp_begin' in p ? 'ts' : p && 'begin_suppress_tokens' in p ? 'bs' : null);
  return {
    push(p) {
      const k = kind(p);
      const i = k ? items.findIndex((q) => kind(q) === k) : -1;
      if (i >= 0) items[i] = p; else items.push(p);
    },
    [Symbol.iterator]() { return items.concat([guard]).values(); },
  };
}

// ครอบ model.generate ครั้งเดียวต่อ pipe: นับช่วง (บอก % จริง) และข้ามช่วงที่เหลือทันทีเมื่อเลยงบเวลา
// (ไม่ต้องรัน encoder อีก — turbo บน GPU ใช้ ~8 วินาทีต่อช่วงแม้จะไม่ถอดอะไรเลย)
function hookGenerate(pipe, lib) {
  const m = pipe.model;
  if (pipe._aqHooked || !m || typeof m.generate !== 'function' || !lib.Tensor) return;
  pipe._aqHooked = true;
  const orig = m.generate.bind(m);
  m.generate = async (args) => {
    const run = pipe._aqRun;
    if (run) {
      run.chunk++;
      if (run.onChunk) run.onChunk(run.chunk);
      if (run.over()) {
        run.st.skipped++;
        return new lib.Tensor('int64', BigInt64Array.from([BigInt(run.sot), BigInt(run.eos)]), [1, 2]);
      }
    }
    return orig(args);
  };
}

// งบเวลาถอด (หลังโหลดโมเดลแล้ว) — วัดบน GTX 1070 Ti: turbo ถอดเพลงที่มีเสียงร้อง ~1–1.5 เท่าความยาวเพลง
// เผื่อเครื่องช้า: GPU 3 เท่า · CPU 8 เท่า + 60 วินาที · เลยงบ = หยุดช่วงที่เหลือ คืนเท่าที่ได้
function budgetSec(device, duration) {
  return Math.round(60 + Math.max(5, duration || 0) * (device === 'webgpu' ? 3 : 8));
}

const SR = 16000;
const WIN = 30 * SR, JUMP = 20 * SR; // ตรงกับ chunk_length_s 30 / stride_length_s 5 ของ pipeline

// ถอดหนึ่งรอบด้วย pipeline (หั่นช่วง 30 วินาทีเหลื่อมกันตามเดิม) + ตัวกันลูป/งบเวลา → [{t0, t1, text}]
async function asr(pipe, lib, pcm, cfg) {
  const { id, lang, deadline, st } = cfg;
  const duration = pcm.length / SR;
  const nChunks = pcm.length <= WIN ? 1 : 1 + Math.ceil((pcm.length - WIN) / JUMP);
  const pct = (k) => Math.min(99, Math.round(cfg.pct0 + (k / nChunks) * (cfg.pct1 - cfg.pct0)));
  let processedSec = 0;
  const opts = {
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    // v2 เท่านั้น: ถูกเรียกทุก ~20s ของเสียงที่ถอดเสร็จ (v3 นับช่วงเองผ่าน hookGenerate)
    chunk_callback: () => {
      processedSec += 20;
      post({ type: 'asr', id, pct: pct(Math.min(1, processedSec / duration) * nChunks) });
    },
  };
  if (lang && lang !== 'auto') opts.language = lang;
  const maxText = cfg.maxText || MAX_TEXT[lang] || 0;
  if (maxText) opts.max_new_tokens = maxText + 64; // + token เวลา
  if ((pipe._aqMajor || 3) >= 3) {
    const gc = (pipe.model && pipe.model.generation_config) || {};
    const run = {
      eos: Number(Array.isArray(gc.eos_token_id) ? gc.eos_token_id[0] : gc.eos_token_id) || 50257,
      sot: Number(gc.decoder_start_token_id) || 50258, maxText, chunk: -1, st,
      over: () => { if (Date.now() > deadline) st.overBudget = true; return st.overBudget; },
      onChunk: (k) => post({ type: 'asr', id, pct: pct(k) }),
    };
    opts.logits_processor = procList(makeGuard(run));
    hookGenerate(pipe, lib);
    pipe._aqRun = run;
  }
  let out;
  try { out = await pipe(pcm, opts); }
  finally { pipe._aqRun = null; }

  const off = cfg.offset || 0;
  const chunks = [];
  for (const c of (out && out.chunks) || []) {
    const ts = c.timestamp || [];
    chunks.push({
      t0: (isFinite(+ts[0]) ? +ts[0] : 0) + off,
      t1: ts[1] == null || !isFinite(+ts[1]) ? null : +ts[1] + off,
      text: String(c.text || ''),
    });
  }
  if (!chunks.length && out && out.text && out.text.trim()) chunks.push({ t0: off, t1: off + duration, text: out.text });
  return chunks;
}

// ตัวกรองเดียวกับตอนประกอบชีต (DSP.cleanChunks ใน dsp.js) → ตัวอักษรจริงที่เหลือ + ความหลากหลายรวม
let dspPromise = null;
async function realText(chunks) {
  if (!dspPromise) dspPromise = import('./dsp.js').then(() => self.DSP).catch(() => null);
  const D = await dspPromise;
  const text = (D ? D.cleanChunks(chunks, 0) : chunks).map((c) => c.text).join(' ');
  const dv = D ? D.textDiversity(text) : { n: 0, div: 1 };
  return { letters: (text.match(/\p{L}/gu) || []).length, div: Math.round(dv.div * 100) / 100, n: dv.n };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.cmd !== 'run') return;
  const { id, pcm, lang, repo, duration, gpuOnly } = msg;
  // vocals: 'yes' = แน่ใจว่ามีเสียงร้อง (VAD สูง หรือช่วงทดลองได้ข้อความจริง) · 'maybe' = VAD สูงกว่าช่วงดนตรีล้วน (≤ 0.38)
  // แต่โมเดลฟังไม่ออก · 'none' = ไม่มี · null = ไม่ได้ตรวจ
  const info = { vad: null, skipped: false, vocals: null };
  try {
    if (msg.vad !== false) {
      post({ type: 'vad', id, pct: 0 });
      info.vad = await vocalPresence(pcm, id);
      if (info.vad && info.vad.peak < VAD_SKIP) {
        info.skipped = true; info.vocals = 'none';
        post({ type: 'done', id, chunks: [], text: '', info });
        return;
      }
    }

    const pipe = await getPipe(repo, id, gpuOnly);
    post({ type: 'dl', id, pct: 100 });
    const lib = await loadLib();
    const budget = budgetSec(pipe._aqDevice, duration);
    const t0 = Date.now(), deadline = t0 + budget * 1000;
    const st = { steps: 0, loops: 0, cut: 0, capped: 0, skipped: 0, overBudget: false };
    post({ type: 'budget', id, sec: budget });

    // heartbeat กัน UI ดูเหมือนค้างระหว่างช่วงที่ยาว
    const hb = setInterval(() => post({ type: 'asr', id, pct: null, elapsed: Math.round((Date.now() - t0) / 1000) }), 4000);
    let chunks = null;
    try {
      // ไม่แน่ใจว่ามีเสียงร้อง: ลองถอดเฉพาะ 30 วินาทีรอบจุดที่ VAD ให้คะแนนสูงสุดก่อน (= encoder รอบเดียว
      // ซึ่งเป็นต้นทุนหลัก: turbo บน GTX 1070 Ti ~8 วินาทีต่อช่วง) แค่ PROBE_TOKENS token พอตัดสิน · ไม่เจอค่อยลองจุดรองจากอีกช่วง
      // เพลงไม่เกิน 30 วินาที: ช่วงทดลองคือทั้งเพลง ผลที่ได้ใช้เป็นเนื้อร้องจริงเลย
      // (วัดแล้ว: เพลงบรรเลง 31 วินาทีลองทั้งเพลง = 2 ช่วง 29 วินาที · ลองช่วงเดียว 12 วินาที — แลกกับเพลงสั้นที่ร้องเบาต้องถอดซ้ำ ~10 วินาที)
      // ได้แต่คำหลอน/ลูป (กรองแล้วเหลือตัวอักษรน้อย หรือวนคำเดิม) ทุกจุด = ไม่มีเสียงร้อง → ไม่ต้องถอดทั้งเพลง
      let pct0 = 0, voicedProbe = null;
      if (info.vad && info.vad.peak < VAD_SURE) {
        const whole = pcm.length <= WIN;
        const tries = whole ? [{ at: 0 }] : (info.vad.cands && info.vad.cands.length ? info.vad.cands : [{ at: info.vad.at }]);
        info.probe = [];
        let voiced = false;
        for (const c of tries) {
          const len = whole ? pcm.length : WIN;
          const a = whole ? 0 : Math.max(0, Math.min(pcm.length - len, Math.round((c.at - 15) * SR)));
          const pct1 = whole ? 100 : pct0 + 15;
          const probe = await asr(pipe, lib, pcm.subarray(a, a + len), { id, lang, deadline, st, offset: a / SR, pct0, pct1, maxText: whole ? 0 : PROBE_TOKENS });
          pct0 = pct1;
          const q = await realText(probe);
          voiced = q.letters >= PROBE_MIN_LETTERS && (q.n < 16 || q.div >= PROBE_MIN_DIV);
          info.probe.push({ at: Math.round(a / SR), letters: q.letters, div: q.div, voiced });
          if (voiced) { info.vocals = 'yes'; if (whole) chunks = probe; else voicedProbe = probe; break; }
          if (st.overBudget) break;
        }
        if (!voiced) { info.skipped = true; info.vocals = info.vad.peak >= VAD_MAYBE ? 'maybe' : 'none'; chunks = []; }
      } else if (info.vad) {
        info.vocals = 'yes';
      }
      if (!chunks) {
        chunks = await asr(pipe, lib, pcm, { id, lang, deadline, st, pct0, pct1: 100 });
        // ถอดทั้งเพลงแล้วไม่เหลือคำจริง แต่ช่วงทดลองได้คำจริง → ใช้ผลช่วงทดลองแทน (ดีกว่าไม่มีเลย)
        // วัดจริง: whisper-base บน CPU กับเพลงที่ร้องเบา ผลเปลี่ยนตามจุดตัดช่วง 30 วินาที — ช่วงทดลองได้ 206 ตัวอักษร ทั้งเพลงได้ 0
        if (voicedProbe && (await realText(chunks)).letters < PROBE_MIN_LETTERS) { chunks = voicedProbe; info.usedProbe = true; }
      }
    } finally { clearInterval(hb); }

    info.guard = st;
    info.asrMs = Date.now() - t0;
    info.budget = budget;
    post({ type: 'done', id, chunks, text: chunks.map((c) => c.text).join(''), info });
  } catch (e) {
    post({
      type: 'error', id,
      code: e && e.code === 'load' ? 'load' : 'run',
      message: String((e && e.message) || e),
    });
  }
};
