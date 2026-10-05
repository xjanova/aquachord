#!/usr/bin/env node
/* test-tracks.cjs — เทสต์เอนจินแกะไลน์เพลงหลายเครื่องดนตรี (site/assets/js/tracks.js) + hook ใน analyze.js
   เพลงสังเคราะห์จาก tools/synth-song.cjs (กลอง/เบส/pad คอร์ด/ลีด 100 BPM ~31 วินาที รู้โน้ตเฉลยทุกตัว)

   สิ่งที่ "ไม่ได้" เทสต์ใน Node (ไม่มี onnxruntime-node ใน CI):
   - โมเดล Basic Pitch จริง → แทนด้วย ORACLE STUB: หาตำแหน่งหน้าต่างจาก "เนื้อเสียง" เอง (ไม่เชื่อสูตรของเรา)
     แล้วสร้าง posteriorgram จากโน้ตเฉลย (+ นอยส์ + ฮาร์มอนิกหลอกออกเทฟของเบส) → เทสต์ท่อทั้งเส้น:
     หน้าต่าง/ต่อเฟรม/เวลา, note creation, แยกบทบาท bass/melody/harmony, quantize — ยกเว้นตัวโมเดล
   - โมเดล Demucs จริง → STUB คืน stem จริงของเพลงสังเคราะห์ตามตำแหน่งหน้าต่าง → เทสต์ overlap-add/resample/present
   คุณภาพของโมเดลจริงวัดใน Chrome: node tools/e2e-tracks.mjs

   เทสต์จริง (ไม่มี stub): HPSS, ตรวจกลอง (NMF), resample, quantize, แก้กราฟ iSTFT (โครงสร้าง protobuf),
   สัญญา TrackSet v1, hook ใน analyze.js (stages/PCT/fallback/ยกเลิก/คืนหน่วยความจำ)
   ใช้: node tools/test-tracks.cjs   (exit 1 เมื่อไม่ผ่านเกณฑ์) */
'use strict';
const path = require('path'), fs = require('fs'), vm = require('vm');
const root = path.join(__dirname, '..');
const DSP = require(path.join(root, 'site/assets/js/dsp.js'));
const Riff = require(path.join(root, 'site/assets/js/riff.js'));
const T = require(path.join(root, 'site/assets/js/tracks.js'));
const { synthSong, evalNotes, mulberry32 } = require('./synth-song.cjs');

const problems = [];
const check = (c, m) => { if (!c) problems.push(m); };
const pct = (x) => (x * 100).toFixed(1) + '%';
const fmt = (e) => `F1 ${pct(e.F1).padStart(6)} · P ${pct(e.P).padStart(6)} · R ${pct(e.R).padStart(6)} (${e.tp}/${e.nRef}, ${e.nEst} est, Δt ${(e.meanDt * 1000).toFixed(0)}ms)`;
const SR = 22050;

/* ---------------- ORACLE Basic Pitch ---------------- */
// หา offset ของหน้าต่างใน xp (สัญญาณเติมศูนย์ 3840 ด้านหน้า) จากเนื้อเสียงจริง แล้วสร้าง posteriorgram จากเฉลย
function oracleBP(x, notes, seed) {
  const NS = T.BP.NS, PADS = T.BP.PAD, HOP = T.BP.HOP, NF = T.BP.NFR, NP = T.BP.NP;
  const len = x.length;
  const rnd = mulberry32(seed || 5);
  const xs = (i) => { const k = i - PADS; return k >= 0 && k < len ? x[k] : 0; };
  // ดัชนีค้นเร็ว: ค่าตัวอย่าง → ตำแหน่ง (เฉพาะค่าที่ไม่ใช่ศูนย์)
  const byVal = new Map();
  for (let i = 0; i < len; i++) { const v = x[i]; if (Math.abs(v) > 1e-4) { const a = byVal.get(v); if (a) a.push(i + PADS); else byVal.set(v, [i + PADS]); } }
  const ghosts = notes.filter((n) => n.midi < 48 && rnd() < 0.35).map((n) => ({ t: n.t, d: n.d * 0.9, midi: n.midi + 12, amp: 0.45 }));
  const all = notes.map((n) => Object.assign({ amp: 0.8 }, n)).concat(ghosts);
  let calls = 0;
  const fn = async (inp, B) => {
    calls++;
    const note = new Float32Array(B * NF * NP), onset = new Float32Array(B * NF * NP);
    for (let bi = 0; bi < B; bi++) {
      const w0 = bi * NS;
      let k0 = -1;
      for (let i = 0; i < NS; i++) if (Math.abs(inp[w0 + i]) > 1e-4) { k0 = i; break; }
      if (k0 < 0) continue;
      const cands = byVal.get(inp[w0 + k0]) || [];
      let off = -1;
      for (const pos of cands) {
        const o = pos - k0;
        let ok = true;
        for (let i = 0; i < 64 && k0 + i < NS; i++) if (xs(o + k0 + i) !== inp[w0 + k0 + i]) { ok = false; break; }
        if (ok) { off = o; break; }
      }
      if (off < 0) throw new Error('oracle: หาตำแหน่งหน้าต่างไม่เจอ');
      fn.offsets.push(off);
      for (let j = 0; j < NF; j++) {
        const t = (off + j * HOP - PADS) / SR;
        const base = (bi * NF + j) * NP;
        for (const n of all) {
          if (t < n.t - 0.03 || t > n.t + n.d) continue;
          const p = n.midi - 21;
          if (p < 0 || p >= NP) continue;
          if (t >= n.t) note[base + p] = Math.max(note[base + p], n.amp + (rnd() - 0.5) * 0.1);
          const dj = Math.abs(t - n.t) / (HOP / SR);
          if (dj < 0.5) onset[base + p] = Math.max(onset[base + p], 0.9);
          else if (dj < 1.5) onset[base + p] = Math.max(onset[base + p], 0.45);
        }
      }
    }
    return { note, onset };
  };
  fn.offsets = [];
  fn.calls = () => calls;
  return fn;
}

