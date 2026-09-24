'use strict';
/* chords.cjs — แปลงชื่อคอร์ดของ AquaChord + ตัวชี้วัดแบบ mir_eval (เขียนใหม่ใน JS)

   ใช้ใน benchmark (tools/eval/run.cjs) เท่านั้น — ไม่ถูกโหลดในเว็บ

   ── การ map ชื่อคอร์ด AquaChord (docs/04 §3) → Harte/mir_eval ──
     C → C:maj   Cm → C:min   C7 → C:7   Cm7 → C:min7   Cmaj7 → C:maj7
     Cm7b5 → C:hdim7   Cdim → C:dim   Cdim7 → C:dim7   Caug/C+ → C:aug
     Csus2 → C:sus2   Csus4/Csus → C:sus4   C7sus4 → C:sus4(b7)
     C6 → C:maj6   Cm6 → C:min6   Cmmaj7 → C:minmaj7
     C9/C11/C13 → C:9/11/13 (bitmap = C:7 เพราะ mir_eval ตัด extension เกินอ็อกเทฟทิ้ง
                  เมื่อ reduce_extended_chords=False — ค่าเริ่มต้นของ metric ทุกตัว)
     Cadd9 → C:maj(9) (bitmap = C:maj ด้วยเหตุผลเดียวกัน)   Cm9 → C:min9   Cmaj9 → C:maj9
     C/E → C:maj/3 — โน้ตเบสถูก "เติม" ลง bitmap เสมอ (encode() ของ mir_eval) เช่น C/B มี bitmap = C:maj7
     null / 'N' / 'N.C.' → N (ไม่มีคอร์ด)
     ชื่อที่ parse ไม่ได้ → X (ref: ไม่นับ, est: ผิดเสมอ)

   ── ตัวชี้วัด (ความหมายเดียวกับ mir_eval.chord) ──
     root     : root ตรงกัน (N เทียบ N = ถูก)
     majmin   : root + 8 semitone แรกของ bitmap ตรงกัน; นับเฉพาะ ref ที่เป็น maj/min/N
                (C7 ใน ref นับเป็น C:maj — 7th อยู่เลย semitone ที่ 7, sus/dim/aug/hdim ไม่นับ)
     sevenths : root + bitmap เต็มตรงกัน; นับเฉพาะ ref ∈ {maj, min, 7, maj7, min7, N}
     tetrads  : root + bitmap เต็มตรงกัน; นับทุกคอร์ด (รวม sus/dim/aug/m7b5) — ใช้เป็น "extended"
     mirex    : มี pitch class ร่วมกัน ≥ 3 ตัว (N เทียบ N = ถูก); ref ที่มีโน้ต 1–2 ตัวไม่นับ
     majminInv: เหมือน majmin แต่ต้องตรงโน้ตเบสด้วย (inversion) — ref ที่เบสไม่ใช่ root/3/5 ไม่นับ
   ค่าทุกตัวเป็น weighted overlap: รวม (ความยาวช่วง × คะแนน) / ความยาวช่วงที่นับ
   ช่วงเวลาของ est ถูกตัด/เติม N ให้ครอบเท่า ref (adjust_intervals ของ mir_eval)
     seg      : min(over-seg, under-seg) จาก directional hamming distance (ความเรียบของ segment)

   ── คีย์ (mir_eval.key.weighted_score / MIREX) ──
     ตรง = 1.0, est อยู่ขั้นคู่ห้าเหนือ ref (mode เดียวกัน) = 0.5, relative = 0.3, parallel = 0.2, อื่น ๆ = 0
     เพลงที่เปลี่ยนคีย์: เทียบกับคีย์ที่ครองเวลานานที่สุด (เอนจินคืนคีย์เดียวทั้งเพลง) */

const PC = {
  C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
};
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const mod12 = (n) => ((n % 12) + 12) % 12;

