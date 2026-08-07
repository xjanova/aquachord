/* lyrics.js — สะพานฝั่ง main thread ไปหา Whisper worker (lyrics-worker.js)
   Lyrics.transcribe(pcm16k, {model, lang, duration, onDl, onAsr, ctl}) → {chunks, text}
   - worker ถูกเก็บไว้ใช้ซ้ำ (โมเดลค้างในหน่วยความจำ → เพลงถัดไปไม่ต้องโหลดใหม่)
   - ยกเลิกจริงได้กลางทางด้วยการ terminate worker (ctl.aborted จาก UI) */
(function () {
  const MODELS = {
    tiny:  { repo: 'Xenova/whisper-tiny',  size: '~45 MB'  },
    base:  { repo: 'Xenova/whisper-base',  size: '~85 MB'  },
    small: { repo: 'Xenova/whisper-small', size: '~250 MB' },
  };

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

  function transcribe(pcm, opts) {
    opts = opts || {};
    const model = MODELS[opts.model] ? opts.model : 'base';
    return new Promise((resolve, reject) => {
      if (busy) { reject(err('busy')); return; }
      let w;
      try { w = ensureWorker(); } catch (e) { reject(err('load')); return; }
      busy = true;
      const id = ++seq;
      let watch = 0;
      const cleanup = () => {
        clearInterval(watch);
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
        else if (m.type === 'asr') { if (opts.onAsr) opts.onAsr(m.pct, m.elapsed); }
        else if (m.type === 'done') { cleanup(); resolve({ chunks: m.chunks || [], text: m.text || '' }); }
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
          duration: opts.duration || 0,
        }, [pcm.buffer]);
      } catch (e) {
        cleanup(); killWorker(); reject(err('load'));
      }
    });
  }

  window.Lyrics = { MODELS, transcribe, reset: killWorker };
})();
