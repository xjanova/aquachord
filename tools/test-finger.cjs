#!/usr/bin/env node
/* test-finger.cjs — เทสต์ตัวเรียบเรียงกีตาร์ fingerstyle (site/assets/js/finger.js) ด้วยเพลงที่รู้ส่วนประกอบ
   เพลงทดสอบ: 1) โฟล์ก C–G–Am–F (ทำนองปกติ + 16th บางช่วง)
              2) ทำนองต่ำช่วงเสียงร้องผู้ชาย G–Em–C–D (ต้องย้ายออกเทฟขึ้น) + คอร์ดเปลี่ยนกลางห้อง
              3) ไมเนอร์ Am–Dm–E7 + แทร็กเบสเดิน (G# ใต้ E7) · และแบบไม่มี BPM/phase (ต้องประมาณเอง)
   ทุกสไตล์ × ทุกระดับ ตรวจด้วยตัวตรวจของเทสต์เอง (ไม่พึ่ง Finger.check):
   - กฎเล่นได้จริง (hard): เสียง = สาย+เฟรต+capo, สายละ 1 โน้ต, ดีดพร้อมกัน ≤ 4, ช่วงเฟรตใน beat ≤ 4 (ง่าย) / 5,
     ย้ายมือ beat ติดกัน ≤ 5 เฟรต (ยกเว้นรอยต่อคอร์ด/วลี) → เป้า 0
   - ทำนองคงอยู่: เสียงสูงสุดตอนทำนองเข้า = pitch class ของทำนอง ≥ 95%
   - เบสลงทุกจุดเปลี่ยนคอร์ด (pitch class อยู่ในคอร์ด) · โน้ตเรียงเวลา · ความยาวสมเหตุผล · แท็บบรรทัดยาวเท่ากัน
   - โหมดง่าย: เบส/เติมอยู่บนกริด 1/8 เท่านั้น, เบสเฉพาะจังหวะ 1/3 หรือจุดเปลี่ยนคอร์ด
   + เคสขอบ, ผลซ้ำได้ (deterministic), ความเร็วเพลง 4 นาที
   ใช้: node tools/test-finger.cjs — exit 1 เมื่อไม่ผ่าน */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
global.window = {};
require(path.join(root, 'site', 'assets', 'js', 'music.js'));
const Music = global.window.Music;
const Finger = require(path.join(root, 'site', 'assets', 'js', 'finger.js'));

const OPEN = [40, 45, 50, 55, 59, 64];
const STYLES = ['melody-bass', 'travis', 'arpeggio', 'chord-melody'];
const DIFFS = ['easy', 'normal'];
const problems = [];
const pct = (x) => (x * 100).toFixed(1) + '%';
const mod12 = (x) => ((x % 12) + 12) % 12;
const PCN = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const namePc = (n) => { let p = PCN[n[0]]; for (const ch of n.slice(1)) p += ch === '#' ? 1 : ch === 'b' ? -1 : 0; return mod12(p); };
const chordPcs = (sym) => {
  const p = Music.parseChord(sym);
  if (!p) return null;
  const s = new Set(Music.chordNotes(sym).map(namePc));
  if (p.bass) s.add(namePc(p.bass));
  return s;
};

/* ---------------- สร้างเพลงจากส่วนประกอบ (หน่วย beat) ---------------- */
function song(def) {
  const beat = 60 / def.bpm, ph = def.t0;
  let b = 0;
  const chords = def.chords.map(([sym, n]) => { const c = { t: ph + b * beat, chord: sym }; b += n; return c; });
  const melody = def.melody.map(([m, s, d]) => ({ t: +(ph + s * beat).toFixed(4), d: +(d * beat * 0.95).toFixed(4), midi: m }));
  const bass = (def.bass || []).map(([m, s, d]) => ({ t: +(ph + s * beat).toFixed(4), d: +(d * beat * 0.9).toFixed(4), midi: m }));
  return { name: def.name, bpm: def.bpm, phase: def.phase === undefined ? ph : def.phase, key: def.key, chords, melody, bass, beats: b };
}

