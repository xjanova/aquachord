/* music.js — คอร์ด, transpose, เสียงโน้ต (Web Audio Karplus-Strong), chord diagram */
(function () {
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const PC = { 'C':0,'C#':1,'DB':1,'D':2,'D#':3,'EB':3,'E':4,'FB':4,'F':5,'E#':5,'F#':6,'GB':6,'G':7,'G#':8,'AB':8,'A':9,'A#':10,'BB':10,'B':11,'CB':11 };
  // คีย์ที่นิยมเขียนด้วยแฟลต
  const FLAT_KEYS = new Set(['F','Bb','Eb','Ab','Db','Gb','Dm','Gm','Cm','Fm','Bbm','Ebm']);

  const CHORD_RE = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

  // intervals ต่อชนิดคอร์ด (semitone จาก root)
  const QUALITY = {
    '':      [0, 4, 7],        'maj':   [0, 4, 7],
    'm':     [0, 3, 7],        'min':   [0, 3, 7],
    '5':     [0, 7],
    '6':     [0, 4, 7, 9],     'm6':    [0, 3, 7, 9],
    '7':     [0, 4, 7, 10],    'maj7':  [0, 4, 7, 11],  'M7': [0,4,7,11],
    'm7':    [0, 3, 7, 10],    'm7b5':  [0, 3, 6, 10],  'dim': [0,3,6], 'dim7':[0,3,6,9],
    'aug':   [0, 4, 8],        '+':     [0, 4, 8],
    'sus2':  [0, 2, 7],        'sus4':  [0, 5, 7],      'sus': [0,5,7],
    '7sus4': [0, 5, 7, 10],
    '9':     [0, 4, 7, 10, 14],'maj9':  [0, 4, 7, 11, 14], 'm9': [0,3,7,10,14],
    'add9':  [0, 4, 7, 14],    '11':    [0,4,7,10,14,17], '13':[0,4,7,10,14,21],
  };

  function normRoot(r) { return r.length > 1 ? r[0].toUpperCase() + r[1] : r.toUpperCase(); }
  function pcOf(r) { return PC[r.toUpperCase()]; }

  function parseChord(sym) {
    if (!sym) return null;
    const m = sym.trim().match(CHORD_RE);
    if (!m) return null;
    const root = normRoot(m[1]);
    if (pcOf(root) === undefined) return null;
    const quality = m[2] || '';
    const bass = m[3] ? normRoot(m[3]) : null;
    return { root, quality, bass, raw: sym };
  }

  function isChord(sym) { return !!parseChord(sym); }

  function nameFromPc(pc, useFlat) {
    pc = ((pc % 12) + 12) % 12;
    return (useFlat ? FLAT : SHARP)[pc];
  }

  function transposeChord(sym, steps, keyHint) {
    const c = parseChord(sym);
    if (!c || steps === 0) return sym;
    const useFlat = keyHint ? FLAT_KEYS.has(keyHint) : (steps < 0);
    const newRoot = nameFromPc(pcOf(c.root) + steps, useFlat);
    let out = newRoot + c.quality;
    if (c.bass) out += '/' + nameFromPc(pcOf(c.bass) + steps, useFlat);
    return out;
  }

  // ชื่อคีย์ตามที่นักดนตรีเขียนจริง: เมเจอร์ Db Eb Ab Bb / ไมเนอร์ C#m F#m G#m Bbm
  const MAJOR_KEY = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_KEY = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  function transposeKey(key, steps) {
    if (!key) return key;
    const m = key.match(/^([A-G][#b]?)(m?)/);
    if (!m || pcOf(normRoot(m[1])) === undefined) return key;
    if (!steps) return key;
    const pc = (((pcOf(normRoot(m[1])) + steps) % 12) + 12) % 12;
    return m[2] ? MINOR_KEY[pc] + 'm' : MAJOR_KEY[pc];
  }

  // คอร์ด -> รายการ midi (root octave 3-4)
  function chordToMidis(sym) {
    const c = parseChord(sym);
    if (!c) return [];
    const iv = QUALITY[c.quality] !== undefined ? QUALITY[c.quality] : QUALITY[''];
    const rootMidi = 48 + pcOf(c.root); // C3 = 48
    const notes = iv.map((i) => rootMidi + i);
    if (c.bass) notes.unshift(36 + pcOf(c.bass)); // bass ต่ำลง
    return notes;
  }

  function noteNameToMidi(name) {
    const m = name.match(/^([A-G][#b]?)(-?\d)$/);
    if (!m) return 60;
    return (parseInt(m[2], 10) + 1) * 12 + pcOf(normRoot(m[1]));
  }

  /* ---------- Web Audio: Karplus-Strong pluck ---------- */
  let ctx = null;
  function audioCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function pluck(midi, when, dur, vol) {
    when = when || 0; dur = dur || 1.7; vol = vol == null ? 0.32 : vol;
    const c = audioCtx();
    const sr = c.sampleRate;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const N = Math.max(2, Math.round(sr / freq));
    const len = Math.floor(sr * dur);
    const buf = c.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const ring = new Float32Array(N);
    for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    for (let i = 0; i < len; i++) {
      const j = i % N;
      out[i] = ring[j];
      ring[j] = (ring[j] + ring[(j + 1) % N]) * 0.4967;
    }
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + when + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
    src.connect(lp).connect(g).connect(c.destination);
    src.start(c.currentTime + when);
    src.stop(c.currentTime + when + dur);
  }

  function strum(midis, gapMs) {
    gapMs = gapMs == null ? 42 : gapMs;
    midis.forEach((m, i) => pluck(m, (i * gapMs) / 1000, 1.9, 0.3));
  }

  function playChord(sym) { strum(chordToMidis(sym)); }

  /* ---------- Chord diagrams ---------- */
  // frets: index 0 = สาย E ต่ำ(6) ... 5 = E สูง(1);  -1 = mute, 0 = open
  // ท่าจับตำแหน่งเปิด (ทำมือ) — ใช้ก่อนเสมอถ้ามี
  const SHAPES = {
    'C': [-1,3,2,0,1,0], 'Cmaj7':[-1,3,2,0,0,0], 'C7':[-1,3,2,3,1,0], 'Cadd9':[-1,3,2,0,3,0],
    'D': [-1,-1,0,2,3,2], 'Dm':[-1,-1,0,2,3,1], 'D7':[-1,-1,0,2,1,2], 'Dmaj7':[-1,-1,0,2,2,2],
    'Dm7':[-1,-1,0,2,1,1], 'Dsus2':[-1,-1,0,2,3,0], 'Dsus4':[-1,-1,0,2,3,3],
    'E': [0,2,2,1,0,0], 'Em':[0,2,2,0,0,0], 'E7':[0,2,0,1,0,0], 'Em7':[0,2,0,0,0,0], 'Esus4':[0,2,2,2,0,0],
    'F': [1,3,3,2,1,1], 'Fmaj7':[-1,-1,3,2,1,0], 'Fm':[1,3,3,1,1,1],
    'G': [3,2,0,0,0,3], 'G7':[3,2,0,0,0,1], 'Gmaj7':[3,2,0,0,0,2],
    'A': [-1,0,2,2,2,0], 'Am':[-1,0,2,2,1,0], 'A7':[-1,0,2,0,2,0], 'Am7':[-1,0,2,0,1,0], 'Amaj7':[-1,0,2,1,2,0],
    'Asus2':[-1,0,2,2,0,0], 'Asus4':[-1,0,2,2,3,0],
    'B': [-1,2,4,4,4,2], 'Bm':[-1,2,4,4,3,2], 'B7':[-1,2,1,2,0,2], 'Bm7':[-1,2,0,2,0,2],
    'Bb': [-1,1,3,3,3,1], 'Bbm':[-1,1,3,3,2,1],
    'F#': [2,4,4,3,2,2], 'F#m':[2,4,4,2,2,2],
  };
  // ท่าเลื่อนได้ (barre) — ตัวเลข = ระยะจากเฟร็ตทาบ, 'x' = ไม่ดีด
  // E-shape: root อยู่สาย 6 · A-shape: root อยู่สาย 5 → คอร์ดไหนก็มีท่าจับเสมอ
  const E_SHAPES = {
    '': [0,2,2,1,0,0], 'm': [0,2,2,0,0,0], '7': [0,2,0,1,0,0], 'm7': [0,2,0,0,0,0],
    'maj7': [0,'x',1,1,0,'x'], 'sus4': [0,2,2,2,0,0], '7sus4': [0,2,0,2,0,0],
    '5': [0,2,2,'x','x','x'], 'dim': [0,1,2,0,'x','x'], '9': [0,2,0,1,0,2],
  };
  const A_SHAPES = {
    '': ['x',0,2,2,2,0], 'm': ['x',0,2,2,1,0], '7': ['x',0,2,0,2,0], 'm7': ['x',0,2,0,1,0],
    'maj7': ['x',0,2,1,2,0], 'sus2': ['x',0,2,2,0,0], 'sus4': ['x',0,2,2,3,0], '7sus4': ['x',0,2,0,3,0],
    '6': ['x',0,2,2,2,2], 'm6': ['x',0,2,2,1,2], 'dim': ['x',0,1,2,1,'x'], 'dim7': ['x',0,1,2,1,2],
    'm7b5': ['x',0,1,0,1,'x'], 'aug': ['x',0,3,2,2,1], 'add9': ['x',0,2,4,2,0], '9': ['x',0,-1,0,0,0],
    '5': ['x',0,2,2,'x','x'],
  };
  const Q_ALIAS = { 'maj': '', 'M': '', 'min': 'm', 'M7': 'maj7', 'sus': 'sus4', '+': 'aug', 'o': 'dim', 'o7': 'dim7' };

  function normQuality(q) {
    q = q || '';
    return Q_ALIAS[q] !== undefined ? Q_ALIAS[q] : q;
  }
  // คอร์ดซับซ้อน (11, 13, 7b9 ...) → ลดเหลือตระกูลหลักที่มีท่าจับ
  function reduceQuality(q) {
    const minor = /^m(?!aj)/.test(q);
    if (/add/.test(q)) return minor ? 'm' : '';
    if (/(7|9|11|13)/.test(q)) return /maj/.test(q) ? 'maj7' : (minor ? 'm7' : '7');
    return minor ? 'm' : '';
  }
  function movable(table, b, q) {
    const s = table[q];
    if (!s || s.some((v) => v !== 'x' && v + b < 0)) return null;
    return s.map((v) => (v === 'x' ? -1 : v + b));
  }

  function shapeFor(sym) {
    const c = parseChord(sym);
    if (!c) return null;
    const pc = pcOf(c.root);
    const names = [c.root, SHARP[pc], FLAT[pc]];
    const quals = [normQuality(c.quality)];
    const red = reduceQuality(quals[0]);
    if (red !== quals[0]) quals.push(red);
    for (const q of quals) {
      for (const n of names) if (SHAPES[n + q]) return SHAPES[n + q].slice();
      const bE = (pc - 4 + 12) % 12, bA = (pc - 9 + 12) % 12;
      const cands = [];
      const e = movable(E_SHAPES, bE, q); if (e) cands.push({ f: e, b: bE });
      const a = movable(A_SHAPES, bA, q); if (a) cands.push({ f: a, b: bA });
      if (cands.length) { cands.sort((x, y) => x.b - y.b); return cands[0].f; }
    }
    return null;
  }

  // เฟร็ตทาบ: นิ้วชี้กดหลายสายที่เฟร็ตต่ำสุด ลากไปถึงสาย 1 โดยไม่มีสายเปิด/สายบอดคั่น
  function barreOf(frets) {
    const fretted = frets.filter((f) => f > 0);
    if (!fretted.length) return null;
    const mn = Math.min.apply(null, fretted);
    const idx = frets.map((f, i) => (f === mn ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2 || idx[idx.length - 1] !== 5) return null;
    for (let i = idx[0]; i <= 5; i++) if (frets[i] <= 0) return null;
    // ท่ามีสายเปิด (เช่น D = xx0232) → นับเป็นทาบเฉพาะเมื่อสายที่ทาบเรียงติดกันถึงสาย 1 (Dm7, Dmaj7)
    if (frets.some((f) => f === 0)) for (let i = idx[0]; i <= 5; i++) if (frets[i] !== mn) return null;
    return { fret: mn, from: idx[0], to: 5 };
  }

  // เสียงตามท่าจับจริงบนกีตาร์ (สาย 6→1: E2 A2 D3 G3 B3 E4) — ได้ยินเหมือนดีดตามไดอะแกรม
  const OPEN_MIDI = [40, 45, 50, 55, 59, 64];
  function voicingMidis(sym) {
    const c = parseChord(sym);
    const f = shapeFor(sym);
    if (!c || !f) return chordToMidis(sym);
    const out = [];
    f.forEach((fr, i) => { if (fr >= 0) out.push(OPEN_MIDI[i] + fr); });
    if (!out.length) return chordToMidis(sym);
    if (c.bass) out.unshift(40 + ((pcOf(c.bass) - 4 + 12) % 12) - (out[0] <= 40 + ((pcOf(c.bass) - 4 + 12) % 12) ? 12 : 0));
    return out;
  }

  // ชื่อโน้ตในคอร์ดสะกดตามทฤษฎี (ตัวอักษรไล่ตามขั้น) เช่น Cm → C Eb G, D → D F# A
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const DEGREE = { 0: 0, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4, 8: 4, 9: 5, 10: 6, 11: 6, 14: 1, 17: 3, 21: 5 };
  const ACC = { 0: '', 1: '#', 2: '##', 11: 'b', 10: 'bb' };
  function chordNotes(sym) {
    const c = parseChord(sym);
    if (!c) return [];
    const q = normQuality(c.quality);
    const iv = QUALITY[q] || QUALITY[reduceQuality(q)] || QUALITY[''];
    const rootPc = pcOf(c.root), rootIdx = LETTERS.indexOf(c.root[0]);
    const out = [];
    iv.forEach((i) => {
      const li = (rootIdx + (DEGREE[i] != null ? DEGREE[i] : 0)) % 7;
      const diff = (((rootPc + i) - LETTER_PC[li]) % 12 + 12) % 12;
      const n = ACC[diff] != null ? LETTERS[li] + ACC[diff] : nameFromPc(rootPc + i, false);
      if (!out.includes(n)) out.push(n);
    });
    return out;
  }

  // SVG ใส่ class ให้ CSS ปรับสีตามธีม (attribute สีคือค่าสำรองเมื่อไม่มี CSS)
  function diagramSVG(sym, opts) {
    opts = opts || {};
    const frets = shapeFor(sym);
    const W = 108, H = 128, x0 = 22, y0 = 28, sw = 14, fh = 20, strings = 6, fretsN = 4;
    const scale = opts.scale || 1;
    const label = String(sym).replace(/[<>"&]/g, '');
    let svg = `<svg class="dg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">`;
    const grid = () => {
      let g = '';
      for (let f = 0; f <= fretsN; f++) {
        const y = y0 + f * fh;
        g += `<line class="dg-fret" x1="${x0}" y1="${y}" x2="${x0 + sw * 5}" y2="${y}" stroke="#2a5a5a" stroke-width="1.2"/>`;
      }
      for (let s = 0; s < strings; s++) {
        const x = x0 + s * sw;
        g += `<line class="dg-str" x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + fh * fretsN}" stroke="#3b6f6f" stroke-width="${(1 + (5 - s) * 0.18).toFixed(2)}"/>`;
      }
      return g;
    };
    svg += grid();
    if (!frets) {
      return svg + `<text class="dg-na" x="${x0 + sw * 2.5}" y="${y0 + fh * 2 + 6}" font-size="20" text-anchor="middle" fill="#6b8a96">?</text></svg>`;
    }
    const fretted = frets.filter((f) => f > 0);
    const maxF = fretted.length ? Math.max.apply(null, fretted) : 0;
    const base = maxF > fretsN ? Math.min.apply(null, fretted) : 1;
    if (base === 1) svg += `<rect class="dg-nut" x="${x0 - 1}" y="${y0 - 4}" width="${sw * 5 + 2}" height="4" rx="1.5" fill="#5eead4"/>`;
    else svg += `<text class="dg-base" x="${x0 - 7}" y="${y0 + fh * 0.5 + 4}" font-size="10" text-anchor="end" fill="#a9c7cf" font-family="monospace">${base}fr</text>`;
    const br = barreOf(frets);
    if (br) {
      const y = y0 + (br.fret - base + 0.5) * fh;
      svg += `<rect class="dg-barre" x="${x0 + br.from * sw - 6}" y="${y - 6}" width="${(br.to - br.from) * sw + 12}" height="12" rx="6" fill="#2dd4bf"/>`;
    }
    for (let s = 0; s < strings; s++) {
      const x = x0 + s * sw;
      const fr = frets[s];
      if (fr === -1) svg += `<text class="dg-mute" x="${x}" y="${y0 - 9}" font-size="10" fill="#6b8a96" text-anchor="middle" font-family="monospace">✕</text>`;
      else if (fr === 0) svg += `<circle class="dg-open" cx="${x}" cy="${y0 - 12}" r="4" fill="none" stroke="#5eead4" stroke-width="1.5"/>`;
      else if (!br || fr !== br.fret) svg += `<circle class="dg-dot" cx="${x}" cy="${y0 + (fr - base + 0.5) * fh}" r="6" fill="#2dd4bf"/>`;
    }
    return svg + `</svg>`;
  }

  window.Music = {
    SHARP, FLAT,
    parseChord, isChord, transposeChord, transposeKey,
    chordToMidis, chordNotes, voicingMidis, noteNameToMidi, pluck, strum, playChord,
    diagramSVG, shapeFor, audioCtx,
  };
})();
