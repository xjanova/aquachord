#!/usr/bin/env node
/* test-notation.cjs — เทสต์ตัวแปลงโน้ต (notation.js) ใน Node โดยไม่ต้องมีเบราว์เซอร์
   - melodyToAbc: ความยาว/ตัวหยุด/โยงข้ามห้อง/pickup/เครื่องหมายประจำคีย์/octave/เนื้อร้องไทย/โน้ตไทย/transpose/คอร์ด
   - leadSheetFromChordPro
   - ถ้ามี abcjs ในเครื่อง (npm i abcjs หรือ ABCJS_PATH=...) จะตรวจเพิ่มว่า "abcjs เล่นออกมาเป็นเสียง/เวลาเดียวกับ
     ทำนองต้นฉบับจริง" แบบสุ่มหลายร้อยเพลงในทุกคีย์ + แปลงกลับ (abcTuneToMelody) — CI ข้ามส่วนนี้ถ้าไม่มี abcjs
   ใช้: node tools/test-notation.cjs */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');

const ctx = { console, Math, JSON, Date, Array, Object, Number, String, Map, Set, Promise, isFinite, parseInt, parseFloat, RegExp };
ctx.window = ctx;
ctx.I18N = { t: (k) => k, extend: () => {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'site/assets/js/notation.js'), 'utf8'), ctx, { filename: 'notation.js' });
const N = ctx.Notation;

let pass = 0;
const fails = [];
function ok(cond, msg) { if (cond) pass++; else fails.push(msg); }
function eq(a, b, msg) { ok(a === b, msg + ` — ได้ ${JSON.stringify(a)} ต้องการ ${JSON.stringify(b)}`); }

// ส่วนดนตรี (ไม่นับ header / w:) ต่อกันเป็นบรรทัดเดียว เว้นวรรคเดียว
function music(abc) {
  return abc.split('\n').filter((l) => l && !/^[A-Za-z]:/.test(l) && !l.startsWith('%%')).join(' ').replace(/\s+/g, ' ').trim();
}
function wlines(abc) { return abc.split('\n').filter((l) => l.startsWith('w:')).map((l) => l.slice(2).trim()); }
const mel = (notes, extra) => Object.assign({ name: 't', timeSig: [4, 4], keySig: 'C', notes }, extra || {});
const abcOf = (m, o) => N.melodyToAbc(m, o).abc;

/* ---------- 1) ความยาวโน้ต (beat → หน่วย 1/16) ---------- */
[[4, 'C16 |]'], [3, 'C12 z4 |]'], [2, 'C8 z8 |]'], [1.5, 'C6z2 z8 |]'], [1, 'C4 z4 z8 |]'],
  [0.75, 'C3z z4 z8 |]'], [0.5, 'C2z2 z4 z8 |]'], [0.25, 'Czz2 z4 z8 |]']].forEach(([d, want]) => {
  eq(music(abcOf(mel([{ t: 0, d, p: 60 }]))), want, `ความยาว ${d} beat`);
});
// ตัวหยุดคั่นกลาง + ตัวหยุดเขียนตามจังหวะ (ไม่ข้ามจังหวะกลางห้อง)
eq(music(abcOf(mel([{ t: 0, d: 1, p: 60 }, { t: 2, d: 1, p: 62 }]))), 'C4 z4 D4 z4 |]', 'ช่องว่างกลายเป็นตัวหยุด');
eq(music(abcOf(mel([{ t: 0.5, d: 0.5, p: 60 }]))), 'z2C2 z4 z8 |]', 'ตัวหยุดก่อนโน้ตนอกจังหวะ');
eq(music(abcOf(mel([{ t: 0, d: 1, p: null }, { t: 1, d: 1, p: 64 }]))), 'z4 E4 z8 |]', 'p:null = ตัวหยุด');
// ทำนองว่าง → ห้องว่าง 1 ห้อง (ไม่ crash)
eq(music(abcOf(mel([]))), 'z16 |]', 'ทำนองว่าง');
eq(music(abcOf(null)), 'z16 |]', 'melody = null');

