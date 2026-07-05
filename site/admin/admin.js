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
      required: 'กรุณากรอกข้อมูลให้ครบ', confirm: 'ยืนยัน',
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
      required: 'Please fill in all fields', confirm: 'Confirm',
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
    const tabs = [['overview', t('tabOverview')], ['songs', t('tabSongs')], ['admins', t('tabAdmins')], ['settings', t('tabSettings')]];
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
