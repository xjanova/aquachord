'use strict';
/* synth.cjs — สังเคราะห์ "เพลงจำลองที่เหมือนจริง" หลายเครื่องดนตรี สำหรับ benchmark เอนจินแกะคอร์ด
   (deterministic ทุก seed, ไม่ต้องดาวน์โหลดอะไร, สังเคราะห์ที่ 11025 Hz = rate ที่เอนจินใช้จริง)

   สิ่งที่ใส่เพื่อให้ยากเหมือนเพลงจริง (ชุดเก่าใน test-dsp.cjs สะอาดเกินไป):
   - กลอง: kick (sine กวาดความถี่ ~45–140Hz ทับย่านเบส), snare (โทน+นอยส์), hi-hat, ฉิ่ง (ลูกทุ่ง — partial ไม่ฮาร์มอนิก)
   - เบส: เดินตาม root/โน้ตเบสของ slash chord + โน้ตผ่าน (approach/walking) + คู่ห้า
   - pad (voice leading เลือก inversion ที่ขยับน้อยสุด), กีตาร์ตีคอร์ด (voicing 6 สายแบบจริง + strum
     delay + ขึ้น/ลง + ตีสับจังหวะยก), เปียโนเกลี่ยคอร์ด (มี inharmonicity)
   - เสียงร้องหลัก: formant สระ, vibrato, portamento, โน้ตนอกคอร์ด (appoggiatura/passing/9th ท้ายวลี),
     ลูกคอลูกทุ่ง; ดังระดับเสียงร้องจริง (ดังกว่าดนตรีประกอบ)
   - reverb (Schroeder), detune ทั้งเพลง ±40 cents, ความดังเปลี่ยนตามท่อน + fade, sidechain (EDM),
     tempo drift/rubato + timing มนุษย์, คอร์ด push ก่อนจังหวะ (anticipation), เปลี่ยนคีย์
   - master: saturation, low-pass (mp3/ลำโพงมือถือ), high-pass (อัดจากลำโพงมือถือ = ไม่มี fundamental เบส), hiss
   ground truth: ช่วงคอร์ด (วินาที) ตามเวลาที่ฮาร์โมนีเปลี่ยนจริง, คีย์รายท่อน, beat/downbeat */
const { parseChord, transposeLabel, isNoChord, PC, mod12 } = require('./chords.cjs');

const SR = 11025;
const TBL = 4096, MASK = TBL - 1;
const SIN = new Float32Array(TBL);
for (let i = 0; i < TBL; i++) SIN[i] = Math.sin((2 * Math.PI * i) / TBL);
const NYQ = SR * 0.47;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => (rnd() + rnd() + rnd() + rnd() - 2) * 0.866; // ~N(0,1) หยาบ ๆ
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

/* ---------------- oscillator: additive + envelope + pitch bend ----------------
   o: {t0, dur, rel, midi, cents, amp, harm[], hdec[] (1/s), att, B (inharm),
       vib:{rate,depth,delay}, bend:[[sec, semis],...] (interpolate เชิงเส้น), trem:{rate,depth}} */
let WOW = null; // ฟังก์ชัน detune(t) ของเพลงที่กำลังเรนเดอร์ (ถ้ามี wow)
function tone(buf, rnd, o) {
  if (WOW) o.cents = (o.cents || 0) + WOW(o.t0);
  const s0 = Math.round(o.t0 * SR);
  if (s0 >= buf.length) return;
  const nSus = Math.max(1, Math.round(o.dur * SR));
  const nRel = Math.max(1, Math.round((o.rel != null ? o.rel : 0.04) * SR));
  const n = Math.min(nSus + nRel, buf.length - s0);
  const f0 = midiHz(o.midi) * Math.pow(2, (o.cents || 0) / 1200);
  const H = o.harm.length, B = o.B || 0;
  const inc = new Float64Array(H), amp = new Float64Array(H), dec = new Float64Array(H), ph = new Float64Array(H);
  const maxFm = o.bend ? Math.pow(2, Math.max(0, ...o.bend.map((p) => p[1])) / 12) : 1.03;
  let Hn = 0;
  for (let h = 1; h <= H; h++) {
    const fh = f0 * h * Math.sqrt(1 + B * h * h);
    if (fh * maxFm > NYQ) break;
    inc[h - 1] = (fh / SR) * TBL;
    amp[h - 1] = o.harm[h - 1] * o.amp;
    dec[h - 1] = Math.exp(-(o.hdec ? o.hdec[h - 1] : 0) / SR);
    ph[h - 1] = rnd() * TBL;
    Hn = h;
  }
  if (!Hn) return;
  const nAtt = Math.max(1, Math.round((o.att || 0.004) * SR));
  const vib = o.vib, bend = o.bend, trem = o.trem;
  const vPh = rnd() * 2 * Math.PI;
  let fm = 1, tr = 1;
  let bi = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) { // control rate
      const t = i / SR;
      let semis = 0;
      if (bend) {
        while (bi + 1 < bend.length && bend[bi + 1][0] <= t) bi++;
        const p = bend[bi], q = bend[bi + 1];
        if (q && t >= p[0]) semis = p[1] + ((q[1] - p[1]) * (t - p[0])) / (q[0] - p[0]);
        else semis = t < p[0] ? bend[0][1] : p[1];
      }
      let cents = semis * 100;
      if (vib && t > vib.delay) cents += vib.depth * Math.min(1, (t - vib.delay) / 0.25) * Math.sin(2 * Math.PI * vib.rate * t + vPh);
      fm = cents ? Math.pow(2, cents / 1200) : 1;
      tr = trem ? 1 - trem.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * trem.rate * t)) : 1;
    }
    let env = i < nAtt ? i / nAtt : 1;
    if (i >= nSus) env *= 1 - (i - nSus) / nRel;
    let v = 0;
    for (let h = 0; h < Hn; h++) {
      let p = ph[h] + inc[h] * fm;
      if (p >= TBL) p -= TBL;
      ph[h] = p;
      v += amp[h] * SIN[p | 0];
      amp[h] *= dec[h];
    }
    buf[s0 + i] += v * env * tr;
  }
}