/* ---------- 2) โยงข้ามเส้นกั้นห้อง + ความยาวที่เขียนหัวเดียวไม่ได้ ---------- */
eq(music(abcOf(mel([{ t: 3, d: 2, p: 60 }]))), 'z8 z4 C4- | C4 z4 z8 |]', 'โน้ตข้ามห้อง → แยก + โยง');
eq(music(abcOf(mel([{ t: 0, d: 5, p: 67 }]))), 'G16- | G4 z4 z8 |]', 'ยาว 5 beat');
eq(music(abcOf(mel([{ t: 0.25, d: 1.25, p: 60 }]))), 'zC3- C2z2 z8 |]', 'ยาว 1.25 beat นอกจังหวะ → แยกที่จังหวะ');
eq(music(abcOf(mel([{ t: 0, d: 1, p: 60, tie: true }, { t: 1, d: 1, p: 60 }]))), 'C4- C4 z8 |]', 'note.tie = โยงกับตัวถัดไป');
eq(music(abcOf(mel([{ t: 0, d: 1, p: 60, tie: true }, { t: 1, d: 1, p: 62 }]))), 'C4 D4 z8 |]', 'tie กับคนละเสียง → ไม่โยง');

/* ---------- 3) pickup / anacrusis + จังหวะอื่น ---------- */
eq(music(abcOf(mel([{ t: -1, d: 1, p: 55 }, { t: 0, d: 4, p: 60 }], { pickup: 1 }))), 'G,4 | C16 |]', 'pickup 1 beat');
eq(music(abcOf(mel([{ t: -0.5, d: 0.5, p: 55 }, { t: 0, d: 3, p: 60 }], { timeSig: [3, 4] }))), 'G,2 | C12 |]', 'pickup อัตโนมัติจาก t ติดลบ (3/4)');
eq(music(abcOf(mel([{ t: 0, d: 0.5, p: 60 }, { t: 0.5, d: 0.5, p: 62 }, { t: 1, d: 0.5, p: 64 }, { t: 1.5, d: 1.5, p: 65 }], { timeSig: [6, 8] }))),
  'C2D2E2 F6 |]', '6/8 จัดกลุ่มเขบ็ตทีละ 3');
ok(abcOf(mel([], { timeSig: [6, 8] })).includes('M:6/8'), 'M:6/8 ใน header');
ok(abcOf(mel([], { timeSig: [7, 3] })).includes('M:4/4'), 'จังหวะเสีย → 4/4');

/* ---------- 4) คีย์ + accidental ในห้อง ---------- */
{
  const a = abcOf(mel([{ t: 0, d: 1, p: 66 }, { t: 1, d: 1, p: 65 }, { t: 2, d: 1, p: 65 }, { t: 3, d: 1, p: 66 }, { t: 4, d: 1, p: 66 }], { keySig: 'G' }));
  ok(a.includes('K:G\n'), 'K:G');
  eq(music(a), 'F4 =F4 F4 ^F4 | F4 z4 z8 |]', 'คีย์ G: F# ไม่ต้องใส่, F ธรรมดาใส่ = ครั้งเดียวในห้อง, กลับเป็น F# ต้องใส่ ^, ห้องใหม่รีเซ็ต');
}
eq(music(abcOf(mel([{ t: 0, d: 1, p: 70 }, { t: 1, d: 1, p: 71 }, { t: 2, d: 1, p: 82 }], { keySig: 'F' }))), 'B4 =B4 b4 z4 |]', 'คีย์ F: Bb/B ธรรมดา, accidental มีผลเฉพาะ octave เดียวกัน');
eq(music(abcOf(mel([{ t: 0, d: 1, p: 61 }, { t: 1, d: 1, p: 62 }], { keySig: 'Dm' }))), '^C4 D4 z8 |]', 'Dm: leading tone = C# (ไม่ใช่ Db)');
eq(music(abcOf(mel([{ t: 0, d: 1, p: 68 }, { t: 1, d: 1, p: 69 }], { keySig: 'Am' }))), '^G4 A4 z8 |]', 'Am: G#');
eq(music(abcOf(mel([{ t: 0, d: 1, p: 61 }, { t: 1, d: 1, p: 70 }], { keySig: 'C' }))), '^C4 _B4 z8 |]', 'C: C# และ Bb');
eq(music(abcOf(mel([{ t: 0, d: 1, p: 66 }], { keySig: 'Eb' }))), '_G4 z4 z8 |]', 'คีย์แฟลต: F# สะกด Gb');
ok(abcOf(mel([], { keySig: 'D#' })).includes('K:Eb\n'), 'คีย์ D# → Eb');
ok(abcOf(mel([], { keySig: '<script>' })).includes('K:C\n'), 'คีย์เสีย → C');
ok(abcOf(mel([], { keySig: 'Bbm' })).includes('K:Bbm\n'), 'K:Bbm');

