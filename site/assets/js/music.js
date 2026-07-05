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

  function transposeKey(key, steps) {
    if (!key) return key;
    const m = key.match(/^([A-G][#b]?)(m?)/);
    if (!m) return key;
    const useFlat = FLAT_KEYS.has(key);
    return nameFromPc(pcOf(normRoot(m[1])) + steps, useFlat) + (m[2] || '');
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

  /* ---------- Chord diagrams (open positions) ---------- */
  // frets: index 0 = สาย E ต่ำ(6) ... 5 = E สูง(1);  -1 = mute, 0 = open
  const SHAPES = {
    'C': [-1,3,2,0,1,0], 'Cmaj7':[-1,3,2,0,0,0], 'C7':[-1,3,2,3,1,0],
    'D': [-1,-1,0,2,3,2], 'Dm':[-1,-1,0,2,3,1], 'D7':[-1,-1,0,2,1,2], 'Dmaj7':[-1,-1,0,2,2,2],
    'E': [0,2,2,1,0,0], 'Em':[0,2,2,0,0,0], 'E7':[0,2,0,1,0,0], 'Em7':[0,2,0,0,0,0],
    'F': [1,3,3,2,1,1], 'Fmaj7':[-1,-1,3,2,1,0], 'Fm':[1,3,3,1,1,1],
    'G': [3,2,0,0,0,3], 'G7':[3,2,0,0,0,1], 'Gmaj7':[3,2,0,0,0,2],
    'A': [-1,0,2,2,2,0], 'Am':[-1,0,2,2,1,0], 'A7':[-1,0,2,0,2,0], 'Am7':[-1,0,2,0,1,0], 'Amaj7':[-1,0,2,1,2,0],
    'B': [-1,2,4,4,4,2], 'Bm':[-1,2,4,4,3,2], 'B7':[-1,2,1,2,0,2], 'Bm7':[-1,2,0,2,0,2],
    'Bb': [-1,1,3,3,3,1], 'Bbm':[-1,1,3,3,2,1],
    'Fs': [2,4,4,3,2,2],
  };

  function shapeFor(sym) {
    if (SHAPES[sym]) return SHAPES[sym];
    const c = parseChord(sym);
    if (!c) return null;
    const key = c.root + c.quality;
    if (SHAPES[key]) return SHAPES[key];
    // ลองแค่ triad พื้นฐาน
    if (SHAPES[c.root + (c.quality.startsWith('m') && !c.quality.startsWith('maj') ? 'm' : '')])
      return SHAPES[c.root + (c.quality.startsWith('m') && !c.quality.startsWith('maj') ? 'm' : '')];
    return null;
  }

  function diagramSVG(sym) {
    const frets = shapeFor(sym);
    const W = 108, H = 128, x0 = 18, y0 = 26, sw = 15, fh = 20, strings = 6, fretsN = 4;
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
    // nut
    svg += `<rect x="${x0}" y="${y0-4}" width="${sw*(strings-1)}" height="4" rx="2" fill="#0b7d75"/>`;
    for (let f = 0; f <= fretsN; f++) {
      const y = y0 + f * fh;
      svg += `<line x1="${x0}" y1="${y}" x2="${x0+sw*(strings-1)}" y2="${y}" stroke="rgba(13,148,136,.4)" stroke-width="1.4"/>`;
    }
    for (let s = 0; s < strings; s++) {
      const x = x0 + s * sw;
      svg += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0+fh*fretsN}" stroke="rgba(13,148,136,.55)" stroke-width="1.4"/>`;
    }
    if (frets) {
      for (let s = 0; s < strings; s++) {
        const x = x0 + s * sw;
        const fr = frets[s];
        if (fr === -1) {
          svg += `<text x="${x}" y="${y0-8}" font-size="11" fill="#94b6b2" text-anchor="middle" font-family="monospace">✕</text>`;
        } else if (fr === 0) {
          svg += `<circle cx="${x}" cy="${y0-11}" r="4.5" fill="none" stroke="#0d9488" stroke-width="1.6"/>`;
        } else {
          const y = y0 + (fr - 0.5) * fh;
          svg += `<circle cx="${x}" cy="${y}" r="6.5" fill="#0d9488"/>`;
        }
      }
    } else {
      svg += `<text x="${W/2}" y="${H/2}" font-size="11" fill="#94b6b2" text-anchor="middle">— ${sym} —</text>`;
    }
    svg += `</svg>`;
    return svg;
  }

  window.Music = {
    parseChord, isChord, transposeChord, transposeKey,
    chordToMidis, noteNameToMidi, pluck, strum, playChord,
    diagramSVG, shapeFor, audioCtx,
  };
})();
