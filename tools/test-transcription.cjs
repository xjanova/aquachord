#!/usr/bin/env node
/* test-transcription.cjs — เทสต์ตัวแปลงผลถอดเพลงจาก GPU (TranscriptionResult v1 → SongDoc v2)
   โหลดไฟล์จริง i18n.js / music.js / chordpro.js / store.js / transcription.js ผ่าน vm
   (shim แค่ localStorage + document ขั้นต่ำ) แล้วตรวจ:
   - คอร์ดวางตรงขอบพยางค์ไทย ไม่คั่นสระ/วรรณยุกต์ ไม่ตามหลังสระหน้า (เ แ โ ใ ไ)
   - ช่วงดนตรี/อินโทรเป็นแถวห้อง, เพลงไม่มีเนื้อเป็นกริดคอร์ดล้วน, ท่อน {c: Verse}
   - ทำนอง: pickup, quantize 1/4 beat, แก้โน้ตซ้อน, พยางค์/"_", คอร์ดบนโน้ต, ตัดเส้นกั้นห้อง
   - ข้อมูลเสีย (NaN, ไม่เรียง, label แปลก, format ผิด) → ผลปลอดภัยหรือ error ชัดเจน
   ใช้: node tools/test-transcription.cjs */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');

const mem = new Map();
global.window = global;
global.self = global;
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
global.document = { documentElement: { setAttribute() {} }, querySelectorAll: () => [] };
for (const f of ['i18n.js', 'music.js', 'chordpro.js', 'store.js', 'transcription.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'site/assets/js', f), 'utf8'), { filename: f });
}
const T = global.Transcription;

const fails = [];
let checks = 0;
const assert = (c, m) => { checks++; if (!c) fails.push(m); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m + '\n    got:  ' + JSON.stringify(a) + '\n    want: ' + JSON.stringify(b));

const COMB_AFTER_CHORD = /\][\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]/;
const CHORD_AFTER_LEADING = /[\u0E40-\u0E44]\[/;
const ALLOWED_D = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25];

function lyricLines(cp) {
  return cp.split('\n').filter((l) => l.trim() && !/^\{.*\}$/.test(l.trim()));
}
function stripChords(l) { return l.replace(/\[[^\]]*\]/g, ''); }
function checkSheet(doc, name) {
  const parsed = global.ChordPro.parse(doc.chordpro);
  assert(parsed && Array.isArray(parsed.lines) && parsed.lines.length > 0, name + ': ChordPro.parse ได้บรรทัด');
  assert(parsed.meta.title === doc.title, name + ': {title} ตรงกับ doc.title (' + parsed.meta.title + ')');
  parsed.lines.forEach((ln) => {
    if (ln.type !== 'line') return;
    ln.segs.forEach((s) => {
      if (s.chord == null) return;
      assert(s.chord === 'N.C.' || global.Music.isChord(s.chord), name + ': คอร์ดต้อง parse ได้ [' + s.chord + ']');
    });
  });
  lyricLines(doc.chordpro).forEach((l) => {
    assert(!COMB_AFTER_CHORD.test(l), name + ': คอร์ดคั่นกลาง grapheme ไทย → ' + l);
    assert(!CHORD_AFTER_LEADING.test(l), name + ': คอร์ดตามหลังสระหน้า → ' + l);
  });
  global.ChordPro.render(doc.chordpro, {}); // ต้องไม่ throw
}