const FOLK = song({
  name: 'โฟล์ก C–G–Am–F', bpm: 100, t0: 0.5, key: 'C',
  chords: [['C', 4], ['G', 4], ['Am', 4], ['F', 4], ['C', 4], ['G', 4], ['Am', 4], ['F', 4], ['C', 4]],
  melody: [
    [64, 0, 1], [64, 1, 1], [67, 2, 1], [67, 3, 1], [67, 4, 0.5], [69, 4.5, 0.5], [67, 5, 1], [62, 6, 2],
    [60, 8, 1], [64, 9, 1], [69, 10, 1.5], [67, 11.5, 0.5], [65, 12, 1], [64, 13, 1], [62, 14, 2],
    [64, 16, 0.5], [65, 16.5, 0.5], [67, 17, 1], [72, 18, 1], [67, 19, 1],
    [71, 20, 0.25], [72, 20.25, 0.25], [74, 20.5, 0.25], [72, 20.75, 0.25], [71, 21, 1], [67, 22, 2],
    [69, 24, 1], [72, 25, 1], [76, 26, 1], [74, 27, 0.5], [72, 27.5, 0.5],
    [69, 28, 1], [65, 29, 1], [64, 30, 1], [62, 31, 1], [60, 32, 4],
  ],
});

const LOW = song({
  name: 'ทำนองต่ำ (เสียงร้อง) G–Em–C–D', bpm: 80, t0: 1.0, key: 'G', phase: null,
  chords: [['G', 4], ['Em', 4], ['C', 4], ['D', 4], ['G', 4], ['Em', 4], ['C', 2], ['D', 2], ['G', 4]],
  melody: [
    [47, 0, 1], [50, 1, 1], [55, 2, 1.5], [54, 3.5, 0.5], [52, 4, 1], [50, 5, 1], [47, 6, 2],
    [48, 8, 1], [52, 9, 1], [55, 10, 1], [52, 11, 1], [54, 12, 1.5], [52, 13.5, 0.5], [50, 14, 2],
    [55, 16, 1], [57, 17, 1], [55, 18, 1], [50, 19, 1], [52, 20, 2], [55, 22, 1], [52, 23, 1],
    [52, 24, 1], [48, 25, 1], [50, 26, 1], [54, 27, 1], [55, 28, 4],
  ],
});

const MINOR = song({
  name: 'ไมเนอร์ Am–Dm–E7 + เบสเดิน', bpm: 90, t0: 0.25, key: 'Am',
  chords: [['Am', 4], ['Dm', 4], ['E7', 4], ['Am', 4], ['Dm', 2], ['Am', 2], ['E7', 4], ['Am', 4]],
  melody: [
    [69, 0, 1], [72, 1, 1], [76, 2, 1], [74, 3, 1], [77, 4, 1.5], [76, 5.5, 0.5], [74, 6, 1], [69, 7, 1],
    [71, 8, 1], [68, 9, 1], [64, 10, 1], [68, 11, 1], [69, 12, 3], [64, 15, 1],
    [65, 16, 1], [69, 17, 1], [72, 18, 1], [69, 19, 1],
    [68, 20, 0.5], [71, 20.5, 0.5], [74, 21, 1], [71, 22, 1], [68, 23, 1], [69, 24, 4],
  ],
  bass: [
    [45, 0, 2], [40, 2, 2], [50, 4, 2], [45, 6, 2], [40, 8, 2], [44, 10, 2], [45, 12, 2], [43, 14, 2],
    [50, 16, 2], [45, 18, 2], [40, 20, 2], [44, 22, 2], [45, 24, 4],
  ],
});
const MINOR_NOBPM = Object.assign({}, MINOR, { name: 'ไมเนอร์ (ไม่มี BPM/phase)', bpm: null, phase: null, _bpm: 90 });
const SONGS = [FOLK, LOW, MINOR, MINOR_NOBPM];

/* ---------------- ตัวตรวจของเทสต์ (เขียนแยกจาก finger.js) ---------------- */
function normMel(mel) { // เหมือนสัญญาของ arrange: เรียงเวลา, ทำนองเส้นเดียว
  const a = mel.slice().sort((x, y) => x.t - y.t || y.midi - x.midi);
  const out = [];
  a.forEach((n) => { const p = out[out.length - 1]; if (p && n.t - p.t < 0.02) return; out.push(Object.assign({}, n)); });
  for (let i = 0; i + 1 < out.length; i++) if (out[i].t + out[i].d > out[i + 1].t) out[i].d = out[i + 1].t - out[i].t;
  return out;
}
function handShift(a1, b1, a2, b2) { // มือคลุม 4 เฟรต p..p+3 → ระยะย้ายขั้นต่ำ
  const r1 = [Math.max(1, b1 - 3), Math.max(Math.max(1, b1 - 3), a1)];
  const r2 = [Math.max(1, b2 - 3), Math.max(Math.max(1, b2 - 3), a2)];
  return Math.max(0, r2[0] - r1[1], r1[0] - r2[1]);
}

