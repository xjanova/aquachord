/* AquaChord Admin SPA */
(function () {
  'use strict';
  const API = '../api';
  const $app = document.getElementById('app');
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- i18n ---------------- */
  const DICT = {
    th: {
      tag: 'หลังบ้าน',
      setupTitle: 'ตั้งค่าผู้ดูแลคนแรก', setupSub: 'สร้างบัญชีผู้ดูแลระบบเพื่อเริ่มใช้งาน', setupBadge: '✨ เริ่มต้นใช้งานครั้งแรก',
      loginTitle: 'เข้าสู่ระบบผู้ดูแล', loginSub: 'AquaChord Admin',
      username: 'ชื่อผู้ใช้', password: 'รหัสผ่าน', passwordConfirm: 'ยืนยันรหัสผ่าน',
      create: 'สร้างผู้ดูแล', login: 'เข้าสู่ระบบ', logout: 'ออกจากระบบ',
      pwMismatch: 'รหัสผ่านยืนยันไม่ตรงกัน', pwShort: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว',
      tabOverview: 'ภาพรวม', tabSongs: 'เพลง', tabAdmins: 'ผู้ดูแล', tabSettings: 'ตั้งค่า',
      stSongs: 'เพลงทั้งหมด', stPublished: 'เผยแพร่แล้ว', stAdmins: 'ผู้ดูแล',
      recent: 'อัปเดตล่าสุด', noSongs: 'ยังไม่มีเพลงในสารบัญ',
      songs: 'สารบัญเพลง', addSong: 'เพิ่มเพลง', editSong: 'แก้ไขเพลง', newSong: 'เพลงใหม่',
      title: 'ชื่อเพลง', artist: 'ศิลปิน', creator: 'ผู้แกะ', key: 'คีย์', chordpro: 'คอร์ด + เนื้อเพลง (ChordPro)',
      published: 'เผยแพร่', private: 'ส่วนตัว', save: 'บันทึก', cancel: 'ยกเลิก', del: 'ลบ',
      delSong: 'ลบเพลงนี้?', delSongDesc: 'การลบไม่สามารถย้อนกลับได้',
      admins: 'ผู้ดูแลระบบ', addAdmin: 'เพิ่มผู้ดูแล', changePw: 'เปลี่ยนรหัสผ่าน',
      curPw: 'รหัสผ่านเดิม', newPw: 'รหัสผ่านใหม่', role: 'สิทธิ์', you: 'คุณ',
      delAdmin: 'ลบผู้ดูแลคนนี้?', settings: 'ตั้งค่าเว็บไซต์',
      siteName: 'ชื่อเว็บไซต์', copyrightEmail: 'อีเมลแจ้งลิขสิทธิ์', enableUrl: 'เปิดให้แกะเพลงจากลิงก์ URL',
      annTh: 'ประกาศ (ไทย)', annEn: 'ประกาศ (อังกฤษ)', saved: 'บันทึกแล้ว', added: 'เพิ่มแล้ว', deleted: 'ลบแล้ว',
      required: 'กรุณากรอกข้อมูลให้ครบ', confirm: 'ยืนยัน', refresh: 'รีเฟรช',
      // GPU / AI เซิร์ฟเวอร์ (docs/09)
      tabGpu: 'GPU / AI', gpuTitle: 'GPU / AI เซิร์ฟเวอร์',
      gpuIntro: 'เชื่อม AquaChord กับระบบเช่า GPU ของ aixman เพื่อถอดคอร์ด เนื้อร้องไทย และทำนองด้วยโมเดลใหญ่ — เฟสนี้ใช้ได้เฉพาะผู้ดูแล ผู้ใช้ทั่วไปยังใช้เอนจินในเบราว์เซอร์ตามเดิม',
      gpuStatus: 'สถานะการเชื่อมต่อ', gpuConnected: 'เชื่อมต่อแล้ว', gpuNotConfigured: 'ยังไม่ได้เชื่อมต่อ',
      gpuUnreachable: 'เชื่อมต่อไม่ได้', gpuRemoteOff: 'aixman ปิดบริการอยู่',
      gpuServer: 'เซิร์ฟเวอร์', gpuKey: 'Partner key', gpuModel: 'โมเดล', gpuSs2Remote: 'SheetSage2 ที่ aixman',
      gpuOn: 'เปิดแล้ว', gpuOff: 'ปิดอยู่', gpuLimits: 'เพดาน', gpuFileLe: 'ไฟล์ ≤', gpuSecPerSong: 'วินาที/เพลง',
      gpuPerDay: 'งาน/วัน', gpuConcurrent: 'พร้อมกัน', gpuUsage: 'ใช้ไปวันนี้', gpuActiveNow: 'กำลังทำ',
      gpuChecked: 'ตรวจล่าสุด', gpuRecheck: 'ตรวจสถานะอีกครั้ง',
      gpuRd_ready: 'พร้อมใช้', gpuRd_tuning: 'ช่วงทดสอบ (งานแรกจะยืนยันความพร้อม)', gpuRd_broken: 'มีปัญหา', gpuRd_disabled: 'ปิดอยู่',
      gpuPairTitle: 'ตั้งค่าการเชื่อมต่อ aixman', gpuBaseUrl: 'ที่อยู่เซิร์ฟเวอร์ (Base URL)',
      gpuBaseHelp: 'อนุญาตเฉพาะ https://ai.xman4289.com เท่านั้น',
      gpuKeyPh: 'วางคีย์จากหลังบ้าน aixman › เมนู AquaChord', gpuKeyKeep: 'เว้นว่าง = ใช้คีย์เดิม ({hint})',
      gpuKeyHelp: 'คีย์เก็บไว้บนเซิร์ฟเวอร์ในโฟลเดอร์ private เท่านั้น — จะไม่แสดงเต็มอีก',
      gpuNeedKey: 'กรุณาวาง Partner key จากหลังบ้าน aixman',
      gpuDefMode: 'ชุดโมเดลเริ่มต้น', gpuModeOpen: 'Open — ไลเซนส์เปิด ใช้เชิงพาณิชย์ได้ (แนะนำ)',
      gpuModeSs2: 'SheetSage2 — CC-BY-NC ห้ามใช้เชิงพาณิชย์',
      gpuSs2Note: '⚠️ SheetSage2 ใช้น้ำหนักโมเดลสัญญาอนุญาต CC-BY-NC-4.0 — ใช้ได้เฉพาะงานที่ไม่ใช่เชิงพาณิชย์ (ทดลอง/ส่วนตัว) และต้องเปิดสิทธิ์ที่หลังบ้าน aixman ก่อน ถ้าไม่แน่ใจให้ใช้ Open',
      gpuTestSave: 'ทดสอบการเชื่อมต่อและบันทึก', gpuTesting: 'กำลังทดสอบ…', gpuSavedOk: 'เชื่อมต่อสำเร็จ บันทึกแล้ว',
      gpuSs2Confirm: 'ใช้ SheetSage2 เป็นค่าเริ่มต้น?',
      gpuSs2ConfirmDesc: 'ผลจากโหมดนี้ห้ามใช้เชิงพาณิชย์ (CC-BY-NC-4.0) และทุกงานที่ไม่ได้ระบุโหมดจะใช้ SheetSage2',
      gpuJobs: 'งาน GPU ล่าสุด', gpuNoJobs: 'ยังไม่มีงาน GPU',
      gpuSt_uploading: 'กำลังอัปโหลด', gpuSt_queued: 'รอคิว', gpuSt_starting: 'กำลังเตรียมเครื่อง', gpuSt_rendering: 'กำลังประมวลผล',
      gpuSt_completed: 'เสร็จแล้ว', gpuSt_failed: 'ล้มเหลว', gpuSt_cancelled: 'ยกเลิกแล้ว',
      gpuCancel: 'ยกเลิกงาน', gpuCancelQ: 'ยกเลิกงานนี้?', gpuCancelDesc: 'ยกเลิกได้เฉพาะงานที่ยังรอคิว — งานที่เริ่มประมวลผลแล้วจะยกเลิกไม่ได้',
      gpuKeepJob: 'ไม่ยกเลิก', gpuDownload: 'ดาวน์โหลดผล JSON', gpuNoResult: 'งานนี้ยังไม่มีผลลัพธ์',
      gpuQueuePos: 'คิวที่', gpuEta: 'อีกประมาณ', gpuBy: 'โดย', gpuSec: 'วิ', gpuMin: 'นาที',
      gpuTestJob: 'ส่งงานทดสอบ', gpuTestJobNote: 'ส่งงานจริงไปที่ GPU ของ aixman (นับโควต้ารายวัน) — ผลเป็นร่างจาก AI ต้องตรวจแก้ก่อนใช้',
      gpuFile: 'ไฟล์เสียง (MP3, WAV, FLAC, OGG, M4A)', gpuFileMax: 'ไม่เกิน {n} MB',
      gpuLyricsOpt: 'เนื้อเพลง (ถ้ามี — ช่วยให้จัดเวลาเนื้อร้องแม่นขึ้น)', gpuMode: 'ชุดโมเดล', gpuSend: 'ส่งงาน',
      gpuUploading: 'กำลังอัปโหลด {p}%', gpuForwarding: 'กำลังส่งต่อไปยัง GPU…', gpuSubmitted: 'ส่งงานแล้ว',
      gpuDeduped: 'งานนี้ถูกส่งไปแล้ว — แสดงงานเดิม', gpuNeedFile: 'กรุณาเลือกไฟล์เสียง', gpuTooBig: 'ไฟล์ใหญ่เกิน {n} MB',
      gpuNetErr: 'การเชื่อมต่อขัดข้อง — งานอาจถูกสร้างแล้ว ตรวจรายการด้านล่าง', gpuNeedPair: 'เชื่อมต่อ aixman ด้านบนก่อนจึงจะส่งงานได้',
    },
    en: {
      tag: 'Admin',
      setupTitle: 'Create first admin', setupSub: 'Set up an administrator account to begin', setupBadge: '✨ First-time setup',
      loginTitle: 'Admin sign in', loginSub: 'AquaChord Admin',
      username: 'Username', password: 'Password', passwordConfirm: 'Confirm password',
      create: 'Create admin', login: 'Sign in', logout: 'Sign out',
      pwMismatch: 'Passwords do not match', pwShort: 'Password must be at least 8 characters',
      tabOverview: 'Overview', tabSongs: 'Songs', tabAdmins: 'Admins', tabSettings: 'Settings',
      stSongs: 'Total songs', stPublished: 'Published', stAdmins: 'Admins',
      recent: 'Recently updated', noSongs: 'No songs in the catalog yet',
      songs: 'Song catalog', addSong: 'Add song', editSong: 'Edit song', newSong: 'New song',
      title: 'Title', artist: 'Artist', creator: 'Transcriber', key: 'Key', chordpro: 'Chords + lyrics (ChordPro)',
      published: 'Published', private: 'Private', save: 'Save', cancel: 'Cancel', del: 'Delete',
      delSong: 'Delete this song?', delSongDesc: 'This cannot be undone.',
      admins: 'Administrators', addAdmin: 'Add admin', changePw: 'Change password',
      curPw: 'Current password', newPw: 'New password', role: 'Role', you: 'you',
      delAdmin: 'Delete this admin?', settings: 'Site settings',
      siteName: 'Site name', copyrightEmail: 'Copyright contact email', enableUrl: 'Allow transcribing from URL links',
      annTh: 'Announcement (Thai)', annEn: 'Announcement (English)', saved: 'Saved', added: 'Added', deleted: 'Deleted',
      required: 'Please fill in all fields', confirm: 'Confirm', refresh: 'Refresh',
      tabGpu: 'GPU / AI', gpuTitle: 'GPU / AI server',
      gpuIntro: "Connect AquaChord to aixman's GPU rental to transcribe chords, Thai lyrics and melody with large models — admins only in this phase; public users keep the in-browser engine.",
      gpuStatus: 'Connection status', gpuConnected: 'Connected', gpuNotConfigured: 'Not connected',
      gpuUnreachable: 'Unreachable', gpuRemoteOff: 'Disabled at aixman',
      gpuServer: 'Server', gpuKey: 'Partner key', gpuModel: 'Model', gpuSs2Remote: 'SheetSage2 at aixman',
      gpuOn: 'Enabled', gpuOff: 'Disabled', gpuLimits: 'Limits', gpuFileLe: 'file ≤', gpuSecPerSong: 's/song',
      gpuPerDay: 'jobs/day', gpuConcurrent: 'concurrent', gpuUsage: 'Used today', gpuActiveNow: 'running',
      gpuChecked: 'Last checked', gpuRecheck: 'Check again',
      gpuRd_ready: 'Ready', gpuRd_tuning: 'Tuning (first success confirms readiness)', gpuRd_broken: 'Broken', gpuRd_disabled: 'Disabled',
      gpuPairTitle: 'aixman connection settings', gpuBaseUrl: 'Server (base URL)',
      gpuBaseHelp: 'Only https://ai.xman4289.com is allowed',
      gpuKeyPh: 'Paste the key from aixman admin › AquaChord', gpuKeyKeep: 'Leave blank to keep the current key ({hint})',
      gpuKeyHelp: 'Stored only on the server in the private folder — never shown in full again',
      gpuNeedKey: 'Please paste the partner key from aixman admin',
      gpuDefMode: 'Default model set', gpuModeOpen: 'Open — permissive licenses, commercial use OK (recommended)',
      gpuModeSs2: 'SheetSage2 — CC-BY-NC, non-commercial only',
      gpuSs2Note: '⚠️ SheetSage2 uses CC-BY-NC-4.0 model weights — non-commercial use only (experiments/personal) and it must be enabled in aixman admin first. When in doubt, use Open.',
      gpuTestSave: 'Test connection & save', gpuTesting: 'Testing…', gpuSavedOk: 'Connected and saved',
      gpuSs2Confirm: 'Use SheetSage2 by default?',
      gpuSs2ConfirmDesc: 'Results from this mode are non-commercial only (CC-BY-NC-4.0), and every job without an explicit mode will use SheetSage2.',
      gpuJobs: 'Recent GPU jobs', gpuNoJobs: 'No GPU jobs yet',
      gpuSt_uploading: 'Uploading', gpuSt_queued: 'Queued', gpuSt_starting: 'Starting machine', gpuSt_rendering: 'Processing',
      gpuSt_completed: 'Done', gpuSt_failed: 'Failed', gpuSt_cancelled: 'Cancelled',
      gpuCancel: 'Cancel job', gpuCancelQ: 'Cancel this job?', gpuCancelDesc: 'Only queued jobs can be cancelled — jobs already processing cannot.',
      gpuKeepJob: 'Keep it', gpuDownload: 'Download result JSON', gpuNoResult: 'This job has no result yet',
      gpuQueuePos: 'Queue #', gpuEta: 'ETA', gpuBy: 'by', gpuSec: 's', gpuMin: 'min',
      gpuTestJob: 'Send a test job', gpuTestJobNote: 'Sends a real job to aixman GPUs (counts toward the daily quota). Output is an AI draft — review before use.',
      gpuFile: 'Audio file (MP3, WAV, FLAC, OGG, M4A)', gpuFileMax: 'max {n} MB',
      gpuLyricsOpt: 'Lyrics (optional — improves lyric timing)', gpuMode: 'Model set', gpuSend: 'Submit',
      gpuUploading: 'Uploading {p}%', gpuForwarding: 'Forwarding to GPU…', gpuSubmitted: 'Job submitted',
      gpuDeduped: 'Already submitted — showing the existing job', gpuNeedFile: 'Please choose an audio file', gpuTooBig: 'File exceeds {n} MB',
      gpuNetErr: 'Connection problem — the job may have been created; check the list below', gpuNeedPair: 'Connect to aixman above before submitting jobs',
    },
  };
  let lang = localStorage.getItem('aq.lang') || 'th';
  if (!DICT[lang]) lang = 'th';
  const t = (k) => (DICT[lang] && DICT[lang][k]) || DICT.th[k] || k;
  function setLang(l) { lang = l; localStorage.setItem('aq.lang', l); document.documentElement.setAttribute('lang', l); document.documentElement.setAttribute('data-lang', l); render(); }
  document.documentElement.setAttribute('data-lang', lang);

  /* ---------------- theme (dark mode) ---------------- */
  function applyTheme(th) {
    document.documentElement.setAttribute('data-theme', th);
    localStorage.setItem('aq.theme', th);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', th === 'dark' ? '#0a1622' : '#0b7d75');
  }
  function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

  /* ---------------- state + api ---------------- */
  const state = { token: localStorage.getItem('aq.admin.token') || '', me: null, tab: 'overview', cache: {} };

  async function api(method, path, bodyObj) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    let res, data = {};
    res = await fetch(API + path, { method, headers, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 401 && state.me) { doLogout(true); }
      const err = new Error((data && data.error && data.error.message) || 'เกิดข้อผิดพลาด');
      err.code = data && data.error && data.error.code; err.status = res.status;
      throw err;
    }
    return data;
  }

  function saveToken(tok, me) { state.token = tok; state.me = me; localStorage.setItem('aq.admin.token', tok); }
  async function doLogout(expired) {
    gpuStop();
    try { if (!expired) await api('POST', '/logout'); } catch (e) {}
    state.token = ''; state.me = null; localStorage.removeItem('aq.admin.token');
    render();
  }

  /* ---------------- toast / modal ---------------- */
  function toast(msg, isErr) {
    const r = document.getElementById('toastRoot');
    const el = document.createElement('div'); el.className = 'toast' + (isErr ? ' err' : ''); el.textContent = msg;
    r.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 2600);
  }
  function modal(html) {
    const r = document.getElementById('modalRoot');
    r.innerHTML = '<div class="modal-overlay"><div class="modal">' + html + '</div></div>';
    const ov = r.querySelector('.modal-overlay');
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    function close() { r.innerHTML = ''; }
    return { root: r, close };
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    try {
      const s = await api('GET', '/setup-status');
      if (s.needs_setup) { renderSetup(); return; }
      if (state.token) {
        try { const m = await api('GET', '/me'); state.me = m.admin; renderDashboard(); return; }
        catch (e) { state.token = ''; localStorage.removeItem('aq.admin.token'); }
      }
      renderLogin();
    } catch (e) {
      $app.innerHTML = '<div class="auth-wrap"><div class="auth-card"><div class="auth-title">⚠️</div><p class="auth-sub">' + esc(e.message) + '</p><button class="btn btn-block" onclick="location.reload()">↻</button></div></div>';
    }
  }
  function render() {
    if (!state.token || !state.me) { boot(); } else { renderDashboard(); }
  }

  /* ---------------- topbar (shared) ---------------- */
  function langBtn() {
    return '<button class="theme-toggle" id="themeBtn" aria-label="Toggle theme"><span class="ic-moon">🌙</span><span class="ic-sun">☀️</span></button>' +
      '<button class="lang-toggle" id="langBtn"><span class="lt-th">ไทย</span> / <span class="lt-en">EN</span></button>';
  }
  function wireLang() {
    const b = document.getElementById('langBtn'); if (b) b.addEventListener('click', () => setLang(lang === 'th' ? 'en' : 'th'));
    const th = document.getElementById('themeBtn'); if (th) th.addEventListener('click', toggleTheme);
  }

  /* ---------------- setup screen ---------------- */
  function renderSetup() {
    $app.innerHTML =
      '<div class="auth-wrap"><div class="auth-card">' +
      '<div style="position:absolute;top:16px;right:16px;display:flex;gap:6px">' + langBtn() + '</div>' +
      '<img class="auth-logo" src="../assets/logo-mark.png" alt="AquaChord" />' +
      '<div class="auth-badge">' + t('setupBadge') + '</div>' +
      '<div class="auth-title">' + t('setupTitle') + '</div>' +
      '<div class="auth-sub">' + t('setupSub') + '</div>' +
      '<div class="form-err" id="err"></div>' +
      '<form id="f">' +
      field('username', t('username'), 'text', 'username') +
      field('password', t('password'), 'password', 'new-password') +
      field('confirm', t('passwordConfirm'), 'password', 'new-password') +
      '<button class="btn btn-block" type="submit">' + t('create') + '</button>' +
      '</form></div></div>';
    wireLang();
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = val('username'), p = val('password'), c = val('confirm');
      const err = document.getElementById('err');
      if (!u || !p) { err.textContent = t('required'); return; }
      if (p.length < 8) { err.textContent = t('pwShort'); return; }
      if (p !== c) { err.textContent = t('pwMismatch'); return; }
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        const r = await api('POST', '/setup', { username: u, password: p });
        saveToken(r.token, r.admin); toast(t('added')); renderDashboard();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  /* ---------------- login screen ---------------- */
  function renderLogin() {
    $app.innerHTML =
      '<div class="auth-wrap"><div class="auth-card">' +
      '<div style="position:absolute;top:16px;right:16px;display:flex;gap:6px">' + langBtn() + '</div>' +
      '<img class="auth-logo" src="../assets/logo-mark.png" alt="AquaChord" />' +
      '<div class="auth-title">' + t('loginTitle') + '</div>' +
      '<div class="auth-sub">' + t('loginSub') + '</div>' +
      '<div class="form-err" id="err"></div>' +
      '<form id="f">' +
      field('username', t('username'), 'text', 'username') +
      field('password', t('password'), 'password', 'current-password') +
      '<button class="btn btn-block" type="submit">' + t('login') + '</button>' +
      '</form></div></div>';
    wireLang();
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('err'); err.textContent = '';
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        const r = await api('POST', '/login', { username: val('username'), password: val('password') });
        saveToken(r.token, r.admin); renderDashboard();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  function field(id, label, type, ac) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" type="' + type + '" autocomplete="' + (ac || 'off') + '" /></div>';
  }
  const val = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };

  /* ---------------- dashboard shell ---------------- */
  function renderDashboard() {
    gpuStop();   // หยุด timer/async ของแท็บ GPU ทุกครั้งที่วาดใหม่หรือสลับแท็บ
    const tabs = [['overview', t('tabOverview')], ['songs', t('tabSongs')], ['admins', t('tabAdmins')], ['gpu', t('tabGpu')], ['settings', t('tabSettings')]];
    $app.innerHTML =
      '<div class="topbar"><div class="brand"><img src="../assets/logo-mark.png" alt=""/><b>AquaChord</b><span class="tag">' + t('tag') + '</span></div>' +
      '<div class="topbar-actions"><span class="who">👤 ' + esc(state.me.username) + '</span>' + langBtn() +
      '<button class="btn-ghost btn-sm" id="logoutBtn">' + t('logout') + '</button></div></div>' +
      '<div class="wrap"><div class="tabs" id="tabs">' +
      tabs.map((x) => '<button data-tab="' + x[0] + '"' + (state.tab === x[0] ? ' class="active"' : '') + '>' + esc(x[1]) + '</button>').join('') +
      '</div><div id="tabView"></div></div>';
    wireLang();
    document.getElementById('logoutBtn').addEventListener('click', () => doLogout(false));
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderDashboard(); }));
    const v = document.getElementById('tabView');
    if (state.tab === 'overview') renderOverview(v);
    else if (state.tab === 'songs') renderSongs(v);
    else if (state.tab === 'admins') renderAdmins(v);
    else if (state.tab === 'gpu') renderGpu(v);
    else if (state.tab === 'settings') renderSettings(v);
  }

  /* ---------------- overview ---------------- */
  async function renderOverview(v) {
    v.innerHTML = '<div class="card"><div class="muted">…</div></div>';
    try {
      const r = await api('GET', '/stats'); const s = r.stats;
      v.innerHTML =
        '<div class="card"><div class="stat-grid">' +
        stat(s.songs, t('stSongs')) + stat(s.published, t('stPublished')) + stat(s.admins, t('stAdmins')) +
        '</div></div>' +
        '<div class="card"><div class="section-title">🕒 ' + t('recent') + '</div>' +
        (s.recent.length ? s.recent.map((x) =>
          '<div class="row"><div class="grow"><div class="t">' + esc(x.title) + '</div><div class="s">' + esc(x.artist || '') + '</div></div>' +
          '<span class="pill ' + (x.is_public ? 'pub">' + t('published') : 'priv">' + t('private')) + '</span></div>').join('')
          : '<div class="empty"><div class="e">🫧</div>' + t('noSongs') + '</div>') +
        '</div>';
    } catch (e) { v.innerHTML = errCard(e); }
  }
  const stat = (n, l) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + esc(l) + '</div></div>';
  const errCard = (e) => '<div class="card"><div class="empty"><div class="e">⚠️</div>' + esc(e.message) + '</div></div>';

  /* ---------------- songs ---------------- */
  async function renderSongs(v) {
    v.innerHTML = '<div class="card"><div class="muted">…</div></div>';
    try {
      const r = await api('GET', '/songs'); const songs = r.songs;
      v.innerHTML =
        '<div class="card"><div class="section-title">🎵 ' + t('songs') +
        '<button class="btn btn-sm" id="addSong">+ ' + t('addSong') + '</button></div>' +
        (songs.length ? songs.map(songRow).join('') : '<div class="empty"><div class="e">🫧</div>' + t('noSongs') + '</div>') +
        '</div>';
      document.getElementById('addSong').addEventListener('click', () => songEditor(null));
      v.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => songEditor(songs.find((x) => x.id === b.dataset.edit))));
      v.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => confirmDelSong(b.dataset.del)));
      v.querySelectorAll('[data-pub]').forEach((c) => c.addEventListener('change', async () => {
        try { await api('POST', '/songs/' + c.dataset.pub + '/publish', { isPublic: c.checked }); toast(t('saved')); }
        catch (e) { toast(e.message, true); c.checked = !c.checked; }
      }));
    } catch (e) { v.innerHTML = errCard(e); }
  }
  function songRow(s) {
    return '<div class="row"><div class="grow"><div class="t">' + esc(s.title) + '</div>' +
      '<div class="s">' + esc([s.artist, s.creator, s.key].filter(Boolean).join(' · ')) + '</div></div>' +
      '<label class="switch"><input type="checkbox" data-pub="' + esc(s.id) + '"' + (s.isPublic ? ' checked' : '') + '/><span></span></label>' +
      '<button class="icon-btn" data-edit="' + esc(s.id) + '">✎</button>' +
      '<button class="icon-btn" data-del="' + esc(s.id) + '">🗑</button></div>';
  }
  function songEditor(s) {
    const isNew = !s;
    const m = modal(
      '<h3>' + (isNew ? t('newSong') : t('editSong')) + '</h3>' +
      '<div class="form-err" id="serr"></div>' +
      '<div class="two">' +
      inp('sTitle', t('title'), s ? s.title : '') + inp('sKey', t('key'), s ? s.key : '') +
      inp('sArtist', t('artist'), s ? s.artist : '') + inp('sCreator', t('creator'), s ? s.creator : '') +
      '</div>' +
      '<div class="field"><label>' + t('chordpro') + '</label><textarea id="sBody">' + esc(s ? s.chordpro : '{title: }\n\n[C] [G] [Am] [F]\n') + '</textarea></div>' +
      '<label class="field" style="display:flex;align-items:center;gap:10px"><input type="checkbox" id="sPub" style="width:auto"' + (s && s.isPublic ? ' checked' : '') + '/> ' + t('published') + '</label>' +
      '<div class="modal-actions"><button class="btn" id="sSave">' + t('save') + '</button><button class="btn-ghost" id="sCancel">' + t('cancel') + '</button></div>');
    m.root.querySelector('#sCancel').addEventListener('click', m.close);
    m.root.querySelector('#sSave').addEventListener('click', async () => {
      const payload = { title: val('sTitle'), artist: val('sArtist'), creator: val('sCreator'), key: val('sKey'),
        chordpro: document.getElementById('sBody').value, isPublic: document.getElementById('sPub').checked };
      if (!payload.title) { document.getElementById('serr').textContent = t('required'); return; }
      try {
        if (isNew) await api('POST', '/songs', payload); else await api('PUT', '/songs/' + s.id, payload);
        m.close(); toast(t('saved')); renderDashboard();
      } catch (e) { document.getElementById('serr').textContent = e.message; }
    });
  }
  function confirmDelSong(id) {
    const m = modal('<h3>' + t('delSong') + '</h3><p class="muted">' + t('delSongDesc') + '</p>' +
      '<div class="modal-actions"><button class="btn btn-danger" id="ok">' + t('del') + '</button><button class="btn-ghost" id="no">' + t('cancel') + '</button></div>');
    m.root.querySelector('#no').addEventListener('click', m.close);
    m.root.querySelector('#ok').addEventListener('click', async () => {
      try { await api('DELETE', '/songs/' + id); m.close(); toast(t('deleted')); renderDashboard(); }
      catch (e) { toast(e.message, true); }
    });
  }
  const inp = (id, label, v) => '<div class="field"><label>' + esc(label) + '</label><input id="' + id + '" value="' + esc(v || '') + '"/></div>';

  /* ---------------- admins ---------------- */
  async function renderAdmins(v) {
    v.innerHTML = '<div class="card"><div class="muted">…</div></div>';
    try {
      const r = await api('GET', '/admins'); const admins = r.admins;
      v.innerHTML =
        '<div class="card"><div class="section-title">🛡 ' + t('admins') +
        '<button class="btn btn-sm" id="addAdmin">+ ' + t('addAdmin') + '</button></div>' +
        admins.map((a) => '<div class="row"><div class="grow"><div class="t">' + esc(a.username) +
          (a.id === state.me.id ? ' <span class="muted">(' + t('you') + ')</span>' : '') + '</div>' +
          '<div class="s">' + esc(a.role) + '</div></div>' +
          '<span class="pill ' + (a.role === 'owner' ? 'owner">owner' : 'priv">' + esc(a.role)) + '</span>' +
          (a.id !== state.me.id ? '<button class="icon-btn" data-dela="' + a.id + '">🗑</button>' : '') + '</div>').join('') +
        '</div>' +
        '<div class="card"><div class="section-title">🔑 ' + t('changePw') + '</div>' +
        '<div class="field"><label>' + t('curPw') + '</label><input id="curPw" type="password" autocomplete="current-password"/></div>' +
        '<div class="field"><label>' + t('newPw') + '</label><input id="newPw" type="password" autocomplete="new-password"/></div>' +
        '<button class="btn" id="chPw">' + t('save') + '</button></div>';
      document.getElementById('addAdmin').addEventListener('click', addAdminModal);
      v.querySelectorAll('[data-dela]').forEach((b) => b.addEventListener('click', () => confirmDelAdmin(b.dataset.dela)));
      document.getElementById('chPw').addEventListener('click', async () => {
        const cur = val('curPw'), nw = val('newPw');
        if (nw.length < 8) { toast(t('pwShort'), true); return; }
        try { await api('POST', '/change-password', { current: cur, new: nw }); toast(t('saved')); document.getElementById('curPw').value = ''; document.getElementById('newPw').value = ''; }
        catch (e) { toast(e.message, true); }
      });
    } catch (e) { v.innerHTML = errCard(e); }
  }
  function addAdminModal() {
    const m = modal('<h3>' + t('addAdmin') + '</h3><div class="form-err" id="aerr"></div>' +
      '<div class="field"><label>' + t('username') + '</label><input id="aU" autocomplete="off"/></div>' +
      '<div class="field"><label>' + t('password') + '</label><input id="aP" type="password" autocomplete="new-password"/></div>' +
      '<div class="modal-actions"><button class="btn" id="ok">' + t('create') + '</button><button class="btn-ghost" id="no">' + t('cancel') + '</button></div>');
    m.root.querySelector('#no').addEventListener('click', m.close);
    m.root.querySelector('#ok').addEventListener('click', async () => {
      try { await api('POST', '/admins', { username: val('aU'), password: val('aP') }); m.close(); toast(t('added')); renderDashboard(); }
      catch (e) { document.getElementById('aerr').textContent = e.message; }
    });
  }
  function confirmDelAdmin(id) {
    const m = modal('<h3>' + t('delAdmin') + '</h3>' +
      '<div class="modal-actions"><button class="btn btn-danger" id="ok">' + t('del') + '</button><button class="btn-ghost" id="no">' + t('cancel') + '</button></div>');
    m.root.querySelector('#no').addEventListener('click', m.close);
    m.root.querySelector('#ok').addEventListener('click', async () => {
      try { await api('DELETE', '/admins/' + id); m.close(); toast(t('deleted')); renderDashboard(); }
      catch (e) { toast(e.message, true); m.close(); }
    });
  }

  /* ---------------- settings ---------------- */
  async function renderSettings(v) {
    v.innerHTML = '<div class="card"><div class="muted">…</div></div>';
    try {
      const r = await api('GET', '/settings'); const s = r.settings;
      v.innerHTML =
        '<div class="card"><div class="section-title">⚙️ ' + t('settings') + '</div>' +
        '<div class="field"><label>' + t('siteName') + '</label><input id="siteName" value="' + esc(s.site_name || '') + '"/></div>' +
        '<div class="field"><label>' + t('copyrightEmail') + '</label><input id="copyrightEmail" type="email" value="' + esc(s.copyright_email || '') + '"/></div>' +
        '<label class="field" style="display:flex;align-items:center;gap:10px"><input type="checkbox" id="enableUrl" style="width:auto"' + ((s.enable_url_ingest || '1') === '1' ? ' checked' : '') + '/> ' + t('enableUrl') + '</label>' +
        '<div class="field"><label>' + t('annTh') + '</label><input id="annTh" value="' + esc(s.announcement_th || '') + '"/></div>' +
        '<div class="field"><label>' + t('annEn') + '</label><input id="annEn" value="' + esc(s.announcement_en || '') + '"/></div>' +
        '<button class="btn" id="saveSet">' + t('save') + '</button></div>';
      document.getElementById('saveSet').addEventListener('click', async () => {
        try {
          await api('PUT', '/settings', {
            site_name: val('siteName'), copyright_email: val('copyrightEmail'),
            enable_url_ingest: document.getElementById('enableUrl').checked ? '1' : '0',
            announcement_th: val('annTh'), announcement_en: val('annEn'),
          });
          toast(t('saved'));
        } catch (e) { toast(e.message, true); }
      });
    } catch (e) { v.innerHTML = errCard(e); }
  }

  /* ---------------- GPU / AI server (docs/09 §3) ----------------
     จับคู่กับ aixman (PUT /gpu/config ทดสอบ ping ก่อนบันทึก), สถานะ + เพดาน/การใช้งานจาก ping,
     รายการงานล่าสุด (poll งานที่ยังไม่จบทุก 5 วิ เฉพาะตอนแท็บนี้เปิดและหน้าจอมองเห็น) */
  const GPU_ACTIVE = ['uploading', 'queued', 'starting', 'rendering'];
  const gpu = { gen: 0, timer: null, cfg: null, jobs: [], notices: {}, submitting: false };
  function gpuStop() {
    gpu.gen++;                                   // async ที่ค้างอยู่จะเห็น gen ไม่ตรง แล้วเลิกแตะ DOM
    if (gpu.timer) { clearTimeout(gpu.timer); gpu.timer = null; }
  }
  const gpuAlive = (my) => my === gpu.gen && state.tab === 'gpu' && !!state.me;
  const tf = (k, o) => t(k).replace(/\{(\w+)\}/g, (_, x) => (o && o[x] != null ? String(o[x]) : ''));
  const fmtTime = (ms) => { try { return new Date(ms).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return ''; } };
  const fmtDur = (s) => (s >= 90 ? Math.round(s / 60) + ' ' + t('gpuMin') : Math.max(0, Math.round(s)) + ' ' + t('gpuSec'));
  const fmtMB = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const errInner = (e) => '<div class="empty"><div class="e">⚠️</div>' + esc(e.message) + '</div>';
  const gpuNeedsPoll = (j) => GPU_ACTIVE.indexOf(j.status) >= 0 || (j.status === 'completed' && !j.hasResult);
  const gpuStLabel = (st) => (DICT[lang]['gpuSt_' + st] ? t('gpuSt_' + st) : st);
  const gpuReadiness = (r) => (DICT[lang]['gpuRd_' + r] ? t('gpuRd_' + r) : r);

  /** multipart upload ผ่าน XHR (ได้ % อัปโหลด) — ไม่ตั้ง Content-Type เอง ให้เบราว์เซอร์ใส่ boundary */
  function apiUpload(path, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', API + path);
      if (state.token) x.setRequestHeader('Authorization', 'Bearer ' + state.token);
      x.timeout = 300000;
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let d = null; try { d = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && d) { resolve(d); return; }
        if (x.status === 401 && state.me) doLogout(true);
        const err = new Error((d && d.error && d.error.message) || t('gpuNetErr'));
        err.status = x.status; err.code = d && d.error && d.error.code;
        reject(err);
      };
      x.onerror = () => reject(new Error(t('gpuNetErr')));
      x.ontimeout = () => reject(new Error(t('gpuNetErr')));
      x.send(fd);
    });
  }

  function renderGpu(v) {
    const my = gpu.gen;
    v.innerHTML =
      '<div class="card"><div class="section-title">🖥 ' + t('gpuTitle') + '</div><p class="muted">' + t('gpuIntro') + '</p></div>' +
      '<div class="card" id="gpuStatus"><div class="muted">…</div></div>' +
      '<div class="card" id="gpuPair"><div class="muted">…</div></div>' +
      '<div class="card"><div class="section-title">🧾 ' + t('gpuJobs') +
      '<button class="btn-ghost btn-sm" id="gpuJobsRefresh">↻ ' + t('refresh') + '</button></div>' +
      '<div id="gpuSubmit"></div><div id="gpuJobList"><div class="muted">…</div></div></div>';
    document.getElementById('gpuJobsRefresh').addEventListener('click', () => gpuLoadJobs(gpu.gen));
    gpuLoadConfig(my, false, true);
    gpuLoadJobs(my);
  }

  /** full=true → วาดฟอร์มจับคู่ใหม่ด้วย (ตอนเปิดแท็บ/หลังบันทึก) · false → อัปเดตเฉพาะสถานะ ไม่ล้างสิ่งที่พิมพ์ค้าง */
  async function gpuLoadConfig(my, fresh, full) {
    const box = document.getElementById('gpuStatus');
    if (box && gpu.cfg) box.classList.add('is-busy');
    try {
      const c = await api('GET', '/gpu/config' + (fresh ? '?fresh=1' : ''));
      if (!gpuAlive(my)) return;
      gpu.cfg = c;
      gpuRenderStatus();
      if (full) gpuRenderPair();
      gpuRenderSubmit();
    } catch (e) {
      if (!gpuAlive(my)) return;
      const el = document.getElementById('gpuStatus');
      if (el) { el.classList.remove('is-busy'); el.innerHTML = errInner(e); }
      if (full && !gpu.cfg) { gpu.cfg = {}; gpuRenderPair(); }
    }
  }

  function gpuRenderStatus() {
    const el = document.getElementById('gpuStatus'); if (!el) return;
    el.classList.remove('is-busy');
    const c = gpu.cfg || {}, r = c.remote;
    let pill;
    if (!c.configured) pill = '<span class="pill priv">' + t('gpuNotConfigured') + '</span>';
    else if (c.error) pill = '<span class="pill err">' + t('gpuUnreachable') + '</span>';
    else if (r && !r.enabled) pill = '<span class="pill warn">' + t('gpuRemoteOff') + '</span>';
    else pill = '<span class="pill pub">' + t('gpuConnected') + '</span>';
    const kv = (k, html) => '<div class="kv-k">' + esc(k) + '</div><div class="kv-v">' + html + '</div>';
    let rows = kv(t('gpuServer'), esc(c.baseUrl || '—')) +
      kv(t('gpuKey'), c.keyHint ? '<code>' + esc(c.keyHint) + '</code>' : '<span class="muted">—</span>');
    if (r) {
      const L = r.limits || {}, U = r.usage || {}, M = r.model || {};
      rows += kv(t('gpuModel'), esc(M.key || '—') + (M.readiness ? ' · ' + esc(gpuReadiness(M.readiness)) : ''));
      rows += kv(t('gpuSs2Remote'), esc(r.allowSheetSage2 ? t('gpuOn') : t('gpuOff')));
      rows += kv(t('gpuLimits'), esc([
        L.maxAudioMb != null ? t('gpuFileLe') + ' ' + L.maxAudioMb + ' MB' : null,
        L.maxSeconds != null ? '≤ ' + L.maxSeconds + ' ' + t('gpuSecPerSong') : null,
        L.maxJobsPerDay != null ? L.maxJobsPerDay + ' ' + t('gpuPerDay') : null,
        L.maxActiveJobs != null ? t('gpuConcurrent') + ' ' + L.maxActiveJobs : null,
      ].filter(Boolean).join(' · ') || '—'));
      rows += kv(t('gpuUsage'), esc((U.jobsToday != null ? U.jobsToday : '—') + (L.maxJobsPerDay != null ? ' / ' + L.maxJobsPerDay : '') +
        ' · ' + t('gpuActiveNow') + ' ' + (U.activeJobs != null ? U.activeJobs : '—') + (L.maxActiveJobs != null ? ' / ' + L.maxActiveJobs : '')));
      if (r.pingedAt) rows += kv(t('gpuChecked'), esc(fmtTime(r.pingedAt)));
    }
    el.innerHTML = '<div class="section-title">📡 ' + t('gpuStatus') + pill + '</div><div class="kv">' + rows + '</div>' +
      (c.error ? '<div class="form-err" style="margin:10px 0 0">' + esc(c.error) + '</div>' : '') +
      (c.warning ? '<div class="note-warn" style="margin:10px 0 0">' + esc(c.warning) + '</div>' : '') +
      (c.configured ? '<button class="btn-ghost btn-sm" id="gpuRecheck" style="margin-top:12px">↻ ' + t('gpuRecheck') + '</button>' : '');
    const b = document.getElementById('gpuRecheck');
    if (b) b.addEventListener('click', () => { b.disabled = true; gpuLoadConfig(gpu.gen, true, false); });
  }

  function gpuRenderPair() {
    const el = document.getElementById('gpuPair'); if (!el) return;
    const c = gpu.cfg || {};
    el.innerHTML = '<div class="section-title">🔗 ' + t('gpuPairTitle') + '</div>' +
      '<div class="form-err" id="gpuPairErr"></div>' +
      '<div class="field"><label for="gpuBase">' + t('gpuBaseUrl') + '</label>' +
      '<input id="gpuBase" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="300" value="' + esc(c.baseUrl || 'https://ai.xman4289.com') + '"/>' +
      '<div class="hint">' + t('gpuBaseHelp') + '</div></div>' +
      '<div class="field"><label for="gpuKeyIn">' + t('gpuKey') + '</label>' +
      '<input id="gpuKeyIn" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" placeholder="' +
      esc(c.keyHint ? tf('gpuKeyKeep', { hint: c.keyHint }) : t('gpuKeyPh')) + '"/>' +
      '<div class="hint">' + t('gpuKeyHelp') + '</div></div>' +
      '<div class="field"><label for="gpuDefMode">' + t('gpuDefMode') + '</label><select id="gpuDefMode">' +
      '<option value="open"' + (c.defaultMode !== 'sheetsage2' ? ' selected' : '') + '>' + t('gpuModeOpen') + '</option>' +
      '<option value="sheetsage2"' + (c.defaultMode === 'sheetsage2' ? ' selected' : '') + '>' + t('gpuModeSs2') + '</option></select></div>' +
      '<div class="note-warn">' + t('gpuSs2Note') + '</div>' +
      '<button class="btn" id="gpuSave">' + t('gpuTestSave') + '</button>';
    document.getElementById('gpuSave').addEventListener('click', gpuSaveConfig);
  }

  function gpuSaveConfig() {
    const my = gpu.gen;
    const btn = document.getElementById('gpuSave'), err = document.getElementById('gpuPairErr');
    if (!btn || btn.disabled) return;
    const payload = { baseUrl: val('gpuBase'), partnerKey: val('gpuKeyIn'), defaultMode: document.getElementById('gpuDefMode').value };
    if (!payload.partnerKey && !(gpu.cfg && gpu.cfg.keyHint)) { err.textContent = t('gpuNeedKey'); return; }
    const go = async () => {
      err.textContent = ''; btn.disabled = true; btn.textContent = t('gpuTesting');
      try {
        const r = await api('PUT', '/gpu/config', payload);
        if (!gpuAlive(my)) { toast(r.warning || t('gpuSavedOk'), !!r.warning); return; }
        gpu.cfg = r;
        gpuRenderStatus(); gpuRenderPair(); gpuRenderSubmit();       // วาดฟอร์มใหม่ = ล้างช่องคีย์ทิ้ง
        toast(r.warning || t('gpuSavedOk'), !!r.warning);
      } catch (e) {
        if (!gpuAlive(my)) { toast(e.message, true); return; }
        const er = document.getElementById('gpuPairErr'); if (er) er.textContent = e.message;
        btn.disabled = false; btn.textContent = t('gpuTestSave');
      }
    };
    if (payload.defaultMode === 'sheetsage2' && (!gpu.cfg || gpu.cfg.defaultMode !== 'sheetsage2')) {
      const m = modal('<h3>' + t('gpuSs2Confirm') + '</h3><p class="muted">' + t('gpuSs2ConfirmDesc') + '</p>' +
        '<div class="modal-actions"><button class="btn" id="ok">' + t('confirm') + '</button><button class="btn-ghost" id="no">' + t('cancel') + '</button></div>');
      m.root.querySelector('#no').addEventListener('click', m.close);
      m.root.querySelector('#ok').addEventListener('click', () => { m.close(); go(); });
      return;
    }
    go();
  }

  function gpuRenderSubmit() {
    const el = document.getElementById('gpuSubmit'); if (!el) return;
    const c = gpu.cfg || {};
    if (!c.configured) { el.dataset.ready = ''; el.innerHTML = '<p class="muted" style="margin-bottom:12px">' + t('gpuNeedPair') + '</p>'; return; }
    if (el.dataset.ready === '1') {                // วาดไว้แล้ว — อัปเดตแค่เพดานไฟล์/โหมดเริ่มต้น ไม่ล้างสิ่งที่เลือก/พิมพ์ไว้
      const cap = document.getElementById('gpuCap'); if (cap) cap.textContent = tf('gpuFileMax', { n: c.uploadCapMb });
      const sel = document.getElementById('gpuJobMode');
      if (sel && sel.dataset.touched !== '1') sel.value = c.defaultMode === 'sheetsage2' ? 'sheetsage2' : 'open';
      return;
    }
    el.dataset.ready = '1';
    el.innerHTML = '<details class="gpu-submit"><summary>🎧 ' + t('gpuTestJob') + '</summary>' +
      '<p class="muted" style="margin:8px 0 12px">' + t('gpuTestJobNote') + '</p>' +
      '<div class="form-err" id="gpuSubErr"></div>' +
      '<div class="field"><label for="gpuFile">' + t('gpuFile') + ' · <span id="gpuCap">' + esc(tf('gpuFileMax', { n: c.uploadCapMb })) + '</span></label>' +
      '<input id="gpuFile" type="file" accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a"/></div>' +
      '<div class="two"><div class="field"><label for="gpuTitle">' + t('title') + '</label><input id="gpuTitle" maxlength="200" autocomplete="off"/></div>' +
      '<div class="field"><label for="gpuJobMode">' + t('gpuMode') + '</label><select id="gpuJobMode">' +
      '<option value="open">Open</option><option value="sheetsage2">SheetSage2 (CC-BY-NC)</option></select></div></div>' +
      '<div class="field"><label for="gpuLyrics">' + t('gpuLyricsOpt') + '</label><textarea id="gpuLyrics" maxlength="5000" class="plain"></textarea></div>' +
      '<button class="btn" id="gpuSend">' + t('gpuSend') + '</button> <span class="muted" id="gpuSendState"></span></details>';
    const sel = document.getElementById('gpuJobMode');
    sel.value = c.defaultMode === 'sheetsage2' ? 'sheetsage2' : 'open';
    sel.addEventListener('change', () => { sel.dataset.touched = '1'; });
    const b = document.getElementById('gpuSend');
    b.addEventListener('click', gpuSubmitJob);
    if (gpu.submitting) b.disabled = true;         // อัปโหลดจากรอบก่อน (ก่อนสลับแท็บ) ยังไม่จบ
  }

  function gpuSubmitJob() {
    const btn = document.getElementById('gpuSend'), err = document.getElementById('gpuSubErr');
    if (!btn || btn.disabled || gpu.submitting) return;
    err.textContent = '';
    const fi = document.getElementById('gpuFile'), file = fi && fi.files && fi.files[0];
    if (!file) { err.textContent = t('gpuNeedFile'); return; }
    const cap = (gpu.cfg && gpu.cfg.uploadCapMb) || 64;
    if (file.size > cap * 1048576) { err.textContent = tf('gpuTooBig', { n: cap }); return; }
    const lyrics = document.getElementById('gpuLyrics').value;
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('title', val('gpuTitle'));
    fd.append('mode', document.getElementById('gpuJobMode').value);
    fd.append('language', 'th');
    if (lyrics.trim()) fd.append('lyrics', lyrics);
    const setState = (s) => { const x = document.getElementById('gpuSendState'); if (x) x.textContent = s; };
    gpu.submitting = true; btn.disabled = true;
    setState(tf('gpuUploading', { p: 0 }));
    apiUpload('/gpu/jobs', fd, (p) => setState(p >= 1 ? t('gpuForwarding') : tf('gpuUploading', { p: Math.round(p * 100) })))
      .then((r) => {
        toast(r.deduped ? t('gpuDeduped') : t('gpuSubmitted'));
        if (state.tab === 'gpu') {
          ['gpuFile', 'gpuTitle', 'gpuLyrics'].forEach((id) => { const x = document.getElementById(id); if (x) x.value = ''; });
        }
      })
      .catch((e) => {
        const er = state.tab === 'gpu' && document.getElementById('gpuSubErr');
        if (er) er.textContent = e.message; else toast(e.message, true);
      })
      .finally(() => {
        gpu.submitting = false; setState('');
        const b = document.getElementById('gpuSend'); if (b) b.disabled = false;
        if (state.tab === 'gpu' && state.me) gpuLoadJobs(gpu.gen);   // งานอาจถูกสร้างแม้ได้ error (เช่น proxy หมดเวลา)
      });
  }

  async function gpuLoadJobs(my) {
    try {
      const r = await api('GET', '/gpu/jobs');
      if (!gpuAlive(my)) return;
      gpu.jobs = r.jobs || [];
      gpuRenderJobs();
      gpuSchedulePoll(my);
    } catch (e) {
      if (!gpuAlive(my)) return;
      const el = document.getElementById('gpuJobList'); if (el) el.innerHTML = errInner(e);
    }
  }

  function gpuSchedulePoll(my) {
    if (gpu.timer) { clearTimeout(gpu.timer); gpu.timer = null; }
    if (!gpuAlive(my) || !gpu.jobs.some(gpuNeedsPoll)) return;
    gpu.timer = setTimeout(() => gpuPollTick(my), 5000);
  }

  async function gpuPollTick(my) {
    gpu.timer = null;
    if (!gpuAlive(my)) return;
    if (document.hidden) { gpuSchedulePoll(my); return; }        // แท็บเบราว์เซอร์ถูกซ่อน — รอรอบถัดไป
    const targets = gpu.jobs.filter(gpuNeedsPoll).slice(0, 4);
    for (const j of targets) {
      try {
        const r = await api('GET', '/gpu/jobs/' + encodeURIComponent(j.id) + '?result=0');
        if (!gpuAlive(my)) return;
        const i = gpu.jobs.findIndex((x) => x.id === j.id);
        if (i >= 0 && r.job) gpu.jobs[i] = r.job;
        if (r.notice) gpu.notices[j.id] = r.notice; else delete gpu.notices[j.id];
      } catch (e) {
        if (!gpuAlive(my)) return;
        gpu.notices[j.id] = e.message;
        if (e.status === 404) gpu.jobs = gpu.jobs.filter((x) => x.id !== j.id);
      }
    }
    gpuRenderJobs();
    gpuSchedulePoll(my);
  }

  function gpuRenderJobs() {
    const el = document.getElementById('gpuJobList'); if (!el) return;
    if (!gpu.jobs.length) { el.innerHTML = '<div class="empty"><div class="e">🫧</div>' + t('gpuNoJobs') + '</div>'; return; }
    el.innerHTML = gpu.jobs.map(gpuJobRow).join('');
    el.querySelectorAll('[data-gcancel]').forEach((b) => b.addEventListener('click', () => gpuConfirmCancel(b.dataset.gcancel)));
    el.querySelectorAll('[data-gdl]').forEach((b) => b.addEventListener('click', () => gpuDownload(b.dataset.gdl, b)));
  }

  function gpuJobRow(j) {
    const st = j.status, active = GPU_ACTIVE.indexOf(st) >= 0;
    const cls = st === 'completed' ? 'pub' : st === 'failed' ? 'err' : st === 'cancelled' ? 'priv' : 'run';
    const pct = active && j.progress != null ? Math.round(j.progress * 100) : null;
    const live = [];
    if (active && j.stageLabel) live.push(j.stageLabel);
    if (st === 'queued' && j.queuePosition != null) live.push(t('gpuQueuePos') + ' ' + j.queuePosition);
    if (active && j.etaSeconds != null) live.push(t('gpuEta') + ' ' + fmtDur(j.etaSeconds));
    const sub = [fmtTime(j.createdAt), j.createdBy ? t('gpuBy') + ' ' + j.createdBy : null,
      j.fileBytes ? fmtMB(j.fileBytes) : null, j.gpuSeconds != null ? 'GPU ' + Math.round(j.gpuSeconds) + ' ' + t('gpuSec') : null].filter(Boolean);
    const notice = gpu.notices[j.id];
    return '<div class="row gpu-row"><div class="grow">' +
      '<div class="t">' + esc(j.title || j.fileName || j.id) + '</div>' +
      '<div class="s">' + esc(sub.join(' · ')) + '</div>' +
      (live.length ? '<div class="s">' + esc(live.join(' · ')) + '</div>' : '') +
      (pct != null ? '<div class="gbar"><span style="width:' + pct + '%"></span></div>' : '') +
      (st === 'failed' && j.errorMessage ? '<div class="s gerr">' + esc(j.errorMessage) + '</div>' : '') +
      (notice && gpuNeedsPoll(j) ? '<div class="s gwarn">' + esc(notice) + '</div>' : '') +
      '</div>' +
      '<span class="pill ' + (j.mode === 'sheetsage2' ? 'warn' : 'owner') + '">' + (j.mode === 'sheetsage2' ? 'SheetSage2' : 'Open') + '</span>' +
      '<span class="pill ' + cls + '">' + esc(gpuStLabel(st)) + (pct != null ? ' ' + pct + '%' : '') + '</span>' +
      (st === 'queued' || st === 'uploading' ? '<button class="icon-btn" title="' + esc(t('gpuCancel')) + '" aria-label="' + esc(t('gpuCancel')) + '" data-gcancel="' + esc(j.id) + '">✕</button>' : '') +
      (j.hasResult ? '<button class="icon-btn" title="' + esc(t('gpuDownload')) + '" aria-label="' + esc(t('gpuDownload')) + '" data-gdl="' + esc(j.id) + '">⬇</button>' : '') +
      '</div>';
  }

  function gpuConfirmCancel(id) {
    const my = gpu.gen;
    const m = modal('<h3>' + t('gpuCancelQ') + '</h3><p class="muted">' + t('gpuCancelDesc') + '</p>' +
      '<div class="modal-actions"><button class="btn btn-danger" id="ok">' + t('gpuCancel') + '</button><button class="btn-ghost" id="no">' + t('gpuKeepJob') + '</button></div>');
    m.root.querySelector('#no').addEventListener('click', m.close);
    const ok = m.root.querySelector('#ok');
    ok.addEventListener('click', async () => {
      if (ok.disabled) return;
      ok.disabled = true;
      try {
        const r = await api('DELETE', '/gpu/jobs/' + encodeURIComponent(id));
        m.close(); toast(t('gpuSt_cancelled'));
        if (!gpuAlive(my)) return;
        const i = gpu.jobs.findIndex((x) => x.id === id);
        if (i >= 0 && r.job) gpu.jobs[i] = r.job;
        gpuRenderJobs();
      } catch (e) { m.close(); toast(e.message, true); if (gpuAlive(my)) gpuLoadJobs(my); }
    });
  }

  async function gpuDownload(id, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await api('GET', '/gpu/jobs/' + encodeURIComponent(id));
      if (!r.result) throw new Error(t('gpuNoResult'));
      const blob = new Blob([JSON.stringify(r.result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const base = String((r.job && (r.job.title || r.job.fileName)) || id).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 80);
      const a = document.createElement('a');
      a.href = url; a.download = base + '.aquachord.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  }

  /* ---------------- bubbles ---------------- */
  (function bubbles() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const c = document.getElementById('bubbles'), x = c.getContext('2d'); let W, H, dpr, arr = [];
    function rs() { dpr = Math.min(2, devicePixelRatio || 1); W = c.width = innerWidth * dpr; H = c.height = innerHeight * dpr; c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px'; arr = Array.from({ length: Math.min(34, (innerWidth / 30) | 0) }, sp); }
    function sp() { const r = (6 + Math.random() * 22) * dpr; return { x: Math.random() * W, y: H + Math.random() * H, r, s: (.2 + Math.random() * .6) * dpr, w: Math.random() * 6.28, a: .05 + Math.random() * .16 }; }
    function d() { if (document.hidden) { raf = requestAnimationFrame(d); return; } const dark = document.documentElement.getAttribute('data-theme') === 'dark'; x.clearRect(0, 0, W, H); x.globalCompositeOperation = dark ? 'lighter' : 'source-over'; arr.forEach((b) => { b.y -= b.s; b.w += .01; b.x += Math.sin(b.w) * .4; if (b.y + b.r < 0) Object.assign(b, sp(), { y: H + b.r }); const g = x.createRadialGradient(b.x - b.r * .3, b.y - b.r * .3, b.r * .1, b.x, b.y, b.r); if (dark) { g.addColorStop(0, 'rgba(224,195,255,' + (b.a + .30) + ')'); g.addColorStop(.45, 'rgba(168,85,247,' + (b.a + .12) + ')'); g.addColorStop(1, 'rgba(124,58,237,0)'); } else { g.addColorStop(0, 'rgba(255,255,255,' + (b.a + .14) + ')'); g.addColorStop(.6, 'rgba(94,234,212,' + b.a + ')'); g.addColorStop(1, 'rgba(13,148,136,0)'); } x.beginPath(); x.arc(b.x, b.y, b.r, 0, 7); x.fillStyle = g; x.fill(); }); x.globalCompositeOperation = 'source-over'; raf = requestAnimationFrame(d); }
    let raf; rs(); d(); addEventListener('resize', rs);
  })();

  boot();
})();