/* ---------- fixture 1: เพลงไทย มีอินโทร/ช่วงดนตรี/ท่อน/พยางค์ ---------- */
const beats1 = []; for (let x = 0.5; x < 29.9; x += 0.5) beats1.push(+x.toFixed(3));
const down1 = beats1.filter((_, i) => i % 4 === 0);
const syl = (arr) => arr.map(([t0, t1, text]) => ({ t0, t1, text }));
const fx1 = {
  format: 'aquachord-transcription', version: 1, mode: 'open',
  engine: { node: 'comfyui-aquachord@0.1.0', models: {} },
  durationSec: 30, tempo: 120, timeSig: [4, 4], beats: beats1, downbeats: down1, key: 'C',
  chords: [
    { t0: 0, t1: 0.5, label: null },
    { t0: 0.5, t1: 2.5, label: 'C', conf: 0.9 }, { t0: 2.5, t1: 4.5, label: 'G', conf: 0.8 },
    { t0: 4.5, t1: 6.5, label: 'Am', conf: 0.8 }, { t0: 6.5, t1: 8.5, label: 'F', conf: 0.7 },
    { t0: 8.5, t1: 10.5, label: 'C', conf: 0.9 }, { t0: 10.5, t1: 12.5, label: 'G', conf: 0.9 },
    { t0: 12.5, t1: 13.8, label: 'Am', conf: 0.8 }, { t0: 13.8, t1: 14.5, label: 'Dm', conf: 0.6 },
    { t0: 14.5, t1: 16.5, label: 'F', conf: 0.8 },
    { t0: 16.5, t1: 18.5, label: 'Em', conf: 0.7 }, { t0: 18.5, t1: 20.5, label: 'G', conf: 0.7 },
    { t0: 20.5, t1: 22.7, label: 'C', conf: 0.9 }, { t0: 22.7, t1: 24.5, label: 'G', conf: 0.9 },
    { t0: 24.5, t1: 28.5, label: 'C', conf: 0.9 },
  ],
  sections: [{ t: 0.5, label: 'intro' }, { t: 8.5, label: 'verse' }, { t: 20.5, label: 'chorus' }, { t: 24.5, label: 'outro' }],
  lyrics: {
    source: 'user', language: 'th', text: 'จากทุ่งนามาไกลหลายร้อยโล\nคิดถึงบ้านเรือนที่จากมา\nใจมันสั่นไหว',
    lines: [
      { t0: 8.5, t1: 12.4, text: 'จากทุ่งนามาไกลหลายร้อยโล', syllables: syl([
        [8.5, 9.0, 'จาก'], [9.0, 9.5, 'ทุ่ง'], [9.5, 10.0, 'นา'], [10.0, 10.5, 'มา'],
        [10.5, 11.0, 'ไกล'], [11.0, 11.5, 'หลาย'], [11.5, 12.0, 'ร้อย'], [12.0, 12.4, 'โล']]) },
      { t0: 12.5, t1: 16.4, text: 'คิดถึงบ้านเรือนที่จากมา', syllables: syl([
        [12.5, 13.0, 'คิด'], [13.0, 13.5, 'ถึง'], [13.5, 14.0, 'บ้าน'], [14.0, 14.5, 'เรือน'],
        [14.5, 15.0, 'ที่'], [15.0, 15.5, 'จาก'], [15.5, 16.4, 'มา']]) },
      { t0: 20.5, t1: 24.0, text: 'ใจมันสั่นไหว', syllables: syl([
        [20.5, 21.0, 'ใจ'], [21.0, 21.5, 'มัน'], [21.5, 22.5, 'สั่น'], [22.5, 24.0, 'ไหว']]) },
    ],
  },
  melody: null,
  warnings: ['asr: skipped (user lyrics)'],
  timings: { separate: 12.3 },
};
const d1 = T.toSongDoc(fx1, { title: 'ลาก่อนบ้านนา', fileName: 'C:\\music\\lagon.mp3' });
checkSheet(d1, 'fx1');
eq(d1.schemaVersion, 2, 'fx1 schemaVersion');
eq(d1.creator, 'AquaChord AI (GPU)', 'fx1 creator');
eq(d1.key, 'C', 'fx1 key');
eq(d1.tempo, '120', 'fx1 tempo เป็น string');
eq(d1.capo, 0, 'fx1 capo');
eq(d1.tabs, [], 'fx1 tabs');
eq(d1.source, { kind: 'upload', ref: 'lagon.mp3', durationSec: 30 }, 'fx1 source (ชื่อไฟล์ไม่มี path)');
eq(d1.analysis.engine, 'gpu', 'fx1 analysis.engine');
eq(d1.analysis.mode, 'open', 'fx1 analysis.mode');
eq(d1.analysis.beats.length, beats1.length, 'fx1 analysis.beats');
eq(d1.analysis.sections[1], { t: 8.5, label: 'verse' }, 'fx1 analysis.sections');
assert(d1.analysis.warnings.includes('asr: skipped (user lyrics)'), 'fx1 เก็บ warnings จาก node');
eq(d1.timeline[0], { t: 0.5, chord: 'C' }, 'fx1 timeline แรก');
eq(d1.timeline.length, 14, 'fx1 timeline ไม่รวม N.C.');
assert(d1.confidence.chords > 0.7 && d1.confidence.chords < 0.9, 'fx1 confidence.chords ถ่วงตามเวลา ' + d1.confidence.chords);
eq(d1.confidence.lyrics, 0.85, 'fx1 confidence.lyrics (เนื้อที่ผู้ใช้วาง)');
assert(d1.lyricsText.startsWith('จากทุ่งนา'), 'fx1 lyricsText');
assert(!('melody' in d1), 'fx1 ไม่มี melody เมื่อผลไม่มี');
assert(!d1.lyricsEmpty, 'fx1 ไม่ตั้ง lyricsEmpty');
const cp1 = d1.chordpro;
assert(cp1.startsWith('{title: ลาก่อนบ้านนา}\n{key: C}\n{tempo: 120}\n'), 'fx1 header ' + cp1.slice(0, 60));
assert(cp1.includes('[C]จากทุ่งนามา[G]ไกลหลายร้อยโล'), 'fx1 บรรทัด 1: G ลงก่อนพยางค์ ไกล (ไม่ใช่หลังสระ ไ)');
assert(cp1.includes('[Am]คิดถึงบ้าน[Dm]เรือน[F]ที่จากมา'), 'fx1 บรรทัด 2: Dm เริ่มครึ่งหลังของ บ้าน → ย้ายไปพยางค์ เรือน');
assert(cp1.includes('[C]ใจมันสั่น[G]ไหว'), 'fx1 บรรทัด 3');
assert(/\{c: Intro\}\n\{c: ⏱ 0:00\}\n\[C\] \| \[G\] \| \[Am\] \| \[F\]/.test(cp1), 'fx1 อินโทรเป็นแถวห้อง 4 ห้อง');
assert(/\{c: ⏱ 0:16\}\n\[Em\] \| \[G\]/.test(cp1), 'fx1 ช่วงดนตรีกลางเพลงเป็นห้อง');
assert(cp1.indexOf('{c: Verse}') < cp1.indexOf('จากทุ่ง'), 'fx1 ป้าย Verse มาก่อนเนื้อ');
assert(cp1.indexOf('{c: Chorus}') < cp1.indexOf('ใจมัน') && cp1.indexOf('{c: Chorus}') > cp1.indexOf('[Em]'), 'fx1 ป้าย Chorus หลังช่วงดนตรี');
assert(/\{c: Outro\}\n\{c: ⏱ 0:24\}\n\[C\] \| \[C\]/.test(cp1), 'fx1 เอาท์โทรมีป้าย + เวลา');
assert(cp1.includes('{c: 🎤 ' + global.I18N.t('gpu.sheet.lyricsUser') + '}'), 'fx1 มีหมายเหตุที่มาเนื้อร้อง');
assert(cp1.includes('{c: ⚠ '), 'fx1 มีหมายเหตุ AI');
// ข้อความเนื้อไม่หาย: ลบคอร์ดออกต้องได้บรรทัดเดิม
const texts1 = lyricLines(cp1).map(stripChords).filter((l) => /[ก-๙]/.test(l));
eq(texts1, ['จากทุ่งนามาไกลหลายร้อยโล', 'คิดถึงบ้านเรือนที่จากมา', 'ใจมันสั่นไหว'], 'fx1 เนื้อครบไม่ถูกตัด');

