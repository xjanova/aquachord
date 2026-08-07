#!/usr/bin/env node
/* test-dsp.cjs — เทสต์เอนจินแกะคอร์ด (site/assets/js/dsp.js) ด้วยเสียงสังเคราะห์
   - สังเคราะห์เพลงคอร์ดจริง (partial stack + เบส + กลอง + นอยส์ + จูนเพี้ยน)
   - รันเอนจิน "legacy" (พารามิเตอร์เทียบเท่า v1.2) กับ "new" แล้วเทียบความแม่นต่อ beat
   - เทสต์การผสานเนื้อร้อง (layoutLyricLines) เรื่อง grapheme ไทย + ตำแหน่งคอร์ด
   ใช้: node tools/test-dsp.cjs  (exit 1 เมื่อไม่ผ่านเกณฑ์) */
'use strict';
const path = require('path');
const DSP = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'dsp.js'));

const SR = 11025;
const SHARP = DSP.SHARP;
const PC = {};
SHARP.forEach((n, i) => { PC[n] = i; });

/* ---------------- PRNG กำหนด seed ได้ (ผลเทสต์ reproducible) ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- สังเคราะห์เสียง ---------------- */
function chordMidis(sym) {
  const m = /^([A-G]#?)(m7|maj7|m|7)?$/.exec(sym);
  if (!m) throw new Error('bad chord ' + sym);
  const root = PC[m[1]];
  const iv = { undefined: [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11] }[m[2]];
  return { notes: iv.map((i) => 48 + root + i), bass: 36 + root };
}

// เสียงหนึ่งโน้ต: partial 1..8 (ฮาร์มอนิกแรงแบบกีตาร์) + envelope + vibrato (เสียงร้อง)
function addNote(buf, rnd, midi, t0, dur, amp, detuneCents, vibrato) {
  const f0 = 440 * Math.pow(2, (midi - 69) / 12) * Math.pow(2, detuneCents / 1200);
  const jitter = Math.pow(2, ((rnd() - 0.5) * 6) / 1200); // ±3 cents ต่อโน้ต
  const s0 = Math.floor(t0 * SR), n = Math.floor(dur * SR);
  const phases = [];
  for (let h = 1; h <= 8; h++) phases.push(rnd() * 2 * Math.PI);
  const vibHz = 5.2 + rnd() * 0.8, vibAmt = vibrato ? 12 : 0; // ±12 cents
  for (let i = 0; i < n; i++) {
    const idx = s0 + i;
    if (idx >= buf.length) break;
    const t = i / SR;
    const env = (vibrato ? Math.exp(-0.9 * t) : Math.exp(-2.2 * t)) * Math.min(1, t * 200);
    const vib = vibAmt ? Math.pow(2, (vibAmt * Math.sin(2 * Math.PI * vibHz * t)) / 1200) : 1;
    let v = 0;
    for (let h = 1; h <= 8; h++) {
      const fh = f0 * jitter * vib * h;
      if (fh > SR / 2 * 0.95) break;
      v += Math.sin(2 * Math.PI * fh * t + phases[h - 1]) / Math.pow(h, 0.95);
    }
    buf[idx] += v * amp * env;
  }
}

// เมโลดี้ร้องเดินบนสเกลของคีย์ (มีโน้ตนอกคอร์ด + โน้ตผ่าน) — ตัวก่อกวนหลักในเพลงจริง
function addMelody(buf, rnd, keyPc, minor, t0, t1, beat, detuneCents) {
  const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  let deg = Math.floor(rnd() * 7);
  let t = t0;
  while (t < t1 - 0.05) {
    const len = (rnd() < 0.4 ? 0.5 : 1) * beat; // ตัวดำ/ตัวเขบ็ต
    deg += Math.round((rnd() - 0.5) * 4);
    deg = ((deg % 7) + 7) % 7;
    let midi = 64 + keyPc + scale[deg]; // ~ออกเทฟ 5
    if (rnd() < 0.12) midi += rnd() < 0.5 ? 1 : -1; // โครมาติกผ่านบางครั้ง
    if (rnd() > 0.15) addNote(buf, rnd, midi, t, Math.min(len * 1.1, t1 - t), 0.55, detuneCents, true);
    t += len;
  }
}

function addDrum(buf, rnd, t0, amp, lenSec) {
  const s0 = Math.floor(t0 * SR), n = Math.floor(lenSec * SR);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const idx = s0 + i;
    if (idx >= buf.length) break;
    const w = rnd() * 2 - 1;
    lp = 0.7 * lp + 0.3 * w; // นอยส์โทนต่ำหน่อยแบบกลอง
    buf[idx] += lp * amp * Math.exp(-18 * (i / SR));
  }
}