/* ---------------- กลอง ---------------- */
function kick(buf, rnd, t, a) {
  const s0 = Math.round(t * SR), n = Math.min(Math.round(0.4 * SR), buf.length - s0);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const f = 46 + 95 * Math.exp(-tt / 0.03);
    ph += f / SR;
    const env = Math.exp(-tt / 0.22) * Math.min(1, i / 20);
    buf[s0 + i] += a * (env * Math.sin(2 * Math.PI * ph) + 0.25 * (rnd() * 2 - 1) * Math.exp(-tt / 0.004));
  }
}
function snare(buf, rnd, t, a) {
  const s0 = Math.round(t * SR), n = Math.min(Math.round(0.3 * SR), buf.length - s0);
  let lp = 0, bp = 0; // state-variable bandpass ~2kHz
  const f = 2 * Math.sin((Math.PI * 2000) / SR), q = 0.9;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const w = rnd() * 2 - 1;
    const hp = w - lp - q * bp; bp += f * hp; lp += f * bp;
    buf[s0 + i] += a * (0.8 * (bp + 0.35 * w) * Math.exp(-tt / 0.12) + 0.5 * Math.sin(2 * Math.PI * 185 * tt) * Math.exp(-tt / 0.05));
  }
}
function hat(buf, rnd, t, a, open) {
  const s0 = Math.round(t * SR), n = Math.min(Math.round((open ? 0.3 : 0.08) * SR), buf.length - s0);
  let p1 = 0, p2 = 0;
  const tau = open ? 0.16 : 0.03;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    const h1 = w - p1; p1 = w; const h2 = h1 - p2; p2 = h1; // high-pass 2 ชั้น
    buf[s0 + i] += a * 0.45 * h2 * Math.exp(-(i / SR) / tau);
  }
}
const CHING_F = [2270, 3160, 3890, 4610];
function ching(buf, rnd, t, a) { // ฉิ่ง: partial ไม่ฮาร์มอนิก เสียงค้าง
  const s0 = Math.round(t * SR), n = Math.min(Math.round(0.6 * SR), buf.length - s0);
  const ph = CHING_F.map(() => rnd() * 2 * Math.PI);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    let v = 0;
    for (let k = 0; k < CHING_F.length; k++) v += Math.sin(2 * Math.PI * CHING_F[k] * tt + ph[k]) / (k + 1);
    buf[s0 + i] += a * 0.5 * v * Math.exp(-tt / 0.25) * Math.min(1, i / 8);
  }
}

/* ---------------- effect / filter ---------------- */
function biquad(x, type, fc, Q) {
  const w0 = (2 * Math.PI * fc) / SR, cw = Math.cos(w0), al = Math.sin(w0) / (2 * (Q || 0.707));
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
  else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
}
function reverb(x, rt) { // Schroeder: comb ×4 (มี damping) + allpass ×2 → คืนเฉพาะ wet
  const D = [279, 297, 319, 339], A = [139, 110];
  const out = new Float32Array(x.length);
  for (const d of D) {
    const g = Math.pow(10, (-3 * d) / (rt * SR));
    const line = new Float32Array(d);
    let idx = 0, lp = 0;
    for (let i = 0; i < x.length; i++) {
      const y = line[idx];
      lp = 0.7 * y + 0.3 * lp;
      line[idx] = x[i] + g * lp;
      out[i] += y * 0.25;
      if (++idx >= d) idx = 0;
    }
  }
  for (const d of A) {
    const line = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      const bufv = line[idx];
      const y = -0.5 * out[i] + bufv;
      line[idx] = out[i] + 0.5 * y;
      out[i] = y;
      if (++idx >= d) idx = 0;
    }
  }
  return out;
}
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length || 1)); }
function scaleTo(x, target) { const r = rms(x); if (r > 1e-9) { const g = target / r; for (let i = 0; i < x.length; i++) x[i] *= g; } }

/* ---------------- voicing ---------------- */
function chordPcs(c) { return Array.from(new Set(c.iv.map((i) => mod12(c.root + i)))); }
function bassMidi(pc) { return pc >= 9 ? 24 + pc : 36 + pc; } // A1..B1, C2..G#2

