#!/usr/bin/env node
'use strict';
/* run.cjs — benchmark "เพลงจำลองที่เหมือนจริง" ของเอนจินแกะคอร์ดในเครื่อง (site/assets/js/dsp.js)

   ใช้:
     node tools/eval/run.cjs                 ทุกเพลง (ตาราง + ค่าเฉลี่ย)
     node tools/eval/run.cjs --ci            เฉพาะชุด CI + ตรวจเกณฑ์ขั้นต่ำ (exit 1 ถ้าต่ำกว่า)
     node tools/eval/run.cjs --song lukthung-Am   เพลงเดียว (ใส่ --verbose เพื่อดู segment)
     node tools/eval/run.cjs --json out.json เขียนผลเป็น JSON (ไว้เทียบก่อน/หลัง)
     node tools/eval/run.cjs --compare tools/eval/baseline-v1.3.1.json   ตารางก่อน/หลังต่อ metric
     node tools/eval/run.cjs --time          จับเวลาเพลงยาว 4 นาที (เฉพาะเวลาเอนจิน)
   ตัวชี้วัด/การ map ชื่อคอร์ด: ดูหัวไฟล์ chords.cjs */
const path = require('path');
const fs = require('fs');
const DSP = require(path.join(__dirname, '..', '..', 'site', 'assets', 'js', 'dsp.js'));
const { renderSong } = require('./synth.cjs');
const { SONGS } = require('./songs.cjs');
const C = require('./chords.cjs');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

// เกณฑ์ขั้นต่ำของชุด CI (ค่าเฉลี่ย) — ตั้งต่ำกว่าผลจริงเล็กน้อยกันความต่าง float ข้ามเครื่อง
const CI_FLOOR = { root: 0.80, majmin: 0.77, sevenths: 0.55, tetrads: 0.52, mirex: 0.80, key: 0.80, seg: 0.78 };

/* เรียกเอนจินแบบเดียวกับ analyze.js ทุกขั้น */
async function runEngine(x, sr) {
  if (DSP.analyzeSong) return DSP.analyzeSong(x, sr, {});
  // v1.3.x (ก่อนมี analyzeSong): ลำดับเดียวกับ analyze.js
  const seconds = x.length / sr;
  const { bpm, phase } = await DSP.detectTempo(x, sr);
  const hop = seconds > 420 ? 2048 : 1024;
  const ch = await DSP.analyzeChroma(x, sr, { hop });
  const dec = await DSP.decodeChords(ch.chroma, ch.bass, ch.rms, ch.F, { frameSec: ch.frameSec });
  const segs = DSP.toSegments(dec.path, dec.labels, dec.nChords, ch.F, ch.frameSec, ch.t0);
  const beats = [];
  for (let t = phase; t < seconds; t += 60 / bpm) beats.push(t);
  return { segs, key: dec.key, bpm, phase, beats, confidence: dec.confidence, tuningCents: ch.tuningCents };
}

async function evalSong(spec, opts) {
  const t0 = Date.now();
  const song = renderSong(spec);
  const tSynth = Date.now() - t0;
  const t1 = Date.now();
  const res = await runEngine(song.x, song.sr);
  const tEngine = Date.now() - t1;
  const m = C.evaluateChords(song.truth, res.segs);
  const refKey = C.mainKey(song.keys);
  m.key = C.keyScore(refKey, res.key);
  m.keyExact = m.key === 1 ? 1 : 0;
  m.beatF = res.beats ? C.beatF(song.beats, res.beats) : null;
  const tempoRatio = res.bpm / song.bpm;
  m.tempo = [1, 2, 0.5].some((r) => Math.abs(tempoRatio / r - 1) < 0.04) ? 1 : 0;
  if (opts.verbose) {
    console.log('\n--- ' + spec.name + ' ---');
    console.log('truth:', song.truth.map((s) => `${s.t0.toFixed(1)} ${s.label || 'N'}`).join(' | '));
    console.log('est  :', res.segs.map((s) => `${s.t0.toFixed(1)} ${s.chord || 'N'}`).join(' | '));
    console.log('key ref ' + refKey + ' est ' + res.key + ' · bpm ref ' + spec.bpm + ' est ' + (res.bpm || 0).toFixed(1));
  }
  return { name: spec.name, ci: !!spec.ci, metrics: m, refKey, estKey: res.key, bpm: res.bpm, duration: song.duration, tSynth, tEngine };
}

const COLS = ['root', 'majmin', 'majminInv', 'sevenths', 'tetrads', 'mirex', 'seg', 'key', 'beatF', 'tempo'];
const pct = (v) => (v == null ? '  -  ' : (v * 100).toFixed(1).padStart(5));

function roundAll(o) {
  const r = {};
  Object.keys(o).forEach((k) => { r[k] = o[k] == null ? null : Math.round(o[k] * 10000) / 10000; });
  return r;
}

