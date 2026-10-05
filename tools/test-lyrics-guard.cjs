#!/usr/bin/env node
/* test-lyrics-guard.cjs — ตัวกันลูปของ Whisper ใน lyrics-worker.js (ไม่ต้องใช้เบราว์เซอร์/โมเดล)
   โหลด lyrics-worker.js ใน vm แล้วจำลองการถอดทีละ token ด้วย token id จริงของ whisper-large-v3-turbo
   (test-lyrics-guard.tokens.json — สร้างจาก tokenizer.json ของโมเดล):
   - เนื้อร้องจริงไทย/อังกฤษ (รวมท่อนซ้ำตามธรรมชาติ + token เวลาแทรก) ต้องผ่านครบทุก token ไม่โดนห้าม/ตัด
   - ลูปที่เจอจริงในเบราว์เซอร์ ("ที่สุด…", "ที่นี่ …", "ของตัว…", "หรือ…", "!!!") ต้องจบเร็ว แม้ "โมเดล" ดื้อวนกลับมาใหม่
   - งบเวลา/เพดานความยาวบังคับ EOS · รายการ logits processor ไม่สะสมข้ามช่วง · hookGenerate ข้ามช่วงเมื่อเลยงบ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'site', 'assets', 'js', 'lyrics-worker.js');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-lyrics-guard.tokens.json'), 'utf8'));
const ctx = { self: { postMessage() {} }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'lyrics-worker.js' });
const { makeGuard, procList, hookGenerate, findLoop } = ctx;

const EOS = FX.eos, TS = FX.tsBegin, V = FX.vocab;
const INIT = [50258, 50289, 50360]; // <|startoftranscript|> <|th|> <|transcribe|>
const fails = [];
const t = (cond, msg) => { if (!cond) fails.push(msg); };

function mkRun(o) {
  const st = { steps: 0, loops: 0, cut: 0, capped: 0, skipped: 0, overBudget: false };
  return Object.assign({ eos: EOS, sot: INIT[0], maxText: 0, chunk: -1, st, over: () => false }, o || {}, { st });
}

/* จำลองถอดหนึ่งช่วง: "โมเดล" อยากออก target[k] เสมอ (คะแนนสูงสุด) ถ้าโดนห้ามก็ออกตัวสำรองแทน
   แล้วรอบหน้ากลับมาอยากออก target[k] ตัวเดิมอีก (จำลองการหลอนแบบดื้อ) · คืน token ที่ออกจริง */
function decode(target, run, maxSteps) {
  const guard = makeGuard(run);
  const ids = INIT.map(BigInt);
  const out = [];
  let k = 0, banned = 0;
  const d = new Float32Array(V);
  for (let step = 0; step < (maxSteps || 448) && k < target.length; step++) {
    d.fill(-20);
    const want = target[k];
    d[want] = 10;
    d[want === 1000 ? 1001 : 1000] = 5; // ตัวสำรอง
    d[EOS] = 0;
    guard([ids], [{ data: d }]);
    let best = 0;
    for (let i = 1; i < V; i++) if (d[i] > d[best]) best = i;
    if (best === EOS) { out.push(EOS); break; }
    if (best === want) k++; else banned++;
    ids.push(BigInt(best));
    out.push(best);
  }
  return { out, k, banned, st: run.st };
}

// แทรก token เวลาเป็นคู่ (จบท่อน/เริ่มท่อน) ทุก ~12 token แบบที่ Whisper ออกตอน return_timestamps
// (token เวลามี 1501 ตัว = 0.00–30.00 วินาที ทีละ 0.02 → ขยับทีละ 0.8 วินาที ไม่เกินช่วง)
function withTimestamps(seq) {
  const r = [TS];
  let ts = 0;
  seq.forEach((x, i) => { r.push(x); if (i % 12 === 11) { ts += 40; r.push(TS + ts, TS + ts); } });
  r.push(TS + ts + 20);
  if (r.some((x) => x >= V)) throw new Error('fixture: token เวลาเกินช่วง 30 วินาที');
  return r;
}

// 1) เนื้อร้องจริงต้องผ่านครบ
for (const [name, seq] of Object.entries(FX.legit)) {
  for (const [label, target] of [['ข้อความล้วน', seq], ['มี token เวลา', withTimestamps(seq)]]) {
    const run = mkRun({ maxText: name.startsWith('en') || name === 'repeat_en' ? 320 : 0 });
    const r = decode(target, run);
    t(r.k === target.length && r.banned === 0 && r.st.loops === 0 && !r.out.includes(EOS),
      `เนื้อร้องจริง "${name}" (${label}) โดนตัวกันลูปแตะ: ผ่าน ${r.k}/${target.length} token, ห้าม ${r.banned}, loops ${r.st.loops}`);
  }
  // ทุก prefix ของเนื้อร้องจริงต้องไม่ถูกมองว่าเป็นลูป
  for (let n = 1; n <= seq.length; n++) {
    if (findLoop(seq.slice(0, n)) >= 0) { fails.push(`findLoop มองเนื้อร้องจริง "${name}" เป็นลูปที่ token ${n}`); break; }
  }
}

