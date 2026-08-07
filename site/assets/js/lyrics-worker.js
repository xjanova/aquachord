/* lyrics-worker.js — ถอดเนื้อร้องด้วย Whisper (transformers.js) ใน Web Worker
   - รันแยกเธรด: UI ไม่ค้างระหว่างโหลดโมเดล/ถอดเสียง และยกเลิกได้ด้วย terminate()
   - โมเดลถูกดาวน์โหลดจาก CDN ครั้งแรกครั้งเดียว (เบราว์เซอร์แคชไว้) — ตัว"เสียงเพลง"
     ไม่ถูกส่งออกจากเครื่องผู้ใช้ วิเคราะห์ในเครื่องทั้งหมดตามปรัชญาเดิมของแอป
   - ลอง WebGPU ก่อน (เร็วกว่ามากบน Chrome เดสก์ท็อป/Android) ตกลงมา WASM อัตโนมัติ */

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

async function getPipe(repo, id) {
  if (pipes.has(repo)) return pipes.get(repo);
  const lib = await loadLib();
  const ver = (lib.env && lib.env.version) || '3';
  const major = parseInt(String(ver).split('.')[0], 10) || 3;
  const progress_callback = mkProgress(id);
  let pipe = null;
  try {
    if (major >= 3) {
      // WebGPU: encoder fp32 (ชัวร์สุดเรื่อง op support) + decoder q8 (เล็ก/ไฟล์เดียวกับ WASM)
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          pipe = await lib.pipeline('automatic-speech-recognition', repo, {
            device: 'webgpu',
            dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
            progress_callback,
          });
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
  pipes.set(repo, pipe);
  return pipe;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.cmd !== 'run') return;
  const { id, pcm, lang, repo, duration } = msg;
  try {
    const pipe = await getPipe(repo, id);
    post({ type: 'dl', id, pct: 100 });

    let processedSec = 0;
    const opts = {
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      // ถูกเรียกทุก ~25s ของเสียงที่ถอดเสร็จ (ถ้าเวอร์ชันไลบรารีรองรับ)
      chunk_callback: () => {
        processedSec += 25;
        if (duration > 0) post({ type: 'asr', id, pct: Math.min(99, Math.round((processedSec / duration) * 100)) });
      },
    };
    if (lang && lang !== 'auto') opts.language = lang;

    // heartbeat กัน UI ดูเหมือนค้างเมื่อ chunk_callback ไม่ถูกเรียก
    const t0 = Date.now();
    const hb = setInterval(() => post({ type: 'asr', id, pct: null, elapsed: Math.round((Date.now() - t0) / 1000) }), 4000);
    let out;
    try { out = await pipe(pcm, opts); }
    finally { clearInterval(hb); }

    const chunks = [];
    const arr = (out && out.chunks) || [];
    for (const c of arr) {
      const ts = c.timestamp || [];
      chunks.push({
        t0: isFinite(+ts[0]) ? +ts[0] : 0,
        t1: ts[1] == null || !isFinite(+ts[1]) ? null : +ts[1],
        text: String(c.text || ''),
      });
    }
    if (!chunks.length && out && out.text && out.text.trim()) {
      chunks.push({ t0: 0, t1: duration || null, text: out.text });
    }
    post({ type: 'done', id, chunks, text: (out && out.text) || '' });
  } catch (e) {
    post({
      type: 'error', id,
      code: e && e.code === 'load' ? 'load' : 'run',
      message: String((e && e.message) || e),
    });
  }
};
