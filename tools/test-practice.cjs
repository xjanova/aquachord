#!/usr/bin/env node
/* test-practice.cjs — เทสต์เอนจินฝึกกับไมค์ (site/assets/js/practice.js) ด้วยเสียงกีตาร์สังเคราะห์
   - สังเคราะห์ Karplus-Strong ที่ 44.1kHz (ผ่าน decimator จริงของ practice.js → ~11kHz)
   - แบบเสียง: clean / "มือถือ" (high-pass 180Hz + นอยส์) / นอยส์หนัก / ห้องก้อง
   1. pitch: E2–E6 ทุก semitone → median cents error, gross error (>50 cents), octave error
   2. chord: ตีคอร์ด (ท่าจับจริง 40+ แบบ) → คะแนน matchChord ของคอร์ดถูก vs คอร์ดผิด (สุ่ม/ใกล้เคียง) → AUC, TPR/FPR
   3. onset: เวลาเริ่มโน้ต/สตรัม เทียบของจริง → precision/recall, error เฉลี่ย/p95
   4. นอยส์ล้วน (พัดลม/ไฟฮัม/นอยส์ขาว) → onset หลอก + pitch หลอก ต้องน้อย
   5. follower (timed/wait/allowOctave/tempo/latency/คอร์ด/กับดักโน้ตค้าง) → hit/miss/early/late ถูกต้อง, false hit = 0
   5b. calibrate: chirp ผ่านลำโพง→ห้อง→ไมค์ จำลอง → latency ±1.5ms, หูฟัง/ไม่นิ่ง → null
   6. ประสิทธิภาพ: เวลา/เฟรม + หน่วยความจำไม่โต
   ใช้: node tools/test-practice.cjs  (exit 1 เมื่อไม่ผ่านเกณฑ์) */
'use strict';
const path = require('path');
const Practice = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'practice.js'));

const FS = 44100;
const TUNING = [40, 45, 50, 55, 59, 64];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };
const fmt = (x, d = 1) => (x == null || !isFinite(x) ? String(x) : x.toFixed(d));

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