/* ---------- fixture 2: เพลงไม่มีเนื้อ (ชีตคอร์ดล้วน) ---------- */
const beats2 = []; for (let x = 0; x < 64; x += 0.5) beats2.push(x);
const chords2 = [];
const prog = ['Am', 'F', 'C', 'G'];
for (let bar = 0; bar < 32; bar++) chords2.push({ t0: bar * 2, t1: bar * 2 + 2, label: prog[bar % 4] });
const fx2 = {
  format: 'aquachord-transcription', version: 1, mode: 'sheetsage2', durationSec: 64, tempo: 120, timeSig: [4, 4],
  beats: beats2, downbeats: beats2.filter((_, i) => i % 4 === 0), key: 'Am', chords: chords2,
  sections: [{ t: 0, label: 'intro' }, { t: 16, label: 'verse1' }, { t: 48, label: 'solo' }],
  lyrics: null, melody: null, warnings: [],
};
const d2 = T.toSongDoc(fx2, { fileName: 'my_song_(inst).wav' });
checkSheet(d2, 'fx2');
eq(d2.title, 'my song (inst)', 'fx2 title จากชื่อไฟล์');
assert(d2.lyricsEmpty === true && d2.lyricsText === '', 'fx2 ไม่มีเนื้อ → lyricsEmpty');
eq(d2.confidence.lyrics, 0, 'fx2 confidence.lyrics = 0');
const cp2 = d2.chordpro;
assert(/\{c: Intro\}\n\{c: ⏱ 0:00\}\n\[Am\] \| \[F\] \| \[C\] \| \[G\]   \(×2\)/.test(cp2), 'fx2 อินโทร ×2');
assert(cp2.includes('{c: Verse 1}') && cp2.includes('{c: Solo}'), 'fx2 ป้ายท่อน Verse 1 / Solo');
assert(cp2.includes('SheetSage2'), 'fx2 หมายเหตุ NC ของ sheetsage2');
eq(lyricLines(cp2).filter((l) => /[ก-๙a-z]/.test(stripChords(l).replace(/\(×\d+\)/, ''))).length, 0, 'fx2 ไม่มีบรรทัดเนื้อ');
eq(d2.analysis.mode, 'sheetsage2', 'fx2 mode');

