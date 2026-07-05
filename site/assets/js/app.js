/* app.js — router + views + wiring */
(function () {
  const t = (k) => I18N.t(k);
  const view = document.getElementById('view');
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  /* ---------------- Toast ---------------- */
  function toast(msg) {
    const root = document.getElementById('toastRoot');
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2400);
  }

  /* ---------------- Modal ---------------- */
  function modal(html, opts) {
    opts = opts || {};
    const root = document.getElementById('modalRoot');
    root.innerHTML = `<div class="modal-overlay"><div class="modal glass">${html}</div></div>`;
    const overlay = root.querySelector('.modal-overlay');
    function close() { root.innerHTML = ''; }
    if (!opts.sticky) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    return { root, close };
  }

  /* ---------------- Copyright gate ---------------- */
  function ensureCopyrightAccepted(then) {
    if (localStorage.getItem('aq.copyright.ok') === '1') { then(); return; }
    const m = modal(`
      <h2>🌊 ${t('copyright.title')}</h2>
      <p>${t('copyright.p1')}</p>
      <ul>
        <li>${t('copyright.li1')}</li>
        <li>${t('copyright.li2')}</li>
        <li>${t('copyright.li3')}</li>
      </ul>
      <div class="modal-actions">
        <button class="btn" id="cpAccept">${t('copyright.accept')}</button>
      </div>`, { sticky: true });
    m.root.querySelector('#cpAccept').addEventListener('click', () => {
      localStorage.setItem('aq.copyright.ok', '1'); m.close(); then();
    });
  }

  /* ---------------- Views ---------------- */
  function renderHome() {
    const recent = Store.all().slice(0, 4);
    view.innerHTML = `
      <section class="card hero reveal">
        <img class="hero-mascot" alt="" aria-hidden="true" decoding="async"
             src="assets/mascot.webp"
             srcset="assets/mascot-sm.webp 381w, assets/mascot.webp 686w"
             sizes="(max-width: 560px) 42vw, 34vw" />
        <img class="hero-logo" src="assets/logo.png" alt="AquaChord" />
        <span class="hero-badge"><span class="dot"></span>${t('hero.badge')}</span>
        <h1>${t('hero.title1')}<br/><span class="grad">${t('hero.title2')}</span></h1>
        <p class="lead">${t('hero.lead')}</p>
      </section>

      <section class="card reveal">
        <div class="ingest">
          <div class="ingest-tabs">
            <button class="ingest-tab active" data-mode="url">${t('ingest.url')}</button>
            <button class="ingest-tab" data-mode="file">${t('ingest.file')}</button>
          </div>
          <div id="ingestUrl" class="field">
            <input type="url" id="urlInput" placeholder="${esc(t('ingest.urlPlaceholder'))}" />
          </div>
          <div id="ingestFile" hidden>
            <div class="dropzone" id="dropzone">
              <svg viewBox="0 0 24 24"><path d="M12 2l4 4h-3v6h-2V6H8zm-7 14v4h14v-4h2v6H3v-6z"/></svg>
              <div>${t('ingest.dropTitle')}</div>
              <div class="muted">${t('ingest.dropHint')}</div>
              <div class="dz-file" id="dzFile" hidden></div>
            </div>
            <input type="file" id="fileInput" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus" hidden />
          </div>
          <button class="btn btn-block" id="startBtn">🎸 ${t('ingest.start')}</button>
          <div class="copyright-hint">
            <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>
            ${t('ingest.copyright')}
          </div>
        </div>
      </section>

      ${recent.length ? `
      <section class="reveal">
        <div class="section-title" style="justify-content:space-between">
          <span>🕒 ${t('recent.title')}</span>
          <a href="#/library" class="chip">${t('recent.viewAll')}</a>
        </div>
        <div class="song-grid" style="margin-top:12px">
          ${recent.map(songItemHTML).join('')}
        </div>
      </section>` : ''}
    `;
    wireIngest();
    wireSongItems();
  }

  let ingestMode = 'url';
  let pickedFile = null;

  function wireIngest() {
    pickedFile = null;
    view.querySelectorAll('.ingest-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        ingestMode = btn.dataset.mode;
        view.querySelectorAll('.ingest-tab').forEach((b) => b.classList.toggle('active', b === btn));
        view.querySelector('#ingestUrl').hidden = ingestMode !== 'url';
        view.querySelector('#ingestFile').hidden = ingestMode !== 'file';
      });
    });
    const dz = view.querySelector('#dropzone');
    const fileInput = view.querySelector('#fileInput');
    const dzFile = view.querySelector('#dzFile');
    if (dz) {
      dz.addEventListener('click', () => fileInput.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('drag');
        if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
    }
    function setFile(f) { pickedFile = f; dzFile.hidden = false; dzFile.textContent = t('ingest.dropFile') + ' ' + f.name; }

    const startBtn = view.querySelector('#startBtn');
    startBtn.addEventListener('click', () => {
      // เปิด AudioContext ใน gesture แรก (iOS)
      try { Music.audioCtx(); } catch (e) {}
      let input;
      if (ingestMode === 'url') {
        const url = view.querySelector('#urlInput').value.trim();
        if (!url) { toast(t('ingest.needInput')); return; }
        if (!/^https?:\/\/.+\..+/.test(url)) { toast(t('ingest.badUrl')); return; }
        input = { kind: 'url', url };
      } else {
        if (!pickedFile) { toast(t('ingest.needInput')); return; }
        input = { kind: 'file', name: pickedFile.name };
      }
      ensureCopyrightAccepted(() => startJob(input));
    });
  }

  /* ---------------- Job progress ---------------- */
  function startJob(input) {
    const controller = { aborted: false };
    view.innerHTML = `
      <section class="card job reveal">
        <div class="section-title">🌀 <span id="jobTitle">${t('job.title')}</span></div>
        <div class="progress-bar"><div class="progress-fill" id="jobFill"></div></div>
        <div class="job-stages" id="jobStages">
          ${Demo.STAGES.map((s) => `
            <div class="stage-row" data-stage="${s}">
              <div class="stage-dot">${stageIcon(s)}</div>
              <div class="stage-label">${t('job.stage.' + s)}</div>
            </div>`).join('')}
        </div>
        <div class="muted" style="text-align:center">${t('job.demoNote')}</div>
        <button class="btn-ghost btn-block" id="jobCancel">${t('job.cancel')}</button>
      </section>`;

    const fill = view.querySelector('#jobFill');
    const stagesEl = view.querySelector('#jobStages');
    view.querySelector('#jobCancel').addEventListener('click', () => {
      controller.aborted = true; location.hash = '#/';
    });

    function onProgress(p) {
      if (controller.aborted) return;
      fill.style.width = p.percent + '%';
      const rows = stagesEl.querySelectorAll('.stage-row');
      const idx = Demo.STAGES.indexOf(p.stage);
      rows.forEach((r, i) => {
        r.classList.toggle('active', i === idx && p.stage !== 'done');
        r.classList.toggle('done', p.stage === 'done' ? true : i < idx);
      });
      if (p.stage === 'done') { view.querySelector('#jobTitle').textContent = t('job.done'); }
    }

    Demo.runFakePipeline(input, onProgress, controller)
      .then((doc) => {
        if (controller.aborted) return;
        Store.upsert(doc);
        toast(t('job.done'));
        location.hash = '#/song/' + doc.id;
      })
      .catch(() => { /* cancelled */ });
  }

  function stageIcon(s) {
    const map = { ingest:'⬇', separate:'🎚', chords:'🎵', lyrics:'✎', tabs:'🎸', assemble:'📄' };
    return `<span style="font-size:13px">${map[s] || '•'}</span>`;
  }

  /* ---------------- Library ---------------- */
  let libFilter = 'all', libQuery = '';
  function renderLibrary() {
    let songs = Store.all();
    if (libFilter === 'fav') songs = songs.filter((s) => s.favorite);
    if (libQuery) {
      const q = libQuery.toLowerCase();
      songs = songs.filter((s) =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.artist || '').toLowerCase().includes(q) ||
        (s.creator || '').toLowerCase().includes(q));
    }
    view.innerHTML = `
      <section class="reveal">
        <div class="section-title">📚 ${t('library.title')} <span class="chip">${Store.count()} ${t('library.count')}</span></div>
      </section>
      <section class="card reveal">
        <div class="field"><input type="text" id="libSearch" placeholder="${esc(t('library.search'))}" value="${esc(libQuery)}" /></div>
        <div class="ingest-tabs" style="margin-top:12px">
          <button class="ingest-tab ${libFilter==='all'?'active':''}" data-f="all">${t('library.all')}</button>
          <button class="ingest-tab ${libFilter==='fav'?'active':''}" data-f="fav">⭐ ${t('library.fav')}</button>
        </div>
      </section>
      ${songs.length ? `
        <section class="song-grid reveal">${songs.map(songItemHTML).join('')}</section>
      ` : emptyLibraryHTML()}
    `;
    const search = view.querySelector('#libSearch');
    let deb;
    search.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { libQuery = search.value; renderLibrary(); const s = view.querySelector('#libSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 200); });
    view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { libFilter = b.dataset.f; renderLibrary(); }));
    wireSongItems();
  }

  function emptyLibraryHTML() {
    return `<section class="card empty reveal">
      <div class="empty-emoji">🫧</div>
      <h3>${t('library.empty.title')}</h3>
      <p class="muted">${t('library.empty.desc')}</p>
      <a href="#/" class="btn" style="margin-top:14px">🎸 ${t('library.empty.cta')}</a>
    </section>`;
  }

  function songItemHTML(s) {
    const initial = (s.title || '?').trim()[0] || '♪';
    const sub = [s.artist, s.creator ? (t('library.by') + ' ' + s.creator) : null].filter(Boolean).join(' · ');
    return `<a class="song-item" href="#/song/${s.id}">
      <div class="song-thumb">${esc(initial.toUpperCase())}</div>
      <div class="song-meta">
        <div class="song-title">${esc(s.title)}</div>
        <div class="song-sub">${esc(sub) || '&nbsp;'}${s.key ? ' · ' + esc(s.key) : ''}${s.playCount ? ' · ' + s.playCount + ' ' + t('library.plays') : ''}</div>
      </div>
      <button class="song-fav ${s.favorite?'on':''}" data-fav="${s.id}" aria-label="favorite">${s.favorite ? '★' : '☆'}</button>
    </a>`;
  }

  function wireSongItems() {
    view.querySelectorAll('[data-fav]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const on = Store.toggleFav(btn.dataset.fav);
        btn.classList.toggle('on', !!on); btn.textContent = on ? '★' : '☆';
      });
    });
  }

  /* ---------------- Song view ---------------- */
  const songState = {}; // per id: {steps, capo, size, scroll}
  function renderSong(id) {
    const song = Store.get(id);
    if (!song) {
      view.innerHTML = `<section class="card empty reveal"><div class="empty-emoji">🌫️</div><h3>${t('song.notFound')}</h3><a href="#/library" class="btn" style="margin-top:12px">${t('common.back')}</a></section>`;
      return;
    }
    Store.markPlayed(id);
    const st = songState[id] || (songState[id] = { steps: 0, capo: song.capo || 0, size: 1.02, scroll: false });

    function paint() {
      const dispKey = song.key ? Music.transposeKey(song.key, st.steps) : null;
      view.innerHTML = `
        <section class="card reveal">
          <div class="song-head">
            <div class="song-thumb">${esc((song.title||'?')[0].toUpperCase())}</div>
            <div style="flex:1;min-width:0">
              <h1>${esc(song.title)}</h1>
              <div class="song-sub muted">${esc([song.artist, song.creator?(t('library.by')+' '+song.creator):''].filter(Boolean).join(' · '))}</div>
            </div>
            <button class="song-fav ${song.favorite?'on':''}" data-fav="${song.id}" style="font-size:1.6rem">${song.favorite?'★':'☆'}</button>
          </div>

          <div class="toolbar">
            <span class="tool">${t('song.transpose')}
              <button data-act="key-">−</button>
              <span class="val">${dispKey || (st.steps>0?'+'+st.steps:st.steps)}</span>
              <button data-act="key+">+</button>
            </span>
            <span class="tool">${t('song.capo')}
              <button data-act="capo-">−</button><span class="val">${st.capo}</span><button data-act="capo+">+</button>
            </span>
            <span class="tool">A
              <button data-act="size-">−</button><button data-act="size+">+</button>
            </span>
            <button class="tool" data-act="scroll" style="cursor:pointer">${st.scroll?'⏸':'▶'} ${t('song.scroll')}</button>
          </div>
          <div class="muted" style="font-size:.78rem;margin-top:8px">💡 ${t('song.tapHint')}</div>

          <div class="chordsheet" id="sheet" style="--sheet-size:${st.size}rem">
            ${ChordPro.render(song.chordpro, { steps: st.steps, keyHint: dispKey })}
          </div>

          <div class="sheet-actions">
            <button class="btn btn-sm" data-act="strum">🎶 ${t('song.strum')}</button>
            <a class="btn-ghost btn-sm" href="#/edit/${song.id}">✎ ${t('song.edit')}</a>
            ${st.steps ? `<button class="btn-ghost btn-sm" data-act="reset">↺ ${t('song.original')}</button>` : ''}
          </div>
        </section>`;

      // fav
      const fav = view.querySelector('[data-fav]');
      fav.addEventListener('click', () => { const on = Store.toggleFav(song.id); song.favorite = on; fav.classList.toggle('on', !!on); fav.textContent = on?'★':'☆'; });

      // toolbar actions
      view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'key+') st.steps++;
        else if (a === 'key-') st.steps--;
        else if (a === 'reset') st.steps = 0;
        else if (a === 'capo+') st.capo = Math.min(11, st.capo + 1);
        else if (a === 'capo-') st.capo = Math.max(0, st.capo - 1);
        else if (a === 'size+') st.size = Math.min(1.6, +(st.size + 0.08).toFixed(2));
        else if (a === 'size-') st.size = Math.max(0.8, +(st.size - 0.08).toFixed(2));
        else if (a === 'scroll') { st.scroll = !st.scroll; toggleScroll(); return; }
        else if (a === 'strum') { strumWholeSong(); return; }
        paint();
      }));

      // tap chord -> sound + diagram
      view.querySelectorAll('.seg-chord').forEach((el) => {
        const chord = el.dataset.chord;
        if (!chord) return;
        el.addEventListener('click', (e) => {
          Music.playChord(chord);
          el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring');
          showDiagram(el, chord);
        });
      });

      if (st.scroll) toggleScroll(true);
    }

    let scrollRAF = 0;
    function toggleScroll(force) {
      const on = force != null ? force : st.scroll;
      cancelAnimationFrame(scrollRAF);
      if (!on) return;
      let last = performance.now();
      const speed = 26; // px/s
      const step = (now) => {
        if (location.hash !== '#/song/' + id) { cancelAnimationFrame(scrollRAF); return; }
        window.scrollBy(0, ((now - last) / 1000) * speed); last = now;
        scrollRAF = requestAnimationFrame(step);
      };
      scrollRAF = requestAnimationFrame(step);
    }

    function strumWholeSong() {
      const { lines } = ChordPro.parse(song.chordpro);
      let delay = 0;
      lines.forEach((ln) => {
        if (ln.type !== 'line') return;
        ln.segs.forEach((s) => {
          if (s.chord && Music.isChord(s.chord)) {
            const disp = st.steps ? Music.transposeChord(s.chord, st.steps, song.key) : s.chord;
            const midis = Music.chordToMidis(disp);
            midis.forEach((m, i) => Music.pluck(m, delay + i * 0.03, 1.6, 0.24));
            delay += 0.5;
          }
        });
      });
    }

    paint();
  }

  function showDiagram(anchor, chord) {
    const old = document.querySelector('.sheet-chord-pop');
    if (old) old.remove();
    const pop = document.createElement('div');
    pop.className = 'sheet-chord-pop';
    pop.innerHTML = `<div class="diagram-card">
      <div class="dc-name">${esc(chord)}</div>
      ${Music.diagramSVG(chord)}
      <button class="btn btn-sm dc-play">▶</button>
    </div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = 140, ph = 190;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - pw - 10));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight) top = r.top - ph - 8;
    pop.style.left = left + 'px'; pop.style.top = Math.max(10, top) + 'px';
    pop.querySelector('.dc-play').addEventListener('click', (e) => { e.stopPropagation(); Music.playChord(chord); });
    setTimeout(() => {
      document.addEventListener('click', function h(ev) {
        if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', h); }
      });
    }, 10);
  }

  /* ---------------- Editor ---------------- */
  function renderEditor(id) {
    const isNew = id === 'new';
    const song = isNew ? { id: Store.uid(), title: '', artist: '', creator: '', key: 'C', chordpro: '{title: }\n\n[C] [G] [Am] [F]\n' } : Store.get(id);
    if (!song) { location.hash = '#/library'; return; }
    const orig = JSON.stringify(song);

    view.innerHTML = `
      <section class="card reveal">
        <div class="section-title">✎ ${isNew ? t('editor.new') : t('editor.title')}</div>
        <div class="editor-meta" style="margin-top:14px">
          <div class="full"><label>${t('editor.songTitle')}</label><input id="eTitle" value="${esc(song.title)}" /></div>
          <div><label>${t('editor.artist')}</label><input id="eArtist" value="${esc(song.artist||'')}" /></div>
          <div><label>${t('editor.creator')}</label><input id="eCreator" value="${esc(song.creator||'')}" /></div>
          <div><label>${t('editor.key')}</label><input id="eKey" value="${esc(song.key||'')}" /></div>
        </div>
        <label style="font-size:.78rem;color:var(--ink-faint);font-weight:600;display:block;margin-bottom:4px">${t('editor.body')}</label>
        <div class="muted" style="font-size:.78rem;margin-bottom:8px">💡 ${t('editor.help')}</div>
        <div class="editor-split">
          <textarea class="editor-body" id="eBody" spellcheck="false">${esc(song.chordpro||'')}</textarea>
          <div>
            <div class="muted" style="font-size:.78rem;margin-bottom:6px">${t('editor.preview')}</div>
            <div class="chordsheet" id="ePreview" style="--sheet-size:.98rem"></div>
          </div>
        </div>
        <div class="sheet-actions">
          <button class="btn" id="eSave">💾 ${t('editor.save')}</button>
          <button class="btn-ghost" id="eBack">${t('common.back')}</button>
        </div>
      </section>`;

    const body = view.querySelector('#eBody');
    const preview = view.querySelector('#ePreview');
    let deb;
    function renderPreview() { preview.innerHTML = ChordPro.render(body.value, {}); }
    renderPreview();
    body.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(renderPreview, 150); });

    view.querySelector('#eSave').addEventListener('click', () => {
      song.title = view.querySelector('#eTitle').value.trim() || 'Untitled';
      song.artist = view.querySelector('#eArtist').value.trim();
      song.creator = view.querySelector('#eCreator').value.trim();
      song.key = view.querySelector('#eKey').value.trim();
      song.chordpro = body.value;
      song.schemaVersion = 1;
      Store.upsert(song);
      toast(t('editor.saved'));
      location.hash = '#/song/' + song.id;
    });
    view.querySelector('#eBack').addEventListener('click', () => {
      const changed = JSON.stringify(Object.assign({}, song, {
        title: view.querySelector('#eTitle').value, artist: view.querySelector('#eArtist').value,
        creator: view.querySelector('#eCreator').value, key: view.querySelector('#eKey').value, chordpro: body.value,
      })) !== orig;
      if (changed && !confirm(t('editor.leaveConfirm'))) return;
      history.back();
    });
  }

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    view.innerHTML = `
      <section class="reveal"><div class="section-title">⚙️ ${t('settings.title')}</div></section>

      <section class="card reveal">
        <div class="setting-row">
          <div><div class="sr-label">${t('settings.language')}</div><div class="sr-desc">${t('settings.languageDesc')}</div></div>
          <div class="switch-lang">
            <button data-lang="th" class="${I18N.get()==='th'?'active':''}">ไทย</button>
            <button data-lang="en" class="${I18N.get()==='en'?'active':''}">EN</button>
          </div>
        </div>
      </section>

      <section class="card reveal">
        <div class="section-title" style="font-size:1rem">💾 ${t('settings.data')}</div>
        <div class="setting-row">
          <div><div class="sr-label">${t('settings.export')}</div><div class="sr-desc">${t('settings.exportDesc')}</div></div>
          <button class="btn-ghost btn-sm" id="exportBtn">↓</button>
        </div>
        <div class="setting-row">
          <div><div class="sr-label">${t('settings.import')}</div><div class="sr-desc">${t('settings.importDesc')}</div></div>
          <button class="btn-ghost btn-sm" id="importBtn">↑</button>
          <input type="file" id="importFile" accept=".json,application/json" hidden />
        </div>
      </section>

      <section class="card reveal">
        <div class="section-title" style="font-size:1rem">ℹ️ ${t('settings.about')}</div>
        <div class="setting-row">
          <div><div class="sr-label">${t('settings.copyright')}</div><div class="sr-desc">${t('settings.copyrightDesc')}</div></div>
          <button class="btn-ghost btn-sm" id="cpBtn">→</button>
        </div>
        <div class="setting-row">
          <div class="sr-label">${t('settings.version')}</div>
          <div class="muted" id="appVersion">AquaChord</div>
        </div>
      </section>`;

    view.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => I18N.setLang(b.dataset.lang)));
    view.querySelector('#exportBtn').addEventListener('click', () => {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'aquachord-' + Date.now() + '.aquachord.json'; a.click();
      toast(t('settings.exported'));
    });
    const importFile = view.querySelector('#importFile');
    view.querySelector('#importBtn').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
      const f = importFile.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { try { const n = Store.importJSON(rd.result); toast(t('settings.imported') + ' (' + n + ')'); } catch (e) { toast('✕'); } };
      rd.readAsText(f);
    });
    view.querySelector('#cpBtn').addEventListener('click', () => {
      modal(`<h2>🌊 ${t('copyright.title')}</h2><p>${t('copyright.p1')}</p>
        <ul><li>${t('copyright.li1')}</li><li>${t('copyright.li2')}</li><li>${t('copyright.li3')}</li></ul>
        <div class="modal-actions"><button class="btn" onclick="document.getElementById('modalRoot').innerHTML=''">${t('common.close')}</button></div>`);
    });
    fetch('version.json', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
      const e = view.querySelector('#appVersion');
      if (e) e.textContent = 'AquaChord v' + v.version + (v.sha && v.sha !== 'dev' ? ' · ' + v.sha : '');
    }).catch(() => {});
  }

  /* ---------------- Router ---------------- */
  function route() {
    const hash = location.hash || '#/';
    const parts = hash.replace(/^#\//, '').split('/');
    window.scrollTo(0, 0);
    document.querySelectorAll('.tab').forEach((tb) => tb.classList.remove('active'));
    if (parts[0] === '' ) { setTab('home'); renderHome(); }
    else if (parts[0] === 'library') { setTab('library'); renderLibrary(); }
    else if (parts[0] === 'settings') { setTab('settings'); renderSettings(); }
    else if (parts[0] === 'song') { renderSong(parts[1]); }
    else if (parts[0] === 'edit') { renderEditor(parts[1]); }
    else { setTab('home'); renderHome(); }
  }
  function setTab(name) {
    const tb = document.querySelector('.tab[data-route="' + name + '"]');
    if (tb) tb.classList.add('active');
  }

  /* ---------------- Language reactivity ---------------- */
  I18N.onChange(() => { route(); });
  document.getElementById('langToggle').addEventListener('click', () => I18N.toggle());

  /* ---------------- Theme (dark mode) ---------------- */
  function setTheme(th) {
    document.documentElement.setAttribute('data-theme', th);
    localStorage.setItem('aq.theme', th);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', th === 'dark' ? '#0a1622' : '#0d9488');
  }
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', () =>
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  /* ---------------- PWA install ---------------- */
  let deferredPrompt = null;
  const installBtn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false; });
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt(); await deferredPrompt.userChoice;
    deferredPrompt = null; installBtn.hidden = true; toast(t('toast.installed'));
  });
  window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

  /* ---------------- Bubbles background ---------------- */
  (function bubbles() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = document.getElementById('bubbles');
    const ctx = canvas.getContext('2d');
    let W, H, dpr, arr = [];
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.width = innerWidth * dpr; H = canvas.height = innerHeight * dpr;
      canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
      const n = Math.min(46, Math.floor(innerWidth / 26));
      arr = Array.from({ length: n }, spawn);
    }
    function spawn() {
      const r = (6 + Math.random() * 26) * dpr;
      return { x: Math.random() * W, y: H + Math.random() * H, r, sp: (0.2 + Math.random() * 0.7) * dpr, wob: Math.random() * Math.PI * 2, wr: 0.3 + Math.random() * 0.6, a: 0.05 + Math.random() * 0.18 };
    }
    function draw() {
      if (document.hidden) { raf = requestAnimationFrame(draw); return; }
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      ctx.clearRect(0, 0, W, H);
      // โหมดมืด: blend แบบบวก → ฟองม่วงเรืองแสงซ้อนกันเป็นแสงบลูม
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      arr.forEach((b) => {
        b.y -= b.sp; b.wob += 0.01; b.x += Math.sin(b.wob) * b.wr;
        if (b.y + b.r < 0) Object.assign(b, spawn(), { y: H + b.r });
        const g = ctx.createRadialGradient(b.x - b.r*0.3, b.y - b.r*0.3, b.r*0.1, b.x, b.y, b.r);
        if (dark) {
          g.addColorStop(0, `rgba(224,195,255,${b.a + 0.30})`);
          g.addColorStop(0.45, `rgba(168,85,247,${b.a + 0.12})`);
          g.addColorStop(1, `rgba(124,58,237,0)`);
        } else {
          g.addColorStop(0, `rgba(255,255,255,${b.a + 0.15})`);
          g.addColorStop(0.6, `rgba(94,234,212,${b.a})`);
          g.addColorStop(1, `rgba(13,148,136,0)`);
        }
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); ctx.arc(b.x - b.r*0.32, b.y - b.r*0.32, b.r*0.18, 0, 7);
        ctx.fillStyle = dark ? `rgba(236,220,255,${b.a + 0.30})` : `rgba(255,255,255,${b.a + 0.25})`;
        ctx.fill();
      });
      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(draw);
    }
    let raf; resize(); draw();
    addEventListener('resize', resize);
  })();

  /* ---------------- Service worker ---------------- */
  if ('serviceWorker' in navigator) {
    // updateViaCache:'none' → เบราว์เซอร์ไม่ใช้ HTTP cache ตอนเช็คอัปเดต sw.js (อัปเดตไว ไม่ค้างของเก่า)
    window.addEventListener('load', () =>
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
  }

  /* ---------------- Boot ---------------- */
  window.addEventListener('hashchange', route);
  I18N.applyStatic();
  route();
})();