/* ---------------- สัญญา TrackSet v1 ---------------- */
const IDS = ['drums', 'bass', 'melody', 'vocals', 'guitar', 'piano', 'harmony', 'other'];
function checkTrackSet(ts, label, source) {
  const t = (c, m) => check(c, `TrackSet(${label}): ${m}`);
  t(ts && ts.v === 1, 'v ต้องเป็น 1');
  t(ts.source === source, `source ต้องเป็น ${source} ได้ ${ts.source}`);
  t(ts.bpm === null || (typeof ts.bpm === 'number' && ts.bpm > 0), 'bpm ต้องเป็นตัวเลข > 0 หรือ null');
  t(ts.phase === null || (typeof ts.phase === 'number' && ts.phase >= 0), 'phase ต้องเป็นตัวเลข ≥ 0 หรือ null');
  t(typeof ts.duration === 'number' && ts.duration > 0, 'duration');
  t(Array.isArray(ts.tracks) && ts.tracks.length > 0, 'ต้องมีแทร็ก');
  const keys = Object.keys(ts).filter((k) => ts[k] !== undefined).sort().join(',');
  t(keys === 'bpm,duration,phase,source,tracks,v', 'field ต้องตรงสัญญา ได้ ' + keys);
  const seen = new Set();
  (ts.tracks || []).forEach((tr) => {
    t(IDS.indexOf(tr.id) >= 0, 'id แปลก ' + tr.id);
    t(!seen.has(tr.id), 'id ซ้ำ ' + tr.id); seen.add(tr.id);
    t(tr.kind === (tr.id === 'drums' ? 'drums' : 'pitched'), 'kind ของ ' + tr.id);
    t(Number.isInteger(tr.program) && tr.program >= 0 && tr.program <= 127, 'program ของ ' + tr.id);
    t(Object.keys(tr).sort().join(',') === 'id,kind,notes,program', 'field ของแทร็ก ' + tr.id);
    t(tr.notes.length > 0, 'แทร็กว่างต้องถูกตัด: ' + tr.id);
    let prev = -1, ok = true, mono = true;
    tr.notes.forEach((n, i) => {
      if (!(isFinite(n.t) && n.t >= 0 && isFinite(n.d) && n.d > 0 && Number.isInteger(n.midi) && n.midi >= 0 && n.midi <= 127 && n.vel >= 0 && n.vel <= 1)) ok = false;
      if (Object.keys(n).sort().join(',') !== 'd,midi,t,vel') ok = false;
      if (n.t < prev) ok = false;
      prev = n.t;
      const nx = tr.notes[i + 1];
      if (nx && n.t + n.d > nx.t + 1e-3) mono = false;
    });
    t(ok, 'โน้ตต้องมีแค่ t,d,midi,vel ในช่วงที่ถูก และเรียงตาม t: ' + tr.id);
    if (tr.id === 'bass' || tr.id === 'melody' || tr.id === 'vocals') t(mono, 'แทร็กเส้นเดียวต้องไม่ทับกัน: ' + tr.id);
    if (tr.id === 'drums') t(tr.notes.every((n) => [36, 38, 42, 46, 49, 45, 47, 50].indexOf(n.midi) >= 0), 'กลองต้องใช้คีย์ GM');
  });
}

/* ---------------- 1) HPSS + กลอง ---------------- */
async function testHpssDrums(s, x) {
  console.log('\n=== HPSS + กลอง (ไม่มี stub) ===');
  const part = (p) => T.decimate(T.mixdown([p.L, p.R]), 2);
  const en = (a) => a.reduce((q, v) => q + v * v, 0);
  const ratio = {};
  for (const k of ['drums', 'bass', 'pads', 'lead']) {
    const px = part(s.parts[k]);
    const h = await T.hpss(px, SR, {});
    ratio[k] = en(h.harmonic) / en(px);
  }
  console.log('สัดส่วนพลังงานที่ไปอยู่ฝั่ง harmonic: ' + Object.entries(ratio).map(([k, v]) => `${k} ${pct(v)}`).join(' · '));
  check(ratio.bass > 0.85 && ratio.pads > 0.8 && ratio.lead > 0.9, 'HPSS: เครื่องดนตรีมีโน้ตต้องอยู่ฝั่ง harmonic ≥ 80–90%');
  check(ratio.drums < 0.75, `HPSS: กลองต้องไปฝั่ง harmonic < 75% (ได้ ${pct(ratio.drums)} — kick มีเนื้อเสียงต่ำค้าง)`);
  // ทำซ้ำได้: harmonic + percussive ≈ ขาเข้า (soft mask รวมกันเป็น 1)
  const t0 = Date.now();
  const hp = await T.hpss(x, SR, {});
  const msHpss = Date.now() - t0;
  const dr = await T.detectDrums(hp, {});
  const drStem = await T.drumsFromSignal(part(s.parts.drums), SR, { blend: 0 });
  const rows = [];
  for (const [label, est] of [['มิกซ์ (lite, HPSS)', dr], ['stem กลองล้วน (full)', drStem]]) {
    const all = evalNotes(est, s.truth.drums);
    console.log(`${label.padEnd(22)} ทุกคีย์ ${fmt(all)}`);
    for (const k of [36, 38, 42]) {
      const e = evalNotes(est.filter((n) => n.midi === k), s.truth.drums.filter((n) => n.midi === k));
      console.log(`${''.padEnd(22)} คีย์ ${k}  ${fmt(e)}`);
      rows.push([label, k, e]);
    }
    rows.push([label, 'all', all]);
  }
  const g = (label, k) => rows.find((r) => r[0] === label && r[1] === k)[2];
  check(g('stem กลองล้วน (full)', 'all').F1 >= 0.85, 'กลองจาก stem: F1 รวม ≥ 85%');
  check(g('stem กลองล้วน (full)', 36).F1 >= 0.9 && g('stem กลองล้วน (full)', 38).F1 >= 0.85 && g('stem กลองล้วน (full)', 42).F1 >= 0.8, 'กลองจาก stem: kick ≥ 90%, snare ≥ 85%, hat ≥ 80%');
  check(g('มิกซ์ (lite, HPSS)', 'all').F1 >= 0.62, 'กลองจากมิกซ์ (lite): F1 รวม ≥ 62%');
  check(Math.abs(g('stem กลองล้วน (full)', 'all').meanDt) < 0.012, 'กลอง: onset เฉลี่ยคลาด < 12ms');
  console.log(`HPSS ${msHpss}ms สำหรับเสียง ${(x.length / SR).toFixed(1)}s`);
  return hp;
}

