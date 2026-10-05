#!/usr/bin/env node
/* test-riff.cjs — เทสต์เอนจินแกะลายโซโล่/ริฟฟ์ (site/assets/js/riff.js) ด้วยเสียงสังเคราะห์
   - สังเคราะห์กีตาร์ด้วย Karplus-Strong จริง (44.1kHz + fractional delay แล้ว decimate เหลือ 11025)
   - 3 ลาย × 2 แบบ: กีตาร์เดี่ยว / ผสมใต้ pad คอร์ดค้าง + นอยส์
   - วัดระดับโน้ต: onset ห่างจริง ≤ 50ms และ pitch ต่าง ≤ 0.5 semitone → precision/recall/F1
   - ตรวจ assignFrets (เล่นได้จริง: ช่วงเฟรตใน 1 beat ≤ 5) + toAsciiTab (บรรทัดยาวเท่ากันทุกแถว)
   - ตรวจ hook ใน analyze.js (stage 'riff', doc._riff, error ไม่ล้มทั้งงาน, ยกเลิกได้)
   ใช้: node tools/test-riff.cjs   (RIFF_LONG=1 เพิ่มเทสต์เสียง 10 นาที) — exit 1 เมื่อไม่ผ่านเกณฑ์ */
'use strict';
const path = require('path'), fs = require('fs'), vm = require('vm');
const root = path.join(__dirname, '..');
const DSP = require(path.join(root, 'site', 'assets', 'js', 'dsp.js'));
const Riff = require(path.join(root, 'site', 'assets', 'js', 'riff.js'));

const SR = 11025, OS = 4, FS = SR * OS; // สังเคราะห์ที่ 44.1kHz

/* ---------------- PRNG กำหนด seed ได้ ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- Karplus-Strong (Jaffe-Smith: averaging + allpass fractional delay) ---------------- */
function ksNote(out, rnd, midi, t0, dur, amp, o) {
  o = o || {};
  const f0 = 440 * Math.pow(2, (midi - 69 + (o.cents || 0) / 100) / 12);
  const total = FS / f0 - 0.5;               // ดีเลย์ลูปรวม (averaging filter กินไป 0.5)
  const nInt = Math.max(2, Math.floor(total - 0.1));
  const frac = total - nInt;                 // 0.1..1.1
  const C = (1 - frac) / (1 + frac);
  const buf = new Float64Array(nInt);
  // excitation: นอยส์ขาว (KS ดั้งเดิม = เสียงสว่างแบบดิสทอร์ชัน ฮาร์มอนิกแบนถึง ~5kHz)
  // tone 'pick' = กีตาร์ดีดปิ๊กทั่วไป: comb ตำแหน่งดีด (β≈0.2 จากหย่อง) + lowpass 2 ชั้น ~1.5kHz
  for (let i = 0; i < nInt; i++) buf[i] = rnd() * 2 - 1;
  if (o.tone === 'pick') {
    const P = Math.max(1, Math.round(0.2 * nInt));
    const src = Float64Array.from(buf);
    for (let i = 0; i < nInt; i++) buf[i] = src[i] - src[(i + P) % nInt];
    const a = Math.exp(-2 * Math.PI * 1500 / FS);
    for (let pass = 0; pass < 2; pass++) {
      let y = buf[nInt - 1];
      for (let i = 0; i < nInt; i++) { y = (1 - a) * buf[i] + a * y; buf[i] = y; }
    }
  }
  let mean = 0, pk = 0;
  for (let i = 0; i < nInt; i++) mean += buf[i];
  mean /= nInt;
  for (let i = 0; i < nInt; i++) { buf[i] -= mean; pk = Math.max(pk, Math.abs(buf[i])); }
  for (let i = 0; i < nInt; i++) buf[i] /= pk || 1;
  const rho = o.rho != null ? o.rho : 0.9965;
  const s0 = Math.floor(t0 * FS);
  const nOn = Math.floor(dur * FS);
  const nRel = Math.floor(0.03 * FS);        // ปล่อยนิ้ว/มิวต์ ~30ms
  const nAll = nOn + nRel;
  // vibrato: อ่านซ้ำแบบ resample (ใช้กับโน้ตยาว)
  const vib = o.vibrato || 0, vibHz = 5.5;
  const tmp = new Float64Array(nAll + 4);
  let idx = 0, prevY = 0, apX = 0, apY = 0;
  for (let n = 0; n < nAll + 4; n++) {
    const y = buf[idx];
    tmp[n] = y;
    const damp = n < nOn ? rho : 0.9;        // หลังจบโน้ต: มิวต์เร็ว
    const avg = damp * 0.5 * (y + prevY);
    prevY = y;
    const ap = C * avg + apX - C * apY;
    apX = avg; apY = ap;
    buf[idx] = ap;
    idx++; if (idx >= nInt) idx = 0;
  }
  let ph = 0;
  for (let n = 0; n < nAll; n++) {
    const oi = s0 + n;
    if (oi >= out.length) break;
    let v;
    if (vib) {
      const t = n / FS;
      const depth = t > 0.2 ? vib : vib * (t / 0.2);
      ph += Math.pow(2, (depth * Math.sin(2 * Math.PI * vibHz * t)) / 1200);
      const i0 = Math.floor(ph), fr = ph - i0;
      if (i0 + 1 >= tmp.length) break;
      v = tmp[i0] * (1 - fr) + tmp[i0 + 1] * fr;
    } else v = tmp[n];
    out[oi] += v * amp;
  }
}

// pad คอร์ดค้าง: partial 1..6 attack ช้า (ไม่มีหัวโน้ต) — เสียงประกอบที่ไม่ควรถูกแกะ
function padChord(out, rnd, midis, t0, dur, amp) {
  const s0 = Math.floor(t0 * FS), n = Math.floor(dur * FS);
  midis.forEach((m) => {
    for (const det of [-6, 6]) {
      const f0 = 440 * Math.pow(2, (m - 69 + det / 100) / 12);
      const ph = [];
      for (let h = 1; h <= 6; h++) ph.push(rnd() * 2 * Math.PI);
      for (let i = 0; i < n; i++) {
        const oi = s0 + i;
        if (oi >= out.length) break;
        const t = i / FS;
        const env = Math.min(1, t / 0.15) * Math.min(1, (dur - t) / 0.15);
        let v = 0;
        for (let h = 1; h <= 6; h++) {
          const fh = f0 * h;
          if (fh > SR * 0.45) break;
          v += Math.sin(2 * Math.PI * fh * t + ph[h - 1]) / (h * h);
        }
        out[oi] += v * env * amp;
      }
    }
  });
}

