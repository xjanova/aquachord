/* stems-worker.js — งานหนักของ "แกะไลน์เพลงหลายเครื่องดนตรี" ใน module worker (UI ไม่ค้าง, ยกเลิกได้ด้วย terminate)
   - เอนจินคำนวณ: tracks.js (HPSS / กลอง / Basic Pitch post-processing / แยกบทบาท / quantize / ต่อ stem ของ Demucs)
   - ตัวรันโมเดล: onnxruntime-web จาก jsDelivr (สำรอง unpkg) — โหลดตอนผู้ใช้เปิดฟีเจอร์เท่านั้น
       lite → ort.wasm (CPU) · full → ort.webgpu (Demucs บน GPU; Basic Pitch ใช้ wasm EP ใน bundle เดียวกัน)
   - ไฟล์โมเดลดึงจาก Hugging Face ครั้งแรกแล้วเก็บใน Cache API ('aq-models-v1') — ครั้งต่อไปไม่ต้องดาวน์โหลด
       Basic Pitch (Spotify, Apache-2.0) 230 KB · HT-Demucs 6 stem (Meta, MIT) 285 MB
   ไฟล์เสียงไม่ถูกส่งออกจากเครื่อง — ส่งออกไปแค่คำขอดาวน์โหลดไฟล์โมเดล/ไลบรารี

   ข้อความ main → worker: { cmd, id, ... }  ·  worker → main: {type:'pct'|'done'|'error', id, ...} */
// โหลดเอนจิน (UMD → self.DSP / self.Riff / self.Tracks) ด้วย dynamic import — ไม่ใช้ import แบบ static
// เพื่อให้ `node --check` ใน CI (CommonJS) ผ่านเหมือนไฟล์อื่น
let T = null;
const ready = (async () => {
  await import('./dsp.js');
  await import('./riff.js');
  await import('./tracks.js');
  T = self.Tracks;
  if (!T) throw new Error('tracks.js not loaded');
})();
const ORT_VER = '1.29.0';
const ORT_CDN = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VER + '/dist/',
  'https://unpkg.com/onnxruntime-web@' + ORT_VER + '/dist/',
];
// ปักหมุด commit ของ repo (ไฟล์ใต้ URL นี้เปลี่ยนไม่ได้) + ตรวจ SHA-256 หลังดาวน์โหลดก่อนเก็บแคช/ใช้งาน
const MODELS = {
  bp: {
    url: 'https://huggingface.co/AEmotionStudio/basic-pitch-onnx-models/resolve/327fd8ccd2f0bb84cbe56b4a0e9d318398ddf763/nmp.onnx',
    bytes: 230444, sha256: '2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec',
  },
  demucs: {
    url: 'https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx/resolve/0c850a01007f48d94900b21b49a0d0ae1a17239f/htdemucs_6s.onnx',
    bytes: 284797240, sha256: 'a3f5050696cda4b2344d465123acb21ee699dad7d0634dba1d282497a04ac86a',
  },
};
const CACHE = 'aq-models-v1';
const DEMUCS_MIN_BIND = 231211008; // tensor ใหญ่สุดของโมเดล (self-attention 8×2688×2688 fp32)

let cfg = {};
const ortMods = {};
let bpSess = null;
const seps = new Map();
let sepSeq = 0;

function err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function post(m, tr) { self.postMessage(m, tr || []); }

/* ---------- progress (จำกัดความถี่ ~12 ครั้ง/วินาที) ---------- */
function mkPct(id) {
  let last = 0, lastKey = '';
  return (f, key, extra) => {
    const now = Date.now();
    if (key === lastKey && now - last < 80 && f < 1) return;
    last = now; lastKey = key;
    post({ type: 'pct', id, f: Math.max(0, Math.min(1, f || 0)), key: key || '', x: extra || null });
  };
}