/* ---------------- 2) note creation (Basic Pitch post-processing) ---------------- */
function testBpNotes() {
  console.log('\n=== Basic Pitch note creation (posteriorgram สังเคราะห์) ===');
  const F = 600, NP = 88;
  const note = new Float32Array(F * NP), onset = new Float32Array(F * NP);
  const put = (p, s, e, amp, on) => {
    for (let f = s; f < e; f++) note[f * NP + p] = amp;
    if (on) { onset[s * NP + p] = on; if (s > 0) onset[(s - 1) * NP + p] = on * 0.4; onset[(s + 1) * NP + p] = on * 0.4; }
  };
  put(40, 10, 60, 0.8, 0.9);            // ปกติ
  put(40, 60, 100, 0.8, 0.52);          // แตกโน้ตหลอก (onset อ่อน ต่อกันสนิท) → ต้องรวมกับตัวก่อน
  put(50, 120, 124, 0.8, 0.9);          // สั้นเกิน (4 เฟรม ≤ minNoteLen 5) → ทิ้ง
  put(55, 200, 260, 0.8, 0.95);         // ดีดซ้ำจริง (onset แรง) …
  put(55, 260, 300, 0.8, 0.95);         // … ต้องเป็น 2 โน้ต
  put(60, 320, 420, 0.7, 0);            // ไม่มี onset แต่ค่อย ๆ ดังขึ้น (ไม่มี inferred onset) ค้างยาวชัด → melodia เก็บ
  for (let f = 320; f < 335; f++) note[f * NP + 60] = 0.05 * (f - 319);
  put(62, 450, 462, 0.4, 0);            // ไม่มี onset สั้นและเบา → melodia ไม่เก็บ
  put(70, 500, 540, 0.8, 0.9);
  // ช่องเบา 5 เฟรม (< energyTol 11) แล้วค่อย ๆ กลับมา (ไม่มี onset ใหม่) → ต้องไม่ตัดโน้ต
  for (let f = 515; f < 520; f++) note[f * NP + 70] = 0.2;
  for (let f = 520; f < 526; f++) note[f * NP + 70] = 0.3 + 0.08 * (f - 520);
  const ns = T.bpNotes({ note, onset, F }, {});
  const at = (p, f) => ns.find((n) => n.midi === p + 21 && Math.abs(n.t - T.bpFrameTime(f)) < 0.002);
  check(at(40, 10) && Math.abs(at(40, 10).d - (T.bpFrameTime(100) - T.bpFrameTime(10))) < 0.003 && !at(40, 60), 'note creation: onset อ่อนที่ต่อกันสนิทต้องรวมเป็นโน้ตเดียว');
  check(!ns.some((n) => n.midi === 71), 'note creation: โน้ตสั้นกว่า minNoteLen ต้องถูกทิ้ง');
  check(at(55, 200) && at(55, 260), 'note creation: ดีดซ้ำจริง (onset แรง) ต้องเป็น 2 โน้ต');
  check(ns.some((n) => n.midi === 81 && n.noOnset) && !ns.some((n) => n.midi === 83), 'melodia: เก็บเฉพาะเสียงค้างยาว/ชัด');
  const n70 = at(70, 500);
  check(n70 && n70.d > T.bpFrameTime(539) - T.bpFrameTime(500) - 0.003, 'energy tolerance: ช่องเบาสั้นกลางโน้ตต้องไม่ตัดโน้ต');
  // เวลาเฟรม: ต่อเนื่องข้ามหน้าต่าง (เพิ่มทีละ 256/22050 ภายในหน้าต่าง, ชดเชยที่รอยต่อ)
  let okT = true;
  for (let f = 1; f < 2000; f++) {
    const d = T.bpFrameTime(f) - T.bpFrameTime(f - 1);
    const expect = f % T.BP.KEEP === 0 ? (T.BP.WHOP - (T.BP.KEEP - 1) * T.BP.HOP) / SR : T.BP.HOP / SR;
    if (Math.abs(d - expect) > 1e-9) okT = false;
  }
  check(okT && T.bpFrameTime(0) === 0, 'bpFrameTime: เวลาเฟรมต้องตรงตำแหน่งหน้าต่างจริง');
  console.log(`โน้ตที่ได้ ${ns.length}: ` + ns.map((n) => `${n.midi}@${n.t.toFixed(3)}/${n.d.toFixed(3)}${n.noOnset ? '*' : ''}`).join(' '));
}

/* ---------------- 3) quantize ---------------- */
function testQuantize() {
  console.log('\n=== quantize เข้ากริด 16th ===');
  const rnd = mulberry32(3);
  const bpm = 100, step = 0.15, ph = 0.37;
  const mk = (jit, extra) => {
    const notes = [];
    for (let k = 0; k < 160; k++) if (k % 3 !== 1) notes.push({ t: ph + k * step + (rnd() - 0.5) * jit, d: 0.11, midi: 60 + (k % 7), vel: 0.8 });
    return notes.concat(extra || []);
  };
  // 1) jitter ±20ms → snap ตรงกริด, ความยาว = เวลาจบจริง
  const a = { id: 'melody', kind: 'pitched', mono: true, notes: mk(0.04) };
  const ends = a.notes.map((n) => n.t + n.d);
  const q = T.quantizeTracks([a], bpm, ph);
  // ลงกริดที่ประมาณจาก onset เอง (phase/BPM เฉพาะที่) → ห่างกริดจริง ≤ 5ms (เดิมกระจาย ±20ms)
  const offGrid = a.notes.filter((n) => Math.abs(((n.t - ph) / step) - Math.round((n.t - ph) / step)) * step > 0.005).length;
  check(q.applied && q.snapped === q.total && offGrid === 0, `quantize: onset ที่คลาด ±20ms ต้องลงกริด (ห่างกริดจริง > 5ms เหลือ ${offGrid})`);
  check(a.notes.every((n, i) => Math.abs(n.t + n.d - ends[i]) < 2e-3), 'quantize: เวลาจบโน้ตต้องคงของจริง (ไม่ยืด/หดเสียง)');
  check(Math.abs(q.bpm - bpm) < 0.2, 'quantize: BPM ที่ปรับละเอียดต้องใกล้ของจริง ได้ ' + q.bpm);
  // 2) triplet/สวิงที่ห่างกริดครึ่งช่อง ต้องไม่ถูกบิด
  const trip = [];
  for (let k = 0; k < 6; k++) trip.push({ t: ph + 40 * step + k * (step * 4 / 3) + 0.001, d: 0.08, midi: 72, vel: 0.9 });
  const b = { id: 'harmony', kind: 'pitched', notes: mk(0.01, trip) };
  T.quantizeTracks([b], bpm, ph);
  const off = b.notes.filter((n) => n.midi === 72 && Math.abs(((n.t - ph) / step) - Math.round((n.t - ph) / step)) > 0.2).length;
  check(off >= 3, `quantize: โน้ต triplet ที่อยู่กลางช่องต้องไม่ถูก snap (เหลือ ${off}/6 ที่ไม่ถูกบิด)`);
  // 3) เล่นอิสระ (ไม่ลงกริด) → ไม่ snap
  const free = { id: 'melody', kind: 'pitched', mono: true, notes: [] };
  for (let k = 0; k < 80; k++) free.notes.push({ t: 1 + k * 0.173 + rnd() * 0.05, d: 0.1, midi: 64, vel: 0.7 });
  const before = free.notes.map((n) => n.t);
  const qf = T.quantizeTracks([free], bpm, ph);
  const moved = free.notes.filter((n, i) => Math.abs(n.t - before[i]) > 1e-6).length;
  check(moved < free.notes.length * 0.45, `quantize: เพลงที่ไม่ลงกริดต้องแทบไม่ถูก snap (ขยับ ${moved}/${free.notes.length})`);
  console.log(`jitter ±20ms → ลงกริด ${a.notes.length - offGrid}/${a.notes.length} · triplet ไม่ถูกบิด ${off}/6 · เล่นอิสระขยับ ${moved}/80 (R=${qf.R})`);
}