/* progression: [{chord, beats}]  opts.melodyKey: 'C'|'Am'|... เปิดเสียงร้องกวน */
function synth(progression, opts) {
  opts = opts || {};
  const bpm = opts.bpm || 120;
  const detune = opts.detuneCents || 0;
  const drums = opts.drums || 0;
  const noise = opts.noise || 0;
  const seed = opts.seed || 42;
  const rnd = mulberry32(seed);
  const beat = 60 / bpm;
  const totalBeats = progression.reduce((s, p) => s + p.beats, 0);
  const dur = totalBeats * beat + 1.5;
  const buf = new Float32Array(Math.ceil(dur * SR));
  const truth = []; // {t0, t1, chord}

  let t = 0.25; // นำหน้าเงียบสั้น ๆ
  for (const p of progression) {
    const { notes, bass } = chordMidis(p.chord);
    truth.push({ t0: t, t1: t + p.beats * beat, chord: p.chord });
    // voicing แบบกีตาร์: triad + คู่แปดของ root และ 3rd
    const voiced = notes.concat([notes[0] + 12, notes[1] + 12]);
    for (let b = 0; b < p.beats; b++) {
      const tb = t + b * beat;
      // เบสสลับ root (จังหวะ 1,2,4) / คู่ห้า (จังหวะ 3) แบบมือเบสจริง
      const bassMidi = b % 4 === 2 ? bass + 7 : bass;
      addNote(buf, rnd, bassMidi, tb, beat * 1.6, 0.55, detune);
      // ตีคอร์ดลงหนักต้น beat + ตีขึ้นเบา ๆ กลาง beat
      voiced.forEach((nMidi, i) => addNote(buf, rnd, nMidi, tb + i * 0.014, beat * 1.2, 0.26, detune));
      if (rnd() < 0.7) voiced.slice(1, 4).forEach((nMidi, i) =>
        addNote(buf, rnd, nMidi, tb + beat / 2 + i * 0.01, beat * 0.5, 0.13, detune));
      if (drums) {
        addDrum(buf, rnd, tb, drums * (b % 2 === 0 ? 1 : 0.7), 0.06);
        addDrum(buf, rnd, tb + beat / 2, drums * 0.35, 0.03);
      }
    }
    t += p.beats * beat;
  }
  if (opts.melodyKey) {
    const mk = /^([A-G]#?)(m?)$/.exec(opts.melodyKey);
    addMelody(buf, rnd, PC[mk[1]], !!mk[2], 0.25 + beat * 2, t, beat, detune);
  }
  if (noise) for (let i = 0; i < buf.length; i++) buf[i] += (rnd() * 2 - 1) * noise;
  // normalize กัน clip
  let mx = 0;
  for (let i = 0; i < buf.length; i++) mx = Math.max(mx, Math.abs(buf[i]));
  if (mx > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] / mx) * 0.85;
  return { buf, truth, bpm, beat };
}

/* ---------------- รันเอนจิน ---------------- */
const LEGACY = {
  chroma: { peakPick: false, tuning: false, harmonics: false, smooth: false, hop: 2048 },
  decode: { sevenths: false, bassWeight: 0, keyAware: false, hSpill: 0, stay: 0.85 },
};
const NEW = { chroma: {}, decode: {} };

async function run(buf, cfg) {
  const ch = await DSP.analyzeChroma(buf, SR, cfg.chroma);
  const dec = await DSP.decodeChords(ch.chroma, ch.bass, ch.rms, ch.F,
    Object.assign({ frameSec: ch.frameSec }, cfg.decode));
  const segs = DSP.toSegments(dec.path, dec.labels, dec.nChords, ch.F, ch.frameSec, ch.t0);
  return { segs, key: dec.key, confidence: dec.confidence, tuningCents: ch.tuningCents };
}

