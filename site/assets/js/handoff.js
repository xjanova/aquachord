/* handoff.js — รับไฟล์เพลงที่แอปพันธมิตรส่งมา (X-DREAMER / aixman — ai.xman4289.com) ผ่านลิงก์
   สัญญาเต็มอยู่ที่ docs/10-SONG-HANDOFF.md · ไม่แตะ DOM · ใช้ได้ทั้งเบราว์เซอร์ (window.Handoff) และ Node (tools/test-handoff.cjs)

   ลิงก์ที่รับ (ข้อมูลอยู่หลัง # จึงไม่ถูกส่งถึงเซิร์ฟเวอร์ AquaChord/Cloudflare และไม่ติดใน log)
     #/import?m=<URL ของ manifest JSON>          ← แบบหลัก: มีชื่อเพลง + เนื้อร้อง + ลิงก์ไฟล์เสียง
     #/import?src=<URL ไฟล์เสียง>&title=<ชื่อ>    ← แบบสั้น: ไฟล์เสียงอย่างเดียว
   ทุก URL ต้องอยู่ใน ORIGINS (https เท่านั้น) · ตอนรัน AquaChord บน localhost รับ http://localhost / 127.0.0.1 เพิ่ม (ไว้ทดสอบ)
   ดึงแบบ credentials:'omit' — ลิงก์ต้องพกสิทธิ์มาเอง (token อายุสั้น) และฝั่งส่งต้องตอบ Access-Control-Allow-Origin

   API
   Handoff.parse(hash) → null (ไม่ใช่ลิงก์ import) | { kind:'manifest'|'audio', url, title } · ผิดรูป → throw {code}
   Handoff.allowed(url, here) → boolean
   Handoff.readManifest(json, now) → meta (ตัดความยาว/อักขระควบคุมแล้ว) · throw {code}
   Handoff.receive(req, { here, fetch, now, maxBytes, timeoutMs }) → Promise<{ file: File, meta }>
   Handoff.fileName(meta, contentType) → ชื่อไฟล์ปลอดภัย (ชื่อเพลง + นามสกุลจริง — analyze.js ใช้เป็นชื่อเพลง)
   error.code: bad · origin · expired · fetch · timeout · manifest · version · toobig · notAudio */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.Handoff = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const ORIGINS = ['https://ai.xman4289.com', 'https://xman4289.com', 'https://www.xman4289.com'];
  const MAX_BYTES = 80 * 1024 * 1024;   // เท่ากับเพดานของ analyze.js
  const MAX_MANIFEST = 256 * 1024;
  const MAX_LYRICS = 20000;             // เท่ากับ LyricFix.MAX_TEXT
  const TIMEOUT_MS = 90000;
  const LANGS = ['th', 'en', 'auto'];
  const EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|webm|mp4)$/i;
  const MIME_EXT = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/webm': 'webm',
  };
  const EXT_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', mp4: 'audio/mp4' };
  // ฝั่งส่งบางตัวตอบชนิดกลาง ๆ — ยอมเฉพาะเมื่อชื่อไฟล์บอกว่าเป็นเสียง
  const GENERIC = ['', 'application/octet-stream', 'binary/octet-stream'];

  function err(code, extra) { const e = new Error('handoff:' + code); e.code = code; if (extra) Object.assign(e, extra); return e; }

  function isLocal(host) { return host === 'localhost' || host === '127.0.0.1'; }

  function allowed(u, here) {
    let url;
    try { url = new URL(u); } catch (e) { return false; }
    if (url.username || url.password) return false;
    if (ORIGINS.indexOf(url.origin) >= 0) return true;
    return !!(here && isLocal(here.hostname)) && (url.protocol === 'http:' || url.protocol === 'https:') && isLocal(url.hostname);
  }

  // ข้อความจากภายนอก: ตัดอักขระควบคุม (เนื้อร้องคงบรรทัดไว้) · ตัดช่องว่างหัวท้าย · จำกัดความยาว
  function clean(v, max, multiline) {
    if (typeof v !== 'string') return '';
    let s = v.replace(/\r\n?/g, '\n');
    s = multiline ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
    s = s.trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  function parse(hash) {
    const h = String(hash || '').replace(/^#\/?/, '');
    const q = h.indexOf('?');
    if ((q < 0 ? h : h.slice(0, q)).replace(/\/+$/, '') !== 'import') return null;
    let p;
    try { p = new URLSearchParams(q < 0 ? '' : h.slice(q + 1)); } catch (e) { throw err('bad'); }
    const m = p.get('m'), src = p.get('src');
    if (m) return { kind: 'manifest', url: m, title: '' };
    if (src) return { kind: 'audio', url: src, title: clean(p.get('title') || '', 200) };
    throw err('bad');
  }

  function readManifest(j, now) {
    if (!j || typeof j !== 'object' || j.type !== 'aquachord.handoff') throw err('manifest');
    if (j.v !== 1) throw err('version');
    const a = j.audio;
    if (!a || typeof a !== 'object' || typeof a.url !== 'string' || !a.url) throw err('manifest');
    if (j.expiresAt != null) {
      const exp = Date.parse(j.expiresAt);
      if (!Number.isFinite(exp)) throw err('manifest');
      if (exp <= (now == null ? Date.now() : now)) throw err('expired');
    }
    const src = j.source && typeof j.source === 'object' ? j.source : {};
    const bytes = Number(a.bytes);
    return {
      title: clean(j.title, 200),
      lyrics: clean(j.lyrics, MAX_LYRICS, true),
      lang: LANGS.indexOf(j.lang) >= 0 ? j.lang : '',
      source: { app: clean(src.app, 40), name: clean(src.name, 60) },
      audio: {
        url: a.url,
        mime: clean(a.mime, 60).toLowerCase(),
        bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
        filename: clean(a.filename, 200),
      },
    };
  }

  function extOf(name) { const m = EXT_RE.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function urlName(u) {
    try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); } catch (e) { return ''; }
  }

  function fileName(meta, type) {
    const fromUrl = urlName(meta.audio.url);
    const fromFile = meta.audio.filename || (EXT_RE.test(fromUrl) ? fromUrl : '');
    const ext = MIME_EXT[type] || extOf(fromFile) || MIME_EXT[meta.audio.mime] || 'mp3';
    let base = meta.title || fromFile.replace(EXT_RE, '') || 'X-DREAMER song';
    base = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 120) || 'X-DREAMER song';
    return base + '.' + ext;
  }

  async function readCapped(res, max) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > max) throw err('toobig');
      return new Uint8Array(buf);
    }
    const reader = res.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) { try { reader.cancel(); } catch (e) { /* ignore */ } throw err('toobig'); }
      parts.push(value);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
  }

  async function get(f, url, signal) {
    let res;
    try {
      res = await f(url, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal });
    } catch (e) {
      throw err(signal && signal.aborted ? 'timeout' : 'fetch');
    }
    // 401/403/404/410 = token หมดอายุ/ถูกใช้แล้ว/ถูกเพิกถอน → บอกผู้ใช้ให้กดส่งใหม่จากต้นทาง
    if ([401, 403, 404, 410].indexOf(res.status) >= 0) throw err('expired', { status: res.status });
    if (!res.ok) throw err('fetch', { status: res.status });
    return res;
  }

  async function receive(req, o) {
    o = o || {};
    const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
    const max = o.maxBytes || MAX_BYTES;
    if (!f || !req || !req.url) throw err('bad');
    if (!allowed(req.url, o.here)) throw err('origin');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), o.timeoutMs || TIMEOUT_MS) : null;
    const signal = ac ? ac.signal : undefined;
    try {
      let meta = { title: req.title || '', lyrics: '', lang: '', source: { app: '', name: '' }, audio: { url: req.url, mime: '', bytes: 0, filename: '' } };
      if (req.kind === 'manifest') {
        const res = await get(f, req.url, signal);
        const raw = await readCapped(res, MAX_MANIFEST).catch((e) => { throw e.code === 'toobig' ? err('manifest') : err(signal && signal.aborted ? 'timeout' : 'fetch'); });
        let j;
        try { j = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { throw err('manifest'); }
        meta = readManifest(j, o.now);
        if (!allowed(meta.audio.url, o.here)) throw err('origin');
      }
      if (meta.audio.bytes > max) throw err('toobig');
      const res = await get(f, meta.audio.url, signal);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const name = fileName(meta, type);
      if (!(type.indexOf('audio/') === 0 || MIME_EXT[type] || (GENERIC.indexOf(type) >= 0 && EXT_RE.test(name)))) throw err('notAudio');
      const len = Number(res.headers.get('content-length')) || 0;
      if (len > max) throw err('toobig');
      const bytes = await readCapped(res, max).catch((e) => { throw typeof e.code === 'string' ? e : err(signal && signal.aborted ? 'timeout' : 'fetch'); });
      if (!bytes.byteLength) throw err('notAudio');
      const mime = type.indexOf('audio/') === 0 ? type : (EXT_MIME[extOf(name)] || 'audio/mpeg');
      return { file: new File([bytes], name, { type: mime }), meta };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { ORIGINS, MAX_BYTES, parse, allowed, readManifest, fileName, receive };
});