/* ---------------- 4) resample ---------------- */
function testResample() {
  console.log('\n=== resample ===');
  const mkSine = (sr, f, sec) => { const n = Math.round(sr * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / sr); return x; };
  const cases = [[48000, 44100, 1000], [44100, 22050, 3000], [22050, 16000, 440], [22050, 11025, 2000], [32000, 22050, 5000]];
  cases.forEach(([a, b, f]) => {
    const y = T.resample(mkSine(a, f, 1), a, b);
    let err = 0, n = 0;
    for (let i = 200; i < y.length - 200; i++) { err += Math.pow(y[i] - Math.sin(2 * Math.PI * f * i / b), 2); n++; }
    const snr = 10 * Math.log10(0.5 / (err / n));
    check(snr > 40 && Math.abs(y.length - Math.floor(a / (a / b))) <= 1, `resample ${a}→${b} @${f}Hz SNR ${snr.toFixed(1)}dB`);
    console.log(`${a}→${b} sine ${f}Hz: SNR ${snr.toFixed(1)}dB`);
  });
  // alias: 9kHz ที่ 44.1k → 16k ต้องถูกตัดทิ้ง (เหนือ Nyquist ใหม่)
  const y = T.resample(mkSine(44100, 9000, 1), 44100, 16000);
  const rms = Math.sqrt(y.reduce((q, v) => q + v * v, 0) / y.length);
  check(rms < 0.02, 'resample: ความถี่เหนือ Nyquist ใหม่ต้องถูกกรอง (rms ' + rms.toFixed(4) + ')');
}

/* ---------------- 5) lite ทั้งเส้น (oracle Basic Pitch) ---------------- */
async function testLite(s, x) {
  console.log('\n=== lite ทั้งเส้น: HPSS + กลอง + ORACLE Basic Pitch + riff.js + แยกบทบาท + quantize ===');
  const truthPitched = s.truth.bass.concat(s.truth.melody, s.truth.harmony);
  // oracle ต้องได้สัญญาณเดียวกับที่ lite ส่งเข้า bpPosteriors = ส่วน harmonic ของ HPSS
  const hp = await T.hpss(x, SR, {});
  const runBP = oracleBP(hp.harmonic, truthPitched, 9);
  const prog = [];
  const t0 = Date.now();
  const ts = await T.lite(x, { runBP, bpm: s.bpm + 0.07, phase: s.phase - 0.09, debug: true, onPct: (f, k) => prog.push([f, k]) });
  const ms = Date.now() - t0;
  const dbg = ts._debug; delete ts._debug;
  checkTrackSet(ts, 'lite', 'lite');
  const exp = []; for (let w = 0; w < dbg.bpWindows; w++) exp.push(w * T.BP.WHOP);
  check(runBP.offsets.every((o) => exp.indexOf(o) >= 0) && runBP.offsets.length === dbg.bpRan, 'หน้าต่าง Basic Pitch ต้องเริ่มที่ w·36164 ของสัญญาณเติมศูนย์ (oracle หาเองจากเนื้อเสียง)');
  check(prog.every((p, i) => i === 0 || p[0] >= prog[i - 1][0] - 1e-9) && prog[prog.length - 1][0] === 1, 'onPct ของ lite ต้องไม่ถอยหลังและจบที่ 1');
  const tr = (id) => (ts.tracks.find((t) => t.id === id) || { notes: [] }).notes;
  const res = {
    drums: evalNotes(tr('drums'), s.truth.drums), bass: evalNotes(tr('bass'), s.truth.bass),
    melody: evalNotes(tr('melody'), s.truth.melody), harmony: evalNotes(tr('harmony'), s.truth.harmony),
    all: evalNotes(ts.tracks.filter((t) => t.kind === 'pitched').flatMap((t) => t.notes), truthPitched),
  };
  Object.entries(res).forEach(([k, e]) => console.log(`${k.padEnd(8)} ${fmt(e)}`));
  console.log(`quantize: ${JSON.stringify(dbg.quant)} · bpm/phase ใน TrackSet ${ts.bpm}/${ts.phase} (ส่งเข้า ${(s.bpm + 0.07).toFixed(2)}/${(s.phase - 0.09).toFixed(2)})`);
  console.log(`เวลา ${ms}ms (${Math.round(ms / (x.length / SR / 60))}ms ต่อนาทีเสียง, ไม่รวมโมเดล) · ขั้น: ${JSON.stringify(dbg.tm)}`);
  check(res.bass.F1 >= 0.9, 'lite+oracle: bass F1 ≥ 90%');
  check(res.melody.F1 >= 0.75, 'lite+oracle: melody F1 ≥ 75%');
  check(res.harmony.F1 >= 0.8, 'lite+oracle: harmony F1 ≥ 80%');
  check(res.all.F1 >= 0.9, 'lite+oracle: โน้ตทั้งหมด (ไม่สนบทบาท) F1 ≥ 90%');
  check(Math.abs(ts.bpm - s.bpm) < 0.2, 'TrackSet.bpm ต้องปรับละเอียดเข้าใกล้ BPM จริง');
  const beat = 60 / s.bpm, dph = Math.abs(((ts.phase - s.phase) / beat) - Math.round((ts.phase - s.phase) / beat)) * beat;
  check(dph < 0.02, `TrackSet.phase ต้องตรง beat จริง (คลาด ${(dph * 1000).toFixed(0)}ms)`);
  // ไม่ส่ง bpm → ไม่ quantize และ bpm/phase = null
  const ts2 = await T.lite(x, { runBP: oracleBP(hp.harmonic, truthPitched, 9) });
  check(ts2.bpm === null && ts2.phase === null, 'ไม่รู้ BPM → TrackSet.bpm/phase = null');
  // ไม่มี riff.js → skyline ยังได้เมโลดี้
  const ts3 = await T.lite(x, { runBP: oracleBP(hp.harmonic, truthPitched, 9), riff: false, bpm: s.bpm, phase: s.phase });
  const m3 = evalNotes((ts3.tracks.find((t) => t.id === 'melody') || { notes: [] }).notes, s.truth.melody);
  console.log(`ไม่มี riff.js (skyline): melody ${fmt(m3)}`);
  check(m3.F1 >= 0.5, 'skyline (ไม่มี riff.js): melody F1 ≥ 50%');
  return { ts, res };
}