/* ---------------- Karplus-Strong (averaging + allpass fractional delay) ---------------- */
function ksNote(out, rnd, midi, t0, dur, amp, o) {
  o = o || {};
  const f0 = 440 * Math.pow(2, (midi - 69 + (o.cents || 0) / 100) / 12);
  const total = FS / f0 - 0.5;
  const nInt = Math.max(2, Math.floor(total - 0.1));
  const frac = total - nInt;
  const C = (1 - frac) / (1 + frac);
  const buf = new Float64Array(nInt);
  for (let i = 0; i < nInt; i++) buf[i] = rnd() * 2 - 1;
  // ปิ๊ก: comb ตำแหน่งดีด (β 0.12–0.25) + lowpass ~2.5kHz → โทนกีตาร์โปร่ง/ไฟฟ้าคลีน
  const beta = o.beta != null ? o.beta : 0.12 + 0.13 * rnd();
  const Pp = Math.max(1, Math.round(beta * nInt));
  const src = Float64Array.from(buf);
  for (let i = 0; i < nInt; i++) buf[i] = src[i] - src[(i + Pp) % nInt];
  // ความสว่าง: 1.2–2.5kHz สุ่มต่อโน้ต (โปร่งทั่วไป … ไฟฟ้าคลีนสว่าง)
  const a = Math.exp((-2 * Math.PI * (o.bright || 1200 + 1300 * rnd())) / FS);
  for (let pass = 0; pass < 2; pass++) {
    let y = buf[nInt - 1];
    for (let i = 0; i < nInt; i++) { y = (1 - a) * buf[i] + a * y; buf[i] = y; }
  }
  let mean = 0, pk = 0;
  for (let i = 0; i < nInt; i++) mean += buf[i];
  mean /= nInt;
  for (let i = 0; i < nInt; i++) { buf[i] -= mean; pk = Math.max(pk, Math.abs(buf[i])); }
  for (let i = 0; i < nInt; i++) buf[i] /= pk || 1;
  const rho = o.rho != null ? o.rho : midi < 50 ? 0.996 : 0.998;
  const s0 = Math.floor(t0 * FS), nOn = Math.floor(dur * FS), nRel = Math.floor(0.03 * FS);
  let idx = 0, prevY = 0, apX = 0, apY = 0;
  for (let n = 0; n < nOn + nRel; n++) {
    const oi = s0 + n;
    const y = buf[idx];
    if (oi >= 0 && oi < out.length) out[oi] += y * amp;
    const damp = n < nOn ? rho : 0.9;
    const avg = damp * 0.5 * (y + prevY);
    prevY = y;
    const ap = C * avg + apX - C * apY;
    apX = avg; apY = ap;
    buf[idx] = ap;
    if (++idx >= nInt) idx = 0;
  }
}
// ตีคอร์ด: frets[6] (−1 = ไม่ดีด) ; down = ดีดลง (สายต่ำ→สูง)
function strum(out, rnd, frets, t0, dur, amp, o) {
  o = o || {};
  const spread = o.spread != null ? o.spread : 0.012 + 0.03 * rnd();
  const strs = [];
  for (let s = 0; s < 6; s++) if (frets[s] >= 0) strs.push(s);
  if (o.up) strs.reverse();
  strs.forEach((s, k) => {
    const midi = TUNING[s] + frets[s];
    const tt = t0 + (strs.length > 1 ? (k * spread) / (strs.length - 1) : 0);
    ksNote(out, rnd, midi, tt, dur - (tt - t0), amp * (0.6 + 0.4 * rnd()) * (s >= 4 ? 0.8 : 1), { rho: midi < 50 ? 0.995 : 0.997 });
  });
}
function biquadHP(x, fc, q) {
  const w0 = (2 * Math.PI * fc) / FS, cw = Math.cos(w0), al = Math.sin(w0) / (2 * (q || 0.7071)), a0 = 1 + al;
  const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0, a1 = (-2 * cw) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y;
  }
}
// ห้องก้องเล็ก ๆ (Schroeder: 4 comb + 2 allpass), wet ~ −12dB
function reverb(x, wet) {
  const combs = [1116, 1188, 1277, 1356].map((d) => ({ d: Math.round((d * FS) / 44100), buf: new Float64Array(Math.round((d * FS) / 44100)), i: 0 }));
  const aps = [556, 441].map((d) => ({ d, buf: new Float64Array(d), i: 0 }));
  const out = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (const c of combs) { const y = c.buf[c.i]; c.buf[c.i] = x[n] + y * 0.78; c.i = (c.i + 1) % c.d; s += y; }
    s *= 0.25;
    for (const a of aps) { const y = a.buf[a.i]; const v = s + y * 0.5; a.buf[a.i] = v; a.i = (a.i + 1) % a.d; s = y - v * 0.5; }
    out[n] = s;
  }
  for (let n = 0; n < x.length; n++) x[n] += out[n] * (wet || 0.25);
}
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }
function addNoise(x, rnd, snrDb, kind) {
  const sig = rms(x);
  const target = sig / Math.pow(10, snrDb / 20);
  const n = new Float64Array(x.length);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < x.length; i++) {
    const w = rnd() * 2 - 1;
    if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; n[i] = b0 + b1 + b2 + w * 0.1848; }
    else n[i] = w;
  }
  const g = target / (rms(n) || 1);
  for (let i = 0; i < x.length; i++) x[i] += n[i] * g;
}
// variant: clean | phone | noisy | room
function finish(x, rnd, variant, peakDb) {
  if (variant === 'phone') { biquadHP(x, 180); biquadHP(x, 180); }
  if (variant === 'room') reverb(x, 0.3);
  let pk = 0;
  for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  const g = Math.pow(10, (peakDb != null ? peakDb : -12) / 20) / (pk || 1);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  if (variant === 'phone') addNoise(x, rnd, 28, 'pink');
  if (variant === 'noisy') addNoise(x, rnd, 15, 'pink');
  if (variant === 'room') addNoise(x, rnd, 35, 'white');
  if (variant === 'clean') addNoise(x, rnd, 50, 'white');
  return Float32Array.from(x);
}
const analyze = (sig, opts) => Practice._analyzeBuffer(sig, FS, opts).frames;
const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const n = s.length; return n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };
const pct = (a, q) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/* ============ 1. pitch accuracy ============ */
function testPitch() {
  console.log('\n[1] pitch — E2…E6 ทุก semitone × 4 แบบเสียง');
  const variants = ['clean', 'phone', 'noisy', 'room'];
  const all = { cents: [], gross: 0, oct: 0, n: 0, voiced: 0, frames: 0, fGross: 0 };
  for (const v of variants) {
    const rnd = mulberry32(100 + variants.indexOf(v));
    const errs = [];
    let gross = 0, oct = 0, voicedF = 0, totalF = 0, fGross = 0, n = 0;
    for (let midi = 40; midi <= 88; midi++) {
      const x = new Float64Array(Math.floor(1.1 * FS));
      ksNote(x, rnd, midi, 0.15, 0.85, 0.5, {});
      const sig = finish(x, rnd, v, -14 - 8 * rnd());
      const fr = analyze(sig);
      const vals = [];
      for (const f of fr) {
        if (f.t < 0.15 + 0.04 || f.t > 0.15 + 0.6) continue;
        totalF++;
        if (f.midi === null || f.conf < 0.72) continue;
        voicedF++;
        vals.push(f.midi);
        if (Math.abs(f.midi - midi) > 0.5) fGross++;
      }
      n++;
      if (!vals.length) { gross++; continue; }
      const m = median(vals), e = (m - midi) * 100;
      if (Math.abs(e) > 50) {
        gross++;
        const k = Math.round(e / 1200);
        if (k !== 0 && Math.abs(e - 1200 * k) < 50) oct++;
        if (process.env.PRACTICE_DEBUG) console.log('   gross', v, NAMES[midi % 12] + (Math.floor(midi / 12) - 1), fmt(e, 0), 'cents');
      } else errs.push(Math.abs(e));
    }
    console.log(`   ${v.padEnd(6)} median |err| ${fmt(median(errs))}c  p95 ${fmt(pct(errs, 0.95))}c  gross ${gross}/${n} (octave ${oct})  voiced frames ${fmt((100 * voicedF) / totalF, 0)}%  frame-gross ${fmt((100 * fGross) / Math.max(1, voicedF))}%`);
    all.cents.push(...errs); all.gross += gross; all.oct += oct; all.n += n; all.voiced += voicedF; all.frames += totalF; all.fGross += fGross;
  }
  const med = median(all.cents), grossRate = all.gross / all.n, fG = all.fGross / Math.max(1, all.voiced);
  console.log(`   รวม: median |err| ${fmt(med)}c · p95 ${fmt(pct(all.cents, 0.95))}c · gross ${fmt(100 * grossRate)}% · octave ${all.oct} · frame-gross ${fmt(100 * fG)}%`);
  check(med <= 8, `pitch median error ${fmt(med)}c > 8c`);
  check(grossRate <= 0.02, `pitch gross error rate ${fmt(100 * grossRate)}% > 2%`);
  check(fG <= 0.03, `pitch frame gross error ${fmt(100 * fG)}% > 3%`);
  // _pitchYin (pure helper) ตรง ๆ
  const rnd = mulberry32(7);
  let yinBad = 0;
  for (const midi of [40, 45, 52, 57, 64, 69, 76, 81, 88]) {
    const x = new Float64Array(Math.floor(0.4 * FS));
    ksNote(x, rnd, midi, 0, 0.4, 0.5, {});
    const seg = Float32Array.from(x.subarray(Math.floor(0.1 * FS), Math.floor(0.1 * FS) + 2048));
    const r = Practice._pitchYin(seg, FS);
    if (!r || Math.abs(r.midi - midi) > 0.3) { yinBad++; console.log('   _pitchYin miss', midi, r && fmt(r.midi, 2)); }
  }
  check(yinBad === 0, `_pitchYin ผิด ${yinBad}/9`);
  return { med, grossRate, oct: all.oct, fG };
}

