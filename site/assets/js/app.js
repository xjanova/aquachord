/* app.js — shell (sidebar/topbar/tabbar) + router + views + wiring
   สไตล์ "hub": sidebar ซ้าย (จอใหญ่) · แถบแท็บล่าง (มือถือ) · หัวข้อ 3D · spotlight panel
   งานแกะเพลงวิ่งเบื้องหลังได้ (ผู้ใช้เปิดหน้าอื่นระหว่างรอได้ — มี job pill บน topbar) */
(function () {
  const t = (k) => I18N.t(k);
  const tf = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : ''));
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const view = $('#view');
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // localStorage อาจโยน error (Safari private / ปิดคุกกี้) → ห้ามทำให้แอปพัง
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const FX = window.FX || { Orb: { mount() {}, detach() {}, setBusy() {}, pulse() {} }, Sky: { setMotion() {} } };
  const GD = () => window.Guide;

  /* ---------------- Icons (stroke, ใช้ currentColor) ---------------- */
  const ICONS = {
    wave: '<path d="M3 12h2.5l2-5.5 3 11 3-8 2 5 1.5-2.5H21"/>',
    library: '<path d="M4 4.5h4v15H4zM10 4.5h4v15h-4z"/><path d="M16.2 5.6l3.4-.9 3 13.9-3.4.9z" transform="translate(-1.6 0)"/>',
    chords: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M5 8.5h14M5 14h14M9.7 3v18M14.3 3v18"/><circle cx="12" cy="11.2" r="1.5" fill="currentColor"/>',
    settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    upload: '<path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5M4.5 20h15"/>',
    link: '<path d="M10.5 13.5a3.6 3.6 0 0 0 5.1 0l2.8-2.8a3.6 3.6 0 0 0-5.1-5.1l-1 1M13.5 10.5a3.6 3.6 0 0 0-5.1 0l-2.8 2.8a3.6 3.6 0 0 0 5.1 5.1l1-1"/>',
    play: '<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
    edit: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/><path d="M13 7l4 4"/>',
    trash: '<path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.9 12.5h9.2L17.5 7M9.5 7V4.5h5V7"/>',
    star: '<path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z"/>',
    download: '<path d="M12 4v11.5M7.5 11L12 15.5 16.5 11M4.5 20h15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
    next: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
    mic: '<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    motion: '<path d="M3 12c2.2-4.5 4.4-4.5 6 0s3.8 4.5 6 0 3.8-4.5 6 0"/>',
    shuffle: '<path d="M4 7h3.2l9.6 10H20M4 17h3.2l2.6-2.7M14.2 9.7L16.8 7H20M17.5 4.5L20 7l-2.5 2.5M17.5 14.5L20 17l-2.5 2.5"/>',
    note: '<path d="M9 18V5.5l10.5-2v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17" cy="16" r="2.5"/>',
    scroll: '<path d="M12 4v14M7 13.5l5 5 5-5"/>',
    reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.6-5.7M4.5 4.5v4h4"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.8 3.2 2.8 13.8 0 17M12 3.5c-2.8 3.2-2.8 13.8 0 17"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
    file: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/>',
  };
  const ic = (n, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  /* ---------------- Toast ---------------- */
  function toast(msg, opts) {
    opts = opts || {};
    const root = $('#toastRoot');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.kind ? ' ' + opts.kind : '');
    el.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    let timer;
    const kill = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 320); };
    if (opts.action) {
      const b = document.createElement('button');
      b.className = 'toast-act'; b.type = 'button'; b.textContent = opts.action.label;
      b.addEventListener('click', () => { kill(); opts.action.run(); });
      el.appendChild(b);
    }
    root.appendChild(el);
    while (root.children.length > 3) root.firstChild.remove();
    timer = setTimeout(kill, opts.ms || (opts.action ? 6000 : 2800));
  }

  /* ---------------- Modal + confirm ---------------- */
  let modalClose = null;
  function modal(html, opts) {
    opts = opts || {};
    const root = $('#modalRoot');
    const prevFocus = document.activeElement;
    root.innerHTML = `<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const overlay = $('.modal-overlay', root);
    document.documentElement.classList.add('modal-open');
    function close() {
      if (modalClose !== close) return;
      modalClose = null;
      root.innerHTML = '';
      document.documentElement.classList.remove('modal-open');
      if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch (e) {}
      if (opts.onClose) opts.onClose();
    }
    modalClose = opts.sticky ? null : close;
    if (!opts.sticky) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const first = $('[data-autofocus]', root) || $('button, a, input', root);
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
    return { root, close: () => { modalClose = close; close(); } };
  }

  function confirmDialog(o) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (done) return; done = true; resolve(v); };
      const m = modal(`
        <h2>${o.danger ? ic('trash') : ic('info')} ${esc(o.title)}</h2>
        ${o.body ? `<p>${esc(o.body)}</p>` : ''}
        <div class="modal-actions">
          <button class="button secondary" type="button" data-no>${esc(o.cancel || t('common.cancel'))}</button>
          <button class="button ${o.danger ? 'danger' : 'primary'}" type="button" data-yes data-autofocus>${esc(o.ok || t('common.confirm'))}</button>
        </div>`, { onClose: () => fin(false) });
      $('[data-yes]', m.root).addEventListener('click', () => { fin(true); m.close(); });
      $('[data-no]', m.root).addEventListener('click', () => { fin(false); m.close(); });
    });
  }

  /* ---------------- Copyright gate ---------------- */
  function copyrightHTML() {
    return `<h2>${ic('info')} ${t('copyright.title')}</h2>
      <p>${t('copyright.p1')}</p>
      <ul><li>${t('copyright.li1')}</li><li>${t('copyright.li2')}</li><li>${t('copyright.li3')}</li></ul>`;
  }
  function ensureCopyrightAccepted(then) {
    if (ls.get('aq.copyright.ok') === '1') { then(); return; }
    const m = modal(`${copyrightHTML()}
      <div class="modal-actions"><button class="button primary" id="cpAccept" data-autofocus>${ic('check')} ${t('copyright.accept')}</button></div>`, { sticky: true });
    $('#cpAccept', m.root).addEventListener('click', () => { ls.set('aq.copyright.ok', '1'); m.close(); then(); });
  }

  /* ---------------- Helpers: songs ---------------- */
  function songChords(chordpro) {
    const out = [], seen = new Set();
    ChordPro.parse(chordpro || '').lines.forEach((ln) => {
      if (ln.type !== 'line') return;
      ln.segs.forEach((s) => {
        if (s.chord && Music.isChord(s.chord) && !seen.has(s.chord)) { seen.add(s.chord); out.push(s.chord); }
      });
    });
    return out;
  }
  function hashOf(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function waveBars(seed, n) {
    let x = seed || 1, out = '';
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      const env = Math.sin((i / (n - 1)) * Math.PI) * 0.6 + 0.4;
      out += `<i style="height:${Math.round(18 + (x % 70) * env)}%"></i>`;
    }
    return out;
  }
  function fmtDate(ts) {
    if (!ts) return '';
    try { return new Intl.DateTimeFormat(I18N.get() === 'th' ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short' }).format(new Date(ts)); }
    catch (e) { return ''; }
  }
  function viewPrefs(id) {
    try { return Object.assign({ steps: 0, capo: 0 }, JSON.parse(ls.get('aq.view.' + id, '{}'))); }
    catch (e) { return { steps: 0, capo: 0 }; }
  }
  function saveViewPrefs(id, p) { ls.set('aq.view.' + id, JSON.stringify({ steps: p.steps, capo: p.capo })); }
  function storeSave(doc) {
    try { Store.upsert(doc); return true; }
    catch (e) { toast(t('err.storage'), { kind: 'warn', ms: 6000 }); return false; }
  }
  function hasLyrics(s) { return !!(s.lyricsText && String(s.lyricsText).trim()); }

  // ลบเพลง (ยืนยันก่อน + เลิกทำได้จาก toast)
  function deleteSong(id, after) {
    const song = Store.get(id);
    if (!song) return;
    confirmDialog({ title: t('library.delete'), body: tf('library.deleteDesc', { title: song.title }), ok: t('common.delete'), danger: true })
      .then((ok) => {
        if (!ok) return;
        const prefs = ls.get('aq.view.' + id, null);
        Store.remove(id); ls.del('aq.view.' + id);
        refreshShell();
        toast(t('library.deleted'), { action: { label: t('common.undo'), run: () => {
          storeSave(song); if (prefs) ls.set('aq.view.' + id, prefs);
          refreshShell(); route();
        } } });
        if (after) after();
      });
  }

  /* ---------------- Shell: nav / topbar ---------------- */
  const NAV = [
    { route: 'home', href: '#/', icon: 'wave', key: 'nav.home' },
    { route: 'library', href: '#/library', icon: 'library', key: 'nav.library', count: () => Store.count() },
    { route: 'chords', href: '#/chords', icon: 'chords', key: 'nav.chords' },
    { route: 'settings', href: '#/settings', icon: 'settings', key: 'nav.settings' },
  ];
  let curRoute = 'home';
  function renderShell() {
    $('#sideNav').innerHTML = NAV.map((n) => `
      <a class="side-link" href="${n.href}" data-route="${n.route}">
        ${ic(n.icon, 'nav-icon')}<span>${t(n.key)}</span>
        ${n.count ? `<span class="nav-count" data-count="${n.route}">${n.count()}</span>` : ''}
        <i class="nav-marker"></i>
      </a>`).join('');
    $('#tabbar').innerHTML = NAV.map((n) => `
      <a class="tab" href="${n.href}" data-route="${n.route}">
        ${ic(n.icon, 'tab-ic')}<span>${t(n.key)}</span>
        ${n.route === 'home' ? '<i class="tab-busy" aria-hidden="true"></i>' : ''}
      </a>`).join('');
    I18N.applyStatic();
    refreshShell();
  }
  function refreshShell() {
    const n = Store.count();
    $$('[data-count="library"]').forEach((e) => { e.textContent = n; });
    const hint = $('#topSearchHint'); if (hint) hint.textContent = tf(n === 1 ? 'search.hint1' : 'search.hint', { n });
    $$('.side-link, .tab').forEach((a) => {
      const on = a.dataset.route === curRoute;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const crumb = $('#crumbHere'); if (crumb) crumb.textContent = t('crumb.' + curRoute);
    updateJobPill();
  }

  /* ---------------- Motion toggle ---------------- */
  function motionOn() { return document.documentElement.getAttribute('data-motion') === 'on'; }
  function setMotion(on) {
    document.documentElement.setAttribute('data-motion', on ? 'on' : 'off');
    ls.set('aq.motion', on ? 'on' : 'off');
    paintMotionBtn();
    FX.Sky.setMotion(on); FX.Orb.setMotion && FX.Orb.setMotion(on);
  }
  function paintMotionBtn() {
    const b = $('#motionBtn');
    if (!b) return;
    const on = motionOn();
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.innerHTML = `<span class="mb-ic">${on ? '❚❚' : '▶'}</span><span class="mb-label">${t('motion.label')}</span>`;
    b.title = on ? t('motion.off') : t('motion.on');
  }

  /* ---------------- Lyrics prefs (จำค่าใน localStorage) ---------------- */
  const lyrPref = {
    // เปิดไว้เป็นค่าเริ่มต้น — คนส่วนใหญ่มาแกะเพลงเพื่ออยากได้เนื้อร้องด้วย
    get on() { const v = ls.get('aq.lyr.on', null); return v === null ? true : v === '1'; },
    set on(v) { ls.set('aq.lyr.on', v ? '1' : '0'); },
    get model() { const m = ls.get('aq.lyr.model', 'base'); return (window.Lyrics && Lyrics.MODELS[m]) ? m : 'base'; },
    set model(v) { ls.set('aq.lyr.model', v); },
    get lang() { return ls.get('aq.lyr.lang', 'th'); },
    set lang(v) { ls.set('aq.lyr.lang', v); },
  };
  const lyricsAvailable = () => !!(window.Lyrics && typeof Worker !== 'undefined');
  const opt = (v, label, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  function lyrSelectsHTML() {
    return `
      <label class="mini-field"><span>${t('lyrics.lang')}</span>
        <select id="lyrLang">
          ${opt('th', t('lyrics.lang.th'), lyrPref.lang)}${opt('en', t('lyrics.lang.en'), lyrPref.lang)}${opt('auto', t('lyrics.lang.auto'), lyrPref.lang)}
        </select></label>
      <label class="mini-field"><span>${t('lyrics.model')}</span>
        <select id="lyrModel">
          ${opt('tiny', t('lyrics.model.tiny'), lyrPref.model)}${opt('base', t('lyrics.model.base'), lyrPref.model)}${opt('small', t('lyrics.model.small'), lyrPref.model)}
        </select></label>`;
  }
  function lyricsBoxHTML() {
    if (!lyricsAvailable()) return '';
    const on = lyrPref.on;
    return `
      <div class="lyr-box ${on ? 'on' : ''}" id="lyrBox">
        <label class="switch-row">
          <span class="switch"><input type="checkbox" id="lyrOn" ${on ? 'checked' : ''} /><i></i></span>
          <span class="switch-text">${ic('mic')} ${t('lyrics.enable')}</span>
          <span class="chip chip-beta">Beta</span>
        </label>
        <div class="lyr-opts" id="lyrOpts" ${on ? '' : 'hidden'}>
          ${lyrSelectsHTML()}
          <p class="lyr-hint">${t('lyrics.hint')}</p>
        </div>
      </div>`;
  }
  function wireLyricsSelects(root) {
    const l = $('#lyrLang', root), m = $('#lyrModel', root);
    if (l) l.addEventListener('change', () => { lyrPref.lang = l.value; });
    if (m) m.addEventListener('change', () => { lyrPref.model = m.value; });
  }

  /* =====================================================================
     HOME — studio console (แกะเพลง)
     ===================================================================== */
  let ingestMode = 'file';
  let pickedFile = null;   // คงไว้หลังแกะพลาด → กดลองใหม่ได้ทันที

  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  function songCardHTML(s) {
    const hue = 160 + (hashOf(s.id || s.title || '') % 130);
    const prog = songChords(s.chordpro).slice(0, 4);
    const lyr = hasLyrics(s);
    const meta = [s.artist, s.key ? 'KEY ' + s.key : '', s.tempo ? s.tempo + ' BPM' : ''].filter(Boolean);
    return `<article class="song-card" style="--h:${hue}">
      <a class="sc-art" href="#/song/${esc(s.id)}" aria-label="${esc(s.title)}">
        <span class="sc-badge ${lyr ? 'lyr' : ''}">${lyr ? ic('mic') + ' ' + t('card.lyrics') : ic('note') + ' ' + t('card.chords')}</span>
        <span class="sc-key">${esc(s.key || '♪')}</span>
        <span class="sc-wave" aria-hidden="true">${waveBars(hashOf(s.id || 'x'), 26)}</span>
        ${prog.length ? `<span class="sc-prog">${prog.map(esc).join(' · ')}</span>` : ''}
      </a>
      <div class="sc-body">
        <h3 class="sc-title"><a href="#/song/${esc(s.id)}">${esc(s.title || 'Untitled')}</a></h3>
        <div class="sc-meta">${esc(meta.join(' / ')) || '&nbsp;'}</div>
        <div class="sc-foot">
          <span class="sc-stat">${s.playCount ? esc(tf('library.plays', { n: s.playCount })) : esc(fmtDate(s.createdAt || s.updatedAt))}</span>
          <button class="icon-btn fav ${s.favorite ? 'on' : ''}" type="button" data-fav="${esc(s.id)}" aria-pressed="${s.favorite ? 'true' : 'false'}" aria-label="${esc(t('library.fav'))}">${ic('star')}</button>
          <button class="icon-btn" type="button" data-del="${esc(s.id)}" aria-label="${esc(t('common.delete'))}">${ic('trash')}</button>
          <a class="sc-open" href="#/song/${esc(s.id)}">${t('card.open')} ${ic('play')}</a>
        </div>
      </div>
    </article>`;
  }

  // cb.onFav: หลังกดโปรด (เช่น ตัวกรอง "โปรด" ต้องวาดใหม่) · cb.onDel: หลังลบ (วาดรายการใหม่)
  function wireSongCards(root, cb) {
    cb = cb || {};
    $$('[data-fav]', root).forEach((btn) => btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const on = Store.toggleFav(btn.dataset.fav);
      btn.classList.toggle('on', !!on); btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (cb.onFav) cb.onFav();
    }));
    $$('[data-del]', root).forEach((btn) => btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      deleteSong(btn.dataset.del, () => { if (cb.onDel) cb.onDel(); else route(); });
    }));
  }

  function renderHome() {
    const songs = Store.all();
    const recent = songs.slice(0, 4);
    const favs = songs.filter((s) => s.favorite).length;
    view.innerHTML = `
      <section class="page-intro rise">
        <div>
          <div class="eyebrow"><i class="short-line"></i>${t('home.eyebrow')}</div>
          <h1 class="title-3d">${t('home.title1')} <span>${t('home.title2')}</span></h1>
        </div>
        <p class="intro-note">${t('home.note')}</p>
      </section>

      <section class="spotlight studio rise" id="studio" data-guide-stage>
        <div class="spot-scan" aria-hidden="true"></div>
        <div class="spot-head">
          <div class="spot-kicker"><span class="spark">✦</span>${t('home.kicker')}</div>
          <div class="spot-status"><i class="dot"></i>${t('home.ready')}</div>
        </div>
        <div class="studio-grid">
          <div class="studio-form">
            <div class="spot-category">${t('home.step')}</div>
            <div class="segctl" role="tablist" aria-label="${esc(t('home.step'))}">
              <button class="ingest-tab ${ingestMode === 'file' ? 'active' : ''}" type="button" role="tab" data-mode="file" aria-selected="${ingestMode === 'file'}">${ic('upload')}${t('ingest.file')}</button>
              <button class="ingest-tab ${ingestMode === 'url' ? 'active' : ''}" type="button" role="tab" data-mode="url" aria-selected="${ingestMode === 'url'}">${ic('link')}${t('ingest.url')}</button>
            </div>
            <div id="ingestFile" ${ingestMode === 'file' ? '' : 'hidden'}>
              <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="${esc(t('ingest.dropTitle'))}">
                <div class="dz-icon">${ic('wave')}</div>
                <div class="dz-title">${t('ingest.dropTitle')}</div>
                <div class="dz-hint">${t('ingest.dropHint')}</div>
                <div class="dz-file" id="dzFile" hidden></div>
              </div>
              <input type="file" id="fileInput" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.webm" hidden />
            </div>
            <div id="ingestUrl" ${ingestMode === 'url' ? '' : 'hidden'}>
              <div class="field"><input type="url" id="urlInput" inputmode="url" autocomplete="off" placeholder="${esc(t('ingest.urlPlaceholder'))}" /></div>
              <p class="field-hint">${t('ingest.urlHint')}</p>
            </div>
            ${lyricsBoxHTML()}
            <div class="spot-actions">
              <button class="button primary" type="button" id="startBtn">${ic('play')}${t('ingest.start')}</button>
              <a class="button secondary" href="#/edit/new">${ic('edit')}${t('home.writeOwn')}</a>
            </div>
            <div class="spot-tags"><span>${t('home.tag1')}</span><span>${t('home.tag2')}</span><span>${t('home.tag3')}</span></div>
            <p class="copyright-hint">${ic('info')} ${t('ingest.copyright')}</p>
          </div>
          <div class="studio-stage">
            <div class="orb-stage" id="orbStage"></div>
            <div class="world-coordinates" aria-hidden="true"><span>SIGNAL / ON-DEVICE</span><span>CHORDS · 60+</span><i></i></div>
          </div>
        </div>
        <div class="spot-bottom" aria-hidden="true"><span>INTERACTIVE · ${t('home.drag')}</span><span class="spot-motto">Let the waves carry the melody.</span></div>
      </section>

      ${recent.length ? `
      <section class="mini-row rise" aria-label="${esc(t('recent.title'))}">
        ${recent.map((s, i) => `
          <a class="mini-card" href="#/song/${esc(s.id)}" style="--h:${160 + (hashOf(s.id) % 130)}">
            <span class="mini-num">0${i + 1}</span>
            <span class="mini-key">${esc(s.key || '♪')}</span>
            <span class="mini-txt"><b>${esc(s.title)}</b><small>${esc([s.artist, s.tempo ? s.tempo + ' BPM' : ''].filter(Boolean).join(' · ') || t('recent.title'))}</small></span>
            <span class="mini-badge">${hasLyrics(s) ? t('card.lyrics') : t('card.chords')}</span>
          </a>`).join('')}
      </section>` : ''}

      <section class="section rise">
        <div class="section-head">
          <div>
            <div class="eyebrow small">${t('how.eyebrow')}</div>
            <h2 class="section-title">${t('how.title')}</h2>
          </div>
        </div>
        <div class="how-grid">
          ${[['upload', 'how.s1'], ['wave', 'how.s2'], ['mic', 'how.s3'], ['note', 'how.s4']].map(([icn, k], i) => `
            <div class="how-card">
              <div class="how-top"><span class="how-ic">${ic(icn)}</span><span class="how-n">0${i + 1}</span></div>
              <h3>${t(k + '.t')}</h3><p>${t(k + '.d')}</p>
            </div>`).join('')}
        </div>
      </section>

      ${songs.length ? `
      <section class="section rise">
        <div class="section-head">
          <div>
            <div class="eyebrow small">${t('collection.eyebrow')}</div>
            <h2 class="section-title">${t('collection.title')} <span class="count-chip">${songs.length}</span></h2>
          </div>
          <a class="button secondary sm" href="#/library">${t('recent.viewAll')} ${ic('next')}</a>
        </div>
        <div class="song-grid" id="homeGrid">${songs.slice(0, 6).map(songCardHTML).join('')}</div>
      </section>` : ''}

      <section class="studio-band rise">
        <div>
          <div class="eyebrow small">${t('band.eyebrow')}</div>
          <h2 class="band-title">${t('band.title1')}<br/><span>${t('band.title2')}</span></h2>
          <p class="band-lead">${t('band.lead')}</p>
        </div>
        <div class="band-stats">
          <div><b>${songs.length}</b><small>${t('band.songs')}</small></div>
          <div><b>${favs}</b><small>${t('band.favs')}</small></div>
          <div><b>0</b><small>${t('band.uploaded')}</small></div>
        </div>
      </section>`;

    wireIngest();
    wireSongCards($('#homeGrid'), { onDel: () => { const y = window.scrollY; renderHome(); window.scrollTo(0, y); } });
    FX.Orb.mount($('#orbStage'));
  }

  function wireIngest() {
    $$('.ingest-tab', view).forEach((btn) => btn.addEventListener('click', () => {
      ingestMode = btn.dataset.mode;
      $$('.ingest-tab', view).forEach((b) => { const on = b === btn; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
      $('#ingestUrl').hidden = ingestMode !== 'url';
      $('#ingestFile').hidden = ingestMode !== 'file';
      if (ingestMode === 'url') $('#urlInput').focus();
    }));
    const dz = $('#dropzone'), fileInput = $('#fileInput'), dzFile = $('#dzFile');
    function showFile() {
      if (!pickedFile) { dzFile.hidden = true; dz.classList.remove('has-file'); return; }
      dz.classList.add('has-file');
      dzFile.hidden = false;
      dzFile.innerHTML = `${ic('file')}<span class="dzf-name">${esc(pickedFile.name)}</span><span class="dzf-size">${fmtSize(pickedFile.size)}</span><span class="dzf-change">${t('ingest.change')}</span>`;
    }
    function setFile(f) {
      if (!f) return;
      const okType = /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm|mp4)$/i.test(f.name);
      if (!okType) { toast(t('ingest.notAudio'), { kind: 'warn' }); return; }
      pickedFile = f; showFile(); FX.Orb.pulse();
      if (GD()) GD().say(tf('guide.fileReady', { name: f.name }));
    }
    showFile();
    dz.addEventListener('click', () => fileInput.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); dz.classList.remove('drag');
      if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); fileInput.value = ''; });

    const lyrOn = $('#lyrOn');
    if (lyrOn) {
      lyrOn.addEventListener('change', () => {
        lyrPref.on = lyrOn.checked;
        $('#lyrOpts').hidden = !lyrOn.checked;
        $('#lyrBox').classList.toggle('on', lyrOn.checked);
      });
      wireLyricsSelects(view);
    }
    $('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#startBtn').click(); });

    $('#startBtn').addEventListener('click', () => {
      // เปิด AudioContext ใน gesture แรก (iOS)
      try { Music.audioCtx(); } catch (e) {}
      let input;
      if (ingestMode === 'url') {
        const url = $('#urlInput').value.trim();
        if (!url) { toast(t('ingest.needInput'), { kind: 'warn' }); $('#urlInput').focus(); return; }
        if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(url)) { toast(t('ingest.badUrl'), { kind: 'warn' }); return; }
        // ลิงก์วิดีโอ/สตรีมมิง ดึงไฟล์เสียงตรง ๆ ไม่ได้ — ต้องอัปโหลดไฟล์แทน (ไม่หลอกผู้ใช้)
        if (/(youtube\.com|youtu\.be|youtube-nocookie\.com|tiktok\.com|facebook\.com|fb\.watch|instagram\.com|spotify\.com|soundcloud\.com|vimeo\.com|music\.apple\.com|joox\.com)/i.test(url)) {
          toast(t('ingest.urlNotSupported'), { kind: 'warn', ms: 6000 }); return;
        }
        input = { kind: 'url', url };
      } else {
        if (!pickedFile) { toast(t('ingest.needFile'), { kind: 'warn' }); $('#dropzone').classList.add('shake'); setTimeout(() => { const d = $('#dropzone'); if (d) d.classList.remove('shake'); }, 500); return; }
        input = { kind: 'file', file: pickedFile };
      }
      if (lyricsAvailable() && lyrPref.on) input.lyrics = { model: lyrPref.model, lang: lyrPref.lang };
      ensureCopyrightAccepted(() => Job.start(input));
    });
  }

  /* =====================================================================
     JOB — วิเคราะห์จริงในเครื่อง (analyze.js) · วิ่งต่อได้แม้เปิดหน้าอื่น
     ===================================================================== */
  const Job = {
    st: null,
    start(input) {
      if (this.st && this.st.running) { location.hash = '#/job'; return; }
      const ctl = { aborted: false };
      const st = this.st = {
        running: true, input, ctl, stages: Analyze.stages(!!input.lyrics), stage: 'ingest', percent: 0, detail: '',
        name: input.kind === 'file' ? input.file.name : input.url, doc: null,
      };
      FX.Orb.setBusy(true);
      Analyze.run(input, (p) => this.progress(st, p), ctl)
        .then((doc) => {
          if (st !== this.st || ctl.aborted) return;
          st.running = false; st.stage = 'done'; st.percent = 100;
          FX.Orb.setBusy(false);
          if (!storeSave(doc)) { this.st = null; this.paint(); if (curRoute === 'job') location.hash = '#/'; return; }
          pickedFile = null;
          st.doc = doc;
          const msg = doc.lyricsError ? (t('lyrics.err.' + doc.lyricsError) || t('lyrics.err.run'))
            : doc.lyricsEmpty ? t('lyrics.none') : t('job.done');
          refreshShell();
          if (GD()) GD().cheer(tf('guide.jobDone', { title: doc.title }));
          if (curRoute === 'job') {
            this.st = null;
            toast(msg, { kind: doc.lyricsError ? 'warn' : 'ok' });
            location.hash = '#/song/' + doc.id;
          } else {
            toast(msg, { kind: 'ok', action: { label: t('job.open'), run: () => { this.st = null; location.hash = '#/song/' + doc.id; } } });
            this.paint();
          }
        })
        .catch((err) => {
          if (st !== this.st) return;
          this.st = null; FX.Orb.setBusy(false);
          if (ctl.aborted || (err && err.message === 'cancelled')) { this.paint(); return; }
          toast(jobErrMsg(err), { kind: 'warn', ms: 6000 });
          this.paint();
          if (curRoute === 'job') location.hash = '#/';
        });
      location.hash = '#/job';
    },
    progress(st, p) {
      if (st !== this.st || st.ctl.aborted) return;
      st.stage = p.stage; st.percent = p.percent; st.detail = p.detail || '';
      this.paint();
    },
    cancel() {
      const st = this.st;
      if (!st || !st.running) return;
      confirmDialog({ title: t('job.cancelQ'), body: t('job.cancelDesc'), ok: t('job.cancel'), cancel: t('job.keep'), danger: true }).then((ok) => {
        if (!ok || st !== this.st) return;
        st.ctl.aborted = true; this.st = null; FX.Orb.setBusy(false);
        this.paint();
        location.hash = '#/';
      });
    },
    paint() {
      updateJobPill();
      if (curRoute === 'job') paintJob();
    },
  };

  function jobErrMsg(err) {
    const code = err && err.code;
    if (code === 'decode') return t('job.err.decode');
    if (code === 'short') return t('job.err.short');
    if (code === 'fetch') return t('job.err.fetch');
    if (code === 'toobig') return t('job.err.tooBig');
    return t('job.err.generic');
  }

  function updateJobPill() {
    const pill = $('#jobPill');
    if (!pill) return;
    const st = Job.st;
    document.documentElement.classList.toggle('job-busy', !!(st && st.running));
    if (!st || (st.running && curRoute === 'job') || (!st.running && !st.doc)) { pill.hidden = true; return; }
    pill.hidden = false;
    if (st.running) {
      pill.className = 'job-pill busy';
      pill.innerHTML = `<i class="jp-ring" style="--p:${st.percent}"></i><span>${tf('job.pill', { p: st.percent })}</span>`;
      pill.onclick = () => { location.hash = '#/job'; };
    } else {
      pill.className = 'job-pill done';
      pill.innerHTML = `${ic('check')}<span>${t('job.pillDone')}</span>`;
      pill.onclick = () => { const id = st.doc.id; Job.st = null; updateJobPill(); location.hash = '#/song/' + id; };
    }
  }

  const STAGE_ICON = { ingest: 'file', prep: 'settings', beats: 'motion', chords: 'chords', key: 'note', lyrics: 'mic', assemble: 'check' };
  function renderJob() {
    const st = Job.st;
    if (!st || (!st.running && !st.doc)) { location.replace('#/'); return; }
    if (!st.running && st.doc) { const id = st.doc.id; Job.st = null; location.replace('#/song/' + id); return; }
    view.innerHTML = `
      <section class="page-intro rise">
        <div>
          <div class="eyebrow"><i class="short-line"></i>${t('job.eyebrow')}</div>
          <h1 class="title-3d" id="jobTitle">${t('job.title')}</h1>
        </div>
        <p class="intro-note">${t('job.realNote')}</p>
      </section>
      <section class="spotlight job-panel rise" data-guide-stage>
        <div class="spot-scan" aria-hidden="true"></div>
        <div class="spot-head">
          <div class="spot-kicker"><span class="spark">✦</span>ANALYZING · ON-DEVICE</div>
          <div class="spot-status busy"><i class="dot"></i><span>${t('job.live')}</span></div>
        </div>
        <div class="job-grid">
          <div class="job-copy">
            <div class="spot-category job-file">${ic('file')} <span>${esc(st.name)}</span></div>
            <div class="job-pct" aria-live="polite"><span id="jobPct">0</span><small>%</small></div>
            <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="jobBar"><div class="progress-fill" id="jobFill"></div></div>
            <div class="job-stages" id="jobStages">
              ${st.stages.map((s) => `
                <div class="stage-row" data-stage="${s}">
                  <span class="stage-dot">${ic(STAGE_ICON[s] || 'spark')}</span>
                  <span class="stage-label">${t('job.stage.' + s)}</span>
                  <span class="stage-state"></span>
                </div>`).join('')}
            </div>
            <div class="job-detail" id="jobDetail">&nbsp;</div>
            <div class="spot-actions">
              <button class="button secondary" type="button" id="jobCancel">${ic('close')}${t('job.cancel')}</button>
              <a class="button ghost" href="#/library">${ic('library')}${t('job.browse')}</a>
            </div>
          </div>
          <div class="job-stage"><div class="orb-stage" id="orbStage"></div></div>
        </div>
      </section>`;
    $('#jobCancel').addEventListener('click', () => Job.cancel());
    FX.Orb.mount($('#orbStage'));
    paintJob();
  }

  function paintJob() {
    const st = Job.st;
    const fill = $('#jobFill');
    if (!st || !fill) return;
    fill.style.width = st.percent + '%';
    $('#jobBar').setAttribute('aria-valuenow', st.percent);
    $('#jobPct').textContent = st.percent;
    const idx = st.stages.indexOf(st.stage);
    $$('#jobStages .stage-row').forEach((r, i) => {
      const done = st.stage === 'done' || (idx >= 0 && i < idx);
      const active = i === idx && st.stage !== 'done';
      r.classList.toggle('active', active);
      r.classList.toggle('done', done);
      $('.stage-state', r).textContent = done ? 'OK' : active ? '···' : '';
    });
    $('#jobDetail').textContent = (st.stage !== 'done' && st.detail) || ' ';
    if (st.stage === 'done') $('#jobTitle').textContent = t('job.done');
  }

  /* =====================================================================
     LIBRARY — "explore the collection"
     ===================================================================== */
  let libFilter = 'all', libQuery = '';
  let libSort = ls.get('aq.lib.sort', 'recent');
  function libSongs() {
    let songs = Store.all();
    if (libFilter === 'fav') songs = songs.filter((s) => s.favorite);
    if (libFilter === 'lyr') songs = songs.filter(hasLyrics);
    if (libQuery) {
      const q = libQuery.toLowerCase().trim();
      songs = songs.filter((s) => [s.title, s.artist, s.creator, s.key].some((v) => (v || '').toLowerCase().includes(q)));
    }
    if (libSort === 'title') songs.sort((a, b) => (a.title || '').localeCompare(b.title || '', I18N.get() === 'th' ? 'th' : 'en'));
    else if (libSort === 'plays') songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
    else if (libSort === 'added') songs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return songs;
  }
  function renderLibrary() {
    const all = Store.all();
    const nFav = all.filter((s) => s.favorite).length, nLyr = all.filter(hasLyrics).length;
    view.innerHTML = `
      <section class="page-intro rise">
        <div>
          <div class="eyebrow"><i class="short-line"></i>${t('library.eyebrow')}</div>
          <h1 class="title-3d">${t('library.title1')}<span>${t('library.title2')}</span></h1>
        </div>
        <div class="intro-actions">
          <a class="button secondary sm" href="#/edit/new">${ic('plus')}${t('library.new')}</a>
          <button class="button secondary sm" type="button" id="libImport">${ic('upload')}${t('settings.import')}</button>
          <input type="file" id="libImportFile" accept=".json,application/json" hidden />
        </div>
      </section>
      <section class="lib-tools rise">
        <label class="search lib-search">${ic('search')}
          <input type="search" id="libSearch" placeholder="${esc(t('library.search'))}" value="${esc(libQuery)}" autocomplete="off" enterkeyhint="search" />
          <span class="search-hint">${tf(all.length === 1 ? 'search.hint1' : 'search.hint', { n: all.length })}</span>
        </label>
        <div class="filters" role="tablist">
          ${[['all', t('library.all'), all.length], ['fav', '★ ' + t('library.fav'), nFav], ['lyr', t('library.withLyrics'), nLyr]].map(([f, label, n]) => `
            <button class="filter ${libFilter === f ? 'active' : ''}" type="button" role="tab" aria-selected="${libFilter === f}" data-f="${f}">${esc(label)} <span>${n}</span></button>`).join('')}
          <label class="sort"><span class="sr-only">${t('library.sort')}</span>
            <select id="libSort">
              ${opt('recent', t('library.sort.recent'), libSort)}${opt('added', t('library.sort.added'), libSort)}${opt('title', t('library.sort.title'), libSort)}${opt('plays', t('library.sort.plays'), libSort)}
            </select>
          </label>
        </div>
      </section>
      <section class="song-grid rise" id="libGrid"></section>`;

    const grid = $('#libGrid');
    function paintGrid() {
      const songs = libSongs();
      if (!all.length) {
        grid.className = 'rise';
        grid.innerHTML = `<div class="empty panel">
          <div class="empty-orb" aria-hidden="true"></div>
          <h3>${t('library.empty.title')}</h3>
          <p>${t('library.empty.desc')}</p>
          <div class="spot-actions center"><a href="#/" class="button primary">${ic('wave')}${t('library.empty.cta')}</a><a href="#/edit/new" class="button secondary">${ic('edit')}${t('home.writeOwn')}</a></div>
        </div>`;
        return;
      }
      grid.className = 'song-grid';
      grid.innerHTML = songs.length ? songs.map(songCardHTML).join('')
        : `<div class="empty panel slim"><h3>${t('library.noMatch')}</h3><p>${t('library.noMatchDesc')}</p></div>`;
      wireSongCards(grid, { onFav: () => { if (libFilter === 'fav') paintGrid(); }, onDel: () => { const y = window.scrollY; renderLibrary(); window.scrollTo(0, y); } });
    }
    paintGrid();

    const search = $('#libSearch');
    let deb;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { libQuery = search.value; const top = $('#topSearch'); if (top && top !== document.activeElement) top.value = libQuery; paintGrid(); }, 140);
    });
    $$('[data-f]', view).forEach((b) => b.addEventListener('click', () => {
      libFilter = b.dataset.f;
      $$('[data-f]', view).forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', on); });
      paintGrid();
    }));
    $('#libSort').addEventListener('change', (e) => { libSort = e.target.value; ls.set('aq.lib.sort', libSort); paintGrid(); });
    const imp = $('#libImportFile');
    $('#libImport').addEventListener('click', () => imp.click());
    imp.addEventListener('change', () => importFrom(imp, () => renderLibrary()));
    view._paintLibrary = (q) => { libQuery = q; search.value = q; paintGrid(); };
  }

  function importFrom(input, after) {
    const f = input.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { const n = Store.importJSON(rd.result); toast(tf('settings.importedN', { n }), { kind: 'ok' }); refreshShell(); if (after) after(); }
      catch (e) { toast(e && e.name === 'QuotaExceededError' ? t('err.storage') : t('settings.importBad'), { kind: 'warn' }); }
      input.value = '';
    };
    rd.onerror = () => toast(t('settings.importBad'), { kind: 'warn' });
    rd.readAsText(f);
  }

  /* =====================================================================
     SONG — แผ่นคอร์ด + คีย์/คาโป้/ขนาด/เลื่อนอัตโนมัติ + ฟังลำดับคอร์ด
     ===================================================================== */
  const SCROLL_SPEEDS = [10, 16, 24, 34, 48];   // px/s
  let scrollRAF = 0, scrollOn = false;
  let wakeLock = null;
  function keepAwake(on) {
    if (on) {
      if (wakeLock || !('wakeLock' in navigator)) return;
      navigator.wakeLock.request('screen').then((l) => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
    } else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    // wake lock ถูกปล่อยเองตอนสลับแอป → ขอใหม่เมื่อกลับมาถ้ายังเลื่อน/เล่นอยู่
    if (document.visibilityState === 'visible' && (scrollOn || Player.on)) keepAwake(true);
  });

  function stopAutoScroll() { scrollOn = false; cancelAnimationFrame(scrollRAF); if (!Player.on) keepAwake(false); }

  /* ฟังลำดับคอร์ดตามจังหวะจริง (timeline จากการแกะ) หรือห้องละ 4 จังหวะตาม BPM */
  const Player = {
    on: false, timer: 0, seq: [], i: 0,
    start(song, mapChord) {
      this.stop();
      let seq = [];
      if (Array.isArray(song.timeline) && song.timeline.length > 1) {
        song.timeline.forEach((e) => { if (e.chord && Music.isChord(e.chord) && (!seq.length || seq[seq.length - 1].chord !== e.chord)) seq.push({ t: +e.t || 0, chord: e.chord }); });
        // ช่องว่างยาว (อินโทร/ท่อนไม่มีคอร์ด) ย่อเหลือไม่เกิน 4 วินาที
        let shift = 0;
        seq = seq.map((e, k) => { if (k) { const gap = e.t - seq[k - 1].t; if (gap > 4) shift += gap - 4; } return { t: e.t - shift, chord: e.chord }; });
        const t0 = seq.length ? seq[0].t : 0;
        seq.forEach((e) => { e.t -= t0; });
      } else {
        const bar = (60 / (parseFloat(song.tempo) || 90)) * 4;
        const chords = [];
        ChordPro.parse(song.chordpro || '').lines.forEach((ln) => { if (ln.type === 'line') ln.segs.forEach((s) => { if (s.chord && Music.isChord(s.chord)) chords.push(s.chord); }); });
        seq = chords.map((c, k) => ({ t: k * bar, chord: c }));
      }
      if (!seq.length) { toast(t('song.noChordsToPlay'), { kind: 'warn' }); return false; }
      this.seq = seq; this.i = 0; this.on = true; this.map = mapChord;
      this.t0 = performance.now();
      keepAwake(true);
      this.step();
      return true;
    },
    step() {
      if (!this.on) return;
      const e = this.seq[this.i];
      if (!e) { this.stop(); paintPlayer(); return; }
      const m = this.map(e.chord);
      Music.strum(Music.voicingMidis ? Music.voicingMidis(m.sound) : Music.chordToMidis(m.sound), 28);
      FX.Orb.pulse();
      this.cur = m.shape;
      paintPlayer();
      this.i++;
      const next = this.seq[this.i];
      const wait = next ? Math.max(120, next.t * 1000 - (performance.now() - this.t0)) : 2200;
      this.timer = setTimeout(() => this.step(), wait);
    },
    stop() {
      clearTimeout(this.timer); this.on = false; this.cur = null;
      if (!scrollOn) keepAwake(false);
    },
  };
  function paintPlayer() {
    const np = $('#nowPlaying');
    const btn = $('[data-act="play"]', view);
    if (btn) btn.innerHTML = Player.on ? `${ic('stop')}${t('song.stop')}` : `${ic('play')}${t('song.playSeq')}`;
    $$('.strip-chord', view).forEach((el) => el.classList.toggle('now', Player.on && el.dataset.chord === Player.cur));
    if (!Player.on) { np.hidden = true; return; }
    np.hidden = false;
    np.innerHTML = `<span class="np-label">${t('song.nowPlaying')}</span><b class="np-chord">${esc(Player.cur || '')}</b><span class="np-count">${Player.i}/${Player.seq.length}</span>
      <button class="icon-btn" type="button" id="npStop" aria-label="${esc(t('song.stop'))}">${ic('stop')}</button>`;
    $('#npStop').onclick = () => { Player.stop(); paintPlayer(); };
  }

  function lyricsStatusHTML(song) {
    if (song.lyricsError) return `<div class="lyr-status warn">${ic('mic')} ${esc(t('lyrics.err.' + song.lyricsError) || t('lyrics.err.run'))}</div>`;
    if (song.lyricsEmpty) return `<div class="lyr-status">${ic('mic')} ${esc(t('lyrics.none'))}</div>`;
    if (hasLyrics(song)) return `<div class="lyr-status ok">${ic('mic')} ${esc(t('lyrics.byAI') + (song.vocalIsolated ? ' · ' + t('lyrics.isolated') : ''))}</div>`;
    if (song.creator === 'AquaChord AI') return `<div class="lyr-status">${ic('mic')} ${esc(t('lyrics.offHint'))}</div>`;
    return '';
  }

  function renderSong(id, fresh) {
    const song = Store.get(id);
    if (!song) {
      view.innerHTML = `<section class="empty panel rise"><div class="empty-orb" aria-hidden="true"></div><h3>${t('song.notFound')}</h3><div class="spot-actions center"><a href="#/library" class="button secondary">${ic('back')}${t('nav.library')}</a></div></section>`;
      return;
    }
    if (fresh) Store.markPlayed(id);
    const st = viewPrefs(id);
    let size = parseFloat(ls.get('aq.sheet.size', '1.05')) || 1.05;
    let speedIdx = Math.min(SCROLL_SPEEDS.length - 1, Math.max(0, parseInt(ls.get('aq.scroll.speed', '1'), 10) || 0));
    const isAI = song.creator === 'AquaChord AI';
    const conf = song.confidence && song.confidence.chords ? Math.round(song.confidence.chords * 100) : null;

    view.innerHTML = `
      <a class="back-link rise" href="#/library">${ic('back')}${t('nav.library')}</a>
      <section class="spotlight song-hero rise">
        <div class="spot-scan" aria-hidden="true"></div>
        <div class="song-hero-in">
          <div class="spot-category" id="songKicker"></div>
          <h1 class="spot-title song-title" ${(song.title || '').length > 22 ? 'data-long' : ''}>${esc(song.title || 'Untitled')}</h1>
          <div class="song-sub">${esc([song.artist, song.creator ? t('library.by') + ' ' + song.creator : ''].filter(Boolean).join(' · ')) || '&nbsp;'}</div>
          <div class="spot-tags">
            ${isAI ? `<span>${t('sheet.header')}</span>` : `<span>${t('song.manual')}</span>`}
            ${conf ? `<span>${esc(tf('song.confidence', { n: conf }))}</span>` : ''}
            ${song.createdAt ? `<span>${esc(fmtDate(song.createdAt))}</span>` : ''}
          </div>
          <div class="spot-actions">
            <button class="button primary" type="button" data-act="play">${ic('play')}${t('song.playSeq')}</button>
            <a class="button secondary" href="#/edit/${esc(song.id)}">${ic('edit')}${t('song.edit')}</a>
            <button class="icon-btn lg fav ${song.favorite ? 'on' : ''}" type="button" data-act="fav" aria-pressed="${song.favorite ? 'true' : 'false'}" aria-label="${esc(t('library.fav'))}">${ic('star')}</button>
            <button class="icon-btn lg" type="button" data-act="download" aria-label="${esc(t('song.download'))}" title="${esc(t('song.download'))}">${ic('download')}</button>
            <button class="icon-btn lg danger" type="button" data-act="delete" aria-label="${esc(t('common.delete'))}" title="${esc(t('common.delete'))}">${ic('trash')}</button>
          </div>
        </div>
        <div class="song-hero-orb"><div class="orb-stage" id="orbStage"></div></div>
      </section>

      <div class="song-dock rise" id="dock" role="toolbar" aria-label="${esc(t('song.tools'))}">
        <div class="dock-group"><span class="dock-label">${t('song.transpose')}</span>
          <button type="button" data-act="key-" aria-label="−1">−</button><span class="dock-val" id="dvKey"></span><button type="button" data-act="key+" aria-label="+1">+</button></div>
        <div class="dock-group"><span class="dock-label">${t('song.capo')}</span>
          <button type="button" data-act="capo-" aria-label="capo −">−</button><span class="dock-val" id="dvCapo"></span><button type="button" data-act="capo+" aria-label="capo +">+</button></div>
        <div class="dock-group"><span class="dock-label">${t('song.fontSize')}</span>
          <button type="button" data-act="size-" aria-label="A−">A−</button><button type="button" data-act="size+" aria-label="A+">A+</button></div>
        <div class="dock-group"><button type="button" class="dock-toggle" data-act="scroll" id="dvScroll"></button>
          <button type="button" data-act="spd-" aria-label="slower">−</button><span class="dock-val" id="dvSpeed"></span><button type="button" data-act="spd+" aria-label="faster">+</button></div>
        <button type="button" class="dock-reset" data-act="reset" id="dvReset">${ic('reset')}<span>${t('song.original')}</span></button>
      </div>

      <section class="panel strip-panel rise">
        <div class="panel-head"><div class="eyebrow small">${t('song.chordsIn')}</div><span class="panel-note">${t('song.tapHint')}</span></div>
        <div class="chord-strip" id="strip"></div>
      </section>

      <section class="panel sheet-panel rise">
        ${lyricsStatusHTML(song)}
        <div class="chordsheet" id="sheet"></div>
      </section>`;

    const sheet = $('#sheet'), strip = $('#strip');

    function keys() {
      const shapeSteps = st.steps - st.capo;
      const soundKey = song.key ? Music.transposeKey(song.key, st.steps) : null;
      const shapeKey = song.key ? Music.transposeKey(song.key, shapeSteps) : null;
      return { shapeSteps, soundKey, shapeKey };
    }
    // ท่าจับที่แสดง (หักคาโป้แล้ว) → เสียงจริงที่ได้ยิน = ท่าจับ + คาโป้
    function mapChord(orig) {
      const k = keys();
      const shape = k.shapeSteps ? Music.transposeChord(orig, k.shapeSteps, k.shapeKey) : orig;
      const sound = st.capo ? Music.transposeChord(shape, st.capo, k.soundKey) : shape;
      return { shape, sound };
    }
    function playShape(shape) {
      const k = keys();
      const sound = st.capo ? Music.transposeChord(shape, st.capo, k.soundKey) : shape;
      Music.strum(Music.voicingMidis(sound), 32);
      FX.Orb.pulse();
    }

    function update() {
      const k = keys();
      $('#songKicker').textContent = [
        k.soundKey ? 'KEY ' + k.soundKey : '', song.tempo ? song.tempo + ' BPM' : '',
        st.capo ? 'CAPO ' + st.capo + (k.shapeKey ? ' · ' + t('song.shape') + ' ' + k.shapeKey : '') : '',
      ].filter(Boolean).join(' · ') || 'CHORD SHEET';
      $('#dvKey').textContent = k.soundKey || (st.steps > 0 ? '+' + st.steps : String(st.steps));
      $('#dvCapo').textContent = st.capo;
      $('#dvSpeed').textContent = '×' + (speedIdx + 1);
      $('#dvScroll').innerHTML = `${ic(scrollOn ? 'stop' : 'scroll')}<span>${t('song.scroll')}</span>`;
      $('#dvScroll').classList.toggle('on', scrollOn);
      $('#dvScroll').setAttribute('aria-pressed', scrollOn ? 'true' : 'false');
      $('#dvReset').hidden = !st.steps && !st.capo;
      sheet.style.setProperty('--sheet-size', size + 'rem');
      sheet.innerHTML = ChordPro.render(song.chordpro, { steps: k.shapeSteps, keyHint: k.shapeKey });
      const chords = songChords(song.chordpro).map((c) => mapChord(c).shape);
      strip.innerHTML = chords.length ? chords.map((c) => `
        <button class="strip-chord" type="button" data-chord="${esc(c)}">
          <b>${esc(c)}</b>${Music.diagramSVG(c, { scale: 0.78 })}
        </button>`).join('') : `<p class="panel-note">${t('sheet.noChords')}</p>`;
      $$('.strip-chord', strip).forEach((b) => b.addEventListener('click', () => {
        playShape(b.dataset.chord);
        b.classList.remove('ring'); void b.offsetWidth; b.classList.add('ring');
      }));
      $$('.seg-chord', sheet).forEach((el) => {
        const chord = el.dataset.chord;
        if (!chord) return;
        el.setAttribute('role', 'button'); el.tabIndex = 0;
        const go = () => {
          playShape(chord);
          el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring');
          showChordPop(el, chord);
        };
        el.addEventListener('click', go);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      });
      paintPlayer();
    }

    function toggleScroll() {
      if (scrollOn) { stopAutoScroll(); update(); return; }
      scrollOn = true; keepAwake(true);
      let last = performance.now(), acc = 0;
      const step = (now) => {
        if (!scrollOn) return;
        acc += ((now - last) / 1000) * SCROLL_SPEEDS[speedIdx]; last = now;
        if (acc >= 1) { const px = Math.floor(acc); acc -= px; window.scrollBy(0, px); }
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) { stopAutoScroll(); update(); return; }
        scrollRAF = requestAnimationFrame(step);
      };
      scrollRAF = requestAnimationFrame(step);
      update();
    }

    view.addEventListener('click', onAct);
    function onAct(e) {
      const b = e.target.closest('[data-act]');
      if (!b || !view.contains(b)) return;
      const a = b.dataset.act;
      if (a === 'key+') st.steps = st.steps >= 11 ? -11 + (st.steps - 11) : st.steps + 1;
      else if (a === 'key-') st.steps = st.steps <= -11 ? 0 : st.steps - 1;
      else if (a === 'capo+') st.capo = Math.min(11, st.capo + 1);
      else if (a === 'capo-') st.capo = Math.max(0, st.capo - 1);
      else if (a === 'reset') { st.steps = 0; st.capo = 0; }
      else if (a === 'size+') { size = Math.min(1.7, +(size + 0.08).toFixed(2)); ls.set('aq.sheet.size', size); }
      else if (a === 'size-') { size = Math.max(0.78, +(size - 0.08).toFixed(2)); ls.set('aq.sheet.size', size); }
      else if (a === 'spd+') { speedIdx = Math.min(SCROLL_SPEEDS.length - 1, speedIdx + 1); ls.set('aq.scroll.speed', speedIdx); update(); return; }
      else if (a === 'spd-') { speedIdx = Math.max(0, speedIdx - 1); ls.set('aq.scroll.speed', speedIdx); update(); return; }
      else if (a === 'scroll') { toggleScroll(); return; }
      else if (a === 'play') {
        try { Music.audioCtx(); } catch (err) {}
        if (Player.on) { Player.stop(); paintPlayer(); } else Player.start(song, mapChord);
        return;
      }
      else if (a === 'fav') {
        const on = Store.toggleFav(song.id); song.favorite = on;
        b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
        toast(on ? t('song.favOn') : t('song.favOff'));
        return;
      }
      else if (a === 'download') { downloadSong(song); return; }
      else if (a === 'delete') { deleteSong(song.id, () => { location.hash = '#/library'; }); return; }
      else return;
      if (Math.abs(st.steps) > 11) st.steps = 0;
      saveViewPrefs(song.id, st);
      update();
    }
    view._cleanup = () => view.removeEventListener('click', onAct);

    update();
    FX.Orb.mount($('#orbStage'));
  }

  function downloadSong(song) {
    let text = song.chordpro || '';
    if (!/\{\s*(title|t)\s*:/i.test(text)) text = `{title: ${song.title || 'Untitled'}}\n` + text;
    if (song.artist && !/\{\s*(artist|st|subtitle)\s*:/i.test(text)) text = text.replace(/(\{\s*(title|t)\s*:[^}]*\}\n?)/i, `$1{artist: ${song.artist}}\n`);
    if (song.key && !/\{\s*key\s*:/i.test(text)) text = text.replace(/(\{\s*(title|t)\s*:[^}]*\}\n?)/i, `$1{key: ${song.key}}\n`);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (song.title || 'song').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) + '.cho';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(t('song.downloaded'), { kind: 'ok' });
  }

  /* popover ท่าจับเมื่อแตะคอร์ดในแผ่นเพลง */
  function closeChordPop() { const old = $('.chord-pop'); if (old) old.remove(); }
  function showChordPop(anchor, chord) {
    closeChordPop();
    const pop = document.createElement('div');
    pop.className = 'chord-pop';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML = `
      <div class="cp-name">${esc(chord)}</div>
      <div class="cp-notes">${esc(Music.chordNotes(chord).join(' · '))}</div>
      ${Music.diagramSVG(chord, { scale: 1.1 })}
      <div class="cp-actions">
        <button class="button primary sm" type="button" data-pp="play">${ic('play')}</button>
        <a class="button secondary sm" href="#/chords/${encodeURIComponent(chord)}">${t('nav.chords')} ${ic('next')}</a>
      </div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 170, ph = pop.offsetHeight || 260;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - pw - 10));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 10) top = r.top - ph - 8;
    pop.style.left = left + 'px'; pop.style.top = Math.max(10, top) + 'px';
    $('[data-pp="play"]', pop).addEventListener('click', (e) => { e.stopPropagation(); anchor.click(); });
    setTimeout(() => {
      document.addEventListener('pointerdown', function h(ev) {
        if (!pop.isConnected) { document.removeEventListener('pointerdown', h); return; }
        if (!pop.contains(ev.target) && ev.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', h); }
      });
    }, 10);
  }
  window.addEventListener('scroll', () => { if (!scrollOn) closeChordPop(); }, { passive: true });

  /* =====================================================================
     CHORD LAB — ห้องคอร์ด: เลือก root + ชนิด → ท่าจับ + เสียง + คอร์ดในคีย์
     ===================================================================== */
  const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const QUALS = [
    ['', 'Major'], ['m', 'Minor'], ['7', '7'], ['m7', 'm7'], ['maj7', 'maj7'], ['sus2', 'sus2'], ['sus4', 'sus4'],
    ['6', '6'], ['m6', 'm6'], ['add9', 'add9'], ['9', '9'], ['dim', 'dim'], ['dim7', 'dim7'], ['m7b5', 'm7b5'], ['aug', 'aug'],
  ];
  const POPULAR = ['C', 'D', 'E', 'G', 'A', 'Am', 'Dm', 'Em', 'F', 'Bm', 'C7', 'G7', 'D7', 'E7', 'A7', 'Am7', 'Em7', 'Dsus4', 'Asus2', 'Cmaj7', 'Fmaj7'];
  let lab = { root: ls.get('aq.lab.root', 'C'), q: ls.get('aq.lab.q', ''), minor: ls.get('aq.lab.minor', '0') === '1' };
  if (!ROOTS.includes(lab.root)) lab.root = 'C';
  if (!QUALS.some((x) => x[0] === lab.q)) lab.q = '';

  function diatonic(root, minor) {
    const pc = Music.SHARP.indexOf(root) >= 0 ? Music.SHARP.indexOf(root) : Music.FLAT.indexOf(root);
    const flatKeys = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
    const flatMinor = ['D', 'G', 'C', 'F', 'Bb', 'Eb'];
    const useFlat = minor ? flatMinor.includes(root) : (flatKeys.includes(root) || root.length > 1 && root[1] === 'b');
    const names = useFlat ? Music.FLAT : Music.SHARP;
    const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const qs = minor ? ['m', 'dim', '', 'm', 'm', '', ''] : ['', 'm', 'm', '', '', 'm', 'dim'];
    const roman = minor ? ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'] : ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
    return steps.map((s, i) => ({ roman: roman[i], chord: names[(pc + s) % 12] + qs[i] }));
  }

  function renderChords(arg) {
    if (arg) {
      const c = Music.parseChord(decodeURIComponent(arg));
      if (c) {
        const pc = Music.SHARP.indexOf(c.root) >= 0 ? Music.SHARP.indexOf(c.root) : Music.FLAT.indexOf(c.root);
        lab.root = ROOTS[pc] || 'C';
        const q = ({ maj: '', min: 'm', M7: 'maj7', sus: 'sus4', '+': 'aug' })[c.quality] != null ? ({ maj: '', min: 'm', M7: 'maj7', sus: 'sus4', '+': 'aug' })[c.quality] : c.quality;
        lab.q = QUALS.some((x) => x[0] === q) ? q : (/^m(?!aj)/.test(q) ? 'm' : '');
      }
    }
    view.innerHTML = `
      <section class="page-intro rise">
        <div>
          <div class="eyebrow"><i class="short-line"></i>${t('lab.eyebrow')}</div>
          <h1 class="title-3d">${t('lab.title1')}<span>${t('lab.title2')}</span></h1>
        </div>
        <p class="intro-note">${t('lab.note')}</p>
      </section>
      <section class="spotlight lab rise">
        <div class="spot-scan" aria-hidden="true"></div>
        <div class="lab-grid">
          <div class="lab-pick">
            <div class="lab-label">${t('lab.root')}</div>
            <div class="root-grid" role="radiogroup" aria-label="${esc(t('lab.root'))}">
              ${ROOTS.map((r) => `<button type="button" role="radio" class="pick ${r === lab.root ? 'active' : ''}" aria-checked="${r === lab.root}" data-root="${r}">${r}</button>`).join('')}
            </div>
            <div class="lab-label">${t('lab.quality')}</div>
            <div class="qual-grid" role="radiogroup" aria-label="${esc(t('lab.quality'))}">
              ${QUALS.map(([q, label]) => `<button type="button" role="radio" class="pick ${q === lab.q ? 'active' : ''}" aria-checked="${q === lab.q}" data-q="${q}">${label}</button>`).join('')}
            </div>
          </div>
          <div class="lab-show" id="labShow"></div>
        </div>
      </section>
      <section class="panel rise">
        <div class="panel-head">
          <div><div class="eyebrow small">${t('lab.inKey')}</div><h2 class="section-title" id="keyTitle"></h2></div>
          <div class="segctl compact" role="tablist">
            <button type="button" class="ingest-tab ${!lab.minor ? 'active' : ''}" data-minor="0">Major</button>
            <button type="button" class="ingest-tab ${lab.minor ? 'active' : ''}" data-minor="1">Minor</button>
          </div>
        </div>
        <div class="key-chords" id="keyChords"></div>
        <div class="spot-actions"><button type="button" class="button secondary sm" id="progBtn">${ic('play')}${t('lab.progression')}</button><span class="panel-note">${t('lab.progHint')}</span></div>
      </section>
      <section class="panel rise">
        <div class="panel-head"><div><div class="eyebrow small">${t('lab.popular')}</div><h2 class="section-title">${t('lab.popularTitle')}</h2></div></div>
        <div class="chord-strip wrap" id="popular">
          ${POPULAR.map((c) => `<button class="strip-chord" type="button" data-pick="${c}"><b>${c}</b>${Music.diagramSVG(c, { scale: 0.78 })}</button>`).join('')}
        </div>
      </section>`;

    const name = () => lab.root + lab.q;
    function paintShow() {
      const c = name();
      $('#labShow').innerHTML = `
        <div class="lab-name">${esc(c)}</div>
        <div class="lab-notes">${esc(Music.chordNotes(c).join(' · '))}</div>
        <div class="lab-diagram">${Music.diagramSVG(c, { scale: 1.9 })}</div>
        <div class="spot-actions center">
          <button type="button" class="button primary" id="labStrum">${ic('play')}${t('lab.strum')}</button>
          <button type="button" class="button secondary" id="labArp">${ic('note')}${t('lab.arp')}</button>
        </div>`;
      $('#labStrum').addEventListener('click', () => { Music.strum(Music.voicingMidis(c), 34); FX.Orb.pulse(); });
      $('#labArp').addEventListener('click', () => { Music.voicingMidis(c).forEach((m, i) => Music.pluck(m, i * 0.24, 1.6, 0.3)); });
      ls.set('aq.lab.root', lab.root); ls.set('aq.lab.q', lab.q);
    }
    function paintKey() {
      const list = diatonic(lab.root, lab.minor);
      $('#keyTitle').textContent = `${lab.root} ${lab.minor ? 'minor' : 'major'}`;
      $('#keyChords').innerHTML = list.map((d) => `
        <button type="button" class="key-chord" data-pick="${esc(d.chord)}">
          <span class="kc-roman">${d.roman}</span><b>${esc(d.chord)}</b>${Music.diagramSVG(d.chord, { scale: 0.62 })}
        </button>`).join('');
      wirePicks($('#keyChords'));
      ls.set('aq.lab.minor', lab.minor ? '1' : '0');
    }
    function selectChord(sym) {
      const c = Music.parseChord(sym); if (!c) return;
      const pc = Music.SHARP.indexOf(c.root) >= 0 ? Music.SHARP.indexOf(c.root) : Music.FLAT.indexOf(c.root);
      lab.root = ROOTS[pc]; lab.q = c.quality;
      $$('[data-root]', view).forEach((b) => { const on = b.dataset.root === lab.root; b.classList.toggle('active', on); b.setAttribute('aria-checked', on); });
      $$('[data-q]', view).forEach((b) => { const on = b.dataset.q === lab.q; b.classList.toggle('active', on); b.setAttribute('aria-checked', on); });
      paintShow();
    }
    function wirePicks(root) {
      $$('[data-pick]', root).forEach((b) => b.addEventListener('click', () => {
        Music.strum(Music.voicingMidis(b.dataset.pick), 30); FX.Orb.pulse();
        b.classList.remove('ring'); void b.offsetWidth; b.classList.add('ring');
        selectChord(b.dataset.pick);
      }));
    }
    $$('[data-root]', view).forEach((b) => b.addEventListener('click', () => {
      lab.root = b.dataset.root;
      $$('[data-root]', view).forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-checked', on); });
      paintShow(); paintKey(); Music.strum(Music.voicingMidis(name()), 30);
    }));
    $$('[data-q]', view).forEach((b) => b.addEventListener('click', () => {
      lab.q = b.dataset.q;
      $$('[data-q]', view).forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-checked', on); });
      paintShow(); Music.strum(Music.voicingMidis(name()), 30);
    }));
    $$('[data-minor]', view).forEach((b) => b.addEventListener('click', () => {
      lab.minor = b.dataset.minor === '1';
      $$('[data-minor]', view).forEach((x) => x.classList.toggle('active', x === b));
      paintKey();
    }));
    $('#progBtn').addEventListener('click', () => {
      // I–V–vi–IV (เมเจอร์) / i–VI–III–VII (ไมเนอร์) — ทางเดินคอร์ดยอดฮิต
      const d = diatonic(lab.root, lab.minor);
      const prog = lab.minor ? [d[0], d[5], d[2], d[6]] : [d[0], d[4], d[5], d[3]];
      prog.forEach((x, i) => setTimeout(() => {
        Music.strum(Music.voicingMidis(x.chord), 30); FX.Orb.pulse();
        const el = $(`#keyChords [data-pick="${CSS.escape(x.chord)}"]`);
        if (el) { el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring'); }
      }, i * 900));
    });
    wirePicks($('#popular'));
    paintShow(); paintKey();
  }

  /* =====================================================================
     EDITOR — ChordPro + แทรกคอร์ดด้วยการแตะ (มือถือพิมพ์ [ ] ยาก)
     ===================================================================== */
  const QUICK = ['C', 'D', 'Em', 'F', 'G', 'Am', 'Dm', 'E', 'A', 'Bm', 'C7', 'G7'];
  function renderEditor(id) {
    const isNew = id === 'new';
    const song = isNew ? { id: Store.uid(), title: '', artist: '', creator: '', key: 'C', tempo: '', chordpro: '{title: }\n\n{soc}\n[C]เนื้อร้อง[G]ท่อนแรก [Am]ตรงนี้[F]\n{eoc}\n' } : Store.get(id);
    if (!song) { location.replace('#/library'); return; }
    const orig = { title: song.title || '', artist: song.artist || '', creator: song.creator || '', key: song.key || '', tempo: song.tempo || '', chordpro: song.chordpro || '' };
    const palette = Array.from(new Set(songChords(song.chordpro).concat(QUICK))).slice(0, 20);

    view.innerHTML = `
      <a class="back-link rise" href="${isNew ? '#/library' : '#/song/' + esc(song.id)}">${ic('back')}${isNew ? t('nav.library') : esc(song.title)}</a>
      <section class="page-intro rise">
        <div>
          <div class="eyebrow"><i class="short-line"></i>EDITOR · CHORDPRO</div>
          <h1 class="title-3d">${isNew ? t('editor.new1') : t('editor.title1')}<span>${isNew ? t('editor.new2') : t('editor.title2')}</span></h1>
        </div>
      </section>
      <section class="panel editor rise">
        <div class="editor-meta">
          <label class="full"><span>${t('editor.songTitle')}</span><input id="eTitle" value="${esc(orig.title)}" autocomplete="off" /></label>
          <label><span>${t('editor.artist')}</span><input id="eArtist" value="${esc(orig.artist)}" autocomplete="off" /></label>
          <label><span>${t('editor.creator')}</span><input id="eCreator" value="${esc(orig.creator)}" autocomplete="off" /></label>
          <label><span>${t('editor.key')}</span><input id="eKey" value="${esc(orig.key)}" autocomplete="off" list="keyList" /></label>
          <label><span>${t('editor.tempo')}</span><input id="eTempo" value="${esc(orig.tempo)}" inputmode="numeric" autocomplete="off" /></label>
          <datalist id="keyList">${ROOTS.map((r) => `<option value="${r}"></option><option value="${r}m"></option>`).join('')}</datalist>
        </div>
        <div class="palette">
          <div class="palette-label">${t('editor.insert')}</div>
          <div class="palette-chips">
            ${palette.map((c) => `<button type="button" class="chip-btn" data-ins="[${esc(c)}]">${esc(c)}</button>`).join('')}
            <button type="button" class="chip-btn sec" data-ins="{soc}\n" data-ins-end="\n{eoc}">Chorus</button>
            <button type="button" class="chip-btn sec" data-ins="{c: Verse}\n">Verse</button>
            <button type="button" class="chip-btn sec" data-ins="{c: Intro}\n">Intro</button>
          </div>
        </div>
        <div class="editor-split">
          <div class="editor-col">
            <label class="col-label" for="eBody">${t('editor.body')}</label>
            <textarea class="editor-body" id="eBody" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(orig.chordpro)}</textarea>
            <p class="field-hint">${t('editor.help')}</p>
          </div>
          <div class="editor-col">
            <div class="col-label">${t('editor.preview')}</div>
            <div class="chordsheet preview" id="ePreview"></div>
          </div>
        </div>
        <div class="spot-actions editor-actions">
          <button class="button primary" type="button" id="eSave">${ic('check')}${t('editor.save')}</button>
          <button class="button secondary" type="button" id="eBack">${t('common.cancel')}</button>
        </div>
      </section>`;

    const body = $('#eBody'), preview = $('#ePreview');
    const fields = { title: '#eTitle', artist: '#eArtist', creator: '#eCreator', key: '#eKey', tempo: '#eTempo' };
    const current = () => {
      const o = { chordpro: body.value };
      Object.keys(fields).forEach((k) => { o[k] = $(fields[k]).value; });
      return o;
    };
    const dirty = () => { const c = current(); return Object.keys(c).some((k) => c[k] !== orig[k]); };
    let saved = false;
    leaveGuard = () => !saved && dirty();

    let deb;
    const renderPreview = () => { preview.innerHTML = ChordPro.render(body.value, {}); };
    renderPreview();
    body.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(renderPreview, 150); });

    $$('[data-ins]', view).forEach((b) => b.addEventListener('click', () => {
      const s = body.selectionStart, e = body.selectionEnd;
      const pre = b.dataset.ins.replace(/\\n/g, '\n'), post = (b.dataset.insEnd || '').replace(/\\n/g, '\n');
      const sel = body.value.slice(s, e);
      body.setRangeText(pre + sel + post, s, e, 'end');
      if (!sel && post) body.selectionStart = body.selectionEnd = s + pre.length;
      body.focus();
      renderPreview();
      const m = /^\[(.+)\]$/.exec(pre); if (m) Music.strum(Music.voicingMidis(m[1]), 26);
    }));

    $('#eSave').addEventListener('click', () => {
      const c = current();
      song.title = c.title.trim() || 'Untitled';
      song.artist = c.artist.trim();
      song.creator = c.creator.trim();
      song.key = c.key.trim();
      song.tempo = c.tempo.trim().replace(/[^\d.]/g, '');
      song.chordpro = c.chordpro;
      song.schemaVersion = song.schemaVersion || 1;
      if (!storeSave(song)) return;
      saved = true; leaveGuard = null;
      refreshShell();
      toast(t('editor.saved'), { kind: 'ok' });
      location.hash = '#/song/' + song.id;
    });
    $('#eBack').addEventListener('click', () => { location.hash = isNew ? '#/library' : '#/song/' + song.id; });
  }

  /* =====================================================================
     SETTINGS
     ===================================================================== */
  let deferredPrompt = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function renderSettings() {
    const songs = Store.all();
    let bytes = 0; try { bytes = (localStorage.getItem('aq.songs.v1') || '').length * 2; } catch (e) {}
    const guideOff = ls.get('aq.guide.off', '0') === '1';
    const seg2 = (name, a, b, cur) => `<div class="switch-lang" data-seg="${name}">
      <button type="button" data-v="${a[0]}" class="${cur === a[0] ? 'active' : ''}" aria-pressed="${cur === a[0]}">${a[1]}</button>
      <button type="button" data-v="${b[0]}" class="${cur === b[0] ? 'active' : ''}" aria-pressed="${cur === b[0]}">${b[1]}</button></div>`;
    view.innerHTML = `
      <section class="page-intro rise">
        <div>
          <div class="eyebrow"><i class="short-line"></i>PREFERENCES</div>
          <h1 class="title-3d">${t('settings.title1')}<span>${t('settings.title2')}</span></h1>
        </div>
      </section>
      <div class="settings-grid">
        <section class="panel rise">
          <h2 class="panel-title">${ic('globe')}${t('settings.general')}</h2>
          <div class="setting-row"><div><div class="sr-label">${t('settings.language')}</div><div class="sr-desc">${t('settings.languageDesc')}</div></div>
            ${seg2('lang', ['th', 'ไทย'], ['en', 'EN'], I18N.get())}</div>
          <div class="setting-row"><div><div class="sr-label">${t('settings.motion')}</div><div class="sr-desc">${t('settings.motionDesc')}</div></div>
            ${seg2('motion', ['on', t('common.on')], ['off', t('common.off')], motionOn() ? 'on' : 'off')}</div>
          <div class="setting-row"><div><div class="sr-label">${t('settings.guide')}</div><div class="sr-desc">${t('settings.guideDesc')}</div></div>
            ${seg2('guide', ['on', t('common.show')], ['off', t('common.hide')], guideOff ? 'off' : 'on')}</div>
        </section>

        ${lyricsAvailable() ? `
        <section class="panel rise">
          <h2 class="panel-title">${ic('mic')}${t('settings.lyrics')}</h2>
          <div class="setting-row"><div><div class="sr-label">${t('lyrics.enable')}</div><div class="sr-desc">${t('settings.lyricsDesc')}</div></div>
            ${seg2('lyr', ['on', t('common.on')], ['off', t('common.off')], lyrPref.on ? 'on' : 'off')}</div>
          <div class="setting-row stack">${lyrSelectsHTML()}</div>
          <p class="lyr-hint">${t('lyrics.hint')}</p>
        </section>` : ''}

        <section class="panel rise">
          <h2 class="panel-title">${ic('library')}${t('settings.data')}</h2>
          <div class="setting-row"><div><div class="sr-label">${t('settings.export')}</div><div class="sr-desc">${t('settings.exportDesc')}</div></div>
            <button class="button secondary sm" type="button" id="exportBtn" ${songs.length ? '' : 'disabled'}>${ic('download')}${t('settings.exportBtn')}</button></div>
          <div class="setting-row"><div><div class="sr-label">${t('settings.import')}</div><div class="sr-desc">${t('settings.importDesc')}</div></div>
            <button class="button secondary sm" type="button" id="importBtn">${ic('upload')}${t('settings.importBtn')}</button>
            <input type="file" id="importFile" accept=".json,application/json" hidden /></div>
          <div class="setting-row"><div><div class="sr-label">${t('settings.storage')}</div><div class="sr-desc">${tf('settings.storageDesc', { n: songs.length, kb: Math.round(bytes / 1024) })}</div></div>
            <button class="button danger-ghost sm" type="button" id="clearBtn" ${songs.length ? '' : 'disabled'}>${ic('trash')}${t('settings.clear')}</button></div>
        </section>

        <section class="panel rise">
          <h2 class="panel-title">${ic('phone')}${t('settings.app')}</h2>
          <div class="setting-row"><div><div class="sr-label">${t('settings.install')}</div><div class="sr-desc" id="installDesc"></div></div>
            <button class="button primary sm" type="button" id="installBtn2" hidden>${ic('download')}${t('install')}</button></div>
          <div class="setting-row"><div><div class="sr-label">${t('settings.copyright')}</div><div class="sr-desc">${t('settings.copyrightDesc')}</div></div>
            <button class="button secondary sm" type="button" id="cpBtn">${t('common.read')}</button></div>
          <div class="setting-row"><div><div class="sr-label">${t('settings.tour')}</div><div class="sr-desc">${t('settings.tourDesc')}</div></div>
            <button class="button secondary sm" type="button" id="tourBtn">${ic('spark')}${t('side.tour')}</button></div>
          <div class="setting-row"><div class="sr-label">${t('settings.version')}</div><div class="sr-desc mono" id="appVersion">AquaChord</div></div>
        </section>
      </div>`;

    $$('[data-seg]', view).forEach((g) => $$('button', g).forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.v, name = g.dataset.seg;
      $$('button', g).forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b); });
      if (name === 'lang') I18N.setLang(v);
      else if (name === 'motion') setMotion(v === 'on');
      else if (name === 'guide') { ls.set('aq.guide.off', v === 'off' ? '1' : '0'); if (GD()) GD().setEnabled(v === 'on'); }
      else if (name === 'lyr') lyrPref.on = v === 'on';
    })));
    wireLyricsSelects(view);

    $('#exportBtn').addEventListener('click', () => {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      const d = new Date();
      a.download = `aquachord-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.aquachord.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(t('settings.exported'), { kind: 'ok' });
    });
    const importFile = $('#importFile');
    $('#importBtn').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => importFrom(importFile, () => renderSettings()));
    $('#clearBtn').addEventListener('click', () => {
      confirmDialog({ title: t('settings.clearQ'), body: tf('settings.clearDesc', { n: songs.length }), ok: t('settings.clear'), danger: true }).then((ok) => {
        if (!ok) return;
        Store.all().forEach((s) => { Store.remove(s.id); ls.del('aq.view.' + s.id); });
        refreshShell(); renderSettings(); toast(t('settings.cleared'));
      });
    });
    $('#cpBtn').addEventListener('click', () => {
      const m = modal(`${copyrightHTML()}<div class="modal-actions"><button class="button primary" type="button" data-autofocus>${t('common.close')}</button></div>`);
      $('.modal-actions button', m.root).addEventListener('click', () => m.close());
    });
    $('#tourBtn').addEventListener('click', () => { if (GD()) { ls.set('aq.guide.off', '0'); GD().setEnabled(true); location.hash = '#/'; setTimeout(() => GD().tour(), 450); } });
    paintInstall();
    fetch('version.json', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
      const e = $('#appVersion');
      if (e) e.textContent = 'AquaChord v' + v.version + (v.sha && v.sha !== 'dev' ? ' · ' + v.sha : '');
    }).catch(() => {});
  }

  function paintInstall() {
    const top = $('#installBtn');
    if (top) top.hidden = !deferredPrompt;
    const desc = $('#installDesc'), b2 = $('#installBtn2');
    if (!desc) return;
    if (isStandalone()) { desc.textContent = t('settings.installed'); b2.hidden = true; }
    else if (deferredPrompt) { desc.textContent = t('settings.installDesc'); b2.hidden = false; b2.onclick = doInstall; }
    else if (isIOS()) { desc.textContent = t('settings.installIOS'); b2.hidden = true; }
    else { desc.textContent = t('settings.installMenu'); b2.hidden = true; }
  }
  async function doInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) {}
    deferredPrompt = null; paintInstall();
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; paintInstall(); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; paintInstall(); toast(t('toast.installed'), { kind: 'ok' }); });
  $('#installBtn').addEventListener('click', doInstall);

  /* =====================================================================
     Router (+ กันออกจาก editor โดยไม่บันทึก)
     ===================================================================== */
  let leaveGuard = null;
  let lastHash = location.hash || '#/';
  let suppressNext = false;

  function parseHash(h) { return (h || '#/').replace(/^#\/?/, '').split('/'); }

  function teardown() {
    if (view._cleanup) { view._cleanup(); view._cleanup = null; }
    view._paintLibrary = null;
    stopAutoScroll();
    if (Player.on) Player.stop();
    paintPlayer();
    closeChordPop();
    FX.Orb.detach();
  }

  function route(fresh) {
    const parts = parseHash(location.hash);
    teardown();
    leaveGuard = null;
    const r = parts[0] || '';
    if (r === '') curRoute = 'home';
    else if (['library', 'settings', 'chords', 'song', 'edit', 'job'].includes(r)) curRoute = r;
    else curRoute = 'home';
    document.documentElement.setAttribute('data-route', curRoute);
    if (curRoute === 'home') renderHome();
    else if (curRoute === 'library') renderLibrary();
    else if (curRoute === 'settings') renderSettings();
    else if (curRoute === 'chords') renderChords(parts[1]);
    else if (curRoute === 'song') renderSong(parts[1], fresh);
    else if (curRoute === 'edit') renderEditor(parts[1]);
    else if (curRoute === 'job') renderJob();
    // แท็บสำหรับหน้าย่อย: เพลง/แก้ไข → คลังเพลง, งานแกะ → หน้าแกะเพลง
    const navRoute = { song: 'library', edit: 'library', job: 'home' }[curRoute] || curRoute;
    const keep = curRoute; curRoute = navRoute; refreshShell(); curRoute = keep;
    const crumb = $('#crumbHere'); if (crumb) crumb.textContent = t('crumb.' + keep);
    updateJobPill();
    revealIn();
    if (GD()) GD().onRoute(curRoute, { songs: Store.count(), job: !!(Job.st && Job.st.running) });
  }

  function onHashChange() {
    if (suppressNext) { suppressNext = false; return; }
    const next = location.hash || '#/';
    if (leaveGuard && leaveGuard()) {
      // ย้อน URL กลับก่อน แล้วถามยืนยัน
      try { history.replaceState(null, '', lastHash); } catch (e) {}
      confirmDialog({ title: t('editor.leaveConfirm'), body: t('editor.leaveDesc'), ok: t('editor.leave'), cancel: t('editor.stay'), danger: true }).then((ok) => {
        if (!ok) return;
        leaveGuard = null;
        if (location.hash === next) { lastHash = next; route(true); } else location.hash = next;
      });
      return;
    }
    lastHash = next;
    window.scrollTo(0, 0);
    route(true);
    view.focus({ preventScroll: true });
  }
  window.addEventListener('beforeunload', (e) => {
    if ((leaveGuard && leaveGuard()) || (Job.st && Job.st.running)) { e.preventDefault(); e.returnValue = ''; }
  });

  /* rise-in เมื่อเลื่อนเข้าจอ */
  let io = null;
  function revealIn() {
    const els = $$('.rise', view);
    if (!('IntersectionObserver' in window) || !motionOn()) { els.forEach((e) => e.classList.add('in')); return; }
    if (!io) io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -6% 0px' });
    els.forEach((e, i) => { e.style.transitionDelay = Math.min(i, 5) * 60 + 'ms'; io.observe(e); });
  }

  /* ---------------- Search (topbar ↔ library) ---------------- */
  const topSearch = $('#topSearch');
  let topDeb;
  topSearch.addEventListener('input', () => {
    clearTimeout(topDeb);
    topDeb = setTimeout(() => {
      libQuery = topSearch.value;
      if (curRoute !== 'library') { location.hash = '#/library'; return; }
      if (view._paintLibrary) view._paintLibrary(libQuery);
    }, 140);
  });
  topSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter' && curRoute !== 'library') location.hash = '#/library'; });
  function focusSearch() {
    if (getComputedStyle($('#topSearchWrap')).display !== 'none') { topSearch.focus(); topSearch.select(); return; }
    if (curRoute !== 'library') { location.hash = '#/library'; setTimeout(() => { const s = $('#libSearch'); if (s) s.focus(); }, 60); }
    else { const s = $('#libSearch'); if (s) s.focus(); }
  }
  $('#mSearch').addEventListener('click', focusSearch);

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
    if (e.key === 'Escape') {
      if (modalClose) { modalClose(); return; }
      if ($('.chord-pop')) { closeChordPop(); return; }
      if (GD()) GD().collapse();
      return;
    }
    if (typing) return;
    if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); focusSearch(); }
  });

  /* ---------------- Language ---------------- */
  I18N.onChange(() => {
    renderShell(); paintMotionBtn();
    if (GD()) GD().relang();
    // ระหว่างแก้เพลงที่ยังไม่บันทึก ห้ามวาดหน้าใหม่ (ข้อความที่พิมพ์จะหาย)
    if (leaveGuard && leaveGuard()) return;
    const y = window.scrollY;
    route(false);
    window.scrollTo(0, y);
  });
  $('#langToggle').addEventListener('click', () => I18N.toggle());
  $('#motionBtn').addEventListener('click', () => setMotion(!motionOn()));
  $('#sideTour').addEventListener('click', () => { if (GD()) { if (curRoute !== 'home') { location.hash = '#/'; setTimeout(() => GD().tour(), 450); } else GD().tour(); } });

  /* ---------------- Service worker ---------------- */
  if ('serviceWorker' in navigator) {
    // updateViaCache:'none' → เบราว์เซอร์ไม่ใช้ HTTP cache ตอนเช็คอัปเดต sw.js
    // พอ SW ตัวใหม่เข้าคุม (controllerchange) ให้รีโหลด 1 ครั้ง — แต่ไม่รีโหลดกลางงานแกะ/ตอนแก้เพลงค้าง
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      if ((Job.st && Job.st.running) || (leaveGuard && leaveGuard())) return;
      reloading = true;
      location.reload();
    });
    window.addEventListener('load', () =>
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then((reg) => { setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); })
        .catch(() => {}));
  }

  // วาดหน้าใหม่ทุกครั้ง (รวมวาดซ้ำหลังลบ/นำเข้า/ล้างคลัง) ต้องปลุก .rise ให้แสดงด้วย ไม่งั้นค้างโปร่งใส
  const withReveal = (fn) => function () { const r = fn.apply(this, arguments); revealIn(); return r; };
  renderHome = withReveal(renderHome); renderJob = withReveal(renderJob); renderLibrary = withReveal(renderLibrary);
  renderSong = withReveal(renderSong); renderChords = withReveal(renderChords); renderEditor = withReveal(renderEditor);
  renderSettings = withReveal(renderSettings);

  /* ---------------- Boot ---------------- */
  window.AppAPI = {
    t, tf, ic, esc, toast, modal, route: () => route(false),
    randomSong() { const all = Store.all(); if (!all.length) return false; location.hash = '#/song/' + all[Math.floor(Math.random() * all.length)].id; return true; },
    focusSearch, get route_() { return curRoute; },
  };
  window.addEventListener('hashchange', onHashChange);
  FX.Sky.init && FX.Sky.init($('#sky'), motionOn());
  renderShell();
  paintMotionBtn();
  if (GD()) GD().init(window.AppAPI);
  route(true);
})();