/* ---------------- 6) full: แยก stem (stub Demucs) + แทร็กจาก stem ---------------- */
async function testFull(s) {
  console.log('\n=== full: overlap-add ของ Demucs (stub คืน stem จริง) + แทร็กจาก stem (ORACLE Basic Pitch) ===');
  const N = T.DM.N, ST = T.DM.STRIDE;
  const map = { drums: s.parts.drums, bass: s.parts.bass, other: s.parts.pads, vocals: s.parts.lead };
  const total = s.L.length;
  let calls = 0;
  const runDemucs = async (inp, ci) => {
    calls++;
    const out = new Float32Array(12 * N);
    const start = ci * ST;
    // ตรวจว่าหน้าต่างที่ส่งมาคือเสียงช่วงนั้นจริง
    for (let i = 0; i < 2000; i += 97) if (start + i < total && Math.abs(inp[i] - s.L[start + i]) > 1e-7) throw new Error('stub: หน้าต่างไม่ตรงตำแหน่ง');
    T.DM.STEMS.forEach((nm, si) => {
      const p = map[nm];
      if (!p) return;
      for (let c = 0; c < 2; c++) {
        const src = c ? p.R : p.L, o = (si * 2 + c) * N;
        for (let j = 0; j < N && start + j < total; j++) out[o + j] = src[start + j];
      }
    });
    return out;
  };
  const t0 = Date.now();
  const sep = await T.separate(s.L, s.R, runDemucs, {});
  const msSep = Date.now() - t0;
  check(calls === Math.ceil(total / ST), 'separate: จำนวนหน้าต่างต้องเท่ากับ ceil(ยาว/stride)');
  // เทียบ stem 22.05k กับของจริง (mono → decimate)
  for (const [nm, p] of Object.entries(map)) {
    const ref = T.decimate(T.mixdown([p.L, p.R]), 2), y = sep.stems[nm];
    let e = 0, r = 0;
    for (let i = 2000; i < Math.min(ref.length, y.length) - 2000; i++) { e += Math.pow(y[i] - ref[i], 2); r += ref[i] * ref[i]; }
    const snr = 10 * Math.log10(r / (e || 1e-20));
    console.log(`stem ${nm.padEnd(6)} SNR เทียบของจริง ${snr.toFixed(1)}dB`);
    check(snr > 40, `separate: stem ${nm} ต้องคืนรูปได้ (SNR ${snr.toFixed(1)}dB)`);
  }
  check(sep.present.drums && sep.present.bass && sep.present.other && sep.present.vocals && !sep.present.guitar && !sep.present.piano, 'present: ' + JSON.stringify(sep.present));
  const inst = T.instrumental11k(sep.stems);
  check(Math.abs(inst.length - Math.floor(total / 4)) <= 2, 'instrumentalMono11k ต้องยาว = เพลง @11025Hz');
  const v16 = T.resample(sep.stems.vocals, SR, 16000);
  check(Math.abs(v16.length / 16000 - total / 44100) < 0.01, 'vocals 16kHz ต้องยาวเท่าเพลง');
  // แทร็กจาก stem
  const runBP = (() => {
    const by = { bass: s.truth.bass, other: s.truth.harmony, vocals: s.truth.melody };
    const o = {};
    Object.keys(by).forEach((k) => { o[k] = oracleBP(sep.stems[k], by[k], 3); });
    return o;
  })();
  // fromStems เรียก runBP ตามลำดับ stem — สลับ oracle ตาม stem ที่กำลังทำ (ดูจาก progress key)
  let cur = null;
  const t1 = Date.now();
  const ts = await T.fromStems(sep, {
    runBP: (inp, B, ws) => runBP[cur](inp, B, ws), bpm: s.bpm, phase: s.phase, debug: true,
    onPct: (f, k) => { if (runBP[k]) cur = k; },
  });
  const ms = Date.now() - t1;
  delete ts._debug;
  checkTrackSet(ts, 'full', 'full');
  const tr = (id) => (ts.tracks.find((t) => t.id === id) || { notes: [] }).notes;
  const res = {
    drums: evalNotes(tr('drums'), s.truth.drums), bass: evalNotes(tr('bass'), s.truth.bass),
    vocals: evalNotes(tr('vocals'), s.truth.melody), other: evalNotes(tr('other'), s.truth.harmony),
  };
  Object.entries(res).forEach(([k, e]) => console.log(`${k.padEnd(8)} ${fmt(e)}`));
  console.log(`overlap-add ${msSep}ms · แทร็กจาก stem ${ms}ms (ไม่รวมโมเดล) · แทร็ก: ${ts.tracks.map((t) => t.id + ':' + t.notes.length).join(' ')}`);
  check(res.drums.F1 >= 0.85 && res.bass.F1 >= 0.9 && res.vocals.F1 >= 0.85 && res.other.F1 >= 0.85, 'full+oracle: drums ≥ 85%, bass/vocals/other ≥ 85–90%');
  // เพลงบรรเลง (ไม่มี vocals) → หาเส้นเมโลดี้จาก stem ที่เป็นเส้นเดียว
  const sep2 = { stems: Object.assign({}, sep.stems, { vocals: new Float32Array(sep.stems.vocals.length), guitar: sep.stems.vocals }), present: Object.assign({}, sep.present, { vocals: false, guitar: true }), level: sep.level };
  const rb2 = { bass: runBP.bass, other: runBP.other, guitar: oracleBP(sep.stems.vocals, s.truth.melody, 4) };
  let cur2 = null;
  const ts2 = await T.fromStems(sep2, { runBP: (inp, B, ws) => rb2[cur2](inp, B, ws), bpm: s.bpm, phase: s.phase, onPct: (f, k) => { if (rb2[k]) cur2 = k; } });
  const mel2 = evalNotes((ts2.tracks.find((t) => t.id === 'melody') || { notes: [] }).notes, s.truth.melody);
  console.log(`เพลงบรรเลง (ลีดอยู่ใน stem guitar): melody ${fmt(mel2)} · แทร็ก ${ts2.tracks.map((t) => t.id + ':' + t.notes.length).join(' ')}`);
  check(mel2.F1 >= 0.8, 'full บรรเลง: ต้องย้ายเส้นทำนองจาก stem ที่เป็นเส้นเดียวไปแทร็ก melody (F1 ≥ 80%)');
}

