/* notation-editor.js — หน้า "ทำโน้ต" (#/notes/<songId> | #/notes/new) แก้ทำนอง SongDoc.melody แบบแตะบนมือถือ
   โมเดลแก้ไข: โน้ตเรียงต่อกันเป็นแถว (ตัวหยุด = p:null) → เวลา t คำนวณจากผลรวมความยาว (ไม่มีช่องโหว่/ซ้อนกัน)
   เคอร์เซอร์ = index โน้ตที่เลือก หรือ seq.length = "ต่อท้าย" (กดคีย์เปียโนแล้วเพิ่มโน้ตใหม่)
   ร่างที่ยังไม่บันทึกอยู่ในหน่วยความจำ — ออกด้วยปุ่ม back ของเครื่องแล้วกลับมาได้ (กู้คืนให้) */
(function () {
  'use strict';
  if (!window.Notation || !window.Store) return;
  const N = window.Notation;
  const t = (k) => I18N.t(k);
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const isNum = (x) => typeof x === 'number' && isFinite(x);

  const TS_OPTS = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [9, 8], [12, 8], [2, 2]];
  const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F',
    'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm'];
  const DURS = [
    { d: 4, k: 'whole' }, { d: 2, k: 'half' }, { d: 1, k: 'quarter' }, { d: 0.5, k: 'eighth' }, { d: 0.25, k: 'sixteenth' },
  ];
  const DOT = { 2: 3, 1: 1.5, 0.5: 0.75 };
  const UNDOT = { 3: 2, 1.5: 1, 0.75: 0.5 };
  const MIN_P = 21, MAX_P = 108;          // ช่วงเปียโน A0..C8
  const HIST_MAX = 80;
  const HIST_CHARS = 6e6;                 // เพดานหน่วยความจำของ undo (~6 MB ตัวอักษร)

  let session = null;   // ร่างที่กำลังแก้ (คงอยู่ข้ามการเปลี่ยนหน้า จนบันทึก/ยืนยันทิ้ง)
  let ui = null;        // ของที่ผูกกับ DOM ปัจจุบัน (ล้างเมื่อออกจากหน้า)
  let lastEdited = null;

  /* ---------------- แปลง melody ↔ แถวโน้ต ---------------- */
  function fromStored(melody) {
    const m = Store.cleanMelody(melody) || { name: 'ทำนองร้อง', timeSig: [4, 4], notes: [] };
    const meta = {
      name: m.name || 'ทำนองร้อง', timeSig: m.timeSig, keySig: m.keySig || null,
      tempo: isNum(m.tempo) ? m.tempo : null, pickup: m.pickup || 0,
    };
    const seq = [];
    let time = -meta.pickup;
    if (m.notes.length && m.notes[0].t < time) { meta.pickup = -m.notes[0].t; time = m.notes[0].t; }
    m.notes.forEach((n) => {
      if (n.t > time + 1e-9) { seq.push({ d: n.t - time, p: null }); time = n.t; }
      else if (n.t < time - 1e-9) {
        const prev = seq[seq.length - 1];
        const cut = time - n.t;
        if (prev && prev.d - cut >= 0.25) { prev.d -= cut; time = n.t; }
        else return; // ซ้อนทับทั้งตัว → ข้าม
      }
      const o = { d: n.d, p: n.p };
      if (n.syl) o.syl = n.syl;
      if (n.chord) o.chord = n.chord;
      if (n.tie) o.tie = true;
      seq.push(o);
      time += n.d;
    });
    return { meta, seq };
  }

  function toStored(s, trimRests) {
    const meta = s.meta;
    let seq = s.seq;
    if (trimRests) { let k = seq.length; while (k > 0 && seq[k - 1].p == null) k--; seq = seq.slice(0, k); }
    const notes = [];
    let time = -meta.pickup;
    seq.forEach((n) => {
      const o = { t: Math.round(time * 4) / 4, d: n.d, p: n.p };
      if (n.syl && n.p != null) o.syl = n.syl;
      if (n.chord) o.chord = n.chord;
      if (n.tie && n.p != null) o.tie = true;
      notes.push(o);
      time += n.d;
    });
    const m = { name: meta.name || 'ทำนองร้อง', timeSig: meta.timeSig.slice(), notes };
    if (meta.keySig) m.keySig = meta.keySig;
    if (meta.tempo) m.tempo = meta.tempo;
    if (meta.pickup) m.pickup = meta.pickup;
    return m;
  }

  /* ---------------- session / history ---------------- */
  function makeSession(song, isNew) {
    const st = fromStored(song.melody);
    if (!st.meta.keySig) st.meta.keySig = (song.key && /^[A-G][#b]?m?$/.test(song.key)) ? song.key : 'C';
    if (!st.meta.tempo) {
      const tp = parseFloat(song.tempo || song.bpm);
      st.meta.tempo = isNum(tp) && tp >= 30 && tp <= 240 ? Math.round(tp) : 90;
    }
    return {
      songId: isNew ? 'new' : song.id, isNew, song, title: song.title || '', origTitle: song.title || '',
      meta: st.meta, seq: st.seq, cur: st.seq.length,
      dur: 1, dotted: false, octave: 4, insert: false, tab: 'notes',
      hist: [], histChars: 0, fut: [], dirty: false, active: false,
      orig: JSON.stringify(toStored(st, true)),
    };
  }
  function snapshot() { return JSON.stringify({ meta: session.meta, seq: session.seq, cur: session.cur }); }
  function pushHist() {
    const s = snapshot();
    session.hist.push(s); session.histChars += s.length;
    while (session.hist.length > HIST_MAX || (session.histChars > HIST_CHARS && session.hist.length > 1)) {
      session.histChars -= session.hist.shift().length;
    }
    session.fut = [];
  }
  function restore(s) {
    const o = JSON.parse(s);
    session.meta = o.meta; session.seq = o.seq; session.cur = clamp(o.cur, 0, o.seq.length);
  }
  function undo() {
    if (!session.hist.length) return;
    session.fut.push(snapshot());
    const s = session.hist.pop(); session.histChars -= s.length;
    restore(s); changed();
  }
  function redo() {
    if (!session.fut.length) return;
    const s = session.fut.pop();
    session.hist.push(snapshot()); session.histChars += session.hist[session.hist.length - 1].length;
    restore(s); changed();
  }
  function isDirty() {
    if (!session) return false;
    if (session.isNew && (session.title || '').trim() !== (session.origTitle || '').trim()) return true;
    return JSON.stringify(toStored(session, true)) !== session.orig;
  }

  /* ---------------- ไอคอนโน้ต (SVG ง่าย ๆ — ไม่พึ่งฟอนต์สัญลักษณ์ดนตรีที่มือถือบางรุ่นไม่มี) ---------------- */
  function durIcon(k) {
    const head = (fill) => `<ellipse cx="10" cy="17" rx="5.2" ry="3.8" transform="rotate(-22 10 17)" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8"/>`;
    const stem = '<line x1="14.6" y1="16" x2="14.6" y2="3" stroke="currentColor" stroke-width="1.8"/>';
    const flag = (y) => `<path d="M14.6 ${y} q6 3 4.5 9" fill="none" stroke="currentColor" stroke-width="1.8"/>`;
    const body = {
      whole: head(false),
      half: head(false) + stem,
      quarter: head(true) + stem,
      eighth: head(true) + stem + flag(3),
      sixteenth: head(true) + stem + flag(3) + flag(7.5),
      rest: '<path d="M9 3l5 5-4 4 5 5c-3-1.5-6-.5-4 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    }[k];
    return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${body}</svg>`;
  }

  /* ---------------- เปิดหน้า ---------------- */
  function open(view, id) {
    const wasActive = !!(ui && session && session.active); // วาดใหม่เพราะเปลี่ยนภาษา → ต่อเงียบ ๆ
    teardown();
    id = String(id || '');
    const isNew = id === 'new';
    let restored = false;
    if (session && session.songId === id && (session.dirty || wasActive)) {
      restored = session.dirty && !wasActive;
    } else {
      const song = isNew ? newSong() : Store.get(id);
      if (!song) {
        view.innerHTML = `<section class="card empty reveal"><div class="empty-emoji">🌫️</div><h3>${esc(t('song.notFound'))}</h3><a href="#/library" class="btn" style="margin-top:12px">${esc(t('common.back'))}</a></section>`;
        return;
      }
      session = makeSession(song, isNew);
    }
    session.active = true;
    build(view);
    if (restored) toast(t('ne.restored'));
  }

  function newSong() {
    return { id: Store.uid(), title: '', artist: '', creator: '', key: 'C', chordpro: '', tabs: [] };
  }

  function barBeats() { const ts = session.meta.timeSig; return ts[0] * 4 / ts[1]; }
  function effDur() { return session.dotted && DOT[session.dur] ? DOT[session.dur] : session.dur; }
  function timeAt(idx) { let x = -session.meta.pickup; for (let i = 0; i < idx && i < session.seq.length; i++) x += session.seq[i].d; return x; }

  function build(view) {
    const s = session;
    const tsOpt = TS_OPTS.map((ts) => `<option value="${ts[0]}/${ts[1]}" ${ts[0] === s.meta.timeSig[0] && ts[1] === s.meta.timeSig[1] ? 'selected' : ''}>${ts[0]}/${ts[1]}</option>`).join('');
    const keyOpt = KEYS.map((k) => `<option value="${k}" ${k === s.meta.keySig ? 'selected' : ''}>${k}${k.endsWith('m') ? ' (' + esc(t('ne.minor')) + ')' : ''}</option>`).join('')
      + (KEYS.indexOf(s.meta.keySig) < 0 ? `<option value="${esc(s.meta.keySig)}" selected>${esc(s.meta.keySig)}</option>` : '');
    view.innerHTML = `
      <section class="card reveal ne">
        <div class="ne-head">
          <button type="button" class="btn-ghost btn-sm" id="neBack">← ${esc(t('common.back'))}</button>
          <div class="ne-htitle">
            <div class="section-title">🎼 ${esc(t('ne.title'))}</div>
            ${s.isNew ? '' : `<div class="muted ne-song">${esc(s.title)}</div>`}
          </div>
          <button type="button" class="btn btn-sm" id="neSave">💾 ${esc(t('editor.save'))}</button>
        </div>
        ${s.isNew ? `<div class="field ne-titlef"><input type="text" id="neTitle" maxlength="120" placeholder="${esc(t('ne.songTitle'))}" value="${esc(s.title)}" /></div>` : ''}
        <details class="ne-settings" ${s.seq.length ? '' : 'open'}>
          <summary>⚙️ ${esc(t('ne.settings'))} · <span id="neSetSum"></span></summary>
          <div class="ne-set-grid">
            <label>${esc(t('ne.timeSig'))}<select id="neTs">${tsOpt}</select></label>
            <label>${esc(t('editor.key'))}<select id="neKey">${keyOpt}</select></label>
            <label>${esc(t('ne.tempo'))}<input type="number" id="neTempo" min="30" max="240" step="1" inputmode="numeric" value="${esc(s.meta.tempo)}" /></label>
            <label>${esc(t('ne.pickup'))}<select id="nePickup"></select></label>
          </div>
        </details>
        <div class="ingest-tabs ne-tabs" role="tablist">
          <button type="button" class="ingest-tab ${s.tab === 'notes' ? 'active' : ''}" data-netab="notes">🎵 ${esc(t('ne.tabNotes'))}</button>
          <button type="button" class="ingest-tab ${s.tab === 'abc' ? 'active' : ''}" data-netab="abc">⌨ ${esc(t('ne.tabAbc'))}</button>
        </div>
        <div id="nePaneNotes" ${s.tab === 'notes' ? '' : 'hidden'}>
          <div class="ne-staff"></div>
          <div class="ne-status" id="neStatus" aria-live="polite"></div>
          <div class="ne-fields">
            <label class="ne-f-syl">${esc(t('ne.syl'))}
              <span class="ne-inrow"><input type="text" id="neSyl" maxlength="24" autocomplete="off" enterkeyhint="next" placeholder="${esc(t('ne.sylPh'))}" />
              <button type="button" class="btn-ghost btn-sm" id="neSylNext" aria-label="${esc(t('ne.next'))}">▶</button></span>
            </label>
            <label class="ne-f-chord">${esc(t('ne.chord'))}
              <input type="text" id="neChord" maxlength="16" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Am7" />
            </label>
          </div>
          <div class="ne-palette" role="toolbar" aria-label="${esc(t('ne.durations'))}">
            ${DURS.map((x) => `<button type="button" class="ne-btn" data-dur="${x.d}" title="${esc(t('ne.dur.' + x.k))}">${durIcon(x.k)}<span>${esc(t('ne.dur.' + x.k))}</span></button>`).join('')}
            <button type="button" class="ne-btn" data-act="dot" title="${esc(t('ne.dotted'))}"><b class="ne-glyph">♩.</b><span>${esc(t('ne.dotted'))}</span></button>
            <button type="button" class="ne-btn" data-act="rest" title="${esc(t('ne.rest'))}">${durIcon('rest')}<span>${esc(t('ne.rest'))}</span></button>
          </div>
          <div class="ne-palette ne-tools" role="toolbar" aria-label="${esc(t('ne.tools'))}">
            <button type="button" class="ne-btn" data-act="left" title="${esc(t('ne.prev'))}"><b class="ne-glyph">◀</b><span>${esc(t('ne.prev'))}</span></button>
            <button type="button" class="ne-btn" data-act="right" title="${esc(t('ne.next'))}"><b class="ne-glyph">▶</b><span>${esc(t('ne.next'))}</span></button>
            <button type="button" class="ne-btn" data-act="sharp" title="${esc(t('ne.sharp'))}"><b class="ne-glyph">♯</b><span>${esc(t('ne.sharp'))}</span></button>
            <button type="button" class="ne-btn" data-act="flat" title="${esc(t('ne.flat'))}"><b class="ne-glyph">♭</b><span>${esc(t('ne.flat'))}</span></button>
            <button type="button" class="ne-btn" data-act="up" title="${esc(t('ne.octUp'))}"><b class="ne-glyph">8↑</b><span>${esc(t('ne.octUp'))}</span></button>
            <button type="button" class="ne-btn" data-act="down" title="${esc(t('ne.octDown'))}"><b class="ne-glyph">8↓</b><span>${esc(t('ne.octDown'))}</span></button>
            <button type="button" class="ne-btn" data-act="tie" title="${esc(t('ne.tie'))}"><b class="ne-glyph">⁀</b><span>${esc(t('ne.tie'))}</span></button>
            <button type="button" class="ne-btn" data-act="insert" title="${esc(t('ne.insert'))}"><b class="ne-glyph">⤵</b><span>${esc(t('ne.insert'))}</span></button>
            <button type="button" class="ne-btn" data-act="del" title="${esc(t('ne.delete'))}"><b class="ne-glyph">⌫</b><span>${esc(t('ne.delete'))}</span></button>
            <button type="button" class="ne-btn" data-act="undo" title="${esc(t('ne.undo'))}"><b class="ne-glyph">↶</b><span>${esc(t('ne.undo'))}</span></button>
            <button type="button" class="ne-btn" data-act="redo" title="${esc(t('ne.redo'))}"><b class="ne-glyph">↷</b><span>${esc(t('ne.redo'))}</span></button>
            <button type="button" class="ne-btn ne-play" data-act="play" title="${esc(t('ne.playFrom'))}"><b class="ne-glyph">▶</b><span>${esc(t('ne.play'))}</span></button>
          </div>
          <div class="ne-kbd-bar">
            <button type="button" class="btn-ghost btn-sm" data-act="kbdDown" aria-label="${esc(t('ne.kbdLower'))}">◀</button>
            <span id="neKbdRange" class="muted"></span>
            <button type="button" class="btn-ghost btn-sm" data-act="kbdUp" aria-label="${esc(t('ne.kbdHigher'))}">▶</button>
          </div>
          <div class="ne-kbd" id="neKbd"></div>
          <div class="muted ne-help">💡 ${esc(t('ne.help'))}<span class="ne-keys"> · ${esc(t('ne.shortcuts'))}</span></div>
        </div>
        <div id="nePaneAbc" ${s.tab === 'abc' ? '' : 'hidden'}>
          <div class="muted ne-help">${esc(t('ne.abcHelp'))}</div>
          <textarea class="editor-body ne-abc" id="neAbc" spellcheck="false" readonly></textarea>
          <div class="sheet-actions">
            <button type="button" class="btn-ghost btn-sm" id="neAbcCopy">📋 ${esc(t('ne.copy'))}</button>
            <button type="button" class="btn-ghost btn-sm" id="neAbcEdit">✎ ${esc(t('ne.abcEdit'))}</button>
            <button type="button" class="btn btn-sm" id="neAbcApply" hidden>✓ ${esc(t('ne.abcApply'))}</button>
          </div>
        </div>
      </section>`;

    const root = view.querySelector('.ne');
    ui = {
      root, view,
      staff: root.querySelector('.ne-staff'),
      status: root.querySelector('#neStatus'),
      syl: root.querySelector('#neSyl'),
      chord: root.querySelector('#neChord'),
      kbd: root.querySelector('#neKbd'),
      titleEl: root.querySelector('#neTitle'),
      abc: root.querySelector('#neAbc'),
      ctl: null, renderT: 0, abcEditing: false, saving: false,
      listeners: [],
    };
    ui.ctl = N.render(ui.staff, editorSong(), {
      follow: true, maxBarsPerLine: 4,
      onSelect: (it) => { setCursor(it.i >= 0 ? it.i : session.seq.length); if (it.p != null) preview(it.p); },
      onRender: (c) => { c.select(session.cur < session.seq.length ? session.cur : -1); },
      onError: (msg) => toast(msg),
      onPlayState: (on) => {
        const b = root.querySelector('[data-act="play"]');
        if (b) { b.classList.toggle('on', on); b.querySelector('.ne-glyph').textContent = on ? '■' : '▶'; b.querySelector('span').textContent = t(on ? 'nt.stop' : 'ne.play'); }
      },
    });
    wire(root);
    buildKeyboard();
    fillPickup();
    refreshPanel();
    if (s.tab === 'abc') refreshAbc();
  }

  function editorSong() {
    const s = session;
    return { id: s.song.id, title: s.title, key: s.meta.keySig, tempo: s.meta.tempo, chordpro: '', melody: toStored(s, false) };
  }

  /* ---------------- ผูกเหตุการณ์ ---------------- */
  function on(target, type, fn, opt) { target.addEventListener(type, fn, opt); ui.listeners.push(() => target.removeEventListener(type, fn, opt)); }

  function wire(root) {
    root.querySelector('#neBack').addEventListener('click', () => leave(session.isNew ? '#/library' : '#/song/' + session.song.id));
    root.querySelector('#neSave').addEventListener('click', save);
    if (ui.titleEl) ui.titleEl.addEventListener('input', () => { session.title = ui.titleEl.value.slice(0, 120); markDirty(); });

    root.querySelector('#neTs').addEventListener('change', (e) => {
      const [a, b] = e.target.value.split('/').map(Number);
      pushHist(); session.meta.timeSig = [a, b];
      if (session.meta.pickup >= barBeats()) session.meta.pickup = 0;
      fillPickup(); changed();
    });
    root.querySelector('#neKey').addEventListener('change', (e) => { pushHist(); session.meta.keySig = e.target.value; buildKeyboard(); changed(); });
    const tempo = root.querySelector('#neTempo');
    tempo.addEventListener('change', () => {
      const v = Math.round(Number(tempo.value));
      if (!isNum(v) || v < 30 || v > 240) { tempo.value = session.meta.tempo; toast(t('ne.err.tempo')); return; }
      if (v === session.meta.tempo) return;
      pushHist(); session.meta.tempo = v; changed();
    });
    root.querySelector('#nePickup').addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (!isNum(v)) return;
      pushHist(); session.meta.pickup = v; changed();
    });

    root.querySelectorAll('[data-netab]').forEach((b) => b.addEventListener('click', () => {
      session.tab = b.dataset.netab;
      root.querySelectorAll('[data-netab]').forEach((x) => x.classList.toggle('active', x === b));
      root.querySelector('#nePaneNotes').hidden = session.tab !== 'notes';
      root.querySelector('#nePaneAbc').hidden = session.tab !== 'abc';
      if (session.tab === 'abc') { ui.ctl.stop(); refreshAbc(); }
      else scheduleRender(0);
    }));

    root.querySelectorAll('[data-dur]').forEach((b) => b.addEventListener('click', () => setDur(Number(b.dataset.dur))));
    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act)));

    // พยางค์: พิมพ์แล้ว Enter/▶ = ไปโน้ตถัดไป (ใส่เนื้อร้องต่อเนื่องได้เร็ว) · บันทึกประวัติ 1 ครั้งต่อการโฟกัส
    let sylHist = false;
    ui.syl.addEventListener('focus', () => { sylHist = false; });
    ui.syl.addEventListener('input', () => {
      const n = session.seq[session.cur];
      if (!n || n.p == null) return;
      if (!sylHist) { pushHist(); sylHist = true; }
      const v = ui.syl.value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24).trim();
      if (v) n.syl = v; else delete n.syl;
      changed(true);
    });
    const nextSyl = () => {
      let i = session.cur + 1;
      while (i < session.seq.length && session.seq[i].p == null) i++;
      setCursor(Math.min(i, session.seq.length));
      sylHist = false;
      ui.syl.focus();
      ui.syl.select();
    };
    ui.syl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nextSyl(); } });
    root.querySelector('#neSylNext').addEventListener('click', nextSyl);

    const commitChord = () => {
      const n = session.seq[session.cur];
      if (!n) return;
      const raw = ui.chord.value.trim();
      const cur = n.chord || '';
      if (raw === cur) return;
      if (raw && !N.cleanChord(raw)) { toast(t('ne.err.chord')); ui.chord.value = cur; return; }
      pushHist();
      if (raw) n.chord = raw; else delete n.chord;
      changed();
    };
    ui.chord.addEventListener('change', commitChord);
    ui.chord.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitChord(); ui.chord.blur(); } });

    // ABC ขั้นสูง
    root.querySelector('#neAbcCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(ui.abc.value); toast(t('ne.copied')); }
      catch (e) { ui.abc.focus(); ui.abc.select(); toast(t('ne.copyManual')); }
    });
    const applyBtn = root.querySelector('#neAbcApply');
    root.querySelector('#neAbcEdit').addEventListener('click', (e) => {
      ui.abcEditing = !ui.abcEditing;
      ui.abc.readOnly = !ui.abcEditing;
      applyBtn.hidden = !ui.abcEditing;
      e.currentTarget.classList.toggle('on', ui.abcEditing);
      if (ui.abcEditing) ui.abc.focus(); else refreshAbc();
    });
    applyBtn.addEventListener('click', applyAbc);

    // คีย์ลัดบนเดสก์ท็อป + กันออกจากหน้าโดยไม่บันทึก
    on(document, 'keydown', onKey);
    on(document, 'click', guardLinks, true);
    on(window, 'beforeunload', (e) => { if (session && session.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  function guardLinks(e) {
    if (!session || !session.active || !session.dirty) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.charAt(0) !== '#' || href === location.hash) return;
    if (!confirm(t('editor.leaveConfirm'))) { e.preventDefault(); e.stopPropagation(); return; }
    discard();
  }

  function onKey(e) {
    if (!session || !session.active || session.tab !== 'notes' || !ui || !ui.root.isConnected) return;
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable)) return;
    if (document.getElementById('modalRoot') && document.getElementById('modalRoot').children.length) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && (k === 'z' || k === 'Z')) { if (e.shiftKey) act('redo'); else act('undo'); }
    else if (mod && (k === 'y' || k === 'Y')) act('redo');
    else if (mod && (k === 's' || k === 'S')) save();
    else if (mod || e.altKey) handled = false;
    else if (k === 'ArrowLeft') act('left');
    else if (k === 'ArrowRight') act('right');
    else if (k === 'ArrowUp') act(e.shiftKey ? 'up' : 'sharp');
    else if (k === 'ArrowDown') act(e.shiftKey ? 'down' : 'flat');
    else if (k === 'Backspace' || k === 'Delete') act('del');
    else if (k === ' ') act('play');
    else if (k === '.') act('dot');
    else if (k === 'r' || k === 'R' || k === '0') act('rest');
    else if (k === 't' || k === 'T') act('tie');
    else if (k === 'i' || k === 'I') act('insert');
    else if (/^[1-5]$/.test(k)) setDur(DURS[Number(k) - 1].d);
    else if (/^[a-gA-G]$/.test(k)) letterKey(k.toUpperCase());
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ตัวอักษร A–G → เสียงที่ใกล้โน้ตก่อนหน้าที่สุด + เครื่องหมายประจำคีย์ (เช่นคีย์ G กด F = F#)
  function letterKey(L) {
    const ki = N.keyInfo(session.meta.keySig);
    const pcBase = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[L] + (ki.sig[L] || 0);
    let ref = 60;
    for (let i = Math.min(session.cur, session.seq.length) - 1; i >= 0; i--) if (session.seq[i].p != null) { ref = session.seq[i].p; break; }
    let best = null;
    for (let o = 0; o <= 9; o++) {
      const m = o * 12 + pcBase;
      if (m < MIN_P || m > MAX_P) continue;
      if (best == null || Math.abs(m - ref) < Math.abs(best - ref)) best = m;
    }
    if (best != null) pressKey(best);
  }

  /* ---------------- การแก้ไข ---------------- */
  function selected() { return session.cur < session.seq.length ? session.seq[session.cur] : null; }

  function setDur(d) {
    session.dur = d;
    if (!DOT[d]) session.dotted = false;
    const n = selected();
    if (n) {
      const nd = effDur();
      if (n.d !== nd) { pushHist(); n.d = nd; changed(); return; }
    }
    refreshPanel();
  }

  function pressKey(midi) {
    midi = clamp(midi, MIN_P, MAX_P);
    preview(midi);
    const n = selected();
    pushHist();
    if (n && !session.insert) {
      n.p = midi;
    } else {
      const note = { d: effDur(), p: midi };
      session.seq.splice(session.cur, 0, note);
      session.cur++;
    }
    changed();
  }

  function act(a) {
    const s = session;
    const n = selected();
    switch (a) {
      case 'left': setCursor(s.cur - 1); return;
      case 'right': setCursor(s.cur + 1); return;
      case 'kbdDown': s.octave = clamp(s.octave - 1, 1, 6); buildKeyboard(); return;
      case 'kbdUp': s.octave = clamp(s.octave + 1, 1, 6); buildKeyboard(); return;
      case 'insert': s.insert = !s.insert; refreshPanel(); return;
      case 'undo': undo(); return;
      case 'redo': redo(); return;
      case 'play': playFromCursor(); return;
      case 'dot': {
        if (n) {
          const nd = DOT[n.d] || UNDOT[n.d];
          if (!nd) { toast(t('ne.err.dot')); return; }
          pushHist(); n.d = nd;
          s.dotted = !!UNDOT[nd]; s.dur = UNDOT[nd] || nd;
          changed(); return;
        }
        if (!DOT[s.dur]) { toast(t('ne.err.dot')); return; }
        s.dotted = !s.dotted; refreshPanel(); return;
      }
      case 'rest':
        pushHist();
        if (n && !s.insert) { n.p = null; delete n.syl; delete n.tie; }
        else { s.seq.splice(s.cur, 0, { d: effDur(), p: null }); s.cur++; }
        changed(); return;
      case 'sharp': case 'flat': case 'up': case 'down': {
        if (!n || n.p == null) {
          if (a === 'up' || a === 'down') { s.octave = clamp(s.octave + (a === 'up' ? 1 : -1), 1, 6); buildKeyboard(); }
          else toast(t('ne.err.pickNote'));
          return;
        }
        const delta = { sharp: 1, flat: -1, up: 12, down: -12 }[a];
        const np = n.p + delta;
        if (np < MIN_P || np > MAX_P) { toast(t('ne.err.range')); return; }
        pushHist(); n.p = np; preview(np); changed(); return;
      }
      case 'tie': {
        if (!n || n.p == null) { toast(t('ne.err.pickNote')); return; }
        const nx = s.seq[s.cur + 1];
        if (!n.tie && (!nx || nx.p !== n.p)) { toast(t('ne.err.tie')); return; }
        pushHist(); if (n.tie) delete n.tie; else n.tie = true; changed(); return;
      }
      case 'del':
        if (n) { pushHist(); s.seq.splice(s.cur, 1); changed(); return; }
        if (s.seq.length) { pushHist(); s.seq.pop(); s.cur = s.seq.length; changed(); }
        return;
      default:
    }
  }

  function setCursor(i) {
    session.cur = clamp(i, 0, session.seq.length);
    // จานความยาวแสดงตามโน้ตที่เลือก (แก้ต่อได้ทันที)
    const n = selected();
    if (n) {
      if (UNDOT[n.d]) { session.dur = UNDOT[n.d]; session.dotted = true; }
      else if (DURS.some((x) => x.d === n.d)) { session.dur = n.d; session.dotted = false; }
    }
    if (ui && ui.ctl) ui.ctl.select(session.cur < session.seq.length ? session.cur : -1);
    refreshPanel();
  }

  function preview(midi) { try { if (window.Music) Music.pluck(midi, 0, 1.1, 0.3); } catch (e) { /* ไม่มีเสียงก็ไม่เป็นไร */ } }

  function playFromCursor() {
    if (!ui || !ui.ctl) return;
    if (ui.ctl.playing) { ui.ctl.stop(); return; }
    if (!session.seq.some((n) => n.p != null)) { toast(t('ne.err.empty')); return; }
    flushRender();
    ui.ctl.play(session.cur < session.seq.length ? session.cur : -1);
  }

  function markDirty() { session.dirty = isDirty(); }

  function changed(textOnly) {
    session.cur = clamp(session.cur, 0, session.seq.length);
    markDirty();
    if (ui && ui.ctl) ui.ctl.stop();
    scheduleRender(textOnly ? 350 : null);
    refreshPanel();
    if (session.tab === 'abc') refreshAbc();
  }

  function scheduleRender(ms) {
    if (!ui) return;
    clearTimeout(ui.renderT);
    const delay = ms != null ? ms : (session.seq.length > 400 ? 320 : 110);
    ui.renderT = setTimeout(flushRender, delay);
  }
  function flushRender() {
    if (!ui) return;
    clearTimeout(ui.renderT);
    if (!ui.root.isConnected || session.tab !== 'notes') return;
    ui.ctl.update(editorSong());
  }

  /* ---------------- แผงสถานะ ---------------- */
  function refreshPanel() {
    if (!ui) return;
    const s = session, r = ui.root;
    const n = selected();
    const bb = barBeats();
    r.querySelectorAll('[data-dur]').forEach((b) => b.classList.toggle('on', Number(b.dataset.dur) === s.dur));
    const dotBtn = r.querySelector('[data-act="dot"]');
    dotBtn.classList.toggle('on', s.dotted);
    dotBtn.disabled = !DOT[s.dur] && !(n && (DOT[n.d] || UNDOT[n.d]));
    r.querySelector('[data-act="insert"]').classList.toggle('on', s.insert);
    r.querySelector('[data-act="undo"]').disabled = !s.hist.length;
    r.querySelector('[data-act="redo"]').disabled = !s.fut.length;
    const tieBtn = r.querySelector('[data-act="tie"]');
    tieBtn.classList.toggle('on', !!(n && n.tie));
    // สถานะ
    let msg;
    if (n) {
      const tm = timeAt(s.cur);
      const bar = Math.floor(tm / bb);
      const where = tm < 0 ? t('ne.pickupBar') : t('ne.bar') + ' ' + (bar + 1);
      const beat = Math.round((tm - bar * bb + 1) * 100) / 100;
      const pitch = n.p == null ? t('ne.rest') : N.noteName(n.p, s.meta.keySig) + ' · ' + N.solfegeName(n.p, s.meta.keySig, 'fixed');
      msg = `${where} · ${t('ne.beat')} ${beat} · <b>${esc(pitch)}</b> · ${esc(durLabel(n.d))}`;
    } else {
      msg = s.seq.length ? t('ne.atEnd') : t('ne.emptyHint');
      msg = esc(msg) + ` · <b>${esc(durLabel(effDur()))}</b>`;
    }
    if (s.insert) msg += ` · <span class="ne-ins">${esc(t('ne.insertOn'))}</span>`;
    ui.status.innerHTML = msg;
    // ช่องพยางค์/คอร์ด
    const canSyl = !!(n && n.p != null);
    ui.syl.disabled = !canSyl;
    if (document.activeElement !== ui.syl) ui.syl.value = canSyl ? (n.syl || '') : '';
    ui.chord.disabled = !n;
    if (document.activeElement !== ui.chord) ui.chord.value = n ? (n.chord || '') : '';
    // สรุปตั้งค่า
    const sum = r.querySelector('#neSetSum');
    if (sum) sum.textContent = `${s.meta.timeSig[0]}/${s.meta.timeSig[1]} · ${s.meta.keySig} · ${s.meta.tempo} BPM${s.meta.pickup ? ' · ' + t('ne.pickup') + ' ' + s.meta.pickup : ''}`;
    const saveBtn = r.querySelector('#neSave');
    saveBtn.classList.toggle('ne-dirty', !!s.dirty);
  }

  function durLabel(d) {
    const base = { 4: 'whole', 2: 'half', 1: 'quarter', 0.5: 'eighth', 0.25: 'sixteenth' };
    if (base[d]) return t('ne.dur.' + base[d]);
    if (UNDOT[d]) return t('ne.dur.' + base[UNDOT[d]]) + ' ' + t('ne.dotShort');
    return d + ' ' + t('ne.beats');
  }

  function fillPickup() {
    const sel = ui.root.querySelector('#nePickup');
    const bb = barBeats();
    const vals = [0];
    for (let v = 0.5; v < bb; v += 0.5) vals.push(v);
    if (session.meta.pickup && vals.indexOf(session.meta.pickup) < 0 && session.meta.pickup < bb) vals.push(session.meta.pickup);
    vals.sort((a, b) => a - b);
    sel.innerHTML = vals.map((v) => `<option value="${v}" ${v === session.meta.pickup ? 'selected' : ''}>${v === 0 ? esc(t('ne.noPickup')) : v + ' ' + esc(t('ne.beats'))}</option>`).join('');
  }

  /* ---------------- เปียโน 2 ช่วงเสียง ---------------- */
  function buildKeyboard() {
    if (!ui) return;
    const base = (session.octave + 1) * 12; // C ของช่วงล่าง
    const WHITE = [0, 2, 4, 5, 7, 9, 11];
    const BLACK = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 }; // index ขาวซ้าย → ครึ่งเสียงของดำ
    let white = '', black = '';
    let wi = 0;
    for (let o = 0; o < 2; o++) {
      WHITE.forEach((semi, i) => {
        const m = base + o * 12 + semi;
        const dis = m < MIN_P || m > MAX_P;
        white += `<button type="button" class="ne-wk${semi === 0 ? ' ne-c' : ''}" data-midi="${m}" ${dis ? 'disabled' : ''} aria-label="${esc(N.noteName(m, 'C'))}">
          <span class="ne-sol">${esc(N.solfegeName(m, 'C', 'fixed'))}</span><span class="ne-nm">${esc(N.noteName(m, 'C'))}</span></button>`;
        if (BLACK[i] != null) {
          const bm = base + o * 12 + BLACK[i];
          const bdis = bm < MIN_P || bm > MAX_P;
          black += `<button type="button" class="ne-bk" data-midi="${bm}" ${bdis ? 'disabled' : ''} style="left:calc(${wi + 1} * var(--wk) - var(--bk) / 2)" aria-label="${esc(N.noteName(bm, session.meta.keySig))}"><span>${esc(N.solfegeName(bm, session.meta.keySig, 'fixed'))}</span></button>`;
        }
        wi++;
      });
    }
    ui.kbd.innerHTML = `<div class="ne-kbd-inner" style="--n:${wi}">${white}${black}</div>`;
    ui.kbd.querySelectorAll('[data-midi]').forEach((b) => b.addEventListener('click', () => pressKey(Number(b.dataset.midi))));
    const rng = ui.root.querySelector('#neKbdRange');
    if (rng) rng.textContent = N.noteName(base, 'C') + ' – ' + N.noteName(base + 23, 'C');
  }

  /* ---------------- ABC ขั้นสูง ---------------- */
  function refreshAbc() {
    if (!ui || ui.abcEditing) return;
    try { ui.abc.value = N.melodyToAbc(toStored(session, true), { title: session.title || (session.song && session.song.title) || '', lineWidth: 740 }).abc; }
    catch (e) { ui.abc.value = ''; }
  }

  let applying = false;
  async function applyAbc() {
    if (applying) return;
    const text = ui.abc.value;
    if (!text.trim()) { toast(t('ne.abc.empty')); return; }
    if (text.length > 200000) { toast(t('ne.abc.tooBig')); return; }
    if (session.seq.length && !confirm(t('ne.abc.replaceConfirm'))) return;
    applying = true;
    const mySession = session;
    try {
      const A = await N.loadAbcjs();
      if (session !== mySession || !ui || !ui.root.isConnected) return;
      let res = null;
      try {
        const src = /^\s*X:/m.test(text) ? text : 'X:1\n' + text;
        const tune = A.parseOnly(src)[0];
        res = N.abcTuneToMelody(tune);
      } catch (e) { res = null; }
      if (!res || !res.melody.notes.some((n) => n.p != null)) { toast(t('ne.abc.bad')); return; }
      pushHist();
      const st = fromStored(res.melody);
      let k = st.seq.length; while (k > 0 && st.seq[k - 1].p == null) k--;
      session.seq = st.seq.slice(0, k);
      session.meta = Object.assign(session.meta, {
        timeSig: st.meta.timeSig, keySig: st.meta.keySig || session.meta.keySig,
        tempo: st.meta.tempo && st.meta.tempo >= 30 && st.meta.tempo <= 240 ? Math.round(st.meta.tempo) : session.meta.tempo,
        pickup: st.meta.pickup || 0,
      });
      session.cur = session.seq.length;
      ui.abcEditing = false; ui.abc.readOnly = true;
      ui.root.querySelector('#neAbcApply').hidden = true;
      ui.root.querySelector('#neAbcEdit').classList.remove('on');
      // ค่าตั้งใน select ต้องตามข้อมูลใหม่ → วาดหน้าใหม่ทั้งหน้า (ร่างยังอยู่ใน session)
      session.tab = 'notes';
      markDirty();
      const v = ui.view;
      teardown();
      session.active = true;
      build(v);
      toast(t('ne.abc.done') + (res.warnings.length ? ' · ' + t('ne.abc.warn') : ''));
    } catch (e) {
      toast(t('nt.err.lib'));
    } finally { applying = false; }
  }

  /* ---------------- บันทึก / ออก ---------------- */
  function save() {
    if (!ui || ui.saving) return;
    ui.saving = true;
    try {
      const s = session;
      const melody = toStored(s, true);
      if (!melody.notes.length) { toast(t('ne.err.empty')); return; }
      let id;
      if (s.isNew) {
        const title = (ui.titleEl && ui.titleEl.value.trim()) || t('ne.untitled');
        const doc = Object.assign({}, s.song, { title: title.slice(0, 120), key: s.meta.keySig, tempo: String(s.meta.tempo), melody, schemaVersion: 2 });
        const saved = Store.upsert(doc);
        id = saved.id;
      } else {
        const cur = Store.get(s.song.id);
        if (!cur) { toast(t('song.notFound')); return; }
        Store.upsert({ id: cur.id, melody });
        id = cur.id;
      }
      s.dirty = false;
      discard();
      lastEdited = id;
      toast(t('editor.saved'));
      location.hash = '#/song/' + id;
    } catch (e) {
      toast(t('ne.err.save'));
    } finally { if (ui) ui.saving = false; }
  }

  function leave(dest) {
    if (session && isDirty() && !confirm(t('editor.leaveConfirm'))) return;
    discard();
    // มาจากหน้าเพลงนั้นจริง → ย้อนประวัติ (ไม่ให้ปุ่ม back ของเครื่องพากลับมาหน้าแก้โน้ตอีก)
    if (enteredFrom === dest) history.back();
    else location.hash = dest;
  }

  function discard() { session = null; }

  function teardown() {
    if (!ui) return;
    clearTimeout(ui.renderT);
    try { if (ui.ctl) ui.ctl.destroy(); } catch (e) { /* ignore */ }
    ui.listeners.forEach((off) => off());
    ui = null;
    if (session) session.active = false;
  }

  function toast(msg) {
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2600);
  }

  // ออกจากหน้าแก้โน้ตด้วยปุ่ม back ของเครื่อง/ลิงก์ → ถอดตัวฟังเหตุการณ์ (ร่างยังเก็บไว้ถ้ายังไม่บันทึก)
  let enteredFrom = null;
  window.addEventListener('hashchange', (e) => {
    const inEditor = /^#\/notes\//.test(location.hash);
    if (inEditor) {
      let old = '';
      try { old = new URL(e.oldURL).hash; } catch (x) { old = ''; }
      if (!/^#\/notes\//.test(old)) enteredFrom = old || null;
    }
    if (ui && !inEditor) teardown();
  });

  /* ---------------- คำแปล ---------------- */
  I18N.extend({
    th: {
      'ne.title': 'ทำโน้ต',
      'ne.songTitle': 'ชื่อเพลง',
      'ne.untitled': 'เพลงใหม่',
      'ne.settings': 'ตั้งค่าโน้ต',
      'ne.timeSig': 'จังหวะ',
      'ne.tempo': 'ความเร็ว (BPM)',
      'ne.pickup': 'ตัวเกริ่น',
      'ne.noPickup': 'ไม่มี',
      'ne.minor': 'ไมเนอร์',
      'ne.tabNotes': 'โน้ต',
      'ne.tabAbc': 'ABC ขั้นสูง',
      'ne.syl': 'เนื้อร้อง',
      'ne.sylPh': 'พยางค์ใต้โน้ตนี้ (_ = ลากเสียง)',
      'ne.chord': 'คอร์ด',
      'ne.durations': 'ความยาวโน้ต',
      'ne.tools': 'เครื่องมือแก้โน้ต',
      'ne.dur.whole': 'ตัวกลม',
      'ne.dur.half': 'ตัวขาว',
      'ne.dur.quarter': 'ตัวดำ',
      'ne.dur.eighth': 'เขบ็ต 1 ชั้น',
      'ne.dur.sixteenth': 'เขบ็ต 2 ชั้น',
      'ne.dotted': 'ประจุด',
      'ne.dotShort': 'ประจุด',
      'ne.rest': 'ตัวหยุด',
      'ne.prev': 'ก่อนหน้า',
      'ne.next': 'ถัดไป',
      'ne.sharp': 'ชาร์ป',
      'ne.flat': 'แฟลต',
      'ne.octUp': 'สูงขึ้น',
      'ne.octDown': 'ต่ำลง',
      'ne.tie': 'โยงเสียง',
      'ne.insert': 'แทรก',
      'ne.insertOn': 'โหมดแทรก: กดคีย์แล้วแทรกหน้าตัวที่เลือก',
      'ne.delete': 'ลบ',
      'ne.undo': 'ย้อน',
      'ne.redo': 'ทำซ้ำ',
      'ne.play': 'เล่น',
      'ne.playFrom': 'เล่นจากตำแหน่งที่เลือก',
      'ne.kbdLower': 'ช่วงเสียงต่ำลง',
      'ne.kbdHigher': 'ช่วงเสียงสูงขึ้น',
      'ne.bar': 'ห้อง',
      'ne.pickupBar': 'ตัวเกริ่น',
      'ne.beat': 'จังหวะที่',
      'ne.beats': 'จังหวะ',
      'ne.atEnd': 'ต่อท้าย — กดคีย์เปียโนเพื่อเพิ่มโน้ต',
      'ne.emptyHint': 'ยังไม่มีโน้ต — เลือกความยาวแล้วกดคีย์เปียโนด้านล่าง',
      'ne.help': 'แตะโน้ตบนบรรทัดเพื่อเลือก แล้วกดคีย์เปียโนเพื่อเปลี่ยนเสียง · เลือก "ต่อท้าย" (แตะหลังโน้ตตัวสุดท้าย/กด ▶ จนสุด) เพื่อเพิ่มโน้ตใหม่',
      'ne.shortcuts': 'คีย์ลัด: A–G ใส่โน้ต · 1–5 ความยาว · . ประจุด · R ตัวหยุด · ←/→ เลื่อน · ↑/↓ ครึ่งเสียง (Shift = ช่วงเสียง) · T โยง · Backspace ลบ · Ctrl+Z ย้อน · Space เล่น',
      'ne.abcHelp': 'โน้ตในรูปแบบ ABC (มาตรฐานเปิด ใช้กับโปรแกรมอื่นได้) — กด "แก้ไข ABC" เพื่อวางโน้ตจากที่อื่นแล้วแปลงกลับเป็นทำนอง',
      'ne.copy': 'คัดลอก',
      'ne.copied': 'คัดลอกแล้ว',
      'ne.copyManual': 'เลือกข้อความไว้แล้ว — กดคัดลอกเอง',
      'ne.abcEdit': 'แก้ไข ABC',
      'ne.abcApply': 'ใช้ ABC นี้แทนทำนอง',
      'ne.abc.empty': 'ยังไม่มีข้อความ ABC',
      'ne.abc.tooBig': 'ข้อความยาวเกินไป',
      'ne.abc.bad': 'อ่านโน้ต ABC นี้ไม่ได้ หรือไม่มีโน้ตเลย',
      'ne.abc.replaceConfirm': 'แทนที่ทำนองทั้งหมดด้วยโน้ตจาก ABC? (ย้อนกลับได้ด้วยปุ่มย้อน)',
      'ne.abc.done': 'แปลง ABC เป็นทำนองแล้ว',
      'ne.abc.warn': 'บางส่วนถูกปรับ (เช่น โน้ตคู่/สามพยางค์) ตรวจอีกครั้ง',
      'ne.restored': 'กู้คืนโน้ตที่ยังไม่ได้บันทึกให้แล้ว',
      'ne.err.chord': 'ชื่อคอร์ดไม่ถูกต้อง (ตัวอย่าง: C, Am7, F#m, G/B)',
      'ne.err.tempo': 'ความเร็วต้องอยู่ระหว่าง 30–240 BPM',
      'ne.err.pickNote': 'เลือกโน้ต (ไม่ใช่ตัวหยุด) ก่อน',
      'ne.err.range': 'เกินช่วงเสียงของเปียโน',
      'ne.err.tie': 'โยงเสียงได้เฉพาะกับโน้ตถัดไปที่เป็นเสียงเดียวกัน',
      'ne.err.empty': 'ยังไม่มีโน้ต — ใส่โน้ตอย่างน้อย 1 ตัว',
      'ne.err.save': 'บันทึกไม่สำเร็จ (ที่เก็บในเครื่องอาจเต็ม)',
      'ne.err.dot': 'ประจุดได้เฉพาะตัวขาว ตัวดำ และเขบ็ต 1 ชั้น',
    },
    en: {
      'ne.title': 'Note editor',
      'ne.songTitle': 'Song title',
      'ne.untitled': 'New song',
      'ne.settings': 'Notation settings',
      'ne.timeSig': 'Time signature',
      'ne.tempo': 'Tempo (BPM)',
      'ne.pickup': 'Pickup',
      'ne.noPickup': 'None',
      'ne.minor': 'minor',
      'ne.tabNotes': 'Notes',
      'ne.tabAbc': 'Advanced ABC',
      'ne.syl': 'Lyric',
      'ne.sylPh': 'Syllable under this note (_ = hold)',
      'ne.chord': 'Chord',
      'ne.durations': 'Note length',
      'ne.tools': 'Edit tools',
      'ne.dur.whole': 'Whole',
      'ne.dur.half': 'Half',
      'ne.dur.quarter': 'Quarter',
      'ne.dur.eighth': 'Eighth',
      'ne.dur.sixteenth': '16th',
      'ne.dotted': 'Dotted',
      'ne.dotShort': 'dotted',
      'ne.rest': 'Rest',
      'ne.prev': 'Prev',
      'ne.next': 'Next',
      'ne.sharp': 'Sharp',
      'ne.flat': 'Flat',
      'ne.octUp': 'Oct up',
      'ne.octDown': 'Oct down',
      'ne.tie': 'Tie',
      'ne.insert': 'Insert',
      'ne.insertOn': 'Insert mode: keys insert before the selected note',
      'ne.delete': 'Delete',
      'ne.undo': 'Undo',
      'ne.redo': 'Redo',
      'ne.play': 'Play',
      'ne.playFrom': 'Play from the selected note',
      'ne.kbdLower': 'Lower range',
      'ne.kbdHigher': 'Higher range',
      'ne.bar': 'Bar',
      'ne.pickupBar': 'Pickup',
      'ne.beat': 'beat',
      'ne.beats': 'beats',
      'ne.atEnd': 'At the end — tap a piano key to add a note',
      'ne.emptyHint': 'No notes yet — pick a length, then tap a piano key below',
      'ne.help': 'Tap a note on the staff to select it, then a piano key to change its pitch · move to the end (after the last note) to add new notes',
      'ne.shortcuts': 'Shortcuts: A–G note · 1–5 length · . dot · R rest · ←/→ move · ↑/↓ semitone (Shift = octave) · T tie · Backspace delete · Ctrl+Z undo · Space play',
      'ne.abcHelp': 'The melody in ABC notation (an open standard other apps understand) — tap "Edit ABC" to paste notes from elsewhere and convert them back',
      'ne.copy': 'Copy',
      'ne.copied': 'Copied',
      'ne.copyManual': 'Text selected — copy it manually',
      'ne.abcEdit': 'Edit ABC',
      'ne.abcApply': 'Use this ABC as the melody',
      'ne.abc.empty': 'No ABC text yet',
      'ne.abc.tooBig': 'Text is too long',
      'ne.abc.bad': 'Could not read this ABC, or it has no notes',
      'ne.abc.replaceConfirm': 'Replace the whole melody with the ABC notes? (you can undo)',
      'ne.abc.done': 'ABC converted to melody',
      'ne.abc.warn': 'some parts were adjusted (chords/tuplets) — please check',
      'ne.restored': 'Restored your unsaved notes',
      'ne.err.chord': 'Invalid chord name (e.g. C, Am7, F#m, G/B)',
      'ne.err.tempo': 'Tempo must be between 30 and 240 BPM',
      'ne.err.pickNote': 'Select a note (not a rest) first',
      'ne.err.range': 'Out of piano range',
      'ne.err.tie': 'You can only tie to a following note of the same pitch',
      'ne.err.empty': 'No notes yet — add at least one note',
      'ne.err.save': 'Could not save (device storage may be full)',
      'ne.err.dot': 'Only half, quarter and eighth notes can be dotted',
    },
  });

  window.NotationEditor = {
    open,
    isDirty: () => !!(session && session.dirty),
    takeLastEdited: () => { const x = lastEdited; lastEdited = null; return x; },
    _test: { fromStored, toStored },
  };
})();