// 2) ลูปที่เจอจริงต้องจบเร็ว (ไม่ถึงเพดาน 448 token ของ Whisper)
const loopRows = [];
for (const [name, seq] of Object.entries(FX.loops)) {
  // ต่อให้ยาวไม่จบ: วนส่วนท้าย (ตัดคำนำหน้าออก) ไปเรื่อย ๆ
  const target = seq.concat(...Array(40).fill(seq.slice(Math.floor(seq.length / 2))));
  const run = mkRun();
  const r = decode(target, run);
  const ended = r.out[r.out.length - 1] === EOS;
  loopRows.push(`${name.padEnd(9)} จบที่ token ${String(r.out.length).padStart(3)} · ห้าม ${r.banned} · loops ${r.st.loops} · cut ${r.st.cut}`);
  t(ended && r.out.length <= 200, `ลูป "${name}" ไม่จบเร็ว: ${r.out.length} token, จบด้วย EOS = ${ended}`);
}

// 3) งบเวลา + เพดานความยาว
{
  let steps = 0;
  const run = mkRun({ over: () => ++steps > 5 });
  const r = decode(FX.legit.th, run);
  t(r.out[r.out.length - 1] === EOS && r.out.length <= 6, 'เลยงบเวลาแล้วต้อง EOS ทันที ได้ ' + r.out.length + ' token');
  const run2 = mkRun({ maxText: 20 });
  const r2 = decode(FX.legit.thfast, run2);
  const txt = r2.out.filter((x) => x < EOS).length;
  t(r2.out[r2.out.length - 1] === EOS && txt === 20 && run2.st.capped === 1, `เพดานข้อความ 20 token ไม่ทำงาน: ข้อความ ${txt}, capped ${run2.st.capped}`);
}

// 4) ขึ้นช่วงใหม่ (ids สั้นลง) ต้องรีเซ็ตตัวนับ — ช่วงก่อนโดนตัด ช่วงถัดไปต้องถอดได้ปกติ
{
  const run = mkRun();
  const guard = makeGuard(run);
  const d = new Float32Array(V);
  const step = (ids, want) => { d.fill(-20); d[want] = 10; d[1000] = 5; guard([ids.map(BigInt)], [{ data: d }]); let b = 0; for (let i = 1; i < V; i++) if (d[i] > d[b]) b = i; return b; };
  const loop = FX.loops.thisud.slice(0, 5);
  const ids = INIT.slice();
  let last = 0;
  for (let i = 0; i < 300 && last !== EOS; i++) { last = step(ids, loop[i % 5]); ids.push(last); }
  t(last === EOS, 'ช่วงแรกที่วนต้องถูกตัด');
  const ids2 = INIT.slice();
  let ok = true;
  for (const x of FX.legit.thm) { const b = step(ids2, x); if (b !== x) { ok = false; break; } ids2.push(b); }
  t(ok, 'ช่วงถัดไปหลังโดนตัด เนื้อร้องจริงต้องผ่าน (ตัวนับไม่รีเซ็ต)');
}

// 5) procList: Whisper.generate push ตัวประมวลผลของมันทุกช่วง → ต้องไม่สะสม และตัวกันลูปอยู่ท้ายสุด
{
  const g = () => {};
  const list = procList(g);
  for (let i = 0; i < 5; i++) {
    list.push(Object.assign(() => {}, { timestamp_begin: TS, n: i }));
    list.push(Object.assign(() => {}, { begin_suppress_tokens: [220, EOS], n: i }));
  }
  const items = [...list];
  t(items.length === 3 && items[2] === g && items[0].n === 4 && items[1].n === 4,
    'procList สะสม/เรียงผิด: ' + items.map((x) => (x === g ? 'guard' : Object.keys(x).join('+') + ':' + x.n)).join(', '));
}

// 6) hookGenerate: นับช่วง + เลยงบแล้วไม่เรียก generate จริง (ไม่เสียเวลา encoder) คืน [sot, eos]
(async () => {
  let real = 0;
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const pipe = { model: { generate: async () => { real++; return 'real'; } } };
  hookGenerate(pipe, { Tensor });
  hookGenerate(pipe, { Tensor }); // ครอบซ้ำต้องไม่ซ้อน
  const seen = [];
  let over = false;
  pipe._aqRun = mkRun({ onChunk: (k) => seen.push(k), over: () => over });
  const a = await pipe.model.generate({});
  over = true;
  const b = await pipe.model.generate({});
  const c = await pipe.model.generate({});
  t(a === 'real' && real === 1, 'ช่วงแรกต้องเรียก generate จริงครั้งเดียว');
  t(b instanceof Tensor && Array.from(b.data, Number).join(',') === `${INIT[0]},${EOS}` && c instanceof Tensor,
    'เลยงบแล้วต้องคืน [sot, eos] โดยไม่เรียก generate');
  t(pipe._aqRun.st.skipped === 2 && seen.join(',') === '0,1,2', 'นับช่วง/ข้ามผิด: skipped ' + pipe._aqRun.st.skipped + ' seen ' + seen);
  pipe._aqRun = null;
  await pipe.model.generate({});
  t(real === 2, 'ไม่มีงานที่กำลังถอด (_aqRun = null) ต้องเรียก generate จริงตามปกติ');

  console.log('=== ตัวกันลูปของ Whisper (lyrics-worker.js) ===');
  console.log('เนื้อร้องจริง ' + Object.keys(FX.legit).length + ' ชุด (ไทย/อังกฤษ/ท่อนซ้ำ ± token เวลา) ต้องผ่านครบ');
  console.log('ลูปจริงจากเบราว์เซอร์ (เพดาน Whisper 448 token/ช่วง):');
  loopRows.forEach((r) => console.log('  ' + r));
  if (fails.length) {
    console.error('\n✗ FAILED:\n- ' + fails.join('\n- '));
    process.exit(1);
  }
  console.log('\n✓ ผ่านทุกข้อ');
})().catch((e) => { console.error(e); process.exit(1); });