/* ---------- fixture 3: ทำนอง (pickup, quantize, ซ้อน, พยางค์ "_", คอร์ด, เส้นกั้นห้อง) ---------- */
const beats3 = []; for (let x = 1.0; x <= 10.0001; x += 0.5) beats3.push(+x.toFixed(3));
const fx3 = {
  format: 'aquachord-transcription', version: 1, mode: 'open', durationSec: 12, tempo: 120, timeSig: [4, 4],
  beats: beats3, downbeats: [2, 4, 6, 8, 10], key: 'Gm',
  chords: [{ t0: 1.0, t1: 2.0, label: 'C' }, { t0: 2.0, t1: 4.5, label: 'G' }, { t0: 4.5, t1: 7.5, label: 'Am' }],
  sections: [],
  lyrics: { source: 'asr', language: 'th', text: 'ฉันรักเธอนะ', lines: [
    { t0: 1.0, t1: 7.0, text: 'ฉันรักเธอนะ', syllables: syl([[1.0, 1.5, 'ฉัน'], [1.5, 2.0, 'รัก'], [2.0, 3.49, 'เธอ'], [3.5, 5.5, 'นะ']]) },
  ] },
  melody: { source: 'fcpe', notes: [
    { t0: 1.0, t1: 1.5, pitch: 60, conf: 0.9 },
    { t0: 1.5, t1: 2.0, pitch: 62, conf: 0.9 },
    { t0: 2.0, t1: 3.1, pitch: 64, conf: 0.9 },
    { t0: 3.0, t1: 3.4, pitch: 65, conf: 0.9 },    // ทับท้ายโน้ตก่อน → ตัดตัวก่อน
    { t0: 3.4, t1: 3.43, pitch: 67, conf: 0.9 },   // สั้นมาก → อย่างน้อย 0.25 beat
    { t0: 3.5, t1: 5.5, pitch: 67.2, conf: 0.9 },  // ข้ามเส้นกั้นห้อง → tie
    { t0: 3.5, t1: 3.8, pitch: 50, conf: 0.1 },    // เริ่มพร้อมกัน มั่นใจน้อยกว่า → ทิ้ง
    { t0: 6.5, t1: 7.0, pitch: 69.4, conf: 0.9 },
    { t0: 7.2, t1: NaN, pitch: 70 },               // เสีย → ทิ้ง
    { t0: 7.4, t1: 7.6, pitch: 300 },              // pitch นอกช่วง → ทิ้ง
  ] },
  warnings: [],
};
const d3 = T.toSongDoc(fx3, { title: 'ทำนอง', fileName: 'x.mp3' });
checkSheet(d3, 'fx3');
const m3 = d3.melody;
assert(m3, 'fx3 มี melody');
eq(m3.timeSig, [4, 4], 'fx3 timeSig');
eq(m3.keySig, 'Gm', 'fx3 keySig');
eq(m3.tempo, 120, 'fx3 tempo');
eq(m3.pickup, 2, 'fx3 pickup = 2 beat ก่อน downbeat แรก');
eq(m3.name, 'ทำนองร้อง', 'fx3 ชื่อแทร็ก');
eq(m3.notes, [
  { t: -2, d: 1, p: 60, syl: 'ฉัน', chord: 'C' },
  { t: -1, d: 1, p: 62, syl: 'รัก' },
  { t: 0, d: 2, p: 64, syl: 'เธอ', chord: 'G' },
  { t: 2, d: 0.75, p: 65, syl: '_' },
  { t: 2.75, d: 0.25, p: 67, syl: '_' },
  { t: 3, d: 1, p: 67, syl: 'นะ', tie: true },
  { t: 4, d: 3, p: 67, syl: '_' },
  { t: 7, d: 1, p: null, chord: 'Am' },
  { t: 8, d: 1, p: null },
  { t: 9, d: 1, p: 69 },
], 'fx3 โน้ตหลังแปลง');
assert(d3.analysis.warnings.some((w) => /melody: dropped 2/.test(w)), 'fx3 เตือนโน้ตเสีย ' + JSON.stringify(d3.analysis.warnings));
eq(d3.confidence.lyrics, 0.6, 'fx3 confidence.lyrics (ASR)');

