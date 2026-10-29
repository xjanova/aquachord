#!/usr/bin/env node
/* test-handoff.cjs — รับเพลงจากแอปพันธมิตร (X-DREAMER/aixman) ผ่านลิงก์ #/import: แยกลิงก์ · allowlist · manifest · ดึงไฟล์ (fetch จำลอง) */
'use strict';
const path = require('path');
const H = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'handoff.js'));

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('✗ ' + msg); } else console.log('✓ ' + msg); };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
const acode = (p) => p.then(() => null, (e) => e.code);

const PROD = { hostname: 'aquachord.online' };
const DEV = { hostname: 'localhost' };
const AX = 'https://ai.xman4289.com';
const enc = encodeURIComponent;

// ---------- parse ----------
ok(H.parse('#/') === null && H.parse('#/song/abc') === null && H.parse('') === null, 'parse: ไม่ใช่ลิงก์ import → null');
const pm = H.parse('#/import?m=' + enc(AX + '/api/partner/aquachord/handoff/tok123'));
ok(pm && pm.kind === 'manifest' && pm.url === AX + '/api/partner/aquachord/handoff/tok123', 'parse: m= → manifest (ถอด URL encode)');
const pa = H.parse('#/import?src=' + enc(AX + '/x/song.mp3') + '&title=' + enc('ฝนตก\u0007ที่หน้าต่าง'));
ok(pa && pa.kind === 'audio' && pa.title === 'ฝนตก ที่หน้าต่าง', 'parse: src= + title (ตัดอักขระควบคุม)');
ok(code(() => H.parse('#/import')) === 'bad' && code(() => H.parse('#/import?x=1')) === 'bad', 'parse: import ไม่มี m/src → bad');
ok(H.parse('import?m=' + enc(AX + '/a')).kind === 'manifest', 'parse: ไม่มี #/ นำหน้าก็รับ');

// ---------- allowlist ----------
ok(H.allowed(AX + '/a', PROD) && H.allowed('https://xman4289.com/a', PROD) && H.allowed('https://www.xman4289.com/a', PROD), 'allowed: โดเมน xman4289');
ok(!H.allowed('http://ai.xman4289.com/a', PROD), 'allowed: http (ไม่ใช่ https) ถูกปฏิเสธ');
ok(!H.allowed('https://ai.xman4289.com.evil.com/a', PROD) && !H.allowed('https://evil.com/?u=https://ai.xman4289.com', PROD), 'allowed: โดเมนปลอม/ซ้อน ถูกปฏิเสธ');
ok(!H.allowed('https://user:pw@ai.xman4289.com/a', PROD), 'allowed: มี user:pass ใน URL ถูกปฏิเสธ');
ok(!H.allowed('javascript:alert(1)', PROD) && !H.allowed('not a url', PROD), 'allowed: javascript:/ข้อความมั่ว ถูกปฏิเสธ');
ok(!H.allowed('http://localhost:3000/a', PROD) && H.allowed('http://localhost:3000/a', DEV) && H.allowed('http://127.0.0.1:8123/a', DEV), 'allowed: localhost เฉพาะตอน AquaChord รันบน localhost');