/* ============ 2. chord match ROC ============ */
const SHAPES = {
  C: [-1, 3, 2, 0, 1, 0], G: [3, 2, 0, 0, 0, 3], D: [-1, -1, 0, 2, 3, 2], A: [-1, 0, 2, 2, 2, 0], E: [0, 2, 2, 1, 0, 0],
  Am: [-1, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0], Dm: [-1, -1, 0, 2, 3, 1], F: [1, 3, 3, 2, 1, 1], Bm: [-1, 2, 4, 4, 3, 2],
  A7: [-1, 0, 2, 0, 2, 0], E7: [0, 2, 0, 1, 0, 0], D7: [-1, -1, 0, 2, 1, 2], G7: [3, 2, 0, 0, 0, 1], C7: [-1, 3, 2, 3, 1, 0], B7: [-1, 2, 1, 2, 0, 2],
  Am7: [-1, 0, 2, 0, 1, 0], Em7: [0, 2, 0, 0, 0, 0], Dm7: [-1, -1, 0, 2, 1, 1], Cmaj7: [-1, 3, 2, 0, 0, 0], Fmaj7: [-1, -1, 3, 2, 1, 0],
  Amaj7: [-1, 0, 2, 1, 2, 0], Dmaj7: [-1, -1, 0, 2, 2, 2], Asus2: [-1, 0, 2, 2, 0, 0], Asus4: [-1, 0, 2, 2, 3, 0],
  Dsus4: [-1, -1, 0, 2, 3, 3], Dsus2: [-1, -1, 0, 2, 3, 0], Esus4: [0, 2, 2, 2, 0, 0], 'F#m': [2, 4, 4, 2, 2, 2],
  'C#m': [-1, 4, 6, 6, 5, 4], Bb: [-1, 1, 3, 3, 3, 1], Gm: [3, 5, 5, 3, 3, 3], Cm: [-1, 3, 5, 5, 4, 3], B: [-1, 2, 4, 4, 4, 2],
  Ab: [4, 6, 6, 5, 4, 4], 'C/G': [3, 3, 2, 0, 1, 0], 'Am/G': [3, 0, 2, 2, 1, 0], 'D/F#': [2, -1, 0, 2, 3, 2],
  E5: [0, 2, 2, -1, -1, -1], A5: [-1, 0, 2, 2, -1, -1], G5: [3, 5, 5, -1, -1, -1], Cadd9: [-1, 3, 2, 0, 3, 0], Bdim: [-1, 2, 3, 4, 3, -1],
};
const SHAPE_ALT = { G: [3, 2, 0, 0, 3, 3], C: [-1, 3, 5, 5, 5, 3], A: [5, 7, 7, 6, 5, 5], Am: [5, 7, 7, 5, 5, 5], E: [-1, 7, 9, 9, 9, 7], D: [-1, 5, 7, 7, 7, 5] };
function pcsOfName(n) { return Practice._parseChord(n).pcs; }
// สะสม chroma แบบเดียวกับ follower (chromaOn ของเฟรม onset+30ms … onset+130ms)
function attackChroma(frames, tOn) {
  const c = new Float64Array(12);
  let n = 0;
  for (const f of frames) {
    const el = f.t - tOn;
    if (el < 0.03 || el > 0.13 || !(f.chromaOnW > 0)) continue;
    for (let k = 0; k < 12; k++) c[k] += f.chromaOn[k];
    n++;
  }
  return n ? c : null;
}
function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
function testChords() {
  console.log('\n[2] chord match — ตีคอร์ดจริง ' + Object.keys(SHAPES).length + ' ท่า × 4 แบบเสียง × ลง/ขึ้น');
  const names = Object.keys(SHAPES);
  const setKey = (n) => pcsOfName(n).slice().sort((a, b) => a - b).join(',');
  const pos = [], negRand = [], negNear = [], negSuper = [], posByVar = {};
  const thr = Practice.CHORD_THRESHOLD;
  let noAttack = 0;
  const vars = ['clean', 'phone', 'noisy', 'room'];
  const misses = [];
  for (const v of vars) {
    const rnd = mulberry32(300 + vars.indexOf(v));
    posByVar[v] = [];
    for (const name of names) {
      for (const up of [false, true]) {
        const shape = up && SHAPE_ALT[name] ? SHAPE_ALT[name] : SHAPES[name];
        const x = new Float64Array(Math.floor(0.9 * FS));
        strum(x, rnd, shape, 0.2, 0.65, 0.4, { up });
        const sig = finish(x, rnd, v, -10 - 10 * rnd());
        const fr = analyze(sig);
        const on = fr.find((f) => f.onset && f.onsetT > 0.12 && f.onsetT < 0.3);
        if (!on) { noAttack++; continue; }
        const c = attackChroma(fr, on.onsetT);
        if (!c) { noAttack++; continue; }
        const sp = Practice._matchChord(c, name);
        pos.push(sp); posByVar[v].push(sp);
        if (sp < thr) misses.push(`${v}:${name}${up ? '↑' : ''}=${fmt(sp, 2)}`);
        const mine = new Set(pcsOfName(name));
        for (const other of names) {
          if (setKey(other) === setKey(name)) continue;
          const sn = Practice._matchChord(c, other);
          const op = pcsOfName(other);
          const shared = op.filter((p) => mine.has(p)).length;
          const missingFromPlayed = op.length - shared; // โน้ตของคอร์ดที่คาดแต่ผู้เล่นไม่ได้เล่น
          const extraPlayed = mine.size - shared;
          if (missingFromPlayed === 0 && extraPlayed > 0) negSuper.push(sn); // เล่นเกิน (เช่น คาด Am เล่น Am7)
          else if (missingFromPlayed <= 1 && shared >= 2) negNear.push(sn);
          else negRand.push(sn);
        }
      }
    }
  }
  const tpr = pos.filter((s) => s >= thr).length / pos.length;
  const fpr = (a) => a.filter((s) => s >= thr).length / Math.max(1, a.length);
  console.log(`   threshold ${thr}: TPR ${fmt(100 * tpr)}% (n=${pos.length}, ไม่พบ onset ${noAttack})`);
  for (const v of vars) console.log(`     ${v.padEnd(6)} TPR ${fmt((100 * posByVar[v].filter((s) => s >= thr).length) / posByVar[v].length)}%  median score ${fmt(median(posByVar[v]), 2)}`);
  console.log(`   FPR คอร์ดต่างกันชัด ${fmt(100 * fpr(negRand))}% (n=${negRand.length}) · ต่างกัน 1 โน้ต ${fmt(100 * fpr(negNear))}% (n=${negNear.length}) · เล่นโน้ตเกิน (เช่น Am7 แทน Am) ${fmt(100 * fpr(negSuper))}% (n=${negSuper.length})`);
  console.log(`   AUC: ชัด ${fmt(auc(pos, negRand), 3)} · ใกล้ ${fmt(auc(pos, negNear), 3)} · โน้ตเกิน ${fmt(auc(pos, negSuper), 3)}`);
  // threshold sweep (ROC-ish)
  const rows = [];
  for (const t of [0.45, 0.5, 0.55, 0.58, 0.6, 0.62, 0.65, 0.7]) rows.push(`${t}: TPR ${fmt(100 * pos.filter((s) => s >= t).length / pos.length, 0)} / FPRnear ${fmt(100 * fpr2(negNear, t), 0)} / FPRsuper ${fmt(100 * fpr2(negSuper, t), 0)}`);
  function fpr2(a, t) { return a.filter((s) => s >= t).length / Math.max(1, a.length); }
  console.log('   sweep  ' + rows.join(' | '));
  if (misses.length && process.env.PRACTICE_DEBUG) console.log('   below thr:', misses.join(' '));
  check(tpr >= 0.92, `chord TPR ${fmt(100 * tpr)}% < 92%`);
  check(fpr(negRand) <= 0.01, `chord FPR (ต่างชัด) ${fmt(100 * fpr(negRand))}% > 1%`);
  check(fpr(negNear) <= 0.1, `chord FPR (ต่าง 1 โน้ต) ${fmt(100 * fpr(negNear))}% > 10%`);
  check(fpr(negSuper) <= 0.35, `chord FPR (เล่นโน้ตเกิน) ${fmt(100 * fpr(negSuper))}% > 35%`);
  check(noAttack <= 2, `ตีคอร์ดแล้วไม่พบ onset ${noAttack} ครั้ง`);
  // matchNotes: double-stop / ท่าจับหลายโน้ต
  const rnd = mulberry32(55);
  let dsBad = 0;
  for (const [a, b] of [[40, 47], [45, 52], [55, 59], [57, 60], [64, 67], [62, 66]]) {
    const x = new Float64Array(Math.floor(0.7 * FS));
    ksNote(x, rnd, a, 0.2, 0.5, 0.4, {}); ksNote(x, rnd, b, 0.205, 0.5, 0.35, {});
    const fr = analyze(finish(x, rnd, 'clean'));
    const on = fr.find((f) => f.onset);
    const c = on && attackChroma(fr, on.onsetT);
    const good = c ? Practice._matchNotes(c, [a, b]) : 0;
    const bad = c ? Practice._matchNotes(c, [a, b + 1]) : 1;
    if (!(good >= thr && bad < thr)) { dsBad++; console.log('   double-stop', a, b, fmt(good, 2), fmt(bad, 2)); }
  }
  check(dsBad === 0, `matchNotes double-stop ผิด ${dsBad}/6`);
  return { tpr, fprRand: fpr(negRand), fprNear: fpr(negNear), fprSuper: fpr(negSuper), aucRand: auc(pos, negRand), aucNear: auc(pos, negNear) };
}

