/* stems.js — สะพานฝั่ง main thread ไปหา stems-worker.js: "แกะไลน์เพลงจริง" หลายเครื่องดนตรี → TrackSet v1
   ไม่แตะ DOM · งานหนักทั้งหมดอยู่ใน worker (ยกเลิกได้จริงด้วย terminate) · ไฟล์เสียงไม่ออกจากเครื่อง

   API
   Stems.capabilities() → Promise<{ webgpu, f16, gpuName, liteOK, fullOK, reason, downloads }>
       reason: '' | 'no-worker' | 'no-wasm' | 'no-webgpu' | 'software-gpu' | 'gpu-limits' | 'low-memory'
   Stems.transcribe(audioBuffer, opts) → Promise<TrackSet>
       opts: { mode:'lite'|'full', bpm, phase, key, chordSegs, tick, chk, onPct(frac, detailText),
               wantVocalsPcm16k, maxSeconds }
       full: TrackSet มี instrumentalMono11k (Float32Array 11025Hz) และ vocalsPcm16k (ถ้าขอ) ติดมาด้วย
             (ไม่ใช่ส่วนของสัญญา TrackSet — ผู้เรียกต้องลบก่อนเก็บ)
   Stems.separate(audioBuffer, opts) → Promise<Separation>   (ขั้นแยก stem อย่างเดียว ใช้ใน analyze.js)
       Separation: { duration, present:{drums,bass,other,vocals,guitar,piano}, level(dB),
                     instrumentalMono11k, vocalsPcm16k|null,
                     stem(name, sr=11025) → Promise<Float32Array>, tracks(opts) → Promise<TrackSet>, release() }
   Stems.reset() — ปิด worker (คืนหน่วยความจำ/GPU)
   Stems.config({ modelUrls:{bp,demucs}, ortBase }) — สำหรับเทสต์/โฮสต์ไฟล์เอง

   error.code: 'gpu' (ไม่มี/ใช้ WebGPU ไม่ได้) · 'load' (โหลดไลบรารี/โมเดลไม่ได้) · 'run' (รันพัง) · ยกเลิก = Error('cancelled') */