const triad = (c) => {
  if (!c) return c;
  const m = /^([A-G]#?)(m7|maj7|m|7)?$/.exec(c);
  return m ? m[1] + (m[2] === 'm' || m[2] === 'm7' ? 'm' : '') : c;
};

function score(segs, truth, beat) {
  let okExact = 0, okTriad = 0, n = 0;
  for (const g of truth) {
    for (let t = g.t0 + beat / 2; t < g.t1; t += beat) {
      const c = DSP.chordAt(segs, t);
      n++;
      if (c === g.chord) okExact++;
      if (triad(c) === triad(g.chord)) okTriad++;
    }
  }
  return { exact: okExact / n, triad: okTriad / n, n };
}

/* ---------------- เคสทดสอบ ---------------- */
const CASES = [
  {
    name: 'pop I-V-vi-IV (C) + ร้อง',
    prog: rep([['C', 4], ['G', 4], ['Am', 4], ['F', 4]], 3),
    opts: { bpm: 120, seed: 1, melodyKey: 'C', drums: 0.3 },
    wantKey: 'C',
  },
  {
    name: 'จูนเพี้ยน +45c + ร้อง + กลอง',
    prog: rep([['C', 4], ['G', 4], ['Am', 4], ['F', 4]], 3),
    opts: { bpm: 120, detuneCents: 45, seed: 2, melodyKey: 'C', drums: 0.5 },
    wantKey: 'C',
  },
  {
    name: 'จูนเพี้ยน −40c + ร้อง + กลอง',
    prog: rep([['G', 4], ['D', 4], ['Em', 4], ['C', 4]], 3),
    opts: { bpm: 108, detuneCents: -40, drums: 0.6, seed: 3, melodyKey: 'G' },
    wantKey: 'G',
  },
  {
    name: 'คอร์ด 7th (jazz ii-V-I)',
    prog: rep([['Dm7', 4], ['G7', 4], ['Cmaj7', 8]], 3),
    opts: { bpm: 100, seed: 4 },
    wantKey: 'C',
    sevenths: true,
  },
  {
    name: 'minor + ร้อง + กลองหนัก + นอยส์',
    prog: rep([['Am', 4], ['F', 4], ['C', 4], ['G', 4]], 3),
    opts: { bpm: 128, drums: 0.9, noise: 0.02, seed: 5, melodyKey: 'Am' },
    wantKey: 'Am',
  },
  {
    name: 'คีย์แฟลต (A#) เพี้ยน −25c + ร้อง',
    prog: rep([['A#', 4], ['F', 4], ['Gm', 4], ['D#', 4]], 3),
    opts: { bpm: 96, detuneCents: -25, drums: 0.4, seed: 6, melodyKey: 'A#' },
    wantKey: 'A#',
  },
  {
    name: 'เปลี่ยนคอร์ดเร็ว (2 beat) + ร้อง',
    prog: rep([['D', 2], ['A', 2], ['Bm', 2], ['G', 2]], 5),
    opts: { bpm: 132, seed: 7, melodyKey: 'D', drums: 0.4 },
    wantKey: 'D',
  },
];

function rep(pairs, times) {
  const out = [];
  for (let i = 0; i < times; i++) pairs.forEach(([c, b]) => out.push({ chord: c, beats: b }));
  return out;
}

/* ---------------- เทสต์ layout เนื้อร้อง ---------------- */
function testLayout() {
  const fails = [];
  const t = (cond, msg) => { if (!cond) fails.push(msg); };

  // grapheme ไทยต้องไม่โดนผ่า (สระ/วรรณยุกต์ติดพยัญชนะ)
  const g = DSP.graphemes('เพื่อเธอฉันจะรอ');
  t(g.join('') === 'เพื่อเธอฉันจะรอ', 'graphemes รวมกลับไม่เท่าต้นฉบับ');
  t(!g.some((x) => /^[ัำ-ฺ็-๎]/.test(x)), 'มี grapheme ขึ้นต้นด้วยสระ/วรรณยุกต์ (โดนผ่า): ' + JSON.stringify(g));

  // ผสานคอร์ดลงเนื้อร้องตามเวลา
  const segs = [
    { chord: 'C', t0: 0, t1: 4 },
    { chord: 'G', t0: 4, t1: 8 },
    { chord: 'Am', t0: 8, t1: 12 },
    { chord: null, t0: 12, t1: 16 },
    { chord: 'F', t0: 16, t1: 24 },
  ];
  const chunks = [
    { t0: 0.2, t1: 7.8, text: 'ฉันเดินอยู่ตรงนั้นเธอเดินผ่านมา' },
    { t0: 8.1, t1: 11.5, text: 'ใจฉันก็สั่นไหว' },
    // ช่องว่างดนตรี 16→20 แล้วร้องต่อ
    { t0: 20.0, t1: 23.5, text: 'and then you smiled at me' },
  ];
  const blocks = DSP.layoutLyricLines(segs, chunks, { bpm: 120, phase: 0, duration: 24 });
  const lyr = blocks.filter((b) => b.type === 'lyric');
  t(lyr.length >= 3, 'ควรมีบรรทัดเนื้อร้อง ≥3 ได้ ' + lyr.length);
  t(lyr[0].text.startsWith('[C]'), 'บรรทัดแรกต้องขึ้นด้วย [C]: ' + lyr[0].text);
  t(lyr[0].text.includes('[G]'), 'บรรทัดแรกต้องมี [G] กลางบรรทัด: ' + lyr[0].text);
  t(lyr[1].text.startsWith('[Am]'), 'บรรทัดสองต้องขึ้น [Am]: ' + lyr[1].text);
  const hasGrid = blocks.some((b) => b.type === 'grid');
  t(hasGrid, 'ต้องมีบล็อกดนตรี (grid) ช่วง 12–20s');
  // คอร์ดต้องไม่แทรกกลาง grapheme: หลัง ] ต้องไม่ใช่สระบน/วรรณยุกต์
  for (const L of lyr) {
    t(!/\][ัำ-ฺ็-๎]/.test(L.text), 'คอร์ดแทรกกลาง grapheme: ' + L.text);
  }
  // ตัด junk + ยุบหลอนซ้ำ
  const cleaned = DSP.cleanChunks([
    { t0: 0, t1: 2, text: ' ขอบคุณครับ ' },
    { t0: 2, t1: 4, text: 'ท่อนฮุคซ้ำ' },
    { t0: 4, t1: 6, text: 'ท่อนฮุคซ้ำ' },
    { t0: 6, t1: 8, text: 'ท่อนฮุคซ้ำ' },
    { t0: 8, t1: 10, text: 'ท่อนฮุคซ้ำ' },
    { t0: 10, t1: 12, text: '♪' },
  ], 12);
  t(cleaned.length === 2, 'cleanChunks ควรเหลือ 2 (ฮุค×2) ได้ ' + cleaned.length + ': ' + JSON.stringify(cleaned.map((c) => c.text)));

  // บรรทัดยาวถูกตัด ≤42 grapheme
  const long = { t0: 0, t1: 20, text: 'ลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลลล' };
  const blocks2 = DSP.layoutLyricLines([{ chord: 'C', t0: 0, t1: 20 }], [long], { bpm: 120, phase: 0, duration: 20 });
  const lines2 = blocks2.filter((b) => b.type === 'lyric');
  t(lines2.length >= 2, 'บรรทัดยาวต้องถูกตัด ได้ ' + lines2.length);
  for (const L of lines2) {
    const textOnly = L.text.replace(/\[[^\]]+\]/g, '');
    t(DSP.graphemes(textOnly).length <= 42, 'บรรทัดยาวเกิน 42: ' + textOnly.length);
  }
  return fails;
}