/* ============ 3. onset timing ============ */
function testOnsets() {
  console.log('\n[3] onset — โน้ตเดี่ยว/โน้ตซ้ำ/สตรัม เวลาสุ่ม');
  const res = {};
  for (const v of ['clean', 'phone', 'room', 'noisy']) {
    const rnd = mulberry32(500 + v.length);
    const dur = 26;
    const x = new Float64Array(Math.floor(dur * FS));
    const truth = [];
    let t = 0.4, prev = 52;
    while (t < dur - 1) {
      const r = rnd();
      if (r < 0.15) { // สตรัม
        const names = Object.keys(SHAPES);
        strum(x, rnd, SHAPES[names[Math.floor(rnd() * names.length)]], t, 0.5, 0.35, { up: rnd() < 0.3 });
        truth.push({ t, kind: 'strum' });
        t += 0.35 + 0.4 * rnd();
      } else {
        const same = rnd() < 0.2;
        const midi = same ? prev : 40 + Math.floor(rnd() * 45);
        const ioi = 0.11 + 0.45 * rnd();
        ksNote(x, rnd, midi, t, Math.min(ioi, 0.6), 0.15 + 0.35 * rnd(), {});
        truth.push({ t, kind: same ? 'repeat' : 'note', midi });
        prev = midi;
        t += ioi;
      }
    }
    const fr = analyze(finish(x, rnd, v, -10));
    const det = fr.filter((f) => f.onset).map((f) => f.onsetT);
    const used = new Set();
    const errs = [];
    let tp = 0;
    const missedKinds = {};
    for (const g of truth) {
      let bi = -1, bd = 0.05;
      det.forEach((d, i) => { if (!used.has(i) && Math.abs(d - g.t) < bd) { bd = Math.abs(d - g.t); bi = i; } });
      if (bi >= 0) { used.add(bi); tp++; errs.push((det[bi] - g.t) * 1000); } else missedKinds[g.kind] = (missedKinds[g.kind] || 0) + 1;
    }
    const prec = tp / Math.max(1, det.length), rec = tp / truth.length;
    const absE = errs.map(Math.abs);
    const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
    res[v] = { prec, rec, mean, med: median(errs), p95: pct(absE, 0.95), n: truth.length };
    console.log(`   ${v.padEnd(6)} n=${truth.length} precision ${fmt(100 * prec)}% recall ${fmt(100 * rec)}%  error mean ${fmt(mean)}ms median ${fmt(median(errs))}ms p95|e| ${fmt(pct(absE, 0.95))}ms  missed ${JSON.stringify(missedKinds)}`);
  }
  const vs = Object.values(res);
  const mRec = Math.min(...vs.map((r) => r.rec)), mPrec = Math.min(...vs.map((r) => r.prec));
  check(res.clean.rec >= 0.97 && res.clean.prec >= 0.97, `onset clean P/R ${fmt(100 * res.clean.prec)}/${fmt(100 * res.clean.rec)} < 97%`);
  check(mRec >= 0.92, `onset recall ต่ำสุด ${fmt(100 * mRec)}% < 92%`);
  check(mPrec >= 0.92, `onset precision ต่ำสุด ${fmt(100 * mPrec)}% < 92%`);
  check(Math.abs(res.clean.mean) <= 4, `onset bias ${fmt(res.clean.mean)}ms > 4ms`);
  check(Math.max(...vs.map((r) => r.p95)) <= 20, `onset p95 error > 20ms`);
  return res;
}

