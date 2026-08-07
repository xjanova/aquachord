/* analyze.js — แกะคอร์ด (และเนื้อร้อง ถ้าเปิด) จากไฟล์เสียงจริง 100% ในเบราว์เซอร์
   pipeline: decode → mono ~11kHz → จับจังหวะ → chromagram (peaks + tuning +
   harmonic + bass) → ถอดคอร์ด Viterbi 2 รอบแบบรู้คีย์ (60 คอร์ด + N.C.)
   → [ตัวเลือก] ถอดเนื้อร้องด้วย Whisper ใน Web Worker (mono 16kHz)
   → ผสานคอร์ด+เนื้อร้องเป็น ChordPro / SongDoc
   ตัวเลข DSP อยู่ใน dsp.js (มีเทสต์ใน tools/test-dsp.cjs) — ไฟล์นี้คือ orchestration
   ไฟล์เสียงไม่ถูกส่งขึ้นเซิร์ฟเวอร์ — วิเคราะห์บนเครื่องผู้ใช้ทั้งหมด */
(function () {
  const BASE_STAGES = ['ingest', 'prep', 'beats', 'chords', 'key', 'assemble'];
  const LYR_STAGES = ['ingest', 'prep', 'beats', 'chords', 'key', 'lyrics', 'assemble'];
  function stages(withLyrics) { return withLyrics ? LYR_STAGES : BASE_STAGES; }

  const TARGET_SR = 11025;        // พอสำหรับคอร์ด (สนใจแค่ 55–1900 Hz)
  const LYR_SR = 16000;           // Whisper ต้องการ 16kHz
  const MAX_SECONDS = 600;        // วิเคราะห์สูงสุด 10 นาที กัน RAM/CPU
  const MAX_BYTES = 80 * 1024 * 1024;

  function mkErr(code) { const e = new Error(code); e.code = code; return e; }
  function chk(ctl) { if (ctl && ctl.aborted) throw new Error('cancelled'); }
  // yield คืน event loop ด้วย MessageChannel — setTimeout โดนเบราว์เซอร์ throttle
  // ตอนแท็บอยู่เบื้องหลัง (เหลือ ~1 ครั้ง/นาที) ทำให้วิเคราะห์ค้างถ้าผู้ใช้สลับแท็บ
  const tickQueue = [];
  const tickChannel = new MessageChannel();
  tickChannel.port1.onmessage = () => { const r = tickQueue.shift(); if (r) r(); };
  const tick = () => new Promise((r) => { tickQueue.push(r); tickChannel.port2.postMessage(0); });

  /* ---------------- decode + resample เป็น mono ---------------- */
  function decode(ctx, buf) {
    return new Promise((res, rej) => {
      // Safari เก่าใช้ callback, ตัวใหม่คืน promise — รองรับทั้งคู่ (res ซ้ำไม่มีผล)
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  function offlineRender(audioBuf, seconds, sr, channels) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OAC(channels || 1, Math.max(1, Math.ceil(seconds * sr)), sr);
    const src = oc.createBufferSource();
    src.buffer = audioBuf;
    src.connect(oc.destination);
    src.start(0);
    return oc.startRendering().then((r) => (channels === 2
      ? { L: r.getChannelData(0), R: r.getChannelData(1) }
      : r.getChannelData(0)));
  }

  // FIR lowpass (windowed sinc) + decimate — ใช้ตอน OfflineAudioContext ไม่รับ sample rate ที่ขอ
  function decimate(x, factor) {
    if (factor <= 1) return x;
    const taps = 31, half = (taps - 1) / 2;
    const fc = 0.42 / factor; // cutoff ต่ำกว่า Nyquist ใหม่เล็กน้อย กัน aliasing
    const h = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const m = i - half;
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
      h[i] = sinc * w; sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    const outLen = Math.floor(x.length / factor);
    const out = new Float32Array(outLen);
    for (let o = 0; o < outLen; o++) {
      const c = o * factor;
      let acc = 0;
      for (let i = 0; i < taps; i++) {
        const idx = c + i - half;
        if (idx >= 0 && idx < x.length) acc += x[idx] * h[i];
      }
      out[o] = acc;
    }
    return out;
  }

  function mixdown(audioBuf) {
    const ch = audioBuf.numberOfChannels, len = audioBuf.length;
    const out = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = audioBuf.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  async function toMono(audioBuf, seconds, targetSr) {
    try {
      return { data: await offlineRender(audioBuf, seconds, targetSr), sr: targetSr };
    } catch (e) { /* บาง browser จำกัด sample rate → เรนเดอร์ rate เดิมแล้ว decimate เอง */ }
    const sr0 = audioBuf.sampleRate;
    let data0;
    try { data0 = await offlineRender(audioBuf, seconds, sr0); }
    catch (e) { data0 = mixdown(audioBuf).subarray(0, Math.ceil(seconds * sr0)); }
    const factor = Math.max(1, Math.round(sr0 / targetSr));
    return { data: decimate(data0, factor), sr: sr0 / factor };
  }

  /* เตรียมเสียงให้ Whisper: เพลงสเตอริโอ → ดึงเสียงกลาง (ร้อง) ออกจากดนตรีก่อน
     Whisper ถอดคำไทยจากมิกซ์เต็ม ๆ ได้แย่มาก แต่พอเบา backing track ลงจับคำได้ดีขึ้นเยอะ
     mono/แยกไม่สำเร็จ → ตกกลับไปใช้ mono ธรรมดา (ยังถอดได้ แค่แม่นน้อยกว่า) */
  async function toVocalPCM(audioBuf, seconds) {
    if (audioBuf.numberOfChannels >= 2) {
      try {
        const st = await offlineRender(audioBuf, seconds, LYR_SR, 2);
        const center = DSP.isolateCenter(st.L, st.R);
        return { data: DSP.prepForASR(center, LYR_SR), isolated: true };
      } catch (e) { /* เรนเดอร์สเตอริโอไม่ได้ → mono */ }
    }
    const m = await toMono(audioBuf, seconds, LYR_SR);
    return { data: DSP.prepForASR(m.data, m.sr), isolated: false };
  }

  /* ---------------- ประกอบ ChordPro ---------------- */
  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function headerFor(title, key, bpm) {
    const bpmDisp = Math.round(bpm);
    return `{title: ${title}}\n{key: ${key}}\n{tempo: ${bpmDisp}}\n\n` +
      `{c: 🎯 Key ${key} · ${bpmDisp} BPM · ${I18N.t('sheet.header')}}\n\n`;
  }

  // แถวกริด → บรรทัดข้อความ (ยุบแถวซ้ำเป็น ×n + ⏱ ทุก ๆ 4 บรรทัด)
  function gridToLines(rows, stampEvery) {
    const out = [];
    let lineNo = 0;
    for (let i = 0; i < rows.length; ) {
      let n = 1;
      while (i + n < rows.length && rows[i + n].text === rows[i].text) n++;
      if (stampEvery && lineNo % stampEvery === 0) out.push(`{c: ⏱ ${fmtTime(rows[i].t)}}`);
      out.push(rows[i].text + (n > 1 ? `   (×${n})` : ''));
      lineNo++;
      i += n;
    }
    return out;
  }

  // ชีตคอร์ดล้วน (ไม่มีเนื้อร้อง) — หน้าตาเดิมของ v1.2
  function assembleChordPro(segs, bpm, duration, key, title, phase) {
    const head = headerFor(title, key, bpm);
    const first = segs.find((s) => s.chord);
    if (!first) return head + `{c: ${I18N.t('sheet.noChords')}}\n`;
    const rows = DSP.gridRows(segs, bpm, phase, first.t0, duration);
    if (!rows.length) return head + `{c: ${I18N.t('sheet.noChords')}}\n`;
    const body = gridToLines(rows, 4).join('\n');
    return head + body + `\n\n{c: ⚠ ${I18N.t('sheet.aiNote')}}\n`;
  }

  // ชีตคอร์ด + เนื้อร้อง: คอร์ดแทรกในบรรทัดร้องตามเวลา / ช่วงดนตรีเป็นกริด
  function assembleWithLyrics(segs, chunks, bpm, phase, duration, key, title) {
    const blocks = DSP.layoutLyricLines(segs, chunks, { bpm, phase, duration });
    if (!blocks.length) return null;
    const out = [];
    blocks.forEach((b) => {
      if (b.type === 'blank') { out.push(''); return; }
      if (b.type === 'lyric') { out.push(b.text); return; }
      if (b.type === 'grid' && b.rows.length) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push(`{c: ⏱ ${fmtTime(b.rows[0].t)}}`);
        gridToLines(b.rows, 0).forEach((l) => out.push(l));
        out.push('');
      }
    });
    return headerFor(title, key, bpm) + out.join('\n') +
      `\n\n{c: 🎤 ${I18N.t('sheet.lyricsBeta')}}\n{c: ⚠ ${I18N.t('sheet.aiNote')}}\n`;
  }

  function prettyTitle(name) {
    return (name || 'Untitled')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'Untitled';
  }

  /* ---------------- ดึงไฟล์จากลิงก์ (เฉพาะลิงก์ไฟล์เสียงตรงที่เปิด CORS) ---------------- */
  async function fetchAudio(url) {
    let res;
    try { res = await fetch(url, { mode: 'cors' }); }
    catch (e) { throw mkErr('fetch'); }
    if (!res.ok) throw mkErr('fetch');
    const len = +res.headers.get('content-length') || 0;
    if (len > MAX_BYTES) throw mkErr('toobig');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw mkErr('toobig');
    return buf;
  }

  /* ---------------- pipeline หลัก ---------------- */
  // สัดส่วนช่วง % ต่อ stage (มี/ไม่มีถอดเนื้อร้อง)
  const PCT_BASE = { ingest: [0, 6], prep: [6, 16], beats: [16, 30], chords: [30, 82], key: [82, 88], assemble: [88, 99] };
  const PCT_LYR = { ingest: [0, 5], prep: [5, 12], beats: [12, 20], chords: [20, 48], key: [48, 52], lyrics: [52, 92], assemble: [92, 99] };

  async function run(input, onProgress, ctl) {
    const withLyrics = !!(input.lyrics && window.Lyrics);
    const PCT = withLyrics ? PCT_LYR : PCT_BASE;
    const P = (stage, frac, detail) => {
      if (!onProgress) return;
      const r = PCT[stage] || [0, 99];
      const pct = r[0] + Math.max(0, Math.min(1, frac)) * (r[1] - r[0]);
      onProgress({ stage, percent: Math.max(0, Math.min(99, Math.round(pct))), detail: detail || null });
    };

    // 1) ingest: อ่านไฟล์ + decode
    P('ingest', 0.2);
    let buf, srcName;
    if (input.kind === 'file') {
      if (input.file.size > MAX_BYTES) throw mkErr('toobig');
      buf = await input.file.arrayBuffer();
      srcName = input.file.name;
    } else {
      buf = await fetchAudio(input.url);
      srcName = decodeURIComponent((input.url.split('/').pop() || '').split(/[?#]/)[0]) || 'Untitled';
    }
    chk(ctl); P('ingest', 0.7);
    let audio;
    try { audio = await decode(Music.audioCtx(), buf); }
    catch (e) { throw mkErr('decode'); }
    if (!audio || audio.duration < 5) throw mkErr('short');
    chk(ctl);

    // 2) prep: mono + resample
    P('prep', 0.2);
    const seconds = Math.min(audio.duration, MAX_SECONDS);
    const { data, sr } = await toMono(audio, seconds, TARGET_SR);
    chk(ctl); P('prep', 1);

    const dspOpts = (stage, f0, f1) => ({
      tick, chk: () => chk(ctl),
      onPct: (p) => P(stage, f0 + p * (f1 - f0)),
    });

    // 3) beats: จับ BPM + beat phase
    const { bpm, phase } = await DSP.detectTempo(data, sr, dspOpts('beats', 0, 1));
    chk(ctl); P('beats', 1);

    // 4) chords: chromagram + Viterbi (เพลงยาวใช้ hop หยาบขึ้น ประหยัด CPU มือถือ)
    const hop = seconds > 420 ? 2048 : 1024;
    const ch = await DSP.analyzeChroma(data, sr, Object.assign({ hop }, dspOpts('chords', 0, 0.6)));
    chk(ctl);
    const dec = await DSP.decodeChords(ch.chroma, ch.bass, ch.rms, ch.F,
      Object.assign({ frameSec: ch.frameSec }, dspOpts('chords', 0.6, 1)));
    chk(ctl);
    const segs = DSP.toSegments(dec.path, dec.labels, dec.nChords, ch.F, ch.frameSec, ch.t0);

    // 5) key (ถอดมาแล้วจาก Viterbi รอบสอง)
    const key = dec.key;
    P('key', 1);

    // 6) [ตัวเลือก] lyrics: Whisper ใน worker (เสียง 16kHz แยกเสียงร้องแล้ว)
    let lyrChunks = null, lyricsError = null, vocalIsolated = false;
    if (withLyrics) {
      try {
        P('lyrics', 0.02, I18N.t('job.lyr.prep'));
        const vox = await toVocalPCM(audio, seconds);
        const pcm16 = vox.data;
        vocalIsolated = vox.isolated;
        chk(ctl);
        P('lyrics', 0.04, I18N.t('job.lyr.dl'));
        const res = await Lyrics.transcribe(pcm16, {
          model: input.lyrics.model,
          lang: input.lyrics.lang,
          duration: seconds,
          ctl,
          // โหลดโมเดล = 4–35% ของช่วง lyrics, ถอดเสียง = 35–100%
          onDl: (pct) => P('lyrics', 0.04 + (pct / 100) * 0.31, I18N.t('job.lyr.dl') + ' ' + pct + '%'),
          onAsr: (pct, elapsed) => {
            if (pct != null) P('lyrics', 0.35 + (pct / 100) * 0.65, I18N.t('job.lyr.asr') + ' ' + pct + '%');
            else P('lyrics', 0.5, I18N.t('job.lyr.asr') + ' ' + fmtTime(elapsed || 0));
          },
        });
        lyrChunks = res.chunks;
      } catch (e) {
        if (ctl && ctl.aborted) throw new Error('cancelled');
        if (e && e.message === 'cancelled') throw e;
        lyricsError = (e && e.code) || 'run'; // ถอดเนื้อร้องพังไม่ทำให้ทั้งงานล้ม — ได้คอร์ดล้วน
      }
    }
    chk(ctl);

    // 7) assemble: ChordPro + SongDoc
    const title = prettyTitle(srcName);
    let chordpro = null;
    let lyricsText = '';
    if (lyrChunks && lyrChunks.length) {
      const cleaned = DSP.cleanChunks(lyrChunks, seconds);
      lyricsText = cleaned.map((c) => c.text).join('\n');
      chordpro = assembleWithLyrics(segs, lyrChunks, bpm, phase, seconds, key, title);
    }
    if (!chordpro) chordpro = assembleChordPro(segs, bpm, seconds, key, title, phase);
    const lyricsEmpty = withLyrics && !lyricsError && !lyricsText;
    const timeline = segs
      .filter((s) => s.chord)
      .map((s) => ({ t: Math.round(s.t0 * 10) / 10, chord: s.chord }));
    P('assemble', 0.8);

    const now = Date.now();
    const doc = {
      id: Store.uid(),
      schemaVersion: 1,
      title,
      artist: '',
      creator: 'AquaChord AI',
      key,
      tempo: String(Math.round(bpm)),
      capo: 0,
      chordpro,
      tabs: [],
      timeline,
      lyricsText,
      source: input.kind === 'file' ? { kind: 'upload', ref: srcName } : { kind: 'url', ref: input.url },
      confidence: { chords: dec.confidence, lyrics: lyricsText ? (vocalIsolated ? 0.6 : 0.45) : 0 },
      tuningCents: ch.tuningCents,
      vocalIsolated,
      isPublic: false,
      favorite: 0,
      playCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (lyricsError) doc.lyricsError = lyricsError;
    if (lyricsEmpty) doc.lyricsEmpty = true;
    return doc;
  }

  window.Analyze = {
    STAGES: BASE_STAGES, stages, run,
    // ช่องสำหรับเทสต์/ดีบัก (ไม่ใช่ API สาธารณะ)
    _test: { assembleChordPro, assembleWithLyrics, gridToLines, fmtTime },
  };
})();
