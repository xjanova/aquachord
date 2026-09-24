/* Mock ของ aixman partner API (docs/09 §2.5) + R2 public host — ใช้กับ tools/test-gpu-e2e.cjs เท่านั้น
   HTTPS จริง (cert self-signed ที่ harness สร้าง) เพื่อให้ gpu.php ตรวจ TLS ตามปกติ
   host ที่เสิร์ฟ (แยกด้วย Host header):
     ai.xman4289.com   → /api/partner/v1/{ping,uploads,jobs,jobs/:id}
     pub-test.r2.dev   → /uploads/... , /generations/... (ผล JSON)
     evil.example.com  → ห้ามถูกเรียกเด็ดขาด (นับ hit ไว้ตรวจ SSRF)
   พฤติกรรมตาม title ของงาน: hold = ค้าง queued, ssrf = resultUrl ไป host อื่น, badresult = format ผิด,
   default = queued → rendering → completed (ทีละ poll) */
'use strict';
const https = require('https');
const crypto = require('crypto');

function createMock({ key, cert, keyPem }) {
  const st = {
    key, enabled: true, allowSheetSage2: false, pingCount: 0, jobs: new Map(), idem: new Map(), uploads: [],
    requests: [], evilHits: 0, resultFetches: [], seq: 0,
  };
  const R2 = 'https://pub-test.r2.dev';
  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const err = (res, code, c) => send(res, code, { error: { code: c, message: 'ข้อผิดพลาดจำลอง ' + c } });
  const pub = (j) => ({
    id: j.id, externalRef: j.externalRef, status: j.status, stageLabel: j.stageLabel, progress: j.progress,
    etaSeconds: j.etaSeconds, etaLabel: null, queuePosition: j.queuePosition, mode: j.mode, createdAt: j.createdAt,
    completedAt: j.completedAt, resultUrl: j.resultUrl, errorMessage: j.errorMessage, expiresAt: null, gpuSeconds: j.gpuSeconds,
  });
  const result = (mode) => ({
    format: 'aquachord-transcription', version: 1, mode, engine: { node: 'comfyui-aquachord@0.1.0', models: {} },
    durationSec: 12.5, tempo: 96.2, timeSig: [4, 4], beats: [0.5, 1.125], downbeats: [0.5], key: 'Gm',
    chords: [{ t0: 0, t1: 2.5, label: 'Gm7', conf: 0.82 }, { t0: 2.5, t1: 3, label: null }], sections: [],
    lyrics: { source: 'user', language: 'th', text: 'ทดสอบ', lines: [{ t0: 1, t1: 2, text: 'ทดสอบ', syllables: [{ t0: 1, t1: 1.5, text: 'ทด' }] }] },
    melody: null, warnings: [], timings: {},
  });

  function advance(j) {
    j.polls++;
    if (j.title === 'hold' || j.status === 'cancelled' || j.status === 'completed' || j.status === 'failed') return;
    if (j.status === 'queued') { j.status = 'rendering'; j.stageLabel = 'กำลังแยกเสียงร้อง'; j.progress = 0.4; j.etaSeconds = 30; j.queuePosition = null; return; }
    if (j.status === 'rendering') {
      j.status = 'completed'; j.progress = 1; j.completedAt = Date.now(); j.gpuSeconds = 42.5; j.stageLabel = 'เสร็จแล้ว';
      if (j.title === 'ssrf') j.resultUrl = 'https://evil.example.com/generations/svc/' + j.id + '/result.json';
      else if (j.title === 'badresult') j.resultUrl = R2 + '/generations/svc/' + j.id + '/bad.json';
      else j.resultUrl = R2 + '/generations/svc/' + j.id + '/result.json';
    }
  }

  const server = https.createServer({ key: keyPem, cert }, (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, 'https://' + host);
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 80 * 1024 * 1024) chunks.push(c); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      st.requests.push({ host, method: req.method, path: url.pathname, ua: req.headers['user-agent'] || '',
        hasKey: 'x-aixman-partner-key' in req.headers, idem: req.headers['idempotency-key'] || null });
      if (host === 'evil.example.com') { st.evilHits++; return send(res, 200, { format: 'aquachord-transcription', version: 1 }); }
      if (host === 'pub-test.r2.dev') {
        st.resultFetches.push({ path: url.pathname, hasKey: 'x-aixman-partner-key' in req.headers, ua: req.headers['user-agent'] || '' });
        const m = url.pathname.match(/^\/generations\/svc\/([^/]+)\/(result|bad)\.json$/);
        if (!m || !st.jobs.has(m[1])) return send(res, 404, { error: 'not found' });
        if (m[2] === 'bad') return send(res, 200, { format: 'something-else', version: 1 });
        return send(res, 200, result(st.jobs.get(m[1]).mode));
      }
      if (host !== 'ai.xman4289.com') return send(res, 421, { error: 'misdirected' });
      if (req.headers['x-aixman-partner-key'] !== st.key) return err(res, 401, 'BAD_KEY');
      if (!st.enabled) return err(res, 503, 'DISABLED');
      const p = url.pathname.replace(/^\/api\/partner\/v1/, '');
      if (req.method === 'GET' && p === '/ping') {
        st.pingCount++;
        const active = [...st.jobs.values()].filter((j) => ['queued', 'starting', 'rendering'].includes(j.status)).length;
        return send(res, 200, { ok: true, partner: 'aquachord', enabled: true, model: { key: 'aquachord-transcribe', readiness: 'tuning' },
          allowSheetSage2: st.allowSheetSage2, defaultMode: 'open', limits: { maxAudioMb: 40, maxSeconds: 600, maxJobsPerDay: 20, maxActiveJobs: 2 },
          usage: { jobsToday: st.jobs.size, activeJobs: active }, internalSecret: 'must-not-leak' });
      }
      if (req.method === 'POST' && p === '/uploads') {
        const head = body.subarray(0, 2048).toString('latin1');
        const fn = (head.match(/filename="([^"]*)"/) || [])[1] || null;
        const ct = (head.match(/Content-Type: ([^\r\n]+)/i) || [])[1] || null;
        const u = R2 + '/uploads/svc/audio/' + crypto.randomUUID() + '.mp3';
        st.uploads.push({ filename: fn, contentType: ct, bytes: body.length, url: u });
        return send(res, 201, { url: u, bytes: body.length, contentType: ct });
      }
      if (req.method === 'POST' && p === '/jobs') {
        const idem = req.headers['idempotency-key'];
        if (!idem) return err(res, 400, 'BAD_INPUT');
        if (st.idem.has(idem)) return send(res, 202, { job: pub(st.jobs.get(st.idem.get(idem))) });
        let j; try { j = JSON.parse(body.toString('utf8')); } catch (e) { return err(res, 400, 'BAD_INPUT'); }
        if (typeof j.inputAudio !== 'string' || !j.inputAudio.startsWith(R2 + '/uploads/')) return err(res, 400, 'BAD_INPUT');
        if (j.mode === 'sheetsage2' && !st.allowSheetSage2) return err(res, 403, 'MODE_NOT_ALLOWED');
        const id = 'gen_' + (++st.seq) + '_' + crypto.randomBytes(3).toString('hex');
        const job = { id, externalRef: j.externalRef, status: 'queued', stageLabel: 'รอคิว', progress: null, etaSeconds: null, queuePosition: 1,
          mode: j.mode || 'open', title: j.title, lyrics: j.lyrics, language: j.language, inputAudio: j.inputAudio, idem,
          createdAt: Date.now(), completedAt: null, resultUrl: null, errorMessage: null, gpuSeconds: null, polls: 0 };
        st.jobs.set(id, job); st.idem.set(idem, id);
        return send(res, 202, { job: pub(job) });
      }
      const m = p.match(/^\/jobs\/([A-Za-z0-9_-]+)$/);
      if (m) {
        const j = st.jobs.get(m[1]);
        if (!j) return err(res, 404, 'NOT_FOUND');
        if (req.method === 'GET') { advance(j); return send(res, 200, { job: pub(j) }); }
        if (req.method === 'DELETE') {
          if (j.status !== 'queued') return err(res, 409, 'NOT_CANCELLABLE');
          j.status = 'cancelled'; return send(res, 200, { job: pub(j) });
        }
      }
      return err(res, 404, 'NOT_FOUND');
    });
  });
  return { server, st };
}

module.exports = { createMock };
