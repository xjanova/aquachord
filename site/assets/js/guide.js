/* guide.js — น้องอควา ไกด์มาสคอตที่ขยับได้ (มาตรฐานเดียวกับ Nova ของ XMAN GAMES HUB)
   ภาพนิ่งอยู่ล่าง · คลิป VP9 โปร่งใสซ้อนบน (เฟรมแรก/เฟรมท้าย = ภาพนิ่ง → สลับได้ไม่กระตุก)
   โหมด: stage = ยืนข้างพาเนลหลักบนจอกว้าง · dock = มุมขวาล่าง · mini = รูปหน้าในวงกลม (มือถือ)
   ไม่มีคลิป / Safari / ประหยัดเน็ต / ปิด Motion → ใช้ภาพนิ่ง + ลอยด้วย CSS แทน */
(function () {
  const STILL = 'assets/mascot.webp';
  const FACE = 'assets/guide/face-160.webp';
  const CLIP_V = '2'; // บัมป์เมื่อเข้ารหัสคลิปใหม่ชื่อเดิม (CDN แคชไฟล์เก่า)
  // pad = คลิปทำจากภาพที่เติมขอบเขียว 8% → วาดใหญ่ขึ้น 16% ให้ตัวทับภาพนิ่งพอดี
  const CLIPS = {
    idle: { loop: true, pad: true },
    talk: { loop: true, pad: true },
    wave: { loop: false, pad: true },
    present: { loop: false, pad: true },
    cheer: { loop: false, pad: true },
    wink: { loop: false, pad: true },
  };
  const ASPECT = 686 / 900;  // สัดส่วนภาพนิ่ง
  const DOCK_H = 330;

  let A = null;            // AppAPI (t, tf, ...)
  let root, figure, still, bubble, textEl, srEl, chipsEl, faceBtn, ctlBtn;
  const videos = {};
  const broken = new Set();
  let active = null, wanted = 'idle', z = 2;
  let loopMove = 'idle', busy = false, typing = false;
  let mode = 'dock', bubbleOn = false, minimized = false, enabled = true;
  let lastLineAt = 0, tipCount = 0, protectedUntil = 0, curPriority = 0;
  let typeTimer = 0, hideTimer = 0, lineSeq = 0;
  let curRoute = 'home', routeCtx = {};
  let tourStep = -1;

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  const t = (k) => (A ? A.t(k) : k);
  const tf = (k, v) => (A ? A.tf(k, v) : k);
  const motionOn = () => document.documentElement.getAttribute('data-motion') === 'on';
  const pick = (l) => l[Math.floor(Math.random() * l.length)];
  function graphemes(s) {
    try { return Array.from(new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(s), (x) => x.segment); }
    catch (e) { return Array.from(s); }
  }

  /* วิดีโอ alpha เฉพาะที่ถอดรหัส alpha ได้และไม่เปลืองเน็ตผู้ใช้ */
  function canPlayAlpha() {
    const ua = navigator.userAgent;
    const webkitOnly = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|Firefox|FxiOS|CriOS/.test(ua);
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const conn = navigator.connection;
    if (webkitOnly || ios || (conn && conn.saveData)) return false;
    if (!motionOn()) return false;
    return matchMedia('(min-width: 720px)').matches;
  }

  /* ---------------- DOM ---------------- */
  function build() {
    root = document.createElement('div');
    root.className = 'guide';
    root.id = 'guide';
    root.innerHTML = `
      <div class="guide-body">
        <div class="guide-figure">
          <img class="g-still on" src="${STILL}" alt="" draggable="false" decoding="async" />
          ${Object.keys(CLIPS).map((m) => `<video class="g-clip${CLIPS[m].pad ? ' pad' : ''}" data-move="${m}" data-src="assets/guide/clips/${m}.webm?v=${CLIP_V}" muted playsinline preload="none" disablepictureinpicture aria-hidden="true"></video>`).join('')}
        </div>
        <button class="guide-hit" type="button"></button>
      </div>
      <section class="guide-bubble">
        <header><span class="guide-name"><i></i>AQUA · GUIDE</span><button class="guide-x" type="button">×</button></header>
        <p class="gb-text" aria-hidden="true"><span class="gb-typed"></span><span class="caret"></span></p>
        <p class="sr-only" role="status" aria-live="polite"></p>
        <div class="guide-chips"></div>
      </section>
      <button class="guide-ctl" type="button">–</button>
      <button class="guide-face" type="button"><img src="${FACE}" alt="" draggable="false" /><span class="guide-dot"></span></button>`;
    document.body.appendChild(root);
    figure = root.querySelector('.guide-figure');
    still = root.querySelector('.g-still');
    bubble = root.querySelector('.guide-bubble');
    textEl = root.querySelector('.gb-typed');
    srEl = root.querySelector('.guide-bubble [role="status"]');
    chipsEl = root.querySelector('.guide-chips');
    faceBtn = root.querySelector('.guide-face');
    ctlBtn = root.querySelector('.guide-ctl');
    root.querySelectorAll('.g-clip').forEach((v) => { videos[v.dataset.move] = v; });
    still.addEventListener('error', () => { root.hidden = true; });

    root.querySelector('.guide-hit').addEventListener('click', poke);
    root.querySelector('.guide-x').addEventListener('click', () => { setBubble(false); if (tourStep >= 0) endTour(); });
    ctlBtn.addEventListener('click', () => setMinimized(true));
    faceBtn.addEventListener('click', () => {
      if (minimized && mode !== 'mini') { setMinimized(false); greet(true); return; }
      if (mode === 'mini') {
        if (bubbleOn) setBubble(false);
        else if (textEl.textContent) { setBubble(true); faceBtn.classList.remove('ping'); }
        else greet(true);
        return;
      }
      poke();
    });
    relang();
  }

  function relang() {
    if (!root) return;
    root.querySelector('.guide-hit').setAttribute('aria-label', t('guide.poke'));
    root.querySelector('.guide-x').setAttribute('aria-label', t('common.close'));
    ctlBtn.setAttribute('aria-label', t('guide.minimize'));
    faceBtn.setAttribute('aria-label', t('guide.talk'));
    bubble.setAttribute('aria-label', t('guide.name'));
  }

  /* ---------------- Figure: ภาพนิ่ง + คลิป ---------------- */
  function show(move, onEnd) {
    const clip = CLIPS[move];
    wanted = move;
    const v = videos[move];
    if (!clip || !canPlayAlpha() || !v || broken.has(move)) {
      if (active) { active.classList.remove('on'); active.pause(); active = null; }
      figure.classList.remove('clip-on');
      // ไม่มีคลิปท่านี้ → ขยับภาพนิ่งด้วย CSS แทน แล้วไปต่อเร็ว ๆ (ไม่ปล่อยกล่องคำพูดว่างนาน)
      const oneOff = move !== 'idle' && move !== 'talk';
      if (oneOff && motionOn()) { still.classList.remove('react'); void still.offsetWidth; still.classList.add('react'); }
      if (onEnd) setTimeout(onEnd, oneOff ? 420 : 0);
      return;
    }
    const start = () => {
      if (wanted !== move) return;
      const prev = active;
      v.loop = clip.loop;
      v.onended = clip.loop ? null : () => { if (onEnd) onEnd(); };
      try { v.currentTime = 0; } catch (e) {}
      v.style.zIndex = String(++z);
      v.classList.add('on');
      const p = v.play();
      if (p && p.catch) p.catch((e) => {
        // AbortError = ถูก pause ทันทีหลัง play — ไม่ใช่คลิปเสีย
        if (!e || e.name !== 'AbortError') { broken.add(move); v.classList.remove('on'); if (active === v) { active = null; figure.classList.remove('clip-on'); } if (onEnd) onEnd(); }
      });
      active = v;
      // เฟรมแรกของคลิป = ภาพนิ่ง → พอคลิปขึ้นแล้วซ่อนภาพนิ่งข้างใต้ (กันเงาซ้อนตอนขยับ)
      figure.classList.add('clip-on');
      // เลเยอร์ใหม่จางเข้าทับของเก่า ซึ่งยังทึบอยู่จนจางเสร็จ (สองเลเยอร์ครึ่ง ๆ จะเห็นพื้นหลังทะลุตัว)
      if (prev && prev !== v) setTimeout(() => { if (active !== prev) { prev.classList.remove('on'); prev.pause(); } }, 260);
    };
    if (!v.getAttribute('src')) { v.src = v.dataset.src; v.load(); }
    if (v.readyState >= 3) start();
    else {
      v.addEventListener('canplay', start, { once: true });
      v.addEventListener('error', () => { broken.add(move); if (wanted === move && onEnd) onEnd(); }, { once: true });
    }
  }

  function playOnce(m, then) {
    busy = true;
    show(m, () => { busy = false; if (then) then(); else show(loopMove); });
  }

  // ทยอยโหลดท่าที่เล่นครั้งเดียวหลังหน้าเว็บนิ่งแล้ว
  function trickle() {
    if (!canPlayAlpha()) return;
    const q = ['talk', 'wave', 'present', 'wink', 'cheer'];
    const next = () => {
      const m = q.shift(); const v = m && videos[m];
      if (!v) return;
      if (!v.getAttribute('src')) { v.preload = 'auto'; v.src = v.dataset.src; v.load(); }
      v.addEventListener('canplaythrough', next, { once: true });
      v.addEventListener('error', () => { broken.add(m); next(); }, { once: true });
    };
    next();
  }

  /* ---------------- Speech ---------------- */
  // line: string | { text, react, after, chips:[{label, run, primary}], priority, hold }
  function say(line) {
    if (!enabled || !root) return false;
    if (typeof line === 'string') line = { text: line };
    const now = performance.now();
    const p = line.priority == null ? 1 : line.priority;
    if (now < protectedUntil && p < curPriority) return false;
    curPriority = p;
    protectedUntil = now + 900 + line.text.length * 38 + (line.hold == null ? 2200 : line.hold);
    lastLineAt = now;
    const id = ++lineSeq;
    clearInterval(typeTimer); clearTimeout(hideTimer);

    chipsEl.innerHTML = '';
    (line.chips || []).forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = c.label;
      if (c.primary) b.className = 'primary';
      b.addEventListener('click', () => { release(); c.run(); });
      chipsEl.appendChild(b);
    });
    srEl.textContent = line.text;
    textEl.textContent = line.text;   // วัดความสูงจริงก่อนวางตำแหน่ง แล้วค่อยพิมพ์ทีละตัว
    place();
    textEl.textContent = '';
    const autoOpen = mode !== 'mini' || line.priority >= 2 || line.open;
    if (autoOpen && !minimized) setBubble(true);
    else if (mode === 'mini' || minimized) faceBtn.classList.add('ping');

    const settle = line.after || 'idle';
    const finish = () => {
      if (id !== lineSeq) return;
      typing = false;
      loopMove = settle;
      if (!busy) show(settle);
      if (mode !== 'stage' && tourStep < 0) {
        const extra = line.chips && line.chips.length ? 6000 : 0;
        hideTimer = setTimeout(() => { if (id === lineSeq) setBubble(false); }, 9000 + extra + line.text.length * 40);
      }
    };
    const type = () => {
      if (id !== lineSeq) return;
      typing = true;
      loopMove = 'talk';
      if (!busy) show('talk');
      if (!motionOn() || !bubbleOn) { textEl.textContent = line.text; finish(); return; }
      const parts = graphemes(line.text);
      let i = 0;
      typeTimer = setInterval(() => {
        if (id !== lineSeq) { clearInterval(typeTimer); return; }
        i = Math.min(parts.length, i + 1);
        textEl.textContent = parts.slice(0, i).join('');
        if (i >= parts.length) { clearInterval(typeTimer); finish(); }
      }, 30);
    };
    // ท่าทางยาว 6 วิ → เริ่มพิมพ์ระหว่างท่ายังเล่นอยู่ (จบท่าแล้วค่อยต่อด้วยท่าพูด/ท่าพัก)
    if (line.react && !minimized && mode !== 'mini') {
      const hasClip = canPlayAlpha() && !broken.has(line.react);
      playOnce(line.react);
      setTimeout(type, hasClip ? 900 : 420);
    } else type();
    return true;
  }
  function release() { protectedUntil = 0; curPriority = 0; }

  function setBubble(on) {
    bubbleOn = !!on;
    root.setAttribute('data-bubble', on ? '1' : '0');
    if (on) faceBtn.classList.remove('ping');
  }
  function setMinimized(m) {
    minimized = !!m;
    ls.set('aq.guide.min', m ? '1' : '0');
    root.setAttribute('data-min', m ? '1' : '0');
    if (m) { setBubble(false); if (active) { active.pause(); } }
    else show(loopMove);
    place();
  }

  /* ---------------- Placement ---------------- */
  // หน้าที่อ่าน/แก้เนื้อหายาว → ย่อเป็นรูปหน้าไว้ ไม่บังแผ่นคอร์ด
  const QUIET = { song: 1, edit: 1 };
  let raf = 0, flyTimer = 0;
  function place() {
    raf = 0;
    if (!root || root.hidden) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const spot = document.querySelector('[data-guide-stage]');
    const r = spot && spot.getBoundingClientRect();
    // จอต่ำกว่า 1280 เนื้อหาเต็มความกว้าง → ตัวเต็มจะบังฟอร์ม ใช้รูปหน้าในวงกลมแทน
    const small = vw < 1280;
    const quiet = QUIET[curRoute];
    const H = Math.max(DOCK_H, Math.min((r ? r.height : 560) * 1.02, vh * 0.8, 660));
    const W = H * ASPECT;
    const stageOK = !small && vw >= 1280 && !!r && r.top < vh * 0.55 && r.bottom - H * 0.97 >= 70;
    const m = small || quiet ? 'mini' : stageOK ? 'stage' : 'dock';
    if (m !== mode) {
      root.classList.add('flying');
      clearTimeout(flyTimer);
      flyTimer = setTimeout(() => root.classList.remove('flying'), 750);
      const was = mode;
      mode = m;
      root.setAttribute('data-mode', m);
      document.documentElement.classList.toggle('guide-staged', m === 'stage' && !minimized);
      if (m === 'mini' && was !== 'mini') setBubble(false);
      if (m === 'mini') { if (active) active.pause(); }
      else if (!minimized) show(loopMove);
    }
    document.documentElement.classList.toggle('guide-staged', mode === 'stage' && !minimized);
    let x, y, s;
    const bottomGap = vw < 1024 ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tabbar-space')) || 0) : 0;
    if (mode === 'stage' && r) { s = 1; x = r.right - W * 0.8; y = r.bottom - H * 0.97; }
    else { s = Math.min(DOCK_H, vh * 0.42) / H; x = vw - W * s - 8; y = vh - H * s - bottomGap + 4; }
    const st = root.style;
    st.setProperty('--nh', H + 'px'); st.setProperty('--nw', W + 'px');
    st.setProperty('--nx', x + 'px'); st.setProperty('--ny', y + 'px'); st.setProperty('--ns', s);
    if (mode === 'stage') {
      // กล่องคำพูดลอยเหนือหัว (ไม่ทับฟอร์ม) — ถ้าชนแถบบนค่อยย้ายไปข้างหัว
      const bh = bubble.offsetHeight || 150;
      const topLimit = (document.querySelector('.topbar') || { offsetHeight: 72 }).offsetHeight + 10;
      const above = y + H * 0.07 - bh >= topLimit;
      root.setAttribute('data-bpos', above ? 'above' : 'side');
      st.setProperty('--bx', (above ? x + W * 0.55 : Math.max(320, x + W * 0.24)) + 'px');
      st.setProperty('--by', (above ? y + H * 0.07 : Math.max(topLimit, y + H * 0.1)) + 'px');
    } else {
      st.setProperty('--bx', Math.min(vw - 10, x + W * s * 0.9) + 'px');
      st.setProperty('--by', (y + H * s * 0.08) + 'px');
    }
  }
  const queue = () => { if (!raf) raf = requestAnimationFrame(place); };

  /* ---------------- Personality ---------------- */
  function chipsFor(route) {
    const c = [];
    if (route === 'home') {
      c.push({ label: t('guide.chip.tour'), primary: true, run: () => tour() });
      c.push({ label: t('guide.chip.lab'), run: () => { location.hash = '#/chords'; } });
      if (A && Store.count()) c.push({ label: t('guide.chip.random'), run: () => { A.randomSong(); } });
    } else if (route === 'library' && !Store.count()) {
      c.push({ label: t('guide.chip.first'), primary: true, run: () => { location.hash = '#/'; } });
    } else if (route === 'library') {
      c.push({ label: t('guide.chip.random'), primary: true, run: () => { A.randomSong(); } });
    }
    return c;
  }
  function lineFor(route, ctx) {
    const n = Store.count();
    if (route === 'home') {
      const first = ls.get('aq.guide.seen', '0') !== '1';
      ls.set('aq.guide.seen', '1');
      return { text: first ? t('guide.home.first') : (n ? tf('guide.home.back', { n }) : t('guide.home.again')), react: 'wave', chips: chipsFor('home'), priority: 1, open: first };
    }
    if (route === 'job') return { text: t('guide.job'), react: 'present', priority: 2 };
    if (route === 'library') return { text: n ? tf('guide.library', { n }) : t('guide.libraryEmpty'), react: n ? 'present' : 'wink', chips: chipsFor('library') };
    if (route === 'song') return { text: t('guide.song'), priority: 0 };
    if (route === 'chords') return { text: t('guide.lab'), react: 'present' };
    if (route === 'edit') return { text: t('guide.edit'), priority: 0 };
    if (route === 'settings') return { text: t('guide.settings'), react: 'wink' };
    return null;
  }
  function greet(force) {
    const l = lineFor(curRoute, routeCtx);
    if (l) { if (force) { release(); l.priority = 2; l.open = true; } say(l); }
  }
  function poke() {
    release();
    const pokes = [
      { text: t('guide.poke1'), react: 'wink' },
      { text: t('guide.poke2'), react: 'cheer' },
      { text: t('guide.poke3'), react: 'wave' },
      { text: t('guide.poke4'), react: 'present', chips: [{ label: t('guide.chip.lab'), primary: true, run: () => { location.hash = '#/chords'; } }] },
    ];
    say(Object.assign({ priority: 2, open: true }, pick(pokes)));
  }

  // ชีวิตตอนว่าง: ขยับเล่นทุก 9–18 วิ และบอกทิปบ้าง (ไม่เกิน 3 ครั้ง)
  function idleLife() {
    let next = performance.now() + 9000 + Math.random() * 9000;
    setInterval(() => {
      if (!enabled || document.hidden || typing || busy || minimized || mode === 'mini' || tourStep >= 0) return;
      const now = performance.now();
      if (now - lastLineAt > 40000 && tipCount < 3) {
        tipCount++;
        const tips = [t('guide.tip1'), t('guide.tip2'), t('guide.tip3'), t('guide.tip4'), t('guide.tip5')];
        say({ text: pick(tips), react: 'wink', priority: 0 });
        return;
      }
      if (now > next && motionOn()) {
        next = now + 9000 + Math.random() * 9000;
        playOnce(Math.random() < 0.6 ? 'wink' : 'wave');
      }
    }, 1000);
  }

  /* ---------------- Tour ---------------- */
  function visible(sel) {
    return Array.from(document.querySelectorAll(sel)).find((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
  }
  const STEPS = [
    { sel: '#dropzone', key: 'tour.1', react: 'present' },
    { sel: '#lyrBox', key: 'tour.2', react: 'present' },
    { sel: '#startBtn', key: 'tour.3', react: 'cheer' },
    { sel: '.side-link[data-route="library"], .tab[data-route="library"]', key: 'tour.4', react: 'present' },
    { sel: '.side-link[data-route="chords"], .tab[data-route="chords"]', key: 'tour.5', react: 'wink' },
  ];
  function clearFocus() { document.querySelectorAll('.tour-focus').forEach((e) => e.classList.remove('tour-focus')); }
  function tour() {
    if (!enabled) return;
    if (minimized) setMinimized(false);
    tourStep = 0;
    stepTour();
  }
  function stepTour() {
    clearFocus();
    let s = STEPS[tourStep];
    while (s && !visible(s.sel)) { tourStep++; s = STEPS[tourStep]; }
    if (!s) { endTour(true); return; }
    const el = visible(s.sel);
    el.classList.add('tour-focus');
    if (getComputedStyle(el).position !== 'fixed') el.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'center' });
    const last = tourStep === STEPS.length - 1;
    release();
    say({
      text: `${tourStep + 1}/${STEPS.length} · ${t(s.key)}`, react: s.react, priority: 3, open: true, hold: 600000,
      chips: [
        { label: last ? t('tour.done') : t('tour.next'), primary: true, run: () => { tourStep++; stepTour(); } },
        { label: t('tour.skip'), run: () => endTour() },
      ],
    });
    setBubble(true);
  }
  function endTour(finished) {
    tourStep = -1; clearFocus(); release();
    if (finished) say({ text: t('tour.end'), react: 'cheer', priority: 2, open: true });
    else setBubble(false);
  }

  /* ---------------- Public API ---------------- */
  window.Guide = {
    init(api) {
      A = api;
      enabled = ls.get('aq.guide.off', '0') !== '1';
      build();
      minimized = ls.get('aq.guide.min', '0') === '1';
      root.setAttribute('data-min', minimized ? '1' : '0');
      root.setAttribute('data-mode', mode);
      root.hidden = !enabled;
      window.addEventListener('scroll', queue, { passive: true });
      window.addEventListener('resize', queue);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { if (active) active.pause(); }
        else if (active && !minimized && mode !== 'mini') { const p = active.play(); if (p && p.catch) p.catch(() => {}); }
      });
      // ปิด Motion → หยุดคลิป เหลือภาพนิ่ง
      new MutationObserver(() => { if (!canPlayAlpha() && active) { active.classList.remove('on'); active.pause(); active = null; figure.classList.remove('clip-on'); } else if (canPlayAlpha() && !active && !minimized && mode !== 'mini') show(loopMove); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
      place();
      show('idle');
      setTimeout(trickle, 6000);
      idleLife();
    },
    onRoute(route, ctx) {
      curRoute = route; routeCtx = ctx || {};
      if (tourStep >= 0 && route !== 'home') { tourStep = -1; clearFocus(); }
      place();
      setTimeout(place, 80);
      if (!enabled) return;
      // มือถือ: เปลี่ยนหน้าแล้วเก็บกล่องคำพูด (ไม่บังเนื้อหา) — มีแค่จุดแจ้งเตือนบนรูปหน้า
      if (mode === 'mini' && tourStep < 0) setBubble(false);
      clearTimeout(this._greetT);
      this._greetT = setTimeout(() => greet(false), route === 'home' ? 700 : 400);
    },
    say(line) { return say(line); },
    cheer(text) { release(); say({ text, react: 'cheer', priority: 2, open: true }); },
    tour,
    collapse() { if (root && bubbleOn) { setBubble(false); if (tourStep >= 0) endTour(); } },
    setEnabled(on) {
      enabled = !!on;
      if (!root) return;
      root.hidden = !enabled;
      document.documentElement.classList.toggle('guide-staged', enabled && mode === 'stage' && !minimized);
      if (enabled) { setMinimized(false); place(); greet(true); } else { setBubble(false); if (active) active.pause(); }
    },
    relang,
    place: queue,
  };
})();
