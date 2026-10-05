#!/usr/bin/env node
/* test-polish.cjs — เกลาโน้ตตามหลักดนตรี (site/assets/js/polish.js)
   1. กติกาทีละข้อ: ต้องแก้สิ่งที่ผิด และต้องไม่แตะสิ่งที่ถูก (โน้ตซ้ำจริง · เบสกระโดดออกเทฟ · ช่วงพักจริง · กลอง)
   2. ผลบนโน้ตที่ถอดด้วยโมเดลจริงในเบราว์เซอร์ (test-polish.fixture.json: เพลงสังเคราะห์ 4 เพลง lite/full —
      2 เพลงไม่ได้ใช้ตอนตั้งกติกา) เทียบโน้ตจริงที่สร้างใหม่จาก seed ด้วย synth-song.cjs:
      F1 (onset ±50ms + pitch ตรง) ของเบส/ทำนอง/คอร์ด ต้องไม่ลดลง และทำนอง/คอร์ดเฉลี่ยต้องดีขึ้น */
'use strict';
const path = require('path');
const fs = require('fs');
const Polish = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'polish.js'));
const { synthSong, evalNotes } = require('./synth-song.cjs');

const fails = [];
const t = (c, m) => { if (!c) fails.push(m); };
const N = (t0, d, midi, vel) => ({ t: t0, d, midi, vel: vel == null ? 0.7 : vel });
const TS = (tracks, bpm) => ({ v: 1, source: 'full', bpm: bpm || 120, phase: 0, duration: 20, tracks });
const tr = (id, notes, kind) => ({ id, kind: kind || 'pitched', program: 0, notes });
const notesOf = (ts, id) => ts.tracks.find((x) => x.id === id).notes;

console.log('=== เกลาโน้ต: กติกาทีละข้อ ===');
// bpm 120 → beat 0.5 s, 16th 0.125 s
{ // 1) รวมท่อน
  const ts = TS([
    tr('harmony', [N(0, 0.45, 60, 0.7), N(0.45, 0.5, 60, 0.5), N(0, 1, 64), N(0, 1, 67)]), // ตัวหลังเบากว่า → รวม
    tr('melody', [N(0, 0.25, 72), N(0.25, 0.25, 72), N(0.5, 0.31, 74), N(0.81, 0.3, 74), N(1.25, 0.2, 76), N(1.5, 0.2, 77), N(1.75, 0.2, 79)]),
  ]);
  const p = Polish.polish(ts, {});
  const h = notesOf(p, 'harmony').filter((n) => n.midi === 60);
  t(h.length === 1 && Math.abs(h[0].t + h[0].d - 0.95) < 1e-6, 'คอร์ด: ท่อนที่แตก (ตัวหลังเบากว่า) ต้องรวมเป็นโน้ตเดียว ได้ ' + JSON.stringify(h));
  const m72 = notesOf(p, 'melody').filter((n) => n.midi === 72), m74 = notesOf(p, 'melody').filter((n) => n.midi === 74);
  t(m72.length === 2, 'ทำนอง: โน้ตซ้ำที่ลงกริด 16th ต้องคงไว้ 2 ตัว ได้ ' + m72.length);
  t(m74.length === 1, 'ทำนอง: ท่อนที่เริ่มนอกกริด (0.81) ต้องรวม ได้ ' + m74.length);
  t(notesOf(ts, 'harmony').length === 4, 'ต้องไม่แก้ TrackSet เดิม');
}
{ // 2) ออกเทฟหลุด
  const mel = [72, 74, 76, 62, 77, 76, 74].map((m, i) => N(i * 0.25, 0.24, m)); // 62 = ยอดแหลมเดี่ยวต่ำไป 1 ออกเทฟ
  const run = [72, 74, 60, 62, 64, 62, 74, 76].map((m, i) => N(i * 0.25, 0.24, m)); // ช่วงต่ำต่อเนื่อง 4 ตัว = ไม่ใช่ยอดเดี่ยว
  const bass = [36, 48, 36, 43, 36, 48, 36, 43].map((m, i) => N(i * 0.25, 0.24, m));
  const p = Polish.polish(TS([tr('melody', mel), tr('vocals', run), tr('bass', bass)]), {});
  t(notesOf(p, 'melody')[3].midi === 74, 'ทำนอง: ยอดแหลมหลุดออกเทฟต้องขยับกลับ (62→74) ได้ ' + notesOf(p, 'melody')[3].midi);
  t(notesOf(p, 'vocals').map((n) => n.midi).join() === run.map((n) => n.midi).join(), 'ช่วงต่ำต่อเนื่องหลายตัวต้องไม่ถูกย้าย');
  t(notesOf(p, 'bass').map((n) => n.midi).join() === bass.map((n) => n.midi).join(), 'เบสกระโดดออกเทฟ (root→octave) ต้องไม่ถูกแก้');
  t(p._polish.octave === 1, 'นับการแก้ออกเทฟ 1 ครั้ง ได้ ' + p._polish.octave);
}
{ // 3) คอร์ดเข้าช้า + 5) เสียงหลุดคอร์ด
  const chords = [{ t: 0, chord: 'C' }, { t: 2, chord: 'F' }];
  const ts = TS([tr('piano', [N(0, 1.9, 48), N(0, 1.9, 55), N(0.3, 1.6, 64), N(0.25, 0.1, 61, 0.2), N(1.0, 0.8, 62, 0.9)])]);
  const p = Polish.polish(ts, { chords });
  const ns = notesOf(p, 'piano');
  const e = ns.find((n) => n.midi === 64);
  t(e && e.t === 0 && Math.abs(e.d - 1.9) < 1e-6, 'เสียงในคอร์ด (E) ที่เข้าช้า 0.3s ต้องเลื่อนไปเริ่มพร้อมคอร์ด ได้ ' + JSON.stringify(e));
  t(!ns.some((n) => n.midi === 61), 'เสียงหลุดคอร์ด (C#) สั้นและเบา ต้องถูกทิ้ง');
  t(ns.some((n) => n.midi === 62), 'เสียงนอกคอร์ดที่ดังพอ (D ยาว 0.8s แรง) ต้องคงไว้ (โน้ตผ่าน/เทนชันจริง)');
}
{ // 6) เติมช่วงคอร์ดที่ถอดตกหล่น — ช่วงพักจริงห้ามเติม
  const bar = 2;
  const chords = ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'].map((c, i) => ({ t: i * bar, chord: c }));
  const V = { C: [60, 64, 67], G: [59, 62, 67], Am: [57, 60, 64], F: [57, 60, 65] };
  const notes = [];
  chords.forEach((c, i) => { if (i === 6 || i === 3 || i === 4) return; V[c.chord].forEach((m) => notes.push(N(c.t, bar - 0.05, m))); });
  const p = Polish.polish(TS([tr('harmony', notes)]), { chords });
  const filled = notesOf(p, 'harmony').filter((n) => n.fill);
  t(filled.length === 3 && filled.every((n) => n.t === 12) && filled.map((n) => n.midi).sort().join() === '57,60,64',
    'ช่องโหว่ช่วงเดียว (Am ห้องที่ 7) ต้องเติมด้วยท่า Am ที่เพลงเคยใช้ (57,60,64) ได้ ' + JSON.stringify(filled));
  t(!notesOf(p, 'harmony').some((n) => n.fill && (n.t === 6 || n.t === 8)), 'ช่วงเงียบติดกัน 2 ช่วง (พักจริง) ต้องไม่เติม');
}
{ // 4) ลากเสียงให้พอ
  const p = Polish.polish(TS([tr('melody', [N(0, 0.1, 72), N(0.5, 0.4, 74), N(2.5, 0.2, 76), N(2.75, 0.2, 77)]), tr('drums', [N(0, 0.1, 36), N(0.5, 0.1, 38)], 'drums')]), {});
  const m = notesOf(p, 'melody');
  t(Math.abs(m[0].d - 0.48) < 1e-6, 'ทำนอง: ดังไม่ถึงครึ่งช่อง (0.1/0.5) ต้องยืดชิดโน้ตถัดไป ได้ ' + m[0].d);
  t(Math.abs(m[1].d - 0.4) < 1e-6, 'ช่วงพักยาว 1.6 วิ (> 1 จังหวะ) ต้องไม่ยืด ได้ ' + m[1].d);
  t(JSON.stringify(notesOf(p, 'drums')) === JSON.stringify([N(0, 0.1, 36), N(0.5, 0.1, 38)]), 'กลองต้องไม่ถูกแตะ');
}