// invariant ทำนอง: ต่อเนื่อง, ความยาวที่ใช้ได้, ไม่ข้ามเส้นกั้นห้อง
function checkMelody(m, name) {
  const num = m.timeSig[0];
  let cur = m.notes[0].t;
  eq(-cur, m.pickup || 0, name + ': pickup = -t แรก');
  m.notes.forEach((n, i) => {
    assert(ALLOWED_D.includes(n.d), name + ': d ใช้ได้ #' + i + ' ' + n.d);
    assert(Math.abs(n.t * 4 - Math.round(n.t * 4)) < 1e-9, name + ': t เป็น 1/4 beat #' + i);
    assert(Math.abs(n.t - cur) < 1e-9, name + ': ต่อเนื่อง #' + i + ' t=' + n.t + ' cur=' + cur);
    assert(Math.floor(n.t / num + 1e-9) === Math.floor((n.t + n.d) / num - 1e-9), name + ': ไม่ข้ามเส้นกั้นห้อง #' + i);
    assert(n.p === null || (Number.isInteger(n.p) && n.p >= 0 && n.p <= 127), name + ': pitch #' + i);
    if (n.chord) assert(global.Music.isChord(n.chord), name + ': chord #' + i);
    cur = n.t + n.d;
  });
}
checkMelody(m3, 'fx3');

/* ---------- fixture 4: ไม่มี beats/downbeats + ทำนอง + เนื้อไม่มีพยางค์ (สัดส่วนเวลา) ---------- */
const fx4 = {
  format: 'aquachord-transcription', version: 1, mode: 'open', durationSec: 20, tempo: 90, timeSig: [3, 4],
  key: 'D', chords: [{ t0: 0, t1: 6, label: 'D' }, { t0: 6, t1: 8.2, label: 'A7' }, { t0: 8.2, t1: 14, label: 'Bm' }],
  sections: null,
  lyrics: { source: 'asr', language: 'th', text: '', lines: [
    { t0: 6.0, t1: 10.0, text: 'เธอเป็นแฟนฉันแล้วใจยังเต้นแรงอยู่ไหม' },
  ] },
  melody: { source: 'fcpe', notes: [
    { t0: 0.1, t1: 0.9, pitch: 62 }, { t0: 1.3, t1: 5.9, pitch: 64 }, { t0: 6.0, t1: 6.4, pitch: 66 },
  ] },
  warnings: null,
};
const d4 = T.toSongDoc(fx4, { title: 'ไม่มีจังหวะ' });
checkSheet(d4, 'fx4');
checkMelody(d4.melody, 'fx4');
eq(d4.melody.timeSig, [3, 4], 'fx4 timeSig 3/4');
assert(!('pickup' in d4.melody), 'fx4 ไม่มี pickup เมื่อโน้ตแรกหลังศูนย์');
const l4 = lyricLines(d4.chordpro).find((l) => l.includes('เธอ'));
assert(l4 && l4.startsWith('[A7]'), 'fx4 บรรทัดเริ่มด้วย A7 ' + l4);
assert(l4 && l4.includes('[Bm]'), 'fx4 Bm แทรกตามสัดส่วนเวลา ' + l4);
eq(stripChords(l4), 'เธอเป็นแฟนฉันแล้วใจยังเต้นแรงอยู่ไหม', 'fx4 ข้อความไม่หาย');