/* ---------------- เทสต์แยกเสียงร้องออกจากดนตรี ---------------- */
// สร้างสเตอริโอ: เสียงร้องกลาง (เท่ากันสองข้าง) + ดนตรีแพนซ้าย/ขวา
// แล้ววัดว่า isolateCenter ทำให้อัตราส่วน ร้อง:ดนตรี ดีขึ้นกี่ dB
function testIsolate() {
  const fails = [];
  const rnd = mulberry32(11);
  const n = SR * 4;
  const vocal = new Float32Array(n), gtrL = new Float32Array(n), gtrR = new Float32Array(n);
  addMelody(vocal, rnd, 0, false, 0.1, 3.9, 0.5, 0);          // "เสียงร้อง"
  for (const m of [48, 52, 55]) addNote(gtrL, rnd, m, 0.1, 3.8, 0.5, 0);  // ดนตรีข้างซ้าย
  for (const m of [43, 47, 50]) addNote(gtrR, rnd, m, 0.1, 3.8, 0.5, 0);  // ดนตรีข้างขวา
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = vocal[i] + gtrL[i]; R[i] = vocal[i] + gtrR[i]; }

  const out = DSP.isolateCenter(L, R);
  // a/b ต้องเป็นจำนวนเต็ม — ดัชนีทศนิยมอ่าน typed array ได้ undefined แล้วผลรวมกลายเป็น NaN
  const energy = (x, a, b) => { let s = 0; for (let i = Math.floor(a); i < Math.floor(b); i++) s += x[i] * x[i]; return s; };
  // วัดผ่าน correlation กับ vocal เทียบกับ correlation กับดนตรี
  const corr = (x, y) => {
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
    return sxy / (Math.sqrt(sxx * syy) || 1);
  };
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) / 2;
  const music = new Float32Array(n);
  for (let i = 0; i < n; i++) music[i] = (gtrL[i] + gtrR[i]) / 2;

  const beforeV = corr(mono, vocal), beforeM = corr(mono, music);
  const afterV = corr(out, vocal), afterM = corr(out, music);
  console.log('  ก่อนแยก: corr(ร้อง)=' + beforeV.toFixed(3) + ' corr(ดนตรี)=' + beforeM.toFixed(3));
  console.log('  หลังแยก: corr(ร้อง)=' + afterV.toFixed(3) + ' corr(ดนตรี)=' + afterM.toFixed(3));
  const gainBefore = beforeV / (beforeM || 1e-9), gainAfter = afterV / (afterM || 1e-9);
  console.log('  อัตราส่วน ร้อง/ดนตรี: ' + gainBefore.toFixed(2) + ' → ' + gainAfter.toFixed(2));
  if (!(afterM < beforeM * 0.75)) fails.push('ดนตรีไม่ได้เบาลงพอ (' + beforeM.toFixed(3) + ' → ' + afterM.toFixed(3) + ')');
  if (!(afterV > 0.5)) fails.push('เสียงร้องถูกทำลายไปด้วย (corr=' + afterV.toFixed(3) + ')');
  if (!(gainAfter > gainBefore * 1.3)) fails.push('อัตราส่วนร้อง/ดนตรีดีขึ้นไม่พอ');
  if (out.length !== n) fails.push('ความยาวสัญญาณเปลี่ยน: ' + out.length + ' != ' + n);

  // mono (L==R) → ทุกอย่างอยู่กลางหมด ต้องคืนสัญญาณใกล้เดิม ไม่ใช่ความเงียบ
  const same = DSP.isolateCenter(mono, mono);
  if (!(energy(same, SR / 2, n - SR / 2) > energy(mono, SR / 2, n - SR / 2) * 0.5)) {
    fails.push('อินพุต mono ถูกหักจนเงียบ');
  }
  // prepForASR ต้อง normalize และไม่ทำให้เป็น NaN
  const prepped = DSP.prepForASR(out, SR);
  let mx = 0, bad = 0;
  for (let i = 0; i < prepped.length; i++) { const v = prepped[i]; if (!isFinite(v)) bad++; if (Math.abs(v) > mx) mx = Math.abs(v); }
  if (bad) fails.push('prepForASR ให้ค่า NaN/Infinity ' + bad + ' ตัว');
  if (!(mx > 0.9 && mx <= 1.0)) fails.push('prepForASR normalize ไม่ถูก (peak=' + mx.toFixed(3) + ')');
  return fails;
}

