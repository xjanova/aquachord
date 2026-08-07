#!/usr/bin/env node
/* test-assemble.cjs — เทสต์การประกอบ ChordPro ของ analyze.js ใน Node
   (stub globals ของเบราว์เซอร์ แล้วโหลด analyze.js ผ่าน vm — จับ regression
   ของ header/กริดคอร์ด/การวางคอร์ดบนเนื้อร้องไทย โดยไม่ต้องมี WebAudio)
   ใช้: node tools/test-assemble.cjs */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');

global.window = global;
global.self = global;
global.I18N = {
  t: (k) => ({
    'sheet.header': 'AI วิเคราะห์บนเครื่อง',
    'sheet.aiNote': 'หมายเหตุ AI',
    'sheet.noChords': 'ไม่พบคอร์ด',
    'sheet.lyricsBeta': 'เนื้อร้อง Beta',
    'job.lyr.dl': 'โหลดโมเดล',
    'job.lyr.asr': 'ฟังเสียง',
  }[k] || k),
};
global.Music = { audioCtx: () => { throw new Error('no audio in node'); } };
global.Store = { uid: () => 'sg_test' };
global.DSP = require(path.join(root, 'site/assets/js/dsp.js'));
vm.runInThisContext(fs.readFileSync(path.join(root, 'site/assets/js/analyze.js'), 'utf8'), { filename: 'analyze.js' });

const A = global.Analyze;
const fails = [];
const assert = (c, m) => { if (!c) fails.push(m); };

assert(A.stages(false).join(',') === 'ingest,prep,beats,chords,key,assemble', 'stages(false)');
assert(A.stages(true).join(',') === 'ingest,prep,beats,chords,key,lyrics,assemble', 'stages(true)');

const segs = [
  { chord: null, t0: 0, t1: 0.5 },
  { chord: 'C', t0: 0.5, t1: 4.5 },
  { chord: 'G', t0: 4.5, t1: 8.5 },
  { chord: 'Am', t0: 8.5, t1: 12.5 },
  { chord: 'F', t0: 12.5, t1: 16.5 },
  { chord: 'C', t0: 16.5, t1: 24.5 },
];

// 1) ชีตคอร์ดล้วน — โครงเดิมของ v1.2
const sheet1 = A._test.assembleChordPro(segs, 120, 24.5, 'C', 'ทดสอบ', 0.5);
assert(sheet1.includes('{title: ทดสอบ}') && sheet1.includes('{key: C}') && sheet1.includes('{tempo: 120}'), 'header ครบ');
assert(sheet1.includes('[C]') && sheet1.includes('[G]') && sheet1.includes('[Am]') && sheet1.includes('[F]'), 'มีคอร์ดครบในกริด');
assert(sheet1.includes('{c: ⏱ 0:00}'), 'มี timestamp');

// 2) ชีตมีเนื้อร้อง — คอร์ดแทรกตามเวลา + ท่อนดนตรีเป็นกริด
const chunks = [
  { t0: 4.6, t1: 8.4, text: ' ฉันเดินอยู่ตรงนั้น ' },
  { t0: 8.6, t1: 12.4, text: 'เธอเดินผ่านมา' },
  { t0: 20.5, t1: 24.0, text: 'ใจมันสั่นไหว' },
];
const sheet2 = A._test.assembleWithLyrics(segs, chunks, 120, 0.5, 24.5, 'C', 'ทดสอบ');
assert(sheet2 && sheet2.includes('ฉันเดินอยู่ตรงนั้น'), 'มีบรรทัดเนื้อร้อง');
assert(/\[G\]ฉันเดิน/.test(sheet2), 'คอร์ด G ต้องนำหน้าบรรทัดร้องแรก (เริ่ม 4.6s)');
assert(/\[Am\]เธอเดิน/.test(sheet2), 'คอร์ด Am นำบรรทัดสอง');
assert(sheet2.includes('เนื้อร้อง Beta'), 'มีหมายเหตุ Beta');
assert(!/\][ัำ-ฺ็-๎]/.test(sheet2), 'คอร์ดต้องไม่แทรกกลาง grapheme ไทย');
assert(sheet2.includes('{c: ⏱'), 'ท่อนดนตรีมี timestamp');

// 3) เนื้อร้องว่าง/ขยะล้วน → คืน null ให้ผู้เรียก fallback เป็นชีตคอร์ดล้วน
const junkOnly = A._test.assembleWithLyrics(segs, [{ t0: 1, t1: 2, text: 'ขอบคุณครับ' }], 120, 0.5, 24.5, 'C', 'ทดสอบ');
assert(junkOnly === null, 'chunk ขยะล้วนต้องคืน null ได้ ' + JSON.stringify(junkOnly && junkOnly.slice(0, 40)));

// 4) ไม่มีคอร์ดเลย
const empty = A._test.assembleChordPro([{ chord: null, t0: 0, t1: 10 }], 100, 10, 'C', 'เงียบ', 0);
assert(empty.includes('ไม่พบคอร์ด'), 'เพลงไร้คอร์ดมีข้อความแจ้ง');

if (fails.length) {
  console.error('✗ FAILED:\n- ' + fails.join('\n- '));
  process.exit(1);
}
console.log('✓ test-assemble ผ่านทุกข้อ');
process.exit(0); // MessageChannel ใน analyze.js ค้าง event loop ของ Node — จบชัดเจน
