#!/usr/bin/env node
/* e2e-gpu.cjs — เทสต์โหมด AI เซิร์ฟเวอร์ (GPU) ในเบราว์เซอร์จริง (Chromium ผ่าน Playwright)
   /api/gpu/* ถูกดักด้วย mock ในเทสต์ (ไม่แตะเซิร์ฟเวอร์จริง ไม่เช่า GPU) แล้วตรวจ:
   - ผู้ใช้ทั่วไปไม่เห็นแผง GPU และไม่มีการเรียก /api/gpu
   - แอดมิน: แผงขึ้น → ส่งไฟล์ (multipart ถูกต้อง) → หน้า job (คิว/เปิดเครื่อง/ถอด)
     → รีโหลดกลางงานแล้ว poll ต่อ → เสร็จ → บันทึกเพลงครั้งเดียว + เปิดหน้าเพลง
   - งานเสร็จตอนอยู่หน้าอื่น → การแจ้งเตือนในแอป + ชิปหน้าแรก
   - ยกเลิกงานที่รอคิว, โควตาเต็ม (429), token หมดอายุ (401), localStorage ถูกแก้มั่ว
   เตรียมก่อนรัน:  npm i playwright (หรือ playwright-core) && npx playwright install chromium
   ใช้:            node tools/e2e-gpu.cjs   (ภาพหน้าจอไปที่ $AQ_SHOTS หรือ <tmp>/aquachord-shots)
   ข้ามอัตโนมัติ (exit 0) ถ้าไม่มี playwright */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  try { ({ chromium } = require('playwright-core')); }
  catch (e2) { console.log('⏭  ข้าม e2e-gpu — ยังไม่ได้ติดตั้ง playwright'); process.exit(0); }
}

const ROOT = path.join(__dirname, '..', 'site');
const SHOTS = process.env.AQ_SHOTS || path.join(os.tmpdir(), 'aquachord-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const TOKEN = 'a'.repeat(64);
const EXPIRED = 'b'.repeat(64);

/* ---------- ไฟล์เสียงทดสอบ (WAV sine 2 วิ) ---------- */
function makeWav() {
  const sr = 8000, n = sr * 2;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 8000), 44 + i * 2);
  return buf;
}

/* ---------- ผลจาก node (TranscriptionResult v1) ---------- */
function fixtureResult() {
  const beats = []; for (let x = 0.5; x < 40; x += 0.5) beats.push(+x.toFixed(3));
  const syl = (a) => a.map(([t0, t1, text]) => ({ t0, t1, text }));
  return {
    format: 'aquachord-transcription', version: 1, mode: 'open',
    engine: { node: 'comfyui-aquachord@0.1.0', models: {} },
    durationSec: 40, tempo: 120, timeSig: [4, 4], beats, downbeats: beats.filter((_, i) => i % 4 === 0), key: 'G',
    chords: [
      { t0: 0.5, t1: 2.5, label: 'G', conf: 0.9 }, { t0: 2.5, t1: 4.5, label: 'Em', conf: 0.8 },
      { t0: 4.5, t1: 6.5, label: 'C', conf: 0.8 }, { t0: 6.5, t1: 8.5, label: 'D', conf: 0.8 },
      { t0: 8.5, t1: 10.5, label: 'G', conf: 0.9 }, { t0: 10.5, t1: 12.5, label: 'D', conf: 0.9 },
      { t0: 12.5, t1: 14.5, label: 'Em', conf: 0.9 }, { t0: 14.5, t1: 16.5, label: 'C', conf: 0.9 },
      { t0: 16.5, t1: 20.5, label: 'G', conf: 0.9 },
    ],
    sections: [{ t: 0.5, label: 'intro' }, { t: 8.5, label: 'verse' }],
    lyrics: { source: 'user', language: 'th', text: 'ทะเลสีครามงามตา\nคิดถึงเธอทุกเวลา', lines: [
      { t0: 8.5, t1: 12.4, text: 'ทะเลสีครามงามตา', syllables: syl([[8.5, 9.0, 'ทะ'], [9.0, 9.5, 'เล'], [9.5, 10.0, 'สี'], [10.0, 10.5, 'คราม'], [10.5, 11.5, 'งาม'], [11.5, 12.4, 'ตา']]) },
      { t0: 12.5, t1: 16.4, text: 'คิดถึงเธอทุกเวลา', syllables: syl([[12.5, 13.0, 'คิด'], [13.0, 13.5, 'ถึง'], [13.5, 14.5, 'เธอ'], [14.5, 15.0, 'ทุก'], [15.0, 15.5, 'เว'], [15.5, 16.4, 'ลา']]) },
    ] },
    melody: { source: 'fcpe', notes: [
      { t0: 8.5, t1: 9.0, pitch: 67 }, { t0: 9.0, t1: 9.5, pitch: 69 }, { t0: 9.5, t1: 10.0, pitch: 71 },
      { t0: 10.0, t1: 10.5, pitch: 74 }, { t0: 10.5, t1: 11.5, pitch: 71 }, { t0: 11.5, t1: 12.4, pitch: 67 },
      { t0: 12.5, t1: 13.0, pitch: 64 }, { t0: 13.0, t1: 13.5, pitch: 67 }, { t0: 13.5, t1: 14.5, pitch: 71 },
    ] },
    warnings: [], timings: {},
  };
}