/* ---------- fixture 5: ข้อมูลเสีย/ประสงค์ร้าย → ผลปลอดภัย ---------- */
const fx5 = {
  format: 'aquachord-transcription', version: 1, mode: 'evil', durationSec: 40, tempo: NaN, timeSig: [0, 3],
  beats: [2, 1, NaN, Infinity, -1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1e9, 'x'],
  downbeats: 'nope', key: 'H#m',
  chords: [
    { t0: 10, t1: 14, label: 'Gm(maj7)' },
    { t0: 2, t1: 6, label: 'C7#9' },         // ไม่เรียง
    { t0: 5, t1: 8, label: 'Bbmin7' },       // ทับ C7#9
    { t0: 8, t1: 9, label: 'Intro' },        // label ไม่ใช่คอร์ด
    { t0: 9, t1: 10, label: 'C]{title: pwn}' },
    { t0: NaN, t1: 3, label: 'D' },
    { t0: 14, t1: 13, label: 'E' },
    { t0: 15, t1: 18, label: 'F#/Bb' },
    { t0: 18, t1: 20, label: 'A/H' },
    'garbage', null,
  ],
  sections: [{ t: 2, label: '{soc}[C]<script>' }, { t: NaN, label: 'x' }],
  lyrics: { source: 'user', text: 'เนื้อ [G]ปลอม {title: hacked}\n<img src=x onerror=alert(1)>', lines: [
    { t0: 2, t1: 6, text: 'เนื้อ [G]ปลอม {title: hacked}', syllables: 'bad' },
    { t0: 'x', t1: 2, text: 'ไม่มีเวลา' },
    { t0: 7, t1: 9, text: '', syllables: [] },
  ] },
  melody: { notes: 'nope' },
  warnings: ['ok', 5, { a: 1 }],
};
const d5 = T.toSongDoc(fx5, { title: 'แปลก {x} [y]\nบรรทัด', fileName: '../../etc/passwd' });
checkSheet(d5, 'fx5');
eq(d5.title, 'แปลก (x) (y) บรรทัด', 'fx5 title ถูกทำความสะอาด');
eq(d5.source.ref, 'passwd', 'fx5 fileName เหลือแค่ basename');
eq(d5.tempo, '60', 'fx5 tempo NaN → คำนวณจาก beats (ห่าง 1 วินาที = 60 BPM)');
eq(d5.analysis.beats.slice(0, 4), [1, 2, 3, 4], 'fx5 beats ทิ้งค่าเสีย + เรียงใหม่');
assert(!('mode' in d5.analysis), 'fx5 mode ผิด → ไม่ใส่');
eq(d5.timeline.map((x) => x.chord), ['C7', 'Bbm7', 'Gm', 'F#/Bb'], 'fx5 คอร์ด: ลดรูป/สะกดใหม่/ทิ้งตัวแปลก');
eq(d5.timeline[1].t, 5, 'fx5 ช่วงทับแก้แล้ว');
eq(d5.key, 'Gm', 'fx5 key ผิด → เดาจากคอร์ดที่นานสุด (Gm 4 วินาที)');
const cp5 = d5.chordpro;
eq(global.ChordPro.parse(cp5).meta.title, d5.title, 'fx5 ไม่มี {title} แทรกจากเนื้อร้อง');
assert(!/\[G\]ปลอม/.test(cp5) && cp5.includes('(G)ปลอม'), 'fx5 วงเล็บในเนื้อกลายเป็น ( )');
assert(cp5.includes('{c: (soc)(C)<script>}'), 'fx5 ป้ายท่อนถูก sanitize (render escape ต่อ)');
assert(!global.ChordPro.render(cp5, {}).includes('<script>'), 'fx5 render escape HTML');
assert(d5.analysis.warnings.some((w) => /dropped unknown label/.test(w)), 'fx5 เตือน label แปลก');
assert(d5.analysis.warnings.some((w) => /simplified/.test(w)), 'fx5 เตือนลดรูปคอร์ด');
assert(d5.analysis.warnings.some((w) => /unsorted/.test(w)), 'fx5 เตือนไม่เรียง');
assert(d5.analysis.warnings.some((w) => /overlap/.test(w)), 'fx5 เตือนทับกัน');
assert(d5.analysis.warnings.some((w) => /without timing/.test(w)), 'fx5 เตือนบรรทัดไม่มีเวลา');
assert(!('melody' in d5), 'fx5 melody เสีย → ไม่มี melody');
assert(d5.analysis.warnings.includes('ok'), 'fx5 warnings string ผ่าน, ชนิดอื่นทิ้ง');
assert(d5.analysis.warnings.length <= 60, 'fx5 warnings มีเพดาน');