function decimate(x) {
  const taps = 95, half = (taps - 1) / 2, fc = 0.45 / OS;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - half;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const outLen = Math.floor(x.length / OS);
  const out = new Float32Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const c = o * OS;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = c + i - half;
      if (j >= 0 && j < x.length) acc += x[j] * h[i];
    }
    out[o] = acc;
  }
  return out;
}

/* ลาย: [[midi|null, steps(16th), {stac, vib}?], ...]  → truth [{t, midi}] */
function render(riff, opts) {
  const bpm = opts.bpm, step = 60 / bpm / 4;
  const lead0 = opts.lead0 != null ? opts.lead0 : 0.6;
  const rnd = mulberry32(opts.seed || 1);
  let steps = 0;
  riff.forEach((r) => { steps += r[1]; });
  const dur = lead0 + steps * step + 1.2;
  const x = new Float64Array(Math.ceil(dur * FS));
  const truth = [];
  let k = 0;
  riff.forEach(([m, n, o]) => {
    o = o || {};
    if (m != null) {
      const t = lead0 + k * step + (rnd() - 0.5) * 2 * (opts.humanize || 0);
      const len = n * step * (o.stac ? 0.55 : 0.97);
      const accent = (k % 4 === 0 ? 1 : 0.8) * (0.85 + 0.3 * rnd());
      ksNote(x, rnd, m, t, len, 0.5 * accent, { vibrato: o.vib || 0, rho: m < 50 ? 0.993 : 0.9965, tone: opts.tone, cents: opts.cents || 0 });
      truth.push({ t, midi: m, steps: n });
    }
    k += n;
  });
  let leadE = 0;
  for (let i = 0; i < x.length; i++) leadE += x[i] * x[i];
  let accE = 0;
  if (opts.pads) {
    // pad ค้างทั้งเพลง (รวมช่วงที่ลีดพัก) + นอยส์ขาว −20dB ใต้ pad → สเกลให้ได้ LAR ตามเป้า
    const acc = new Float64Array(x.length);
    const bar = step * 16;
    const total = Math.ceil((dur - lead0) / bar) + 1;
    for (let b = 0; b < total; b++) {
      const ch = opts.pads[b % opts.pads.length];
      padChord(acc, rnd, ch, Math.max(0, lead0 - 0.3 + b * bar), bar + 0.05, 1);
    }
    let pe = 0;
    for (let i = 0; i < acc.length; i++) pe += acc[i] * acc[i];
    const nAmp = Math.sqrt((pe / acc.length) * 0.01 * 3); // uniform: var = a²/3
    for (let i = 0; i < acc.length; i++) acc[i] += (rnd() * 2 - 1) * nAmp;
    let ae = 0;
    for (let i = 0; i < acc.length; i++) ae += acc[i] * acc[i];
    const g = Math.sqrt(leadE / ae / Math.pow(10, opts.lar / 10));
    for (let i = 0; i < x.length; i++) { const v = acc[i] * g; accE += v * v; x[i] += v; }
  }
  const y = decimate(x);
  let mx = 0;
  for (let i = 0; i < y.length; i++) mx = Math.max(mx, Math.abs(y[i]));
  for (let i = 0; i < y.length; i++) y[i] = (y[i] / mx) * 0.85;
  const lar = accE > 0 ? 10 * Math.log10(leadE / accE) : Infinity; // lead-to-accompaniment ratio (dB)
  return { buf: y, truth, bpm, step, lar };
}


/* ---------------- ลายทดสอบ ---------------- */
// A minor pentatonic 16th @100 — มีโน้ตซ้ำติดกัน (ต้องแยกด้วย onset) + 8th/ตัวดำปน + ย้ายตำแหน่งขึ้นเฟรต 8–12
const PENTA = [
  [69, 1], [67, 1], [64, 1], [67, 1], [69, 1], [67, 1], [64, 1], [62, 1],
  [64, 1], [62, 1], [60, 1], [62, 1], [64, 1], [62, 1], [60, 1], [57, 1],
  [60, 1], [60, 1], [62, 1], [62, 1], [64, 1], [64, 1], [67, 1], [67, 1],
  [69, 2], [72, 2], [74, 1], [72, 1], [69, 1], [72, 1],
  [76, 1], [74, 1], [72, 1], [74, 1], [76, 1], [74, 1], [72, 1], [69, 1],
  [72, 1], [69, 1], [67, 1], [69, 1], [72, 1], [69, 1], [67, 1], [64, 1],
  [67, 2], [64, 2], [62, 1], [60, 1], [57, 1], [60, 1], [62, 4], [57, 4],
];
// เมโลดี้ช้า โน้ตค้าง + vibrato + ช่วงพัก @72
const SLOW = [
  [64, 4], [67, 2], [69, 2], [71, 8, { vib: 18 }], [69, 4], [67, 2], [64, 2], [62, 8, { vib: 18 }],
  [null, 4], [64, 4], [71, 4], [74, 4], [76, 6, { vib: 22 }], [74, 2], [71, 8, { vib: 18 }],
  [67, 4], [64, 12, { vib: 15 }],
];
// ริฟฟ์ต่ำ (E2–B2) palm-mute บางตัว @120 วนซ้ำ ×4
const LOWRIFF_1 = [
  [40, 2, { stac: 1 }], [40, 1, { stac: 1 }], [43, 1], [45, 2], [40, 2, { stac: 1 }],
  [47, 1], [45, 1], [43, 2], [40, 2], [null, 2],
];
const LOWRIFF = [].concat(LOWRIFF_1, LOWRIFF_1, LOWRIFF_1, LOWRIFF_1);

