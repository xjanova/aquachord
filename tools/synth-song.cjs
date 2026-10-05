/* synth-song.cjs — เพลงสังเคราะห์หลายเครื่องดนตรี + เฉลยโน้ตจริง (ใช้ร่วมโดย test-tracks.cjs และ e2e-tracks.mjs)
   กลอง (kick/snare/hat ปิด-เปิด/crash) · เบส pluck · pad คอร์ด · ลีดเมโลดี้ (vibrato ตอนโน้ตยาว)
   ทุกโน้ตมีความยาวจริงและช่วงพักจริง · humanize ±8ms · สเตอริโอ 44.1kHz (แพนต่างกันให้ Demucs มีข้อมูลแยก)
   evalNotes: F1 ระดับโน้ต — onset ±50ms + pitch ตรงเป๊ะ (กลอง: คีย์ GM ตรง) จับคู่แบบ greedy ตามระยะเวลา */
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const PROG = ['C', 'Am', 'F', 'G'];
const ROOT = { C: 36, Am: 33, F: 41, G: 43 };
const PAD = { C: [55, 60, 64], Am: [57, 60, 64], F: [57, 60, 65], G: [55, 59, 62] };
const SCALE = [67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84];
const CHORD_TONES = { C: [67, 72, 76, 79, 84], Am: [69, 72, 76, 81, 84], F: [69, 72, 77, 81, 84], G: [67, 71, 74, 79, 83] };
// จังหวะลีดต่อห้อง [step, len] (16th = 1)
const LEAD_RHY = [
  [[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 3]],
  [[0, 1], [1, 1], [2, 2], [4, 2], [6, 2], [8, 6]],
  [[0, 4], [6, 2], [8, 2], [10, 1], [11, 1], [12, 4]],
  [[2, 2], [4, 2], [6, 6], [13, 2]],
];

