#!/usr/bin/env node
/* e2e-tracks.mjs — เทสต์ "แกะไลน์เพลงหลายเครื่องดนตรี" ในเบราว์เซอร์จริง (Chrome headless ผ่าน CDP) ด้วยโมเดลจริง
   - สังเคราะห์เพลงจาก tools/synth-song.cjs (รู้โน้ตเฉลยทุกตัว) → เขียน WAV → อัปโหลดเข้า <input type=file>
   - เรียก Analyze.run({ tracks:'lite' | 'full' }) ของแอปจริง (stems.js/stems-worker.js/tracks.js + onnxruntime-web
     + Basic Pitch + Demucs จาก CDN/Hugging Face ตัวจริง) แล้วให้คะแนน F1 ต่อแทร็ก (onset ±50ms, pitch ตรง; กลอง = คีย์ GM)
   - วัดเวลา (ms ต่อนาทีเสียง) และขนาดดาวน์โหลดจริง (encodedDataLength ของ worker ผ่าน Target.setAutoAttach)
   ต้องมี: Chrome ที่ CHROME (ค่าเริ่มต้น C:/Program Files/Google/Chrome/Application/chrome.exe) + อินเทอร์เน็ต
   ใช้:  node tools/e2e-tracks.mjs [--modes=lite,full] [--bars=12] [--long=48] [--cold] [--profile=DIR] [--json=out.json]
   ไม่ได้อยู่ใน CI (ต้องใช้ GPU + ดาวน์โหลดโมเดล ~290MB) — รันบนเครื่องนักพัฒนา */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'site');
const { synthSong, writeWav, evalNotes } = require('./synth-song.cjs');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => process.argv.includes('--' + k);
const MODES = arg('modes', 'lite,full').split(',').filter(Boolean);
const BARS = +arg('bars', 12);
const LONG = +arg('long', 0);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = flag('cold') ? mkdtempSync(join(tmpdir(), 'aq-e2e-cold-')) : arg('profile', join(tmpdir(), 'aq-e2e-tracks-profile'));
if (!existsSync(CHROME)) { console.log('⏭  ไม่พบ Chrome ที่ ' + CHROME + ' (ตั้ง CHROME=...)'); process.exit(0); }
if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });

/* ---------- static server ของ site/ ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  // ไม่ให้ service worker ของแอปแคชสคริปต์ (เทสต์ต้องได้ไฟล์ล่าสุดเสมอ)
  if (p === '/sw.js') { res.writeHead(404); res.end(); return; }
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
});
// พอร์ตคงที่ → origin เดิมทุกครั้ง → Cache API ของโมเดล (ต่อ origin) ใช้ซ้ำข้ามรอบได้
await new Promise((r) => server.listen(+arg('port', 5611), '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

/* ---------- เพลงสังเคราะห์ ---------- */
const songs = [];
const mkSong = (bars, seed) => {
  const s = synthSong({ bars, seed });
  const file = join(tmpdir(), `aq-e2e-song-${bars}-${seed}.wav`);
  writeWav(file, s.L, s.R, s.sr);
  return { s, file, bars };
};
songs.push(mkSong(BARS, 7));
if (LONG) songs.push(mkSong(LONG, 11));