// pad วางแบบคีย์บอร์ดทั่วไป (E2–E4) — คาบเกี่ยวช่วงเสียงของลีดในสองเคสแรก
const PADS_AM = [[45, 52, 57, 60], [41, 48, 53, 57], [48, 52, 55, 60], [43, 50, 55, 59]];
const PADS_EM = [[40, 47, 52, 55], [48, 52, 55, 60], [43, 50, 55, 59], [45, 52, 57, 60]];
// ริฟฟ์ต่ำ: pad อยู่เหนือริฟฟ์ (ออกเทฟ 4) แบบที่มิกซ์จริงเว้นย่านต่ำให้กีตาร์ริฟฟ์/เบส
const PADS_EM_HI = [[52, 55, 59, 64], [48, 52, 55, 60], [50, 55, 59, 62], [52, 57, 60, 64]];

// tone: 'bright' = KS ดั้งเดิม (นอยส์ขาว ≈ เสียงแตก/ดิสทอร์ชัน) · 'pick' = กีตาร์ดีดปิ๊กทั่วไป
const CASES = [
  { name: 'pentatonic 16th @100', riff: PENTA, bpm: 100, seed: 11, pads: PADS_AM, tone: 'bright' },
  { name: 'เมโลดี้ช้า โน้ตค้าง @72', riff: SLOW, bpm: 72, seed: 12, pads: PADS_EM, tone: 'pick' },
  { name: 'ริฟฟ์ต่ำวนซ้ำ ×4 @120', riff: LOWRIFF, bpm: 120, seed: 13, pads: PADS_EM_HI, tone: 'pick' },
];

/* ---------------- เกณฑ์ผ่าน (เหตุผล) ----------------
   เดี่ยว ≥ 0.95: กีตาร์เส้นเดียวไม่มีอะไรกวน ควรเกือบสมบูรณ์ — เผื่อพลาด ~1 โน้ตต่อ 20–50 โน้ต
   มิกซ์ (LAR +3dB = ลีดดังกว่าดนตรีประกอบชัด) ≥ 0.80: melody extraction บนเพลงจริงระดับงานวิจัย
     ได้ราว 0.7–0.8 (ระดับเฟรม) เสียงสังเคราะห์ที่ลีดเด่นควรได้อย่างน้อยระดับนั้น
   quantize ผ่าน DSP.detectTempo จริง (ไม่ใช้ BPM เฉลย) ต้องไม่แย่กว่าไม่ quantize เกิน 0.03
   เคสยาก (มิกซ์ 0dB, เสียงแตกในมิกซ์, pad ทับรีจิสเตอร์ริฟฟ์ต่ำ) = รายงานตามจริง + พื้นกันพัง ≥ 0.40 */
const TH_SOLO = 0.95, TH_MIX = 0.80, TH_Q_DROP = 0.03, TH_HARD_FLOOR = 0.40;
// โน้ตขยะในท่อนคอร์ดล้วน ≤ 0.5 โน้ต/วินาที (ริฟฟ์จริง 4–8 โน้ต/วินาที → แท็บท่อนนั้นแทบว่าง)
const TH_JUNK = 0.5;

/* ---------------- วัดผลระดับโน้ต (onset ≤ 50ms + pitch ≤ 0.5 semitone, จับคู่ 1:1) ---------------- */
function evalNotes(est, truth, tolOn) {
  tolOn = tolOn || 0.05;
  const used = new Uint8Array(est.length);
  let tp = 0, onErr = 0;
  for (const g of truth) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < est.length; i++) {
      if (used[i]) continue;
      const dt = Math.abs(est[i].t - g.t);
      if (dt <= tolOn && Math.abs(est[i].midi - g.midi) <= 0.5 && dt < bd) { bd = dt; best = i; }
    }
    if (best >= 0) { used[best] = 1; tp++; onErr += est[best].t - g.t; }
  }
  const P = est.length ? tp / est.length : 0, R = truth.length ? tp / truth.length : 0;
  const F1 = P + R ? (2 * P * R) / (P + R) : 0;
  return { P, R, F1, tp, nEst: est.length, nRef: truth.length, bias: tp ? onErr / tp : 0 };
}

const pct = (x) => (x * 100).toFixed(0) + '%';
const ms = (x) => (x * 1000).toFixed(1) + 'ms';

function dump(est, truth) {
  const all = est.map((n) => ({ k: 'E', t: n.t, m: n.midi, d: n.d, c: n.conf }))
    .concat(truth.map((g) => ({ k: 'T', t: g.t, m: g.midi })));
  all.sort((a, b) => a.t - b.t);
  console.log(all.map((a) => `${a.k} ${a.t.toFixed(3)} ${a.m}${a.d != null ? ' d=' + a.d.toFixed(3) + ' c=' + a.c : ''}`).join('\n'));
}

/* ---------------- ตรวจตำแหน่งนิ้ว (assignFrets) ---------------- */
// ช่วงเฟรต (เฉพาะโน้ตที่กด) ภายในแต่ละ beat — เล่นได้จริงถ้า ≤ 5 เฟรต
function beatSpans(notes, bpm, phase) {
  const beat = 60 / bpm;
  const by = new Map();
  notes.forEach((n) => {
    if (!(n.f > 0)) return;
    const b = Math.floor((n.t - phase + 0.02) / beat);
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(n.f);
  });
  const spans = [];
  by.forEach((fs) => { if (fs.length >= 2) spans.push(Math.max(...fs) - Math.min(...fs)); });
  return spans;
}

function naiveFrets(notes) { // เทียบ: เฟรตต่ำสุดเสมอ (แบบโปรแกรมแท็บง่าย ๆ)
  const T = Riff.STD_TUNING;
  return notes.map((n) => {
    let best = null;
    for (let s = 0; s < 6; s++) {
      const f = n.midi - T[s];
      if (f >= 0 && f <= 20 && (!best || f < best.f)) best = { s, f };
    }
    return Object.assign({}, n, best || { s: 0, f: 0 });
  });
}

