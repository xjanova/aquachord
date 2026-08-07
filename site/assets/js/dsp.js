/* dsp.js — เอนจินวิเคราะห์คอร์ด (DSP ล้วน ไม่แตะ DOM/WebAudio)
   ใช้ได้ทั้งเบราว์เซอร์ (window.DSP) และ Node (module.exports → รันเทสต์ได้ใน CI)

   ของใหม่เทียบเอนจินเดิม (v1.2):
   1. tuning compensation — ประมาณค่าเพี้ยนจูนของทั้งเพลง (เพลงที่ไม่ได้จูน A440
      ตรง ๆ เคยทำให้โน้ตตกผิดช่อง semitone → คอร์ดผิดยกแผง)
   2. spectral peak picking — ใช้เฉพาะยอดสเปกตรัมจริง ตัดพื้นเสียงกลอง/นอยส์
      ที่เคยเลอะ chromagram ทั้งแถบ
   3. harmonic attribution — ยอดแต่ละยอดถูกเฉลี่ยกลับไปหา fundamental (f, f/2,
      f/3, f/4) ทำให้โน้ตจริงคมขึ้น ฮาร์มอนิกไม่ถูกนับเป็นโน้ตใหม่
   4. bass chroma — แยกย่านเบส (≤280Hz) มาโหวต root ของคอร์ดโดยเฉพาะ
      ช่วยแยก C กับ Am (โน้ตชุดเกือบเดียวกัน ต่างกันที่เบส)
   5. ศัพท์คอร์ด 60 ตัว — เพิ่ม 7, m7, maj7 (เดิมมีแค่ maj/min 24 ตัว)
   6. Viterbi 2 รอบแบบรู้คีย์ — รอบแรกหาคีย์ รอบสองให้โบนัสคอร์ดในคีย์
      (เพลงป๊อปคอร์ดนอกคีย์เจอน้อย → ตัด false positive แบบสุ่ม)
   7. เกลี่ย chroma ตามเวลา (moving average) ก่อนถอด ลด flicker */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.DSP = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noTick = () => Promise.resolve();
  const noop = () => {};
  const mod12 = (n) => ((n % 12) + 12) % 12;

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

  /* ---------------- จับจังหวะ: spectral flux + autocorrelation ---------------- */
  async function detectTempo(x, sr, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
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
      if ((f & 63) === 0) { chk(); onPct(f / F); await tick(); }
    }
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

  /* ---------------- chromagram: peaks → tuning → harmonic fold ---------------- */
  async function analyzeChroma(x, sr, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    // hop 1024 (~93ms) — คอร์ดเปลี่ยนเร็วสุดที่จับได้ ~0.35s; หน้าต่าง 8192 ยังจำเป็น
    // เพื่อแยกโน้ตเบสต่ำ (A1–B1 ห่างกัน ~3.3Hz)
    const N = opts.fftN || 8192, HOP = opts.hop || 1024;
    const FMIN = opts.fmin || 55, FMAX = opts.fmax || 1900;
    const BASS_FMAX = opts.bassFmax || 280;
    const usePeaks = opts.peakPick !== false;
    const useTuning = opts.tuning !== false;
    const useHarm = opts.harmonics !== false;
    const useSmooth = opts.smooth !== false;

    const F = Math.floor((x.length - N) / HOP) + 1;
    if (F < 8) { const e = new Error('short'); e.code = 'short'; throw e; }
    const fp = makeFFT(N), win = hann(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const kMin = Math.max(2, Math.floor((FMIN * N) / sr));
    const kMax = Math.min(N / 2 - 1, Math.ceil((FMAX * N) / sr));
    const binHz = sr / N;
    const midiMin = 69 + 12 * Math.log2(FMIN / 440) - 0.6;

    const chroma = new Float32Array(F * 12);
    const bass = new Float32Array(F * 12);
    const rms = new Float32Array(F);
    // เก็บยอดต่อเฟรมไว้ก่อน (midi, mag สลับกัน) — ต้องรู้ tuning ของทั้งเพลง
    // ก่อนจึงจะพับลงช่อง semitone ได้ถูก
    const framePeaks = new Array(F);
    let tunC = 0, tunS = 0;

    const AVG_W = 14; // ครึ่งหน้าต่าง moving average สำหรับ noise floor
    const mag = new Float32Array(kMax + 2);
    const pre = new Float64Array(kMax + 3);

    for (let fr = 0; fr < F; fr++) {
      const off = fr * HOP;
      let e = 0;
      for (let i = 0; i < N; i++) { const v = x[off + i] * win[i]; re[i] = v; im[i] = 0; e += v * v; }
      rms[fr] = Math.sqrt(e / N);
      fft(fp, re, im);
      for (let k = kMin - 1; k <= kMax + 1; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);

      const peaks = [];
      if (usePeaks) {
        // noise floor เฉพาะที่: ค่าเฉลี่ยรอบ bin ±AVG_W — ยอดต้องโผล่พ้นถึงนับ
        pre[kMin - 1] = 0;
        for (let k = kMin - 1; k <= kMax + 1; k++) pre[k + 1] = pre[k] + mag[k];
        for (let k = kMin; k <= kMax; k++) {
          const m = mag[k];
          if (m <= mag[k - 1] || m < mag[k + 1]) continue;
          const a0 = Math.max(kMin - 1, k - AVG_W), b0 = Math.min(kMax + 1, k + AVG_W);
          const local = (pre[b0 + 1] - pre[a0]) / (b0 - a0 + 1);
          if (m < local * 1.7 || m <= 1e-6) continue;
          // parabolic refine ตำแหน่งยอด → ความถี่ละเอียดกว่า 1 bin
          const am = mag[k - 1], bm = m, cm = mag[k + 1];
          const den = am - 2 * bm + cm;
          const d = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (am - cm) / den)) : 0;
          const f0 = (k + d) * binHz;
          const midi = 69 + 12 * Math.log2(f0 / 440);
          peaks.push(midi, m);
          if (useTuning) {
            const dev = midi - Math.round(midi);
            const w = Math.sqrt(m);
            tunC += w * Math.cos(2 * Math.PI * dev);
            tunS += w * Math.sin(2 * Math.PI * dev);
          }
        }
      } else {
        // โหมดเก่า: พับทุก bin ตรง ๆ (ไว้เทียบ benchmark)
        for (let k = kMin; k <= kMax; k++) {
          const f0 = k * binHz;
          peaks.push(69 + 12 * Math.log2(f0 / 440), mag[k]);
        }
      }
      framePeaks[fr] = peaks;
      if ((fr & 31) === 0) { chk(); onPct((fr / F) * 0.8); await tick(); }
    }

    const tuning = useTuning ? Math.atan2(tunS, tunC) / (2 * Math.PI) : 0;

    // พับยอดลง chroma (ชดเชย tuning) + กระจายฮาร์มอนิกกลับหา fundamental
    const H_OFF = [0, 12, 19.019550008653875, 24]; // log2(1,2,3,4)*12
    const H_W = [1.0, 0.5, 0.33, 0.25];
    const bassMidiMax = 69 + 12 * Math.log2(BASS_FMAX / 440);
    for (let fr = 0; fr < F; fr++) {
      const peaks = framePeaks[fr];
      const cBase = fr * 12;
      for (let i = 0; i < peaks.length; i += 2) {
        const midi = peaks[i], m = peaks[i + 1];
        if (useHarm) {
          for (let h = 0; h < 4; h++) {
            const m0 = midi - H_OFF[h];
            if (m0 < midiMin) break;
            chroma[cBase + mod12(Math.round(m0 - tuning))] += m * H_W[h];
          }
        } else {
          chroma[cBase + mod12(Math.round(midi - tuning))] += m;
        }
        if (midi <= bassMidiMax) bass[cBase + mod12(Math.round(midi - tuning))] += m;
      }
      framePeaks[fr] = null; // คืน RAM ระหว่างทาง
      if ((fr & 255) === 0) { chk(); onPct(0.8 + (fr / F) * 0.2); await tick(); }
    }

    // เกลี่ยตามเวลา 3 เฟรม (~0.56s) — Viterbi ชอบหลักฐานที่นิ่ง
    let outC = chroma, outB = bass;
    if (useSmooth && F >= 3) {
      outC = new Float32Array(F * 12);
      outB = new Float32Array(F * 12);
      for (let fr = 0; fr < F; fr++) {
        const p = Math.max(0, fr - 1) * 12, c = fr * 12, n = Math.min(F - 1, fr + 1) * 12;
        for (let i = 0; i < 12; i++) {
          outC[c + i] = 0.25 * chroma[p + i] + 0.5 * chroma[c + i] + 0.25 * chroma[n + i];
          outB[c + i] = 0.25 * bass[p + i] + 0.5 * bass[c + i] + 0.25 * bass[n + i];
        }
      }
    }

    return {
      chroma: outC, bass: outB, rms, F,
      frameSec: HOP / sr, t0: N / 2 / sr,
      tuningCents: Math.round(tuning * 100),
    };
  }

  /* ---------------- แยกเสียงร้องออกจากดนตรี (center extraction) ----------------
     เสียงร้องเกือบทุกเพลงถูกแพนไว้กลาง (เท่ากันทั้ง L/R) ส่วนดนตรีกระจายซ้าย-ขวา
     ต่อ bin: mid=(L+R)/2, side=(L−R)/2 → |center| ≈ max(0, |mid| − k·|side|)
     คงเฟสของ mid ไว้ แล้ว overlap-add กลับ (หารด้วยผลรวมหน้าต่างจริง = คืนรูปได้เป๊ะ)
     ผลคือดนตรีเบาลงมาก Whisper จับคำไทยได้ดีขึ้นชัดเจนบนเพลงมิกซ์เต็ม */
  function isolateCenter(L, R, opts) {
    opts = opts || {};
    const N = opts.fftN || 2048, HOP = N >> 1;
    const k = opts.k != null ? opts.k : 1.0;   // ความแรงในการหักเสียงข้าง
    const floor = opts.floor != null ? opts.floor : 0.08; // เหลือพื้นไว้กัน artifact
    const len = Math.min(L.length, R.length);
    if (len < N) return L.slice(0, len);
    const fp = makeFFT(N), win = hann(N);
    const mr = new Float32Array(N), mi = new Float32Array(N);
    const sr_ = new Float32Array(N), si = new Float32Array(N);
    const out = new Float32Array(len), wsum = new Float32Array(len);
    const nFrames = Math.floor((len - N) / HOP) + 1;
    for (let f = 0; f < nFrames; f++) {
      const off = f * HOP;
      for (let i = 0; i < N; i++) {
        const l = L[off + i], r = R[off + i], w = win[i];
        mr[i] = ((l + r) * 0.5) * w; mi[i] = 0;
        sr_[i] = ((l - r) * 0.5) * w; si[i] = 0;
      }
      fft(fp, mr, mi);
      fft(fp, sr_, si);
      for (let b = 0; b < N; b++) {
        const mm = Math.sqrt(mr[b] * mr[b] + mi[b] * mi[b]);
        if (mm < 1e-12) { mr[b] = 0; mi[b] = 0; continue; }
        const ss = Math.sqrt(sr_[b] * sr_[b] + si[b] * si[b]);
        const g = Math.max(floor, (mm - k * ss) / mm);
        mr[b] *= g; mi[b] *= g;
      }
      // IFFT ผ่าน FFT ของคอนจูเกต: ifft(x) = conj(fft(conj(x)))/N
      for (let b = 0; b < N; b++) mi[b] = -mi[b];
      fft(fp, mr, mi);
      for (let i = 0; i < N; i++) {
        const v = (mr[i] / N) * win[i]; // synthesis window ด้วย → hann² overlap-add
        out[off + i] += v;
        wsum[off + i] += win[i] * win[i];
      }
    }
    for (let i = 0; i < len; i++) if (wsum[i] > 1e-6) out[i] /= wsum[i];
    return out;
  }

  // เตรียมสัญญาณให้ ASR: ตัดเสียงต่ำ (rumble/เบส) + normalize ตาม peak
  function prepForASR(x, sr, opts) {
    opts = opts || {};
    const hpHz = opts.highpass != null ? opts.highpass : 80;
    const out = new Float32Array(x.length);
    // one-pole high-pass
    const dt = 1 / sr, rc = 1 / (2 * Math.PI * hpHz), a = rc / (rc + dt);
    let yPrev = 0, xPrev = 0;
    for (let i = 0; i < x.length; i++) {
      const y = a * (yPrev + x[i] - xPrev);
      out[i] = y; yPrev = y; xPrev = x[i];
    }
    let mx = 0;
    for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > mx) mx = v; }
    if (mx > 1e-6) { const g = 0.95 / mx; for (let i = 0; i < out.length; i++) out[i] *= g; }
    return out;
  }

  /* ---------------- ศัพท์คอร์ด + template ---------------- */
  // ลำดับ quality ต่อ root — ดัชนี state = root*Q + q
  const QUALITIES = [
    { suf: '',     iv: [0, 4, 7],      w: [1.0, 0.85, 0.95] },
    { suf: 'm',    iv: [0, 3, 7],      w: [1.0, 0.85, 0.95] },
    { suf: '7',    iv: [0, 4, 7, 10],  w: [1.0, 0.8, 0.9, 0.75] },
    { suf: 'm7',   iv: [0, 3, 7, 10],  w: [1.0, 0.8, 0.9, 0.75] },
    { suf: 'maj7', iv: [0, 4, 7, 11],  w: [1.0, 0.8, 0.9, 0.7] },
  ];

  function l2norm(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    s = Math.sqrt(s) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
    return out;
  }

  function buildTemplates(nQ, hSpill) {
    const labels = [], templates = [], bassTpl = [];
    for (let r = 0; r < 12; r++) {
      for (let q = 0; q < nQ; q++) {
        const Q = QUALITIES[q];
        const t = new Float32Array(12);
        for (let i = 0; i < Q.iv.length; i++) {
          const p = mod12(r + Q.iv[i]), w = Q.w[i];
          t[p] += w;
          if (hSpill > 0) {
            // เศษฮาร์มอนิกที่เหลือหลัง attribution: คู่ห้า (h3) เด่นสุด
            t[mod12(p + 7)] += hSpill * w;
            t[mod12(p + 4)] += hSpill * 0.4 * w;
          }
        }
        labels.push(SHARP[r] + Q.suf);
        templates.push(l2norm(t));
        const b = new Float32Array(12);
        b[r] = 1.0; b[mod12(r + 7)] = 0.55; b[mod12(r + Q.iv[1])] = 0.25;
        bassTpl.push(l2norm(b));
      }
    }
    return { labels, templates, bassTpl };
  }

  // คอร์ด diatonic ของคีย์ (รวม 7th ที่พบบ่อย) — ใช้ให้โบนัสใน Viterbi รอบสอง
  function diatonicLabels(key) {
    const m = /^([A-G]#?)(m?)$/.exec(key || '');
    if (!m) return new Set();
    const r = SHARP.indexOf(m[1]);
    if (r < 0) return new Set();
    const out = new Set();
    const add = (off, suf) => out.add(SHARP[mod12(r + off)] + suf);
    if (!m[2]) { // เมเจอร์: I ii iii IV V vi (+7th)
      add(0, ''); add(5, ''); add(7, '');
      add(2, 'm'); add(4, 'm'); add(9, 'm');
      add(0, 'maj7'); add(5, 'maj7'); add(7, '7');
      add(2, 'm7'); add(4, 'm7'); add(9, 'm7');
    } else { // ไมเนอร์ (natural + harmonic V): i iv v/V III VI VII
      add(0, 'm'); add(5, 'm'); add(7, 'm'); add(7, '');
      add(3, ''); add(8, ''); add(10, '');
      add(0, 'm7'); add(5, 'm7'); add(7, '7');
      add(3, 'maj7'); add(8, 'maj7'); add(10, '7');
    }
    return out;
  }

  /* ---------------- ถอดคอร์ด: emission + Viterbi 2 รอบ ---------------- */
  async function decodeChords(chroma, bass, rms, F, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    const nQ = opts.sevenths === false ? 2 : QUALITIES.length;
    const bassW = opts.bassWeight != null ? opts.bassWeight : 0.27;
    const hSpill = opts.hSpill != null ? opts.hSpill : 0.15;
    const keyAware = opts.keyAware !== false;
    const BETA = opts.beta || 4;
    // penalty ต่อเฟรม — 7th ต้องมีหลักฐานต่อเนื่องจริงถึงชนะ triad (สะสมทั้ง segment)
    const PRIOR7 = opts.prior7 != null ? opts.prior7 : -0.1;
    const KEY_BONUS = opts.keyBonus != null ? opts.keyBonus : 0.5;
    const STAY = opts.stay != null ? opts.stay : 0.9;
    const frameSec = opts.frameSec || 0.093; // ใช้แปลง segment เป็นวินาทีตอน refine คีย์

    const { labels, templates, bassTpl } = buildTemplates(nQ, hSpill);
    const C = labels.length; // จำนวนคอร์ด
    const S = C + 1;         // + สถานะ N (ไม่มีคอร์ด/เงียบ)
    let maxRms = 0;
    for (let f = 0; f < F; f++) if (rms[f] > maxRms) maxRms = rms[f];
    const silentThr = Math.max(1e-4, maxRms * 0.02);

    // similarity ทุกเฟรม×คอร์ด คิดครั้งเดียว ใช้ทั้ง 2 รอบ + confidence
    const sims = new Float32Array(F * S);
    const cn = new Float32Array(12), bn = new Float32Array(12);
    for (let f = 0; f < F; f++) {
      const base = f * 12;
      let s = 0, sb = 0;
      // ค่าดิบ + L2 normalize — ห้าม log compress ก่อน cosine ไม่งั้นเวกเตอร์แบนจนคอร์ดแยกไม่ออก
      for (let i = 0; i < 12; i++) {
        const v = chroma[base + i]; cn[i] = v; s += v * v;
        const b = bass[base + i]; bn[i] = b; sb += b * b;
      }
      s = Math.sqrt(s); sb = Math.sqrt(sb);
      const silent = rms[f] < silentThr || s < 1e-9;
      const hasBass = sb > 1e-9 && bassW > 0;
      const row = f * S;
      for (let c = 0; c < C; c++) {
        if (silent) { sims[row + c] = 0; continue; }
        const tpl = templates[c];
        let d = 0;
        for (let i = 0; i < 12; i++) d += (cn[i] / s) * tpl[i];
        if (hasBass) {
          const bt = bassTpl[c];
          let db = 0;
          for (let i = 0; i < 12; i++) db += (bn[i] / sb) * bt[i];
          d = (1 - bassW) * d + bassW * db;
        }
        sims[row + c] = d > 0 ? d : 0;
      }
      sims[row + C] = silent ? 0.7 : 0.2;
      if ((f & 127) === 0) { chk(); onPct((f / F) * 0.45); await tick(); }
    }

    const logStay = Math.log(STAY), logSwitch = Math.log((1 - STAY) / (S - 1));
    const bp = new Uint8Array(F * S);
    const prior = new Float32Array(S);
    for (let c = 0; c < C; c++) {
      const suf = labels[c].replace(/^[A-G]#?/, '');
      if (suf === '7' || suf === 'm7' || suf === 'maj7') prior[c] = PRIOR7;
    }

    async function viterbi(bonus) {
      let dpPrev = new Float64Array(S), dpCur = new Float64Array(S);
      const emit = (f, c) => BETA * Math.log(sims[f * S + c] + 1e-3) + prior[c] + (bonus ? bonus[c] : 0);
      for (let c = 0; c < S; c++) dpPrev[c] = emit(0, c);
      for (let f = 1; f < F; f++) {
        let bi = 0;
        for (let c = 1; c < S; c++) if (dpPrev[c] > dpPrev[bi]) bi = c;
        const rowBp = f * S;
        for (let c = 0; c < S; c++) {
          let best = dpPrev[c] + logStay, from = c;
          const sw = dpPrev[bi] + logSwitch;
          if (bi !== c && sw > best) { best = sw; from = bi; }
          dpCur[c] = best + emit(f, c);
          bp[rowBp + c] = from;
        }
        const t = dpPrev; dpPrev = dpCur; dpCur = t;
        if ((f & 255) === 0) { chk(); await tick(); }
      }
      const path = new Uint8Array(F);
      let cur = 0;
      for (let c = 1; c < S; c++) if (dpPrev[c] > dpPrev[cur]) cur = c;
      for (let f = F - 1; f >= 0; f--) { path[f] = cur; cur = bp[f * S + cur]; }
      return path;
    }

    let path = await viterbi(null);
    onPct(0.7);

    // รอบสอง: หาคีย์จากรอบแรก แล้วให้โบนัสคอร์ดในคีย์
    let key = detectKey(chroma, F);
    key = refineKeyWithChords(key, pathToSegments(path, labels, C, frameSec));
    if (keyAware) {
      const dia = diatonicLabels(key);
      if (dia.size) {
        const bonus = new Float32Array(S);
        for (let c = 0; c < C; c++) if (dia.has(labels[c])) bonus[c] = KEY_BONUS;
        path = await viterbi(bonus);
      }
    }
    onPct(0.95);

    // confidence: ค่าเฉลี่ย similarity ของเฟรมที่เป็นคอร์ดจริง
    let confSum = 0, confN = 0;
    for (let f = 0; f < F; f++) {
      if (path[f] < C) { confSum += sims[f * S + path[f]]; confN++; }
    }
    const confidence = confN ? Math.round((confSum / confN) * 100) / 100 : 0;
    return { path, labels, confidence, key, nChords: C };
  }

  // segment ภายใน (แปลงเป็นวินาที) — ใช้ refine คีย์ระหว่างรอบ
  // ต้องเป็นวินาทีจริง เพราะ refineKeyWithChords มีโบนัสคอร์ดเปิดเพลงเป็นค่าคงที่ (+5s)
  function pathToSegments(path, labels, C, frameSec) {
    const segs = [];
    for (let f = 0; f < path.length; f++) {
      const chord = path[f] < C ? labels[path[f]] : null;
      if (segs.length && segs[segs.length - 1].chord === chord) segs[segs.length - 1].t1 = (f + 1) * frameSec;
      else segs.push({ chord, t0: f * frameSec, t1: (f + 1) * frameSec });
    }
    return segs;
  }

  function toSegments(path, labels, nChords, F, frameSec, t0) {
    const raw = [];
    for (let f = 0; f < F; f++) {
      const chord = path[f] < nChords ? labels[path[f]] : null;
      if (raw.length && raw[raw.length - 1].chord === chord) raw[raw.length - 1].f1 = f + 1;
      else raw.push({ chord, f0: f, f1: f + 1 });
    }
    // segment สั้นกว่า ~0.3s ถือว่า flicker → รวมเข้ากับ segment ก่อนหน้า
    const minFrames = Math.max(2, Math.round(0.3 / frameSec));
    const merged = [];
    raw.forEach((s) => {
      if (s.f1 - s.f0 < minFrames && merged.length) { merged[merged.length - 1].f1 = s.f1; return; }
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
  // เทียบแบบ triad (Am7 นับเป็นฝั่ง Am ด้วย)
  function refineKeyWithChords(key, segs) {
    const minor = key.endsWith('m');
    const pc = SHARP.indexOf(key.replace(/m$/, ''));
    if (pc < 0) return key;
    const rel = minor ? SHARP[(pc + 3) % 12] : SHARP[(pc + 9) % 12] + 'm';
    const triadOf = (c) => {
      if (!c) return null;
      const m = /^([A-G]#?)(.*)$/.exec(c);
      if (!m) return c;
      return m[1] + (m[2] === 'm' || m[2] === 'm7' ? 'm' : '');
    };
    let tKey = 0, tRel = 0, firstChord = null;
    segs.forEach((s) => {
      const tri = triadOf(s.chord);
      if (!tri) return;
      if (firstChord === null) firstChord = tri;
      const d = s.t1 - s.t0;
      if (tri === key) tKey += d;
      if (tri === rel) tRel += d;
    });
    if (firstChord === key) tKey += 5;
    if (firstChord === rel) tRel += 5;
    return tRel > tKey * 1.2 ? rel : key;
  }

  /* ---------------- กริดคอร์ดเป็นห้องเพลง (ใช้ทั้งชีตล้วนและช่วงดนตรี) ---------------- */
  function chordAt(segs, t) {
    for (let i = 0; i < segs.length; i++) {
      if (t >= segs[i].t0 && t < segs[i].t1) return segs[i].chord;
    }
    return null;
  }

  // แถวคอร์ดช่วง [a,b) จัดเป็นห้อง 4 จังหวะ, 4 ห้อง/แถว → [{text:'[C] [G] | ...', t}]
  function gridRows(segs, bpm, phase, a, b) {
    const beat = 60 / bpm, bar = beat * 4;
    const gStart = phase + Math.round((a - phase) / beat) * beat;
    const nBeats = Math.round((b - gStart) / beat);
    if (nBeats < 2) return [];
    const beatChords = new Array(nBeats);
    let si = 0;
    for (let bt = 0; bt < nBeats; bt++) {
      const t = gStart + (bt + 0.5) * beat;
      while (si < segs.length - 1 && segs[si].t1 <= t) si++;
      beatChords[bt] = (segs[si] && t >= segs[si].t0 && t < segs[si].t1) ? segs[si].chord : null;
    }
    const bars = [];
    for (let bt = 0; bt < nBeats; bt += 4) {
      const tokens = [];
      for (let i = bt; i < Math.min(bt + 4, nBeats); i++) {
        const c = beatChords[i] || 'N.C.';
        if (!tokens.length || tokens[tokens.length - 1] !== c) tokens.push(c);
      }
      bars.push(tokens);
    }
    const rows = [];
    for (let i = 0; i < bars.length; i += 4) {
      const text = bars.slice(i, i + 4).map((tk) => tk.map((c) => '[' + c + ']').join(' ')).join(' | ');
      rows.push({ text, t: gStart + i * bar });
    }
    return rows;
  }

  /* ---------------- ผสานเนื้อร้อง + คอร์ด ---------------- */
  // ตัดเป็น grapheme cluster — ห้ามแทรกคอร์ดคั่นกลางสระ/วรรณยุกต์ไทย
  let segmenter = null;
  function graphemes(s) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      if (!segmenter) segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' });
      return Array.from(segmenter.segment(s), (x) => x.segment);
    }
    const out = [];
    // combining marks ไทย (ไม้หันอากาศ สระอำ สระบน/ล่าง วรรณยุกต์) + ZWJ/VS16
    const COMB = /[\u0300-\u036F\u0E31\u0E33-\u0E3A\u0E47-\u0E4E\u200D\uFE0F]/;
    for (const ch of s) {
      if (out.length && COMB.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  // ประโยคหลอนที่ Whisper ชอบเติมช่วงเงียบ/ท้ายเพลง — ตัดทิ้งเมื่อทั้ง chunk คือข้อความนี้
  const JUNK = new Set([
    'ขอบคุณครับ', 'ขอบคุณค่ะ', 'ขอบคุณมากครับ', 'ขอบคุณมากค่ะ',
    'ขอบคุณที่รับชม', 'ขอบคุณที่รับชมครับ', 'ขอบคุณที่รับชมค่ะ',
    'ขอบคุณสำหรับการรับชม', 'ขอบคุณสำหรับการรับชมครับ',
    'ฝากกดไลก์กดแชร์ด้วยนะครับ', 'ฝากกดไลค์กดแชร์ด้วยนะคะ', 'กดไลก์กดแชร์',
    'สวัสดีครับ', 'สวัสดีค่ะ', 'แล้วพบกันใหม่', 'แล้วเจอกันใหม่',
    'thank you.', 'thank you', 'thanks for watching.', 'thanks for watching!',
    'thanks for watching', 'please subscribe', 'subscribe',
    '[เพลง]', '(เพลง)', '[ดนตรี]', '(ดนตรี)', '[music]', '(music)', '♪', '♪♪', '♫',
  ]);

  function cleanChunks(chunks, duration) {
    const out = [];
    (chunks || []).forEach((c) => {
      let text = String(c.text == null ? '' : c.text)
        .replace(/[♪♫]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (JUNK.has(text.toLowerCase())) return;
      let t0 = +c.t0, t1 = +c.t1;
      if (!isFinite(t0) || t0 < 0) t0 = 0;
      if (!isFinite(t1) || t1 <= t0) t1 = Math.min(duration || t0 + 6, t0 + 6);
      out.push({ t0, t1, text });
    });
    out.sort((x, y) => x.t0 - y.t0);
    // Whisper วนหลอนซ้ำข้อความเดิม — เพลงจริงร้องท่อนซ้ำได้ แต่เกิน 2 ครั้งติดถือว่าหลอน
    const dedup = [];
    let run = 0;
    for (const c of out) {
      if (dedup.length && dedup[dedup.length - 1].text === c.text) run++;
      else run = 0;
      if (run >= 2) continue;
      dedup.push(c);
    }
    return dedup;
  }

  // chunk ยาวมากตัดเป็นบรรทัดละ ≤ maxG grapheme (แบ่งตรงช่องว่างถ้ามี)
  function splitChunk(c, maxG) {
    const g = graphemes(c.text);
    if (g.length <= maxG) return [c];
    const mid = Math.floor(g.length / 2);
    let cut = -1;
    for (let d = 0; d <= Math.min(10, mid - 1); d++) {
      if (g[mid + d] === ' ') { cut = mid + d; break; }
      if (g[mid - d] === ' ') { cut = mid - d; break; }
    }
    if (cut < 1) cut = mid;
    const left = g.slice(0, cut).join('').trim();
    const right = g.slice(cut).join('').trim();
    const frac = cut / g.length;
    const tm = c.t0 + (c.t1 - c.t0) * frac;
    const parts = [];
    if (left) parts.push(...splitChunk({ t0: c.t0, t1: tm, text: left }, maxG));
    if (right) parts.push(...splitChunk({ t0: tm, t1: c.t1, text: right }, maxG));
    return parts.length ? parts : [c];
  }

  /* วางคอร์ดลงในบรรทัดเนื้อร้องตามสัดส่วนเวลา + แทรกช่วงดนตรีเป็นกริดคอร์ด
     คืน blocks: {type:'grid', rows:[{text,t}]} | {type:'lyric', text, t} | {type:'blank'} */
  function layoutLyricLines(segs, chunks, opts) {
    const bpm = opts.bpm || 100, phase = opts.phase || 0, duration = opts.duration || 0;
    const beat = 60 / bpm, bar = beat * 4;
    let list = cleanChunks(chunks, duration);
    list = list.flatMap((c) => splitChunk(c, 42));
    const blocks = [];
    if (!list.length) return blocks;

    let musicEnd = 0;
    segs.forEach((s) => { if (s.chord) musicEnd = Math.max(musicEnd, s.t1); });
    list.forEach((c) => { musicEnd = Math.max(musicEnd, c.t1); });

    const firstChordSeg = segs.find((s) => s.chord);
    let cursor = firstChordSeg ? Math.max(0, firstChordSeg.t0) : 0;
    let prevChord = null;
    let sectionStart = true;

    const pushGrid = (a, b) => {
      const rows = gridRows(segs, bpm, phase, a, b);
      if (rows.length) { blocks.push({ type: 'grid', rows }); sectionStart = true; }
    };

    for (const c of list) {
      const gap = c.t0 - cursor;
      if (gap >= bar * 0.9) {
        pushGrid(cursor, c.t0);
      } else if (gap >= beat * 2 && blocks.length && blocks[blocks.length - 1].type === 'lyric') {
        blocks.push({ type: 'blank' });
        sectionStart = true;
      }

      // event คอร์ดในหน้าต่างของบรรทัดนี้
      const g = graphemes(c.text);
      const G = g.length;
      const span = Math.max(0.001, c.t1 - c.t0);
      const events = [];
      for (const s of segs) {
        if (!s.chord || s.t1 <= c.t0 || s.t0 >= c.t1) continue;
        const evT = Math.max(s.t0, c.t0);
        const lead = evT <= c.t0 + 0.001; // คอร์ดที่คาบเกี่ยวมาจากก่อนหน้า
        if (lead && s.chord === prevChord && !sectionStart) continue; // ไม่ย้ำคอร์ดเดิมทุกบรรทัด
        if (events.length && events[events.length - 1].chord === s.chord) continue;
        let pos = Math.round(((evT - c.t0) / span) * G);
        pos = Math.max(0, Math.min(G, pos));
        if (events.length && pos < events[events.length - 1].pos) pos = events[events.length - 1].pos;
        events.push({ pos, chord: s.chord });
      }
      let text = '';
      let ei = 0;
      for (let i = 0; i <= G; i++) {
        while (ei < events.length && events[ei].pos === i) { text += '[' + events[ei].chord + ']'; ei++; }
        if (i < G) text += g[i];
      }
      blocks.push({ type: 'lyric', text, t: c.t0 });
      const lastSeg = segs.filter((s) => s.chord && s.t0 < c.t1 && s.t1 > c.t0).pop();
      if (lastSeg) prevChord = lastSeg.chord;
      sectionStart = false;
      cursor = Math.max(cursor, c.t1);
    }
    if (musicEnd - cursor >= bar * 0.9) pushGrid(cursor, musicEnd);
    return blocks;
  }

  return {
    SHARP, QUALITIES,
    makeFFT, fft, hann,
    detectTempo, analyzeChroma, decodeChords, toSegments,
    isolateCenter, prepForASR,
    detectKey, refineKeyWithChords, diatonicLabels,
    gridRows, chordAt, graphemes, cleanChunks, layoutLyricLines,
  };
});