/* ============ 4. noise only ============ */
function testNoise() {
  console.log('\n[4] นอยส์ล้วน (ไม่มีกีตาร์) — ต้องไม่มี onset/pitch หลอก');
  const rnd = mulberry32(900);
  const dur = 12, n = Math.floor(dur * FS);
  const cases = {
    'white −50dB': () => { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = (rnd() * 2 - 1) * 0.0055; return x; },
    'pink −40dB (พัดลม)': () => { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = 1e-9; addNoise(x, rnd, 20 * Math.log10(rms(x)) + 40, 'pink'); return x; },
    'pink −30dB (ห้องดัง)': () => { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = 1e-9; addNoise(x, rnd, 20 * Math.log10(rms(x)) + 30, 'pink'); return x; },
    'hum 50Hz −30dB': () => { const x = new Float64Array(n); for (let i = 0; i < n; i++) { const t = i / FS; x[i] = 0.03 * (Math.sin(2 * Math.PI * 50 * t) + 0.5 * Math.sin(2 * Math.PI * 100 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t)) + (rnd() * 2 - 1) * 0.001; } return x; },
    'hum 50Hz −40dB': () => { const x = new Float64Array(n); for (let i = 0; i < n; i++) { const t = i / FS; x[i] = 0.01 * (Math.sin(2 * Math.PI * 50 * t) + 0.5 * Math.sin(2 * Math.PI * 100 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t)) + (rnd() * 2 - 1) * 0.001; } return x; },
    'silence (digital 0)': () => new Float64Array(n),
  };
  let worstOn = 0, worstPitch = 0;
  for (const [name, mk] of Object.entries(cases)) {
    const fr = analyze(Float32Array.from(mk()));
    const ons = fr.filter((f) => f.t > 0.5 && f.onset).length;
    const voiced = fr.filter((f) => f.t > 0.5 && f.midi !== null && f.conf >= 0.72).length;
    const lv = median(fr.map((f) => f.level));
    console.log(`   ${name.padEnd(20)} level ${fmt(lv)}dB gate ${fmt(fr[fr.length - 1].gate)}dB  onsets ${ons} (${fmt(ons / dur, 2)}/s)  voiced frames ${voiced}`);
    worstOn = Math.max(worstOn, ons / dur); worstPitch = Math.max(worstPitch, voiced);
  }
  check(worstOn <= 0.1, `onset หลอกในนอยส์ ${fmt(worstOn, 2)}/s > 0.1/s`);
  check(worstPitch <= 10, `pitch หลอกในนอยส์ ${worstPitch} เฟรม`);
  return { worstOn, worstPitch };
}