// จำนวนครั้งที่ต้องย้ายมือไกล (เฟรตของโน้ตที่กดติดกันห่าง > 4 = ออกนอกกล่องมือ)
function bigJumps(notes) {
  let n = 0, last = null;
  notes.forEach((x) => { if (x.f > 0) { if (last != null && Math.abs(x.f - last) > 4) n++; last = x.f; } });
  return n;
}

function testFrets(problems, detected) {
  console.log('\n=== ตำแหน่งนิ้ว (assignFrets) ===');
  const T = Riff.STD_TUNING;
  let bad = 0;
  const checkNote = (n, capo, where) => {
    const sounding = Math.round(n.midi) + 12 * (n.oct || 0);
    if (T[n.s] + capo + n.f !== sounding) { bad++; problems.push(`frets: ${where} สาย ${n.s} เฟรต ${n.f} ไม่ได้เสียง ${sounding}`); }
    if (!(n.f >= 0 && n.f <= 20 - capo)) { bad++; problems.push(`frets: ${where} เฟรต ${n.f} นอกช่วง 0–${20 - capo}`); }
    if (!(n.s >= 0 && n.s <= 5)) { bad++; problems.push(`frets: ${where} สาย ${n.s} ผิด`); }
  };
  const rows = [];
  const sets = CASES.map((c) => {
    const step = 60 / c.bpm / 4;
    let k = 0;
    const notes = [];
    c.riff.forEach(([m, n]) => { if (m != null) notes.push({ t: 0.6 + k * step, d: n * step, midi: m, conf: 1 }); k += n; });
    return { name: c.name + ' (เฉลย)', notes, bpm: c.bpm, phase: 0.6 };
  }).concat(detected);
  for (const set of sets) {
    const fr = Riff.assignFrets(set.notes, {});
    fr.forEach((n) => checkNote(n, 0, set.name));
    const sp = beatSpans(fr, set.bpm, set.phase);
    const ok = sp.filter((x) => x <= 5).length;
    const nv = naiveFrets(set.notes);
    const spN = beatSpans(nv, set.bpm, set.phase);
    const okN = spN.filter((x) => x <= 5).length;
    const hi = fr.filter((n) => n.f <= 12).length / (fr.length || 1);
    rows.push([set.name, `${ok}/${sp.length}`, `${okN}/${spN.length}`, bigJumps(fr), bigJumps(nv), pct(hi)]);
    if (sp.length && ok / sp.length < 0.9) problems.push(`frets: ${set.name} beat ที่ช่วงเฟรต ≤5 แค่ ${ok}/${sp.length}`);
    if (hi < 0.9) problems.push(`frets: ${set.name} เฟรต ≤12 แค่ ${pct(hi)}`);
    if (bigJumps(fr) > bigJumps(nv)) problems.push(`frets: ${set.name} ย้ายมือไกลบ่อยกว่าแบบเฟรตต่ำสุด`);
  }
  const W = [44, 13, 15, 10, 12, 8];
  const f = (r) => r.map((x, i) => String(x).padEnd(W[i])).join('');
  console.log(f(['ชุดโน้ต', 'span≤5 (DP)', 'span≤5 (ต่ำสุด)', 'กระโดด DP', 'กระโดดต่ำสุด', 'เฟรต≤12']));
  rows.forEach((r) => console.log(f(r)));

  // capo + โน้ตนอกช่วงคอกีตาร์ → ย้ายออกเทฟ + ติดธง oct
  const capo = 3;
  const odd = Riff.assignFrets([
    { t: 0, d: 0.2, midi: 34 }, { t: 0.3, d: 0.2, midi: 43 }, { t: 0.6, d: 0.2, midi: 70 }, { t: 0.9, d: 0.2, midi: 95 },
  ], { capo });
  odd.forEach((n) => checkNote(n, capo, 'capo3'));
  if (odd[0].oct !== 1) problems.push('frets: โน้ต 34 ที่ capo 3 (สายต่ำสุด G2=43) ต้องได้ oct +1 ได้ ' + odd[0].oct);
  if (odd[3].oct !== -1) problems.push('frets: โน้ต 95 ต้องได้ oct −1 ได้ ' + odd[3].oct);
  if (odd[1].oct) problems.push('frets: โน้ต 43 อยู่ในช่วงอยู่แล้ว ไม่ควรมี oct');
  if (Riff.assignFrets([], {}).length !== 0) problems.push('frets: อินพุตว่างต้องคืน []');
  console.log('capo 3 + นอกช่วง:', odd.map((n) => `${n.midi}→สาย${n.s}/เฟรต${n.f}${n.oct ? ' oct' + (n.oct > 0 ? '+' : '') + n.oct : ''}`).join(', '));
  console.log(bad ? `✗ ตำแหน่งผิด ${bad} จุด` : 'ทุกโน้ต: สาย+เฟรต+capo ให้เสียงตรง, เฟรตอยู่ในช่วง');
}

/* ---------------- ตรวจแท็บ ASCII ---------------- */
function checkTab(txt, nNotes, where, problems, wantBpm) {
  const lines = txt.replace(/\n$/, '').split('\n');
  const head = lines[0];
  const re = wantBpm ? /^Tuning: E A D G B E · BPM \d+$/ : /^Tuning: E A D G B E$/;
  if (!re.test(head)) problems.push(`tab: ${where} header ผิด: "${head}"`);
  let systems = 0, frets = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!/^e\|/.test(lines[i])) continue;
    const sys = lines.slice(i, i + 6);
    const names = sys.map((l) => l.split('|')[0]);
    if (names.join('') !== 'eBGDAE') problems.push(`tab: ${where} ลำดับสายผิด ${names.join(',')}`);
    const L = sys[0].length;
    if (!sys.every((l) => l.length === L)) problems.push(`tab: ${where} แถวที่ ${systems + 1} บรรทัดยาวไม่เท่ากัน (${sys.map((l) => l.length).join(',')})`);
    sys.forEach((l) => { frets += (l.slice(2).match(/\d+/g) || []).length; });
    if (wantBpm) {
      const bars = sys[0].split('|').length - 2;
      if (bars < 1 || bars > 4) problems.push(`tab: ${where} แถวละ ${bars} ห้อง (ควร 1–4)`);
    }
    systems++;
    i += 5;
  }
  if (!systems) problems.push(`tab: ${where} ไม่มีแถวแท็บเลย`);
  if (nNotes != null && frets !== nNotes) problems.push(`tab: ${where} ตัวเลขเฟรตในแท็บ ${frets} ≠ จำนวนโน้ต ${nNotes}`);
  return systems;
}