function mean(results, col) {
  const vals = results.map((r) => r.metrics[col]).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

async function timeLongSong() {
  // เพลง 4 นาที: ต่อท่อนของ pop-C-slash ซ้ำจนครบ ~240 วินาที
  const base = SONGS.find((s) => s.name === 'pop-C-slash');
  const spec = JSON.parse(JSON.stringify(base));
  spec.name = 'pop-C-4min';
  spec.sections = [];
  while (spec.sections.length < 10) base.sections.forEach((s) => spec.sections.push(JSON.parse(JSON.stringify(s))));
  const song = renderSong(spec);
  const x = song.x.subarray(0, Math.min(song.x.length, 240 * song.sr));
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    await runEngine(x, song.sr);
    runs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  runs.sort((a, b) => a - b);
  console.log(`เวลาเอนจิน (เพลง ${(x.length / song.sr).toFixed(0)} วินาที, Node ${process.version}): median ${runs[1].toFixed(0)} ms (runs ${runs.map((r) => r.toFixed(0)).join(', ')})`);
  return runs[1];
}

(async () => {
  if (flag('--time')) { await timeLongSong(); return; }
  let list = SONGS;
  if (flag('--ci')) list = SONGS.filter((s) => s.ci);
  const only = val('--song');
  if (only) list = SONGS.filter((s) => s.name === only);
  if (!list.length) { console.error('ไม่พบเพลง'); process.exit(2); }
  const tAll = Date.now();
  const results = [];
  for (const s of list) results.push(await evalSong(s, { verbose: flag('--verbose') }));

  console.log('=== AquaChord realistic chord benchmark (' + results.length + ' เพลง) ===');
  const head = 'เพลง'.padEnd(22) + COLS.map((c) => c.slice(0, 6).padStart(7)).join('') + '  key(ref→est)   bpm';
  console.log(head);
  results.forEach((r) => {
    console.log(r.name.padEnd(22) + COLS.map((c) => pct(r.metrics[c]).padStart(7)).join('') +
      '  ' + (r.refKey + '→' + r.estKey).padEnd(12) + (r.bpm ? r.bpm.toFixed(0).padStart(5) : ''));
  });
  const avg = {};
  COLS.forEach((c) => { avg[c] = mean(results, c); });
  console.log('เฉลี่ย'.padEnd(22) + COLS.map((c) => pct(avg[c]).padStart(7)).join(''));
  const tSyn = results.reduce((a, r) => a + r.tSynth, 0), tEng = results.reduce((a, r) => a + r.tEngine, 0);
  const secs = results.reduce((a, r) => a + r.duration, 0);
  console.log(`เวลา: สังเคราะห์ ${(tSyn / 1000).toFixed(1)}s · เอนจิน ${(tEng / 1000).toFixed(1)}s (เสียงรวม ${secs.toFixed(0)}s) · ทั้งหมด ${((Date.now() - tAll) / 1000).toFixed(1)}s`);

  const out = val('--json');
  if (out) {
    // ไม่ใส่เวลาที่วัด (ต่างกันทุกเครื่อง) — ไฟล์ผลต้อง reproducible
    const slim = results.map((r) => ({ name: r.name, ci: r.ci, refKey: r.refKey, estKey: r.estKey,
      bpm: r.bpm == null ? null : Math.round(r.bpm * 10) / 10, metrics: roundAll(r.metrics) }));
    fs.writeFileSync(out, JSON.stringify({ engine: DSP.ENGINE_VERSION || 'v1.3.1', avg: roundAll(avg), results: slim }, null, 2) + '\n');
    console.log('เขียนผล → ' + out);
  }
  const cmp = val('--compare');
  if (cmp) {
    const before = JSON.parse(fs.readFileSync(cmp, 'utf8'));
    const names = new Set(results.map((r) => r.name));
    const bRes = before.results.filter((r) => names.has(r.name));
    console.log('\n=== ก่อน (' + before.engine + ') → หลัง (' + (DSP.ENGINE_VERSION || 'current') + ') · ' + bRes.length + ' เพลงที่ตรงกัน ===');
    COLS.forEach((c) => {
      const b = mean(bRes, c), a = avg[c];
      if (b == null || a == null) return;
      const d = (a - b) * 100;
      console.log(c.padEnd(10) + pct(b) + ' → ' + pct(a) + '   (' + (d >= 0 ? '+' : '') + d.toFixed(1) + ')');
    });
  }
  if (flag('--ci')) {
    const fails = Object.keys(CI_FLOOR).filter((k) => avg[k] == null || avg[k] < CI_FLOOR[k]);
    if (fails.length) {
      console.error('\n✗ ต่ำกว่าเกณฑ์: ' + fails.map((k) => `${k} ${pct(avg[k])} < ${(CI_FLOOR[k] * 100).toFixed(0)}`).join(', '));
      process.exit(1);
    }
    console.log('\n✓ ผ่านเกณฑ์ CI');
  }
})().catch((e) => { console.error(e); process.exit(1); });
