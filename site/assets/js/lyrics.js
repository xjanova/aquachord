/* lyrics.js — สะพานฝั่ง main thread ไปหา Whisper worker (lyrics-worker.js)
   Lyrics.transcribe(pcm16k, {model, lang, duration, vad, onDl, onVad, onAsr, ctl}) → {chunks, text, info}
   info: { vad: {peak, frac, ms} | null, skipped (ไม่มีเสียงร้อง → ไม่ได้รัน Whisper), guard: {loops, cut, capped, skipped, overBudget} }
   - worker ถูกเก็บไว้ใช้ซ้ำ (โมเดลค้างในหน่วยความจำ → เพลงถัดไปไม่ต้องโหลดใหม่)
   - ยกเลิกจริงได้กลางทางด้วยการ terminate worker (ctl.aborted จาก UI) */
(function () {
  const MODELS = {
    tiny:  { repo: 'Xenova/whisper-tiny',  size: '~45 MB'  },
    base:  { repo: 'Xenova/whisper-base',  size: '~85 MB'  },
    small: { repo: 'Xenova/whisper-small', size: '~250 MB' },
    // large-v3-turbo: แม่นที่สุดสำหรับเพลงไทย แต่ต้องมี GPU (WebGPU) — บน CPU ช้าเกินใช้งาน
    turbo: { repo: 'onnx-community/whisper-large-v3-turbo', size: '~565–760 MB', gpuOnly: true },
  };

  /* ---------- ตรวจ GPU ของเครื่องนี้ (WebGPU) — ใช้ตัดสินว่าเปิดโมเดลใหญ่ได้ไหม + บอกผู้ใช้ ----------
     ข้อมูลอยู่ในเครื่องเท่านั้น ไม่ส่งไปไหน */
  let gpuPromise = null;
  function prettyRenderer(r) {
    if (!r) return '';
    let s = String(r);
    const m = s.match(/^ANGLE \((.*)\)$/);
    if (m) {
      const parts = m[1].split(',').map((x) => x.trim());
      s = (parts[1] || parts[0] || '').replace(/^ANGLE Metal Renderer:\s*/i, '');
    }
    return s.replace(/\s*\(0x[0-9a-f]+\)/ig, '').replace(/\s+(Direct3D|OpenGL|Vulkan|vs_|ps_).*$/i, '').trim().slice(0, 60);
  }
  function detectGPU() {
    if (gpuPromise) return gpuPromise;
    gpuPromise = (async () => {
      const r = { webgpu: false, f16: false, name: '', vendor: '', arch: '', software: false, renderer: '' };
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          r.renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        }
      } catch (e) {}
      try {
        if (navigator.gpu) {
          const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          if (a) {
            let info = a.info || null;
            if (!info && a.requestAdapterInfo) { try { info = await a.requestAdapterInfo(); } catch (e) {} }
            info = info || {};
            r.webgpu = !a.isFallbackAdapter;
            r.f16 = !!(a.features && a.features.has('shader-f16'));
            r.vendor = info.vendor || ''; r.arch = info.architecture || '';
          }
        }
      } catch (e) {}
      r.software = /swiftshader|llvmpipe|softpipe|microsoft basic render/i.test(r.renderer);
      if (r.software) r.webgpu = false;
      r.name = prettyRenderer(r.renderer) || [r.vendor, r.arch].filter(Boolean).join(' ');
      return r;
    })();
    return gpuPromise;
  }


  let worker = null, busy = false, seq = 0;

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('assets/js/lyrics-worker.js', { type: 'module' });
    return worker;
  }

  function killWorker() {
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null; busy = false;
  }

  function err(code) { const e = new Error(code); e.code = code; return e; }

  // worker หยุดตัวเองเมื่อเลยงบเวลา (คืนเนื้อร้องเท่าที่ได้) — ตัวนี้กันกรณีค้างอยู่ในการคำนวณครั้งเดียว
  // (เช่น GPU ค้าง) ที่ worker ไม่มีจังหวะได้เช็กเวลา: เลยงบ + เผื่อ → ปิด worker ทิ้ง
  const HARD_GRACE_SEC = 120;

  function transcribe(pcm, opts) {
    opts = opts || {};
    const model = MODELS[opts.model] ? opts.model : 'base';
    return new Promise((resolve, reject) => {
      if (busy) { reject(err('busy')); return; }
      let w;
      try { w = ensureWorker(); } catch (e) { reject(err('load')); return; }
      busy = true;
      const id = ++seq;
      let watch = 0, hard = 0;
      const cleanup = () => {
        clearInterval(watch);
        clearTimeout(hard);
        busy = false;
        if (worker) {
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onErr);
        }
      };
      const onMsg = (ev) => {
        const m = ev.data || {};
        if (m.id != null && m.id !== id) return;
        if (m.type === 'dl') { if (opts.onDl) opts.onDl(m.pct); }
        else if (m.type === 'vad') { if (opts.onVad) opts.onVad(m.pct); }
        else if (m.type === 'device') { api.lastDevice = m.device; if (opts.onDevice) opts.onDevice(m.device, m.model); }
        else if (m.type === 'budget') {
          clearTimeout(hard);
          hard = setTimeout(() => { cleanup(); killWorker(); reject(err('timeout')); }, (m.sec + Math.max(HARD_GRACE_SEC, m.sec * 0.5)) * 1000);
        }
        else if (m.type === 'asr') { if (opts.onAsr) opts.onAsr(m.pct, m.elapsed); }
        else if (m.type === 'done') { cleanup(); resolve({ chunks: m.chunks || [], text: m.text || '', info: m.info || null }); }
        else if (m.type === 'error') {
          cleanup();
          const e = err(m.code === 'load' ? 'load' : 'run');
          e.detail = m.message;
          reject(e);
        }
      };
      // error ระดับ worker (โหลดสคริปต์ไม่ได้ / เบราว์เซอร์ไม่รองรับ module worker)
      const onErr = () => { cleanup(); killWorker(); reject(err('load')); };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      if (opts.ctl) {
        watch = setInterval(() => {
          if (opts.ctl.aborted) { cleanup(); killWorker(); reject(new Error('cancelled')); }
        }, 300);
      }
      try {
        w.postMessage({
          cmd: 'run', id, pcm,
          lang: opts.lang || 'th',
          repo: MODELS[model].repo,
          gpuOnly: !!MODELS[model].gpuOnly,
          duration: opts.duration || 0,
          vad: opts.vad !== false,
        }, [pcm.buffer]);
      } catch (e) {
        cleanup(); killWorker(); reject(err('load'));
      }
    });
  }

  const api = { MODELS, transcribe, reset: killWorker, detectGPU, lastDevice: null };
  window.Lyrics = api;
})();
