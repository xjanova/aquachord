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

  /* ---------- Web Audio ---------- */
  let ctx = null, bus = null;
  function audioCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // บัสรวม + คอมเพรสเซอร์ กันเสียงแตกเมื่อเล่นหลายโน้ตพร้อมกัน (จังหวะตีเร็ว + โซโล่)
  function output() {
    const c = audioCtx();
    if (!bus) {
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      const g = c.createGain(); g.gain.value = 0.95;
      comp.connect(g); g.connect(c.destination);
      bus = comp;
    }
    return bus;
  }

  /* ---------- เครื่องดนตรี: กีตาร์ (Karplus-Strong) / เปียโน (additive synth) ---------- */
  let instrument = 'guitar';
  function setInstrument(i) { instrument = i === 'piano' ? 'piano' : 'guitar'; }
  function getInstrument() { return instrument; }
  const KS_CACHE = new Map(), PIANO_CACHE = new Map();
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // บัฟเฟอร์สายดีด แคชต่อโน้ต 3 แบบสุ่ม — จังหวะตีเร็วเรียกหลายสิบครั้งต่อวินาที
  function ksBuffer(midi, variant) {
    const key = midi + ':' + variant;
    let b = KS_CACHE.get(key);
    if (b) return b;
    const c = audioCtx(), sr = c.sampleRate;
    const N = Math.max(2, Math.round(sr / mtof(midi)));
    const len = Math.floor(sr * 2.6);
    b = c.createBuffer(1, len, sr);
    const out = b.getChannelData(0), ring = new Float32Array(N);
    for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    for (let i = 0; i < len; i++) {
      const j = i % N;
      out[i] = ring[j];
      ring[j] = (ring[j] + ring[(j + 1) % N]) * 0.4967;
    }
    KS_CACHE.set(key, b);
    return b;
  }

  // เปียโน: ฮาร์มอนิก 8 ตัว (inharmonic เล็กน้อย) สองสายเพี้ยนกันนิด ๆ + เสียงค้อนสั้น ๆ — แคชต่อโน้ต
  function pianoBuffer(midi) {
    let b = PIANO_CACHE.get(midi);
    if (b) return b;
    const c = audioCtx(), sr = c.sampleRate;
    const f = mtof(midi);
    const len = Math.floor(sr * 3.2);
    b = c.createBuffer(1, len, sr);
    const out = b.getChannelData(0);
    const low = Math.max(0, Math.min(1, (76 - midi) / 40));
    for (let h = 1; h <= 8; h++) {
      const fh = f * h * Math.sqrt(1 + 0.00035 * h * h);
      if (fh > sr * 0.45) break;
      const amp = h === 1 ? 1 : (h === 2 ? 0.55 : 0.42 / Math.pow(h, 1.2));
      const tau = (0.7 + 2.8 * low) / (1 + 0.6 * (h - 1));
      const dk = Math.exp(-1 / (tau * sr));
      const dets = h <= 2 ? [-0.0008, 0.0008] : [0];
      for (const det of dets) {
        const w = 2 * Math.PI * fh * (1 + det) / sr, co = Math.cos(w), si = Math.sin(w);
        let x = 1, y = 0, e = amp / dets.length;
        for (let i = 0; i < len; i++) { out[i] += y * e; const nx = x * co - y * si; y = x * si + y * co; x = nx; e *= dk; }
      }
    }
    const atk = Math.floor(sr * 0.003), ham = Math.floor(sr * 0.012);
    for (let i = 0; i < atk; i++) out[i] *= i / atk;
    let n = 0;
    for (let i = 0; i < ham; i++) { n = n * 0.6 + (Math.random() * 2 - 1) * 0.4; out[i] += n * 0.1 * (1 - i / ham); }
    let pk = 0;
    for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(out[i]));
    if (pk > 0) { const k = 0.8 / pk; for (let i = 0; i < len; i++) out[i] *= k; }
    PIANO_CACHE.set(midi, b);
    return b;
  }

  // เล่นโน้ตที่เวลา t0 (เวลาของ AudioContext) — o: { mute, bright, bend, bendTime, vib }
  /* ---------- เสียงเฉพาะแทร็ก (มิกเซอร์หลายเครื่องดนตรี): กลองสังเคราะห์ · ลีด · เสียงร้อง ---------- */
  let noiseBuf = null;
  function noise() {
    if (noiseBuf) return noiseBuf;
    const c = audioCtx(), len = Math.floor(c.sampleRate * 1.2);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  function env(g, t0, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }
  // คีย์กลองแบบ GM: 35/36 กระเดื่อง · 37/38/40 สแนร์ · 42/44 ไฮแฮตปิด · 46 เปิด · 49/57 แฉ · 51/59 ride · 41–50 ทอม
  function drumAt(key, t0, vol, dest) {
    const c = audioCtx(), out = dest || output();
    vol = Math.max(0.05, Math.min(1, vol));
    if (key === 35 || key === 36) {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(150, t0); o.frequency.exponentialRampToValueAtTime(45, t0 + 0.12);
      env(g, t0, 0.9 * vol, 0.003, 0.32);
      o.connect(g).connect(out); o.start(t0); o.stop(t0 + 0.4);
      return;
    }
    if (key >= 41 && key <= 50 && key !== 42 && key !== 44 && key !== 46 && key !== 49) {
      const o = c.createOscillator(), g = c.createGain();
      const f = 80 + (key - 41) * 18;
      o.frequency.setValueAtTime(f * 1.6, t0); o.frequency.exponentialRampToValueAtTime(f, t0 + 0.08);
      env(g, t0, 0.55 * vol, 0.004, 0.3);
      o.connect(g).connect(out); o.start(t0); o.stop(t0 + 0.4);
      return;
    }
    const src = c.createBufferSource(); src.buffer = noise();
    const f = c.createBiquadFilter(), g = c.createGain();
    if (key === 37 || key === 38 || key === 40) {
      f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7;
      env(g, t0, 0.55 * vol, 0.002, 0.18);
      const o = c.createOscillator(), og = c.createGain();
      o.frequency.setValueAtTime(220, t0); o.frequency.exponentialRampToValueAtTime(160, t0 + 0.08);
      env(og, t0, 0.35 * vol, 0.002, 0.1);
      o.connect(og).connect(out); o.start(t0); o.stop(t0 + 0.2);
    } else if (key === 46) { f.type = 'highpass'; f.frequency.value = 7000; env(g, t0, 0.22 * vol, 0.002, 0.32); }
    else if (key === 49 || key === 57 || key === 52 || key === 55) { f.type = 'highpass'; f.frequency.value = 5000; env(g, t0, 0.28 * vol, 0.004, 1.1); }
    else if (key === 51 || key === 59 || key === 53) { f.type = 'bandpass'; f.frequency.value = 6500; f.Q.value = 1.5; env(g, t0, 0.18 * vol, 0.002, 0.45); }
    else { f.type = 'highpass'; f.frequency.value = 8000; env(g, t0, 0.2 * vol, 0.001, 0.05); }
    src.connect(f).connect(g).connect(out);
    src.start(t0, Math.random() * 0.5); src.stop(t0 + 1.3);
  }
  // ลีดซินธ์ (ทำนอง) / เสียงร้อง (ไซน์นุ่ม + ไวเบรโต)
  function synthAt(midi, t0, dur, vol, voice, dest) {
    const c = audioCtx(), out = dest || output();
    const f0 = mtof(midi);
    dur = Math.max(0.05, Math.min(dur, 6));
    const g = c.createGain(), lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = voice === 'voice' ? 1800 : 3200;
    const oscs = voice === 'voice' ? [['sine', 1, 0.7], ['triangle', 2, 0.18]] : [['sawtooth', 1, 0.35], ['triangle', 1.003, 0.45]];
    const vib = c.createOscillator(), vg = c.createGain();
    vib.frequency.value = 5.2; vg.gain.value = f0 * 0.006;
    vib.connect(vg);
    oscs.forEach(([type, mul, amp]) => {
      const o = c.createOscillator(), og = c.createGain();
      o.type = type; o.frequency.value = f0 * mul; og.gain.value = amp;
      vg.connect(o.frequency);
      o.connect(og).connect(lp);
      o.start(t0); o.stop(t0 + dur + 0.15);
    });
    vib.start(t0 + 0.12); vib.stop(t0 + dur + 0.15);
    const a = voice === 'voice' ? 0.04 : 0.01;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + a);
    g.gain.setValueAtTime(vol * 0.85, t0 + Math.max(a + 0.01, dur - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.12);
    lp.connect(g).connect(out);
  }

  function noteAt(midi, t0, dur, vol, o) {
    o = o || {};
    if (o.voice === 'drum') { drumAt(midi, t0, vol, o.dest); return; }
    if (o.voice === 'lead' || o.voice === 'voice') { synthAt(midi, t0, dur || 0.5, vol, o.voice, o.dest); return; }
    const c = audioCtx();
    const piano = o.voice ? o.voice === 'piano' : (instrument === 'piano' && !o.guitar);
    if (o.voice === 'bass') { o = Object.assign({}, o); o.bassTone = true; }
    const maxDur = piano ? 3.1 : 2.5;
    dur = Math.max(0.03, Math.min(dur || 1.5, maxDur));
    const src = c.createBufferSource();
    src.buffer = piano ? pianoBuffer(midi) : ksBuffer(midi, (Math.random() * 3) | 0);
    if (o.bend) {
      src.playbackRate.setValueAtTime(Math.pow(2, -o.bend / 12), t0);
      src.playbackRate.linearRampToValueAtTime(1, t0 + (o.bendTime || 0.12));
    }
    let lfo = null;
    if (o.vib) {
      lfo = c.createOscillator(); const lg = c.createGain();
      lfo.frequency.value = 5.6; lg.gain.value = 0.007;
      lfo.connect(lg).connect(src.playbackRate);
      lfo.start(t0 + 0.12); lfo.stop(t0 + dur);
    }
    const lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = o.bassTone ? 1100 : o.mute ? 900 : (o.bright ? 6500 : (piano ? 7000 : 3800));
    const g = c.createGain();
    const rel = piano ? 0.18 : (o.mute ? 0.04 : 0.08);
    g.gain.setValueAtTime(vol, t0);
    g.gain.setValueAtTime(vol, t0 + Math.max(0.01, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(g).connect(o.dest || output());
    src.start(t0); src.stop(t0 + dur + 0.02);
  }
  // เวลาแบบสัมพัทธ์ (วินาทีจากตอนนี้)
  function note(midi, when, dur, vol, o) { noteAt(midi, audioCtx().currentTime + (when || 0), dur, vol == null ? 0.3 : vol, o); }
  // ชื่อเดิม (กีตาร์เสมอ) — คงไว้ให้โค้ดเก่า
  function pluck(midi, when, dur, vol) { note(midi, when, dur || 1.7, vol == null ? 0.32 : vol, { guitar: true }); }

  function strum(midis, gapMs) {
    const c = audioCtx(), t = c.currentTime + 0.01;
    const piano = instrument === 'piano';
    const gap = piano ? 0.006 : (gapMs == null ? 32 : gapMs) / 1000;
    midis.forEach((m, i) => noteAt(m, t + i * gap, piano ? 1.8 : 1.9, piano ? 0.24 : 0.28));
  }
  function playChord(sym) { strum(chordVoicing(sym)); }

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

  /* ---------- เสียงคอร์ดตามเครื่องดนตรี ---------- */
  // เปียโน: เบสมือซ้าย (C2–B2) + คอร์ดตำแหน่งชิดกลางคีย์บอร์ด (ไม่เกิน 4 โน้ต)
  function pianoVoicing(sym) {
    const c = parseChord(sym);
    if (!c) return [];
    const q = normQuality(c.quality);
    const iv = (QUALITY[q] || QUALITY[reduceQuality(q)] || QUALITY['']).slice();
    if (iv.length > 4) iv.splice(iv.indexOf(7), 1);
    const pc = pcOf(c.root);
    let base = 60 + pc;
    if (base > 66) base -= 12;
    return [36 + (c.bass ? pcOf(c.bass) : pc)].concat(iv.map((i) => base + i));
  }
  function chordPcs(sym) {
    const c = parseChord(sym);
    if (!c) return [];
    const q = normQuality(c.quality);
    return (QUALITY[q] || QUALITY[reduceQuality(q)] || QUALITY['']).map((i) => (pcOf(c.root) + i) % 12);
  }
  function chordVoicing(sym) { return instrument === 'piano' ? pianoVoicing(sym) : voicingMidis(sym); }

  /* ---------- จังหวะการตี / เกา หลายสไตล์ ----------
     ตัวอักษรต่อช่องจังหวะ: D ตีลงเต็ม · d ตีลงเบา (สายบน) · U ตีขึ้น · X ตบสายบอด · C สับคอร์ดสั้น
     B เบสตัวต้น · b เบสสลับ · p i m a = นิ้วโป้ง/ชี้/กลาง/นาง (เกา) · . = เว้น */
  const PATTERNS = [
    { id: 'single', grid: 0, th: 'ทีละคอร์ด', en: 'One strum per chord' },
    { id: 'pop', meter: 4, grid: 8, steps: 'D.DU.UDU', th: 'ป๊อป', en: 'Pop' },
    { id: 'ballad', meter: 4, grid: 8, steps: 'pimiaimi', th: 'บัลลาด (เกา)', en: 'Ballad picking' },
    { id: 'slowrock', meter: 4, grid: 12, steps: 'pimamipimami', th: 'สโลว์ร็อก', en: 'Slow rock (12/8)' },
    { id: 'rock', meter: 4, grid: 8, steps: 'DDDDDDDD', pm: true, th: 'ร็อก', en: 'Rock 8ths' },
    { id: 'lukthung', meter: 4, grid: 8, steps: 'B.C.b.C.', th: 'ลูกทุ่ง / รำวง', en: 'Luk thung boom-chick' },
    { id: 'reggae', meter: 4, grid: 8, steps: '.C.C.C.C', th: 'เร็กเก้ / สกา', en: 'Reggae / ska' },
    { id: 'bossa', meter: 4, grid: 8, steps: 'B.CCb.C.', th: 'บอสซาโนวา', en: 'Bossa nova' },
    { id: 'travis', meter: 4, grid: 8, steps: 'BmbiBmba', th: 'โฟล์ก (แทรวิส)', en: 'Folk (Travis)' },
    { id: 'waltz', meter: 3, grid: 6, steps: 'B.C.C.', th: 'วอลทซ์ 3/4', en: 'Waltz 3/4' },
  ];
  const GLYPH = { D: '↓', d: '⇣', U: '↑', X: '×', C: '⤓', B: 'B', b: 'b', p: 'P', i: 'i', m: 'm', a: 'a', '.': '·' };
  function countLabels(p) {
    if (!p.grid) return [];
    if (p.grid === 12) return ['1', 't', 'a', '2', 't', 'a', '3', 't', 'a', '4', 't', 'a'];
    const out = [];
    for (let b = 1; b <= p.meter; b++) out.push(String(b), '&');
    return out;
  }

  // เล่นหนึ่งช่องจังหวะของคอร์ด v (โน้ตเรียงต่ำ→สูง)
  function playStep(tok, v, at, step, accent, pm) {
    if (!v.length || tok === '.') return;
    const piano = instrument === 'piano';
    const n = v.length, hi = v.slice(Math.max(1, n - 4));
    const ring = Math.min(2.2, step * (piano ? 2.2 : 3));
    const acc = accent ? 1.15 : 1;
    if (piano) {
      const up = v.slice(1);
      if (tok === 'D') { noteAt(v[0], at, ring * 1.4, 0.24 * acc); up.forEach((m) => noteAt(m, at + 0.004, ring, 0.17 * acc)); }
      else if (tok === 'd' || tok === 'U') up.forEach((m) => noteAt(m, at, ring * 0.8, 0.12));
      else if (tok === 'X') up.forEach((m) => noteAt(m, at, 0.07, 0.12));
      else if (tok === 'C') up.forEach((m) => noteAt(m, at, Math.min(0.16, step * 0.8), 0.16 * acc));
      else if (tok === 'B' || tok === 'p') noteAt(v[0], at, step * 3.5, 0.26 * acc);
      else if (tok === 'b') noteAt(v[0] + 7 > 52 ? v[0] - 5 : v[0] + 7, at, step * 3, 0.22);
      else { const k = { i: 0, m: 1, a: 2 }[tok]; const m = up[Math.min(up.length - 1, k)]; if (m != null) noteAt(m, at, step * 4, 0.2); }
      return;
    }
    const gap = 0.011;
    if (tok === 'D') {
      const notes = pm ? v.slice(0, Math.min(3, n)) : v;
      notes.forEach((m, i) => noteAt(m, at + i * gap, pm ? 0.18 : ring, (pm ? 0.24 : 0.25) * acc, { mute: pm }));
    } else if (tok === 'd') hi.forEach((m, i) => noteAt(m, at + i * 0.009, ring * 0.8, 0.15));
    else if (tok === 'U') hi.slice().reverse().forEach((m, i) => noteAt(m, at + i * 0.009, ring * 0.8, 0.16));
    else if (tok === 'X') { v.forEach((m, i) => noteAt(m, at + i * 0.004, 0.05, 0.16, { mute: true })); }
    else if (tok === 'C') hi.forEach((m, i) => noteAt(m, at + i * 0.006, Math.min(0.13, step * 0.7), 0.2 * acc, { mute: false }));
    else if (tok === 'B' || tok === 'p') noteAt(v[0], at, step * 3.5, 0.3 * acc);
    else if (tok === 'b') noteAt(v[Math.min(1, n - 1)], at, step * 3, 0.26);
    else { const idx = { i: n - 3, m: n - 2, a: n - 1 }[tok]; noteAt(v[Math.max(0, idx)], at, step * 4, 0.24); }
  }

  // RNG ที่กำหนด seed ได้ — เพลงเดิมได้ลูกเล่นแบบเดิมทุกครั้ง
  function rng(seed) {
    let a = seed >>> 0 || 1;
    return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // ลูกเล่นโซโล่: ทำนองเพนทาโทนิกตามคีย์ ถาม-ตอบทุก 4 ห้อง เข้าหาโน้ตในคอร์ดตอนเปลี่ยนคอร์ด
  // พร้อมเบนด์/สไลด์/ไวเบรโตแบบกีตาร์โซโล่
  function leadLine(seq, chordAt, o) {
    const r = rng(o.seed || 7);
    const km = String(o.key || (seq[0] && seq[0].chord) || 'C').match(/^([A-G][#b]?)(m?)/) || [0, 'C', ''];
    const tonic = pcOf(normRoot(km[1])) || 0;
    const scale = (km[2] ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]).map((x) => (x + tonic) % 12);
    const piano = instrument === 'piano';
    const lo = piano ? 67 : 64, hi = piano ? 86 : 84;
    const pool = [];
    for (let m = lo; m <= hi; m++) if (scale.includes(m % 12)) pool.push(m);
    const RHY = ['10110100', '10101010', '11011000', '10010110', '00101101', '11101000', '10100111'];
    const step = o.beat / 2, perBar = 8 * o.meter / 4;
    const bars = Math.ceil(o.end / (step * perBar));
    let pi = Math.floor(pool.length / 2);
    const notes = [];
    for (let b = 0; b < bars; b++) {
      if (b % 4 === 2) continue;
      const rh = RHY[Math.floor(r() * RHY.length)];
      const ons = [];
      for (let s = 0; s < perBar; s++) if (rh[s % 8] === '1') ons.push(s);
      ons.forEach((s, k) => {
        const t = (b * perBar + s) * step;
        if (t >= o.end) return;
        const ch = chordAt(t);
        const tones = ch ? chordPcs(ch) : [];
        if ((s % 4 === 0 || k === 0) && tones.length) {
          let best = pi, bd = 99;
          pool.forEach((m, j) => { if (tones.includes(m % 12) && Math.abs(j - pi) < bd) { bd = Math.abs(j - pi); best = j; } });
          pi = best;
        } else {
          const x = r();
          const dir = pi > pool.length * 0.7 ? -1 : pi < pool.length * 0.3 ? 1 : (r() < 0.5 ? -1 : 1);
          pi = Math.max(0, Math.min(pool.length - 1, pi + (x < 0.5 ? dir : x < 0.8 ? 2 * dir : 0)));
        }
        const next = ons[k + 1] != null ? ons[k + 1] : perBar;
        const d = Math.min((next - s) * step * 0.95, o.beat * 1.5);
        const tech = {};
        if (!piano) {
          if (d >= o.beat * 0.9 && r() < 0.35) { tech.bend = 2; tech.bendTime = 0.14; }
          else if (d >= o.beat * 0.9) tech.vib = true;
          else if (r() < 0.12) { tech.bend = 1; tech.bendTime = 0.05; }
          tech.bright = true;
        }
        notes.push({ t, d, midi: pool[pi], tech });
      });
    }
    return notes;
  }

  /* ตัวเล่นจังหวะ: จัดคิวด้วยนาฬิกาของ Web Audio (แม่นกว่า setTimeout) มองล่วงหน้า 0.25 วินาที
     o: { seq:[{t, chord, label}], end, bpm, pattern, solo, key, seed, repeat, onChord(i), onStep(k), onEnd() } */
  const R = { on: false, gen: 0, timer: 0 };
  function rhythmStop() { R.on = false; R.gen++; clearTimeout(R.timer); }
  function rhythmPlay(o) {
    rhythmStop();
    const gen = R.gen;
    const c = audioCtx();
    const pat = PATTERNS.find((p) => p.id === o.pattern) || PATTERNS[1];
    const bpm = Math.max(40, Math.min(220, +o.bpm || 90));
    const beat = 60 / bpm, meter = pat.meter || 4;
    const seq = (o.seq || []).filter((e) => isChord(e.chord));
    if (!seq.length) return false;
    const reps = Math.max(1, o.repeat || 1);
    const span = o.end || (seq[seq.length - 1].t + beat * meter);
    const chordIdxAt = (t) => { let i = 0; while (i + 1 < seq.length && seq[i + 1].t <= t + 1e-6) i++; return i; };
    const voices = new Map();
    const voiceOf = (i) => { if (!voices.has(i)) voices.set(i, chordVoicing(seq[i].chord)); return voices.get(i); };
    const events = [];
    for (let rep = 0; rep < reps; rep++) {
      const off = rep * span;
      if (!pat.grid) {
        seq.forEach((e, i) => events.push({ t: off + e.t, kind: 'chord', i, d: Math.min(2.4, ((seq[i + 1] ? seq[i + 1].t : span) - e.t) || 2) }));
      } else {
        const step = beat * meter / pat.grid;
        for (let k = 0; k * step < span - 1e-6; k++) {
          const t = k * step;
          events.push({ t: off + t, kind: 'step', k: k % pat.grid, tok: pat.steps[k % pat.grid], i: chordIdxAt(t + step * 0.5), step, accent: k % pat.grid === 0 });
        }
      }
      if (o.solo) {
        leadLine(seq, (t) => seq[chordIdxAt(t)].chord, { key: o.key, seed: o.seed, beat, meter, end: span })
          .forEach((n) => events.push({ t: off + n.t, kind: 'lead', n }));
      }
    }
    events.sort((a, b) => a.t - b.t);
    const t0 = c.currentTime + 0.12;
    let idx = 0, lastI = -1;
    R.on = true;
    const ui = (fn, at) => setTimeout(() => { if (R.on && R.gen === gen) fn(); }, Math.max(0, (at - c.currentTime) * 1000));
    const pump = () => {
      if (!R.on || R.gen !== gen) return;
      const horizon = c.currentTime + 0.25;
      while (idx < events.length && t0 + events[idx].t < horizon) {
        const ev = events[idx++], at = t0 + ev.t;
        if (ev.kind === 'lead') {
          const n = ev.n;
          noteAt(n.midi, at, n.d + 0.25, instrument === 'piano' ? 0.2 : 0.3, Object.assign({ guitar: false }, n.tech));
          continue;
        }
        const v = voiceOf(ev.i);
        if (ev.kind === 'chord') v.forEach((m, j) => noteAt(m, at + j * (instrument === 'piano' ? 0.005 : 0.03), ev.d, instrument === 'piano' ? 0.22 : 0.27));
        else playStep(ev.tok, v, at, ev.step, ev.accent, pat.pm);
        if (ev.i !== lastI) { lastI = ev.i; const i = ev.i; if (o.onChord) ui(() => o.onChord(i), at); }
        if (ev.kind === 'step' && o.onStep) { const k = ev.k; ui(() => o.onStep(k), at); }
      }
      if (idx >= events.length) {
        const endAt = t0 + (events.length ? events[events.length - 1].t : 0) + 1.2;
        R.timer = setTimeout(() => { if (R.gen === gen) { R.on = false; if (o.onEnd) o.onEnd(); } }, Math.max(0, (endAt - c.currentTime) * 1000));
        return;
      }
      R.timer = setTimeout(pump, 45);
    };
    pump();
    return true;
  }

  /* ---------- ไดอะแกรมคีย์เปียโน (2 ช่วงเสียง) ---------- */
  const WHITE = [0, 2, 4, 5, 7, 9, 11];
  function pianoSVG(sym, opts) {
    opts = opts || {};
    const scale = opts.scale || 1;
    const v = pianoVoicing(sym);
    const label = String(sym).replace(/[<>"&]/g, '');
    const W = 154, H = 74, kw = 11, top = 6;
    if (!v.length) return `<svg class="pk" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}"><text class="dg-na" x="${W / 2}" y="${H / 2 + 6}" font-size="18" text-anchor="middle" fill="#6b8a96">?</text></svg>`;
    const up = v.slice(1);
    const start = Math.floor(Math.min.apply(null, up) / 12) * 12;
    const rootPc = pcOf(parseChord(sym).root);
    const on = new Set(up);
    let svg = `<svg class="pk" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">`;
    let wi = 0;
    const blacks = [];
    for (let m = start; m < start + 24; m++) {
      const pc = m % 12;
      if (WHITE.includes(pc)) {
        const x = 2 + wi * kw;
        const hit = on.has(m);
        svg += `<rect class="pk-w${hit ? ' pk-on' : ''}" x="${x}" y="${top}" width="${kw - 1}" height="${H - top - 4}" rx="2" fill="${hit ? '#3df5d0' : '#dfeef0'}"/>`;
        if (hit) svg += `<circle class="pk-dot${pc === rootPc ? ' pk-root' : ''}" cx="${x + (kw - 1) / 2}" cy="${H - 14}" r="3.2" fill="#03201a"/>`;
        wi++;
      } else blacks.push({ m, x: 2 + wi * kw - 3.5 });
    }
    blacks.forEach((k) => {
      const hit = on.has(k.m);
      svg += `<rect class="pk-b${hit ? ' pk-on' : ''}" x="${k.x}" y="${top}" width="7" height="${(H - top) * 0.6}" rx="1.5" fill="${hit ? '#3df5d0' : '#0b1622'}"/>`;
      if (hit) svg += `<circle class="pk-dot${k.m % 12 === rootPc ? ' pk-root' : ''}" cx="${k.x + 3.5}" cy="${top + (H - top) * 0.6 - 7}" r="2.4" fill="#03201a"/>`;
    });
    return svg + `</svg>`;
  }
  function diagram(sym, opts) { return instrument === 'piano' ? pianoSVG(sym, opts) : diagramSVG(sym, opts); }

  window.Music = {
    SHARP, FLAT, PATTERNS, GLYPH,
    parseChord, isChord, transposeChord, transposeKey,
    chordToMidis, chordNotes, voicingMidis, pianoVoicing, chordVoicing, noteNameToMidi,
    pluck, note, noteAt, drumAt, strum, playChord, output,
    setInstrument, getInstrument,
    rhythm: { play: rhythmPlay, stop: rhythmStop, get on() { return R.on; }, countLabels },
    diagram, diagramSVG, pianoSVG, shapeFor, audioCtx,
  };
})();