// iv = โน้ตที่ใช้สังเคราะห์ (มี extension เกินอ็อกเทฟได้), bm = bitmap แบบ mir_eval (ภายในอ็อกเทฟ)
const QUAL = {
  '':     { iv: [0, 4, 7],          bm: [0, 4, 7] },
  m:      { iv: [0, 3, 7],          bm: [0, 3, 7] },
  '7':    { iv: [0, 4, 7, 10],      bm: [0, 4, 7, 10] },
  m7:     { iv: [0, 3, 7, 10],      bm: [0, 3, 7, 10] },
  maj7:   { iv: [0, 4, 7, 11],      bm: [0, 4, 7, 11] },
  mmaj7:  { iv: [0, 3, 7, 11],      bm: [0, 3, 7, 11] },
  m7b5:   { iv: [0, 3, 6, 10],      bm: [0, 3, 6, 10] },
  dim:    { iv: [0, 3, 6],          bm: [0, 3, 6] },
  dim7:   { iv: [0, 3, 6, 9],       bm: [0, 3, 6, 9] },
  aug:    { iv: [0, 4, 8],          bm: [0, 4, 8] },
  '+':    { iv: [0, 4, 8],          bm: [0, 4, 8] },
  sus2:   { iv: [0, 2, 7],          bm: [0, 2, 7] },
  sus4:   { iv: [0, 5, 7],          bm: [0, 5, 7] },
  sus:    { iv: [0, 5, 7],          bm: [0, 5, 7] },
  '7sus4': { iv: [0, 5, 7, 10],     bm: [0, 5, 7, 10] },
  '6':    { iv: [0, 4, 7, 9],       bm: [0, 4, 7, 9] },
  m6:     { iv: [0, 3, 7, 9],       bm: [0, 3, 7, 9] },
  add9:   { iv: [0, 4, 7, 14],      bm: [0, 4, 7] },
  '9':    { iv: [0, 4, 7, 10, 14],  bm: [0, 4, 7, 10] },
  m9:     { iv: [0, 3, 7, 10, 14],  bm: [0, 3, 7, 10] },
  maj9:   { iv: [0, 4, 7, 11, 14],  bm: [0, 4, 7, 11] },
  '11':   { iv: [0, 4, 7, 10, 17],  bm: [0, 4, 7, 10] },
  '13':   { iv: [0, 4, 7, 10, 21],  bm: [0, 4, 7, 10] },
};
const CHORD_RE = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

function isNoChord(label) {
  return label == null || label === '' || label === 'N' || label === 'N.C.' || label === 'NC';
}

// → {root, quality, iv, bm(12 ตัว 0/1), bass(pc), bassIv} | {none:true} | {invalid:true}
function parseChord(label) {
  if (isNoChord(label)) return { none: true, root: -1, bm: new Array(12).fill(0), bassIv: 0 };
  const m = CHORD_RE.exec(String(label).trim());
  if (!m || !(m[2] in QUAL)) return { invalid: true, root: -2, bm: new Array(12).fill(-1), bassIv: 0 };
  const root = PC[m[1]];
  const q = QUAL[m[2]];
  const bm = new Array(12).fill(0);
  q.bm.forEach((i) => { bm[mod12(i)] = 1; });
  bm[0] = 1;
  const bass = m[3] ? PC[m[3]] : root;
  const bassIv = mod12(bass - root);
  bm[bassIv] = 1; // mir_eval เติมโน้ตเบสลง bitmap เสมอ
  return { root, quality: m[2], iv: q.iv.slice(), bm, bass, bassIv };
}

function transposeLabel(label, n, useFlat) {
  if (isNoChord(label)) return label;
  const m = CHORD_RE.exec(label);
  if (!m) return label;
  const names = useFlat ? FLAT : SHARP;
  let out = names[mod12(PC[m[1]] + n)] + m[2];
  if (m[3]) out += '/' + names[mod12(PC[m[3]] + n)];
  return out;
}

/* ---------------- ตัวเปรียบเทียบรายคู่ (คืน -1 = ไม่นับ) ---------------- */
const MAJ8 = [1, 0, 0, 0, 1, 0, 0, 1];
const MIN8 = [1, 0, 0, 1, 0, 0, 0, 1];
const SEVENTH_BM = ['', 'm', '7', 'm7', 'maj7'].map((q) => {
  const bm = new Array(12).fill(0); QUAL[q].bm.forEach((i) => { bm[i] = 1; }); return bm;
});
const eqN = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
const rotate = (c) => { // bitmap สัมพัทธ์ root → pitch class จริง
  const out = new Array(12).fill(0);
  if (c.root < 0) return out;
  for (let i = 0; i < 12; i++) if (c.bm[i] > 0) out[mod12(i + c.root)] = 1;
  return out;
};