function audit(sg, res, diff) {
  const H = [];   // hard violations
  const notes = res.notes;
  const capo = res.capo;
  const beat = 60 / res.bpm, phase = res.phase;
  const beatOf = (t) => Math.floor((t - phase + 0.02) / beat);
  const spanMax = diff === 'easy' ? 4 : 5;
  // เสียง/ตำแหน่ง/เวลา
  notes.forEach((n, i) => {
    if (![n.s, n.f, n.midi].every(Number.isInteger)) H.push(`โน้ต ${i}: s/f/midi ไม่ใช่จำนวนเต็ม`);
    if (!(n.s >= 0 && n.s <= 5)) H.push(`โน้ต ${i}: สาย ${n.s}`);
    if (!(n.f >= 0 && n.f <= 20 - capo)) H.push(`โน้ต ${i}: เฟรต ${n.f}`);
    if (OPEN[n.s] + capo + n.f !== n.midi) H.push(`โน้ต ${i}: สาย${n.s}+เฟรต${n.f}+capo${capo} ≠ ${n.midi}`);
    if (!(isFinite(n.t) && n.t >= 0 && isFinite(n.d) && n.d > 0)) H.push(`โน้ต ${i}: t/d ผิด (${n.t}, ${n.d})`);
    if (n.d > 8 * beat + 0.01) H.push(`โน้ต ${i}: ยาวเกิน (${n.d}s)`);
    if (!['melody', 'bass', 'fill'].includes(n.role)) H.push(`โน้ต ${i}: role ${n.role}`);
    if (n.role === 'bass' && n.s > 2) H.push(`โน้ต ${i}: เบสบนสาย ${6 - n.s} (ต้องเป็นสาย 6/5/4)`);
    if (i && notes[i - 1].t > n.t) H.push(`โน้ต ${i}: ไม่เรียงเวลา`);
  });
  // สายละ 1 โน้ต
  for (let s = 0; s < 6; s++) {
    const l = notes.filter((n) => n.s === s);
    for (let j = 1; j < l.length; j++) {
      if (l[j].t - l[j - 1].t < 1e-6) H.push(`สาย ${6 - s}: 2 โน้ตพร้อมกันที่ ${l[j].t}`);
      else if (l[j - 1].t + l[j - 1].d > l[j].t + 1e-3) H.push(`สาย ${6 - s}: โน้ตที่ ${l[j - 1].t} ยังดังทับ ${l[j].t}`);
    }
  }
  // ดีดพร้อมกัน
  const byT = new Map();
  notes.forEach((n) => { const k = n.t.toFixed(3); byT.set(k, (byT.get(k) || []).concat(n)); });
  byT.forEach((l, k) => {
    if (l.length > 4) H.push(`${k}s: ดีดพร้อมกัน ${l.length} เสียง`);
    if (l.filter((n) => n.f > 0).length > 4) H.push(`${k}s: กดพร้อมกันเกิน 4 นิ้ว`);
  });
  // ช่วงเฟรตต่อ beat + ย้ายมือ
  const byB = new Map();
  notes.forEach((n) => { if (n.f > 0) { const k = beatOf(n.t); byB.set(k, (byB.get(k) || []).concat(n.f)); } });
  const mel = normMel(sg.melody);
  const outMel = notes.filter((n) => n.role === 'melody');
  const bnd = new Set();
  sg.chords.forEach((c) => { for (let t = c.t - beat / 2; t < c.t + beat / 2 + 1e-9; t += beat / 4) bnd.add(beatOf(t)); });
  mel.forEach((m, i) => { if (!i || m.t - (mel[i - 1].t + mel[i - 1].d) >= beat / 2 - 1e-6) bnd.add(beatOf(m.t)); });
  outMel.forEach((m, i) => { // วลีที่ย้ายออกเทฟต่างกัน = รอยต่อวลี
    if (i && (m.oct || 0) !== (outMel[i - 1].oct || 0)) bnd.add(beatOf(m.t));
  });
  let maxSpan = 0, maxShift = 0;
  byB.forEach((fs, k) => {
    const a = Math.min(...fs), b = Math.max(...fs);
    maxSpan = Math.max(maxSpan, b - a);
    if (b - a > spanMax) H.push(`beat ${k}: ช่วงเฟรต ${a}–${b} > ${spanMax}`);
    const p = byB.get(k - 1);
    if (!p || bnd.has(k)) return;
    const sh = handShift(Math.min(...p), Math.max(...p), a, b);
    maxShift = Math.max(maxShift, sh);
    if (sh > 5) H.push(`beat ${k}: ย้ายมือ ${sh} เฟรต`);
  });
  // ทำนองคงอยู่: เสียงสูงสุดตอนทำนองเข้า
  let topOk = 0;
  if (outMel.length !== mel.length) H.push(`ทำนองหาย: ออก ${outMel.length} จาก ${mel.length}`);
  mel.forEach((m) => {
    const sounding = notes.filter((n) => n.t <= m.t + 1e-3 && n.t + n.d > m.t + 1e-3);
    if (!sounding.length) return;
    const top = sounding.reduce((x, y) => (y.midi > x.midi ? y : x));
    if (top.role === 'melody' && mod12(top.midi) === mod12(m.midi) && Math.abs(top.t - m.t) < 2e-3 &&
        sounding.filter((n) => n.midi === top.midi).length === 1) topOk++;
  });
  const topRate = mel.length ? topOk / mel.length : 1;
  // ทำนองอยู่รีจิสเตอร์ที่เล่นได้ (เทียบ capo)
  outMel.forEach((n) => { const r = n.midi - capo; if (r < 55 || r > 88) H.push(`ทำนอง ${n.midi} นอกช่วง G3–E6 (เทียบ capo)`); });
  // เบสลงจุดเปลี่ยนคอร์ด
  const tol = Math.max(0.075, beat / 8);
  let chg = 0, chgOk = 0, rootOk = 0;
  sg.chords.forEach((c, i) => {
    if (i && sg.chords[i - 1].chord === c.chord) return;
    const pcs = chordPcs(c.chord);
    if (!pcs) return;
    chg++;
    const b = notes.find((n) => n.role === 'bass' && Math.abs(n.t - c.t) <= tol && pcs.has(mod12(n.midi)));
    if (b) {
      chgOk++;
      const p = Music.parseChord(c.chord);
      if (mod12(b.midi) === namePc(p.bass || p.root)) rootOk++;
    }
  });
  // โหมดง่าย: เบส/เติมบนกริด 1/8, เบสเฉพาะจังหวะ 1/3 หรือจุดเปลี่ยนคอร์ด
  if (diff === 'easy') {
    const half = beat / 2;
    notes.forEach((n) => {
      if (n.role === 'melody') return;
      const q = (n.t - phase) / half;
      if (Math.abs(q - Math.round(q)) * half > 0.075) H.push(`ง่าย: ${n.role} ที่ ${n.t} ไม่อยู่บนกริด 1/8 (16th)`);
      if (n.role === 'bass') {
        const bi = Math.round((n.t - phase) / beat);
        const inBar = ((bi % 4) + 4) % 4;
        const atChange = sg.chords.some((c) => Math.abs(c.t - n.t) <= tol);
        if (!atChange && inBar !== 0 && inBar !== 2) H.push(`ง่าย: เบสที่ ${n.t} ไม่ใช่จังหวะ 1/3 หรือจุดเปลี่ยนคอร์ด`);
      }
    });
  }
  return { H, topRate, chg, chgOk, rootOk, maxSpan, maxShift };
}

