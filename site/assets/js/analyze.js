/* analyze.js — แกะคอร์ดจากไฟล์เสียงจริง 100% ในเบราว์เซอร์ (Web Audio API + DSP ล้วน)
   pipeline: decode → mono ~11kHz → จับจังหวะ (spectral flux autocorrelation)
   → chromagram (FFT 8192) → ถอดคอร์ดด้วย Viterbi (24 คอร์ด + N.C.)
   → หาคีย์ (Krumhansl-Schmuckler) → ประกอบ ChordPro เป็น SongDoc
   ไฟล์เสียงไม่ถูกส่งขึ้นเซิร์ฟเวอร์ — วิเคราะห์บนเครื่องผู้ใช้ทั้งหมด */
(function () {
  const STAGES = ['ingest', 'prep', 'beats', 'chords', 'key', 'assemble'];

  const TARGET_SR = 11025;        // พอสำหรับคอร์ด (สนใจแค่ 55–1900 Hz)
  const FFT_N = 8192;             // ~0.74s → ละเอียด ~1.35 Hz แยกโน้ตเบสได้
  const HOP = 2048;               // ~0.19s ต่อเฟรม
  const FMIN = 55, FMAX = 1900;   // A1 ถึง ~A#6
  const MAX_SECONDS = 600;        // วิเคราะห์สูงสุด 10 นาที กัน RAM/CPU
  const MAX_BYTES = 80 * 1024 * 1024;

  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function mkErr(code) { const e = new Error(code); e.code = code; return e; }
  function chk(ctl) { if (ctl && ctl.aborted) throw new Error('cancelled'); }
  // yield คืน event loop ด้วย MessageChannel — setTimeout โดนเบราว์เซอร์ throttle
  // ตอนแท็บอยู่เบื้องหลัง (เหลือ ~1 ครั้ง/นาที) ทำให้วิเคราะห์ค้างถ้าผู้ใช้สลับแท็บ
  const tickQueue = [];
  const tickChannel = new MessageChannel();
  tickChannel.port1.onmessage = () => { const r = tickQueue.shift(); if (r) r(); };
  const tick = () => new Promise((r) => { tickQueue.push(r); tickChannel.port2.postMessage(0); });

  /* ---------------- FFT (radix-2 iterative) ---------------- */
  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const cosT = new Float32Array(n / 2), sinT = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cosT[i] = Math.cos((2 * Math.PI * i) / n);
      sinT[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    return { n, cosT, sinT, rev };
  }

  function fft(fp, re, im) {
    const { n, cosT, sinT, rev } = fp;
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) { let t = re[i]; re[i] = re[r]; re[r] = t; t = im[i]; im[i] = im[r]; im[r] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const wr = cosT[k], wi = sinT[k];
          const tre = re[l] * wr + im[l] * wi;
          const tim = im[l] * wr - re[l] * wi;
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  /* ---------------- decode + resample เป็น mono ---------------- */
  function decode(ctx, buf) {
    return new Promise((res, rej) => {
      // Safari เก่าใช้ callback, ตัวใหม่คืน promise — รองรับทั้งคู่ (res ซ้ำไม่มีผล)
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  function offlineRender(audioBuf, seconds, sr) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OAC(1, Math.max(1, Math.ceil(seconds * sr)), sr);
    const src = oc.createBufferSource();
    src.buffer = audioBuf;
    src.connect(oc.destination);
    src.start(0);
    return oc.startRendering().then((r) => r.getChannelData(0));
  }

  // FIR lowpass (windowed sinc) + decimate — ใช้ตอน OfflineAudioContext ไม่รับ 11025
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

  async function toMono(audioBuf, seconds) {
    try {
      return { data: await offlineRender(audioBuf, seconds, TARGET_SR), sr: TARGET_SR };
    } catch (e) { /* บาง browser จำกัด sample rate → เรนเดอร์ rate เดิมแล้ว decimate เอง */ }
    const sr0 = audioBuf.sampleRate;
    let data0;
    try { data0 = await offlineRender(audioBuf, seconds, sr0); }
    catch (e) { data0 = mixdown(audioBuf).subarray(0, Math.ceil(seconds * sr0)); }
    const factor = Math.max(1, Math.round(sr0 / TARGET_SR));
    return { data: decimate(data0, factor), sr: sr0 / factor };
  }

  /* ---------------- จับจังหวะ: spectral flux + autocorrelation ---------------- */
  async function detectTempo(x, sr, ctl, onPct) {
    const N = 2048, hop = 512;
    const F = Math.floor((x.length - N) / hop) + 1;
    if (F < 16) return { bpm: 100, phase: 0 };
    const fp = makeFFT(N), win = hann(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const kMax = Math.min(N / 2 - 1, Math.ceil((4000 * N) / sr));
    let prev = new Float32Array(kMax + 1), cur = new Float32Array(kMax + 1);
    const flux = new Float32Array(F);
    for (let f = 0; f < F; f++) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(fp, re, im);
      let s = 0;
      for (let k = 1; k <= kMax; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const d = m - prev[k];
        if (d > 0) s += d;
        cur[k] = m;
      }
      flux[f] = s;
      const t = prev; prev = cur; cur = t;
      if ((f & 63) === 0) { chk(ctl); if (onPct) onPct(f / F); await tick(); }
    }
    // ลบค่าเฉลี่ย
    let mean = 0;
    for (let i = 0; i < F; i++) mean += flux[i];
    mean /= F;
    let energy = 0;
    for (let i = 0; i < F; i++) { flux[i] = Math.max(0, flux[i] - mean); energy += flux[i]; }
    if (energy <= 0) return { bpm: 100, phase: 0 };
    const fps = sr / hop;
    const lagMin = Math.max(2, Math.round((60 * fps) / 200));
    const lagMax = Math.min(F - 2, Math.round((60 * fps) / 55));
    const ac = new Float32Array(lagMax + 1);
    let bestLag = lagMin, bestScore = -1;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let s = 0;
      for (let i = 0; i + lag < F; i++) s += flux[i] * flux[i + lag];
      ac[lag] = s / (F - lag);
      const bpm = (60 * fps) / lag;
      // ถ่วงน้ำหนักให้ tempo ยอดนิยม (~120) ชนะเมื่อคะแนนใกล้กัน
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
      const score = ac[lag] * w;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    // parabolic interpolation รอบ lag ที่ดีที่สุด
    let lag = bestLag;
    if (bestLag > lagMin && bestLag < lagMax) {
      const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
      const den = a - 2 * b + c;
      if (den !== 0) lag = bestLag + 0.5 * ((a - c) / den);
    }
    let bpm = (60 * fps) / lag;
    while (bpm < 75) bpm *= 2;
    while (bpm > 185) bpm /= 2;
    // fine-search bpm+phase รอบค่าประมาณ — ความละเอียด lag หยาบ (fps ~21.5)
    // ถ้า bpm เพี้ยนแม้ 1 กริดห้องเพลงจะเลื่อนสะสมจนคอร์ดคร่อมห้อง
    let bestBpm = bpm, bestPhase = 0, bestGrid = -1;
    for (let cand = Math.max(60, bpm - 4); cand <= bpm + 4; cand += 0.1) {
      const period = (60 * fps) / cand;
      for (let o = 0; o < period; o++) {
        let s = 0, n = 0;
        for (let t = o; t < F; t += period) { s += flux[Math.round(t)] || 0; n++; }
        const sc = s / n;
        if (sc > bestGrid) { bestGrid = sc; bestBpm = cand; bestPhase = o; }
      }
    }
    return { bpm: bestBpm, phase: bestPhase / fps };
  }

  /* ---------------- chromagram ---------------- */
  async function chromagram(x, sr, ctl, onPct) {
    const F = Math.floor((x.length - FFT_N) / HOP) + 1;
    if (F < 8) throw mkErr('short');
    const fp = makeFFT(FFT_N), win = hann(FFT_N);
    const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
    const kMin = Math.max(2, Math.floor((FMIN * FFT_N) / sr));
    const kMax = Math.min(FFT_N / 2 - 1, Math.ceil((FMAX * FFT_N) / sr));
    const pcOfBin = new Int8Array(kMax + 1).fill(-1);
    for (let k = kMin; k <= kMax; k++) {
      const f = (k * sr) / FFT_N;
      const midi = 69 + 12 * Math.log2(f / 440);
      pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
    }
    const chroma = new Float32Array(F * 12);
    const rms = new Float32Array(F);
    for (let fr = 0; fr < F; fr++) {
      const off = fr * HOP;
      let e = 0;
      for (let i = 0; i < FFT_N; i++) { const v = x[off + i] * win[i]; re[i] = v; im[i] = 0; e += v * v; }
      rms[fr] = Math.sqrt(e / FFT_N);
      fft(fp, re, im);
      const base = fr * 12;
      for (let k = kMin; k <= kMax; k++) {
        chroma[base + pcOfBin[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
      if ((fr & 31) === 0) { chk(ctl); if (onPct) onPct(fr / F); await tick(); }
    }
    return { chroma, rms, F, frameSec: HOP / sr, t0: FFT_N / 2 / sr };
  }

  /* ---------------- ถอดคอร์ด: template + Viterbi ---------------- */
  function buildTemplates() {
    const labels = [], templates = [];
    for (let r = 0; r < 12; r++) {
      // เมเจอร์: root, 3, 5 — น้ำหนัก 3rd ต่ำหน่อยเพราะฮาร์มอนิกปนบ่อย
      const maj = new Float32Array(12);
      maj[r] = 1.0; maj[(r + 4) % 12] = 0.85; maj[(r + 7) % 12] = 0.95;
      labels.push(SHARP[r]); templates.push(l2norm(maj));
      const min = new Float32Array(12);
      min[r] = 1.0; min[(r + 3) % 12] = 0.85; min[(r + 7) % 12] = 0.95;
      labels.push(SHARP[r] + 'm'); templates.push(l2norm(min));
    }
    return { labels, templates };
  }

  function l2norm(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    s = Math.sqrt(s) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
    return out;
  }

  async function decodeChords(chroma, rms, F, ctl, onPct) {
    const { labels, templates } = buildTemplates();
    const S = 25; // 24 คอร์ด + สถานะ N (ไม่มีคอร์ด/เงียบ)
    let maxRms = 0;
    for (let f = 0; f < F; f++) if (rms[f] > maxRms) maxRms = rms[f];
    const silentThr = Math.max(1e-4, maxRms * 0.02);

    const bp = new Uint8Array(F * S);
    let dpPrev = new Float64Array(S), dpCur = new Float64Array(S);
    // BETA ขยาย contrast ของ emission — ไม่งั้น switch penalty ชนะหลักฐานตลอด คอร์ดไม่ยอมเปลี่ยน
    const BETA = 4;
    const logStay = Math.log(0.85), logSwitch = Math.log(0.15 / (S - 1));
    const sims = new Float32Array(S);
    const cn = new Float32Array(12);
    const simPath = new Float32Array(F); // เก็บ sim ของ state ที่เลือก ไว้คิด confidence

    const emit = (f) => {
      const base = f * 12;
      let s = 0;
      // ใช้ค่าดิบ + L2 normalize — ห้าม log compress ก่อน cosine ไม่งั้นเวกเตอร์แบนจนคอร์ดแยกไม่ออก
      for (let i = 0; i < 12; i++) { const v = chroma[base + i]; cn[i] = v; s += v * v; }
      s = Math.sqrt(s);
      const silent = rms[f] < silentThr || s < 1e-9;
      for (let c = 0; c < 24; c++) {
        if (silent) { sims[c] = 0; continue; }
        const tpl = templates[c];
        let d = 0;
        for (let i = 0; i < 12; i++) d += (cn[i] / s) * tpl[i];
        sims[c] = d;
      }
      sims[24] = silent ? 0.7 : 0.2;
    };

    emit(0);
    for (let c = 0; c < S; c++) dpPrev[c] = BETA * Math.log(sims[c] + 1e-3);
    for (let f = 1; f < F; f++) {
      emit(f);
      // หา best กับ second-best ของ dpPrev — transition มีแค่ stay/switch
      let bi = 0;
      for (let c = 1; c < S; c++) if (dpPrev[c] > dpPrev[bi]) bi = c;
      for (let c = 0; c < S; c++) {
        let best = dpPrev[c] + logStay, from = c;
        const sw = dpPrev[bi] + logSwitch;
        if (bi !== c && sw > best) { best = sw; from = bi; }
        dpCur[c] = best + BETA * Math.log(sims[c] + 1e-3);
        bp[f * S + c] = from;
      }
      const t = dpPrev; dpPrev = dpCur; dpCur = t;
      if ((f & 255) === 0) { chk(ctl); if (onPct) onPct(f / F); await tick(); }
    }
    // backtrace
    const path = new Uint8Array(F);
    let cur = 0;
    for (let c = 1; c < S; c++) if (dpPrev[c] > dpPrev[cur]) cur = c;
    for (let f = F - 1; f >= 0; f--) { path[f] = cur; cur = bp[f * S + cur]; }
    // confidence: ค่าเฉลี่ย similarity ของเฟรมที่เป็นคอร์ดจริง
    let confSum = 0, confN = 0;
    for (let f = 0; f < F; f++) {
      emit(f);
      if (path[f] < 24) { confSum += sims[path[f]]; confN++; }
    }
    const confidence = confN ? Math.round((confSum / confN) * 100) / 100 : 0;
    return { path, labels, confidence };
  }

  function toSegments(path, labels, F, frameSec, t0) {
    const raw = [];
    for (let f = 0; f < F; f++) {
      const chord = path[f] < 24 ? labels[path[f]] : null;
      if (raw.length && raw[raw.length - 1].chord === chord) raw[raw.length - 1].f1 = f + 1;
      else raw.push({ chord, f0: f, f1: f + 1 });
    }
    // segment สั้นกว่า 2 เฟรม (~0.37s) ถือว่า flicker → รวมเข้ากับ segment ก่อนหน้า
    const merged = [];
    raw.forEach((s) => {
      if (s.f1 - s.f0 < 2 && merged.length) { merged[merged.length - 1].f1 = s.f1; return; }
      if (merged.length && merged[merged.length - 1].chord === s.chord) { merged[merged.length - 1].f1 = s.f1; return; }
      merged.push(s);
    });
    return merged.map((s) => ({
      chord: s.chord,
      // เฟรมแรกมี center-bias (~ครึ่งวินโดว์) — คอร์ดที่เริ่มตั้งแต่เฟรม 0 คือเริ่มที่ 0 จริง
      t0: s.f0 === 0 ? 0 : t0 + s.f0 * frameSec,
      t1: t0 + s.f1 * frameSec,
    }));
  }

  /* ---------------- หาคีย์ (Krumhansl-Schmuckler) ---------------- */
  const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function detectKey(chroma, F) {
    const sum = new Float64Array(12);
    for (let f = 0; f < F; f++) {
      const base = f * 12;
      let mx = 0;
      for (let i = 0; i < 12; i++) if (chroma[base + i] > mx) mx = chroma[base + i];
      if (mx <= 0) continue; // เฟรมเงียบไม่มีสิทธิ์โหวต
      for (let i = 0; i < 12; i++) sum[i] += chroma[base + i] / mx;
    }
    function corr(profile, rot) {
      let mx = 0, mp = 0;
      for (let i = 0; i < 12; i++) { mx += sum[i]; mp += profile[i]; }
      mx /= 12; mp /= 12;
      let num = 0, dx = 0, dp = 0;
      for (let i = 0; i < 12; i++) {
        const a = sum[(i + rot) % 12] - mx, b = profile[i] - mp;
        num += a * b; dx += a * a; dp += b * b;
      }
      return num / (Math.sqrt(dx * dp) || 1);
    }
    let best = { r: 0, minor: false, score: -2 };
    for (let r = 0; r < 12; r++) {
      const cM = corr(KS_MAJ, r), cm = corr(KS_MIN, r);
      if (cM > best.score) best = { r, minor: false, score: cM };
      if (cm > best.score) best = { r, minor: true, score: cm };
    }
    return SHARP[best.r] + (best.minor ? 'm' : '');
  }

  // Krumhansl แยก relative major/minor ไม่ออก (โน้ตชุดเดียวกัน) —
  // ตัดสินด้วยเวลารวมของ tonic chord แต่ละฝั่ง + โบนัสคอร์ดเปิดเพลง
  function refineKeyWithChords(key, segs) {
    const minor = key.endsWith('m');
    const pc = SHARP.indexOf(key.replace(/m$/, ''));
    if (pc < 0) return key;
    const rel = minor ? SHARP[(pc + 3) % 12] : SHARP[(pc + 9) % 12] + 'm';
    let tKey = 0, tRel = 0, firstChord = null;
    segs.forEach((s) => {
      if (!s.chord) return;
      if (firstChord === null) firstChord = s.chord;
      const d = s.t1 - s.t0;
      if (s.chord === key) tKey += d;
      if (s.chord === rel) tRel += d;
    });
    if (firstChord === key) tKey += 5;
    if (firstChord === rel) tRel += 5;
    return tRel > tKey * 1.2 ? rel : key;
  }

  /* ---------------- ประกอบ ChordPro ---------------- */
  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function assembleChordPro(segs, bpm, duration, key, title, phase) {
    const beat = 60 / bpm, bar = beat * 4;
    const first = segs.find((s) => s.chord);
    const bpmDisp = Math.round(bpm);
    const head =
      `{title: ${title}}\n{key: ${key}}\n{tempo: ${bpmDisp}}\n\n` +
      `{c: 🎯 Key ${key} · ${bpmDisp} BPM · ${I18N.t('sheet.header')}}\n\n`;
    if (!first) return head + `{c: ${I18N.t('sheet.noChords')}}\n`;

    // snap จุดเริ่มเข้ากริดจังหวะ (phase จาก onset) ให้ห้องเพลงไม่เหลื่อม
    // round() การันตี |เพี้ยน| ≤ ครึ่ง beat — ติดลบนิดหน่อยได้ (จุดสุ่มต่อ beat ยังเป็นบวกเสมอ)
    const tStart = phase + Math.round((first.t0 - phase) / beat) * beat;
    const nBeats = Math.max(4, Math.round((duration - tStart) / beat));
    // คอร์ด ณ กึ่งกลางแต่ละ beat (ไล่ pointer ไปตาม segment — O(n))
    const beatChords = new Array(nBeats);
    let si = 0;
    for (let b = 0; b < nBeats; b++) {
      const t = tStart + (b + 0.5) * beat;
      while (si < segs.length - 1 && segs[si].t1 <= t) si++;
      beatChords[b] = (t >= segs[si].t0 && t < segs[si].t1) ? segs[si].chord : null;
    }
    // จัดเป็นห้อง (4 จังหวะ) — คอร์ดซ้ำติดกันในห้องเดียวยุบเหลือตัวเดียว
    const bars = [];
    for (let b = 0; b < nBeats; b += 4) {
      const tokens = [];
      for (let i = b; i < Math.min(b + 4, nBeats); i++) {
        const c = beatChords[i] || 'N.C.';
        if (!tokens.length || tokens[tokens.length - 1] !== c) tokens.push(c);
      }
      bars.push(tokens);
    }
    // 4 ห้องต่อบรรทัด + ยุบบรรทัดซ้ำติดกันเป็น (×n) + timestamp ทุก 4 บรรทัด
    const lines = [];
    for (let i = 0; i < bars.length; i += 4) {
      const text = bars.slice(i, i + 4)
        .map((tk) => tk.map((c) => `[${c}]`).join(' ')).join(' | ');
      lines.push({ text, t: tStart + (i / 4) * bar * 4 });
    }
    let body = '', lineNo = 0;
    for (let i = 0; i < lines.length; ) {
      let n = 1;
      while (i + n < lines.length && lines[i + n].text === lines[i].text) n++;
      if (lineNo % 4 === 0) body += `{c: ⏱ ${fmtTime(lines[i].t)}}\n`;
      body += lines[i].text + (n > 1 ? `   (×${n})` : '') + '\n';
      lineNo++;
      i += n;
    }
    return head + body + `\n{c: ⚠ ${I18N.t('sheet.aiNote')}}\n`;
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
  async function run(input, onProgress, ctl) {
    const P = (stage, pct) =>
      onProgress && onProgress({ stage, percent: Math.max(0, Math.min(99, Math.round(pct))) });

    // 1) ingest: อ่านไฟล์ + decode
    P('ingest', 2);
    let buf, srcName;
    if (input.kind === 'file') {
      if (input.file.size > MAX_BYTES) throw mkErr('toobig');
      buf = await input.file.arrayBuffer();
      srcName = input.file.name;
    } else {
      buf = await fetchAudio(input.url);
      srcName = decodeURIComponent((input.url.split('/').pop() || '').split(/[?#]/)[0]) || 'Untitled';
    }
    chk(ctl); P('ingest', 6);
    let audio;
    try { audio = await decode(Music.audioCtx(), buf); }
    catch (e) { throw mkErr('decode'); }
    if (!audio || audio.duration < 5) throw mkErr('short');
    chk(ctl);

    // 2) prep: mono + resample
    P('prep', 12);
    const seconds = Math.min(audio.duration, MAX_SECONDS);
    const { data, sr } = await toMono(audio, seconds);
    chk(ctl); P('prep', 18);

    // 3) beats: จับ BPM + beat phase
    const { bpm, phase } = await detectTempo(data, sr, ctl, (p) => P('beats', 18 + p * 12));
    chk(ctl); P('beats', 30);

    // 4) chords: chromagram + Viterbi
    const { chroma, rms, F, frameSec, t0 } = await chromagram(data, sr, ctl, (p) => P('chords', 30 + p * 40));
    chk(ctl);
    const { path, labels, confidence } = await decodeChords(chroma, rms, F, ctl, (p) => P('chords', 70 + p * 12));
    chk(ctl); P('chords', 82);
    const segs = toSegments(path, labels, F, frameSec, t0);

    // 5) key
    const key = refineKeyWithChords(detectKey(chroma, F), segs);
    P('key', 88);

    // 6) assemble: ChordPro + SongDoc
    const title = prettyTitle(srcName);
    const chordpro = assembleChordPro(segs, bpm, seconds, key, title, phase);
    const timeline = segs
      .filter((s) => s.chord)
      .map((s) => ({ t: Math.round(s.t0 * 10) / 10, chord: s.chord }));
    P('assemble', 96);

    const now = Date.now();
    return {
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
      source: input.kind === 'file' ? { kind: 'upload', ref: srcName } : { kind: 'url', ref: input.url },
      confidence: { chords: confidence, lyrics: 0 },
      isPublic: false,
      favorite: 0,
      playCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  window.Analyze = { STAGES, run };
})();