/* ---------- format/version ผิด → error ชัดเจน ---------- */
function codeOf(fn) { try { fn(); return 'no-throw'; } catch (e) { return e.code || e.message; } }
eq(codeOf(() => T.toSongDoc(null, {})), 'format', 'null → format');
eq(codeOf(() => T.toSongDoc('not json', {})), 'format', 'string ไม่ใช่ JSON → format');
eq(codeOf(() => T.toSongDoc([], {})), 'format', 'array → format');
eq(codeOf(() => T.toSongDoc({ format: 'other', version: 1 }, {})), 'format', 'format อื่น → format');
eq(codeOf(() => T.toSongDoc({ format: 'aquachord-transcription', version: 2 }, {})), 'version', 'version 2 → version');
eq(codeOf(() => T.toSongDoc(JSON.stringify(fx2), { title: 'json string' })), 'no-throw', 'รับ JSON string ได้');

/* ---------- ผลว่างเปล่า (ไม่มีคอร์ด ไม่มีเนื้อ) ---------- */
const d6 = T.toSongDoc({ format: 'aquachord-transcription', version: 1, durationSec: 10, tempo: 100, chords: [], lyrics: null }, { title: 'เงียบ' });
checkSheet(d6, 'fx6');
assert(d6.chordpro.includes(global.I18N.t('sheet.noChords')), 'fx6 แจ้งไม่พบคอร์ด');
eq(d6.timeline, [], 'fx6 timeline ว่าง');

/* ---------- เนื้อที่ผู้ใช้วางแต่จัดเวลาไม่ได้ → ยังแสดงข้อความ ---------- */
const d7 = T.toSongDoc({ format: 'aquachord-transcription', version: 1, durationSec: 20, tempo: 100,
  chords: [{ t0: 0, t1: 10, label: 'C' }, { t0: 10, t1: 20, label: 'G' }],
  lyrics: { source: 'user', text: 'บรรทัดหนึ่ง [x]\nบรรทัดสอง', lines: [] } }, { title: 'ไม่มีเวลา' });
checkSheet(d7, 'fx7');
assert(d7.chordpro.includes('บรรทัดหนึ่ง (x)\nบรรทัดสอง'), 'fx7 เนื้อที่จัดเวลาไม่ได้ยังอยู่ในชีต');
eq(d7.lyricsText, 'บรรทัดหนึ่ง [x]\nบรรทัดสอง', 'fx7 lyricsText เก็บข้อความเดิม');

/* ---------- บรรทัดยาวมาก → ตัดที่ขอบพยางค์ ---------- */
const longSyl = [];
const words = ['ฉัน', 'ยัง', 'คิด', 'ถึง', 'เธอ', 'ทุก', 'วัน', 'ไม่', 'เคย', 'ลืม', 'เลือน', 'ความ', 'รัก', 'ที่', 'เรา', 'เคย', 'มี', 'ให้', 'กัน', 'เสมอ', 'มา'];
let tt = 2;
words.forEach((w) => { longSyl.push({ t0: tt, t1: tt + 0.4, text: w }); tt += 0.4; });
const d8 = T.toSongDoc({ format: 'aquachord-transcription', version: 1, durationSec: 20, tempo: 100,
  chords: [{ t0: 0, t1: 5, label: 'Em' }, { t0: 5, t1: 11, label: 'Cmaj7' }],
  lyrics: { source: 'asr', lines: [{ t0: 2, t1: tt, text: words.join(''), syllables: longSyl }] } }, { title: 'ยาว' });