console.log('\n=== เกลาโน้ตบนโน้ตที่ถอดด้วยโมเดลจริง (เทียบโน้ตจริงของเพลงสังเคราะห์) ===');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-polish.fixture.json'), 'utf8'));
const ROLE = { bass: 'bass', melody: 'melody', vocals: 'melody', harmony: 'harmony', piano: 'harmony', guitar: 'harmony', other: 'harmony' };
const sum = { melody: [0, 0], harmony: [0, 0] };
for (const it of FX) {
  const truth = synthSong(it.song).truth;
  const ts = Object.assign({}, it.ts, { tracks: it.ts.tracks.map((x) => ({ id: x.id, kind: x.kind, program: x.program, notes: x.n.map(([t0, d, midi, vel]) => ({ t: t0, d, midi, vel })) })) });
  const p = Polish.polish(ts, { chords: it.timeline.map(([t0, chord]) => ({ t: t0, chord })) });
  const row = [];
  for (const role of ['bass', 'melody', 'harmony']) {
    const pick = (s) => s.tracks.filter((x) => ROLE[x.id] === role).flatMap((x) => x.notes).sort((a, b) => a.t - b.t);
    const b = evalNotes(pick(ts), truth[role]).F1, a = evalNotes(pick(p), truth[role]).F1;
    row.push(`${role} ${(b * 100).toFixed(0)}→${(a * 100).toFixed(0)}`);
    if (a + 0.005 < b) fails.push(`${it.song.name} ${it.mode} ${role}: F1 ลดลง ${(b * 100).toFixed(1)} → ${(a * 100).toFixed(1)}`);
    if (sum[role]) { sum[role][0] += b; sum[role][1] += a; }
  }
  console.log(`${it.song.name} ${it.mode.padEnd(4)} ${row.join(' · ')}  ${JSON.stringify(p._polish)}`);
}
for (const role of ['melody', 'harmony']) {
  const [b, a] = sum[role].map((x) => (x / FX.length) * 100);
  console.log(`เฉลี่ย ${role}: ${b.toFixed(1)} → ${a.toFixed(1)}`);
  if (a < b + 2) fails.push(`${role}: เฉลี่ยดีขึ้นไม่ถึง 2 จุด (${b.toFixed(1)} → ${a.toFixed(1)})`);
}

if (fails.length) { console.error('\n✗ FAILED:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('\n✓ ผ่านทุกข้อ');