/* ---------- mock /api/gpu/* ---------- */
const mock = {
  jobs: new Map(), seq: 0, hold: false, calls: [], lastPost: null, nextPostError: null, expired: new Set([EXPIRED]),
  config() {
    return { configured: true, baseUrl: 'https://ai.xman4289.com', keyHint: '…abcd', defaultMode: 'open',
      remote: { ok: true, partner: 'aquachord', enabled: true, allowSheetSage2: true, defaultMode: 'open',
        limits: { maxAudioMb: 40, maxSeconds: 600, maxJobsPerDay: 20, maxActiveJobs: 2 }, usage: { jobsToday: 1, activeJobs: 0 } } };
  },
  view(j) {
    const { polls, script, ...job } = j; // eslint-disable-line no-unused-vars
    return job;
  },
  advance(j) {
    if (j.script === 'stuck' || (this.hold && j.status === 'rendering')) return;
    j.polls++;
    const p = j.polls;
    if (p <= 2) Object.assign(j, { status: 'queued', stageLabel: 'รอคิว GPU', queuePosition: 1, etaSeconds: 150, progress: null });
    else if (p <= 4) Object.assign(j, { status: 'starting', stageLabel: 'กำลังเปิดเครื่อง GPU (ครั้งแรกอาจนานหลายนาที)', queuePosition: null, etaSeconds: 120, progress: null });
    else if (p <= 7) Object.assign(j, { status: 'rendering', stageLabel: 'กำลังถอดคอร์ดและเนื้อร้อง', progress: [0.2, 0.5, 0.8][p - 5], etaSeconds: [60, 40, 15][p - 5] });
    else Object.assign(j, { status: 'completed', stageLabel: 'เสร็จแล้ว', progress: 1, etaSeconds: null, completedAt: Date.now(), gpuSeconds: 42 });
  },
};