checkSheet(d8, 'fx8');
const l8 = lyricLines(d8.chordpro).filter((l) => /[ก-๙]/.test(l));
assert(l8.length === 2, 'fx8 บรรทัดยาวถูกตัดเป็น 2 ' + JSON.stringify(l8));
eq(l8.map(stripChords).join(''), words.join(''), 'fx8 ตัดแล้วข้อความครบ');
assert(l8.some((l) => l.includes('[Cmaj7]')), 'fx8 มี Cmaj7');

/* ---------- เพดานขนาด ---------- */
const bigBeats = []; for (let i = 0; i < 30000; i++) bigBeats.push(i * 0.1);
const d9 = T.toSongDoc({ format: 'aquachord-transcription', version: 1, durationSec: 3000, tempo: 120,
  beats: bigBeats, chords: [{ t0: 0, t1: 3000, label: 'C' }] }, { title: 'ใหญ่' });
assert(d9.analysis.beats.length <= 20000, 'fx9 beats มีเพดาน');
assert(d9.analysis.warnings.some((w) => /truncated/.test(w)), 'fx9 เตือนตัดข้อมูล');

/* ---------- normChord ---------- */
const nc = T._test.normChord;
eq(nc('Gm7'), { label: 'Gm7', simplified: false }, 'normChord Gm7');
eq(nc('Ebmaj7/G'), { label: 'Ebmaj7/G', simplified: false }, 'normChord slash');
eq(nc('N.C.'), { label: null }, 'normChord N.C.');
eq(nc('Am(maj7)'), { label: 'Am', simplified: true }, 'normChord m(maj7) → m');
eq(nc('Xyz'), { drop: true }, 'normChord ขยะ');
eq(nc(42), { drop: true }, 'normChord ไม่ใช่ string');
eq(T._test.splitDur(2.25), [2, 0.25], 'splitDur 2.25');
eq(T._test.splitDur(7), [4, 3], 'splitDur 7');
const bm = T._test.makeBeatMap([1, 1.5, 2.5], 120);
eq([bm(0.5), bm(1), bm(1.25), bm(2), bm(3)], [-1, 0, 0.5, 1.5, 3], 'beat map (interpolate + extrapolate ด้วย tempo)');

/* ---------- เบราว์เซอร์เก่าไม่มี Intl.Segmenter → ใช้ fallback ตัด grapheme เอง ---------- */
{
  const mem2 = new Map();
  const sb = {
    Intl: {}, // ไม่มี Segmenter
    localStorage: { getItem: (k) => (mem2.has(k) ? mem2.get(k) : null), setItem: (k, v) => mem2.set(k, String(v)), removeItem: (k) => mem2.delete(k) },
    document: { documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
  };
  vm.createContext(sb);
  vm.runInContext('this.window = this; this.self = this;', sb);
  for (const f of ['i18n.js', 'music.js', 'chordpro.js', 'store.js', 'transcription.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'site/assets/js', f), 'utf8'), sb, { filename: f });
  }
  const T2 = sb.Transcription;
  eq(Array.from(T2._test.graphemes('ที่น้ำใส')), ['ที่', 'น้ำ', 'ใ', 'ส'], 'fallback graphemes ไทย (รวมสระอำ/วรรณยุกต์)');
  const fb1 = T2.toSongDoc(JSON.parse(JSON.stringify(fx1)), { title: 'ลาก่อนบ้านนา', fileName: 'lagon.mp3' });
  eq(fb1.chordpro.split('\n').slice(5), d1.chordpro.split('\n').slice(5), 'fallback ให้ชีตเหมือน Intl.Segmenter');
  const fb4 = T2.toSongDoc(JSON.parse(JSON.stringify(fx4)), { title: 'ไม่มีจังหวะ' });
  lyricLines(fb4.chordpro).forEach((l) => {
    assert(!COMB_AFTER_CHORD.test(l), 'fallback: คอร์ดคั่นกลาง grapheme → ' + l);
    assert(!CHORD_AFTER_LEADING.test(l), 'fallback: คอร์ดตามหลังสระหน้า → ' + l);
  });
}

if (fails.length) {
  console.error('✗ test-transcription FAILED (' + fails.length + '/' + checks + '):\n- ' + fails.join('\n- '));
  process.exit(1);
}
console.log('✓ test-transcription ผ่านทุกข้อ (' + checks + ' checks)');