function synthSong(opts) {
  opts = opts || {};
  const sr = opts.sr || 44100, bpm = opts.bpm || 100, bars = opts.bars || 12;
  const phase0 = opts.phase != null ? opts.phase : 0.5;
  const hum = opts.humanize != null ? opts.humanize : 0.008;
  const step = 60 / bpm / 4;
  const duration = phase0 + bars * 16 * step + 1.6;
  const n = Math.ceil(duration * sr);
  const rnd = mulberry32(opts.seed || 7);
  const nrnd = mulberry32((opts.seed || 7) + 99);
  const mk = () => ({ L: new Float32Array(n), R: new Float32Array(n) });
  const parts = { drums: mk(), bass: mk(), pads: mk(), lead: mk() };
  const truth = { drums: [], bass: [], harmony: [], melody: [] };
  const T = (bar, st) => phase0 + (bar * 16 + st) * step + (rnd() * 2 - 1) * hum;
  const put = (p, i, v, pan) => { if (i >= 0 && i < n) { p.L[i] += v * (1 - pan); p.R[i] += v * (1 + pan); } };
  // เฟดท้ายเสียงกลอง 30% สุดท้าย (กันเสียงคลิกตอนตัดหาง)
  const tail = (i, len) => (i < 0.7 * len ? 1 : Math.max(0, (len - i) / (0.3 * len)));

  // ---------- กลอง ----------
  function hpNoise(len, fc, stages) {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = nrnd() * 2 - 1;
    const a = 1 / (1 + 2 * Math.PI * fc / sr);
    for (let s = 0; s < stages; s++) {
      let y = 0, xp = 0;
      for (let i = 0; i < len; i++) { const x = out[i]; y = a * (y + x - xp); xp = x; out[i] = y; }
    }
    return out;
  }
  function lpInPlace(x, fc) {
    const a = Math.exp(-2 * Math.PI * fc / sr);
    let y = 0;
    for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; x[i] = y; }
  }
  function kick(t, vel) {
    const len = Math.floor(0.45 * sr), s0 = Math.floor(t * sr);
    let ph = 0;
    const click = hpNoise(Math.floor(0.004 * sr), 1500, 1);
    for (let i = 0; i < len; i++) {
      const tt = i / sr;
      const f = 48 + 100 * Math.exp(-tt / 0.035);
      ph += 2 * Math.PI * f / sr;
      let v = Math.sin(ph) * Math.exp(-tt / 0.16) * Math.min(1, tt / 0.002);
      if (i < click.length) v += click[i] * (1 - i / click.length) * 0.6;
      put(parts.drums, s0 + i, v * 0.9 * vel * tail(i, len), 0);
    }
  }
  function snare(t, vel) {
    const len = Math.floor(0.35 * sr), s0 = Math.floor(t * sr);
    const nz = hpNoise(len, 900, 2);
    lpInPlace(nz, 9000);
    for (let i = 0; i < len; i++) {
      const tt = i / sr;
      const body = Math.sin(2 * Math.PI * 185 * tt) * Math.exp(-tt / 0.06) * 0.5 + Math.sin(2 * Math.PI * 330 * tt) * Math.exp(-tt / 0.04) * 0.3;
      const v = (body + nz[i] * 2.2 * Math.exp(-tt / 0.11)) * Math.min(1, tt / 0.001);
      put(parts.drums, s0 + i, v * 0.55 * vel * tail(i, len), 0);
    }
  }
  function hat(t, vel, open) {
    const dec = open ? 0.25 : 0.03;
    const len = Math.floor((open ? 0.7 : 0.14) * sr), s0 = Math.floor(t * sr);
    const nz = hpNoise(len, 5000, 2);
    for (let i = 0; i < len; i++) put(parts.drums, s0 + i, nz[i] * 2.2 * Math.exp(-(i / sr) / dec) * 0.22 * vel * tail(i, len), 0.25);
  }
  function crash(t, vel) {
    const len = Math.floor(2.4 * sr), s0 = Math.floor(t * sr);
    const nz = hpNoise(len, 3000, 2);
    for (let i = 0; i < len; i++) put(parts.drums, s0 + i, nz[i] * 1.6 * Math.exp(-(i / sr) / 0.9) * 0.3 * vel * tail(i, len), -0.2);
  }

  // ---------- โน้ตแบบ additive ----------
  // partials: [[h, amp, decayRate]] · attack/release วินาที · vib = cents (เฉพาะโน้ตยาว)
  function tone(p, midi, t, dur, amp, o) {
    const f0 = hz(midi) * Math.pow(2, (o.cents || 0) / 1200);
    const s0 = Math.floor(t * sr);
    const nOn = Math.floor(dur * sr), nRel = Math.floor(o.rel * sr);
    const parts_ = o.partials.filter(([h]) => f0 * h < sr * 0.45);
    const ph = parts_.map(() => rnd() * 2 * Math.PI);
    let vibPh = 0;
    for (let i = 0; i < nOn + nRel; i++) {
      const tt = i / sr;
      let env = Math.min(1, tt / o.att);
      if (i >= nOn) env *= Math.max(0, 1 - (i - nOn) / nRel);
      let fm = 1;
      if (o.vib && dur >= 0.4 && tt > 0.15) { vibPh += 2 * Math.PI * 5.5 / sr; fm = Math.pow(2, (o.vib * Math.min(1, (tt - 0.15) / 0.15) * Math.sin(vibPh)) / 1200); }
      let v = 0;
      for (let k = 0; k < parts_.length; k++) {
        const [h, a, dr] = parts_[k];
        ph[k] += 2 * Math.PI * f0 * h * fm / sr;
        v += a * Math.sin(ph[k]) * (dr ? Math.exp(-tt * dr) : 1);
      }
      put(p, s0 + i, v * env * amp, o.pan || 0);
    }
  }
  const BASS_P = []; for (let h = 1; h <= 10; h++) BASS_P.push([h, 1 / Math.pow(h, 1.3), 1.2 + 0.9 * h]);
  const PAD_P = []; for (let h = 1; h <= 6; h++) PAD_P.push([h, 1 / Math.pow(h, 1.8), 0.35]);
  const LEAD_P = []; for (let h = 1; h <= 14; h++) LEAD_P.push([h, (1 / h) / (1 + Math.pow(h * 523 / 3000, 2)), 0]);

  for (let b = 0; b < bars; b++) {
    const ch = PROG[b % 4], nxt = PROG[(b + 1) % 4];
    // กลอง
    const kicks = [0, 8].concat(b % 2 === 1 ? [10] : []).concat(b % 4 === 3 ? [14] : []);
    kicks.forEach((st) => { const t = T(b, st), v = st === 0 ? 0.95 : 0.85; kick(t, v); truth.drums.push({ t, midi: 36, vel: v }); });
    const snares = [4, 12].concat(b % 4 === 3 ? [13, 15] : []);
    snares.forEach((st) => { const t = T(b, st), v = st === 13 || st === 15 ? 0.6 : 0.9; snare(t, v); truth.drums.push({ t, midi: 38, vel: v }); });
    for (let st = 0; st < 16; st += 2) {
      const open = b % 4 === 3 && st === 14;
      const t = T(b, st), v = st % 4 === 0 ? 0.8 : 0.55;
      hat(t, v, open); truth.drums.push({ t, midi: open ? 46 : 42, vel: v });
    }
    if (b % 8 === 0) { const t = T(b, 0); crash(t, 0.9); truth.drums.push({ t, midi: 49, vel: 0.9 }); }
    // เบส
    const r = ROOT[ch], rn = ROOT[nxt];
    const appr = rn - 1 >= 28 ? rn - 1 : rn + 2;
    [[0, 3, r], [3, 1, r + 12], [6, 2, r], [8, 3, r + 7], [12, 2, r], [14, 2, appr]].forEach(([st, len, m]) => {
      const t = T(b, st), d = len * step * 0.85;
      tone(parts.bass, m, t, d, 0.42, { partials: BASS_P, att: 0.004, rel: 0.025 });
      truth.bass.push({ t, d, midi: m });
    });
    // pad คอร์ด (ตีจังหวะ 1 และ 3 ของห้อง)
    [0, 8].forEach((st) => {
      const t = T(b, st), d = 7 * step;
      PAD[ch].forEach((m) => {
        tone(parts.pads, m, t, d, 0.075, { partials: PAD_P, att: 0.012, rel: 0.06, cents: -4, pan: -0.6 });
        tone(parts.pads, m, t, d, 0.075, { partials: PAD_P, att: 0.012, rel: 0.06, cents: 4, pan: 0.6 });
        truth.harmony.push({ t, d, midi: m });
      });
    });
    // ลีด (ห้อง 2..; พักทั้งห้องที่ 6 และ 10)
    if (b >= 1 && b !== 6 && b !== 10 && b < bars) {
      let last = CHORD_TONES[ch][1];
      LEAD_RHY[b % 4].forEach(([st, len], k) => {
        let m;
        if (st === 0 || st === 8) m = CHORD_TONES[ch][Math.floor(rnd() * CHORD_TONES[ch].length)];
        else {
          const i = SCALE.indexOf(last) >= 0 ? SCALE.indexOf(last) : 3;
          const j = Math.max(0, Math.min(SCALE.length - 1, i + Math.floor(rnd() * 5) - 2));
          m = SCALE[j];
        }
        last = m;
        const t = T(b, st), d = len * step * 0.9;
        tone(parts.lead, m, t, d, 0.2, { partials: LEAD_P, att: 0.01, rel: 0.04, vib: 25, pan: -0.2 });
        truth.melody.push({ t, d, midi: m });
      });
    }
  }
  // มิกซ์ + normalize peak
  const L = new Float32Array(n), R = new Float32Array(n);
  Object.values(parts).forEach((p) => { for (let i = 0; i < n; i++) { L[i] += p.L[i]; R[i] += p.R[i]; } });
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.9 / (pk || 1);
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  Object.values(parts).forEach((p) => { for (let i = 0; i < n; i++) { p.L[i] *= g; p.R[i] *= g; } });
  Object.keys(truth).forEach((k) => truth[k].sort((a, b) => a.t - b.t || a.midi - b.midi));
  return { sr, L, R, duration, bpm, phase: phase0, truth, parts };
}