async function handleApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const auth = req.headers()['authorization'] || '';
  mock.calls.push(method + ' ' + url.pathname);
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
  const tok = auth.replace(/^Bearer\s+/, '');
  if (mock.expired.has(tok) || !/^[a-f0-9]{64}$/.test(tok)) return json(401, { error: { code: 'UNAUTHORIZED', message: 'กรุณาเข้าสู่ระบบ' } });
  const p = url.pathname.replace(/^.*\/api/, '');
  if (p === '/gpu/config' && method === 'GET') return json(200, mock.config());
  if (p === '/gpu/jobs' && method === 'POST') {
    if (mock.nextPostError) { const e = mock.nextPostError; mock.nextPostError = null; return json(e.status, { error: { code: e.code, message: e.message } }); }
    const body = req.postDataBuffer() || Buffer.alloc(0);
    mock.lastPost = { size: body.length, text: body.toString('utf8'), contentType: req.headers()['content-type'] || '' };
    const id = 'gj_e2e' + (++mock.seq);
    const mode = (mock.lastPost.text.match(/name="mode"\r\n\r\n(\w+)/) || [])[1] || 'open';
    const title = (mock.lastPost.text.match(/name="title"\r\n\r\n([^\r]*)/) || [])[1] || '';
    const j = { id, status: 'queued', stageLabel: 'รอคิว GPU', progress: null, etaSeconds: 150, etaLabel: null, queuePosition: 2,
      mode, title, fileName: 'x.wav', createdAt: Date.now(), completedAt: null, errorMessage: null, gpuSeconds: null,
      polls: 0, script: mock.nextScript || 'normal' };
    mock.nextScript = null;
    mock.jobs.set(id, j);
    return json(201, { job: mock.view(j) });
  }
  if (p === '/gpu/jobs' && method === 'GET') return json(200, { jobs: Array.from(mock.jobs.values()).map((j) => mock.view(j)) });
  const m = p.match(/^\/gpu\/jobs\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const j = mock.jobs.get(m[1]);
    if (!j) return json(404, { error: { code: 'NOT_FOUND', message: 'ไม่พบงาน' } });
    if (method === 'DELETE') {
      if (j.status !== 'queued') return json(409, { error: { code: 'NOT_CANCELLABLE', message: 'ยกเลิกไม่ได้' } });
      Object.assign(j, { status: 'cancelled', stageLabel: 'ยกเลิกแล้ว', script: 'stuck' });
      return json(200, { job: mock.view(j) });
    }
    if (j.status !== 'cancelled') mock.advance(j);
    const out = { job: mock.view(j) };
    if (j.status === 'completed') out.result = fixtureResult();
    return json(200, out);
  }
  return json(404, { error: { code: 'NOT_FOUND', message: 'ไม่พบ' } });
}