/* ---------------- 7) แก้กราฟ iSTFT (protobuf) ---------------- */
function testPatch() {
  console.log('\n=== แก้กราฟ iSTFT ของ Demucs (ConvTranspose → MatMul + overlap-add) ===');
  const PB = T._pb;
  const ct = (name, x, w, out) => PB.node('ConvTranspose', name, [x, w], [out], [PB.attrInts('kernel_shape', [4096]), PB.attrInts('strides', [1024]), PB.attrInts('pads', [0, 0]), PB.attrInts('dilations', [1]), PB.attrInt('group', 1)]);
  const graph = PB.cat([
    PB.node('Gather', '/real_istft/Gather_5', ['X', 'i0'], ['g5'], [PB.attrInt('axis', 1)]),
    PB.node('Gather', '/real_istft/Gather_6', ['X', 'i1'], ['g6'], [PB.attrInt('axis', 1)]),
    ct('/real_istft/ConvTranspose_1', 'g6', 'W8', 'c1'),
    ct('/real_istft/ConvTranspose', 'g5', 'W7', 'c0'),
    PB.node('Add', '/real_istft/Add', ['c0', 'c1'], ['/real_istft/Add_output_0']),
    PB.node('Gather', '/real_istft/Gather_7', ['/real_istft/Add_output_0', 'i0'], ['y'], [PB.attrInt('axis', 1)]),
    PB.fLen(2, new TextEncoder().encode('g')),
  ]);
  const model = PB.cat([PB.fLen(1, new Uint8Array([8, 8])), PB.key(7, 2), PB.varint(graph.length), graph, PB.fLen(8, new Uint8Array([16, 17]))]);
  const out = T.patchDemucsIstft(model);
  check(out instanceof Uint8Array, 'patch: ต้องแก้กราฟรูปแบบนี้ได้');
  if (!out) return;
  const top = PB.fields(out, 0, out.length);
  check(top.map((x) => x.f).join(',') === '1,7,8', 'patch: field อื่นของ ModelProto ต้องอยู่ครบตามลำดับ');
  const g = top.find((x) => x.f === 7);
  const gf = PB.fields(out, g.a, g.b);
  const nodes = gf.filter((x) => x.f === 1).map((x) => {
    const nf = PB.fields(out, x.a, x.b);
    const s = (f) => nf.filter((y) => y.f === f).map((y) => PB.str(out, y));
    return { op: s(4)[0], name: s(3)[0], ins: s(1), outs: s(2) };
  });
  const ops = nodes.map((n) => n.op).join(',');
  check(!/ConvTranspose/.test(ops), 'patch: ConvTranspose ของ iSTFT ต้องหายไป');
  check((ops.match(/MatMul/g) || []).length === 2 && (ops.match(/Pad/g) || []).length === 4, 'patch: ต้องมี MatMul 2 + Pad 4 (overlap-add 4096/1024)');
  const last = nodes.findIndex((n) => n.outs[0] === '/real_istft/Add_output_0');
  const use = nodes.findIndex((n) => n.name === '/real_istft/Gather_7');
  check(last >= 0 && last < use, 'patch: ผลลัพธ์ต้องชื่อเดิมและมาก่อนโหนดที่ใช้ (เรียงตาม topology)');
  const inits = gf.filter((x) => x.f === 5).length;
  check(inits === 3 + 2 * 4, 'patch: initializer ใหม่ (shape/idx/pad) ครบ ได้ ' + inits);
  check(gf.some((x) => x.f === 2 && PB.str(out, x) === 'g'), 'patch: field อื่นของ GraphProto ต้องอยู่');
  // ไม่ใช่รูปแบบที่รู้จัก → null (ใช้กราฟเดิม)
  const bad = PB.cat([PB.key(7, 2), PB.varint(5), PB.fLen(2, new Uint8Array([103, 103, 103]))]);
  check(T.patchDemucsIstft(bad) === null, 'patch: กราฟที่ไม่ตรงรูปแบบต้องคืน null');
  check(T.patchDemucsIstft(new Uint8Array([255, 255, 255])) === null, 'patch: ไบต์เสียต้องคืน null ไม่ throw');
  // โมเดลจริง (ถ้ามีไฟล์ในเครื่อง — ไม่อยู่ใน CI)
  const real = process.env.DEMUCS_ONNX;
  if (real && fs.existsSync(real)) {
    const b = new Uint8Array(fs.readFileSync(real));
    const t0 = Date.now();
    const o = T.patchDemucsIstft(b);
    console.log(`โมเดลจริง ${real}: แก้ได้ ${!!o} ใน ${Date.now() - t0}ms (${b.length} → ${o && o.length} ไบต์)`);
    check(!!o, 'patch: ต้องแก้โมเดลจริงได้');
  } else console.log('(ตั้ง DEMUCS_ONNX=path/htdemucs_6s.onnx เพื่อเทสต์กับโมเดลจริง — ตรวจตัวเลขเทียบกราฟเดิมแล้วด้วย onnxruntime: ต่างสูงสุด 1.5e-7)');
}