/* ---------------- ตรวจ hook ใน analyze.js (โหลดผ่าน vm แบบ test-assemble) ---------------- */
async function testHook(problems, buf) {
  console.log('\n=== hook ใน analyze.js ===');
  global.window = global;
  global.self = global;
  global.I18N = { t: (k) => k };
  global.Store = { uid: () => 'sg_test' };
  global.DSP = DSP;
  global.Riff = Riff;
  const fakeAudio = {
    duration: buf.length / SR, numberOfChannels: 1, length: buf.length, sampleRate: SR,
    getChannelData: () => buf,
  };
  global.Music = { audioCtx: () => ({ decodeAudioData: (b, res) => { res(fakeAudio); } }) };
  vm.runInThisContext(fs.readFileSync(path.join(root, 'site/assets/js/analyze.js'), 'utf8'), { filename: 'analyze.js' });
  const A = global.Analyze;
  const t = (c, m) => { if (!c) problems.push('hook: ' + m); };
  t(A.stages(false).join(',') === 'ingest,prep,beats,chords,key,assemble', 'stages(false) ต้องเหมือนเดิม');
  t(A.stages(true).join(',') === 'ingest,prep,beats,chords,key,lyrics,assemble', 'stages(true) ต้องเหมือนเดิม');
  t(A.stages(false) === A.STAGES, 'stages(false) ต้องคืน array เดิม (STAGES)');
  t(A.stages(false, true).join(',') === 'ingest,prep,beats,chords,key,riff,assemble', 'stages(false,true)');
  t(A.stages(true, true).join(',') === 'ingest,prep,beats,chords,key,riff,lyrics,assemble', 'stages(true,true)');

  const input = () => ({ kind: 'file', file: { size: 1000, name: 'riff_test.wav', arrayBuffer: async () => new ArrayBuffer(8) }, riff: true });
  // 1) ปกติ
  const prog = [];
  const doc = await A.run(input(), (p) => prog.push(p), { aborted: false });
  t(doc && doc.chordpro, 'ต้องได้ชีตคอร์ดตามปกติ');
  t(doc._riff && doc._riff.v === 1, 'ต้องมี doc._riff.v = 1');
  t(doc._riff && JSON.stringify(doc._riff.tuning) === '[40,45,50,55,59,64]', 'doc._riff.tuning ต้องเป็นจูนมาตรฐาน');
  const rn = (doc._riff && doc._riff.notes) || [];
  t(rn.length > 20, 'doc._riff.notes ต้องมีโน้ต ได้ ' + rn.length);
  t(rn.every((n) => isFinite(n.t) && isFinite(n.d) && isFinite(n.midi) && isFinite(n.conf) && n.s >= 0 && n.s <= 5 && n.f >= 0),
    'โน้ตต้องมี t,d,midi,conf,s,f ครบ');
  t(!('_riffError' in doc), 'ไม่ควรมี _riffError ตอนสำเร็จ');
  t(doc.schemaVersion === 1 && !('riff' in doc), 'SongDoc ต้องไม่เปลี่ยน (ไม่มี field riff ใหม่)');
  const pcts = prog.map((p) => p.percent);
  t(pcts.every((v, i) => i === 0 || v >= pcts[i - 1]), 'percent ต้องไม่ถอยหลัง: ' + pcts.join(','));
  const stg = [];
  prog.forEach((p) => { if (stg[stg.length - 1] !== p.stage) stg.push(p.stage); });
  t(stg.join(',') === 'ingest,prep,beats,chords,key,riff,assemble', 'ลำดับ stage ที่รายงาน: ' + stg.join(','));
  const rp = prog.filter((p) => p.stage === 'riff').map((p) => p.percent);
  t(rp.length > 3 && Math.min(...rp) >= 48 && Math.max(...rp) <= 96, 'percent ช่วง riff ต้องอยู่ 48–96: ' + rp.join(','));
  const tab = Riff.toAsciiTab(rn, { bpm: doc._riff.bpm, phase: doc._riff.phase });
  checkTab(tab, null, 'hook', problems, doc._riff.bpm != null);
  console.log(`doc._riff: ${rn.length} โน้ต, bpm ${doc._riff.bpm}, phase ${doc._riff.phase}, voicedRatio ${doc._riff.voicedRatio}`);

  // 2) riff พัง → งานไม่ล้ม ได้ _riffError
  const orig = Riff.extract;
  Riff.extract = async () => { throw new Error('boom'); };
  const doc2 = await A.run(input(), null, { aborted: false });
  Riff.extract = orig;
  t(doc2 && doc2.chordpro && doc2._riffError === 'run' && !doc2._riff, 'riff พังต้องได้ _riffError="run" และยังมีชีตคอร์ด');
  // 3) ไม่ได้โหลด riff.js
  delete global.Riff;
  const doc3 = await A.run(input(), null, { aborted: false });
  global.Riff = Riff;
  t(doc3 && doc3._riffError === 'run', 'ไม่มี window.Riff ต้องได้ _riffError="run"');
  // 4) ยกเลิกระหว่าง riff → ต้อง reject 'cancelled' (ไม่กลืนเป็น _riffError)
  const ctl = { aborted: false };
  let cancelled = false;
  try {
    await A.run(input(), (p) => { if (p.stage === 'riff' && p.percent > 52) ctl.aborted = true; }, ctl);
  } catch (e) { cancelled = e && e.message === 'cancelled'; }
  t(cancelled, 'ยกเลิกระหว่างแกะริฟฟ์ต้อง throw "cancelled"');
  // 5) ไม่ขอ riff → ไม่มี _riff และไม่มี stage riff
  const prog5 = [];
  const doc5 = await A.run(Object.assign(input(), { riff: false }), (p) => prog5.push(p), { aborted: false });
  t(!('_riff' in doc5) && !('_riffError' in doc5) && !prog5.some((p) => p.stage === 'riff'), 'ไม่ขอ riff ต้องไม่มีอะไรเกี่ยวกับ riff');
  console.log('stages / PCT / doc._riff / _riffError / ยกเลิก: ตรวจแล้ว');
}