// ---------- readManifest ----------
const NOW = Date.parse('2026-10-29T10:00:00Z');
const man = (o) => Object.assign({ type: 'aquachord.handoff', v: 1, title: 'เพลงทดสอบ', audio: { url: AX + '/h/tok/audio', mime: 'audio/mpeg', bytes: 1234 } }, o);
const m1 = H.readManifest(man({ lyrics: 'บรรทัด 1\r\nบรรทัด\u0000 2', lang: 'th', source: { app: 'aixman', name: 'X-DREAMER' }, expiresAt: '2026-10-29T10:10:00Z' }), NOW);
ok(m1.title === 'เพลงทดสอบ' && m1.lyrics === 'บรรทัด 1\nบรรทัด 2' && m1.lang === 'th' && m1.source.name === 'X-DREAMER' && m1.audio.bytes === 1234, 'manifest: อ่านครบ + เนื้อร้องคงบรรทัด ตัดอักขระควบคุม');
ok(H.readManifest(man({ lang: 'jp' }), NOW).lang === '', 'manifest: ภาษาที่ไม่รู้จัก → ว่าง (ใช้ค่าของผู้ใช้)');
ok(H.readManifest(man({ lyrics: 'ก'.repeat(30000) }), NOW).lyrics.length === 20000, 'manifest: เนื้อร้องยาวเกิน → ตัดที่ 20000');
ok(code(() => H.readManifest(man({ expiresAt: '2026-10-29T09:59:00Z' }), NOW)) === 'expired', 'manifest: หมดอายุ → expired');
ok(code(() => H.readManifest(man({ v: 2 }), NOW)) === 'version', 'manifest: v อื่น → version');
ok(code(() => H.readManifest(man({ type: 'x' }), NOW)) === 'manifest' && code(() => H.readManifest(man({ audio: {} }), NOW)) === 'manifest' && code(() => H.readManifest(null, NOW)) === 'manifest', 'manifest: ผิดรูป → manifest');

// ---------- fileName ----------
const fm = (title, filename, url, mime) => ({ title, audio: { url: url || AX + '/a', mime: mime || '', filename: filename || '' } });
ok(H.fileName(fm('ฝน/ตก: คืนนี้?'), 'audio/mpeg') === 'ฝน ตก คืนนี้.mp3', 'fileName: ตัดอักขระต้องห้าม + นามสกุลจากชนิดจริง');
ok(H.fileName(fm('', 'my_song.flac'), '') === 'my_song.flac', 'fileName: ไม่มีชื่อเพลง → ใช้ชื่อไฟล์');
ok(H.fileName(fm('', '', AX + '/files/%E0%B8%9D%E0%B8%99.wav'), 'application/octet-stream') === 'ฝน.wav', 'fileName: จาก URL (ถอด encode)');
ok(H.fileName(fm('', '', AX + '/api/x/123'), '') === 'X-DREAMER song.mp3', 'fileName: ไม่มีอะไรเลย → ชื่อกลาง');

// ---------- receive (fetch จำลอง) ----------
function resp(status, body, headers) {
  const h = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return new Response(status === 204 ? null : body, { status, headers: Object.fromEntries(h) });
}
function fakeFetch(routes, log) {
  return async (url, init) => {
    log && log.push({ url, init });
    const r = routes[url];
    if (!r) throw new TypeError('Failed to fetch');
    return typeof r === 'function' ? r(init) : r();
  };
}
const audioBytes = new Uint8Array(4096).map((_, i) => i & 255);