/* ---------- onnxruntime-web ---------- */
async function loadOrt(kind) {
  if (kind === 'wasm' && ortMods.webgpu) return ortMods.webgpu; // bundle webgpu มี wasm EP อยู่แล้ว
  if (ortMods[kind]) return ortMods[kind];
  const file = kind === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs';
  let lastErr = null;
  for (const base of (cfg.ortBase ? [cfg.ortBase] : ORT_CDN)) {
    try {
      const m = await import(base + file);
      const ort = m.InferenceSession ? m : (m.default || m);
      ort.env.wasm.wasmPaths = base;
      // หลายเธรดต้องใช้ crossOriginIsolated (COOP/COEP) — ไม่มีก็ 1 เธรด
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) >> 1)) : 1;
      ort.env.logLevel = 'error';
      if (kind === 'webgpu' && ort.env.webgpu) ort.env.webgpu.powerPreference = 'high-performance';
      ortMods[kind] = ort;
      return ort;
    } catch (e) { lastErr = e; }
  }
  throw err('load', 'onnxruntime-web: ' + String((lastErr && lastErr.message) || lastErr));
}

/* ---------- ดึงไฟล์โมเดล + แคช ---------- */
async function fetchModel(key, onProg) {
  const url = (cfg.modelUrls && cfg.modelUrls[key]) || MODELS[key].url;
  let cache = null;
  try {
    if (self.caches) {
      cache = await caches.open(CACHE);
      const hit = await cache.match(url);
      if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); if (onProg) onProg(1, true); return b; }
    }
  } catch (e) { cache = null; }
  let res;
  try { res = await fetch(url, { mode: 'cors', credentials: 'omit' }); }
  catch (e) { throw err('load', 'fetch ' + key); }
  if (!res.ok) throw err('load', 'http ' + res.status + ' ' + key);
  const total = +res.headers.get('content-length') || MODELS[key].bytes;
  let bytes;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    let buf = new Uint8Array(total), n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > buf.length) {
        const nb = new Uint8Array(Math.max(Math.ceil(buf.length * 1.5), n + value.length));
        nb.set(buf.subarray(0, n)); buf = nb;
      }
      buf.set(value, n); n += value.length;
      if (onProg) onProg(Math.min(0.999, n / total), false);
    }
    bytes = n === buf.length ? buf : buf.slice(0, n);
  } else bytes = new Uint8Array(await res.arrayBuffer());
  // ไฟล์ไม่ตรง hash ที่ปักไว้ (ดาวน์โหลดไม่ครบ/ถูกแก้กลางทาง) → ไม่ใช้ ไม่แคช
  const want = !(cfg.modelUrls && cfg.modelUrls[key]) && MODELS[key].sha256;
  if (want && self.crypto && crypto.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
    if (hex !== want) throw err('load', 'sha256 mismatch ' + key);
  }
  if (cache) { try { await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { /* โควตาเต็ม/โหมดส่วนตัว — ใช้ต่อได้ แค่ไม่ได้แคช */ } }
  if (onProg) onProg(1, false);
  return bytes;
}