/* ---------------- ตรวจ opts (tick/chk/onPct) + อินพุตแปลก ---------------- */
async function testOpts(problems, buf) {
  let ticks = 0, chks = 0, last = -1, mono = true, maxGap = 0;
  let tPrev = Date.now();
  const r = await Riff.extract(buf, SR, {
    tick: () => { ticks++; const n = Date.now(); maxGap = Math.max(maxGap, n - tPrev); tPrev = n; return Promise.resolve(); },
    chk: () => { chks++; },
    onPct: (p) => { if (p < last - 1e-9) mono = false; last = p; },
  });
  maxGap = Math.max(maxGap, Date.now() - tPrev);
  if (!(ticks > 10 && chks > 10)) problems.push(`opts: tick/chk ถูกเรียกน้อยเกิน (${ticks}/${chks})`);
  if (!mono || Math.abs(last - 1) > 1e-9) problems.push('opts: onPct ต้องเพิ่มขึ้นและจบที่ 1');
  if (!r.notes.length) problems.push('opts: ไม่ได้โน้ต');
  // ยกเลิกกลางทาง: chk โยน error → extract ต้อง reject ด้วย error เดิม
  let n = 0, got = null;
  try { await Riff.extract(buf, SR, { chk: () => { if (++n > 5) throw new Error('cancelled'); } }); } catch (e) { got = e; }
  if (!got || got.message !== 'cancelled') problems.push('opts: chk โยน error แล้ว extract ต้อง reject');
  // อินพุตแปลก: ว่าง / สั้น / เงียบ → โน้ตว่าง ไม่ crash
  for (const [nm, x] of [['ว่าง', new Float32Array(0)], ['สั้น 0.05s', new Float32Array(550)], ['เงียบ 3s', new Float32Array(SR * 3)]]) {
    try {
      const e = await Riff.extract(x, SR, { bpm: 120, phase: 0 });
      if (e.notes.length) problems.push(`opts: อินพุต${nm} ไม่ควรได้โน้ต (${e.notes.length})`);
    } catch (e) { problems.push(`opts: อินพุต${nm} crash: ${e.message}`); }
  }
  // sample rate อื่น (toMono fallback อาจได้ 12000/16000): โทนฮาร์มอนิกสลายตัว A4 → ต้องได้ 69 ที่ 0.3s
  for (const sr of [12000, 16000, 22050]) {
    const x = new Float32Array(sr * 2);
    for (let i = 0; i < x.length; i++) {
      const tt = i / sr;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 440 * h * tt) / h;
      x[i] = (tt > 0.3 ? 0.4 * Math.exp(-2 * (tt - 0.3)) : 0) * v;
    }
    const e = await Riff.extract(x, sr, {});
    const okN = e.notes.length >= 1 && e.notes[0].midi === 69 && Math.abs(e.notes[0].t - 0.3) < 0.05;
    if (!okN) problems.push(`opts: sr ${sr} ต้องได้ A4 (69) ที่ 0.3s ได้ ${JSON.stringify(e.notes.slice(0, 2))}`);
  }
  return { maxGap };
}


/* ---------------- ท่อนคอร์ดล้วน: voicing ต้องไม่เติมโน้ตขยะ ---------------- */
function normalize(x) {
  const y = decimate(x);
  let mx = 0;
  for (let i = 0; i < y.length; i++) mx = Math.max(mx, Math.abs(y[i]));
  for (let i = 0; i < y.length; i++) y[i] = (y[i] / (mx || 1)) * 0.85;
  return y;
}