/* ---------------- 8) hook ใน analyze.js ---------------- */
async function testHook(s) {
  console.log('\n=== hook ใน analyze.js (Stems ปลอม) ===');
  const SR11 = 11025;
  const mono11 = T.resample(T.mixdown([s.L, s.R]), 44100, SR11);
  global.window = global; global.self = global;
  global.I18N = { t: (k) => k };
  global.Store = { uid: () => 'sg_test' };
  global.DSP = DSP; global.Riff = Riff;
  const fakeAudio = { duration: mono11.length / SR11, numberOfChannels: 1, length: mono11.length, sampleRate: SR11, getChannelData: () => mono11 };
  global.Music = { audioCtx: () => ({ decodeAudioData: (b, res) => { res(fakeAudio); } }) };
  vm.runInThisContext(fs.readFileSync(path.join(root, 'site/assets/js/analyze.js'), 'utf8'), { filename: 'analyze.js' });
  const A = global.Analyze;
  const t = (c, m) => check(c, 'hook: ' + m);
  t(A.stages(false) === A.STAGES && A.stages(false).join(',') === 'ingest,prep,beats,chords,key,assemble', 'stages(false) ต้องเหมือนเดิม');
  t(A.stages(true, true).join(',') === 'ingest,prep,beats,chords,key,riff,lyrics,assemble', 'stages(true,true) ต้องเหมือนเดิม');
  t(A.stages(false, false, null) === A.STAGES, 'stages(false,false,null) = เดิม');
  t(A.stages(false, false, 'lite').join(',') === 'ingest,prep,beats,chords,key,tracks,assemble', 'stages lite');
  t(A.stages(true, true, 'full').join(',') === 'ingest,prep,beats,separate,chords,key,riff,lyrics,tracks,assemble', 'stages full');
  t(A.stages({ lyrics: false, riff: true, tracks: 'full' }).join(',') === 'ingest,prep,beats,separate,chords,key,riff,tracks,assemble', 'stages แบบ options');

  // Stems ปลอม — บันทึกการเรียก
  const log = [];
  const ts = (source) => ({ v: 1, source, bpm: 100, phase: 0.5, duration: 30, tracks: [{ id: 'bass', kind: 'pitched', program: 33, notes: [{ t: 1, d: 0.2, midi: 36, vel: 0.8 }] }], _debug: { x: 1 }, instrumentalMono11k: new Float32Array(4) });
  const inst = T.resample(T.mixdown([s.parts.bass.L, s.parts.pads.L, s.parts.lead.L]), 44100, SR11); // ไม่มีกลอง
  const voc = T.resample(s.parts.lead.L, 44100, 16000);
  let mode = {};
  global.Stems = {
    capabilities: async () => ({ fullOK: !mode.noGpu, liteOK: true }),
    separate: async (audio, o) => {
      log.push('separate'); o.onPct(0.5, 'sep');
      if (mode.cancelSep) { mode.ctl.aborted = true; await new Promise((r) => setTimeout(r, 10)); o.chk(); }
      if (mode.sepFail) { const e = new Error(mode.sepFail); e.code = mode.sepFail; throw e; }
      return {
        present: { drums: true, bass: true, other: true, vocals: true, guitar: true, piano: false }, instrumentalMono11k: inst, vocalsPcm16k: o.wantVocalsPcm16k ? voc : null,
        stem: async (nm, sr) => { log.push('stem:' + nm + '@' + sr); return T.resample(s.parts.lead.L, 44100, sr); },
        tracks: async (o2) => {
          log.push('sep.tracks'); o2.onPct(0.3, 'bass');
          if (mode.cancelTracks) { mode.ctl.aborted = true; o2.chk(); }
          if (mode.tracksFail) { const e = new Error('x'); e.code = mode.tracksFail; throw e; }
          return ts('full');
        },
        release: () => { log.push('release'); },
      };
    },
    transcribe: async (audio, o) => {
      log.push('transcribe:' + o.mode); o.onPct(0.4, 'notes');
      if (mode.liteFail) { const e = new Error('x'); e.code = mode.liteFail; throw e; }
      return ts('lite');
    },
  };
  // Lyrics ปลอม — ดูว่าได้ PCM จากไหน
  global.Lyrics = { transcribe: async (pcm, o) => { log.push('lyrics:' + pcm.length); return { chunks: [], text: '' }; } };
  const spyChroma = DSP.analyzeChroma;
  let chromaIn = null;
  DSP.analyzeChroma = (x, sr, o) => { chromaIn = { n: x.length, sr }; return spyChroma(x, sr, o); };
  const input = (tracks, extra) => Object.assign({ kind: 'file', file: { size: 1000, name: 'song.wav', arrayBuffer: async () => new ArrayBuffer(8) }, tracks }, extra || {});
  const go = async (inp, m) => {
    mode = m || {}; log.length = 0;
    const ctl = { aborted: false }; mode.ctl = ctl;
    const prog = [];
    let err = null, doc = null;
    try { doc = await A.run(inp, (p) => prog.push(p), ctl); } catch (e) { err = e; }
    return { doc, err, prog, log: log.slice() };
  };
  const stagesOf = (prog) => { const o = []; prog.forEach((p) => { if (o[o.length - 1] !== p.stage) o.push(p.stage); }); return o.join(','); };
  const mono = (prog) => prog.every((p, i) => i === 0 || p.percent >= prog[i - 1].percent) && prog.every((p) => p.percent >= 0 && p.percent <= 99);

  // 0) ไม่ขอ tracks → เหมือนเดิมทุกอย่าง
  let r = await go(input(undefined));
  t(r.doc && r.doc.chordpro && !Object.keys(r.doc).some((k) => /^_tracks/.test(k)) && !r.log.length, 'ไม่ขอ tracks → ไม่มี _tracks* และไม่เรียก Stems');
  t(stagesOf(r.prog) === 'ingest,prep,beats,chords,key,assemble', 'ไม่ขอ tracks → stage เดิม');
  const chordsPlain = r.doc.timeline.map((x) => x.chord).join(' ');
  // 1) lite
  r = await go(input('lite'));
  t(r.doc._tracks && r.doc._tracks.source === 'lite' && !r.doc._tracksError && !r.doc._tracksFallback, 'lite → doc._tracks');
  t(Object.keys(r.doc._tracks).sort().join(',') === 'bpm,duration,phase,source,tracks,v', 'doc._tracks ต้องตัดของแถม (_debug/instrumentalMono11k)');
  t(stagesOf(r.prog) === A.stages(false, false, 'lite').join(','), 'lite: ลำดับ stage ที่รายงาน ' + stagesOf(r.prog));
  t(mono(r.prog), 'lite: percent ต้องไม่ถอยหลัง');
  t(r.doc.schemaVersion === 1 && !('tracks' in r.doc), 'SongDoc ต้องไม่เปลี่ยน');
  // 2) full ปกติ (+ riff + lyrics)
  r = await go(input('full', { riff: true, lyrics: { model: 'base', lang: 'th' } }));
  t(r.doc._tracks && r.doc._tracks.source === 'full' && !r.doc._tracksError, 'full → doc._tracks.source = full');
  t(r.log.join('|') === 'separate|stem:guitar@11025|lyrics:' + voc.length + '|sep.tracks|release', 'full: ลำดับเรียก ' + r.log.join('|'));
  t(chromaIn && chromaIn.sr === SR11 && chromaIn.n === inst.length, 'full: แกะคอร์ดจาก instrumentalMono11k');
  t(stagesOf(r.prog) === A.stages(true, true, 'full').join(','), 'full: ลำดับ stage ' + stagesOf(r.prog));
  t(mono(r.prog), 'full: percent ต้องไม่ถอยหลัง');
  t(r.doc.vocalIsolated === true, 'full: เนื้อร้องจาก stem เสียงร้อง (vocalIsolated)');
  console.log('คอร์ดจากมิกซ์:        ' + chordsPlain.slice(0, 80));
  console.log('คอร์ดจาก instrumental: ' + r.doc.timeline.map((x) => x.chord).join(' ').slice(0, 80));
  // 3) ไม่มี WebGPU → lite + fallback
  r = await go(input('full'), { noGpu: true });
  t(r.doc._tracks && r.doc._tracks.source === 'lite' && r.doc._tracksError === 'gpu' && r.doc._tracksFallback === true && r.log.join('|') === 'transcribe:lite', 'ไม่มี WebGPU → lite + _tracksError=gpu + _tracksFallback');
  t(mono(r.prog), 'fallback: percent ต้องไม่ถอยหลัง');
  // 4) separate โหลดโมเดลไม่ได้ → lite
  r = await go(input('full'), { sepFail: 'load' });
  t(r.doc._tracks && r.doc._tracks.source === 'lite' && r.doc._tracksError === 'load' && r.doc._tracksFallback, 'separate โหลดไม่ได้ → lite + _tracksError=load');
  // 5) แทร็กจาก stem พัง (run) → lite, คืน stem
  r = await go(input('full'), { tracksFail: 'run' });
  t(r.doc._tracks && r.doc._tracks.source === 'lite' && r.doc._tracksError === 'run' && r.doc._tracksFallback && r.log.indexOf('release') >= 0, 'sep.tracks พัง → lite + _tracksError=run + release');
  t(mono(r.prog), 'sep.tracks พัง → percent ของ fallback ต้องไม่ถอยหลัง');
  // 6) Basic Pitch โหลดไม่ได้ใน full → ไม่ลอง lite ซ้ำ, ชีตคอร์ดยังได้
  r = await go(input('full'), { tracksFail: 'load' });
  t(r.doc.chordpro && !r.doc._tracks && r.doc._tracksError === 'load' && r.log.indexOf('transcribe:lite') < 0, 'Basic Pitch โหลดไม่ได้ → _tracksError=load ไม่มี _tracks');
  // 7) lite พัง
  r = await go(input('lite'), { liteFail: 'run' });
  t(r.doc.chordpro && !r.doc._tracks && r.doc._tracksError === 'run', 'lite พัง → ชีตคอร์ดยังได้ + _tracksError=run');
  // 8) ยกเลิกระหว่าง separate / tracks
  r = await go(input('full'), { cancelSep: true });
  t(r.err && r.err.message === 'cancelled', 'ยกเลิกระหว่าง separate → cancelled');
  r = await go(input('full'), { cancelTracks: true });
  t(r.err && r.err.message === 'cancelled' && r.log.indexOf('release') >= 0, 'ยกเลิกระหว่าง tracks → cancelled + release');
  // 9) ไม่มี Stems
  const S = global.Stems; delete global.Stems;
  r = await go(input('full'));
  global.Stems = S;
  t(r.doc && r.doc.chordpro && r.doc._tracksError === 'load' && !r.doc._tracks, 'ไม่มี stems.js → _tracksError=load');
  DSP.analyzeChroma = spyChroma;
  delete global.Lyrics;
  console.log('stages / PCT / doc._tracks / fallback (gpu/load/run) / ยกเลิก / release: ตรวจแล้ว');
}

async function main() {
  const t0 = Date.now();
  const s = synthSong({ bars: 12, seed: 7 });
  const x = T.decimate(T.mixdown([s.L, s.R]), 2);
  console.log(`เพลงสังเคราะห์ ${s.duration.toFixed(1)}s · ${s.truth.drums.length} กลอง · ${s.truth.bass.length} เบส · ${s.truth.harmony.length} โน้ตคอร์ด · ${s.truth.melody.length} ลีด (สร้าง ${Date.now() - t0}ms)`);
  await testHpssDrums(s, x);
  testBpNotes();
  testQuantize();
  testResample();
  await testLite(s, x);
  await testFull(s);
  testPatch();
  await testHook(s);
  if (problems.length) {
    console.error('\n✗ FAILED:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log(`\n✓ ผ่านทุกเกณฑ์ (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