/* ============ 5. follower ============ */
// เล่นเสียงสังเคราะห์ผ่าน analyzer → follower ด้วยนาฬิกาจำลอง (now = เวลาเฟรม + 20ms)
function runFollower(sig, expected, fopts, hooks) {
  const judged = [];
  const attempts = [];
  let now = 0, summary = null, f = null;
  const opts = Object.assign({ at: 0 }, fopts, {
    onJudge: (j) => judged.push(j), onAttempt: (a) => attempts.push(a), onDone: (s) => { summary = s; },
  });
  f = Practice._createFollower(expected, opts, { now: () => now });
  Practice._analyzeBuffer(sig, FS, {
    onFrame: (fr) => {
      now = fr.t + 0.02;
      f.frame(fr); f.tick(now);
      if (hooks && hooks.onFrame) hooks.onFrame(f, now);
    },
  });
  // ปล่อยเวลาไหลต่อจนจบ
  if (!summary) { for (let k = 0; k < 200 && !summary; k++) { now += 0.05; f.tick(now); f.frame({ t: now - 0.02, level: -120, gate: -60, midi: null, conf: 0, chroma: new Float32Array(12), chromaW: 0, onset: false }); } }
  if (!summary) summary = f.stop();
  return { judged, attempts, summary, f };
}
function renderMelody(notes, variant, seed, extraDelay) {
  const rnd = mulberry32(seed);
  const end = Math.max(...notes.map((n) => n.t + (n.d || 0.4))) + 1.2;
  const x = new Float64Array(Math.floor(end * FS));
  for (const n of notes) {
    if (n.midi == null && n.shape) strum(x, rnd, n.shape, n.t + (extraDelay || 0), n.d || 0.5, 0.35, { up: !!n.up });
    else if (n.midi != null) ksNote(x, rnd, n.midi, n.t + (extraDelay || 0), n.d || 0.4, 0.3 + 0.2 * rnd(), {});
  }
  return finish(x, rnd, variant || 'room', -12);
}
function testFollower() {
  console.log('\n[5] follower — ตัดสินจริงตามไทม์ไลน์');
  const out = {};
  // เมโลดี้ 32 โน้ต (8th @ 100bpm = 0.3s)
  const rnd = mulberry32(42);
  const scale = [52, 55, 57, 59, 62, 64, 67, 69, 71, 72, 74, 76, 79, 45, 47, 48, 50, 40, 43];
  const exp = [];
  for (let k = 0; k < 32; k++) exp.push({ t: 1.0 + k * 0.3, d: 0.28, midi: scale[Math.floor(rnd() * scale.length)] });
  // ผู้เล่น: เวลาเพี้ยน ±25ms, โน้ตผิด 3 ตัว (#5 +1, #12 −2, #20 +12), early #8 (−170ms), late #16 (+170ms), ขาด #25
  const play = exp.map((e) => ({ t: e.t + (rnd() - 0.5) * 0.05, d: 0.27, midi: e.midi }));
  const wrongIdx = { 5: 1, 12: -2, 20: 12 };
  for (const [i, d] of Object.entries(wrongIdx)) play[i].midi += d;
  play[8].t = exp[8].t - 0.17; play[16].t = exp[16].t + 0.17;
  play[25].midi = null;
  const want = exp.map((e, i) => (wrongIdx[i] != null || i === 25 ? 'miss' : i === 8 ? 'early' : i === 16 ? 'late' : 'hit'));
  const scoreRun = (label, r) => {
    const got = new Array(exp.length).fill('none');
    for (const j of r.judged) got[j.i] = j.result;
    let ok = 0, falseHit = 0, wrongMiss = 0;
    const bad = [];
    got.forEach((g, i) => {
      if (g === want[i]) ok++; else bad.push(`#${i}:${want[i]}→${g}`);
      if (want[i] === 'miss' && g !== 'miss') falseHit++;
      if (want[i] !== 'miss' && g === 'miss') wrongMiss++;
    });
    const dts = r.judged.filter((j) => j.result === 'hit').map((j) => j.dtMs);
    console.log(`   ${label.padEnd(26)} ตรงคาด ${ok}/${exp.length}  false-hit ${falseHit}  พลาดโน้ตที่ถูก ${wrongMiss}  dt hit median ${fmt(median(dts))}ms  acc ${fmt(100 * r.summary.accuracy)}%  ${bad.length ? 'ต่าง: ' + bad.join(' ') : ''}`);
    return { ok, falseHit, wrongMiss, n: exp.length };
  };
  for (const v of ['clean', 'phone', 'room', 'noisy']) {
    const sig = renderMelody(play, v, 11);
    const r = runFollower(sig, exp, { mode: 'timed' });
    out['timed-' + v] = scoreRun('timed ' + v, r);
  }
  // latency 80ms ในเสียง + latencyMs=80
  {
    const sig = renderMelody(play, 'room', 12, 0.08);
    out.latency = scoreRun('timed room +80ms latency', runFollower(sig, exp, { mode: 'timed', latencyMs: 80 }));
  }
  // tempo 0.5: เพลงเดิม เล่นช้าลงครึ่ง (เวลาจริง = t/0.5)
  {
    const slow = play.map((p) => ({ t: p.t / 0.5, d: 0.4, midi: p.midi }));
    // early/late ของเดิม 170ms(song) → จริง 340ms ยังอยู่ในหน้าต่าง ok (2.5×100ms song = 500ms จริง)
    const sig = renderMelody(slow, 'room', 13);
    out.tempo = scoreRun('timed tempo 0.5', runFollower(sig, exp, { mode: 'timed', tempo: 0.5 }));
  }
  // allowOctave
  {
    const e2 = [{ t: 0.8, d: 0.4, midi: 52 }, { t: 1.6, d: 0.4, midi: 57 }];
    const p2 = [{ t: 0.8, midi: 64 }, { t: 1.6, midi: 57 }];
    const sig = renderMelody(p2, 'room', 14);
    const strict = runFollower(sig, e2, { mode: 'timed' }).judged.map((j) => j.result).join(',');
    const loose = runFollower(sig, e2, { mode: 'timed', allowOctave: true }).judged.map((j) => j.result).join(',');
    console.log(`   allowOctave: คาด E3 เล่น E4 → strict [${strict}] · allowOctave [${loose}]`);
    check(strict === 'miss,hit', 'allowOctave=false ต้อง miss โน้ตผิดออกเทฟ');
    check(loose === 'hit,hit', 'allowOctave=true ต้อง hit โน้ตออกเทฟ');
  }
  // คอร์ด: ตีแพทเทิร์น D-DU-UDU (คอร์ดละ 1 ห้อง 4/4 @ 90bpm) 12 คอร์ด × 3 seed × 4 แบบเสียง
  // ความยาวเสียงสุ่ม 0.5–0.95 beat → คอร์ดเก่ามักยังดังทับตอนเปลี่ยนคอร์ด (เคสยาก) · ห้องที่ 7 ตีผิด (Em แทน Am)
  {
    const prog = ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'Dm', 'E', 'Am', 'D'];
    const beat = 60 / 90, bar = 4 * beat;
    const pattern = [[0, false], [1, false], [1.5, true], [2.5, true], [3, false], [3.5, true]];
    // ชุด far: ห้อง 7 ตี Em แทน Am · ชุด near: ห้อง 3 ตี C แทน Am, ห้อง 10 ตี Em แทน E, ห้อง 12 ตี Dm แทน D
    const WRONG = { far: { 6: 'Em' }, near: { 2: 'C', 9: 'Em', 11: 'Dm' } };
    let ok = 0, n = 0, missed = 0, fh = 0, offTime = 0, nWrong = 0;
    const bad = [], fhList = [];
    for (const set of ['far', 'near']) for (const seed of [15, 16, 17]) for (const v of ['clean', 'phone', 'room', 'noisy']) {
      const rr = mulberry32(seed + (set === 'near' ? 100 : 0));
      const e3 = prog.map((c, i) => ({ t: 1 + i * bar, d: bar, chord: c }));
      const pl = [];
      prog.forEach((c, i) => {
        const pn = WRONG[set][i] || c;
        for (const [b, up] of pattern) pl.push({ t: 1 + i * bar + b * beat + (rr() - 0.5) * 0.03, d: (0.5 + 0.45 * rr()) * beat, shape: SHAPES[pn], up });
      });
      const r = runFollower(renderMelody(pl, v, seed), e3, { mode: 'timed' });
      for (const j of r.judged) {
        n++;
        const want = WRONG[set][j.i] ? 'miss' : 'hit';
        if (want === 'miss') nWrong++;
        if (j.result === want) ok++;
        else if (want === 'miss') { fh++; fhList.push(`${set}/${v}/${seed}#${j.i} ${WRONG[set][j.i]}→${prog[j.i]}`); }
        else if (j.result === 'miss') { missed++; bad.push(`${v}/${seed}#${j.i}${prog[j.i]}`); } else offTime++;
      }
    }
    const nRight = n - nWrong;
    console.log(`   chords (12 คอร์ด × 3 seed × 4 แบบเสียง × 2 ชุดคอร์ดผิด): ตรงคาด ${ok}/${n} (${fmt((100 * ok) / n)}%)  พลาดคอร์ดถูก ${missed}/${nRight}  ผิดจังหวะ ${offTime}  false-hit ${fh}/${nWrong}${bad.length ? ' · พลาด: ' + bad.join(' ') : ''}${fhList.length ? ' · false-hit: ' + fhList.join(' ') : ''}`);
    out.chords = { ok, n, missed, fh, nWrong, nRight };
    check(fh / nWrong <= 0.1, `chord follower false-hit ${fh}/${nWrong} > 10%`);
    check(missed / nRight <= 0.05, `chord follower พลาดคอร์ดที่ตีถูก ${missed}/${nRight} > 5%`);
  }
  // กับดัก false hit: โน้ตผิดขณะโน้ตก่อนหน้ายังดังค้าง (sustain ยาว)
  {
    const cases = [
      { name: 'โน้ตซ้ำ E4→(คาด E4) เล่น F4', prev: 64, exp: 64, play: 65, want: 'miss' },
      { name: 'คาด A3 เล่น A4 (ออกเทฟบน)', prev: 57, exp: 57, play: 69, want: 'miss' },
      { name: 'คาด E3 เล่น B4 (h3)', prev: 52, exp: 52, play: 71, want: 'miss' },
      { name: 'คาด G3 เล่น G2 (ออกเทฟล่าง)', prev: 55, exp: 55, play: 43, want: 'miss' },
      { name: 'คาด D4 เล่น D#4', prev: 62, exp: 62, play: 63, want: 'miss' },
      { name: 'คาด C4 ไม่เล่น (C4 ก่อนหน้ายังดัง)', prev: 60, exp: 60, play: null, want: 'miss' },
      { name: 'คาด E5 หลัง E4 ค้าง (ถูก)', prev: 64, exp: 76, play: 76, want: 'hit' },
      { name: 'คาด A2 หลัง A2 ค้าง (ถูก, ดีดซ้ำ)', prev: 45, exp: 45, play: 45, want: 'hit' },
    ];
    let bad = 0;
    const rows = [];
    for (const [ci, c] of cases.entries()) {
      for (const v of ['clean', 'room', 'phone']) {
        const e = [{ t: 0.6, d: 0.5, midi: c.prev }, { t: 1.1, d: 0.5, midi: c.exp }];
        const p = [{ t: 0.6, d: 1.2, midi: c.prev }];
        if (c.play != null) p.push({ t: 1.1, d: 0.6, midi: c.play });
        const r = runFollower(renderMelody(p, v, 70 + ci), e, { mode: 'timed' });
        const j = r.judged.find((x) => x.i === 1);
        const got = j ? (j.result === 'miss' ? 'miss' : 'hit') : 'none';
        if (got !== c.want) { bad++; rows.push(`${c.name} [${v}] → ${j && j.result}`); }
      }
    }
    console.log(`   กับดัก false-hit/โน้ตค้าง: ผิด ${bad}/${cases.length * 3}${rows.length ? ' · ' + rows.join(' · ') : ''}`);
    check(bad === 0, `กับดักโน้ตค้าง ผิด ${bad} เคส`);
    out.traps = bad;
  }
  // wait mode: ผู้เล่นช้ากว่าเพลง + ตีผิดก่อนแล้วแก้ + ข้าม 1 โน้ต
  {
    const e4 = [52, 55, 57, 59, 60, 62].map((m, k) => ({ t: 0.5 + k * 0.4, d: 0.35, midi: m }));
    // ผู้เล่น: แต่ละโน้ตห่าง 0.7s, โน้ต #2 เล่นผิด (58) ก่อน แล้วถูกที่ +0.5s, โน้ต #4 ไม่เล่น (กด skip)
    const p4 = [];
    let tt = 0.7;
    e4.forEach((e, k) => {
      if (k === 2) { p4.push({ t: tt, midi: 58 }); tt += 0.5; }
      if (k === 4) { tt += 0.2; return; }
      p4.push({ t: tt, midi: e.midi }); tt += 0.7;
    });
    const sig = renderMelody(p4, 'room', 16);
    let waitedAt4 = null;
    const r = runFollower(sig, e4, { mode: 'wait' }, {
      onFrame: (f, now) => {
        // จำลองผู้ใช้กด skip เมื่อรอโน้ต #4 นานเกิน 0.25s
        if (f.waiting && f.events[4] && !f.events[4].status && f.events[3].status) {
          if (waitedAt4 == null) waitedAt4 = now; else if (now - waitedAt4 > 0.25) f.skip();
        }
      },
    });
    const res = r.judged.sort((a, b) => a.i - b.i).map((j) => j.result + (j.skipped ? '(skip)' : '')).join(',');
    const wrongTries = r.attempts.filter((a) => !a.ok).length;
    console.log(`   wait mode: [${res}] attempt ผิด ${wrongTries} ครั้ง  summary hits ${r.summary.hits}/${r.summary.total}`);
    check(res === 'hit,hit,hit,hit,miss(skip),hit', `wait mode ได้ [${res}]`);
    check(wrongTries >= 1, 'wait mode ต้องรายงาน attempt ผิด (onAttempt)');
    out.wait = { res };
  }
  const timedRuns = ['timed-clean', 'timed-phone', 'timed-room', 'timed-noisy', 'latency', 'tempo'].map((k) => out[k]);
  const fh = timedRuns.reduce((a, r) => a + r.falseHit, 0), wm = timedRuns.reduce((a, r) => a + r.wrongMiss, 0);
  const totalCorrect = timedRuns.reduce((a, r) => a + (r.n - 4), 0), totalWrong = timedRuns.length * 4;
  console.log(`   รวม timed: false-hit ${fh}/${totalWrong} โน้ตผิด · พลาดโน้ตถูก ${wm}/${totalCorrect}`);
  check(fh === 0, `false hit ${fh} (โน้ตผิดถูกนับว่าถูก)`);
  check(wm / totalCorrect <= 0.03, `พลาดโน้ตที่เล่นถูก ${wm}/${totalCorrect} > 3%`);
  for (const k of ['timed-clean', 'timed-room']) check(out[k].ok === out[k].n, `${k}: ตรงคาด ${out[k].ok}/${out[k].n}`);
  return { falseHit: fh, wrongMiss: wm, totalCorrect, totalWrong };
}