(async () => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 }, locale: 'th-TH' });
  await ctx.route(/fonts\.g/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('**/api/**', handleApi);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  const results = [];
  const ok = (m) => { results.push('✓ ' + m); console.log('  ✓ ' + m); };
  const fail = async (msg) => {
    console.error('✗ ' + msg);
    if (errors.length) console.error('  errors:\n   - ' + errors.join('\n   - '));
    await page.screenshot({ path: path.join(SHOTS, 'gpu-FAIL.png'), fullPage: true }).catch(() => {});
    await browser.close(); server.close();
    process.exit(1);
  };
  const expect = async (cond, msg) => { if (!cond) await fail(msg); else ok(msg); };
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
  const songsFor = (jobId) => page.evaluate((id) => JSON.parse(localStorage.getItem('aq.songs.v1') || '[]')
    .filter((s) => s.analysis && s.analysis.jobId === id).length, jobId);
  const wav = { name: 'ทะเลสีคราม_demo.wav', mimeType: 'audio/wav', buffer: makeWav() };

  /* 1) ผู้ใช้ทั่วไป */
  await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('aq.copyright.ok', '1'); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('.ingest-tab[data-mode="file"]');
  await page.waitForTimeout(400);
  await expect(!(await page.locator('#gpuIngest, .gpu-box').count()), 'ผู้ใช้ทั่วไปไม่เห็นแผง GPU');
  await expect(!mock.calls.length, 'ผู้ใช้ทั่วไปไม่เรียก /api/gpu เลย');
  await expect(await page.locator('.lyr-box').isVisible(), 'ผู้ใช้ทั่วไปยังเห็นตัวเลือกถอดเนื้อในเครื่อง');
  await shot('gpu-01-public-no-panel.png');

  /* 2) แอดมิน: แผงขึ้น */
  await page.evaluate((tk) => localStorage.setItem('aq.admin.token', tk), TOKEN);
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('.ingest-tab[data-mode="file"]');
  await page.waitForSelector('#gpuBox', { timeout: 5000 }).catch(() => {});
  await expect(await page.locator('#gpuBox').isVisible(), 'แอดมินเห็นแผง GPU ในแท็บอัปโหลดไฟล์');
  await expect(await page.locator('#gpuOn').isChecked(), 'สวิตช์ GPU เปิดเป็นค่าเริ่มต้น');
  await expect((await page.locator('#gpuMode option').count()) === 2, 'มีตัวเลือก SheetSage2 เมื่อเซิร์ฟเวอร์อนุญาต');
  await expect(!(await page.locator('.lyr-box').isVisible()), 'ซ่อนตัวเลือกถอดเนื้อในเครื่องเมื่อใช้ GPU');
  await page.selectOption('#gpuMode', 'sheetsage2');
  await expect(await page.locator('#gpuNc').isVisible(), 'เลือก SheetSage2 แล้วขึ้นคำเตือนไม่ใช่เชิงพาณิชย์');
  await page.selectOption('#gpuMode', 'open');
  await page.click('.ingest-tab[data-mode="url"]');
  await expect(await page.locator('.lyr-box').isVisible(), 'แท็บลิงก์ยังเห็นตัวเลือกถอดเนื้อในเครื่อง');
  await page.click('.ingest-tab[data-mode="file"]');
  await page.setInputFiles('#fileInput', wav);
  await page.fill('#gpuLyrics', 'ทะเลสีครามงามตา\nคิดถึงเธอทุกเวลา');
  await shot('gpu-02-admin-panel.png');

  /* 3) ส่งงาน → หน้า job */
  await page.click('#startBtn');
  await page.waitForFunction(() => location.hash.startsWith('#/job/'), { timeout: 10000 }).catch(() => {});
  const jobId = await page.evaluate(() => location.hash.split('/')[2]);
  await expect(/^gj_e2e\d+$/.test(jobId || ''), 'ส่งงานแล้วไปหน้า #/job/<id> (' + jobId + ')');
  const lp = mock.lastPost || { text: '', contentType: '' };
  await expect(/multipart\/form-data/.test(lp.contentType), 'POST เป็น multipart/form-data');
  await expect(/name="file"; filename="[^"]*\.wav"/.test(lp.text) && lp.size > 30000, 'multipart มีไฟล์เสียง');
  await expect(lp.text.includes('ทะเลสีครามงามตา') && /name="language"\r\n\r\nth/.test(lp.text) && /name="mode"\r\n\r\nopen/.test(lp.text), 'multipart มีเนื้อเพลง/ภาษา/โหมด');
  await page.waitForSelector('#gpuJob');
  await expect(/รอคิว/.test(await page.locator('#gpuJobStage').innerText()), 'สถานะเริ่มต้น: รอคิว');
  await expect(/คิวที่/.test(await page.locator('#gpuJobMeta').innerText()), 'แสดงลำดับคิว');
  await expect(/หลายนาที/.test(await page.locator('#gpuJobNotes').innerText()), 'มีหมายเหตุเครื่อง GPU บูตนาน');
  await expect(/ออกจากหน้านี้ได้/.test(await page.locator('#gpuJobNotes').innerText()), 'บอกว่าออกจากหน้าได้ งานทำต่อเบื้องหลัง');
  await expect(await page.locator('[data-act="cancel"]').isVisible(), 'มีปุ่มยกเลิกตอนรอคิว');
  await shot('gpu-03-job-queued.png');
  await page.waitForFunction(() => /เปิดเครื่อง/.test((document.querySelector('#gpuJobStage') || {}).textContent || ''), { timeout: 15000 }).catch(() => {});
  await expect(/เปิดเครื่อง/.test(await page.locator('#gpuJobStage').innerText()), 'สถานะเปิดเครื่อง GPU (label จากเซิร์ฟเวอร์)');

  /* 4) รีโหลดกลางงาน → poll ต่อ */
  mock.hold = true;
  await page.waitForFunction(() => /ถอดคอร์ด/.test((document.querySelector('#gpuJobStage') || {}).textContent || ''), { timeout: 15000 }).catch(() => {});
  await expect(/ถอดคอร์ด/.test(await page.locator('#gpuJobStage').innerText()), 'สถานะกำลังถอด + แถบความคืบหน้า');
  await shot('gpu-04-job-rendering.png');
  const pollsBefore = mock.jobs.get(jobId).polls;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#gpuJob');
  await page.waitForTimeout(3500);
  await expect(mock.calls.filter((c) => c === 'GET /api/gpu/jobs/' + jobId).length > pollsBefore, 'รีโหลดแล้ว poll งานต่ออัตโนมัติ');
  await expect(/ถอดคอร์ด/.test(await page.locator('#gpuJobStage').innerText()), 'หลังรีโหลดยังแสดงงานเดิม');
  await shot('gpu-05-resumed-after-reload.png');
  mock.hold = false;

  /* 5) เสร็จ → เพลงถูกบันทึกและเปิด */
  await page.waitForFunction(() => location.hash.startsWith('#/song/'), { timeout: 30000 }).catch(() => {});
  const hash = await page.evaluate(() => location.hash);
  await expect(hash.startsWith('#/song/'), 'งานเสร็จแล้วเปิดหน้าเพลงให้ (' + hash + ')');
  await page.waitForSelector('#sheet');
  const doc = await page.evaluate(() => {
    const id = location.hash.split('/')[2];
    return JSON.parse(localStorage.getItem('aq.songs.v1') || '[]').find((s) => s.id === id);
  });
  await expect(doc && doc.schemaVersion === 2 && doc.analysis && doc.analysis.engine === 'gpu' && doc.analysis.jobId === jobId, 'SongDoc v2 engine gpu + jobId');
  await expect(doc && doc.creator === 'AquaChord AI (GPU)' && doc.key === 'G' && doc.tempo === '120', 'creator/key/tempo ถูกต้อง');
  await expect(doc && doc.melody && doc.melody.notes.length > 0 && doc.melody.notes.some((n) => n.syl === 'ทะ'), 'มี melody พร้อมพยางค์');
  const lyr1 = doc && doc.chordpro.split('\n').find((l) => l.includes('ทะเล') && !l.startsWith('{'));
  await expect(lyr1 === '[G]ทะเลสีคราม[D]งามตา', 'ChordPro วางคอร์ดตรงพยางค์ (' + lyr1 + ')');
  const sheetText = await page.locator('#sheet').innerText();
  await expect(sheetText.includes('ทะเลสี') && sheetText.includes('คิดถึง'), 'เนื้อร้องขึ้นบนจอหน้าเพลง');
  await shot('gpu-06-song-opened.png');
  await expect((await songsFor(jobId)) === 1, 'สร้างเพลง 1 ครั้งต่องาน');

  /* 6) idempotent: กลับไปหน้า job ไม่เด้ง + poll ซ้ำไม่สร้างเพลงซ้ำ */
  await page.goto(base + '/index.html#/job/' + jobId, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await expect((await page.evaluate(() => location.hash)) === '#/job/' + jobId, 'เปิดหน้า job ที่เสร็จแล้ว ไม่เด้งไปหน้าเพลงเอง (กัน back วน)');
  await expect(await page.locator('#gpuJobActions a[href^="#/song/"]').isVisible(), 'หน้า job ที่เสร็จมีปุ่มเปิดเพลง');
  await page.evaluate((id) => GPU.poll(id), jobId);
  await page.waitForTimeout(1500);
  await expect((await songsFor(jobId)) === 1, 'poll ซ้ำหลังเสร็จไม่สร้างเพลงซ้ำ');
  await page.evaluate((id) => { // จำลองรายการในเครื่องหาย songId → ต้องหาเพลงเดิมจาก analysis.jobId
    const l = JSON.parse(localStorage.getItem('aq.gpu.jobs'));
    l.forEach((e) => { if (e.id === id) { e.songId = null; } });
    localStorage.setItem('aq.gpu.jobs', JSON.stringify(l));
  }, jobId);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await expect((await songsFor(jobId)) === 1, 'songId หาย → ไม่สร้างซ้ำ (อ้าง analysis.jobId)');

  /* 7) งานเสร็จตอนอยู่หน้าอื่น → แจ้งเตือนในแอป + ชิป */
  await page.goto(base + '/index.html#/', { waitUntil: 'networkidle' });
  await page.click('.ingest-tab[data-mode="file"]');
  await page.waitForSelector('#gpuBox');
  await page.setInputFiles('#fileInput', wav);
  await page.click('#startBtn');
  await page.waitForFunction(() => location.hash.startsWith('#/job/'), { timeout: 10000 });
  const job2 = await page.evaluate(() => location.hash.split('/')[2]);
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#gpuChipSlot .gpu-chip', { timeout: 5000 }).catch(() => {});
  await expect(/กำลังทำ 1/.test(await page.locator('#gpuChipSlot').innerText().catch(() => '')), 'หน้าแรกมีชิปงานกำลังทำ');
  await shot('gpu-07-home-chip-active.png');
  await page.evaluate(() => { location.hash = '#/library'; });
  await page.waitForSelector('.gpu-notice', { timeout: 30000 }).catch(() => {});
  await expect(await page.locator('.gpu-notice').isVisible(), 'งานเสร็จตอนอยู่หน้าอื่น → มีแจ้งเตือนในแอป');
  await expect((await page.evaluate(() => location.hash)) === '#/library', 'ไม่ดึงผู้ใช้ออกจากหน้าที่อยู่');
  await shot('gpu-08-notice-other-page.png');
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(300);
  await expect(/เสร็จใหม่ 1/.test(await page.locator('#gpuChipSlot').innerText().catch(() => '')), 'ชิปบอกงานเสร็จใหม่');
  await page.click('.gpu-notice-go');
  await page.waitForTimeout(300);
  await expect((await page.evaluate(() => location.hash)).startsWith('#/song/') && (await songsFor(job2)) === 1, 'กดแจ้งเตือนแล้วเปิดเพลงของงานที่ 2');

  /* 8) หน้า #/jobs */
  await page.evaluate(() => { location.hash = '#/jobs'; });
  await page.waitForSelector('.gpu-list');
  await expect((await page.locator('.gpu-item').count()) === 2, 'หน้า #/jobs แสดง 2 งาน');
  await shot('gpu-09-jobs-list.png');

  /* 9) ยกเลิกงานที่รอคิว */
  mock.nextScript = 'stuck';
  await page.goto(base + '/index.html#/', { waitUntil: 'networkidle' });
  await page.click('.ingest-tab[data-mode="file"]');
  await page.waitForSelector('#gpuBox');
  await page.setInputFiles('#fileInput', wav);
  await page.click('#startBtn');
  await page.waitForFunction(() => location.hash.startsWith('#/job/'), { timeout: 10000 });
  const job3 = await page.evaluate(() => location.hash.split('/')[2]);
  mock.jobs.get(job3).status = 'queued';
  await page.click('[data-act="cancel"]');
  await page.waitForFunction(() => /ยกเลิกแล้ว/.test((document.querySelector('#gpuJobStage') || {}).textContent || ''), { timeout: 8000 }).catch(() => {});
  await expect(/ยกเลิกแล้ว/.test(await page.locator('#gpuJobStage').innerText()) && mock.calls.includes('DELETE /api/gpu/jobs/' + job3), 'ยกเลิกงานที่รอคิวได้ (DELETE)');
  await shot('gpu-10-cancelled.png');

  /* 10) โควตาเต็ม 429 → ข้อความไทย กลับหน้าแรก */
  mock.nextPostError = { status: 429, code: 'DAILY_LIMIT', message: 'x' };
  await page.goto(base + '/index.html#/', { waitUntil: 'networkidle' });
  await page.click('.ingest-tab[data-mode="file"]');
  await page.waitForSelector('#gpuBox');
  await page.setInputFiles('#fileInput', wav);
  await page.click('#startBtn');
  await page.waitForSelector('.toast', { timeout: 8000 }).catch(() => {});
  const toastTxt = await page.locator('.toast').last().innerText().catch(() => '');
  await expect(/โควตา/.test(toastTxt), 'โควตาเต็ม → toast ภาษาไทย (' + toastTxt + ')');
  await page.waitForTimeout(300);
  await expect(await page.locator('#startBtn').isVisible(), 'ส่งไม่สำเร็จ → กลับหน้าแกะเพลง');

  /* 11) localStorage ถูกแก้มั่ว → แอปไม่พัง */
  for (const junk of ['not json', '{"x":1}', '[{"id":"../../etc"},{"id":"ok_1","status":"<img src=x onerror=alert(1)>","title":{"a":1}},null,5]']) {
    await page.evaluate((j) => { localStorage.setItem('aq.gpu.jobs', j); localStorage.setItem('aq.gpu.pref', j); }, junk);
    await page.goto(base + '/index.html#/jobs', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
  }
  const junkState = await page.evaluate(() => GPU.jobs().map((e) => ({ id: e.id, status: e.status, title: e.title })));
  await expect(junkState.every((e) => /^[A-Za-z0-9_-]+$/.test(e.id) && ['queued', 'starting', 'rendering', 'completed', 'failed', 'cancelled'].includes(e.status) && typeof e.title === 'string'), 'รายการงานที่ถูกแก้มั่วถูกกรองทิ้ง/ทำความสะอาด ' + JSON.stringify(junkState));
  await expect(!(await page.locator('img[src="x"]').count()), 'ไม่มี HTML แทรกจาก localStorage');

  /* 12) มือถือ */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(base + '/index.html#/job/' + job3, { waitUntil: 'networkidle' });
  await page.waitForSelector('#gpuJob');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await expect(overflow <= 1, 'หน้า job บนมือถือไม่ล้นแนวนอน (' + overflow + ')');
  await shot('gpu-11-mobile-job.png');
  await page.goto(base + '/index.html#/', { waitUntil: 'networkidle' });
  await page.click('.ingest-tab[data-mode="file"]');
  await page.waitForSelector('#gpuBox');
  await page.locator('#gpuBox').scrollIntoViewIfNeeded();
  await shot('gpu-12-mobile-panel.png');
  await page.setViewportSize({ width: 1100, height: 900 });

  /* 13) token หมดอายุ → เคลียร์ + ชี้ไปหน้า /admin/ */
  await page.evaluate((tk) => localStorage.setItem('aq.admin.token', tk), EXPIRED);
  await page.goto(base + '/index.html#/', { waitUntil: 'networkidle' });
  await page.click('.ingest-tab[data-mode="file"]');
  await page.waitForSelector('.gpu-notice', { timeout: 5000 }).catch(() => {});
  const tokAfter = await page.evaluate(() => localStorage.getItem('aq.admin.token'));
  await expect(tokAfter === null, '401 → ล้าง token แอดมิน');
  await expect(await page.locator('.gpu-notice a[href="/admin/"]').isVisible(), '401 → แจ้งให้เข้าสู่ระบบที่ /admin/');
  await expect(!(await page.locator('#gpuBox').count()), '401 → ไม่แสดงแผง GPU (กลับไปโหมดในเครื่อง)');
  await shot('gpu-13-auth-expired.png');

  // สถานะ 4xx ที่ mock ตั้งใจตอบ (401/404/409/429) Chrome log เป็น "Failed to load resource" — ไม่ใช่บั๊ก
  const real = errors.filter((e) => !/Failed to load resource/i.test(e));
  if (real.length) await fail('มี error ในหน้าเว็บ:\n   - ' + real.join('\n   - '));
  console.log('✓ e2e-gpu ผ่าน ' + results.length + ' ข้อ — ภาพหน้าจอ: ' + SHOTS);
  await browser.close();
  server.close();
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(3); });