(async () => {
  const MAN = AX + '/api/partner/aquachord/handoff/tok';
  const AUD = AX + '/api/partner/aquachord/handoff/tok/audio';
  const manifestBody = JSON.stringify(man({ title: 'ลูกทุ่งทดสอบ', lyrics: 'ฝนเอยทำไมจึงตก', lang: 'th', source: { app: 'aixman', name: 'X-DREAMER' }, audio: { url: AUD, mime: 'audio/mpeg', bytes: 4096 } }));
  const log = [];
  const f1 = fakeFetch({
    [MAN]: () => resp(200, manifestBody, { 'content-type': 'application/json' }),
    [AUD]: () => resp(200, audioBytes, { 'content-type': 'audio/mpeg', 'content-length': 4096 }),
  }, log);
  const r1 = await H.receive({ kind: 'manifest', url: MAN }, { here: PROD, fetch: f1, now: NOW });
  ok(r1.file.name === 'ลูกทุ่งทดสอบ.mp3' && r1.file.type === 'audio/mpeg' && r1.file.size === 4096, 'receive: manifest → File ชื่อเพลง/ชนิด/ขนาดถูก');
  ok(r1.meta.lyrics === 'ฝนเอยทำไมจึงตก' && r1.meta.lang === 'th', 'receive: ได้เนื้อร้อง + ภาษา');
  const back = new Uint8Array(await r1.file.arrayBuffer());
  ok(back.every((v, i) => v === audioBytes[i]), 'receive: ไบต์ตรงกับต้นทาง');
  ok(log.length === 2 && log.every((l) => l.init.credentials === 'omit' && l.init.mode === 'cors'), 'receive: ไม่ส่ง cookie (credentials:omit) + mode cors');

  const fOct = fakeFetch({ [AX + '/f/a.wav']: () => resp(200, audioBytes, { 'content-type': 'application/octet-stream' }) });
  const r2 = await H.receive({ kind: 'audio', url: AX + '/f/a.wav', title: '' }, { here: PROD, fetch: fOct });
  ok(r2.file.name === 'a.wav' && r2.file.type === 'audio/wav', 'receive: src= octet-stream + .wav → audio/wav');

  ok(await acode(H.receive({ kind: 'audio', url: 'https://evil.com/a.mp3' }, { here: PROD, fetch: f1 })) === 'origin', 'receive: src นอก allowlist → origin (ไม่ fetch)');
  const evilMan = fakeFetch({ [MAN]: () => resp(200, JSON.stringify(man({ audio: { url: 'https://evil.com/x.mp3' } })), {}) });
  ok(await acode(H.receive({ kind: 'manifest', url: MAN }, { here: PROD, fetch: evilMan, now: NOW })) === 'origin', 'receive: manifest ชี้ไฟล์นอก allowlist → origin');
  const gone = fakeFetch({ [MAN]: () => resp(410, 'gone') });
  ok(await acode(H.receive({ kind: 'manifest', url: MAN }, { here: PROD, fetch: gone })) === 'expired', 'receive: 410 → expired');
  const boom = fakeFetch({ [MAN]: () => resp(500, 'x') });
  ok(await acode(H.receive({ kind: 'manifest', url: MAN }, { here: PROD, fetch: boom })) === 'fetch', 'receive: 500 → fetch');
  ok(await acode(H.receive({ kind: 'manifest', url: MAN }, { here: PROD, fetch: fakeFetch({}) })) === 'fetch', 'receive: เครือข่าย/CORS ล้ม → fetch');
  const html = fakeFetch({ [AUD]: () => resp(200, '<html>', { 'content-type': 'text/html' }) });
  ok(await acode(H.receive({ kind: 'audio', url: AUD }, { here: PROD, fetch: html })) === 'notAudio', 'receive: ได้ HTML แทนเสียง → notAudio');
  const big = fakeFetch({ [AUD]: () => resp(200, audioBytes, { 'content-type': 'audio/mpeg' }) });
  ok(await acode(H.receive({ kind: 'audio', url: AUD }, { here: PROD, fetch: big, maxBytes: 1000 })) === 'toobig', 'receive: เกินเพดาน (ไม่มี content-length) → toobig ระหว่างสตรีม');
  const bigMan = fakeFetch({ [MAN]: () => resp(200, JSON.stringify(man({ audio: { url: AUD, bytes: 9e9 } })), {}) });
  ok(await acode(H.receive({ kind: 'manifest', url: MAN }, { here: PROD, fetch: bigMan, now: NOW })) === 'toobig', 'receive: manifest บอกขนาดเกิน → toobig ก่อนโหลด');
  const badJson = fakeFetch({ [MAN]: () => resp(200, '{nope', {}) });
  ok(await acode(H.receive({ kind: 'manifest', url: MAN }, { here: PROD, fetch: badJson })) === 'manifest', 'receive: JSON เสีย → manifest');
  const slow = (url, init) => new Promise((res, rej) => { init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });
  ok(await acode(H.receive({ kind: 'audio', url: AUD }, { here: PROD, fetch: slow, timeoutMs: 50 })) === 'timeout', 'receive: ช้าเกิน → timeout');
  const dev = fakeFetch({ ['http://127.0.0.1:8123/s.mp3']: () => resp(200, audioBytes, { 'content-type': 'audio/mpeg' }) });
  ok(!!(await H.receive({ kind: 'audio', url: 'http://127.0.0.1:8123/s.mp3' }, { here: DEV, fetch: dev })).file, 'receive: dev บน localhost รับเซิร์ฟเวอร์ทดสอบ');

  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