/* ---------- Chrome + CDP ---------- */
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`,
  ...(flag('nogpu') ? ['--disable-gpu', '--disable-features=WebGPU,Vulkan'] : ['--use-angle=d3d11', '--enable-gpu', '--enable-unsafe-webgpu']),
  '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch (e) { /* รอ */ } await sleep(200); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map(), logs = [], net = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Target.attachedToTarget') {
    const sid = m.params.sessionId;
    send('Network.enable', {}, sid); send('Runtime.enable', {}, sid); send('Runtime.runIfWaitingForDebugger', {}, sid);
  }
  if (m.method === 'Network.responseReceived') net.set(m.params.requestId, { url: m.params.response.url, status: m.params.response.status, fromCache: !!m.params.response.fromDiskCache });
  if (m.method === 'Network.loadingFinished') { const r = net.get(m.params.requestId); if (r) r.bytes = m.params.encodedDataLength; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params.type)) logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
});
function send(method, params = {}, sessionId) {
  return new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify(Object.assign({ id: i, method, params }, sessionId ? { sessionId } : {}))); });
}
const ev = async (expr, timeoutMs) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs || 900000).then(() => ({ result: { exceptionDetails: { text: 'timeout' } } })),
  ]);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'eval error');
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: false });
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send('Page.navigate', { url: BASE });
await sleep(2000);
await ev(`(async () => { const rs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : []; for (const r of rs) await r.unregister();
  for (const k of await caches.keys()) if (!/^aq-models/.test(k)) await caches.delete(k); return rs.length; })()`);
await send('Page.reload', { ignoreCache: true });
await sleep(2500);
// stems.js ยังไม่อยู่ใน index.html (session หลักเป็นคนใส่) → ฉีดเองถ้ายังไม่มี
await ev(`new Promise((res, rej) => { if (window.Stems) return res(1); const s = document.createElement('script'); s.src = 'assets/js/stems.js'; s.onload = () => res(2); s.onerror = rej; document.head.appendChild(s); })`);
const caps = await ev('Stems.capabilities()');
console.log('capabilities', JSON.stringify(caps));

async function upload(file) {
  await ev(`(() => { let i = document.getElementById('aqE2E'); if (!i) { i = document.createElement('input'); i.type = 'file'; i.id = 'aqE2E'; i.style.display = 'none'; document.body.appendChild(i); } return 1; })()`);
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#aqE2E' });
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [file] });
}

async function runMode(song, mode) {
  await upload(song.file);
  net.clear();
  const t0 = Date.now();
  const out = await ev(`(async () => {
    const file = document.getElementById('aqE2E').files[0];
    const prog = [];
    let lastStage = '', st = performance.now();
    const stageMs = {};
    const ctl = { aborted: false };
    const t0 = performance.now();
    const doc = await Analyze.run({ kind: 'file', file, tracks: ${mode ? `'${mode}'` : 'null'} }, (p) => {
      const now = performance.now();
      if (p.stage !== lastStage) { if (lastStage) stageMs[lastStage] = Math.round(now - st); lastStage = p.stage; st = now; }
      prog.push([p.stage, p.percent, p.detail || '']);
    }, ctl);
    if (lastStage) stageMs[lastStage] = Math.round(performance.now() - st);
    return { ms: Math.round(performance.now() - t0), stageMs, key: doc.key, tempo: doc.tempo, conf: doc.confidence, timeline: doc.timeline,
      tracks: doc._tracks || null, err: doc._tracksError || null, fb: !!doc._tracksFallback,
      details: [...new Set(prog.map((p) => p[0] + ': ' + p[2]).filter((x) => !/: $/.test(x)))].slice(0, 60),
      mono: prog.every((p, i) => i === 0 || p[1] >= prog[i - 1][1]) };
  })()`);
  out.wall = Date.now() - t0;
  out.net = [...net.values()].filter((r) => /jsdelivr|unpkg|huggingface|hf\.co|xethub|cdn-lfs/.test(r.url));
  return out;
}

// เรียก Stems ตรง ๆ (debug: เวลาแต่ละขั้นใน worker + ระดับ stem) — ไม่ผ่าน Analyze
async function runDirect(song, mode, bpm, phase) {
  await upload(song.file);
  return ev(`(async () => {
    const file = document.getElementById('aqE2E').files[0];
    const audio = await Music.audioCtx().decodeAudioData(await file.arrayBuffer());
    const o = { bpm: ${bpm}, phase: ${phase}, debug: true, bpDevice: '${process.env.BPDEV || ''}', batch: ${+(process.env.BATCH || 0) || 'undefined'} };
    const t0 = performance.now();
    if ('${mode}' === 'lite') {
      const ts = await Stems.transcribe(audio, Object.assign({ mode: 'lite' }, o));
      return { total: Math.round(performance.now() - t0), dbg: ts._debug || null };
    }
    const sep = await Stems.separate(audio, Object.assign({ wantVocalsPcm16k: true }, o));
    const t1 = performance.now();
    const ts = await sep.tracks(o);
    const t2 = performance.now();
    const r = { total: Math.round(t2 - t0), separate: Math.round(t1 - t0), tracks: Math.round(t2 - t1), sepTiming: sep.timing, chunks: sep.chunks,
      present: sep.present, level: sep.level, inst11: sep.instrumentalMono11k.length, voc16: sep.vocalsPcm16k ? sep.vocalsPcm16k.length : 0, dbg: ts._debug || null,
      ids: ts.tracks.map((t) => t.id + ':' + t.notes.length).join(' ') };
    sep.release();
    return r;
  })()`);
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const fmtE = (e) => `F1 ${pct(e.F1).padStart(6)}  P ${pct(e.P).padStart(6)}  R ${pct(e.R).padStart(6)}  (${e.tp}/${e.nRef} ref, ${e.nEst} est, Δt ${(e.meanDt * 1000).toFixed(0)}ms)`;
const truthAll = (s) => s.truth.bass.concat(s.truth.melody, s.truth.harmony);

function score(song, res, mode) {
  const s = song.s, ts = res.tracks;
  const rows = [];
  const tr = (id) => ((ts && ts.tracks.find((t) => t.id === id)) || { notes: [] }).notes;
  rows.push(['drums (all keys)', evalNotes(tr('drums'), s.truth.drums)]);
  for (const k of [36, 38, 42, 46, 49]) rows.push([`  drums ${k}`, evalNotes(tr('drums').filter((n) => n.midi === k), s.truth.drums.filter((n) => n.midi === k))]);
  rows.push(['  drums hat 42+46 as one', evalNotes(tr('drums').filter((n) => n.midi === 42 || n.midi === 46).map((n) => ({ t: n.t, midi: 42 })), s.truth.drums.filter((n) => n.midi === 42 || n.midi === 46).map((n) => ({ t: n.t, midi: 42 })))]);
  rows.push(['bass', evalNotes(tr('bass'), s.truth.bass)]);
  if (mode === 'full') {
    rows.push(['vocals (vs lead melody)', evalNotes(tr('vocals'), s.truth.melody)]);
    rows.push(['melody (vs lead melody)', evalNotes(tr('melody'), s.truth.melody)]);
    for (const id of ['guitar', 'piano', 'other']) {
      if (!tr(id).length) continue;
      rows.push([`${id} vs pads`, evalNotes(tr(id), s.truth.harmony)]);
      rows.push([`${id} vs lead`, evalNotes(tr(id), s.truth.melody)]);
    }
    const poly = ['guitar', 'piano', 'other'].flatMap(tr);
    rows.push(['guitar+piano+other vs pads', evalNotes(poly, s.truth.harmony)]);
  } else {
    rows.push(['melody', evalNotes(tr('melody'), s.truth.melody)]);
    rows.push(['harmony (vs pads)', evalNotes(tr('harmony'), s.truth.harmony)]);
  }
  const pitched = ts ? ts.tracks.filter((t) => t.kind === 'pitched').flatMap((t) => t.notes) : [];
  rows.push(['ALL pitched (role-agnostic)', evalNotes(pitched, truthAll(s))]);
  return rows;
}

// ยกเลิกกลางทาง: ต้อง reject 'cancelled' เร็ว (worker ถูก terminate) และรอบถัดไปต้องทำงานได้ปกติ
async function runCancel(song, mode, afterMs) {
  await upload(song.file);
  return ev(`(async () => {
    const file = document.getElementById('aqE2E').files[0];
    const ctl = { aborted: false };
    let stage = '';
    const t0 = performance.now();
    setTimeout(() => { ctl.aborted = true; }, ${afterMs});
    try { await Analyze.run({ kind: 'file', file, tracks: '${mode}' }, (p) => { stage = p.stage; }, ctl); return { ok: false, why: 'ไม่ถูกยกเลิก' }; }
    catch (e) { return { ok: e.message === 'cancelled', msg: e.message, stage, ms: Math.round(performance.now() - t0) }; }
  })()`);
}

const report = { caps, runs: [] };
if (flag('cancel')) {
  for (const [mode, ms] of [['full', 2500], ['lite', 1500]]) {
    const r = await runCancel(songs[0], mode, ms);
    console.log(`ยกเลิก ${mode} หลัง ${ms}ms → ${JSON.stringify(r)} (ยกเลิกเสร็จใน ${r.ms - ms}ms)`);
    report.runs.push({ cancel: mode, result: r });
  }
}
for (const song of songs) {
  const minutes = song.s.duration / 60;
  for (const mode of [null].concat(MODES)) {
    if (mode === null && song !== songs[0] && !LONG) continue;
    process.stdout.write(`\n=== ${song.bars} ห้อง (${song.s.duration.toFixed(1)}s) · tracks=${mode || 'off'} ... `);
    let res;
    try { res = await runMode(song, mode); } catch (e) { console.log('FAILED', e.message); report.runs.push({ bars: song.bars, mode, error: e.message }); continue; }
    console.log(`${res.ms}ms (${Math.round(res.ms / minutes)}ms ต่อนาทีเสียง) · key ${res.key} · ${res.tempo} BPM · monotonic ${res.mono}`);
    console.log('  stage ms:', JSON.stringify(res.stageMs));
    if (mode) {
      console.log(`  _tracksError=${res.err} _tracksFallback=${res.fb} source=${res.tracks && res.tracks.source} bpm=${res.tracks && res.tracks.bpm} phase=${res.tracks && res.tracks.phase} tracks=${res.tracks ? res.tracks.tracks.map((t) => t.id + ':' + t.notes.length).join(' ') : '-'}`);
      score(song, res, mode).forEach(([k, e]) => console.log('  ' + k.padEnd(30) + fmtE(e)));
      const dl = res.net.filter((r) => r.bytes != null);
      if (dl.length) {
        console.log('  ดาวน์โหลด (ที่ส่งผ่านเน็ตจริง):');
        dl.forEach((r) => console.log(`    ${(r.bytes / 1048576).toFixed(2).padStart(8)} MB  ${r.status} ${r.url.replace(/\?.*$/, '').slice(0, 110)}`));
        console.log(`    รวม ${(dl.reduce((a, r) => a + r.bytes, 0) / 1048576).toFixed(2)} MB`);
      }
      if (res.details.length) console.log('  ข้อความระหว่างทำงาน:', [...new Set(res.details.map((d) => d.replace(/ \d+%$| \d+\/\d+$/, '')))].join(' | '));
      if (flag('direct')) {
        const d = await runDirect(song, mode, Math.round(+res.tempo) || 100, 0.5);
        console.log('  direct (debug):', JSON.stringify(d));
        report.runs.push({ bars: song.bars, mode, direct: d });
      }
    }
    report.runs.push({ bars: song.bars, seconds: song.s.duration, mode, ms: res.ms, perMinute: Math.round(res.ms / minutes), stageMs: res.stageMs,
      tracksError: res.err, fallback: res.fb, monotonic: res.mono, key: res.key, tempo: res.tempo,
      scores: mode ? Object.fromEntries(score(song, res, mode).map(([k, e]) => [k.trim(), { F1: +e.F1.toFixed(3), P: +e.P.toFixed(3), R: +e.R.toFixed(3), tp: e.tp, nRef: e.nRef, nEst: e.nEst, dtMs: Math.round(e.meanDt * 1000) }])) : null,
      downloads: res.net.filter((r) => r.bytes != null).map((r) => ({ url: r.url.replace(/\?.*$/, ''), mb: +(r.bytes / 1048576).toFixed(3) })),
      sample: mode && res.tracks ? { v: res.tracks.v, source: res.tracks.source, bpm: res.tracks.bpm, phase: res.tracks.phase, duration: res.tracks.duration, tracks: res.tracks.tracks.map((t) => ({ id: t.id, kind: t.kind, program: t.program, n: t.notes.length, first: t.notes.slice(0, 3) })) } : null });
  }
}
if (logs.length) console.log('\nconsole:', logs.slice(0, 20).join('\n'));
const jf = arg('json', '');
if (jf) writeFileSync(jf, JSON.stringify(report, null, 2));
ws.close(); proc.kill(); server.close();
process.exit(0);