/* ---------------- main ---------------- */
(async () => {
  console.log('=== AquaChord DSP benchmark (สังเคราะห์เสียงจริง ไม่ mock) ===\n');
  const rows = [];
  let sumLegacyT = 0, sumNewT = 0, sumLegacyE = 0, sumNewE = 0;
  let keyOkLegacy = 0, keyOkNew = 0;
  const problems = [];

  for (const c of CASES) {
    const { buf, truth, beat } = synth(c.prog, c.opts);
    const legacy = await run(buf, LEGACY);
    const nw = await run(buf, NEW);
    const sl = score(legacy.segs, truth, beat);
    const sn = score(nw.segs, truth, beat);
    sumLegacyT += sl.triad; sumNewT += sn.triad;
    sumLegacyE += sl.exact; sumNewE += sn.exact;
    const relOf = (k) => (k.endsWith('m') ? SHARP[(PC[k.slice(0, -1)] + 3) % 12] : SHARP[(PC[k] + 9) % 12] + 'm');
    const keyMatch = (got, want) => got === want || got === relOf(want); // relative key นับว่าใช้ได้
    if (keyMatch(legacy.key, c.wantKey)) keyOkLegacy++;
    if (keyMatch(nw.key, c.wantKey)) keyOkNew++;
    rows.push([
      c.name,
      (sl.triad * 100).toFixed(0) + '%',
      (sn.triad * 100).toFixed(0) + '%',
      (sl.exact * 100).toFixed(0) + '%',
      (sn.exact * 100).toFixed(0) + '%',
      legacy.key + '→' + nw.key + ' (จริง ' + c.wantKey + ')',
      'tune ' + nw.tuningCents + 'c',
    ]);
    if (sn.triad < 0.85) problems.push(`เคส "${c.name}" triad acc ต่ำ: ${(sn.triad * 100).toFixed(0)}%`);
    if (sn.triad + 1e-9 < sl.triad - 0.02) problems.push(`เคส "${c.name}" เอนจินใหม่แย่กว่าเก่า (${(sn.triad * 100).toFixed(0)}% < ${(sl.triad * 100).toFixed(0)}%)`);
    if (c.sevenths && sn.exact < 0.6) problems.push(`เคส "${c.name}" จับ 7th ได้ต่ำ: exact ${(sn.exact * 100).toFixed(0)}%`);
  }

  const W = [34, 9, 9, 9, 9, 26, 10];
  const fmt = (r) => r.map((x, i) => String(x).padEnd(W[i])).join('');
  console.log(fmt(['เคส', 'เก่า(triad)', 'ใหม่(triad)', 'เก่า(exact)', 'ใหม่(exact)', 'คีย์ เก่า→ใหม่', 'จูนที่วัด']));
  rows.forEach((r) => console.log(fmt(r)));
  const n = CASES.length;
  console.log('\nเฉลี่ย triad:  เก่า ' + ((sumLegacyT / n) * 100).toFixed(1) + '%  →  ใหม่ ' + ((sumNewT / n) * 100).toFixed(1) + '%');
  console.log('เฉลี่ย exact:  เก่า ' + ((sumLegacyE / n) * 100).toFixed(1) + '%  →  ใหม่ ' + ((sumNewE / n) * 100).toFixed(1) + '%');
  console.log('คีย์ถูก:       เก่า ' + keyOkLegacy + '/' + n + '  →  ใหม่ ' + keyOkNew + '/' + n);

  if (sumNewT / n < sumLegacyT / n) problems.push('ค่าเฉลี่ย triad ของเอนจินใหม่แพ้เอนจินเก่า');
  if (keyOkNew < keyOkLegacy) problems.push('เอนจินใหม่หาคีย์ถูกน้อยกว่าเก่า');

  console.log('\n=== เทสต์ผสานเนื้อร้อง (layout) ===');
  const layoutFails = testLayout();
  if (layoutFails.length) layoutFails.forEach((f) => problems.push('layout: ' + f));
  console.log(layoutFails.length ? layoutFails.join('\n') : 'ผ่านทุกข้อ');

  console.log('\n=== เทสต์แยกเสียงร้องออกจากดนตรี (ก่อนส่ง Whisper) ===');
  const isoFails = testIsolate();
  if (isoFails.length) isoFails.forEach((f) => problems.push('isolate: ' + f));
  console.log(isoFails.length ? isoFails.join('\n') : 'ผ่านทุกข้อ');

  if (problems.length) {
    console.error('\n✗ FAILED:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('\n✓ ผ่านทุกเกณฑ์');
})().catch((e) => { console.error(e); process.exit(1); });