function padVoicing(c, prev) {
  const pcs = c.iv.filter((i) => i < 12).map((i) => mod12(c.root + i));
  if (pcs.length > 3 && prev && prev.length === 3) pcs.splice(2, 1); // ตัดคู่ห้าบางครั้ง (4 เสียง→3)
  let best = null, bestCost = Infinity;
  for (let rot = 0; rot < pcs.length; rot++) {
    for (const base of [52, 55, 57, 60]) {
      const v = [];
      let cur = base - 1;
      for (let k = 0; k < pcs.length; k++) {
        const pc = pcs[(rot + k) % pcs.length];
        let m = cur + 1;
        while (mod12(m) !== pc) m++;
        v.push(m); cur = m;
      }
      if (v[v.length - 1] > 79) continue;
      let cost = 0;
      if (prev) for (let k = 0; k < v.length; k++) cost += Math.abs(v[k] - (prev[Math.min(k, prev.length - 1)]));
      else cost = Math.abs(v[0] - 60);
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
  }
  return best;
}
const OPEN = [40, 45, 50, 55, 59, 64]; // สายเปล่า E A D G B E
function guitarVoicing(c) {
  const pcs = chordPcs(c).concat(c.iv.filter((i) => i >= 12).map((i) => mod12(c.root + i)));
  const bass = c.bass != null ? c.bass : c.root;
  const v = [];
  // สายเบส: หาสายต่ำสุดที่กดโน้ตเบสได้ภายใน 0–7 เฟรต
  let s0 = 0;
  for (; s0 < 3; s0++) { const f = mod12(bass - OPEN[s0]); if (f <= 7) { v.push(OPEN[s0] + f); break; } }
  if (!v.length) { s0 = 0; v.push(bassMidi(bass) + 12); }
  for (let s = s0 + 1; s < 6; s++) {
    let best = null;
    for (let f = 0; f <= 5; f++) { const m = OPEN[s] + f; if (pcs.includes(mod12(m)) && m > v[v.length - 1]) { best = m; break; } }
    if (best != null) v.push(best);
  }
  return v;
}

/* ---------------- จัดโครงเพลง → เหตุการณ์ในหน่วย beat ---------------- */
function buildScore(spec) {
  const chords = []; // {b0,b1,label,sec}
  const secs = [];
  let b = 0;
  spec.sections.forEach((sec, si) => {
    const rep = sec.repeat || 1;
    const b0 = b;
    for (let r = 0; r < rep; r++) {
      sec.bars.forEach((item) => {
        let [label, beats, flags] = item;
        if (sec.transpose && !isNoChord(label)) label = transposeLabel(label, sec.transpose, sec.flat);
        chords.push({ b0: b, b1: b + beats, label: isNoChord(label) ? null : label, push: !!(flags && flags.push), si });
        b += beats;
      });
    }
    secs.push(Object.assign({}, sec, { b0, b1: b, idx: si }));
  });
  // push: คอร์ดมาก่อนจังหวะครึ่ง beat (anticipation) — เลื่อนขอบระหว่างคอร์ด
  for (let i = 1; i < chords.length; i++) {
    if (chords[i].push && chords[i - 1].label && chords[i].label && chords[i - 1].b1 - chords[i - 1].b0 > 1) {
      chords[i - 1].b1 -= 0.5; chords[i].b0 -= 0.5;
    }
  }
  return { chords, secs, totalBeats: b };
}

/* ---------------- เรนเดอร์เพลงทั้งเพลง ---------------- */
function renderSong(spec) {
  const R = (k) => mulberry32((spec.seed || 1) * 7919 + k);
  const rTempo = R(1);
  const { chords, secs, totalBeats } = buildScore(spec);
  const lead = spec.lead != null ? spec.lead : 0.6;
  // tempo map + drift/rubato
  const beatT = new Float64Array(totalBeats + 64);
  const drift = spec.drift || 0, dph = rTempo() * 6.28;
  beatT[0] = lead;
  for (let k = 1; k < beatT.length; k++) {
    const bpmK = spec.bpm * (1 + drift * Math.sin((2 * Math.PI * k) / 48 + dph));
    beatT[k] = beatT[k - 1] + 60 / bpmK;
  }
  const time = (bb) => {
    if (bb <= 0) return lead + (bb * 60) / spec.bpm;
    const i = Math.floor(bb), f = bb - i;
    return beatT[i] + f * (beatT[i + 1] - beatT[i]);
  };
  const endT = time(totalBeats);
  const dur = endT + (spec.tail != null ? spec.tail : 2.0);
  const L = Math.ceil(dur * SR);
  const bus = { drums: new Float32Array(L), bass: new Float32Array(L), harm: new Float32Array(L), vocal: new Float32Array(L) };
  // wow (เทปเก่า/แผ่นเสียง): จูนแกว่งช้า ๆ ทั้งเพลง — ประมาณเป็นค่าคงที่ต่อโน้ต ณ เวลาเริ่มโน้ต
  const wow = spec.wow || null;
  WOW = wow ? (t) => wow.depth * Math.sin((2 * Math.PI * t) / wow.period) : null;
  const detune = spec.detune || 0;
  const style = spec.style || 'pop';
  const hum = (rnd, ms) => gauss(rnd) * (ms || 6) / 1000; // timing มนุษย์
  const secOf = (bb) => { for (const s of secs) if (bb >= s.b0 && bb < s.b1) return s; return secs[secs.length - 1]; };
  const inst = (s, name) => (s[name] != null ? s[name] : (spec.inst || {})[name]);

  /* ----- harmony: pad / guitar / piano ----- */
  const rH = R(2);
  let prevPad = null;
  chords.forEach((ch, ci) => {
    if (!ch.label) return;
    let c = parseChord(ch.label);
    const s = secs[ch.si];
    const t0 = time(ch.b0), t1 = time(ch.b1);
    const vel = 0.9 + 0.2 * rH();
    // color tone: นักดนตรีเติม 9/6/11 ในการเล่นจริง แต่คนแกะคอร์ดยังเขียนแค่ triad (label ไม่เปลี่ยน)
    if (spec.color && rH() < spec.color && c.iv.length === 3) {
      const minor = c.iv[1] === 3;
      const add = minor ? pick(rH, [2, 5]) : pick(rH, [2, 2, 9]);
      c = Object.assign({}, c, { iv: c.iv.concat([add]) });
    }
    if (inst(s, 'pad')) {
      const v = padVoicing(c, prevPad); prevPad = v;
      const harm = [1, 0.45, 0.28, 0.16, 0.1, 0.06, 0.04];
      v.forEach((m) => tone(bus.harm, rH, {
        t0: t0 + hum(rH, 4), dur: t1 - t0, rel: 0.3, midi: m, cents: detune + (rH() - 0.5) * 8,
        amp: 0.16 * vel, harm, att: 0.12, trem: { rate: 4.5 + rH(), depth: 0.1 },
      }));
    }
    const gStyle = inst(s, 'gtr');
    if (gStyle) {
      const v = guitarVoicing(c);
      const pattern = {
        pop: [[0, 'D', 1], [1, 'D', 0.8], [1.5, 'U', 0.6], [2.5, 'U', 0.6], [3, 'D', 0.8], [3.5, 'U', 0.6]],
        folk: [[0, 'D', 1], [1, 'D', 0.8], [1.5, 'U', 0.6], [2, 'D', 0.9], [2.5, 'U', 0.6], [3.5, 'U', 0.6]],
        rock: [[0, 'D', 1], [0.5, 'D', 0.8], [1, 'D', 0.9], [1.5, 'D', 0.8], [2, 'D', 1], [2.5, 'D', 0.8], [3, 'D', 0.9], [3.5, 'D', 0.8]],
        chuck: [[0.5, 'C', 0.9], [1.5, 'C', 0.9], [2.5, 'C', 0.9], [3.5, 'C', 0.9]],
      }[gStyle] || [[0, 'D', 1]];
      const nb = ch.b1 - ch.b0;
      const hits = [];
      // pattern วนทุก 4 beat นับจากต้นห้อง (ไม่ใช่ต้นคอร์ด) — คอร์ดที่ push มาเริ่มตีทันที
      const barStart = Math.floor(ch.b0 / 4) * 4;
      for (let bb = barStart; bb < ch.b1; bb += 4) {
        pattern.forEach(([off, dir, a]) => { const at = bb + off; if (at >= ch.b0 - 1e-6 && at < ch.b1 - 1e-6) hits.push([at, dir, a]); });
      }
      if (!hits.length || hits[0][0] > ch.b0 + 1e-6) hits.unshift([ch.b0, 'D', 0.9]);
      hits.forEach(([at, dir, a], hi) => {
        const nextAt = hi + 1 < hits.length ? hits[hi + 1][0] : ch.b1;
        const tS = time(at) + hum(rH, 7);
        const ringFor = Math.max(0.06, time(nextAt) - time(at));
        let strings = v.map((m, i) => i);
        if (dir === 'U') strings = strings.slice(-4).reverse();
        if (dir === 'C') strings = strings.slice(-4);
        const spread = dir === 'U' ? 0.008 : 0.013;
        strings.forEach((si, k) => {
          const m = v[si];
          const harm = [], hdec = [];
          for (let h = 1; h <= 10; h++) { harm.push(Math.abs(Math.sin(Math.PI * h * 0.19)) / h); hdec.push(1.2 + 0.9 * h); }
          tone(bus.harm, rH, {
            t0: tS + k * spread, dur: dir === 'C' ? 0.07 : ringFor, rel: 0.03, midi: m, cents: detune + (rH() - 0.5) * 6,
            amp: 0.22 * a * vel, harm, hdec, B: 0.00008,
          });
        });
      });
    }
    if (inst(s, 'piano')) {
      const v = padVoicing(c, null);
      const bassN = bassMidi(c.bass != null ? c.bass : c.root) + 12;
      const arp = [bassN, v[0], v[1], v[2] || v[0] + 12, v[1] + 12, v[2] || v[0] + 12, v[1], v[0]];
      const nb = ch.b1 - ch.b0;
      for (let k = 0; k < nb * 2; k++) {
        const at = ch.b0 + k * 0.5;
        const harm = [], hdec = [];
        for (let h = 1; h <= 9; h++) { harm.push(1 / Math.pow(h, 1.3)); hdec.push(0.7 + 0.6 * h); }
        tone(bus.harm, rH, {
          t0: time(at) + hum(rH, 5), dur: Math.max(0.1, time(ch.b1) - time(at)), rel: 0.12,
          midi: arp[k % arp.length], cents: detune, amp: 0.2 * (k % 4 === 0 ? 1 : 0.75) * vel, harm, hdec, B: 0.00035,
        });
      }
    }
  });

  /* ----- riff / counter-melody (โน้ตนอกคอร์ดจากเครื่องดนตรีอื่น) ----- */
  const riff = spec.riff;
  if (riff) {
    const rR = R(7);
    const riffNotes = [];
    const scaleOf = (key) => {
      const km = /^([A-G][#b]?)(m?)$/.exec(key);
      const kpc = PC[km[1]];
      return (km[2] ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((i) => mod12(kpc + i));
    };
    const snap = (m, pcs, dir) => { let x = m; for (let k = 0; k < 12 && !pcs.includes(mod12(x)); k++) x += dir; return x; };
    chords.forEach((ch) => {
      const s = secs[ch.si];
      if (!ch.label || s.riff === false) return;
      const c = parseChord(ch.label);
      const cpcs = chordPcs(c), scale = scaleOf(s.key);
      const base = riff.octave || 72;
      if (riff.type === 'strings') { // เส้นเสียงยาว: suspension 4-3 / 9-8 คร่อมจุดเปลี่ยนคอร์ด
        const nb = ch.b1 - ch.b0;
        const third = mod12(c.root + c.iv[1]);
        const top = base + mod12(third - base); // โน้ตสามของคอร์ดในช่วง [base, base+11]
        if (rR() < 0.5 && nb >= 2) {
          riffNotes.push({ b0: ch.b0, b1: ch.b0 + 1, midi: snap(top + 1, scale, 1) }); // โน้ตค้างจากคอร์ดก่อน (4 หรือ 9)
          riffNotes.push({ b0: ch.b0 + 1, b1: ch.b1, midi: top });
        } else riffNotes.push({ b0: ch.b0, b1: ch.b1, midi: top });
      } else if (riff.type === 'arp') { // synth arp 16th: chord tone + neighbor
        for (let bb = ch.b0; bb < ch.b1 - 1e-6; bb += 0.25) {
          let pc = cpcs[Math.floor(rR() * cpcs.length)];
          let m = base - 12 + mod12(pc - (base - 12));
          if (rR() < 0.2) m = snap(m + 1, scale, 1);
          riffNotes.push({ b0: bb, b1: bb + 0.22, midi: m });
        }
      } else { // 'fills': ไลน์กีตาร์/ขลุ่ยวิ่งสเกล 8th/16th ช่วง 1–2 beat ท้ายคอร์ด
        const len = ch.b1 - ch.b0 >= 4 ? (rR() < 0.5 ? 2 : 1) : 0;
        if (!len || rR() < 0.35) return;
        let m = snap(base + Math.floor(rR() * 8), scale, 1);
        const step = rR() < 0.5 ? 1 : -1;
        const sub = rR() < 0.5 ? 0.25 : 0.5;
        for (let bb = ch.b1 - len; bb < ch.b1 - 1e-6; bb += sub) {
          riffNotes.push({ b0: bb, b1: bb + sub * 0.95, midi: m });
          m = snap(m + step, scale, step);
        }
      }
    });
    const harm = [], hdec = [];
    const odd = riff.type === 'fills'; // ขลุ่ย/แคน/กีตาร์ลีด: ฮาร์มอนิกคี่เด่น
    for (let h = 1; h <= 10; h++) { harm.push((odd && h % 2 === 0 ? 0.35 : 1) / h); hdec.push(riff.type === 'arp' ? 2 + h : 0.3); }
    riffNotes.forEach((n) => tone(bus.harm, rR, {
      t0: time(n.b0) + hum(rR, 5), dur: Math.max(0.05, time(n.b1) - time(n.b0)), rel: riff.type === 'strings' ? 0.2 : 0.03,
      midi: n.midi, cents: detune + (rR() - 0.5) * 10, amp: 0.2 * (riff.level || 0.5), harm, hdec,
      att: riff.type === 'strings' ? 0.15 : 0.01, vib: riff.type === 'strings' ? { rate: 5.5, depth: 12, delay: 0.3 } : null,
    }));
  }

  /* ----- bass ----- */
  const rB = R(3);
  const bassNotes = []; // {b0,b1,midi}
  chords.forEach((ch, ci) => {
    const s = secs[ch.si];
    const bStyle = inst(s, 'bass');
    if (!ch.label || !bStyle) return;
    const c = parseChord(ch.label);
    const root = bassMidi(c.bass != null ? c.bass : c.root);
    const fifth = root + 7 > 47 ? root - 5 : root + 7;
    const next = chords[ci + 1] && chords[ci + 1].label ? parseChord(chords[ci + 1].label) : null;
    const nextRoot = next ? bassMidi(next.bass != null ? next.bass : next.root) : null;
    const pcs = chordPcs(c);
    const nb = ch.b1 - ch.b0;
    const push = (b0, b1, midi) => bassNotes.push({ b0, b1, midi });
    if (bStyle === 'eighths') {
      for (let k = 0; k < nb * 2; k++) push(ch.b0 + k / 2, ch.b0 + (k + 1) / 2 - 0.05, (k % 8 === 7 && rB() < 0.3) ? root + 12 : root);
    } else if (bStyle === 'ballad') {
      push(ch.b0, ch.b0 + Math.min(nb, 2), root);
      if (nb >= 3) push(ch.b0 + 2, ch.b1 - (nb >= 4 ? 1 : 0), fifth);
      if (nb >= 4) push(ch.b1 - 1, ch.b1, root);
    } else if (bStyle === 'oompah') { // ลูกทุ่ง: root–ห้า สลับ
      for (let k = 0; k < nb; k++) push(ch.b0 + k, ch.b0 + k + 0.85, k % 2 === 0 ? root : fifth);
    } else if (bStyle === 'walk') { // walking quarter: chord tone + โน้ตผ่าน
      for (let k = 0; k < nb; k++) {
        let m;
        if (k === 0) m = root;
        else if (k === nb - 1 && nextRoot != null) m = nextRoot + (rB() < 0.5 ? 1 : -1); // chromatic approach
        else { const pc = pick(rB, pcs); m = 36 + mod12(pc - 0); if (m > 47) m -= 12; }
        push(ch.b0 + k, ch.b0 + k + 0.9, m);
      }
    } else { // 'pop': root ยาว + syncopation + approach note ก่อนเปลี่ยนคอร์ด
      push(ch.b0, ch.b0 + 1.5, root);
      if (nb > 2) push(ch.b0 + 1.5, ch.b0 + Math.min(nb, 3), rB() < 0.3 ? fifth : root);
      if (nb > 3) push(ch.b0 + 3, ch.b1 - 0.5, root);
      if (nb > 3) {
        let m = root;
        if (nextRoot != null && rB() < 0.6) m = nextRoot + (nextRoot > root ? -2 : 2) * (rB() < 0.5 ? 1 : 0.5);
        push(ch.b1 - 0.5, ch.b1 - 0.02, Math.round(m));
      } else if (nb > 1.5) push(ch.b1 - 0.5, ch.b1 - 0.02, root);
    }
  });
  const sub = spec.subBass;
  bassNotes.forEach((bn) => {
    const harm = sub ? [1, 0.2, 0.05] : [1, 0.6, 0.4, 0.25, 0.16, 0.1, 0.06];
    const hdec = sub ? [0.3, 0.5, 0.8] : [0.6, 1.2, 1.8, 2.4, 3, 3.6, 4.2];
    tone(bus.bass, rB, {
      t0: time(bn.b0) + hum(rB, 5), dur: Math.max(0.05, time(bn.b1) - time(bn.b0)), rel: 0.04,
      midi: bn.midi, cents: detune + (rB() - 0.5) * 6, amp: 0.5 * (0.85 + 0.3 * rB()), harm, hdec, att: 0.006,
    });
  });

  /* ----- drums ----- */
  const rD = R(4);
  for (let bb = 0; bb < totalBeats; bb++) {
    const s = secOf(bb);
    const mode = s.drums || 'none';
    if (mode === 'none') continue;
    const beatInBar = bb % 4;
    const fillBar = s.b1 - bb <= 4 && s.fill !== false && mode === 'full';
    const tb = (x) => time(bb + x) + hum(rD, 3);
    const A = mode === 'light' ? 0.5 : 1;
    const ds = s.drumStyle || spec.drumStyle || 'pop';
    if (ds === 'pop' || ds === 'rock') {
      if (beatInBar === 0 || beatInBar === 2 || (ds === 'rock' && rD() < 0.3)) kick(bus.drums, rD, tb(0), A);
      if (beatInBar === 2 && rD() < 0.4) kick(bus.drums, rD, tb(0.5), A * 0.7);
      if (beatInBar === 1 || beatInBar === 3) snare(bus.drums, rD, tb(0), A * 0.9);
      hat(bus.drums, rD, tb(0), A * 0.6, false); hat(bus.drums, rD, tb(0.5), A * 0.45, ds === 'rock' && beatInBar === 3);
      if (fillBar && beatInBar >= 2) for (let k = 1; k < 4; k++) snare(bus.drums, rD, tb(k / 4), A * 0.5);
    } else if (ds === 'ballad') {
      if (beatInBar === 0) kick(bus.drums, rD, tb(0), A * 0.8);
      if (beatInBar === 2) snare(bus.drums, rD, tb(0), A * 0.6);
      hat(bus.drums, rD, tb(0), A * 0.35, false); hat(bus.drums, rD, tb(0.5), A * 0.25, false);
    } else if (ds === 'lukthung') { // สองจังหวะ: kick ทุก beat, snare ยก, ฉิ่งจังหวะยก
      kick(bus.drums, rD, tb(0), A * 0.9);
      snare(bus.drums, rD, tb(0.5), A * 0.55);
      ching(bus.drums, rD, tb(0.5), A * 0.5);
      if (beatInBar === 3) hat(bus.drums, rD, tb(0.75), A * 0.4, false);
    } else if (ds === 'edm') {
      kick(bus.drums, rD, tb(0), A * 1.1);
      if (beatInBar === 1 || beatInBar === 3) snare(bus.drums, rD, tb(0), A * 0.7);
      for (let k = 0; k < 4; k++) hat(bus.drums, rD, tb(k / 4), A * (k === 2 ? 0.5 : 0.25), k === 2);
    } else if (ds === 'shuffle') {
      if (beatInBar === 0 || beatInBar === 2) kick(bus.drums, rD, tb(0), A);
      if (beatInBar === 1 || beatInBar === 3) snare(bus.drums, rD, tb(0), A * 0.85);
      hat(bus.drums, rD, tb(0), A * 0.5, false); hat(bus.drums, rD, tb(2 / 3), A * 0.4, false);
    }
  }

  /* ----- เสียงร้อง ----- */
  const rV = R(5);
  const VOWELS = [
    [[730, 90, 1], [1090, 110, 0.5], [2440, 160, 0.3]],
    [[530, 60, 1], [1840, 150, 0.45], [2480, 200, 0.3]],
    [[300, 60, 1], [2290, 200, 0.35], [3010, 250, 0.25]],
    [[570, 80, 1], [840, 100, 0.6], [2410, 160, 0.25]],
    [[320, 60, 1], [870, 100, 0.45], [2240, 150, 0.2]],
  ];
  const formant = (f, vw) => { let g = 0.06; for (const [F, Bw, a] of vw) g += a / (1 + Math.pow((f - F) / Bw, 2)); return g; };
  const vox = spec.vocal || {};
  const vLo = vox.lo || 57, vHi = vox.hi || 76;
  const chordAtBeat = (bb) => { for (const c of chords) if (bb >= c.b0 && bb < c.b1) return c; return null; };
  let prevMidi = null;
  for (let bb = 0; bb < totalBeats;) {
    const s = secOf(bb);
    if (!s.vocal) { bb = s.b1; prevMidi = null; continue; }
    // วลีละ 2 ห้อง: ร้อง ~5–7 beat แล้วพัก
    const phraseEnd = Math.min(s.b1, bb + 8);
    const singTo = phraseEnd - (1 + Math.floor(rV() * 2));
    const key = s.key;
    const km = /^([A-G][#b]?)(m?)$/.exec(key);
    const kpc = PC[km[1]], minor = !!km[2];
    const scale = (minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((i) => mod12(kpc + i));
    let t = bb + (rV() < 0.4 ? 0.5 : 0);
    const rhythm = vox.rhythm || [0.5, 0.5, 1, 0.5, 0.5, 1, 1.5, 0.5, 2];
    let pendingResolve = null;
    while (t < singTo - 0.2) {
      let d = pick(rV, rhythm);
      if (t + d > singTo) d = singTo - t;
      if (d < 0.25) break;
      const ch = chordAtBeat(t);
      if (!ch || !ch.label) { t += d; continue; }
      const c = parseChord(ch.label);
      const cpcs = chordPcs(c);
      const strong = Math.abs(t - Math.round(t)) < 1e-6 && Math.round(t) % 2 === 0;
      const lastOfPhrase = t + d >= singTo - 0.01;
      let pool;
      if (pendingResolve != null) pool = [pendingResolve];
      else if (lastOfPhrase) pool = rV() < 0.25 ? [mod12(c.root + 2)] : cpcs; // จบวลีด้วย 9th บ้าง (ป๊อปไทยชอบ)
      else if (strong) pool = rV() < 0.68 ? cpcs : scale.filter((p) => !cpcs.includes(p));
      else pool = rV() < 0.5 ? scale : cpcs;
      pendingResolve = null;
      // เลือกโน้ตในช่วงเสียง ใกล้โน้ตก่อนหน้า (ขั้นคู่เล็กมีโอกาสมากกว่า)
      const ref = prevMidi != null ? prevMidi : (vLo + vHi) / 2;
      const cands = [];
      for (let m = vLo; m <= vHi; m++) if (pool.includes(mod12(m))) cands.push(m);
      if (!cands.length) { t += d; continue; }
      const ws = cands.map((m) => Math.exp(-Math.abs(m - ref) / 2.5));
      let r = rV() * ws.reduce((a, b) => a + b, 0), midi = cands[0];
      for (let i = 0; i < cands.length; i++) { r -= ws[i]; if (r <= 0) { midi = cands[i]; break; } }
      if (strong && !cpcs.includes(mod12(midi))) {
        // appoggiatura → โน้ตถัดไปคลายลงขั้นเดียวหาโน้ตในคอร์ด
        const down = cpcs.map((p) => mod12(midi - p)).filter((x) => x > 0 && x <= 2);
        if (down.length) pendingResolve = mod12(midi - Math.min(...down));
      }
      if (!lastOfPhrase && rV() < 0.05) midi += rV() < 0.5 ? 1 : -1; // โครมาติก
      const secT0 = time(t) + hum(rV, 12), secT1 = time(t + d);
      const vw = pick(rV, VOWELS);
      const f0 = midiHz(midi);
      const harm = [];
      for (let h = 1; h <= 16; h++) harm.push(formant(f0 * h, vw) / Math.pow(h, 0.6));
      const bend = [];
      if (prevMidi != null && Math.abs(prevMidi - midi) <= 7) { bend.push([0, prevMidi - midi], [0.06, 0]); }
      if (vox.ornament && d >= 1 && rV() < 0.5) { // ลูกคอ
        const s0 = bend.length ? 0.07 : 0;
        bend.push([s0, 0], [s0 + 0.05, 2], [s0 + 0.1, 0], [s0 + 0.16, -1], [s0 + 0.22, 0]);
      }
      const vAmp = 0.5 * (0.8 + 0.4 * rV());
      tone(bus.vocal, rV, {
        t0: secT0, dur: Math.max(0.08, secT1 - secT0 - 0.03), rel: 0.06, midi, cents: detune + (rV() - 0.5) * 16,
        amp: vAmp, harm, att: 0.03,
        vib: { rate: 5 + rV() * 1.5, depth: vox.vibrato || 30, delay: 0.2 },
        bend: bend.length ? bend : null,
      });
      if (s.harmony) { // เสียงประสาน: ขั้นคู่สามในสเกลต่ำกว่าทำนอง
        let hm = midi - 3;
        while (!scale.includes(mod12(hm)) && hm > midi - 5) hm--;
        const harm2 = [];
        for (let h = 1; h <= 16; h++) harm2.push(formant(midiHz(hm) * h, vw) / Math.pow(h, 0.6));
        tone(bus.vocal, rV, {
          t0: secT0 + 0.015, dur: Math.max(0.08, secT1 - secT0 - 0.03), rel: 0.06, midi: hm, cents: detune + (rV() - 0.5) * 16,
          amp: vAmp * 0.55, harm: harm2, att: 0.04, vib: { rate: 5.5 + rV(), depth: vox.vibrato || 30, delay: 0.25 },
        });
      }
      prevMidi = midi;
      t += d;
    }
    bb = phraseEnd;
  }

  /* ----- mix ----- */
  const mix = Object.assign({ drums: 0.8, bass: 0.7, harm: 1, vocal: 1.25, reverb: 0.25, rt: 1.6, lp: 4800, hp: 0, drive: 1.5, hiss: 0.002 }, spec.mix || {});
  scaleTo(bus.harm, 0.1);
  scaleTo(bus.bass, 0.1);
  scaleTo(bus.drums, 0.1);
  scaleTo(bus.vocal, 0.1);
  const out = new Float32Array(L);
  const send = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    out[i] = bus.harm[i] * mix.harm + bus.bass[i] * mix.bass + bus.drums[i] * mix.drums + bus.vocal[i] * mix.vocal;
    send[i] = bus.harm[i] * mix.harm + bus.vocal[i] * mix.vocal + 0.3 * bus.bass[i] * mix.bass;
  }
  if (spec.sidechain) { // EDM pumping: เครื่องดนตรีอื่นหลบ kick ทุก beat
    for (let bb = 0; bb < totalBeats; bb++) {
      const s0 = Math.round(time(bb) * SR), s1 = Math.min(L, Math.round(time(bb + 1) * SR));
      for (let i = s0; i < s1; i++) {
        const g = 1 - 0.55 * Math.exp(-((i - s0) / SR) / 0.12);
        out[i] -= (1 - g) * (bus.harm[i] * mix.harm + bus.bass[i] * mix.bass);
      }
    }
  }
  if (mix.reverb > 0) { const wet = reverb(send, mix.rt); for (let i = 0; i < L; i++) out[i] += wet[i] * mix.reverb; }
  // ความดังตามท่อน (ต่อเนื่อง ไม่กระโดด) + fade in/out
  const gain = new Float32Array(L);
  secs.forEach((s) => {
    const a = Math.round(time(s.b0) * SR), b = Math.min(L, Math.round(time(s.b1) * SR));
    for (let i = a; i < b; i++) gain[i] = s.dyn != null ? s.dyn : 0.85;
  });
  const lastG = secs.length ? (secs[secs.length - 1].dyn || 0.85) : 1;
  for (let i = Math.round(endT * SR); i < L; i++) gain[i] = lastG;
  for (let i = 0; i < Math.round(lead * SR); i++) gain[i] = secs[0].dyn || 0.85;
  let g = gain[0];
  const sm = Math.exp(-1 / (0.4 * SR));
  for (let i = 0; i < L; i++) { g = sm * g + (1 - sm) * gain[i]; out[i] *= g; }
  if (spec.fadeOut) {
    const n = Math.round(spec.fadeOut * SR), s0 = Math.max(0, Math.round(endT * SR) - n);
    for (let i = s0; i < L; i++) out[i] *= Math.max(0, 1 - (i - s0) / n);
  }
  // master: saturation → filter → hiss → normalize
  scaleTo(out, 0.18);
  const drv = mix.drive, nd = Math.tanh(drv);
  for (let i = 0; i < L; i++) out[i] = Math.tanh(drv * out[i]) / nd;
  if (mix.hp > 0) { biquad(out, 'hp', mix.hp, 0.707); biquad(out, 'hp', mix.hp, 0.707); }
  if (mix.lp > 0 && mix.lp < SR / 2) { biquad(out, 'lp', mix.lp, 0.707); biquad(out, 'lp', mix.lp, 0.707); }
  const rN = R(6);
  for (let i = 0; i < L; i++) out[i] += (rN() * 2 - 1) * mix.hiss;
  let mx = 0;
  for (let i = 0; i < L; i++) mx = Math.max(mx, Math.abs(out[i]));
  const outGain = (spec.level || 0.9) / (mx || 1);
  for (let i = 0; i < L; i++) out[i] *= outGain;

  /* ----- ground truth ----- */
  const truth = [];
  const pushSeg = (t0, t1, label) => {
    if (t1 <= t0 + 1e-6) return;
    const last = truth[truth.length - 1];
    if (last && last.label === label && Math.abs(last.t1 - t0) < 1e-6) last.t1 = t1;
    else truth.push({ t0, t1, label });
  };
  pushSeg(0, time(chords[0].b0), null);
  chords.forEach((c) => pushSeg(time(c.b0), time(c.b1), c.label));
  pushSeg(endT, dur, null);
  WOW = null;
  const keys = secs.map((s) => ({ t0: time(s.b0), t1: time(s.b1), key: s.key }));
  const beats = [], downbeats = [];
  for (let k = 0; k <= totalBeats; k++) { beats.push(beatT[k]); if (k % 4 === 0) downbeats.push(beatT[k]); }
  return { x: out, sr: SR, truth, keys, beats, downbeats, bpm: spec.bpm, duration: dur };
}

module.exports = { SR, renderSong, mulberry32 };