/* ---------- 5) octave: 'C' = C4 (middle C), 'c' = C5 ---------- */
[[60, 'C'], [72, 'c'], [48, 'C,'], [84, "c'"], [59, 'B,'], [71, 'B'], [83, 'b'], [36, 'C,,'], [96, "c''"]].forEach(([p, want]) => {
  eq(music(abcOf(mel([{ t: 0, d: 4, p }]))), want + '16 |]', `MIDI ${p} → ${want}`);
});
eq(N.noteName(60), 'C4', 'noteName C4');
eq(N.noteName(70, 'F'), 'Bb4', 'noteName Bb4 ในคีย์ F');

/* ---------- 6) เนื้อร้องไทย (w:) ---------- */
{
  const m = mel([
    { t: 0, d: 1, p: 60, syl: 'จาก' }, { t: 1, d: 1, p: 62, syl: 'ทุ่ง' }, { t: 2, d: 1, p: 64, syl: '_' },
    { t: 3, d: 2, p: 65, syl: 'นา' }, { t: 5, d: 1, p: null }, { t: 6, d: 1, p: 67 },
  ]);
  const a = abcOf(m);
  const w = wlines(a);
  eq(w.length, 1, 'มีบรรทัด w: 1 บรรทัด');
  eq(w[0], 'จาก ทุ่ง _ นา _ *', 'พยางค์ต่อโน้ต: _ = ลากเสียง, ชิ้นที่โยงข้ามห้อง = _, ไม่มีพยางค์ = *, ตัวหยุดไม่กินพยางค์');
  ok(!/(^|\s)-|-(\s|$)/.test(w[0]), 'ไม่มี - คั่นพยางค์');
  const b = abcOf(mel([{ t: 0, d: 1, p: 60, syl: 'ร็อก-แอนด์ โรล' }, { t: 1, d: 1, p: 62, syl: 'a%b|c*d"e' }, { t: 2, d: 1, p: 64, syl: 'x\nX:2\nT:hack' }]));
  const wb = wlines(b)[0];
  ok(wb.split(' ').length === 3, 'พยางค์ที่มีช่องว่าง/อักขระพิเศษยังเป็น 1 ช่อง: ' + wb);
  ok(!wb.includes('-') && wb.includes('\u2010'), 'ขีดในพยางค์ใช้ U+2010 (abcjs ไม่ตีเป็นตัวคั่น)');
  ok(!/[%|*"]/.test(wb.replace(/^\*| \*/g, '')), 'ตัด % | * " ออกจากพยางค์');
  ok(b.split('\n').filter((l) => /^T:/.test(l)).length === 0 && !/\nX:2/.test(b), 'newline ในพยางค์แทรก header ไม่ได้');
  const none = abcOf(mel([{ t: 0, d: 1, p: 60 }]));
  eq(wlines(none).length, 0, 'ไม่มีเนื้อร้อง → ไม่มีบรรทัด w:');
}

/* ---------- 7) โน้ตไทย (w: บรรทัดที่สอง) ---------- */
{
  const m = mel([{ t: 0, d: 1, p: 60, syl: 'ก' }, { t: 1, d: 1, p: 66 }, { t: 2, d: 1, p: 70 }, { t: 3, d: 1, p: 72 },
    { t: 4, d: 1, p: 59 }, { t: 5, d: 1, p: 64 }, { t: 6, d: 1, p: 67 }]);
  const fixed = wlines(abcOf(m, { thaiSolfege: true, solfegeMode: 'fixed' }));
  eq(fixed.length, 2, 'มีเนื้อร้อง + โน้ตไทย = 2 บรรทัด w:');
  eq(fixed[1], 'ด ฟ♯ ท♭ ด\u0E4D ท\u0E3A ม ซ', 'fixed ด=C: C4=ด, F#=ฟ♯, Bb=ท♭, C5=ดํ (นิคหิต), B3=ทฺ (พินทุ)');
  const onlySol = wlines(abcOf(mel([{ t: 0, d: 1, p: 67 }, { t: 1, d: 1, p: 69 }, { t: 2, d: 1, p: 71 }, { t: 3, d: 1, p: 72 }, { t: 4, d: 1, p: 74 }, { t: 5, d: 1, p: 66 }], { keySig: 'G' }),
    { thaiSolfege: true, solfegeMode: 'movable' }));
  eq(onlySol.length, 1, 'ไม่มีเนื้อร้อง → โน้ตไทยบรรทัดเดียว');
  eq(onlySol[0], 'ด ร ม ฟ ซ ท\u0E3A', 'movable คีย์ G: G=ด … F#(ต่ำกว่า ด) = ทฺ');
  const am = wlines(abcOf(mel([{ t: 0, d: 1, p: 69 }, { t: 1, d: 1, p: 68 }, { t: 2, d: 1, p: 72 }], { keySig: 'Am' }), { thaiSolfege: true, solfegeMode: 'movable' }));
  eq(am[0], 'ล ซ♯ ด\u0E4D', 'movable Am (la-based): A=ล, G#=ซ♯');
  const fl = wlines(abcOf(mel([{ t: 0, d: 1, p: 65 }, { t: 1, d: 1, p: 70 }, { t: 2, d: 1, p: 71 }], { keySig: 'F' }), { thaiSolfege: true, solfegeMode: 'movable' }));
  eq(fl[0], 'ด ฟ ฟ♯', 'movable F: Bb=ฟ, B=ฟ♯');
  const tie = wlines(abcOf(mel([{ t: 3, d: 2, p: 60 }]), { thaiSolfege: true }));
  eq(tie[0], 'ด _', 'ชิ้นที่โยงข้ามห้อง = _ ในโน้ตไทย');
  eq(N.solfegeName(72, 'C', 'fixed'), 'ด\u0E4D', 'solfegeName C5');
}

/* ---------- 8) transpose ---------- */
{
  const m = mel([{ t: 0, d: 2, p: 60, chord: 'C' }, { t: 2, d: 2, p: 69, chord: 'Am7' }]);
  const up = N.melodyToAbc(m, { transpose: 2 });
  eq(up.key, 'D', 'C +2 = D');
  eq(music(up.abc), '"D"D8 "Bm7"B8 |]', 'transpose +2 โน้ตและคอร์ด');
  const dn = N.melodyToAbc(m, { transpose: -2 });
  eq(dn.key, 'Bb', 'C -2 = Bb');
  eq(music(dn.abc), '"Bb"B,8 "Gm7"G8 |]', 'transpose -2 ในคีย์แฟลต (Bb อยู่ในเครื่องหมายประจำคีย์)');
  eq(N.melodyToAbc(mel([], { keySig: 'Am' }), { transpose: 1 }).key, 'Bbm', 'Am +1 = Bbm');
  eq(N.melodyToAbc(mel([], { keySig: 'G' }), { transpose: 12 }).key, 'G', '+12 = คีย์เดิม');
  eq(N.transposeChordName('F#m/C#', 1, N.keyInfo('G')), 'Gm/D', 'transpose คอร์ดมี bass');
}

/* ---------- 9) คอร์ด ---------- */
{
  eq(music(abcOf(mel([{ t: 0, d: 2, p: 57, chord: 'Am7' }]))), '"Am7"A,8 z8 |]', 'คอร์ดเหนือโน้ต');
  eq(music(abcOf(mel([{ t: 0, d: 2, p: 57, chord: 'X"y' }]))), 'A,8 z8 |]', 'ชื่อคอร์ดเสีย/มีเครื่องหมายคำพูด → ไม่ใส่');
  const c = N.melodyToAbc(mel([{ t: 0, d: 2, p: 60 }]), { chords: [{ t: 0, chord: 'C' }, { t: 1, chord: 'G7' }, { t: 3, chord: 'F' }] });
  eq(music(c.abc), '"C"C4- "G7"C4 z4 "F"z4 |]', 'คอร์ดกลางโน้ต → แยกโน้ตแล้วโยง, คอร์ดบนตัวหยุด');
  const late = N.melodyToAbc(mel([{ t: 0, d: 1, p: 60 }]), { chords: [{ t: 5, chord: 'D' }] });
  ok(music(late.abc).includes('"D"z4'), 'คอร์ดหลังโน้ตตัวสุดท้าย → ขยายห้องให้');
}

/* ---------- 10) noteMap ชี้กลับโน้ตต้นฉบับถูกตัว ---------- */
{
  const m = mel([{ t: 0, d: 1, p: 60 }, { t: 1, d: 4, p: 62, chord: 'G' }, { t: 5, d: 1, p: null }, { t: 6, d: 1, p: 64 }]);
  const r = N.melodyToAbc(m);
  const items = r.noteMap.items;
  ok(items.length > 0, 'มี noteMap');
  items.forEach((it, i) => {
    eq(r.noteMap.byStart[it.start], i, 'byStart ชี้ item ถูกตัว #' + i);
    const s = r.abc.slice(it.start, it.end);
    ok(/^("[^"]*")*[_^=]*[A-Ga-gzx]/.test(s), 'ช่วงอักขระของ item เป็นโน้ต/ตัวหยุด: ' + s);
  });
  eq((r.noteMap.noteItems[1] || []).length, 2, 'โน้ตยาวข้ามห้อง = 2 item');
  eq(r.abc.slice(items[r.noteMap.noteItems[1][0]].start, items[r.noteMap.noteItems[1][0]].end), '"G"D12-', 'item แรกของโน้ต #1 รวมคอร์ดและเส้นโยง');
  eq(items[r.noteMap.noteItems[3][0]].p, 64, 'noteItems[3] = E4');
  eq(r.noteMap.noteItems[2][0] >= 0 && items[r.noteMap.noteItems[2][0]].rest, true, 'ตัวหยุดใน melody ก็ map ได้');
}

/* ---------- 11) ข้อมูลเสีย/ถูกแก้ ---------- */
{
  const r = N.melodyToAbc(mel([{ t: 0, d: 2, p: 60 }, { t: 1, d: 2, p: 64 }, { t: 'x', d: 1, p: 60 }, { t: 3, d: NaN, p: 60 },
    { t: 3, d: 1, p: 'abc' }, null, 5, { t: 3, d: 1, p: 999 }]));
  ok(r.warnings.indexOf('overlap') >= 0, 'โน้ตซ้อนกัน → warning overlap');
  eq(music(r.abc), 'C4 E8 ' + "b'''" + '4 |]', 'ตัดโน้ตที่ซ้อน/ข้อมูลเสีย, ระดับเสียงถูก clamp');
  const big = [];
  for (let i = 0; i < 6000; i++) big.push({ t: i * 0.5, d: 0.5, p: 60 + (i % 12), syl: 'ลา' });
  const t0 = Date.now();
  const rb = N.melodyToAbc({ timeSig: [4, 4], notes: big }, { thaiSolfege: true });
  const ms = Date.now() - t0;
  ok(rb.warnings.indexOf('too-many-notes') >= 0, 'เกิน 5000 โน้ต → ตัด + warning');
  ok(ms < 1500, 'ทำนอง 5000 โน้ตแปลงเร็วพอ (' + ms + ' ms)');
  const tt = N.melodyToAbc(mel([{ t: 0, d: 1, p: 60 }]), { title: 'ชื่อ\nX:9\n%%hack' });
  ok(/^T:ชื่อ X:9 hack$/m.test(tt.abc) && !/^X:9/m.test(tt.abc), 'ชื่อเพลงมี newline/% แทรก header ไม่ได้');
  ok(N.melodyToAbc(mel([{ t: 0, d: 1, p: 60 }], { tempo: 1e9 })).abc.includes('Q:1/4=90'), 'tempo เพี้ยน → 90');
}

/* ---------- 12) จัดบรรทัดตามความกว้าง (มือถือ) ---------- */
{
  const notes = [];
  for (let i = 0; i < 64; i++) notes.push({ t: i * 0.25, d: 0.25, p: 60 + (i % 8), syl: 'ยาว' });
  const narrow = N.melodyToAbc(mel(notes), { lineWidth: 320 });
  const wide = N.melodyToAbc(mel(notes), { lineWidth: 2000, maxBarsPerLine: 8 });
  ok(narrow.lines > wide.lines, `จอแคบได้หลายบรรทัดกว่า (${narrow.lines} > ${wide.lines})`);
  eq(narrow.abc.split('\n').filter((l) => l.startsWith('w:')).length, narrow.lines, 'ทุกบรรทัดดนตรีมีบรรทัด w: ของตัวเอง');
}

/* ---------- 13) lead sheet จาก ChordPro ---------- */
{
  const cp = '{title: t}\n{c: 🎯 Key C · 90 BPM}\n{c: ⏱ 0:00}\n{soc}\n[C] [G] | [Am] | [F] | [C]   (×2)\n[Am]ฟองคลื่น [F]ลอยไป\n{c: Solo}\n[N.C.] [G7]\n[Intro]\n';
  const r = N.leadSheetFromChordPro(cp, [4, 4], { keySig: 'C' });
  const m = music(r.abc);
  eq(r.bars, 13, 'จำนวนห้อง: กริด 4 ห้อง ×2 + 2 + 2 + [Intro]');
  ok(m.startsWith('"^Chorus""C"x8 "G"x8 | "Am"x16 | "F"x16 | "C"x16 |'), 'ห้องแรก 2 คอร์ดแบ่งครึ่ง + ป้ายท่อน: ' + m.slice(0, 60));
  ok(!/⏱|🎯/.test(r.abc), 'ข้ามป้ายเมตาของ AI');
  ok(m.includes('"^Solo · N.C."x16') || m.includes('"^Solo"') , 'N.C. + ป้าย Solo');
  ok(m.includes('"G7"x16'), 'คอร์ดหลัง N.C.');
  const tr = N.leadSheetFromChordPro('[C] [F]', [3, 4], { keySig: 'C', transpose: 5 });
  eq(music(tr.abc), '"F"x12 | "Bb"x12 |]', 'lead sheet transpose +5 (สะกดแฟลต) 3/4');
  ok(tr.abc.includes('K:F\n'), 'คีย์ lead sheet ตาม transpose');
  eq(music(N.leadSheetFromChordPro('', [4, 4]).abc), 'z16 |]', 'ChordPro ว่าง → ห้องว่าง');
  const many = N.leadSheetFromChordPro(Array(3000).fill('[C] [G]').join('\n'), [4, 4]);
  ok(many.bars <= 1000, 'lead sheet จำกัด 1000 ห้อง');
}

/* ---------- 14) (ถ้ามี abcjs) เทียบกับเสียงที่ abcjs เล่นจริง + แปลงกลับ ---------- */
let A = null;
try { A = require(process.env.ABCJS_PATH || 'abcjs'); } catch (e) { A = null; }
if (!A) {
  console.log('⏭  ข้ามส่วนตรวจกับ abcjs จริง (ไม่พบ abcjs — npm i abcjs@6.7.1 หรือตั้ง ABCJS_PATH)');
} else {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
    'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm'];
  const TS = [[4, 4], [3, 4], [2, 4], [6, 8], [5, 4], [12, 8], [2, 2]];
  const DS = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25, 1.25, 2.5];
  let checked = 0, rtOk = 0;
  for (let n = 0; n < 300; n++) {
    const key = KEYS[n % KEYS.length];
    const ts = TS[n % TS.length];
    const bar = ts[0] * 4 / ts[1];
    const pickup = n % 3 === 0 ? Math.floor(rnd() * bar * 4) / 4 : 0;
    const notes = [];
    let t = -pickup;
    const len = 5 + Math.floor(rnd() * 40);
    for (let i = 0; i < len; i++) {
      const d = DS[Math.floor(rnd() * DS.length)];
      const rest = rnd() < 0.12;
      const note = { t, d, p: rest ? null : 48 + Math.floor(rnd() * 36) };
      if (!rest && rnd() < 0.5) note.syl = ['จาก', 'ทุ่ง', 'นา', '_', 'รัก', 'เธอ'][Math.floor(rnd() * 6)];
      if (!rest && rnd() < 0.2) note.chord = ['C', 'Am7', 'F#m', 'Bb', 'G7/B'][Math.floor(rnd() * 5)];
      notes.push(note);
      t += d;
    }
    const m = { timeSig: ts, keySig: key, pickup, tempo: 100, notes };
    const tr = [0, 3, -5][n % 3];
    const r = N.melodyToAbc(m, { thaiSolfege: n % 2 === 0, solfegeMode: n % 4 === 0 ? 'movable' : 'fixed', transpose: tr, lineWidth: 300 + (n % 5) * 200 });
    const tune = A.parseOnly(r.abc)[0];
    if (tune.warnings && tune.warnings.length) fails.push(`abcjs เตือน (${key} ${ts}): ${tune.warnings[0]}`);
    const got = tune.setUpAudio({}).tracks[0].filter((e) => e.cmd === 'note').map((e) => [e.pitch, Math.round(e.start * 16), Math.round(e.duration * 16)]);
    // abcjs รวมโน้ตที่โยงกันเป็นเสียงเดียว → เทียบกับ "เสียง" ของต้นฉบับ (รวม tie ระหว่างโน้ตด้วย)
    const want = [];
    notes.forEach((x) => {
      if (x.p == null) return;
      want.push([x.p + tr, Math.round((x.t + pickup) * 4), Math.round(x.d * 4)]);
    });
    const same = JSON.stringify(got) === JSON.stringify(want);
    ok(same, `abcjs เล่นตรงต้นฉบับ #${n} (${key}, ${ts.join('/')}, pickup ${pickup}, tr ${tr})` + (same ? '' : `\n   ต้องการ ${JSON.stringify(want.slice(0, 8))}\n   ได้     ${JSON.stringify(got.slice(0, 8))}`));
    checked++;
    // แปลงกลับ
    const back = N.abcTuneToMelody(tune).melody;
    const backNotes = back.notes.filter((x) => x.p != null).map((x) => [x.p, Math.round(x.t * 4), Math.round(x.d * 4)]);
    const wantBack = want.map((w) => [w[0], w[1] - Math.round(pickup * 4), w[2]]);
    if (JSON.stringify(backNotes) === JSON.stringify(wantBack) && back.keySig === N.transposeKeyName(key, tr) && (back.pickup || 0) === pickup) rtOk++;
    else fails.push(`แปลงกลับไม่ตรง #${n} (${key} ${ts} pickup ${pickup}): ${JSON.stringify(backNotes.slice(0, 5))} vs ${JSON.stringify(wantBack.slice(0, 5))} key ${back.keySig} pickup ${back.pickup}`);
  }
  console.log(`  abcjs ${A.signature || ''}: ตรวจ ${checked} ทำนองสุ่ม (ทุกคีย์/จังหวะ) · แปลงกลับตรง ${rtOk}/${checked}`);
  // เนื้อร้องที่ abcjs อ่านได้ตรงโน้ต
  const lt = A.parseOnly(N.melodyToAbc(mel([{ t: 0, d: 1, p: 60, syl: 'จาก' }, { t: 1, d: 1, p: null }, { t: 2, d: 3, p: 62, syl: 'ทุ่ง' }, { t: 5, d: 1, p: 64, syl: 'นา' }])).abc)[0];
  const syls = [];
  lt.lines.forEach((l) => l.staff && l.staff[0].voices[0].forEach((e) => { if (e.el_type === 'note' && !e.rest) syls.push(e.lyric ? e.lyric[0].syllable : null); }));
  eq(JSON.stringify(syls), JSON.stringify(['จาก', 'ทุ่ง', '', 'นา']), 'abcjs วางพยางค์ถูกโน้ต (ข้ามตัวหยุด, ชิ้นโยง = ลากเสียง)');
  // MIDI
  const midi = A.synth.getMidiFile(N.melodyToAbc(mel([{ t: 0, d: 1, p: 60 }]), { title: 'x' }).abc, { midiOutputType: 'binary' });
  ok(midi && midi[0] && midi[0][0] === 0x4d && midi[0][1] === 0x54, 'getMidiFile ได้ไฟล์ MIDI (MThd)');
}

if (fails.length) {
  console.error('✗ test-notation: ' + fails.length + ' ข้อไม่ผ่าน\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log(`✓ test-notation ผ่าน ${pass} ข้อ`);
