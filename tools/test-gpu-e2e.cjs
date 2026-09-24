#!/usr/bin/env node
/* E2E ของ /api/gpu/* — PHP จริง (php -S) + MySQL จริง + mock aixman ผ่าน HTTPS จริง (cert self-signed)
   ไม่แตะเซิร์ฟเวอร์จริง/ไม่ใช้เงิน: cURL ใน gpu.php ถูกชี้ไป mock ด้วย CURLOPT_CONNECT_TO
   (hook เปิดได้เฉพาะ cli-server ผ่าน tools/gpu-mock/router.php)

   ต้องมี: php (pdo_mysql, curl, mbstring), openssl CLI, MySQL/MariaDB ที่ทิ้งได้
   env:  PHP_BIN=php  OPENSSL_BIN=openssl
         AQ_E2E_DB_HOST=127.0.0.1 AQ_E2E_DB_PORT=3306 AQ_E2E_DB_USER=root AQ_E2E_DB_PASS=
         AQ_E2E_DB_NAME=aq_e2e_gpu   (ต้องขึ้นต้นด้วย aq_e2e_ — harness DROP/CREATE ฐานนี้ใหม่ทุกรอบ)
   รัน:  AQ_E2E_DB_PORT=3306 node tools/test-gpu-e2e.cjs
   ลองหลังบ้านด้วยมือ: AQ_E2E_SERVE=1 [AQ_E2E_SERVE_PORT=8765] … → เปิด /admin/ + ใช้คีย์ mock ที่พิมพ์ออกมา
   ถ้าไม่ได้ตั้ง AQ_E2E_DB_PORT → ข้าม (exit 0) เพราะต้องใช้ MySQL */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { createMock } = require('./gpu-mock/aixman-mock.cjs');

const ROOT = path.resolve(__dirname, '..');
const SERVE = process.env.AQ_E2E_SERVE === '1';   // 1 = ไม่รันเทสต์ เปิดเซิร์ฟเวอร์ค้างไว้ให้ลองหลังบ้านด้วยมือ
const PHP = process.env.PHP_BIN || 'php';
const OPENSSL = process.env.OPENSSL_BIN || 'openssl';
const DB = {
  host: process.env.AQ_E2E_DB_HOST || '127.0.0.1', port: Number(process.env.AQ_E2E_DB_PORT || 0),
  user: process.env.AQ_E2E_DB_USER || 'root', pass: process.env.AQ_E2E_DB_PASS || '', name: process.env.AQ_E2E_DB_NAME || 'aq_e2e_gpu',
};
if (!DB.port) { console.log('skip: ตั้ง AQ_E2E_DB_PORT (MySQL ที่ทิ้งได้) เพื่อรัน E2E'); process.exit(0); }
if (!/^aq_e2e_\w{1,40}$/.test(DB.name) || !['127.0.0.1', 'localhost'].includes(DB.host)) {
  console.error('ปฏิเสธ: AQ_E2E_DB_NAME ต้องขึ้นต้น aq_e2e_ และ host ต้องเป็น localhost'); process.exit(2);
}