(function () {
  'use strict';
  const WORKER_URL = 'assets/js/stems-worker.js';
  const DEMUCS_MIN_BIND = 231211008;
  // ขนาดดาวน์โหลดครั้งแรก (MiB ที่ส่งผ่านเน็ตจริง วัดใน Chrome ผ่าน CDP — tools/e2e-tracks.mjs) ครั้งต่อไปมาจากแคช
  // lite: onnxruntime-web wasm 2.9 + Basic Pitch 0.22 · full: onnxruntime-web WebGPU 5.1 + Demucs 272 (+ Basic Pitch ถ้ายังไม่มี)
  const DOWNLOADS = { lite: { runtime: 2.9, models: 0.22 }, full: { runtime: 5.1, models: 272.2 } };

  let worker = null, seq = 0, cfg = {};
  const calls = new Map();

  function err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

  /* ---------- ข้อความรายละเอียดระหว่างทำงาน (เพิ่มเข้า I18N เฉพาะคีย์ที่ยังไม่มี) ---------- */
  const TXT = {
    th: {
      'stems.d.prep': 'เตรียมเสียง',
      'stems.d.rt': 'โหลดเอนจิน AI',
      'stems.d.dlbp': 'ดาวน์โหลดโมเดลแกะโน้ต',
      'stems.d.dldm': 'ดาวน์โหลดโมเดลแยกเครื่องดนตรี (272 MB ครั้งแรกครั้งเดียว)',
      'stems.d.cachedm': 'โหลดโมเดลแยกเครื่องดนตรีจากเครื่อง',
      'stems.d.sep': 'แยกเครื่องดนตรีด้วย GPU',
      'stems.d.mix': 'รวมเสียงดนตรีสำหรับแกะคอร์ด',
      'stems.d.hpss': 'แยกเสียงกลองออกจากเสียงที่มีโน้ต',
      'stems.d.drums': 'แกะกลอง',
      'stems.d.notes': 'แกะโน้ต',
      'stems.d.melody': 'หาเส้นทำนอง',
      'stems.d.bass': 'แกะเบส',
      'stems.d.vocals': 'แกะทำนองร้อง',
      'stems.d.guitar': 'แกะกีตาร์',
      'stems.d.piano': 'แกะเปียโน',
      'stems.d.other': 'แกะเครื่องดนตรีอื่น',
      'stems.d.done': 'เสร็จ',
    },
    en: {
      'stems.d.prep': 'Preparing audio',
      'stems.d.rt': 'Loading the AI engine',
      'stems.d.dlbp': 'Downloading the note model',
      'stems.d.dldm': 'Downloading the separation model (272 MB, first time only)',
      'stems.d.cachedm': 'Loading the separation model from this device',
      'stems.d.sep': 'Separating instruments on the GPU',
      'stems.d.mix': 'Mixing the band for chord detection',
      'stems.d.hpss': 'Splitting drums from pitched sound',
      'stems.d.drums': 'Transcribing drums',
      'stems.d.notes': 'Transcribing notes',
      'stems.d.melody': 'Tracing the melody line',
      'stems.d.bass': 'Transcribing bass',
      'stems.d.vocals': 'Transcribing the vocal melody',
      'stems.d.guitar': 'Transcribing guitar',
      'stems.d.piano': 'Transcribing piano',
      'stems.d.other': 'Transcribing other instruments',
      'stems.d.done': 'Done',
    },
  };
  (function addText() {
    const I = window.I18N;
    if (!I || typeof I.extend !== 'function' || typeof I.t !== 'function') return;
    const more = {};
    Object.keys(TXT).forEach((l) => {
      more[l] = {};
      // อย่าทับคำแปลที่ i18n.js กำหนดไว้แล้ว (เช็กได้เฉพาะภาษาปัจจุบัน — ภาษาอื่นเติมเฉพาะเมื่อภาษาปัจจุบันยังไม่มีคีย์)
      Object.keys(TXT[l]).forEach((k) => { if (I.t(k) === k) more[l][k] = TXT[l][k]; });
    });
    I.extend(more);
  })();
  function txt(key) {
    const I = window.I18N;
    if (I && typeof I.t === 'function') { const s = I.t(key); if (s && s !== key) return s; }
    const lang = (I && I.get && I.get()) || 'th';
    return (TXT[lang] && TXT[lang][key]) || TXT.en[key] || '';
  }
  function detail(key, x) {
    if (!key) return '';
    const k = 'stems.d.' + key.replace(/-/g, '');
    let s = txt(k);
    if (x != null && x !== '') s += (key === 'sep' ? ' ' + x : ' ' + x + '%');
    return s;
  }

  /* ---------- worker ---------- */
  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = onMsg;
    worker.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const ex = err('load', 'worker failed to start');
      killWorker();
      failAll(ex);
    };
    return worker;
  }
  function killWorker() {
    if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
    worker = null;
  }
  function failAll(e) {
    const list = Array.from(calls.values());
    calls.clear();
    list.forEach((c) => { clearInterval(c.watch); c.reject(e); });
  }
  function onMsg(ev) {
    const m = ev.data || {};
    const c = calls.get(m.id);
    if (!c) return;
    if (m.type === 'pct') { if (c.onPct) c.onPct(m.f, m.key, m.x); return; }
    calls.delete(m.id);
    clearInterval(c.watch);
    if (m.type === 'done') c.resolve(m.result);
    else c.reject(Object.assign(err(m.code || 'run', m.message), { detail: m.message }));
  }
  function call(cmd, payload, transfer, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      let w;
      try { w = ensureWorker(); } catch (e) { reject(err('load', 'worker')); return; }
      const id = ++seq;
      const c = { resolve, reject, onPct: opts._onPct || null, watch: 0 };
      calls.set(id, c);
      if (typeof opts.chk === 'function') {
        // ยกเลิกจาก UI: chk() โยน Error('cancelled') → ปิด worker ทันที (งานทุกชิ้นที่ค้างจบพร้อมกัน)
        c.watch = setInterval(() => {
          try { opts.chk(); } catch (e) { killWorker(); failAll(e && e.message === 'cancelled' ? e : new Error('cancelled')); }
        }, 250);
      }
      try { w.postMessage(Object.assign({ cmd, id, cfg }, payload), transfer || []); }
      catch (e) { calls.delete(id); clearInterval(c.watch); reject(err('load', 'postMessage')); }
    });
  }

  /* ---------- เสียงขาเข้า ---------- */
  function channelsOf(audio, maxSeconds) {
    if (!audio || typeof audio.getChannelData !== 'function') throw err('run', 'audio buffer required');
    const sr = audio.sampleRate;
    const n = Math.min(audio.length, Math.floor((maxSeconds > 0 ? maxSeconds : 600) * sr));
    const chans = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels || 1); c++) chans.push(audio.getChannelData(c).slice(0, n)); // สำเนา (AudioBuffer ยังใช้ต่อ)
    return { chans, sr, n };
  }
  function monoOf(audio, maxSeconds) {
    const { chans, sr, n } = channelsOf(audio, maxSeconds);
    if (chans.length === 1) return { pcm: chans[0], sr };
    const m = new Float32Array(n);
    const a = chans[0], b = chans[1];
    for (let i = 0; i < n; i++) m[i] = 0.5 * (a[i] + b[i]);
    return { pcm: m, sr };
  }
  function pickOpts(o) {
    return { bpm: +o.bpm > 0 ? +o.bpm : null, phase: isFinite(+o.phase) ? +o.phase : null, debug: !!o.debug, batch: o.batch, bpDevice: o.bpDevice, keepModel: !!o.keepModel, wantVocalsPcm16k: !!o.wantVocalsPcm16k };
  }
  function pctFn(o, a, b) {
    const on = typeof o.onPct === 'function' ? o.onPct : null;
    return (f, key, x) => { if (on) on(a + (b - a) * Math.max(0, Math.min(1, f || 0)), detail(key, x)); };
  }

  /* ---------- capabilities ---------- */
  let capsP = null;
  function simdOK() {
    try {
      return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch (e) { return false; }
  }
  function capabilities() {
    if (capsP) return capsP;
    capsP = (async () => {
      const r = { webgpu: false, f16: false, gpuName: '', liteOK: false, fullOK: false, reason: '', downloads: DOWNLOADS };
      const workerOK = typeof Worker === 'function';
      const wasmOK = typeof WebAssembly === 'object' && simdOK();
      r.liteOK = workerOK && wasmOK;
      let g = null;
      try { if (window.Lyrics && typeof Lyrics.detectGPU === 'function') g = await Lyrics.detectGPU(); } catch (e) { g = null; }
      if (g) { r.webgpu = !!g.webgpu; r.f16 = !!g.f16; r.gpuName = g.name || ''; }
      let lim = null;
      try {
        if (navigator.gpu) {
          const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          if (a) {
            lim = a.limits;
            if (!g) {
              const info = a.info || {};
              r.webgpu = !a.isFallbackAdapter;
              r.f16 = !!(a.features && a.features.has('shader-f16'));
              r.gpuName = [info.vendor, info.architecture].filter(Boolean).join(' ');
            }
          }
        }
      } catch (e) { lim = null; }
      if (!r.liteOK) r.reason = workerOK ? 'no-wasm' : 'no-worker';
      else if (!r.webgpu) r.reason = g && g.software ? 'software-gpu' : 'no-webgpu';
      else if (!lim || lim.maxStorageBufferBindingSize < DEMUCS_MIN_BIND || lim.maxBufferSize < DEMUCS_MIN_BIND) r.reason = 'gpu-limits';
      else if (navigator.deviceMemory && navigator.deviceMemory < 4) r.reason = 'low-memory';
      else r.fullOK = true;
      return r;
    })();
    return capsP;
  }

  /* ---------- separate (full ขั้นที่ 1) ---------- */
  async function separate(audio, opts) {
    opts = opts || {};
    const { chans, sr } = channelsOf(audio, opts.maxSeconds);
    const L = chans[0], R = chans[1] || null;
    const tr = [L.buffer];
    if (R) tr.push(R.buffer);
    const res = await call('separate', { L, R, sr, opts: pickOpts(opts) }, tr, Object.assign({}, opts, { _onPct: pctFn(opts, 0, 1) }));
    let alive = true;
    const sepId = res.sepId;
    const myWorker = worker;
    const check = () => { if (!alive || worker !== myWorker || !worker) throw err('run', 'separation released'); };
    return {
      duration: res.duration, present: res.present, level: res.level, chunks: res.chunks, timing: res.timing,
      instrumentalMono11k: res.instrumentalMono11k, vocalsPcm16k: res.vocalsPcm16k || null,
      stem(name, outSr) { check(); return call('stem', { sepId, name, sr: outSr || 11025 }, [], opts); },
      tracks(o) {
        o = o || {};
        check();
        return call('tracks', { sepId, opts: pickOpts(o) }, [], Object.assign({}, o, { _onPct: pctFn(o, 0, 1) }));
      },
      release() {
        if (!alive) return;
        alive = false;
        if (worker && worker === myWorker) { try { worker.postMessage({ cmd: 'release', sepId }); } catch (e) { /* ignore */ } }
      },
    };
  }

  /* ---------- transcribe ---------- */
  async function transcribe(audio, opts) {
    opts = opts || {};
    const mode = opts.mode === 'full' ? 'full' : 'lite';
    if (mode === 'lite') {
      const caps = await capabilities();
      if (!caps.liteOK) throw err('load', caps.reason);
      const { pcm, sr } = monoOf(audio, opts.maxSeconds);
      return call('lite', { pcm, sr, opts: pickOpts(opts) }, [pcm.buffer], Object.assign({}, opts, { _onPct: pctFn(opts, 0, 1) }));
    }
    const caps = await capabilities();
    if (!caps.fullOK) throw err('gpu', caps.reason);
    const onPct = opts.onPct;
    const sep = await separate(audio, Object.assign({}, opts, { onPct: (f, d) => { if (onPct) onPct(0.75 * f, d); } }));
    try {
      const ts = await sep.tracks(Object.assign({}, opts, { onPct: (f, d) => { if (onPct) onPct(0.75 + 0.25 * f, d); } }));
      ts.instrumentalMono11k = sep.instrumentalMono11k;
      if (sep.vocalsPcm16k) ts.vocalsPcm16k = sep.vocalsPcm16k;
      return ts;
    } finally { sep.release(); }
  }

  window.Stems = {
    capabilities, transcribe, separate,
    reset() { killWorker(); failAll(err('run', 'reset')); },
    config(c) { cfg = Object.assign({}, cfg, c || {}); },
    DOWNLOADS,
  };
})();
