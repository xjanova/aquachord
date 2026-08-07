#!/usr/bin/env node
/* e2e-lyrics.cjs — เทสต์ end-to-end ในเบราว์เซอร์จริง (Chromium ผ่าน Playwright)
   ตรวจว่า "เนื้อร้องขึ้นบนจอจริงไหม": สวิตช์เปิดเป็นค่าเริ่มต้น → อัปโหลดไฟล์เสียง
   → worker ทำงาน → ผสานคอร์ด+เนื้อร้อง → ChordPro → DOM

   โมดูล transformers.js ถูกดักที่ชั้นเน็ตเวิร์กแล้วแทนด้วยตัวปลอมที่คืน chunk ตายตัว
   (ไม่ต้องดาวน์โหลดโมเดลจริง ~85MB และรันในเครื่องที่ออกเน็ตไม่ได้ก็ผ่าน)
   → ทดสอบ "ท่อทั้งเส้น" ยกเว้นตัวโมเดล ซึ่งต้องลองกับเพลงจริงบนเครื่องผู้ใช้

   เตรียมก่อนรัน:  npm i playwright && npx playwright install chromium
   ใช้:            node tools/e2e-lyrics.cjs
   ข้ามอัตโนมัติ (exit 0) ถ้าไม่มี playwright — CI หลักไม่ต้องติดตั้งเบราว์เซอร์ */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.log('⏭  ข้าม e2e — ยังไม่ได้ติดตั้ง playwright (npm i playwright && npx playwright install chromium)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..', 'site');
const WAV = path.join(os.tmpdir(), 'aquachord-test.wav');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

// โมดูลปลอมแทน transformers.js — pipeline() คืนฟังก์ชันที่ให้ chunk ตัวอย่าง (ข้อความทดสอบของเราเอง)
const FAKE_TRANSFORMERS = `
export const env = { version: '3.3.1' };
export async function pipeline(task, repo, opts) {
  if (opts && opts.progress_callback) {
    opts.progress_callback({ file: 'encoder.onnx', loaded: 50, total: 100 });
    opts.progress_callback({ file: 'encoder.onnx', loaded: 100, total: 100, status: 'done' });
  }
  return async function (pcm) {
    if (!pcm || !pcm.length) throw new Error('worker ไม่ได้รับ PCM');
    return {
      text: 'บรรทัดทดสอบหนึ่ง บรรทัดทดสอบสอง',
      chunks: [
        { timestamp: [0.5, 4.0], text: ' บรรทัดทดสอบหนึ่ง ' },
        { timestamp: [4.5, 8.0], text: ' บรรทัดทดสอบสอง ' },
      ],
    };
  };
}
`;

function findChromium() {
  const base = '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined; // ให้ playwright หาเอง
  const dir = fs.readdirSync(base).find((d) => /^chromium-\d+$/.test(d));
  const exe = dir && path.join(base, dir, 'chrome-linux', 'chrome');
  return exe && fs.existsSync(exe) ? exe : undefined;
}

(async () => {
  if (!fs.existsSync(WAV)) {
    console.log('→ สร้างไฟล์เสียงทดสอบ ...');
    execFileSync('python3', [path.join(__dirname, 'make-test-wav.py'), WAV], { stdio: 'inherit' });
  }

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

  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  await ctx.route(/(jsdelivr|unpkg|huggingface)/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TRANSFORMERS }));
  await ctx.route(/fonts\.g/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const fail = async (msg) => {
    console.error('✗ ' + msg);
    if (errors.length) console.error('  errors:\n   - ' + errors.join('\n   - '));
    await browser.close(); server.close();
    process.exit(1);
  };

  await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker &&
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())));

  // 1) สวิตช์ถอดเนื้อร้องต้องมีอยู่ และเปิดไว้เป็นค่าเริ่มต้น
  if (!(await page.locator('#lyrOn').count())) await fail('ไม่พบสวิตช์ถอดเนื้อร้อง (#lyrOn)');
  if (!(await page.locator('#lyrOn').isChecked())) await fail('สวิตช์ถอดเนื้อร้องควรเปิดไว้เป็นค่าเริ่มต้น');

  // 2) อัปโหลดไฟล์ แล้วรอผล
  await page.click('.ingest-tab[data-mode="file"]');
  await page.setInputFiles('#fileInput', WAV);
  await page.click('#startBtn');
  if (await page.locator('#cpAccept').count()) await page.click('#cpAccept');
  try {
    await page.waitForFunction(() => location.hash.startsWith('#/song/'), { timeout: 180000 });
  } catch (e) {
    const detail = await page.locator('#jobDetail').textContent().catch(() => '-');
    await fail('วิเคราะห์ไม่จบ — detail: ' + detail);
  }
  await page.waitForTimeout(500);

  // 3) เนื้อร้องต้องอยู่ใน DOM — ประกอบกลับจาก .seg-text (คอร์ดแทรกกลางคำได้)
  const lines = await page.$$eval('#sheet .cp-line', (els) => els
    .map((el) => Array.from(el.querySelectorAll('.seg-text')).map((s) => s.textContent).join('').trim())
    .filter(Boolean));
  const doc = await page.evaluate(() => {
    const id = location.hash.split('/')[2];
    const s = JSON.parse(localStorage.getItem('aq.songs.v1') || '[]').find((x) => x.id === id);
    return s && { key: s.key, lyricsText: s.lyricsText, lyricsError: s.lyricsError, lyricsEmpty: s.lyricsEmpty };
  });
  const status = await page.locator('.lyr-status').innerText().catch(() => '');

  console.log('  คีย์ที่แกะได้   :', doc && doc.key);
  console.log('  lyricsError    :', (doc && doc.lyricsError) || '-');
  console.log('  บรรทัดเนื้อร้อง :', JSON.stringify(lines));
  console.log('  แถบสถานะ       :', status || '(ไม่มี)');

  if (doc && doc.lyricsError) await fail('ถอดเนื้อร้องล้มเหลว: ' + doc.lyricsError);
  if (!lines.includes('บรรทัดทดสอบหนึ่ง') || !lines.includes('บรรทัดทดสอบสอง')) {
    await fail('เนื้อร้องไม่ขึ้นบนจอ');
  }
  if (!/Beta/.test(status)) await fail('ไม่มีแถบสถานะเนื้อร้องในหน้าเพลง');
  if (errors.length) await fail('มี error ในหน้าเว็บ');

  console.log('✓ e2e ผ่าน — เนื้อร้องขึ้นบนจอพร้อมคอร์ด');
  await browser.close();
  server.close();
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(3); });