let passN = 0, failN = 0;
const ok = (c, name, extra) => { if (c) passN++; else { failN++; console.error('FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function php(args, opts) {
  const r = spawnSync(PHP, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error('php failed: ' + (r.stderr || r.stdout));
  return r.stdout;
}
function sqlExec(sql) {
  const code = `$p=new PDO('mysql:host=${DB.host};port=${DB.port};dbname=${DB.name};charset=utf8mb4',getenv('DBU'),getenv('DBP'));echo $p->exec(getenv('SQL'));`;
  return Number(php(['-r', code], { env: { ...process.env, DBU: DB.user, DBP: DB.pass, SQL: sql } }));
}
function sqlJson(sql) {
  const code = `$p=new PDO('mysql:host=${DB.host};port=${DB.port};dbname=${DB.name};charset=utf8mb4',getenv('DBU'),getenv('DBP'));` +
    `echo json_encode($p->query(getenv('SQL'))->fetchAll(PDO::FETCH_ASSOC), JSON_UNESCAPED_UNICODE);`;
  return JSON.parse(php(['-r', code], { env: { ...process.env, DBU: DB.user, DBP: DB.pass, SQL: sql } }));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(process.env.AQ_E2E_TMP || os.tmpdir(), 'aq-gpu-e2e-'));
  const web = path.join(tmp, 'public_html');
  const priv = path.join(tmp, 'private');
  let phpProc = null, mockSrv = null, phpLog = '';
  try {
    // ---- โครงเหมือนเซิร์ฟเวอร์: <domain>/public_html/api + <domain>/private/config.php ----
    if (SERVE) fs.cpSync(path.join(ROOT, 'site'), web, { recursive: true });
    else fs.cpSync(path.join(ROOT, 'site', 'api'), path.join(web, 'api'), { recursive: true });
    fs.writeFileSync(path.join(web, 'version.json'), JSON.stringify({ version: '9.9.9-e2e', sha: 'test', builtAt: 0 }));
    fs.mkdirSync(priv);
    const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    fs.writeFileSync(path.join(priv, 'config.php'), `<?php return ['db_host'=>${q(DB.host)},'db_port'=>${DB.port},'db_name'=>${q(DB.name)},'db_user'=>${q(DB.user)},'db_pass'=>${q(DB.pass)}];`);
    php(['-r', `$p=new PDO('mysql:host=${DB.host};port=${DB.port}',getenv('DBU'),getenv('DBP'));$p->exec('DROP DATABASE IF EXISTS ${DB.name}');$p->exec('CREATE DATABASE ${DB.name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');`],
      { env: { ...process.env, DBU: DB.user, DBP: DB.pass } });

    // ---- cert self-signed ครอบ 3 host ของ mock ----
    const keyPath = path.join(tmp, 'mock-key.pem'), certPath = path.join(tmp, 'mock-cert.pem');
    const o = spawnSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/CN=ai.xman4289.com', '-addext', 'subjectAltName=DNS:ai.xman4289.com,DNS:pub-test.r2.dev,DNS:evil.example.com'], { encoding: 'utf8' });
    if (o.status !== 0) throw new Error('openssl failed: ' + o.stderr);

    const KEY = 'aqc_' + crypto.randomBytes(32).toString('base64url');
    const { server, st } = createMock({ key: KEY, cert: fs.readFileSync(certPath), keyPem: fs.readFileSync(keyPath) });
    mockSrv = server;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const mport = server.address().port;

    const hook = {
      connect_to: ['ai.xman4289.com:443:127.0.0.1:' + mport, 'pub-test.r2.dev:443:127.0.0.1:' + mport, 'evil.example.com:443:127.0.0.1:' + mport],
      cainfo: certPath,
      resolve: { 'pub-test.r2.dev': '93.184.216.34', 'evil.example.com': '93.184.216.35' },
    };
    const port = SERVE ? Number(process.env.AQ_E2E_SERVE_PORT || 8765) : await freePort();
    phpProc = spawn(PHP, ['-S', '127.0.0.1:' + port, '-t', web, path.join(__dirname, 'gpu-mock', 'router.php')],
      { env: { ...process.env, AQUA_GPU_TEST_JSON: JSON.stringify(hook) }, stdio: ['ignore', 'pipe', 'pipe'] });
    phpProc.stdout.on('data', (d) => { phpLog += d; });
    phpProc.stderr.on('data', (d) => { phpLog += d; });
    const base = 'http://127.0.0.1:' + port;

    async function call(method, p, { token, json, form } = {}) {
      const headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      let body;
      if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      if (form) body = form;
      const res = await fetch(base + '/api' + p, { method, headers, body });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
      return { status: res.status, data, text };
    }
    for (let i = 0; i < 50; i++) { try { const r = await call('GET', '/health'); if (r.status === 200) break; } catch (e) { /* ยังไม่พร้อม */ } await sleep(200); }

    const mp3 = (n = 100000) => Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), crypto.randomBytes(16), Buffer.alloc(n)]);
    const form = (buf, fields = {}, name = 'my song.mp3') => {
      const fd = new FormData();
      if (buf) fd.append('file', new Blob([buf]), name);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return fd;
    };

    if (SERVE) {
      // โหมดลองมือ: เปิด http://127.0.0.1:<port>/admin/ แล้วจับคู่ด้วยคีย์ mock ด้านล่าง (คีย์ทดสอบสุ่ม ไม่ใช่ความลับจริง)
      console.log('serving ' + base + '/admin/  (mock partner key: ' + KEY + ')  — Ctrl+C เพื่อหยุด');
      await new Promise((resolve) => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve); });
      return;
    }

    // ---------- auth ----------
    const setup = await call('POST', '/setup', { json: { username: 'owner', password: 'e2e-pass-123' } });
    ok(setup.status === 201 && setup.data.token, 'setup first admin', setup);
    const T = setup.data.token;
    ok((await call('GET', '/gpu/config')).status === 401, 'config requires admin');
    ok((await call('POST', '/gpu/jobs', { form: form(mp3()) })).status === 401, 'create job requires admin');
    ok((await call('GET', '/gpu/jobs')).status === 401, 'list requires admin');

    // ---------- config ----------
    let r = await call('GET', '/gpu/config', { token: T });
    ok(r.status === 200 && r.data.configured === false && r.data.keyHint === null && r.data.remote === null, 'empty config', r.data);
    r = await call('PUT', '/gpu/config', { token: T, json: { baseUrl: 'https://evil.com', partnerKey: KEY } });
    ok(r.status === 400 && r.data.error.code === 'BAD_BASE_URL', 'reject non-allowlisted base', r.data);
    r = await call('PUT', '/gpu/config', { token: T, json: { baseUrl: 'http://ai.xman4289.com', partnerKey: KEY } });
    ok(r.status === 400 && r.data.error.code === 'BAD_BASE_URL', 'reject http base', r.data);
    r = await call('PUT', '/gpu/config', { token: T, json: { baseUrl: 'https://ai.xman4289.com@127.0.0.1', partnerKey: KEY } });
    ok(r.status === 400, 'reject userinfo base', r.data);
    r = await call('PUT', '/gpu/config', { token: T, json: { partnerKey: 'bad key\r\nX-Evil: 1' } });
    ok(r.status === 400 && r.data.error.code === 'BAD_KEY_FORMAT', 'reject key with CRLF', r.data);
    r = await call('PUT', '/gpu/config', { token: T, json: { partnerKey: '' } });
    ok(r.status === 400 && r.data.error.code === 'NO_KEY', 'no key yet', r.data);
    const WRONG = 'aqc_' + crypto.randomBytes(32).toString('base64url');
    r = await call('PUT', '/gpu/config', { token: T, json: { partnerKey: WRONG } });
    ok(r.status === 502 && r.data.error.code === 'GPU_BAD_KEY' && !r.text.includes(WRONG), 'wrong key → 502 GPU_BAD_KEY (not 401)', r.data);
    ok(!fs.existsSync(path.join(priv, 'aixman.json')), 'failed test does not save config');

    const pingsBefore = st.pingCount;
    r = await call('PUT', '/gpu/config', { token: T, json: { baseUrl: 'https://ai.xman4289.com/', partnerKey: KEY, defaultMode: 'open' } });
    ok(r.status === 200 && r.data.configured === true && r.data.remote && r.data.remote.enabled === true, 'pair ok', r.data);
    ok(r.data.keyHint === '…' + KEY.slice(-4) && !r.text.includes(KEY) && !r.text.includes('internalSecret'), 'keyHint only, no key/raw body', r.data);
    ok(r.data.remote.limits.maxAudioMb === 40 && r.data.uploadCapMb === 40, 'cap from ping', r.data);
    ok(st.pingCount === pingsBefore + 1, 'PUT pings once');
    const cfgFile = path.join(priv, 'aixman.json');
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    ok(saved.partnerKey === KEY && saved.baseUrl === 'https://ai.xman4289.com', 'config file written');
    ok(fs.readdirSync(priv).every((f) => !f.endsWith('.tmp')), 'no temp files left in private/');
    if (process.platform !== 'win32') ok((fs.statSync(cfgFile).mode & 0o777) === 0o600, 'config file 0600');

    r = await call('GET', '/gpu/config', { token: T });
    ok(r.status === 200 && r.data.remote && st.pingCount === pingsBefore + 1, 'GET config uses cached ping (<15 s)', { pc: st.pingCount });
    r = await call('GET', '/gpu/config?fresh=1', { token: T });
    ok(r.status === 200 && st.pingCount === pingsBefore + 2, 'GET config ?fresh=1 pings', { pc: st.pingCount });
    r = await call('GET', '/gpu/config?ping=0', { token: T });
    ok(r.status === 200 && st.pingCount === pingsBefore + 2 && r.data.configured, 'GET config ?ping=0 no ping');
    r = await call('PUT', '/gpu/config', { token: T, json: { partnerKey: '', defaultMode: 'sheetsage2' } });
    ok(r.status === 200 && r.data.defaultMode === 'sheetsage2' && r.data.keyHint === '…' + KEY.slice(-4), 'empty key keeps key; mode changes', r.data);
    r = await call('PUT', '/gpu/config', { token: T, json: { defaultMode: 'open' } });
    ok(r.status === 200 && r.data.defaultMode === 'open', 'mode back to open');

    // ---------- upload validation ----------
    r = await call('POST', '/gpu/jobs', { token: T, form: form(null, { title: 'x' }) });
    ok(r.status === 400 && r.data.error.code === 'NO_FILE', 'no file', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(2000)]), {}, 'fake.mp3') });
    ok(r.status === 400 && r.data.error.code === 'BAD_AUDIO', 'png renamed .mp3 rejected by magic bytes', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(Buffer.alloc(0)) });
    ok(r.status === 400, 'empty file rejected', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { lyrics: 'ก'.repeat(5001) }) });
    ok(r.status === 400 && r.data.error.code === 'LYRICS_TOO_LONG', 'lyrics > 5000', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { mode: 'evil' }) });
    ok(r.status === 400 && r.data.error.code === 'BAD_MODE', 'bad mode', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { language: 'xx' }) });
    ok(r.status === 400 && r.data.error.code === 'BAD_LANGUAGE', 'bad language', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(41 * 1024 * 1024)) });
    ok(r.status === 413 && r.data.error.code === 'FILE_TOO_LARGE', '41 MB > 40 MB cap from ping', r.data);
    ok(st.uploads.length === 0, 'nothing forwarded to aixman for rejected uploads');

    // ---------- happy path ----------
    const songA = mp3();
    r = await call('POST', '/gpu/jobs', { token: T, form: form(songA, { title: 'เพลง A', lyrics: 'ทดสอบ\r\nบรรทัดสอง' }) });
    ok(r.status === 201 && r.data.job && r.data.job.status === 'queued', 'create job 201 queued', r.data);
    const A = r.data.job.id;
    ok(/^gj_[a-f0-9]{18}$/.test(A), 'our job id format');
    const up = st.uploads[0] || {};
    ok(up.filename === 'audio.mp3' && up.contentType === 'audio/mpeg', 'upload uses safe name + sniffed type (not user filename)', up);
    const rj = [...st.jobs.values()][0] || {};
    ok(rj.idem === A && rj.externalRef === A && rj.inputAudio === up.url, 'Idempotency-Key/externalRef = our id; inputAudio = upload url', rj);
    ok(rj.lyrics === 'ทดสอบ\nบรรทัดสอง' && rj.language === 'th' && rj.mode === 'open', 'lyrics normalised + defaults', rj);
    ok(st.requests.filter((x) => x.host === 'ai.xman4289.com').every((x) => x.ua === 'AquaChord/9.9.9-e2e' && x.hasKey), 'UA + key header on partner calls');

    r = await call('POST', '/gpu/jobs', { token: T, form: form(songA, { title: 'เพลง A', lyrics: 'ทดสอบ\r\nบรรทัดสอง' }) });
    ok(r.status === 200 && r.data.deduped === true && r.data.job.id === A && st.uploads.length === 1, 'double submit → same job, no 2nd upload', r.data);

    r = await call('GET', '/gpu/jobs/' + A, { token: T });
    const polls1 = st.jobs.get(rj.id).polls;
    r = await call('GET', '/gpu/jobs/' + A, { token: T });
    ok(st.jobs.get(rj.id).polls === polls1, 'second GET within 3 s does not poll aixman', { polls1, now: st.jobs.get(rj.id).polls });
    let result = null;
    for (let i = 0; i < 8 && !result; i++) {
      await sleep(3200);
      r = await call('GET', '/gpu/jobs/' + A, { token: T });
      if (r.data && r.data.result) result = r.data.result;
    }
    ok(result && result.format === 'aquachord-transcription' && r.data.job.status === 'completed' && r.data.job.hasResult, 'job completes with result', r.data);
    ok(r.text.includes('"timings":{}') && r.text.includes('"models":{}'), 'empty objects preserved as {}');
    ok(r.data.job.gpuSeconds === 42.5 && r.data.job.progress === 1, 'remote fields stored', r.data.job);
    ok(st.resultFetches.length === 1 && st.resultFetches.every((f) => !f.hasKey && f.ua === 'AquaChord/9.9.9-e2e'), 'result fetched once, without partner key', st.resultFetches);
    const pollsDone = st.jobs.get(rj.id).polls;
    await sleep(3200);
    r = await call('GET', '/gpu/jobs/' + A + '?result=0', { token: T });
    ok(r.status === 200 && !('result' in r.data) && st.jobs.get(rj.id).polls === pollsDone, 'done job: no more remote polls; ?result=0 omits result');

    // ---------- active limit + cancel ----------
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'hold' }) });
    const H1 = r.data && r.data.job && r.data.job.id;
    ok(r.status === 201, 'hold1 created', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'hold' }) });
    const H2 = r.data && r.data.job && r.data.job.id;
    ok(r.status === 201, 'hold2 created', r.data);
    const upBefore = st.uploads.length;
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'hold' }) });
    ok(r.status === 429 && r.data.error.code === 'ACTIVE_LIMIT' && st.uploads.length === upBefore, '3rd active job → 429 before upload', r.data);
    r = await call('DELETE', '/gpu/jobs/' + H1, { token: T });
    ok(r.status === 200 && r.data.job.status === 'cancelled', 'cancel queued job', r.data);
    r = await call('DELETE', '/gpu/jobs/' + H1, { token: T });
    ok(r.status === 409 && r.data.error.code === 'JOB_DONE', 'cancel twice → 409', r.data);
    r = await call('DELETE', '/gpu/jobs/' + A, { token: T });
    ok(r.status === 409, 'cancel completed → 409', r.data);
    const remoteH2 = [...st.jobs.values()].find((j) => j.externalRef === H2);
    remoteH2.status = 'rendering';
    r = await call('DELETE', '/gpu/jobs/' + H2, { token: T });
    ok(r.status === 409 && r.data.error.code === 'GPU_CONFLICT', 'cancel rendering job → 409 from aixman', r.data);
    remoteH2.status = 'cancelled';
    await sleep(3200);
    r = await call('GET', '/gpu/jobs/' + H2, { token: T });
    ok(r.data.job.status === 'cancelled', 'remote cancel reflected on poll', r.data);

    // ---------- SSRF / bad result / mode ----------
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'ssrf' }) });
    const S = r.data.job.id;
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'badresult' }) });
    const B = r.data.job.id;
    for (let i = 0; i < 4; i++) { await sleep(3200); await call('GET', '/gpu/jobs/' + S, { token: T }); await call('GET', '/gpu/jobs/' + B, { token: T }); }
    r = await call('GET', '/gpu/jobs/' + S, { token: T });
    ok(r.data.job.status === 'failed' && /ไม่อยู่ในรายการที่อนุญาต/.test(r.data.job.errorMessage || '') && !('result' in r.data), 'resultUrl on foreign host → failed', r.data);
    ok(st.evilHits === 0, 'foreign host never contacted', st.evilHits);
    ok(!r.text.includes('evil.example.com'), 'foreign URL not echoed to client');
    r = await call('GET', '/gpu/jobs/' + B, { token: T });
    ok(r.data.job.status === 'failed' && /ไม่ถูกต้อง/.test(r.data.job.errorMessage || ''), 'bad result format → failed', r.data);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'ss2', mode: 'sheetsage2' }) });
    ok(r.status === 403 && r.data.error.code === 'GPU_MODE_NOT_ALLOWED', 'sheetsage2 refused by aixman → 403', r.data);

    // ---------- remote disabled / key rotated ----------
    st.enabled = false;
    r = await call('GET', '/gpu/config?fresh=1', { token: T });
    ok(r.status === 200 && r.data.errorCode === 'GPU_DISABLED' && r.data.error, 'disabled at aixman → error in config', r.data);
    st.enabled = true;
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'hold' }) });
    const H3 = r.data.job.id;
    st.key = 'aqc_rotated_' + crypto.randomBytes(16).toString('hex');
    await sleep(3200);
    r = await call('GET', '/gpu/jobs/' + H3, { token: T });
    ok(r.status === 200 && r.data.job.status === 'queued' && /Partner key/.test(r.data.notice || ''), 'rotated key → notice, job kept', r.data);
    st.key = KEY;

    // ---------- แถว 'uploading' ที่ค้าง (request ตายกลางทาง) ----------
    const now = Date.now();
    sqlExec(`INSERT INTO gpu_jobs(id,status,mode,language,title,created_by,created_at,updated_at) VALUES('gj_${'a'.repeat(18)}','uploading','open','th','fresh-up',1,${now},${now})`);
    r = await call('POST', '/gpu/jobs', { token: T, form: form(mp3(), { title: 'hold' }) });
    ok(r.status === 429 && r.data.error.code === 'ACTIVE_LIMIT', 'fresh uploading row counts toward the per-admin limit', r.data);
    sqlExec(`UPDATE gpu_jobs SET created_at = ${now - 20 * 60 * 1000} WHERE id = 'gj_${'a'.repeat(18)}'`);
    r = await call('GET', '/gpu/jobs/gj_' + 'a'.repeat(18), { token: T });
    ok(r.status === 200 && r.data.job.status === 'failed' && /ค้าง/.test(r.data.job.errorMessage || ''), 'stale uploading row → failed on read', r.data);
    r = await call('DELETE', '/gpu/jobs/' + H3, { token: T });
    ok(r.status === 200 && r.data.job.status === 'cancelled', 'cancel H3', r.data);

    // ---------- list / not found ----------
    r = await call('GET', '/gpu/jobs', { token: T });
    ok(r.status === 200 && Array.isArray(r.data.jobs) && r.data.jobs.length >= 6 && r.data.jobs.every((j) => !('result' in j)) && !r.text.includes('ทดสอบ\\nบรรทัด'), 'list without results/lyrics', r.data && r.data.jobs && r.data.jobs.length);
    ok(r.data.jobs[0].createdBy === 'owner', 'list shows creator');
    ok((await call('GET', '/gpu/jobs/gj_000000000000000000', { token: T })).status === 404, 'unknown job 404');
    ok((await call('GET', '/gpu/jobs/..%2F..%2Fetc', { token: T })).status === 404, 'weird id 404');

    // ---------- audit + no secrets in DB/logs ----------
    const audit = sqlJson("SELECT action, detail FROM audit_log WHERE action LIKE 'gpu_%'");
    const acts = audit.map((a) => a.action);
    ok(acts.includes('gpu_config_update') && acts.includes('gpu_config_fail') && acts.includes('gpu_job_create') && acts.includes('gpu_job_cancel'), 'audit entries', acts);
    ok(audit.every((a) => !a.detail.includes(KEY) && !a.detail.includes(WRONG)), 'audit has no keys');
    const failedRows = sqlJson("SELECT status, error FROM gpu_jobs WHERE title = 'ss2'");
    ok(failedRows.length === 1 && failedRows[0].status === 'failed', 'remote-refused job row marked failed', failedRows);
    ok(!phpLog.includes(KEY) && !phpLog.includes(WRONG) && !phpLog.includes('r2.dev') && !phpLog.includes('evil.example.com'), 'php log has no key/URLs');
  } catch (e) {
    failN++;
    console.error('ERROR: ' + (e && e.stack || e));
  } finally {
    if (phpProc) phpProc.kill();
    if (mockSrv) mockSrv.close();
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  if (failN && process.env.AQ_E2E_SHOW_LOG) console.error(phpLog.slice(-4000));
  console.log(`gpu e2e: ${passN} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})();