/* ---------- Basic Pitch ---------- */
async function getBP(kind, device, onProg) {
  const ort = await loadOrt(kind);
  if (bpSess && bpSess._ort === ort && bpSess._dev === device) return bpSess;
  if (bpSess) { try { await bpSess.release(); } catch (e) {} bpSess = null; }
  const bytes = await fetchModel('bp', onProg);
  let s;
  try {
    s = await ort.InferenceSession.create(bytes, { executionProviders: [device === 'webgpu' ? 'webgpu' : 'wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  } catch (e) { throw err(device === 'webgpu' ? 'gpu' : 'load', 'basic-pitch session: ' + (e && e.message)); }
  s._ort = ort; s._dev = device;
  bpSess = s;
  return s;
}
function bpRunner(sess) {
  const ort = sess._ort;
  const inName = sess.inputNames[0];
  // ชื่อเอาต์พุตจาก TF→ONNX: :0 = contour (264), :1 = note (88), :2 = onset (88) — เหมือน basic_pitch/inference.py
  const noteName = sess.outputNames.find((n) => /:1$/.test(n)) || sess.outputNames[1];
  const onsetName = sess.outputNames.find((n) => /:2$/.test(n)) || sess.outputNames[2];
  return async (inp, B) => {
    const t = new ort.Tensor('float32', inp, [B, T.BP.NS, 1]);
    let r;
    try { r = await sess.run({ [inName]: t }, [noteName, onsetName]); }
    catch (e) { throw err('run', 'basic-pitch run: ' + (e && e.message)); }
    const out = { note: r[noteName].data, onset: r[onsetName].data };
    return out;
  };
}

/* ---------- Demucs (WebGPU) ---------- */
async function gpuCheck() {
  if (!self.navigator || !navigator.gpu) throw err('gpu', 'no navigator.gpu');
  let a = null;
  try { a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { a = null; }
  if (!a || a.isFallbackAdapter) throw err('gpu', 'no adapter');
  const L = a.limits;
  if (L.maxStorageBufferBindingSize < DEMUCS_MIN_BIND || L.maxBufferSize < DEMUCS_MIN_BIND) throw err('gpu', 'gpu limits');
  return a;
}
async function getDemucs(onProg) {
  await gpuCheck();
  const ort = await loadOrt('webgpu');
  let bytes = await fetchModel('demucs', onProg);
  // iSTFT ในกราฟเป็น ConvTranspose ที่ WebGPU ช้ามาก → แก้เป็น MatMul + overlap-add (ผลเท่าเดิม, เร็วขึ้นหลายเท่า)
  // แก้ไม่ได้/สร้าง session จากกราฟที่แก้ไม่ได้ → ใช้กราฟเดิม
  const patched = cfg.noPatch ? null : T.patchDemucsIstft(bytes);
  if (patched) {
    try {
      const s = await ort.InferenceSession.create(patched, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
      s._patched = true;
      return s;
    } catch (e) { /* ตกไปใช้กราฟเดิม */ }
  }
  try {
    return await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
  } catch (e) { throw err('gpu', 'demucs session: ' + (e && e.message)); }
  finally { bytes = null; }
}

/* ---------- เสียงขาเข้า ---------- */
function toRate(x, sr, target) { return Math.abs(sr - target) < 1e-6 ? x : T.resample(x, sr, target); }

/* ---------- คำสั่ง ---------- */
async function cmdLite(m) {
  const P = mkPct(m.id);
  const o = m.opts || {};
  P(0, 'prep');
  const x = toRate(m.pcm, m.sr, T.BP.SR);
  P(0.03, 'rt');
  const sess = await getBP('wasm', 'wasm', (f) => P(0.03 + 0.05 * f, 'dl-bp', Math.round(f * 100)));
  const runBP = bpRunner(sess);
  const t0 = Date.now();
  const ts = await T.lite(x, {
    runBP, bpm: o.bpm, phase: o.phase, debug: o.debug, batch: o.batch || 4,
    onPct: (f, key) => P(0.08 + 0.92 * f, key),
  });
  if (o.debug && ts._debug) ts._debug.total = Date.now() - t0;
  if (!o.debug) delete ts._debug;
  return { result: ts };
}

async function cmdSeparate(m) {
  const P = mkPct(m.id);
  const o = m.opts || {};
  P(0, 'prep');
  let L = m.L, R = m.R || m.L;
  L = toRate(L, m.sr, T.DM.SR);
  R = m.R ? toRate(R, m.sr, T.DM.SR) : L;
  P(0.02, 'rt');
  const t0 = Date.now();
  const sess = await getDemucs((f, cached) => P(0.02 + 0.2 * f, cached ? 'cache-dm' : 'dl-dm', Math.round(f * 100)));
  const tLoad = Date.now() - t0;
  const ort = ortMods.webgpu;
  const N = T.DM.N;
  const runDemucs = async (inp) => {
    let r;
    try { r = await sess.run({ mix: new ort.Tensor('float32', inp, [1, 2, N]) }); }
    catch (e) { throw err('run', 'demucs run: ' + (e && e.message)); }
    const out = r.stems.data;
    if (!out || out.length < 12 * N) throw err('run', 'demucs output');
    return out;
  };
  const t1 = Date.now();
  let sep;
  try {
    sep = await T.separate(L, R, runDemucs, { onPct: (f, i, n) => P(0.25 + 0.72 * f, 'sep', i && n ? i + '/' + n : null) });
  } finally {
    if (!o.keepModel) { try { await sess.release(); } catch (e) {} }
  }
  const tSep = Date.now() - t1;
  L = R = m.L = m.R = null;
  const sepId = ++sepSeq;
  seps.set(sepId, sep);
  P(0.98, 'mix');
  const inst = T.instrumental11k(sep.stems);
  const voc = o.wantVocalsPcm16k ? T.resample(sep.stems.vocals, T.BP.SR, 16000) : null;
  const tr = [inst.buffer];
  if (voc) tr.push(voc.buffer);
  return {
    result: {
      sepId, duration: sep.stems.drums.length / T.BP.SR, present: sep.present, level: sep.level, chunks: sep.chunks,
      instrumentalMono11k: inst, vocalsPcm16k: voc, timing: { load: tLoad, separate: tSep, patched: !!sess._patched },
    },
    transfer: tr,
  };
}

async function cmdStem(m) {
  const sep = seps.get(m.sepId);
  if (!sep) throw err('run', 'separation released');
  const x = sep.stems[m.name];
  if (!x) throw err('run', 'no stem ' + m.name);
  const y = m.sr === T.BP.SR ? Float32Array.from(x) : T.resample(x, T.BP.SR, m.sr || 11025);
  return { result: y, transfer: [y.buffer] };
}

async function cmdTracks(m) {
  const sep = seps.get(m.sepId);
  if (!sep) throw err('run', 'separation released');
  const P = mkPct(m.id);
  const o = m.opts || {};
  P(0, 'rt');
  // full: Basic Pitch บน WebGPU (ผลเท่ากับ wasm ทุกโน้ตในเทสต์ แต่เร็วกว่า ~6–8 เท่า) · สร้าง session ไม่ได้ → wasm
  let dev = o.bpDevice === 'wasm' ? 'wasm' : 'webgpu';
  let sess;
  try { sess = await getBP('webgpu', dev, (f) => P(0.04 * f, 'dl-bp', Math.round(f * 100))); }
  catch (e) {
    if (dev !== 'webgpu' || e.code === 'load') throw e;
    dev = 'wasm';
    sess = await getBP('webgpu', dev, (f) => P(0.04 * f, 'dl-bp', Math.round(f * 100)));
  }
  const runBP = bpRunner(sess);
  const t0 = Date.now();
  const ts = await T.fromStems(sep, {
    runBP, bpm: o.bpm, phase: o.phase, debug: o.debug, batch: o.batch || (dev === 'webgpu' ? 8 : 4),
    onPct: (f, key) => P(0.05 + 0.95 * f, key),
  });
  if (o.debug && ts._debug) { ts._debug.total = Date.now() - t0; ts._debug.bpDevice = dev; }
  if (!o.debug) delete ts._debug;
  return { result: ts };
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.cfg) cfg = m.cfg;
  if (m.cmd === 'release') { seps.delete(m.sepId); return; }
  try {
    try { await ready; } catch (e) { throw err('load', 'engine: ' + (e && e.message)); }
    let r;
    if (m.cmd === 'lite') r = await cmdLite(m);
    else if (m.cmd === 'separate') r = await cmdSeparate(m);
    else if (m.cmd === 'stem') r = await cmdStem(m);
    else if (m.cmd === 'tracks') r = await cmdTracks(m);
    else throw err('run', 'unknown cmd ' + m.cmd);
    post({ type: 'done', id: m.id, result: r.result }, r.transfer);
  } catch (e) {
    post({ type: 'error', id: m.id, code: (e && e.code) || 'run', message: String((e && e.message) || e) });
  }
};
ready.then(() => post({ type: 'ready' }), () => post({ type: 'ready', failed: true }));