/* ============ 5b. calibrate (วิเคราะห์เสียง chirp ที่ไมค์อัดได้) ============ */
// จำลอง: ลำโพงมือถือ (band-pass 300Hz–4kHz) + ห้องก้อง + นอยส์ → ไมค์ → decimate ของจริง
function testCalib() {
  console.log('\n[5b] calibrate — chirp ผ่านลำโพง→ห้อง→ไมค์ จำลอง');
  const C = Practice._calib;
  const dec0 = Practice._decimationFor(FS);
  const wsr = dec0.rate;
  const cfg = { dur: C.dur, f0: C.f0, f1: Math.min(C.f1max, 0.4 * wsr), maxLag: C.maxLag };
  const t0 = 0.3, times = [];
  for (let k = 0; k < C.K; k++) times.push(t0 + k * C.SP + C.jit[k]);
  const capStart = t0 - 0.05, end = times[C.K - 1] + C.maxLag + C.dur + 0.05;
  const run = (latMs, o) => {
    const rnd = mulberry32(o.seed || 1);
    const x = new Float64Array(Math.ceil((end + 0.2) * FS));
    const ch = Practice._chirp(FS, C.dur, C.f0, cfg.f1);
    if (!o.silent) for (const T of times) {
      const s0 = Math.round((T + latMs / 1000 + (o.jitterMs ? (rnd() - 0.5) * o.jitterMs / 1000 : 0)) * FS);
      for (let j = 0; j < ch.length; j++) if (s0 + j < x.length) x[s0 + j] += ch[j] * (o.gain || 0.3);
    }
    if (o.strum) { // ผู้ใช้ตีกีตาร์ไปด้วยระหว่างวัด
      for (let t = 0.5; t < end; t += 0.45 + 0.2 * rnd()) strum(x, rnd, SHAPES[Object.keys(SHAPES)[Math.floor(rnd() * 20)]], t, 0.4, 0.5, {});
    }
    biquadHP(x, 300); // ลำโพงมือถือไม่มีย่านต่ำ
    if (o.room) reverb(x, 0.35);
    addNoise(x, rnd, o.snr || 30, 'pink');
    const sig = Float32Array.from(x);
    const dec = Practice._makeDecimator(FS);
    const d = new Float32Array(sig.length);
    const n = dec.run(sig, sig.length, d);
    const cap = new Float32Array(Math.ceil((end - capStart) * wsr) + 64);
    const off = Math.round(capStart * wsr);
    for (let i = 0; i < cap.length && off + i < n; i++) cap[i] = d[off + i];
    return Practice._calibAnalyze(cap, capStart, times, wsr, cfg);
  };
  const cases = [
    { name: 'ลำโพงในตัว 37ms', lat: 37, o: { room: true } },
    { name: 'ลำโพง 137ms + ห้องก้อง + นอยส์ 20dB', lat: 137, o: { room: true, snr: 20, seed: 2 } },
    { name: 'Bluetooth ~250ms', lat: 252, o: { room: true, seed: 3 } },
    { name: 'เสียงเบามาก (gain 0.03)', lat: 80, o: { gain: 0.03, room: true, seed: 4 } },
    { name: 'ใส่หูฟัง (ไมค์ไม่ได้ยิน)', lat: 60, o: { silent: true, seed: 5 }, expectNull: 'not-heard' },
    { name: 'ตีกีตาร์ไปด้วยระหว่างวัด', lat: 90, o: { strum: true, room: true, seed: 6 }, tolerant: true },
    { name: 'latency แกว่ง ±40ms (BT ไม่นิ่ง)', lat: 200, o: { jitterMs: 80, room: true, seed: 7 }, expectNull: 'inconsistent' },
  ];
  let bad = 0;
  for (const c of cases) {
    const r = run(c.lat, c.o);
    let ok;
    if (c.expectNull) ok = !r.ok && r.reason === c.expectNull;
    else if (c.tolerant) ok = !r.ok || Math.abs(r.latencyMs - c.lat) <= 2; // วัดไม่ได้ก็ได้ แต่ห้ามได้ค่าผิด
    else ok = r.ok && Math.abs(r.latencyMs - c.lat) <= 1.5;
    if (!ok) bad++;
    console.log(`   ${ok ? '✓' : '✗'} ${c.name.padEnd(34)} จริง ${c.lat}ms → ${r.ok ? r.latencyMs + 'ms (spread ' + r.spreadMs + 'ms, ได้ยิน ' + r.heard + '/' + r.clicks + ')' : 'null: ' + r.reason + ' (ได้ยิน ' + r.heard + '/' + r.clicks + ')'}`);
  }
  check(bad === 0, `calibrate ผิด ${bad} เคส`);
  return { bad };
}

