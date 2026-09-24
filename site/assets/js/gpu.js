/* gpu.js — โหมด "AI เซิร์ฟเวอร์ (GPU)" สำหรับแอดมิน (docs/09 §3)
   PWA → /api/gpu/* (PHP ของเรา, ต้องมี admin bearer token) → aixman partner API → GPU
   - เบราว์เซอร์ไม่คุยกับ aixman ตรง ๆ · token ใน localStorage เป็นแค่ "คำใบ้" — เซิร์ฟเวอร์ตัดสินสิทธิ์
   - งานถูกจำไว้ใน localStorage 'aq.gpu.jobs' (มีเพดาน, parse แบบไม่เชื่อข้อมูล) → รีโหลดแล้ว poll ต่อได้
   - งานเสร็จ → Transcription.toSongDoc → Store.upsert ครั้งเดียวต่องาน (จำ songId ต่อ jobId + Web Locks ข้ามแท็บ)
   ส่วน UI (แผงหน้าแกะเพลง, หน้า #/job/<id>, หน้า #/jobs) อยู่ท้ายไฟล์ — app.js แค่เรียก hook */
(function () {
  'use strict';

  const API = 'api';
  const LS_JOBS = 'aq.gpu.jobs';
  const LS_PREF = 'aq.gpu.pref';
  const LS_TOKEN = 'aq.admin.token';
  const MAX_JOBS = 30;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const TOKEN_RE = /^[a-f0-9]{64}$/i;
  const MODES = ['open', 'sheetsage2'];
  const LANGS = ['th', 'en', 'auto'];
  const STATUSES = ['queued', 'starting', 'rendering', 'completed', 'failed', 'cancelled'];
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const ERR_KEYS = ['notFound', 'badResult', 'noResult', 'quota', 'badResponse'];
  const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|mp4|webm)$/i;
  const CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
  const MAX_LYRICS = 5000;

  /* ---------------- คำแปล ---------------- */
  I18N.extend({
    th: {
      'gpu.panel.title': 'โหมด AI เซิร์ฟเวอร์ (GPU) — แอดมิน',
      'gpu.panel.mode': 'โมเดล',
      'gpu.mode.open': 'มาตรฐาน',
      'gpu.mode.sheetsage2': 'SheetSage2 (ไม่ใช่เชิงพาณิชย์)',
      'gpu.panel.lang': 'ภาษาเพลง',
      'gpu.lang.th': 'ไทย',
      'gpu.lang.en': 'อังกฤษ',
      'gpu.lang.auto': 'อัตโนมัติ',
      'gpu.panel.lyrics': 'วางเนื้อเพลง (ถ้ามี) — ระบบจะจัดเวลาให้ แม่นกว่าให้ AI ถอดเอง',
      'gpu.panel.lyricsPh': 'เนื้อเพลงบรรทัดละวรรค (ไม่เกิน 5,000 ตัวอักษร)',
      'gpu.panel.hint': 'ไฟล์เสียงจะถูกอัปโหลดไปถอดคอร์ด เนื้อร้อง และทำนองบนเซิร์ฟเวอร์ GPU (ไม่เกิน {mb} MB · {min} นาที) ผลที่ได้เป็นร่างให้ตรวจแก้ · ใช้กับไฟล์ที่อัปโหลดเท่านั้น ลิงก์ยังแกะในเครื่องเหมือนเดิม',
      'gpu.panel.ncNote': 'SheetSage2 ใช้น้ำหนักโมเดล CC-BY-NC — ผลใช้ส่วนตัว/การศึกษาเท่านั้น ห้ามใช้เชิงพาณิชย์',
      'gpu.panel.disabled': 'ระบบ GPU ปิดอยู่ที่ฝั่ง aixman — ตอนนี้จะแกะในเครื่องแทน',
      'gpu.panel.unreachable': 'ยังติดต่อเซิร์ฟเวอร์ GPU ไม่ได้ — ส่งงานได้ แต่อาจล้มเหลว',
      'gpu.panel.notConfigured': 'โหมด GPU ยังไม่ได้ตั้งค่าการเชื่อมต่อ — ตั้งได้ที่หลังบ้าน',
      'gpu.panel.loadFail': 'โหลดสถานะโหมด GPU ไม่ได้',
      'gpu.panel.retry': 'ลองใหม่',
      'gpu.panel.jobsLink': 'ดูงาน GPU ทั้งหมด',
      'gpu.chip': 'งาน GPU',
      'gpu.chip.active': 'กำลังทำ {n}',
      'gpu.chip.new': 'เสร็จใหม่ {n}',
      'gpu.job.title': 'งาน AI เซิร์ฟเวอร์ (GPU)',
      'gpu.job.uploading': 'กำลังอัปโหลดไฟล์เสียง… {pct}%',
      'gpu.status.uploading': 'กำลังอัปโหลด',
      'gpu.status.queued': 'รอคิว GPU',
      'gpu.status.starting': 'กำลังเปิดเครื่อง GPU',
      'gpu.status.rendering': 'กำลังถอดเพลง',
      'gpu.status.completed': 'เสร็จแล้ว',
      'gpu.status.failed': 'ล้มเหลว',
      'gpu.status.cancelled': 'ยกเลิกแล้ว',
      'gpu.job.queue': 'คิวที่ {n}',
      'gpu.job.eta': 'เหลือประมาณ {eta}',
      'gpu.job.elapsed': 'ผ่านไป {t}',
      'gpu.job.bootNote': 'งานแรกอาจใช้เวลาหลายนาทีระหว่างเปิดเครื่อง GPU',
      'gpu.job.bgNote': 'ออกจากหน้านี้ได้ งานจะทำต่อเบื้องหลัง',
      'gpu.job.uploadNote': 'อย่าปิดหน้าจนกว่าจะอัปโหลดเสร็จ',
      'gpu.job.cancel': 'ยกเลิกงาน',
      'gpu.job.cancelConfirm': 'ยกเลิกงานนี้? (ยกเลิกได้เฉพาะงานที่ยังรอคิว)',
      'gpu.job.cancelUploadConfirm': 'หยุดอัปโหลดไฟล์นี้?',
      'gpu.job.cancelled': 'ยกเลิกงานแล้ว',
      'gpu.job.uploadCancelled': 'หยุดอัปโหลดแล้ว',
      'gpu.job.notCancellable': 'งานเริ่มประมวลผลแล้ว ยกเลิกไม่ได้ — รอผลได้เลย',
      'gpu.job.openSong': 'เปิดเพลง',
      'gpu.job.allJobs': 'งานทั้งหมด',
      'gpu.job.newJob': 'แกะเพลงใหม่',
      'gpu.job.retryPoll': 'ลองเช็คอีกครั้ง',
      'gpu.job.makeSong': 'สร้างเพลงจากผล',
      'gpu.job.reconnecting': 'การเชื่อมต่อสะดุด — กำลังลองใหม่…',
      'gpu.job.pollStopped': 'หยุดเช็คสถานะชั่วคราว (เชื่อมต่อไม่ได้)',
      'gpu.job.notFound': 'ไม่พบงานนี้',
      'gpu.job.needAdmin': 'ต้องเข้าสู่ระบบแอดมินก่อนจึงจะดูสถานะงานได้',
      'gpu.job.doneTitle': 'ถอดเพลงเสร็จแล้ว!',
      'gpu.job.aiNote': 'ผลจาก AI เป็นร่าง — ตรวจและแก้คอร์ด/เนื้อร้องได้ในหน้าเพลง',
      'gpu.done': 'ถอดเพลงเสร็จแล้ว!',
      'gpu.doneNotice': 'งาน GPU เสร็จแล้ว',
      'gpu.submitted': 'ส่งงานไปเซิร์ฟเวอร์ GPU แล้ว',
      'gpu.viewJob': 'ดูงาน',
      'gpu.adminLogin': 'เข้าสู่ระบบแอดมิน',
      'gpu.close': 'ปิด',
      'gpu.jobs.empty': 'ยังไม่มีงาน GPU',
      'gpu.jobs.emptyDesc': 'เปิดโหมด GPU ที่หน้าแกะเพลงแล้วอัปโหลดไฟล์เสียง งานจะแสดงที่นี่',
      'gpu.jobs.refresh': 'รีเฟรช',
      'gpu.jobs.remove': 'ลบออกจากรายการ',
      'gpu.jobs.removeConfirm': 'ลบงานนี้ออกจากรายการในเครื่อง? (เพลงที่สร้างแล้วยังอยู่ในคลัง)',
      'gpu.jobs.syncFail': 'ดึงรายการจากเซิร์ฟเวอร์ไม่ได้ — แสดงเฉพาะงานในเครื่องนี้',
      'gpu.err.auth': 'เซสชันแอดมินหมดอายุหรือยังไม่ได้เข้าสู่ระบบ — เข้าสู่ระบบใหม่ที่หน้า /admin/',
      'gpu.err.network': 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่',
      'gpu.err.timeout': 'เซิร์ฟเวอร์ตอบช้าเกินไป — ลองใหม่อีกครั้ง',
      'gpu.err.tooLarge': 'ไฟล์ใหญ่เกินที่เซิร์ฟเวอร์รับได้',
      'gpu.err.fileTooBig': 'ไฟล์ใหญ่เกิน {mb} MB — แปลงเป็น mp3 ก่อนแล้วลองใหม่',
      'gpu.err.badFile': 'ไฟล์นี้ไม่ใช่ไฟล์เสียงที่รองรับ (mp3, wav, flac, ogg, m4a)',
      'gpu.err.dailyLimit': 'ใช้โควตางาน GPU ของวันนี้ครบแล้ว — ลองใหม่พรุ่งนี้',
      'gpu.err.activeLimit': 'มีงาน GPU ที่กำลังทำอยู่เต็มจำนวน — รอให้เสร็จก่อน',
      'gpu.err.disabled': 'ระบบ GPU ปิดอยู่ชั่วคราว',
      'gpu.err.notConfigured': 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ GPU',
      'gpu.err.mode': 'โมเดลนี้ยังไม่เปิดให้ใช้',
      'gpu.err.badInput': 'ข้อมูลที่ส่งไม่ถูกต้อง',
      'gpu.err.notFound': 'ไม่พบงานนี้บนเซิร์ฟเวอร์ (อาจหมดอายุแล้ว)',
      'gpu.err.badResponse': 'เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ',
      'gpu.err.badResult': 'ผลลัพธ์จากเซิร์ฟเวอร์อ่านไม่ได้ — สร้างเพลงไม่สำเร็จ',
      'gpu.err.noResult': 'งานเสร็จแต่ยังดึงผลไม่ได้ — ลองเช็คอีกครั้งภายหลัง',
      'gpu.err.quota': 'พื้นที่เก็บเพลงในเครื่องเต็ม — ลบเพลงเก่าหรือส่งออกไฟล์ก่อน แล้วกด "สร้างเพลงจากผล"',
      'gpu.err.rate': 'เรียกบ่อยเกินไป — รอสักครู่แล้วลองใหม่',
      'gpu.err.notCancellable': 'งานเริ่มประมวลผลแล้ว ยกเลิกไม่ได้',
      'gpu.err.jobFailed': 'งานล้มเหลวบนเซิร์ฟเวอร์',
      'gpu.err.generic': 'เกิดข้อผิดพลาด กรุณาลองใหม่',
      'gpu.eta.sec': '{n} วินาที',
      'gpu.eta.min': '{n} นาที',
    },
    en: {
      'gpu.panel.title': 'Server AI mode (GPU) — admin',
      'gpu.panel.mode': 'Model',
      'gpu.mode.open': 'Standard',
      'gpu.mode.sheetsage2': 'SheetSage2 (non-commercial)',
      'gpu.panel.lang': 'Song language',
      'gpu.lang.th': 'Thai',
      'gpu.lang.en': 'English',
      'gpu.lang.auto': 'Auto',
      'gpu.panel.lyrics': 'Paste the lyrics (optional) — the server aligns them, more accurate than letting AI transcribe',
      'gpu.panel.lyricsPh': 'One phrase per line (max 5,000 characters)',
      'gpu.panel.hint': 'The audio is uploaded to a GPU server to transcribe chords, lyrics and melody (max {mb} MB · {min} min). Results are a draft to review · uploads only — links are still analyzed on-device',
      'gpu.panel.ncNote': 'SheetSage2 uses CC-BY-NC weights — results are for personal/educational use only, no commercial use',
      'gpu.panel.disabled': 'The GPU service is switched off on aixman — on-device analysis will be used instead',
      'gpu.panel.unreachable': 'Cannot reach the GPU server right now — you can submit, but it may fail',
      'gpu.panel.notConfigured': 'GPU mode is not connected yet — configure it in the admin panel',
      'gpu.panel.loadFail': 'Could not load GPU mode status',
      'gpu.panel.retry': 'Retry',
      'gpu.panel.jobsLink': 'All GPU jobs',
      'gpu.chip': 'GPU jobs',
      'gpu.chip.active': '{n} running',
      'gpu.chip.new': '{n} new',
      'gpu.job.title': 'Server AI job (GPU)',
      'gpu.job.uploading': 'Uploading audio… {pct}%',
      'gpu.status.uploading': 'Uploading',
      'gpu.status.queued': 'Waiting for a GPU',
      'gpu.status.starting': 'Starting a GPU machine',
      'gpu.status.rendering': 'Transcribing',
      'gpu.status.completed': 'Done',
      'gpu.status.failed': 'Failed',
      'gpu.status.cancelled': 'Cancelled',
      'gpu.job.queue': 'Queue #{n}',
      'gpu.job.eta': 'About {eta} left',
      'gpu.job.elapsed': '{t} elapsed',
      'gpu.job.bootNote': 'The first job may take several minutes while a GPU machine boots',
      'gpu.job.bgNote': 'You can leave this page — the job keeps running in the background',
      'gpu.job.uploadNote': 'Keep this page open until the upload finishes',
      'gpu.job.cancel': 'Cancel job',
      'gpu.job.cancelConfirm': 'Cancel this job? (only queued jobs can be cancelled)',
      'gpu.job.cancelUploadConfirm': 'Stop uploading this file?',
      'gpu.job.cancelled': 'Job cancelled',
      'gpu.job.uploadCancelled': 'Upload stopped',
      'gpu.job.notCancellable': 'The job has already started and cannot be cancelled — the result is on its way',
      'gpu.job.openSong': 'Open song',
      'gpu.job.allJobs': 'All jobs',
      'gpu.job.newJob': 'New transcription',
      'gpu.job.retryPoll': 'Check again',
      'gpu.job.makeSong': 'Create song from result',
      'gpu.job.reconnecting': 'Connection hiccup — retrying…',
      'gpu.job.pollStopped': 'Status checks paused (cannot connect)',
      'gpu.job.notFound': 'Job not found',
      'gpu.job.needAdmin': 'Sign in as an admin to see this job’s status',
      'gpu.job.doneTitle': 'Transcription complete!',
      'gpu.job.aiNote': 'AI results are a draft — review and fix chords/lyrics on the song page',
      'gpu.done': 'Transcription complete!',
      'gpu.doneNotice': 'GPU job finished',
      'gpu.submitted': 'Sent to the GPU server',
      'gpu.viewJob': 'View job',
      'gpu.adminLogin': 'Admin sign-in',
      'gpu.close': 'Close',
      'gpu.jobs.empty': 'No GPU jobs yet',
      'gpu.jobs.emptyDesc': 'Turn on GPU mode on the transcribe page and upload an audio file — jobs show up here',
      'gpu.jobs.refresh': 'Refresh',
      'gpu.jobs.remove': 'Remove from list',
      'gpu.jobs.removeConfirm': 'Remove this job from the list on this device? (songs already created stay in your library)',
      'gpu.jobs.syncFail': 'Could not load the server list — showing jobs on this device only',
      'gpu.err.auth': 'Admin session expired or not signed in — sign in again at /admin/',
      'gpu.err.network': 'Cannot reach the server — check your connection and retry',
      'gpu.err.timeout': 'The server took too long — please retry',
      'gpu.err.tooLarge': 'The file is larger than the server accepts',
      'gpu.err.fileTooBig': 'File exceeds {mb} MB — convert it to mp3 and retry',
      'gpu.err.badFile': 'This is not a supported audio file (mp3, wav, flac, ogg, m4a)',
      'gpu.err.dailyLimit': 'Today’s GPU job quota is used up — try again tomorrow',
      'gpu.err.activeLimit': 'Too many GPU jobs running — wait for one to finish',
      'gpu.err.disabled': 'The GPU service is temporarily off',
      'gpu.err.notConfigured': 'The GPU connection is not configured',
      'gpu.err.mode': 'This model is not enabled',
      'gpu.err.badInput': 'The request was invalid',
      'gpu.err.notFound': 'The job was not found on the server (it may have expired)',
      'gpu.err.badResponse': 'The server sent an unexpected response',
      'gpu.err.badResult': 'Could not read the server result — the song was not created',
      'gpu.err.noResult': 'The job finished but its result is not available yet — check again later',
      'gpu.err.quota': 'Device storage is full — delete or export old songs, then tap "Create song from result"',
      'gpu.err.rate': 'Too many requests — wait a moment and retry',
      'gpu.err.notCancellable': 'The job has already started and cannot be cancelled',
      'gpu.err.jobFailed': 'The job failed on the server',
      'gpu.err.generic': 'Something went wrong, please retry',
      'gpu.eta.sec': '{n} sec',
      'gpu.eta.min': '{n} min',
    },
  });
  const t = (k) => I18N.t(k);
  const tf = (k, vars) => t(k).replace(/\{(\w+)\}/g, (m, n) => (vars && vars[n] != null ? String(vars[n]) : m));
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- storage (ทุกการอ่าน/เขียนห่อ try — private mode/quota ต้องไม่พังแอป) ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function token() { const v = lsGet(LS_TOKEN) || ''; return TOKEN_RE.test(v) ? v : ''; }
  // คำใบ้เท่านั้น — ใครก็ตั้ง localStorage เองได้ เซิร์ฟเวอร์ต้องตรวจ require_admin() ทุก request
  function isAdmin() { return !!token(); }

  const pref = {
    read() {
      let p = {};
      try { p = JSON.parse(lsGet(LS_PREF) || '{}') || {}; } catch (e) { p = {}; }
      return {
        on: typeof p.on === 'boolean' ? p.on : true, // แอดมินเปิดไว้เป็นค่าเริ่มต้น
        mode: MODES.indexOf(p.mode) >= 0 ? p.mode : null,
        lang: LANGS.indexOf(p.lang) >= 0 ? p.lang : 'th',
      };
    },
    write(patch) { lsSet(LS_PREF, JSON.stringify(Object.assign(pref.read(), patch))); },
  };

  function safeMsg(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/https?:\/\/\S+/gi, '')
      .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/])+[\w.-]*/g, '')
      .replace(CTRL, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
  }
  function str(v, n) { return typeof v === 'string' ? v.replace(CTRL, '').trim().slice(0, n) : ''; }
  function numIn(v, lo, hi) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : null; }
  function tsOf(v) {
    if (typeof v === 'number' && isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
    if (typeof v === 'string' && v) { const p = Date.parse(v); if (!isNaN(p)) return p; }
    return null;
  }
  function prettyTitle(name) {
    return String(name || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_+/g, ' ')
      .replace(CTRL, '').replace(/\s{2,}/g, ' ').trim().slice(0, 200) || 'Untitled';
  }

  /* ---------------- errors ---------------- */
  function gpuErr(code, status, message) { const e = new Error(message || code); e.code = code; e.status = status || 0; return e; }
  const ERR_MAP = {
    AUTH: 'gpu.err.auth', UNAUTHORIZED: 'gpu.err.auth', NETWORK: 'gpu.err.network', TIMEOUT: 'gpu.err.timeout',
    TOO_LARGE: 'gpu.err.tooLarge', DAILY_LIMIT: 'gpu.err.dailyLimit', ACTIVE_LIMIT: 'gpu.err.activeLimit',
    DISABLED: 'gpu.err.disabled', PAUSED: 'gpu.err.disabled', NOT_CONFIGURED: 'gpu.err.notConfigured',
    MODE_NOT_ALLOWED: 'gpu.err.mode', BAD_INPUT: 'gpu.err.badInput', BAD_FILE: 'gpu.err.badFile',
    BAD_AUDIO: 'gpu.err.badFile', NOT_FOUND: 'gpu.err.notFound', BAD_RESPONSE: 'gpu.err.badResponse',
    RATE_LIMITED: 'gpu.err.rate', NOT_CANCELLABLE: 'gpu.err.notCancellable', CONFLICT: 'gpu.err.notCancellable',
  };
  function errMsg(err) {
    const c = err && err.code;
    if (c && ERR_MAP[c]) return t(ERR_MAP[c]);
    const st = err && err.status;
    if (st === 413) return t('gpu.err.tooLarge');
    if (st === 429) return t('gpu.err.rate');
    if (st === 503) return t('gpu.err.disabled');
    if (st === 409) return t('gpu.err.notCancellable');
    if (st === 404) return t('gpu.err.notFound');
    return safeMsg(err && err.message !== c ? err.message : '') || t('gpu.err.generic');
  }

  /* ---------------- events ---------------- */
  const listeners = new Set();
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(type, entry, extra) {
    listeners.forEach((fn) => { try { fn(type, entry, extra); } catch (e) { /* listener พังต้องไม่หยุดตัวอื่น */ } });
  }

  /* ---------------- API ---------------- */
  let authNoticeShown = false;
  function onUnauthorized() {
    lsDel(LS_TOKEN);
    cfg.cache = null;
    stopAll();
    emit('auth', null);
    if (!authNoticeShown) {
      authNoticeShown = true;
      notice({ icon: '🔒', text: t('gpu.err.auth'), href: '/admin/', linkText: t('gpu.adminLogin'), sticky: true });
    }
  }

  async function api(path, opts) {
    opts = opts || {};
    const tok = token();
    if (!tok) throw gpuErr('AUTH', 401);
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + tok };
    let body = opts.body;
    if (body && !(typeof FormData !== 'undefined' && body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 20000);
    let res, data = null;
    try {
      res = await fetch(API + path, {
        method: opts.method || 'GET', headers, body, cache: 'no-store',
        credentials: 'same-origin', redirect: 'error', signal: ctl.signal,
      });
      try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
      throw gpuErr(ctl.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    } finally { clearTimeout(timer); }
    if (res.status === 401) { onUnauthorized(); throw gpuErr('AUTH', 401); }
    if (!res.ok) {
      const er = data && data.error;
      const code = er && typeof er.code === 'string' ? er.code.slice(0, 40) : 'HTTP_' + res.status;
      throw gpuErr(code, res.status, er && typeof er.message === 'string' ? er.message : '');
    }
    if (!data || typeof data !== 'object') throw gpuErr('BAD_RESPONSE', res.status);
    return data;
  }

  const cfg = { cache: null, at: 0, promise: null };
  function normConfig(d) {
    const remote = d && d.remote && typeof d.remote === 'object' ? d.remote : null;
    const lim = remote && remote.limits && typeof remote.limits === 'object' ? remote.limits : {};
    const n = (x, def, lo, hi) => (numIn(x, lo, hi) == null ? def : x);
    const dm = MODES.indexOf(d.defaultMode) >= 0 ? d.defaultMode : (remote && MODES.indexOf(remote.defaultMode) >= 0 ? remote.defaultMode : 'open');
    return {
      configured: d.configured === true,
      defaultMode: dm,
      remoteOk: !!remote,
      enabled: remote ? remote.enabled !== false : null,
      allowSheetSage2: !!(remote && remote.allowSheetSage2 === true),
      // PHP รับได้ ≤ 64 MB (upload_max_filesize) — เอาค่าที่น้อยกว่า
      maxAudioMb: Math.min(64, n(lim.maxAudioMb, 40, 1, 1000)),
      maxSeconds: n(lim.maxSeconds, 600, 10, 7200),
    };
  }
  function getConfig(force) {
    if (!isAdmin()) return Promise.resolve(null);
    if (!force && cfg.cache && Date.now() - cfg.at < 60000) return Promise.resolve(cfg.cache);
    if (cfg.promise) return cfg.promise;
    cfg.promise = api('/gpu/config', { timeoutMs: 12000 })
      .then((d) => { cfg.cache = normConfig(d); cfg.at = Date.now(); return cfg.cache; })
      .finally(() => { cfg.promise = null; });
    return cfg.promise;
  }

  // อัปโหลดด้วย XHR — fetch ไม่มี upload progress (ไฟล์ 40 MB บนมือถือต้องเห็นความคืบหน้า)
  function submit(p, hooks) {
    hooks = hooks || {};
    return new Promise((resolve, reject) => {
      const tok = token();
      if (!tok) { reject(gpuErr('AUTH', 401)); return; }
      const fd = new FormData();
      fd.append('file', p.file, prettyTitle(p.file.name).slice(0, 120) + (String(p.file.name).match(AUDIO_EXT) || [''])[0]);
      fd.append('mode', MODES.indexOf(p.mode) >= 0 ? p.mode : 'open');
      fd.append('language', LANGS.indexOf(p.language) >= 0 ? p.language : 'th');
      if (p.lyrics) fd.append('lyrics', String(p.lyrics).slice(0, MAX_LYRICS));
      if (p.title) fd.append('title', String(p.title).slice(0, 200));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/gpu/jobs');
      xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.timeout = 15 * 60 * 1000;
      if (xhr.upload && hooks.onProgress) {
        xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) hooks.onProgress(e.loaded / e.total); };
      }
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        if (xhr.status === 401) { onUnauthorized(); reject(gpuErr('AUTH', 401)); return; }
        if (xhr.status < 200 || xhr.status >= 300) {
          const er = data && data.error;
          reject(gpuErr(er && typeof er.code === 'string' ? er.code.slice(0, 40) : 'HTTP_' + xhr.status, xhr.status,
            er && typeof er.message === 'string' ? er.message : ''));
          return;
        }
        const job = normJob(data && (data.job || data));
        if (!job) { reject(gpuErr('BAD_RESPONSE', xhr.status)); return; }
        resolve(job);
      };
      xhr.onerror = () => reject(gpuErr('NETWORK'));
      xhr.ontimeout = () => reject(gpuErr('TIMEOUT'));
      xhr.onabort = () => reject(gpuErr('ABORTED'));
      if (hooks.signal) {
        if (hooks.signal.aborted) { reject(gpuErr('ABORTED')); return; }
        hooks.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(fd);
    });
  }

  async function cancel(id) {
    if (!ID_RE.test(id)) throw gpuErr('BAD_INPUT', 400);
    const data = await api('/gpu/jobs/' + encodeURIComponent(id), { method: 'DELETE', timeoutMs: 15000 });
    const job = normJob(data.job || data);
    if (job) mergeRemote(id, job);
    else { const e = get(id); if (e) { e.status = 'cancelled'; e.updatedAt = Date.now(); save(); emit('update', e); } }
    stopPolling(id);
    return get(id);
  }

  /* ---------------- รายการงานในเครื่อง (localStorage — ไม่เชื่อข้อมูล) ---------------- */
  function sanitizeEntry(x) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ID_RE.test(x.id)) return null;
    const now = Date.now();
    return {
      id: x.id,
      title: str(x.title, 200),
      fileName: str(x.fileName, 200),
      mode: MODES.indexOf(x.mode) >= 0 ? x.mode : 'open',
      language: LANGS.indexOf(x.language) >= 0 ? x.language : 'th',
      status: STATUSES.indexOf(x.status) >= 0 ? x.status : 'queued',
      stageLabel: str(x.stageLabel, 120),
      progress: numIn(x.progress, 0, 1),
      etaSeconds: numIn(x.etaSeconds, 0, 7 * 86400),
      etaLabel: str(x.etaLabel, 60),
      queuePosition: numIn(x.queuePosition, 0, 1e5),
      gpuSeconds: numIn(x.gpuSeconds, 0, 1e6),
      createdAt: numIn(x.createdAt, 1, 1e14) || now,
      updatedAt: numIn(x.updatedAt, 1, 1e14) || now,
      songId: typeof x.songId === 'string' && ID_RE.test(x.songId) ? x.songId : null,
      error: str(x.error, 300),
      errorKey: ERR_KEYS.indexOf(x.errorKey) >= 0 ? x.errorKey : '',
      unseen: x.unseen === true,
    };
  }
  function load() {
    let raw;
    try { raw = JSON.parse(lsGet(LS_JOBS) || '[]'); } catch (e) { raw = []; }
    if (!Array.isArray(raw)) raw = [];
    const out = [], seen = new Set();
    for (const x of raw.slice(0, MAX_JOBS * 2)) {
      const e = sanitizeEntry(x);
      if (e && !seen.has(e.id)) { seen.add(e.id); out.push(e); }
    }
    return out;
  }
  let jobs = load();
  function save() {
    // เพดาน: เก็บงานที่ยังไม่จบทั้งหมด + งานจบล่าสุดจนครบ MAX_JOBS
    const active = jobs.filter((e) => !TERMINAL.has(e.status));
    const done = jobs.filter((e) => TERMINAL.has(e.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    jobs = active.concat(done).slice(0, Math.max(MAX_JOBS, active.length));
    jobs.sort((a, b) => b.createdAt - a.createdAt);
    lsSet(LS_JOBS, JSON.stringify(jobs));
  }
  function list() { return jobs.slice(); }
  function get(id) { return jobs.find((e) => e.id === id) || null; }
  function isActive(e) { return !!e && !TERMINAL.has(e.status); }

  // job จากเซิร์ฟเวอร์ (camelCase ตาม partner API หรือ snake_case ตามคอลัมน์ gpu_jobs — รับทั้งคู่)
  function normJob(j) {
    if (!j || typeof j !== 'object') return null;
    const pick = (a, b) => (j[a] !== undefined && j[a] !== null ? j[a] : j[b]);
    if (typeof j.id !== 'string' || !ID_RE.test(j.id)) return null;
    let progress = pick('progress', 'progress');
    if (typeof progress === 'number' && progress > 1 && progress <= 100) progress /= 100;
    const status = STATUSES.indexOf(j.status) >= 0 ? j.status : null;
    return {
      id: j.id,
      status,
      stageLabel: str(pick('stageLabel', 'stage_label'), 120),
      progress: numIn(progress, 0, 1),
      etaSeconds: numIn(pick('etaSeconds', 'eta_seconds'), 0, 7 * 86400),
      etaLabel: str(pick('etaLabel', 'eta_label'), 60),
      queuePosition: numIn(pick('queuePosition', 'queue_position'), 0, 1e5),
      gpuSeconds: numIn(pick('gpuSeconds', 'gpu_seconds'), 0, 1e6),
      mode: MODES.indexOf(j.mode) >= 0 ? j.mode : null,
      title: str(j.title, 200),
      fileName: str(pick('fileName', 'file_name'), 200),
      error: safeMsg(str(pick('errorMessage', 'error_message') || j.error, 300)),
      createdAt: tsOf(pick('createdAt', 'created_at')),
    };
  }

  function mergeRemote(id, job, extra) {
    let e = get(id);
    const now = Date.now();
    if (!e) {
      e = sanitizeEntry(Object.assign({ id, createdAt: job.createdAt || now }, extra || {}));
      if (!e) return null;
      jobs.push(e);
    }
    if (job.status) {
      // งานที่สร้างเพลงแล้วไม่ถอยสถานะ (กันเซิร์ฟเวอร์ตอบค้างจาก cache)
      if (!(e.status === 'completed' && e.songId)) e.status = job.status;
    }
    ['stageLabel', 'etaLabel'].forEach((k) => { e[k] = job[k] || ''; });
    ['progress', 'etaSeconds', 'queuePosition', 'gpuSeconds'].forEach((k) => { e[k] = job[k]; });
    if (job.mode) e.mode = job.mode;
    if (job.title && !e.title) e.title = job.title;
    if (job.fileName && !e.fileName) e.fileName = job.fileName;
    if (job.status === 'failed' || job.status === 'cancelled') e.error = job.error || e.error;
    else if (job.status) { e.error = ''; if (e.errorKey !== 'quota' && e.errorKey !== 'badResult') e.errorKey = ''; }
    e.updatedAt = now;
    save();
    emit('update', e);
    return e;
  }

  function remove(id) {
    const e = get(id);
    if (!e || isActive(e)) return false;
    stopPolling(id);
    jobs = jobs.filter((x) => x.id !== id);
    save();
    emit('remove', e);
    return true;
  }
  function markSeen(id) {
    const e = get(id);
    if (e && e.unseen) { e.unseen = false; save(); emit('update', e); }
  }
  function setError(id, key, status) {
    const e = get(id);
    if (!e) return;
    e.errorKey = key;
    if (status) e.status = status;
    e.updatedAt = Date.now();
    save();
    emit('update', e);
  }

  /* ---------------- poller ---------------- */
  // 1.5 วิ ตอนรอคิว/เปิดเครื่อง (นานเกิน 1 นาทีค่อยขยายเป็น 3 วิ) → 3–5 วิ ตอนกำลังถอด
  // หยุดเมื่อแท็บถูกซ่อน, เชื่อมต่อพังถอยแบบ exponential, 401 หยุดทั้งหมด
  const pollers = new Map();
  const pollState = new Map(); // id → 'retrying' | 'stopped' (สถานะชั่วคราว ไม่เก็บลงเครื่อง)

  function startPolling(id, opts) {
    if (!isAdmin() || !ID_RE.test(id)) return;
    const e = get(id);
    if (!e) return;
    const force = opts && opts.force;
    if (TERMINAL.has(e.status) && !force && !(e.status === 'completed' && !e.songId && !e.errorKey)) return;
    pollState.delete(id);
    let p = pollers.get(id);
    if (p) { schedule(p, 0); return; }
    p = { id, timer: 0, delay: 1500, errors: 0, busy: false, noResult: 0, statusSince: Date.now(), lastStatus: e.status, lastProgress: e.progress, paused: false };
    pollers.set(id, p);
    schedule(p, 0);
    emit('update', e);
  }
  function schedule(p, ms) {
    clearTimeout(p.timer);
    p.timer = 0;
    if (!pollers.has(p.id)) return;
    if (typeof document !== 'undefined' && document.hidden) { p.paused = true; return; }
    p.paused = false;
    p.timer = setTimeout(() => tick(p), ms);
  }
  function stopPolling(id) {
    const p = pollers.get(id);
    if (p) { clearTimeout(p.timer); pollers.delete(id); }
  }
  function stopAll() { Array.from(pollers.keys()).forEach(stopPolling); }
  function isPolling(id) { return pollers.has(id); }

  async function tick(p) {
    if (p.busy || !pollers.has(p.id)) return;
    if (typeof document !== 'undefined' && document.hidden) { p.paused = true; return; }
    p.busy = true;
    try {
      const data = await api('/gpu/jobs/' + encodeURIComponent(p.id), { timeoutMs: 20000 });
      if (!pollers.has(p.id)) return; // ถูกหยุดระหว่างรอ
      p.errors = 0;
      if (pollState.get(p.id)) { pollState.delete(p.id); }
      const job = normJob(data.job || data);
      if (!job || job.id !== p.id) throw gpuErr('BAD_RESPONSE');
      const e = mergeRemote(p.id, job);
      if (!e) { stopPolling(p.id); return; }
      if (job.status === 'completed') {
        const result = parseResult(data.result);
        if (result !== null) { stopPolling(p.id); await finalize(p.id, result); return; }
        // เซิร์ฟเวอร์อาจยังดึงผลจาก R2 ไม่เสร็จ — ลองอีกสักพัก
        if (++p.noResult > 10) { stopPolling(p.id); setError(p.id, 'noResult'); return; }
        schedule(p, 3000);
        return;
      }
      if (TERMINAL.has(job.status)) { stopPolling(p.id); emit('update', e); return; }
      if (job.status !== p.lastStatus) { p.lastStatus = job.status; p.statusSince = Date.now(); p.delay = 0; }
      if (job.status === 'queued' || job.status === 'starting') {
        p.delay = Date.now() - p.statusSince > 60000 ? 3000 : 1500;
      } else {
        const changed = job.progress !== p.lastProgress;
        p.delay = changed || p.delay < 3000 ? 3000 : Math.min(5000, p.delay + 500);
      }
      p.lastProgress = job.progress;
      schedule(p, p.delay);
    } catch (err) {
      if (!pollers.has(p.id)) return;
      if (err.code === 'AUTH') { stopPolling(p.id); return; }
      if (err.status === 404) { stopPolling(p.id); setError(p.id, 'notFound', 'failed'); return; }
      p.errors++;
      if (p.errors >= 12) {
        stopPolling(p.id);
        pollState.set(p.id, 'stopped');
      } else {
        pollState.set(p.id, 'retrying');
        schedule(p, Math.min(30000, 2000 * Math.pow(2, Math.min(p.errors, 4))));
      }
      emit('update', get(p.id));
    } finally { p.busy = false; }
  }

  function parseResult(r) {
    if (r == null) return null;
    if (typeof r === 'string') {
      if (r.length > 6 * 1024 * 1024) return null;
      try { return JSON.parse(r); } catch (e) { return {}; } // {} → toSongDoc โยน format → badResult
    }
    return typeof r === 'object' ? r : null;
  }

  /* ---------------- งานเสร็จ → SongDoc (ครั้งเดียวต่องาน แม้เปิดหลายแท็บ) ---------------- */
  async function finalize(id, result) {
    const run = async () => {
      jobs = load(); // อ่านสดจาก storage — อีกแท็บอาจสร้างเพลงไปแล้ว
      const e = get(id);
      if (!e) return; // ผู้ใช้ลบออกจากรายการระหว่างรอ
      if (e.songId && Store.get(e.songId)) { e.status = 'completed'; save(); emit('done', e, { created: false }); return; }
      const dup = Store.all().find((s) => s && s.analysis && s.analysis.jobId === id);
      if (dup) { e.songId = dup.id; e.status = 'completed'; save(); emit('done', e, { created: false }); return; }
      let doc;
      try { doc = Transcription.toSongDoc(result, { title: e.title, fileName: e.fileName }); }
      catch (err) { setError(id, 'badResult', 'completed'); return; }
      doc.analysis.jobId = id;
      try { Store.upsert(doc); }
      catch (err) { setError(id, 'quota', 'completed'); return; }
      e.songId = doc.id;
      e.status = 'completed';
      e.errorKey = '';
      e.error = '';
      e.unseen = true;
      e.updatedAt = Date.now();
      save();
      emit('done', e, { created: true });
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
        await navigator.locks.request('aq-gpu-finalize-' + id, run);
      } else await run();
    } catch (err) { setError(id, 'badResult', 'completed'); }
  }

  /* ---------------- UI: ตัวช่วย ---------------- */
  function toast(msg) {
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2800);
  }

  // การแจ้งเตือนในแอป (ค้างจนกดปิด/หมดเวลา) — ใช้ตอนงานเสร็จขณะผู้ใช้อยู่หน้าอื่น
  function notice(o) {
    let root = document.getElementById('gpuNotices');
    if (!root) {
      root = document.createElement('div');
      root.id = 'gpuNotices';
      root.className = 'gpu-notices';
      root.setAttribute('aria-live', 'polite');
      document.body.appendChild(root);
    }
    while (root.children.length >= 3) root.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'gpu-notice';
    el.innerHTML = `<span class="gpu-notice-ic">${esc(o.icon || '🚀')}</span>
      <span class="gpu-notice-text">${esc(o.text)}</span>
      ${o.href ? `<a class="btn btn-sm gpu-notice-go" href="${esc(o.href)}">${esc(o.linkText || t('gpu.viewJob'))}</a>` : ''}
      <button class="gpu-notice-x" type="button" aria-label="${esc(t('gpu.close'))}">×</button>`;
    const close = () => { clearTimeout(timer); el.remove(); };
    el.querySelector('.gpu-notice-x').addEventListener('click', close);
    const go = el.querySelector('.gpu-notice-go');
    if (go) go.addEventListener('click', () => { if (o.onClick) o.onClick(); close(); });
    const timer = o.sticky ? 0 : setTimeout(close, 15000);
    root.appendChild(el);
    return close;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  function fmtEta(e) {
    if (e.etaLabel) return e.etaLabel;
    if (e.etaSeconds == null) return '';
    return e.etaSeconds < 90 ? tf('gpu.eta.sec', { n: Math.max(5, Math.round(e.etaSeconds / 5) * 5) })
      : tf('gpu.eta.min', { n: Math.round(e.etaSeconds / 60) });
  }
  function fmtDate(ms) {
    try {
      return new Date(ms).toLocaleString(I18N.get() === 'th' ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function stageText(e) {
    if (e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled') return t('gpu.status.' + e.status);
    return e.stageLabel || t('gpu.status.' + e.status);
  }
  function errorText(e) {
    if (e.errorKey) return t('gpu.err.' + e.errorKey);
    if (e.status === 'failed') return e.error || t('gpu.err.jobFailed');
    return '';
  }
  function songOf(e) { return e && e.songId && typeof Store !== 'undefined' ? Store.get(e.songId) : null; }

  /* ---------------- UI: แผงหน้าแกะเพลง ---------------- */
  let lyricsDraft = ''; // จำไว้ในหน่วยความจำ (เปลี่ยนภาษา/รีเรนเดอร์หน้าแรกแล้วไม่หาย)
  let panelCfg = null;

  function slotHTML() { return isAdmin() ? '<div id="gpuIngest" class="gpu-slot"></div>' : ''; }

  function chipInner() {
    const act = jobs.filter(isActive).length;
    const fresh = jobs.filter((e) => e.unseen && e.songId).length;
    if (!act && !fresh) return '';
    const parts = [];
    if (act) parts.push(tf('gpu.chip.active', { n: act }));
    if (fresh) parts.push(tf('gpu.chip.new', { n: fresh }));
    return `<a class="chip gpu-chip${fresh ? ' has-new' : ''}" href="#/jobs">${act ? '<span class="gpu-dot"></span>' : '✅'} ${esc(t('gpu.chip'))} · ${esc(parts.join(' · '))}</a>`;
  }
  function chipHTML() { return isAdmin() || jobs.length ? `<div id="gpuChipSlot" class="gpu-chip-slot">${chipInner()}</div>` : ''; }
  function refreshChip() {
    const slot = document.getElementById('gpuChipSlot');
    if (slot) slot.innerHTML = chipInner();
  }

  async function mountIngest(view) {
    const slot = view.querySelector('#gpuIngest');
    if (!slot || !isAdmin()) return;
    let c;
    try { c = await getConfig(); }
    catch (err) {
      if (!slot.isConnected) return;
      if (err.code === 'AUTH') { slot.innerHTML = ''; return; }
      slot.innerHTML = `<div class="gpu-mini muted">🚀 ${esc(t('gpu.panel.loadFail'))} · <button type="button" class="gpu-link" id="gpuCfgRetry">${esc(t('gpu.panel.retry'))}</button></div>`;
      slot.querySelector('#gpuCfgRetry').addEventListener('click', () => { slot.innerHTML = ''; getConfig(true).catch(() => {}).then(() => mountIngest(view)); });
      return;
    }
    if (!slot.isConnected || !c) return;
    panelCfg = c;
    if (!c.configured) {
      slot.innerHTML = `<div class="gpu-mini muted">🚀 ${esc(t('gpu.panel.notConfigured'))} · <a class="gpu-link" href="/admin/">${esc(t('gpu.adminLogin'))}</a></div>`;
      return;
    }
    const p = pref.read();
    const usable = c.enabled !== false;
    let mode = p.mode || c.defaultMode;
    if (mode === 'sheetsage2' && !c.allowSheetSage2) mode = 'open';
    const on = usable && p.on;
    const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    slot.innerHTML = `
      <div class="gpu-box" id="gpuBox">
        <label class="lyr-toggle">
          <input type="checkbox" id="gpuOn" ${on ? 'checked' : ''} ${usable ? '' : 'disabled'} />
          <span>🚀 ${esc(t('gpu.panel.title'))}</span>
          <span class="chip chip-admin">Admin</span>
        </label>
        ${!usable ? `<div class="gpu-warn">${esc(t('gpu.panel.disabled'))}</div>` : ''}
        ${usable && !c.remoteOk ? `<div class="gpu-warn">${esc(t('gpu.panel.unreachable'))}</div>` : ''}
        <div class="gpu-opts" id="gpuOpts" ${on ? '' : 'hidden'}>
          <div class="lyr-opts">
            <label>${esc(t('gpu.panel.mode'))}
              <select id="gpuMode">
                ${opt('open', t('gpu.mode.open'), mode)}
                ${c.allowSheetSage2 ? opt('sheetsage2', t('gpu.mode.sheetsage2'), mode) : ''}
              </select>
            </label>
            <label>${esc(t('gpu.panel.lang'))}
              <select id="gpuLang">
                ${opt('th', t('gpu.lang.th'), p.lang)}
                ${opt('en', t('gpu.lang.en'), p.lang)}
                ${opt('auto', t('gpu.lang.auto'), p.lang)}
              </select>
            </label>
          </div>
          <div class="gpu-nc" id="gpuNc" ${mode === 'sheetsage2' ? '' : 'hidden'}>⚠ ${esc(t('gpu.panel.ncNote'))}</div>
          <label class="gpu-lyrics-label" for="gpuLyrics">${esc(t('gpu.panel.lyrics'))}</label>
          <textarea id="gpuLyrics" class="gpu-lyrics" rows="4" maxlength="${MAX_LYRICS}" spellcheck="false"
            placeholder="${esc(t('gpu.panel.lyricsPh'))}">${esc(lyricsDraft)}</textarea>
          <div class="muted gpu-hint">${esc(tf('gpu.panel.hint', { mb: c.maxAudioMb, min: Math.round(c.maxSeconds / 60) }))}
            · <a class="gpu-link" href="#/jobs">${esc(t('gpu.panel.jobsLink'))}</a></div>
        </div>
      </div>`;
    const onEl = slot.querySelector('#gpuOn');
    const opts = slot.querySelector('#gpuOpts');
    onEl.addEventListener('change', () => { pref.write({ on: onEl.checked }); opts.hidden = !onEl.checked; syncLyrBox(view); });
    slot.querySelector('#gpuMode').addEventListener('change', (e) => {
      pref.write({ mode: e.target.value });
      slot.querySelector('#gpuNc').hidden = e.target.value !== 'sheetsage2';
    });
    slot.querySelector('#gpuLang').addEventListener('change', (e) => pref.write({ lang: e.target.value }));
    slot.querySelector('#gpuLyrics').addEventListener('input', (e) => { lyricsDraft = e.target.value.slice(0, MAX_LYRICS); });
    // ตัวเลือกถอดเนื้อในเครื่องไม่มีผลกับงาน GPU → ซ่อนตอนแท็บ "อัปโหลดไฟล์" + เปิด GPU
    view.querySelectorAll('.ingest-tab').forEach((b) => b.addEventListener('click', () => syncLyrBox(view)));
    syncLyrBox(view);
  }

  function fileTabActive(view) {
    const f = view.querySelector('#ingestFile');
    return !!f && !f.hidden;
  }
  function gpuOn(view) {
    const el = view.querySelector('#gpuOn');
    return !!el && el.checked && !el.disabled && !!panelCfg && panelCfg.configured && panelCfg.enabled !== false;
  }
  function syncLyrBox(view) {
    const box = view.querySelector('.lyr-box');
    if (box) box.hidden = gpuOn(view) && fileTabActive(view);
  }

  // app.js เรียกตอนกดเริ่ม (โหมดไฟล์) — null = ใช้เอนจินในเครื่องตามเดิม
  function ingestOptions() {
    const view = document.getElementById('view');
    if (!view || !isAdmin() || !gpuOn(view)) return null;
    const mode = view.querySelector('#gpuMode');
    const lang = view.querySelector('#gpuLang');
    const lyr = view.querySelector('#gpuLyrics');
    return {
      mode: mode && MODES.indexOf(mode.value) >= 0 ? mode.value : 'open',
      language: lang && LANGS.indexOf(lang.value) >= 0 ? lang.value : 'th',
      lyrics: lyr ? lyr.value.replace(CTRL, '').trim().slice(0, MAX_LYRICS) : '',
    };
  }

  /* ---------------- UI: อัปโหลด → หน้า job ---------------- */
  let submitting = false;
  function startJob(view, input, hooks) {
    hooks = hooks || {};
    const say = hooks.toast || toast;
    if (submitting) return;
    const f = input && input.file, o = input && input.gpu;
    if (!f || !o) return;
    const maxMb = panelCfg ? panelCfg.maxAudioMb : 40;
    if (f.size > maxMb * 1024 * 1024) { say(tf('gpu.err.fileTooBig', { mb: maxMb })); return; }
    if (f.size < 1024 || !(AUDIO_EXT.test(f.name) || /^audio\//.test(f.type || ''))) { say(t('gpu.err.badFile')); return; }
    submitting = true;
    const title = prettyTitle(f.name);
    const ctl = new AbortController();
    view.innerHTML = `
      <section class="card job gpu-job reveal" id="gpuUpload">
        <div class="section-title">🚀 <span>${esc(t('gpu.job.title'))}</span> <span class="chip">${esc(t('gpu.mode.' + o.mode))}</span></div>
        <div class="gpu-job-name">${esc(title)}</div>
        <div class="gpu-stage" id="gpuUpStage">${esc(tf('gpu.job.uploading', { pct: 0 }))}</div>
        <div class="progress-bar"><div class="progress-fill" id="gpuUpFill"></div></div>
        <div class="muted gpu-note">${esc(t('gpu.job.uploadNote'))}</div>
        <button class="btn-ghost btn-block" id="gpuUpCancel">${esc(t('job.cancel'))}</button>
      </section>`;
    const card = view.querySelector('#gpuUpload');
    const fill = view.querySelector('#gpuUpFill');
    const stage = view.querySelector('#gpuUpStage');
    const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    view.querySelector('#gpuUpCancel').addEventListener('click', () => {
      if (confirm(t('gpu.job.cancelUploadConfirm'))) ctl.abort();
    });
    const goHome = () => { if (hooks.route && ((location.hash || '#/') === '#/' || location.hash === '#')) hooks.route(); else location.hash = '#/'; };

    submit({ file: f, lyrics: o.lyrics, mode: o.mode, language: o.language, title }, {
      signal: ctl.signal,
      onProgress: (fr) => {
        if (!card.isConnected) return;
        const pct = Math.min(100, Math.round(fr * 100));
        fill.style.width = pct + '%';
        stage.textContent = tf('gpu.job.uploading', { pct });
      },
    }).then((job) => {
      mergeRemote(job.id, job, { title, fileName: f.name, mode: o.mode, language: o.language, status: job.status || 'queued' });
      lyricsDraft = '';
      startPolling(job.id);
      if (card.isConnected) location.hash = '#/job/' + job.id;
      else notice({ text: t('gpu.submitted') + ': ' + title, href: '#/job/' + job.id, linkText: t('gpu.viewJob') });
    }).catch((err) => {
      if (err && err.code === 'ABORTED') { say(t('gpu.job.uploadCancelled')); if (card.isConnected) goHome(); return; }
      say(errMsg(err));
      if (card.isConnected) goHome();
    }).finally(() => {
      submitting = false;
      window.removeEventListener('beforeunload', guard);
    });
  }

  /* ---------------- UI: หน้า #/job/<id> ---------------- */
  function notFoundHTML(msg) {
    return `<section class="card empty reveal"><div class="empty-emoji">🌫\uFE0F</div><h3>${esc(msg)}</h3>
      <a href="#/jobs" class="btn" style="margin-top:12px">${esc(t('gpu.job.allJobs'))}</a></section>`;
  }

  function renderJob(view, id) {
    id = String(id || '');
    if (!ID_RE.test(id)) { view.innerHTML = notFoundHTML(t('gpu.job.notFound')); return; }
    const e0 = get(id);
    if (!e0) {
      if (!isAdmin()) { view.innerHTML = notFoundHTML(t('gpu.job.needAdmin')); return; }
      // งานจากเครื่องอื่น/รายการถูกล้าง → ถามเซิร์ฟเวอร์ครั้งเดียว
      view.innerHTML = `<section class="card job reveal gpu-job" id="gpuLoading"><div class="gpu-stage">…</div></section>`;
      const holder = view.querySelector('#gpuLoading');
      api('/gpu/jobs/' + encodeURIComponent(id), { timeoutMs: 15000 }).then((d) => {
        const job = normJob(d.job || d);
        if (!holder.isConnected) return;
        if (!job || job.id !== id) { view.innerHTML = notFoundHTML(t('gpu.job.notFound')); return; }
        mergeRemote(id, job, { title: job.title, fileName: job.fileName, status: job.status || 'queued' });
        renderJob(view, id);
      }).catch((err) => {
        if (holder.isConnected) view.innerHTML = notFoundHTML(err.status === 404 ? t('gpu.job.notFound') : errMsg(err));
      });
      return;
    }
    const wasDone = !!songOf(e0);
    view.innerHTML = `
      <section class="card job gpu-job reveal" id="gpuJob">
        <div class="section-title">🚀 <span id="gpuJobHead">${esc(t('gpu.job.title'))}</span> <span class="chip" id="gpuJobMode"></span></div>
        <div class="gpu-job-name" id="gpuJobName"></div>
        <div class="gpu-stage" id="gpuJobStage"></div>
        <div class="progress-bar" id="gpuJobBar"><div class="progress-fill" id="gpuJobFill"></div></div>
        <div class="gpu-meta" id="gpuJobMeta"></div>
        <div class="gpu-err" id="gpuJobErr" hidden></div>
        <div class="muted gpu-note" id="gpuJobNotes"></div>
        <div class="sheet-actions gpu-actions" id="gpuJobActions"></div>
      </section>`;
    const card = view.querySelector('#gpuJob');
    const $ = (s) => card.querySelector(s);
    let lastActionsKey = '';

    function paint() {
      const e = get(id);
      if (!e) { view.innerHTML = notFoundHTML(t('gpu.job.notFound')); return; }
      const song = songOf(e);
      const active = isActive(e);
      $('#gpuJobHead').textContent = song ? t('gpu.job.doneTitle') : t('gpu.job.title');
      $('#gpuJobMode').textContent = t('gpu.mode.' + e.mode);
      $('#gpuJobName').textContent = e.title || e.fileName || e.id;
      $('#gpuJobStage').textContent = stageText(e);
      const bar = $('#gpuJobBar'), fill = $('#gpuJobFill');
      const indet = active && e.progress == null;
      bar.classList.toggle('indeterminate', indet);
      bar.hidden = !active && e.status !== 'completed';
      fill.style.width = e.status === 'completed' ? '100%' : (e.progress != null ? Math.round(e.progress * 100) + '%' : (indet ? '' : '0%'));
      const meta = [];
      if (e.status === 'queued' && e.queuePosition != null) meta.push(tf('gpu.job.queue', { n: e.queuePosition }));
      const eta = active ? fmtEta(e) : '';
      if (eta) meta.push(tf('gpu.job.eta', { eta }));
      if (active) meta.push('<span id="gpuElapsed"></span>');
      $('#gpuJobMeta').innerHTML = meta.map((m) => (m.charAt(0) === '<' ? m : esc(m))).join(' · ');
      updateElapsed();
      const err = errorText(e);
      const ps = pollState.get(id);
      const errEl = $('#gpuJobErr');
      const errLine = err || (ps === 'retrying' ? t('gpu.job.reconnecting') : ps === 'stopped' ? t('gpu.job.pollStopped') : '');
      errEl.hidden = !errLine;
      errEl.textContent = errLine;
      errEl.classList.toggle('soft', !err);
      const notes = [];
      if (active) {
        if (e.status === 'queued' || e.status === 'starting') notes.push(t('gpu.job.bootNote'));
        notes.push(t('gpu.job.bgNote'));
      } else if (song) notes.push(t('gpu.job.aiNote'));
      if (!isAdmin()) notes.push(t('gpu.job.needAdmin'));
      $('#gpuJobNotes').innerHTML = notes.map((n) => `<div>${esc(n)}</div>`).join('');

      const acts = [];
      if (song) acts.push(`<a class="btn btn-sm" href="#/song/${esc(song.id)}" data-seen="1">🎸 ${esc(t('gpu.job.openSong'))}</a>`);
      if (e.status === 'completed' && !song && isAdmin() && !isPolling(id)) acts.push(`<button class="btn btn-sm" data-act="retry">↻ ${esc(t('gpu.job.makeSong'))}</button>`);
      if (active && isAdmin() && ps === 'stopped') acts.push(`<button class="btn btn-sm" data-act="retry">↻ ${esc(t('gpu.job.retryPoll'))}</button>`);
      if (e.status === 'queued' && isAdmin()) acts.push(`<button class="btn-ghost btn-sm" data-act="cancel">✕ ${esc(t('gpu.job.cancel'))}</button>`);
      if (!active) acts.push(`<a class="btn-ghost btn-sm" href="#/">🎸 ${esc(t('gpu.job.newJob'))}</a>`);
      acts.push(`<a class="btn-ghost btn-sm" href="#/jobs">📋 ${esc(t('gpu.job.allJobs'))}</a>`);
      const key = acts.join('');
      if (key !== lastActionsKey) { $('#gpuJobActions').innerHTML = key; lastActionsKey = key; wireActions(); }

      // งานเพิ่งเสร็จขณะดูหน้านี้ → ไปหน้าเพลง (replace: กด back แล้วไม่วนกลับมาหน้านี้)
      if (song && !wasDone) {
        markSeen(id);
        toast(t('gpu.done'));
        location.replace('#/song/' + song.id);
      }
    }
    function updateElapsed() {
      const el = card.querySelector('#gpuElapsed');
      const e = get(id);
      if (el && e) el.textContent = tf('gpu.job.elapsed', { t: fmtClock((Date.now() - e.createdAt) / 1000) });
    }
    let busy = false;
    function wireActions() {
      card.querySelectorAll('[data-seen]').forEach((a) => a.addEventListener('click', () => markSeen(id)));
      card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
        if (busy) return;
        const act = b.dataset.act;
        if (act === 'retry') { const e = get(id); if (e) { e.errorKey = ''; save(); } startPolling(id, { force: true }); return; }
        if (act === 'cancel') {
          if (!confirm(t('gpu.job.cancelConfirm'))) return;
          busy = true; b.disabled = true;
          try { await cancel(id); toast(t('gpu.job.cancelled')); }
          catch (err) { toast(err.status === 409 ? t('gpu.job.notCancellable') : errMsg(err)); }
          finally { busy = false; if (b.isConnected) b.disabled = false; if (card.isConnected) paint(); }
        }
      }));
    }

    const off = onChange((type, e) => {
      if (!card.isConnected) { off(); clearInterval(clock); return; }
      if (type === 'auth' || type === 'sync' || !e || e.id === id) paint();
    });
    const clock = setInterval(() => {
      if (!card.isConnected) { clearInterval(clock); off(); return; }
      updateElapsed();
    }, 1000);
    paint();
    const e = get(id);
    if (e && isAdmin() && (isActive(e) || (e.status === 'completed' && !songOf(e) && !e.errorKey))) startPolling(id);
  }

  /* ---------------- UI: หน้า #/jobs ---------------- */
  let serverSyncing = false;
  async function syncServerList() {
    if (!isAdmin() || serverSyncing) return true;
    serverSyncing = true;
    try {
      const d = await api('/gpu/jobs', { timeoutMs: 15000 });
      const arr = Array.isArray(d) ? d : (Array.isArray(d.jobs) ? d.jobs : []);
      arr.slice(0, 50).forEach((j) => {
        const job = normJob(j);
        if (!job) return;
        const e = get(job.id);
        if (!e && jobs.length >= MAX_JOBS && TERMINAL.has(job.status)) return; // ไม่ดันงานในเครื่องออก
        if (e && e.status === 'completed' && e.songId) return;
        mergeRemote(job.id, job, { title: job.title, fileName: job.fileName, status: job.status || 'queued' });
        const cur = get(job.id);
        if (cur && isActive(cur)) startPolling(cur.id);
      });
      return true;
    } catch (err) { return err.code === 'AUTH' ? true : false; }
    finally { serverSyncing = false; }
  }

  function renderJobs(view) {
    view.innerHTML = `
      <section class="reveal"><div class="section-title" style="justify-content:space-between">
        <span>🚀 ${esc(t('gpu.job.title'))}</span>
        ${isAdmin() ? `<button class="btn-ghost btn-sm" id="gpuRefresh">↻ ${esc(t('gpu.jobs.refresh'))}</button>` : ''}
      </div></section>
      <div id="gpuJobsBody"></div>`;
    const body = view.querySelector('#gpuJobsBody');
    let syncFailed = false;

    function paint() {
      const items = list().sort((a, b) => b.createdAt - a.createdAt);
      const warn = !isAdmin() ? `<div class="gpu-warn">🔒 ${esc(t('gpu.job.needAdmin'))} · <a class="gpu-link" href="/admin/">${esc(t('gpu.adminLogin'))}</a></div>`
        : (syncFailed ? `<div class="gpu-warn soft">${esc(t('gpu.jobs.syncFail'))}</div>` : '');
      if (!items.length) {
        body.innerHTML = warn + `<section class="card empty reveal"><div class="empty-emoji">🛰\uFE0F</div>
          <h3>${esc(t('gpu.jobs.empty'))}</h3><p class="muted">${esc(t('gpu.jobs.emptyDesc'))}</p>
          <a href="#/" class="btn" style="margin-top:14px">🎸 ${esc(t('gpu.job.newJob'))}</a></section>`;
        return;
      }
      body.innerHTML = warn + `<section class="card gpu-list">${items.map(itemHTML).join('')}</section>`;
      body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.id;
        const act = b.dataset.act;
        if (!ID_RE.test(id || '')) return;
        if (act === 'retry') { const e = get(id); if (e) { e.errorKey = ''; save(); } startPolling(id, { force: true }); paint(); }
        else if (act === 'remove') { if (confirm(t('gpu.jobs.removeConfirm'))) { remove(id); paint(); } }
        else if (act === 'open') markSeen(id);
      }));
    }
    function itemHTML(e) {
      const song = songOf(e);
      const active = isActive(e);
      const ps = pollState.get(e.id);
      const err = errorText(e) || (ps === 'stopped' ? t('gpu.job.pollStopped') : '');
      const pct = e.status === 'completed' ? 100 : (e.progress != null ? Math.round(e.progress * 100) : null);
      const acts = [];
      if (song) acts.push(`<a class="btn btn-sm" data-act="open" data-id="${esc(e.id)}" href="#/song/${esc(song.id)}">🎸 ${esc(t('gpu.job.openSong'))}</a>`);
      if (active) acts.push(`<a class="btn-ghost btn-sm" href="#/job/${esc(e.id)}">${esc(t('gpu.viewJob'))}</a>`);
      if (isAdmin() && !isPolling(e.id) && ((e.status === 'completed' && !song) || (active && ps === 'stopped') || e.errorKey === 'notFound')) {
        acts.push(`<button class="btn-ghost btn-sm" data-act="retry" data-id="${esc(e.id)}">↻ ${esc(e.status === 'completed' ? t('gpu.job.makeSong') : t('gpu.job.retryPoll'))}</button>`);
      }
      if (!active) acts.push(`<button class="btn-ghost btn-sm gpu-x" data-act="remove" data-id="${esc(e.id)}" aria-label="${esc(t('gpu.jobs.remove'))}" title="${esc(t('gpu.jobs.remove'))}">🗑</button>`);
      return `<div class="gpu-item${e.unseen && song ? ' is-new' : ''}">
        <div class="gpu-item-main">
          <div class="gpu-item-title">${esc(e.title || e.fileName || e.id)}</div>
          <div class="gpu-item-sub">
            <span class="gpu-status s-${esc(e.status)}">${esc(stageText(e))}</span>
            <span>${esc(fmtDate(e.createdAt))}</span>
            <span>${esc(t('gpu.mode.' + e.mode))}</span>
          </div>
          ${active ? `<div class="progress-bar gpu-mini-bar${pct == null ? ' indeterminate' : ''}"><div class="progress-fill" style="width:${pct == null ? 0 : pct}%"></div></div>` : ''}
          ${err ? `<div class="gpu-item-err">${esc(err)}</div>` : ''}
        </div>
        <div class="gpu-item-actions">${acts.join('')}</div>
      </div>`;
    }

    const off = onChange(() => {
      if (!body.isConnected) { off(); return; }
      paint();
    });
    paint();
    const refresh = view.querySelector('#gpuRefresh');
    const doSync = () => syncServerList().then((ok) => { syncFailed = !ok; if (body.isConnected) paint(); });
    if (refresh) refresh.addEventListener('click', () => {
      refresh.disabled = true;
      jobs.filter(isActive).forEach((e) => startPolling(e.id));
      doSync().finally(() => { if (refresh.isConnected) refresh.disabled = false; });
    });
    if (isAdmin()) doSync();
  }

  /* ---------------- global: งานเสร็จตอนอยู่หน้าอื่น + sync ข้ามแท็บ ---------------- */
  onChange((type, e, extra) => {
    refreshChip();
    if (type !== 'done' || !e || !e.songId) return;
    if (location.hash === '#/job/' + e.id) return; // หน้า job จัดการนำทางเอง
    if (extra && extra.created) {
      notice({ icon: '✅', text: t('gpu.doneNotice') + ': ' + (e.title || e.fileName), href: '#/song/' + e.songId,
        linkText: t('gpu.job.openSong'), onClick: () => markSeen(e.id) });
    }
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (ev) => {
      if (ev.key === LS_JOBS) {
        jobs = load();
        // อีกแท็บสร้างเพลงแล้ว → หยุด poll งานนั้นที่นี่
        jobs.forEach((e) => { if (e.songId && isPolling(e.id)) stopPolling(e.id); });
        emit('sync', null);
      } else if (ev.key === LS_TOKEN) {
        cfg.cache = null;
        if (!isAdmin()) { stopAll(); emit('auth', null); } else resumeAll();
      }
    });
    window.addEventListener('hashchange', () => {
      const m = (location.hash || '').match(/^#\/song\/([A-Za-z0-9_-]{1,64})$/);
      if (!m) return;
      const e = jobs.find((x) => x.songId === m[1] && x.unseen);
      if (e) markSeen(e.id);
    });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        pollers.forEach((p) => { clearTimeout(p.timer); p.timer = 0; p.paused = true; });
      } else {
        pollers.forEach((p) => { if (p.paused) schedule(p, 0); });
      }
    });
  }

  // รีโหลดหน้าแล้ว poll งานค้างต่อ (+ งานที่เสร็จแต่ยังไม่ได้สร้างเพลง)
  function resumeAll() {
    if (!isAdmin()) return;
    jobs.forEach((e) => {
      if (isActive(e) || (e.status === 'completed' && !e.songId && !e.errorKey)) startPolling(e.id);
    });
  }
  resumeAll();

  window.GPU = {
    isAdmin, api, getConfig, submit, cancel,
    poll: (id) => startPolling(id, { force: true }), stopPolling,
    jobs: list, job: get, remove, markSeen, onChange,
    // hooks ของ app.js
    slotHTML, chipHTML, mountIngest, ingestOptions, startJob, renderJob, renderJobs,
    // ช่องสำหรับเทสต์/ดีบัก (ไม่ใช่ API สาธารณะ)
    _test: { sanitizeEntry, normJob, normConfig, load, errMsg, safeMsg },
  };
})();