async function testChordOnly(problems) {
  const out = [];
  const rnd = mulberry32(5);
  const sec = 20;
  // 1) pad คอร์ดค้างล้วนทั้งไฟล์
  let x = new Float64Array(sec * FS);
  for (let b = 0; b < 8; b++) padChord(x, rnd, PADS_AM[b % 4], b * 2.4, 2.45, 0.1);
  for (let i = 0; i < x.length; i++) x[i] += (rnd() * 2 - 1) * 0.002;
  let e = await Riff.extract(normalize(x), SR, {});
  out.push({ name: 'pad คอร์ดล้วน (ทั้งไฟล์)', n: e.notes.length, sec, mono: e.monoRatio });
  // 2) กีตาร์ดีดคอร์ดล้วน (rhythm guitar) 8th @100
  x = new Float64Array(sec * FS);
  const shapes = [[45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [48, 52, 55, 60, 64], [43, 47, 50, 55, 59]];
  for (let b = 0; b < 32; b++) {
    const sh = shapes[Math.floor(b / 4) % 4];
    sh.forEach((m, i) => ksNote(x, rnd, m, 0.3 + b * 0.6 + i * 0.012, 0.58, 0.3, { tone: 'pick' }));
  }
  e = await Riff.extract(normalize(x), SR, {});
  out.push({ name: 'กีตาร์ดีดคอร์ดล้วน (ทั้งไฟล์)', n: e.notes.length, sec, mono: e.monoRatio });
  // 3) ริฟฟ์ แล้วตามด้วยท่อนคอร์ดล้วน 20s (เพลงจริง: โซโล่แค่บางท่อน)
  const lr = render(PENTA, { bpm: 100, seed: 11, humanize: 0.008, pads: PADS_AM, lar: 3, tone: 'bright' });
  x = new Float64Array(sec * FS);
  for (let b = 0; b < 8; b++) padChord(x, rnd, PADS_AM[b % 4], b * 2.4, 2.45, 0.1);
  const tail = normalize(x);
  const all = new Float32Array(lr.buf.length + tail.length);
  all.set(lr.buf, 0);
  for (let i = 0; i < tail.length; i++) all[lr.buf.length + i] = tail[i] * 0.5;
  e = await Riff.extract(all, SR, {});
  const t0 = lr.buf.length / SR;
  out.push({ name: 'ริฟฟ์ + ท่อนคอร์ดล้วนต่อท้าย (นับเฉพาะท่อนคอร์ด)', n: e.notes.filter((n) => n.t > t0).length, sec, mono: e.monoRatio });
  const ev = evalNotes(e.notes.filter((n) => n.t <= t0), lr.truth);
  if (ev.F1 < TH_MIX) problems.push(`ริฟฟ์ + ท่อนคอร์ด: ส่วนริฟฟ์ F1 ตกเหลือ ${pct(ev.F1)}`);
  out.forEach((j) => { if (j.n / j.sec > TH_JUNK) problems.push(`"${j.name}" โน้ตขยะ ${j.n} ใน ${j.sec}s`); });
  return out;
}

/* ---------------- main ---------------- */
async function main() {
  const problems = [];
  console.log('=== AquaChord Riff/Solo → Tab benchmark (Karplus-Strong สังเคราะห์ ไม่ mock) ===');
  console.log('วัดระดับโน้ต: onset ห่างเฉลย ≤ 50ms และ pitch ≤ 0.5 semitone · LAR = ความดังลีดเทียบดนตรีประกอบ\n');
  const rows = [];
  const detected = [];
  let hookBuf = null;
  const run = async (label, c, ro, gate) => {
    const r = render(c.riff, Object.assign({ bpm: c.bpm, seed: c.seed, humanize: 0.008, tone: c.tone }, ro));
    const raw = await Riff.extract(r.buf, SR, {});
    const er = evalNotes(raw.notes, r.truth);
    // end-to-end แบบ analyze.js: BPM/phase จาก DSP.detectTempo (ไม่ใช้เฉลย) แล้ว quantize
    const tp = await DSP.detectTempo(r.buf, SR);
    const q = await Riff.extract(r.buf, SR, { bpm: tp.bpm, phase: tp.phase });
    const eq = evalNotes(q.notes, r.truth);
    rows.push([label, isFinite(r.lar) ? r.lar.toFixed(0) + 'dB' : '–', pct(er.P), pct(er.R), pct(er.F1), ms(er.bias),
      pct(eq.F1), q.grid ? q.grid.bpm.toFixed(1) + (q.grid.beatFrom === 'onset' ? '' : '*') : 'ไม่ snap', `${er.tp}/${er.nRef}`]);
    if (process.env.RIFF_DEBUG) dump(raw.notes, r.truth);
    if (gate != null && er.F1 < gate) problems.push(`"${label}" F1 ${pct(er.F1)} < เกณฑ์ ${pct(gate)}`);
    if (gate != null && eq.F1 < er.F1 - TH_Q_DROP) problems.push(`"${label}" quantize แล้วแย่ลง ${pct(er.F1)} → ${pct(eq.F1)}`);
    return { r, raw, q, tp, er };
  };
  for (const c of CASES) {
    const s = await run(c.name + ' · เดี่ยว', c, {}, TH_SOLO);
    const other = c.tone === 'bright' ? 'pick' : 'bright';
    await run(c.name + ' · เดี่ยว (' + other + ')', c, { tone: other }, TH_SOLO);
    const m = await run(c.name + ' · มิกซ์', c, { pads: c.pads, lar: 3 }, TH_MIX);
    if (!hookBuf) hookBuf = m.r.buf;
    detected.push({ name: c.name + ' (แกะได้ เดี่ยว)', notes: s.q.notes, bpm: s.q.grid ? s.q.grid.bpm : c.bpm, phase: s.q.grid ? s.q.grid.phase : 0.6 });
    detected.push({ name: c.name + ' (แกะได้ มิกซ์)', notes: m.q.notes, bpm: m.q.grid ? m.q.grid.bpm : c.bpm, phase: m.q.grid ? m.q.grid.phase : 0.6 });
  }
  // จูนเพี้ยน +35 cents (เพลงที่ไม่ได้จูน A440)
  const det = await run(CASES[0].name + ' · เดี่ยว จูน +35c', CASES[0], { cents: 35 }, TH_SOLO);
  if (Math.abs(det.raw.tuningCents - 35) > 8) problems.push(`จูน +35c วัดได้ ${det.raw.tuningCents}c`);
  // เคสยาก — รายงานตามจริง (พื้นกันพังเท่านั้น)
  const hard = [
    [CASES[0].name + ' · มิกซ์ 0dB', CASES[0], { pads: CASES[0].pads, lar: 0 }],
    [CASES[1].name + ' · มิกซ์ 0dB', CASES[1], { pads: CASES[1].pads, lar: 0 }],
    [CASES[2].name + ' · มิกซ์ เสียงแตก', CASES[2], { pads: CASES[2].pads, lar: 3, tone: 'bright' }],
    [CASES[2].name + ' · pad ทับรีจิสเตอร์', CASES[2], { pads: PADS_EM, lar: 3 }],
  ];
  const hardStart = rows.length;
  for (const [label, c, ro] of hard) {
    const h = await run(label, c, ro, null);
    if (h.er.F1 < TH_HARD_FLOOR) problems.push(`เคสยาก "${label}" F1 ${pct(h.er.F1)} ต่ำกว่าพื้นกันพัง ${pct(TH_HARD_FLOOR)}`);
  }
  const junk = await testChordOnly(problems);

  const W = [50, 6, 6, 6, 6, 9, 8, 10, 8];
  const fmt = (r) => r.map((x, i) => String(x).padEnd(W[i])).join('');
  console.log(fmt(['เคส', 'LAR', 'P', 'R', 'F1', 'onset', 'F1(q)', 'BPM(q)', 'ถูก']));
  rows.forEach((r, i) => {
    if (i === hardStart) console.log('-- เคสยาก (รายงานตามจริง, พื้นกันพัง ' + pct(TH_HARD_FLOOR) + ') --');
    console.log(fmt(r));
  });
  console.log('onset = ค่าเฉลี่ยเวลาที่แกะได้ลบเฉลย · F1(q) = quantize ด้วย BPM/phase จาก DSP.detectTempo');
  console.log('BPM(q) = BPM หลังปรับละเอียดจาก onset (* = ใช้ phase ของ detectTempo เพราะหลักฐาน onset ไม่ชัด)');
  console.log(`เกณฑ์: เดี่ยว F1 ≥ ${pct(TH_SOLO)} · มิกซ์ LAR +3dB F1 ≥ ${pct(TH_MIX)} · quantize ห้ามแย่ลงเกิน ${TH_Q_DROP}`);
  console.log('\n=== ท่อนที่มีแต่คอร์ด (โน้ตขยะต้อง ≤ ' + TH_JUNK + ' โน้ต/วินาที; ริฟฟ์จริง 4–8 โน้ต/วินาที) ===');
  junk.forEach((j) => console.log(`${j.name.padEnd(44)} ${String(j.n).padStart(3)} โน้ต ใน ${j.sec.toFixed(0)}s (${(j.n / j.sec).toFixed(2)}/s)` +
    (j.mono != null ? ` · monoRatio ${j.mono}` : '')));

  testFrets(problems, detected);

  console.log('\n=== แท็บ ASCII (toAsciiTab) ===');
  let nSys = 0;
  for (const d of detected) {
    const fr = Riff.assignFrets(d.notes, {});
    nSys += checkTab(Riff.toAsciiTab(fr, { bpm: d.bpm, phase: d.phase }), fr.length, d.name, problems, true);
    nSys += checkTab(Riff.toAsciiTab(fr, {}), fr.length, d.name + ' ไม่มี BPM', problems, false);
  }
  // ผู้เรียกส่งแค่ { bpm } (ไม่มี phase) → toAsciiTab อนุมาน phase จากโน้ตเอง: ต้องตรงกริด beat จริง
  // (ต่างจาก phase ของ extract ได้เป็นจำนวนเต็ม beat เท่านั้น — downbeat ไม่มีใครรู้อยู่แล้ว)
  for (const d of detected) {
    const beat = 60 / d.bpm;
    const ph = Riff._test.inferPhase(d.notes, beat / 4);
    const off = (ph - d.phase) / beat;
    if (Math.abs(off - Math.round(off)) * beat > 0.02) problems.push(`tab: phase ที่อนุมาน ${ph.toFixed(3)} ไม่ตรงจังหวะ (จริง ${d.phase}) — ${d.name}`);
  }
  const capoTab = Riff.toAsciiTab(Riff.assignFrets(detected[0].notes, { capo: 2 }), { bpm: 100, phase: 0.6, capo: 2 });
  if (!/^Tuning: E A D G B E · BPM 100 · Capo 2$/.test(capoTab.split('\n')[0])) problems.push('tab: header capo ผิด');
  checkTab(Riff.toAsciiTab([], { bpm: 120 }), 0, 'ว่าง', problems, true);
  console.log(`ตรวจ ${nSys} แถว: ทุกแถว 6 บรรทัดยาวเท่ากัน, ลำดับสาย e B G D A E, ตัวเลขเฟรตครบทุกโน้ต`);
  console.log('ตัวอย่าง (pentatonic เดี่ยว, แถวแรก):');
  console.log(Riff.toAsciiTab(Riff.assignFrets(detected[0].notes, {}), { bpm: detected[0].bpm, phase: detected[0].phase })
    .split('\n').slice(0, 9).join('\n'));

  console.log('\n=== opts (tick/chk/onPct), อินพุตแปลก, sample rate อื่น ===');
  const optRes = await testOpts(problems, hookBuf);
  console.log(`ช่วงที่ไม่ yield นานสุด ${optRes.maxGap}ms`);
  if (optRes.maxGap > 250) problems.push(`ค้างนานเกินระหว่าง tick: ${optRes.maxGap}ms`);

  await testHook(problems, hookBuf);

  console.log('\n=== ความเร็ว ===');
  const reps = Math.ceil(60 / (PENTA.reduce((s, r) => s + r[1], 0) * 0.15));
  let long = [];
  for (let i = 0; i < reps; i++) long = long.concat(PENTA);
  const lr = render(long, { bpm: 100, seed: 21, humanize: 0.008, pads: PADS_AM, lar: 3, tone: 'bright' });
  const minutes = lr.buf.length / SR / 60;
  let t0 = Date.now();
  const le = await Riff.extract(lr.buf, SR, { bpm: 100, phase: 0.6 });
  const took = Date.now() - t0;
  const perMin = took / minutes;
  const lev = evalNotes(le.notes, lr.truth);
  console.log(`เสียง ${minutes.toFixed(2)} นาที (${lr.truth.length} โน้ต, มิกซ์): ${took}ms → ${perMin.toFixed(0)}ms ต่อนาทีเสียง · F1 ${pct(lev.F1)}`);
  if (perMin > 8000) problems.push(`ช้าเกิน: ${perMin.toFixed(0)}ms ต่อนาที`);
  if (process.env.RIFF_LONG) {
    const n10 = SR * 600;
    const big = new Float32Array(n10);
    for (let i = 0; i < n10; i += lr.buf.length) big.set(lr.buf.subarray(0, Math.min(lr.buf.length, n10 - i)), i);
    if (global.gc) global.gc();
    const h0 = process.memoryUsage().heapUsed;
    let gap = 0, tp = Date.now();
    t0 = Date.now();
    const be = await Riff.extract(big, SR, {
      bpm: 100, phase: 0.6,
      tick: () => { const n = Date.now(); gap = Math.max(gap, n - tp); tp = n; return new Promise((r) => setImmediate(r)); },
    });
    gap = Math.max(gap, Date.now() - tp);
    const h1 = process.memoryUsage().heapUsed;
    console.log(`เสียง 10 นาที: ${Date.now() - t0}ms, ${be.notes.length} โน้ต, ค้างนานสุด ${gap}ms, heap +${((h1 - h0) / 1048576).toFixed(1)}MB`);
  }

  if (problems.length) {
    console.error('\n✗ FAILED:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('\n✓ ผ่านทุกเกณฑ์');
  process.exit(0); // MessageChannel ใน analyze.js ค้าง event loop ของ Node — จบชัดเจน
}

main().catch((e) => { console.error(e); process.exit(1); });