/* ============ 6. performance ============ */
function testPerf() {
  console.log('\n[6] ประสิทธิภาพ');
  const rnd = mulberry32(77);
  const dur = 30;
  const x = new Float64Array(Math.floor(dur * FS));
  for (let t = 0.2; t < dur - 1; t += 0.25) ksNote(x, rnd, 40 + Math.floor(rnd() * 40), t, 0.6, 0.3, {});
  const sig = finish(x, rnd, 'room', -12);
  const dec = Practice._makeDecimator(FS);
  const d = new Float32Array(sig.length);
  const nd = dec.run(sig, sig.length, d);
  const an = Practice._createAnalyzer(dec.rate, {});
  let frames = 0;
  const cb = () => { frames++; };
  // warm-up
  an.push(d, Math.min(nd, dec.rate * 3), 0, cb);
  an.reset(); frames = 0;
  if (global.gc) global.gc();
  const h0 = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const CH = an.hop;
  for (let o = 0; o + CH <= nd; o += CH) an.push(d.subarray(o, o + CH), CH, o / dec.rate, cb);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (global.gc) global.gc();
  const h1 = process.memoryUsage().heapUsed;
  const usPer = (ms * 1000) / frames;
  const rt = ms / 1000 / dur;
  console.log(`   analyzer @${dec.rate}Hz hop ${an.hop} (${fmt((1000 * an.hop) / dec.rate)}ms) NS ${an.sizes.NS} NL ${an.sizes.NL} YIN τ ${an.sizes.TAU_MIN}…${an.sizes.TAU_MAX}`);
  console.log(`   ${frames} เฟรม ใน ${fmt(ms)}ms → ${fmt(usPer)}µs/เฟรม = ${fmt(100 * rt, 2)}% ของเวลาจริง (เครื่องนี้) · heap Δ ${fmt((h1 - h0) / 1024)}KB${global.gc ? '' : ' (รันด้วย --expose-gc เพื่อวัดแม่น)'}`);
  check(rt < 0.05, `analyzer ใช้ ${fmt(100 * rt, 1)}% ของเวลาจริง > 5%`);
  if (global.gc) check(h1 - h0 < 512 * 1024, `heap โต ${fmt((h1 - h0) / 1024)}KB ระหว่างวิเคราะห์ (ควรไม่จองใหม่ต่อเฟรม)`);
  return { usPer, rt };
}

/* ============ 7. chord parser ============ */
function testParser() {
  const cases = { C: 'C,E,G', Am7: 'C,E,G,A', 'F#m7b5': 'C,E,F#,A', Bbmaj7: 'D,F,A,A#', Dsus4: 'D,G,A', G7: 'D,F,G,B', 'C/E': 'C,E,G', 'Am/G': 'C,E,G,A', E5: 'E,B', Cadd9: 'C,D,E,G', Bdim: 'D,F,B', 'C#m': 'C#,E,G#', Ebm: 'D#,F#,A#', 'G13': 'C,D,E,F,G,A,B', 'C7#9': 'C,D#,E,G,A#', Caug: 'C,E,G#', Cdim7: 'C,D#,F#,A' };
  let bad = 0;
  for (const [n, want] of Object.entries(cases)) {
    const p = Practice._parseChord(n);
    const got = p ? p.pcs.map((k) => NAMES[k]).join(',') : 'null';
    if (got !== want) { bad++; console.log('   parse', n, '→', got, '(คาด', want + ')'); }
  }
  check(bad === 0, `parseChord ผิด ${bad} ตัว`);
  check(Practice._parseChord('N.C.') === null, 'N.C. ต้องได้ null');
}

/* ---------------- main ---------------- */
module.exports = { testChords, testOnsets, testPitch, testFollower, testNoise, testCalib, fails, mulberry32, ksNote, strum, finish, analyze, SHAPES, FS, median, pct, attackChroma, runFollower, renderMelody };
if (require.main === module) {
const t0 = Date.now();
const only = process.env.PRACTICE_ONLY ? process.env.PRACTICE_ONLY.split(',') : null;
const run = (k, fn) => (!only || only.includes(k) ? fn() : null);
run('parse', testParser);
const R = {};
R.pitch = run('pitch', testPitch);
R.chord = run('chord', testChords);
R.onset = run('onset', testOnsets);
R.noise = run('noise', testNoise);
R.follow = run('follow', testFollower);
R.calib = run('calib', testCalib);
R.perf = run('perf', testPerf);
console.log(`\nเวลาเทสต์ ${fmt((Date.now() - t0) / 1000)}s`);
if (fails.length) {
  console.log('\n✗ ไม่ผ่าน ' + fails.length + ' ข้อ:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('\n✓ practice engine ผ่านทุกเกณฑ์');
}