function writeWav(file, L, R, sr) {
  const fs = require('fs');
  const n = L.length, ch = R ? 2 : 1;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), o); o += 2;
    if (R) { buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), o); o += 2; }
  }
  fs.writeFileSync(file, buf);
}

// F1 ระดับโน้ต: onset ±tol + midi ตรงเป๊ะ (กลอง = คีย์ GM) · greedy ตามระยะเวลาจากน้อยไปมาก
function evalNotes(est, ref, tol) {
  tol = tol == null ? 0.05 : tol;
  const pairs = [];
  const rs = ref.slice().sort((a, b) => a.t - b.t);
  est.forEach((e, i) => {
    rs.forEach((r, j) => {
      const dt = Math.abs(e.t - r.t);
      if (dt <= tol && e.midi === r.midi) pairs.push([dt, i, j, e.t - r.t]);
    });
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const ue = new Set(), ur = new Set();
  let tp = 0, sumDt = 0;
  for (const [, i, j, sd] of pairs) {
    if (ue.has(i) || ur.has(j)) continue;
    ue.add(i); ur.add(j); tp++; sumDt += sd;
  }
  const P = est.length ? tp / est.length : (ref.length ? 0 : 1);
  const R = ref.length ? tp / ref.length : 1;
  const F1 = P + R > 0 ? (2 * P * R) / (P + R) : 0;
  return { tp, nEst: est.length, nRef: ref.length, P, R, F1, meanDt: tp ? sumDt / tp : 0 };
}

module.exports = { synthSong, writeWav, evalNotes, mulberry32 };