const COMPARE = {
  root(r, e) {
    if (r.invalid) return -1;
    return r.root === e.root ? 1 : 0;
  },
  majmin(r, e) {
    if (r.invalid) return -1;
    const isMaj = eqN(r.bm, MAJ8, 8), isMin = eqN(r.bm, MIN8, 8);
    if (!(r.none || isMaj || isMin)) return -1;
    if (e.invalid) return 0;
    return r.root === e.root && eqN(r.bm, e.bm, 8) ? 1 : 0;
  },
  majminInv(r, e) {
    if (r.invalid) return -1;
    const isMaj = eqN(r.bm, MAJ8, 8), isMin = eqN(r.bm, MIN8, 8);
    if (!(r.none || isMaj || isMin)) return -1;
    if (!r.none && r.bassIv !== 0 && r.bassIv !== 7 && r.bassIv !== (isMaj ? 4 : 3)) return -1;
    if (e.invalid) return 0;
    return r.root === e.root && eqN(r.bm, e.bm, 8) && r.bassIv === e.bassIv ? 1 : 0;
  },
  sevenths(r, e) {
    if (r.invalid) return -1;
    if (!(r.none || SEVENTH_BM.some((b) => eqN(r.bm, b, 12)))) return -1;
    if (e.invalid) return 0;
    return r.root === e.root && eqN(r.bm, e.bm, 12) ? 1 : 0;
  },
  tetrads(r, e) {
    if (r.invalid) return -1;
    if (e.invalid) return 0;
    return r.root === e.root && eqN(r.bm, e.bm, 12) ? 1 : 0;
  },
  mirex(r, e) {
    if (r.invalid) return -1;
    if (r.none && e.none) return 1;
    const nRef = r.bm.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
    if (nRef > 0 && nRef < 3) return -1;
    if (e.invalid) return 0;
    const a = rotate(r), b = rotate(e);
    let inter = 0;
    for (let i = 0; i < 12; i++) inter += a[i] * b[i];
    return inter >= 3 ? 1 : 0;
  },
};
const METRICS = Object.keys(COMPARE);

function labelAt(segs, t, key) {
  // segs เรียงตามเวลา — ค้นแบบ binary search
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (t < s.t0) hi = mid - 1;
    else if (t >= s.t1) lo = mid + 1;
    else return s[key];
  }
  return null;
}

// ref: [{t0,t1,label}] ต่อเนื่อง, est: [{t0,t1,chord}] (รูปแบบ segs ของ dsp.js)
function evaluateChords(ref, est) {
  const T0 = ref[0].t0, T1 = ref[ref.length - 1].t1;
  const cut = new Set([T0, T1]);
  ref.forEach((s) => { cut.add(s.t0); cut.add(s.t1); });
  est.forEach((s) => {
    if (s.t0 > T0 && s.t0 < T1) cut.add(s.t0);
    if (s.t1 > T0 && s.t1 < T1) cut.add(s.t1);
  });
  const ts = Array.from(cut).filter((t) => t >= T0 && t <= T1).sort((a, b) => a - b);
  const num = {}, den = {};
  METRICS.forEach((m) => { num[m] = 0; den[m] = 0; });
  const cache = new Map();
  const enc = (l) => { const k = l == null ? 'N' : l; if (!cache.has(k)) cache.set(k, parseChord(l)); return cache.get(k); };
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i], b = ts[i + 1], d = b - a;
    if (d <= 0) continue;
    const mid = (a + b) / 2;
    const r = enc(labelAt(ref, mid, 'label'));
    const e = enc(labelAt(est, mid, 'chord'));
    for (const m of METRICS) {
      const s = COMPARE[m](r, e);
      if (s < 0) continue;
      num[m] += d * s; den[m] += d;
    }
  }
  const out = {};
  METRICS.forEach((m) => { out[m] = den[m] > 0 ? num[m] / den[m] : null; });
  out.seg = segmentation(ref, est, T0, T1);
  return out;
}