function checkTab(txt, where) {
  const lines = txt.replace(/\n$/, '').split('\n');
  let systems = 0, frets = 0;
  if (!/^Tuning: E A D G B E( · BPM \d+)?( · Capo \d+)?$/.test(lines[0])) problems.push(`tab ${where}: header "${lines[0]}"`);
  for (let i = 0; i < lines.length; i++) {
    if (!/^e\|/.test(lines[i])) continue;
    const sys = lines.slice(i, i + 6);
    const names = sys.map((l) => l[0]).join('');
    if (names !== 'eBGDAE') problems.push(`tab ${where}: ลำดับสาย ${names}`);
    const L = sys[0].length;
    if (sys.some((l) => l.length !== L)) problems.push(`tab ${where}: บรรทัดยาวไม่เท่ากัน (${sys.map((l) => l.length).join(',')})`);
    const chordLine = lines[i - 1];
    if (chordLine != null && /^ /.test(chordLine) && chordLine.length !== L) problems.push(`tab ${where}: บรรทัดคอร์ดยาว ${chordLine.length} ≠ ${L}`);
    const cnt = lines[i + 6];
    if (cnt != null && /^ {2}\S/.test(cnt) && cnt.length !== L) problems.push(`tab ${where}: บรรทัดนับจังหวะยาว ${cnt.length} ≠ ${L}`);
    sys.forEach((l) => { frets += (l.slice(2).match(/\d+/g) || []).length; });
    systems++;
    i += 5;
  }
  return { systems, frets, dropped: +((txt.match(/\((\d+) โน้ตเร็วกว่า/) || [0, 0])[1]) };
}

/* ---------------- 1) ทุกเพลง × ทุกสไตล์ × ทุกระดับ ---------------- */
console.log('=== เรียบเรียง fingerstyle: ทุกเพลง × สไตล์ × ระดับ ===');
const rows = [];
let hardTotal = 0, runs = 0;
const results = {};
for (const sg of SONGS) {
  for (const style of STYLES) {
    for (const diff of DIFFS) {
      const input = { melody: sg.melody, bass: sg.bass, chords: sg.chords, bpm: sg.bpm, phase: sg.phase, key: sg.key, style, difficulty: diff, capo: 'auto' };
      const t0 = process.hrtime.bigint();
      const res = Finger.arrange(input);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      results[sg.name + '|' + style + '|' + diff] = res;
      runs++;
      const a = audit(sg, res, diff);
      hardTotal += a.H.length;
      a.H.slice(0, 5).forEach((h) => problems.push(`${sg.name} · ${style} · ${diff}: ${h}`));
      if (a.H.length > 5) problems.push(`${sg.name} · ${style} · ${diff}: … อีก ${a.H.length - 5} จุด`);
      if (a.topRate < 0.95) problems.push(`${sg.name} · ${style} · ${diff}: ทำนองเป็นเสียงสูงสุดแค่ ${pct(a.topRate)}`);
      if (a.chgOk < a.chg) problems.push(`${sg.name} · ${style} · ${diff}: เบสลงจุดเปลี่ยนคอร์ดแค่ ${a.chgOk}/${a.chg}`);
      const fc = Finger.check(res);
      if (!fc.ok) problems.push(`${sg.name} · ${style} · ${diff}: Finger.check ไม่ผ่าน — ${fc.hard.slice(0, 2).map((h) => h.msg).join('; ')}`);
      const tab = Finger.toAsciiTab(res);
      const tc = checkTab(tab, `${sg.name} · ${style} · ${diff}`);
      if (tc.frets + tc.dropped !== res.notes.length) problems.push(`${sg.name} · ${style} · ${diff}: แท็บมีเฟรต ${tc.frets} (+ไม่แสดง ${tc.dropped}) ≠ โน้ต ${res.notes.length}`);
      // จำนวนโน้ตตามสไตล์/ระดับ: ง่ายต้องน้อยกว่าปกติ
      const st = res.stats;
      rows.push([sg.name.slice(0, 26), style, diff, res.capo, `${st.melody}/${st.bass}/${st.fill}`, a.H.length,
        pct(a.topRate), `${a.chgOk}/${a.chg}`, `${a.rootOk}/${a.chg}`, `${a.maxSpan}`, `${a.maxShift}`, `${st.positions[0]}–${st.positions[1]}`, ms.toFixed(1)]);
    }
  }
}
const W = [28, 14, 8, 6, 12, 6, 8, 8, 7, 6, 6, 7, 7];
const fmt = (r) => r.map((x, i) => String(x).padEnd(W[i])).join('');
console.log(fmt(['เพลง', 'สไตล์', 'ระดับ', 'capo', 'ท/บ/ต', 'ผิด', 'ทำนอง', 'เบส@คอร์ด', 'root', 'span', 'ย้าย', 'มือ', 'ms']));
rows.forEach((r) => console.log(fmt(r)));
console.log('ท/บ/ต = โน้ตทำนอง/เบส/เติม · ผิด = กฎเล่นได้จริงที่ผิด (เป้า 0) · ทำนอง = เสียงสูงสุดตอนทำนองเข้าตรง pitch class');
console.log('span = ช่วงเฟรตกว้างสุดใน 1 beat · ย้าย = ระยะย้ายมือมากสุดระหว่าง beat ติดกัน (นอกรอยต่อ) · มือ = ตำแหน่งนิ้วชี้ที่ใช้');
console.log(`รวม ${runs} ชุด · ผิดกฎ ${hardTotal} จุด`);

/* ---------------- 2) พฤติกรรมเฉพาะ ---------------- */
console.log('\n=== พฤติกรรมเฉพาะ ===');
{
  // ทำนองต่ำต้องย้ายขึ้น ≥ 1 ออกเทฟ และคงรูปทำนอง (ทิศทางขึ้นลงเหมือนเดิม)
  const r = results[LOW.name + '|melody-bass|normal'];
  const om = r.notes.filter((n) => n.role === 'melody');
  const im = normMel(LOW.melody);
  const shifts = new Set(om.map((n, i) => n.midi - im[i].midi));
  const contourOk = om.every((n, i) => !i || Math.sign(n.midi - om[i - 1].midi) === Math.sign(im[i].midi - im[i - 1].midi) || (n.oct || 0) !== (om[i - 1].oct || 0));
  const med = om.map((n) => n.midi - r.capo).sort((a, b) => a - b)[om.length >> 1];
  console.log(`ทำนองต่ำ: ย้าย ${Array.from(shifts).join(', ')} semitone · ค่ากลางเทียบ capo ${med} · รูปทำนองคงเดิม ${contourOk} · warnings: ${r.warnings.join(' | ')}`);
  if (![...shifts].every((x) => x >= 12 && x % 12 === 0)) problems.push('ทำนองต่ำ: ต้องย้ายขึ้นเป็นออกเทฟ ได้ ' + [...shifts].join(','));
  if (!contourOk) problems.push('ทำนองต่ำ: รูปทำนอง (ขึ้น/ลง) เปลี่ยน');
  if (med < 57 || med > 76) problems.push('ทำนองต่ำ: ค่ากลางหลังย้าย ' + med + ' ไม่อยู่ช่วงที่เล่นสบาย');
}
{
  // เพลงไม่มี BPM: ต้องประมาณได้ใกล้ 90 (หรือ ×2/÷2) และเตือน
  const r = results[MINOR_NOBPM.name + '|travis|normal'];
  const ratio = r.bpm / 90;
  const okBpm = [0.5, 1, 2].some((x) => Math.abs(ratio - x) < 0.03);
  console.log(`ไม่มี BPM: ประมาณได้ ${r.bpm} · phase ${r.phase} · warnings: ${r.warnings.join(' | ')}`);
  if (!okBpm) problems.push('ไม่มี BPM: ประมาณได้ ' + r.bpm + ' (จริง 90)');
  if (!r.warnings.some((w) => /^bpm-estimated/.test(w))) problems.push('ไม่มี BPM: ต้องมี warning bpm-estimated');
}
{
  // เบสเดิน: E7 ห้องที่มี G# ในแทร็กเบสตรงจังหวะ 3 → melody-bass ปกติต้องใช้ G#
  const r = results[MINOR.name + '|melody-bass|normal'];
  const beat = 60 / 90;
  const tG = 0.25 + 10 * beat;
  const b = r.notes.find((n) => n.role === 'bass' && Math.abs(n.t - tG) < 0.08);
  console.log(`เบสเดิน: E7 จังหวะ 3 ได้เบส ${b ? b.midi + ' (pc ' + mod12(b.midi) + ')' : 'ไม่มี'}`);
  if (!b || mod12(b.midi) !== 8) problems.push('เบสเดิน: E7 จังหวะ 3 ต้องเป็น G# จากแทร็กเบส');
}
{
  // travis ปกติ: เบสทุกจังหวะ (ในช่วงที่มีคอร์ด) สลับสาย root/alt
  const r = results[FOLK.name + '|travis|normal'];
  const beat = 60 / 100;
  let hit = 0, n = 0, alt = 0;
  for (let k = 0; k < FOLK.beats; k++) {
    n++;
    const b = r.notes.find((x) => x.role === 'bass' && Math.abs(x.t - (0.5 + k * beat)) < 0.08);
    if (b) { hit++; if (k % 2 && r.notes.some((x) => x.role === 'bass' && Math.abs(x.t - (0.5 + (k - 1) * beat)) < 0.08 && x.s !== b.s)) alt++; }
  }
  console.log(`travis: เบสลงจังหวะ ${hit}/${n} · สลับสายบน beat 2/4 ${alt}/${n >> 1}`);
  if (hit / n < 0.9) problems.push(`travis: เบสลงจังหวะแค่ ${hit}/${n}`);
  if (alt / (n >> 1) < 0.8) problems.push(`travis: เบสสลับสายแค่ ${alt}/${n >> 1}`);
}
{
  // ง่าย < ปกติ (จำนวนโน้ตประกอบ) และตำแหน่งมือง่ายต่ำกว่า
  for (const style of STYLES) {
    const e = results[FOLK.name + '|' + style + '|easy'], nn = results[FOLK.name + '|' + style + '|normal'];
    const acc = (r) => r.notes.filter((x) => x.role !== 'melody').length;
    if (acc(e) > acc(nn)) problems.push(`${style}: โหมดง่ายมีโน้ตประกอบ ${acc(e)} มากกว่าปกติ ${acc(nn)}`);
  }
  const easyMax = Math.max(...Object.keys(results).filter((k) => k.endsWith('|easy')).map((k) => results[k].stats.maxFret));
  console.log(`โหมดง่าย: เฟรตสูงสุดทุกเพลง ${easyMax}`);
  if (easyMax > 9) problems.push('โหมดง่าย: เฟรตสูงสุด ' + easyMax + ' (ควรอยู่ตำแหน่งต้นคอ)');
}
{
  // capo ตายตัว + คอร์ดแปลก/สแลช/N.C. + ทำนองนอกช่วงกีตาร์
  const chords = [{ t: 0, chord: 'C/G' }, { t: 2, chord: 'N.C.' }, { t: 4, chord: 'Xyz' }, { t: 6, chord: 'Bbm7' }, { t: 8, chord: 'F#' }, { t: 10, chord: 'G/B' }];
  const melody = [{ t: 0, d: 0.5, midi: 96 }, { t: 1, d: 0.5, midi: 30 }, { t: 2, d: 1, midi: 67 }, { t: 6.5, d: 1, midi: 70 }, { t: 8.2, d: 1, midi: 73 }, { t: 10, d: 1, midi: 74 }];
  for (const style of STYLES) {
    for (const diff of DIFFS) {
      const r = Finger.arrange({ melody, chords, bpm: 120, phase: 0, capo: 2, style, difficulty: diff });
      const fc = Finger.check(r);
      if (r.capo !== 2) problems.push('capo ตายตัว 2 ได้ ' + r.capo);
      if (!fc.ok) problems.push(`เคสขอบ ${style}/${diff}: ${fc.hard.map((h) => h.type + ' ' + h.msg).slice(0, 2).join('; ')}`);
      if (r.notes.filter((n) => n.role === 'melody').length !== melody.length) problems.push(`เคสขอบ ${style}/${diff}: ทำนองหาย`);
      if (r.notes.some((n) => n.role !== 'melody' && n.t >= 2 && n.t < 6)) problems.push(`เคสขอบ ${style}/${diff}: มีเบส/เติมช่วง N.C./คอร์ดอ่านไม่ออก`);
      const gb = r.notes.find((n) => n.role === 'bass' && Math.abs(n.t - 10) < 0.01);
      if (!gb || mod12(gb.midi) !== 11) problems.push(`เคสขอบ ${style}/${diff}: G/B ต้องได้เบส B`);
      checkTab(Finger.toAsciiTab(r), 'เคสขอบ');
    }
  }
  const r = Finger.arrange({ melody, chords, bpm: 120, phase: 0, capo: 2, style: 'chord-melody' });
  console.log('เคสขอบ (capo 2, C/G N.C. Xyz Bbm7 F# G/B, โน้ต 96/30):', r.notes.filter((n) => n.role === 'melody').map((n) => n.midi).join(' '), '·', r.warnings.join(' | '));
  // อินพุตว่าง / มีแต่คอร์ด / มีแต่ทำนอง
  const empty = Finger.arrange({});
  if (empty.notes.length !== 0) problems.push('อินพุตว่างต้องได้ notes ว่าง');
  checkTab(Finger.toAsciiTab(empty), 'ว่าง');
  checkTab(Finger.toAsciiTab([], { bpm: 120 }), 'ว่าง bpm');
  for (const style of STYLES) {
    const co = Finger.arrange({ chords: FOLK.chords, bpm: 100, phase: 0.5, style });
    if (!Finger.check(co).ok || co.notes.length < 20 || co.notes.some((n) => n.role === 'melody')) problems.push(`มีแต่คอร์ด ${style}: ${co.notes.length} โน้ต check=${Finger.check(co).ok}`);
  }
  const mo = Finger.arrange({ melody: FOLK.melody, bpm: 100, phase: 0.5, style: 'travis' });
  if (mo.notes.length !== normMel(FOLK.melody).length || !Finger.check(mo).ok) problems.push('มีแต่ทำนอง: ต้องได้ทำนองครบและเล่นได้');
  // SongDoc v2 melody ({t0,t1,pitch}) ใช้ได้เหมือนกัน
  const v2 = Finger.arrange({ melody: FOLK.melody.map((n) => ({ t0: n.t, t1: n.t + n.d, pitch: n.midi })), chords: FOLK.chords, bpm: 100, phase: 0.5, style: 'travis' });
  if (JSON.stringify(v2.notes) !== JSON.stringify(results[FOLK.name + '|travis|normal'].notes)) problems.push('melody แบบ {t0,t1,pitch} ได้ผลต่างจาก {t,d,midi}');
  // แท็บแบบไม่มี BPM (หลายเสียงต่อคอลัมน์)
  const free = Finger.toAsciiTab(results[FOLK.name + '|chord-melody|normal'].notes, { capo: 0, chords: results[FOLK.name + '|chord-melody|normal'].chords });
  const fc = checkTab(free, 'ไม่มี BPM');
  if (fc.frets !== results[FOLK.name + '|chord-melody|normal'].notes.length) problems.push(`แท็บไม่มี BPM: เฟรต ${fc.frets} ≠ โน้ต`);
  console.log(`อินพุตว่าง/มีแต่คอร์ด/มีแต่ทำนอง/SongDoc v2/แท็บไม่มี BPM (${fc.systems} แถว): ตรวจแล้ว`);
}
{
  // ผลซ้ำได้
  const a = Finger.arrange({ melody: MINOR.melody, bass: MINOR.bass, chords: MINOR.chords, bpm: 90, phase: 0.25, style: 'arpeggio' });
  const b = Finger.arrange({ melody: MINOR.melody, bass: MINOR.bass, chords: MINOR.chords, bpm: 90, phase: 0.25, style: 'arpeggio' });
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push('arrange ไม่ deterministic');
  console.log('deterministic:', JSON.stringify(a) === JSON.stringify(b));
}

/* ---------------- 3) ความเร็ว: เพลง 4 นาที ---------------- */
console.log('\n=== ความเร็ว (เพลง 4 นาที) ===');
{
  const beat = 0.6, songLen = FOLK.beats * beat;
  const reps = Math.ceil(240 / songLen);
  const melody = [], chords = [], bass = [];
  for (let r = 0; r < reps; r++) {
    const off = r * songLen;
    FOLK.melody.forEach((n) => melody.push({ t: n.t + off, d: n.d, midi: n.midi + (r % 3 === 2 ? -12 : 0) }));
    FOLK.chords.forEach((c) => chords.push({ t: c.t + off, chord: c.chord }));
  }
  const times = [];
  for (const style of STYLES) {
    for (const diff of DIFFS) {
      Finger.arrange({ melody, chords, bass, bpm: 100, phase: 0.5, style, difficulty: diff }); // warm-up
      const t0 = process.hrtime.bigint();
      const r = Finger.arrange({ melody, chords, bass, bpm: 100, phase: 0.5, style, difficulty: diff });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      times.push(ms);
      const fc = Finger.check(r);
      if (!fc.ok) problems.push(`4 นาที ${style}/${diff}: ผิดกฎ ${fc.hard.length} จุด`);
      console.log(`${style.padEnd(13)} ${diff.padEnd(7)} ${String(r.notes.length).padStart(5)} โน้ต  ${ms.toFixed(1).padStart(6)} ms`);
    }
  }
  const mx = Math.max(...times);
  console.log(`${(reps * songLen).toFixed(0)} วินาที ${normMel(melody).length} โน้ตทำนอง · ช้าสุด ${mx.toFixed(1)} ms (เป้า < 200 ms)`);
  if (mx > 200) problems.push(`ความเร็ว: เพลง 4 นาทีใช้ ${mx.toFixed(1)} ms > 200 ms`);
}

/* ---------------- 4) ตัวอย่างแท็บ ---------------- */
console.log('\n=== ตัวอย่างแท็บ: ' + FOLK.name + ' · travis · ปกติ (2 แถวแรก) ===');
{
  const r = results[FOLK.name + '|travis|normal'];
  const lines = Finger.toAsciiTab(r).split('\n');
  console.log(lines.slice(0, 22).join('\n'));
  const e = results[LOW.name + '|melody-bass|easy'];
  console.log('\n=== ตัวอย่างแท็บ: ' + LOW.name + ' · melody-bass · ง่าย (capo ' + e.capo + ', แถวแรก) ===');
  console.log(Finger.toAsciiTab(e).split('\n').slice(0, 11).join('\n'));
}

console.log('');
if (problems.length) {
  console.log(`✗ ไม่ผ่าน ${problems.length} ข้อ:`);
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('✓ ผ่านทั้งหมด');