/* ---------------- segmentation (directional hamming distance) ---------------- */
function mergeSame(segs, key, T0, T1) {
  const out = [];
  let cur = T0;
  for (const s of segs) {
    const a = Math.max(T0, s.t0), b = Math.min(T1, s.t1);
    if (b <= a) continue;
    if (a > cur + 1e-9) out.push({ t0: cur, t1: a, l: null }); // ช่องว่าง = N
    const l = s[key] == null ? null : s[key];
    if (out.length && out[out.length - 1].l === l) out[out.length - 1].t1 = b;
    else out.push({ t0: a, t1: b, l });
    cur = b;
  }
  if (cur < T1 - 1e-9) {
    if (out.length && out[out.length - 1].l === null) out[out.length - 1].t1 = T1;
    else out.push({ t0: cur, t1: T1, l: null });
  }
  return out;
}
function dhd(A, B, T0, T1) {
  const bt = Array.from(new Set(B.flatMap((s) => [s.t0, s.t1]))).sort((x, y) => x - y);
  let seg = 0;
  for (const s of A) {
    const inside = bt.filter((t) => t >= s.t0 && t < s.t1);
    const pts = [s.t0].concat(inside, [s.t1]);
    let mx = 0;
    for (let i = 0; i + 1 < pts.length; i++) mx = Math.max(mx, pts[i + 1] - pts[i]);
    seg += (s.t1 - s.t0) - mx;
  }
  return seg / (T1 - T0);
}
function segmentation(ref, est, T0, T1) {
  const R = mergeSame(ref, 'label', T0, T1), E = mergeSame(est, 'chord', T0, T1);
  const over = 1 - dhd(R, E, T0, T1), under = 1 - dhd(E, R, T0, T1);
  return Math.min(over, under);
}

/* ---------------- คีย์ ---------------- */
function parseKey(k) {
  const m = /^([A-G][#b]?)(m?)$/.exec(k || '');
  if (!m) return null;
  return { pc: PC[m[1]], minor: !!m[2] };
}
function keyScore(ref, est) {
  const r = parseKey(ref), e = parseKey(est);
  if (!r || !e) return 0;
  if (r.pc === e.pc && r.minor === e.minor) return 1;
  if (r.minor === e.minor && mod12(e.pc - r.pc) === 7) return 0.5;
  if (!r.minor && e.minor && mod12(e.pc - r.pc) === 9) return 0.3;
  if (r.minor && !e.minor && mod12(e.pc - r.pc) === 3) return 0.3;
  if (r.pc === e.pc && r.minor !== e.minor) return 0.2;
  return 0;
}
function mainKey(keys) {
  const dur = new Map();
  keys.forEach((k) => {
    const p = parseKey(k.key);
    const id = p.pc + (p.minor ? 'm' : '');
    dur.set(id, (dur.get(id) || { key: k.key, d: 0 }));
    dur.get(id).d += k.t1 - k.t0;
  });
  let best = null;
  dur.forEach((v) => { if (!best || v.d > best.d) best = v; });
  return best.key;
}

/* ---------------- beat F-measure (หน้าต่าง ±70ms แบบ mir_eval.beat.f_measure) ---------------- */
function beatF(ref, est, win) {
  win = win || 0.07;
  const R = ref.filter((t) => t >= 5), E = est.filter((t) => t >= 5); // mir_eval ตัด 5 วิแรก
  if (!R.length || !E.length) return 0;
  let i = 0, j = 0, hit = 0;
  while (i < R.length && j < E.length) {
    const d = E[j] - R[i];
    if (Math.abs(d) <= win) { hit++; i++; j++; } else if (d < 0) j++; else i++;
  }
  const p = hit / E.length, r = hit / R.length;
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

module.exports = {
  PC, SHARP, FLAT, QUAL, METRICS, mod12,
  parseChord, isNoChord, transposeLabel,
  evaluateChords, keyScore, mainKey, parseKey, beatF,
};
