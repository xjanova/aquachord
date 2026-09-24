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

  /* =====================================================================
     เอนจิน v2 (device-2) — pipeline ที่ analyze.js ใช้จริงผ่าน analyzeSong()
     ฟังก์ชัน v1 ด้านบนยังอยู่ (เทสต์เทียบ legacy ใน tools/test-dsp.cjs ใช้)
     เทคนิค (เขียนเองจากคำอธิบายในงานวิจัย ไม่ได้ port โค้ดใคร):
     - beat tracker แบบ dynamic programming (Ellis 2007) บน log spectral flux
     - semitone spectrogram จากยอดสเปกตรัม + ชดเชย tuning
     - approximate note transcription ด้วย NNLS (แนวคิด Mauch & Dixon 2010) —
       อธิบายฮาร์มอนิกของโน้ตแทนการพับ f/2 f/3 f/4 ที่ทำให้คอร์ดข้างเคียงรั่ว
     - chroma เฉลี่ยตามจังหวะ (ครึ่ง beat) แล้วถอดด้วย HMM ที่รู้คีย์
     - bass แบบรู้ inversion (C/E ไม่กลายเป็น Em) + คอร์ด sus/dim/aug/m7b5 ที่ต้องมีหลักฐานชัด
     ===================================================================== */
  const ENGINE_VERSION = 'device-2';
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /* ---------- onset envelope: log spectral flux (normalize ระดับเสียงก่อน) ---------- */
  async function onsetEnvelope(x, sr, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    const N = sr > 16000 ? 2048 : 1024, hop = N / 4;
    const F = Math.floor((x.length - N) / hop) + 1;
    if (F < 64) return null;
    let e = 0, ne = 0;
    for (let i = 0; i < x.length; i += 5) { e += x[i] * x[i]; ne++; }
    const g = 1 / (Math.sqrt(e / (ne || 1)) || 1);
    const fp = makeFFT(N), win = hann(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const K = Math.min(N / 2, Math.ceil((5000 * N) / sr));
    const kLow = Math.max(2, Math.round((150 * N) / sr));
    let prev = new Float32Array(K), cur = new Float32Array(K);
    const env = new Float32Array(F), low = new Float32Array(F);
    for (let f = 0; f < F; f++) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i] * g; im[i] = 0; }
      fft(fp, re, im);
      let s = 0, sl = 0;
      for (let k = 1; k < K; k++) {
        const m = Math.log(1 + Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        cur[k] = m;
        const d = m - prev[k];
        if (d > 0) { s += d; if (k <= kLow) sl += d; }
      }
      env[f] = f ? s : 0; low[f] = f ? sl : 0;
      const t = prev; prev = cur; cur = t;
      if ((f & 255) === 0) { chk(); onPct(f / F); await tick(); }
    }
    // high-pass (ลบค่าเฉลี่ยเคลื่อนที่ ~0.4s) + half-wave → เหลือเฉพาะจุดที่พุ่งขึ้นจริง
    const fps = sr / hop;
    const hw = Math.max(2, Math.round(0.2 * fps));
    const hpass = (a) => {
      const pre = new Float64Array(F + 1);
      for (let i = 0; i < F; i++) pre[i + 1] = pre[i] + a[i];
      const out = new Float32Array(F);
      let sd = 0;
      for (let i = 0; i < F; i++) {
        const lo = Math.max(0, i - hw), hi = Math.min(F, i + hw + 1);
        const v = a[i] - (pre[hi] - pre[lo]) / (hi - lo);
        out[i] = v > 0 ? v : 0; sd += out[i] * out[i];
      }
      sd = Math.sqrt(sd / F) || 1;
      for (let i = 0; i < F; i++) out[i] /= sd;
      return out;
    };
    // เวลาของเฟรม = กึ่งกลางหน้าต่าง − ครึ่ง hop (flux พุ่งเมื่อ onset ผ่านกลางหน้าต่าง)
    return { env: hpass(env), low: hpass(low), fps, t0: (N / 2 - hop / 2) / sr };
  }

  /* ---------- tempo (autocorrelation + prior) + beat tracking แบบ DP ---------- */
  function trackBeats(on, duration, opts) {
    opts = opts || {};
    const env = on.env, fps = on.fps, F = env.length;
    const bpmMin = 50, bpmMax = 210;
    const lagMin = Math.max(2, Math.floor((60 * fps) / bpmMax));
    const lagMax = Math.min(F - 2, Math.ceil((60 * fps) / bpmMin));
    const acMax = Math.min(F - 2, lagMax * 2 + 2);
    const ac = new Float64Array(acMax + 1);
    for (let lag = 1; lag <= acMax; lag++) {
      let s = 0;
      for (let i = lag; i < F; i++) s += env[i] * env[i - lag];
      ac[lag] = s / (F - lag);
    }
    const center = opts.tempoCenter || 115, sigma = opts.tempoSigma || 0.9;
    let bestLag = lagMin, best = -Infinity;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const bpm = (60 * fps) / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / center) / sigma, 2));
      // โครงสร้างจังหวะ: beat จริงมักมีพลังที่ 2×lag ด้วย (ห้อง/จังหวะคู่)
      const sc = w * (ac[lag] + 0.5 * (ac[2 * lag] || 0) + 0.25 * ((ac[Math.round(lag / 2)] || 0)));
      if (sc > best) { best = sc; bestLag = lag; }
    }
    let period = bestLag;
    if (bestLag > 1 && bestLag < acMax) {
      const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
      const den = a - 2 * b + c;
      if (den < 0) period = bestLag + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    // local score: onset เกลี่ยด้วย gaussian แคบ (σ ≈ period/16 เฟรม)
    const sigmaF = Math.max(1, period / 16);
    const gw = Math.max(1, Math.round(sigmaF * 3));
    const kern = [];
    for (let d = -gw; d <= gw; d++) kern.push(Math.exp(-0.5 * Math.pow(d / sigmaF, 2)));
    const loc = new Float32Array(F);
    let locMax = 0;
    for (let i = 0; i < F; i++) {
      let s = 0;
      for (let d = -gw; d <= gw; d++) { const j = i + d; if (j >= 0 && j < F) s += env[j] * kern[d + gw]; }
      loc[i] = s; if (s > locMax) locMax = s;
    }
    const tight = opts.tightness || 100;
    const lo = Math.max(1, Math.round(period / 2)), hi = Math.max(lo + 1, Math.round(period * 2));
    const pen = new Float64Array(hi + 1);
    for (let d = lo; d <= hi; d++) pen[d] = -tight * Math.pow(Math.log(d / period), 2);
    const cum = new Float64Array(F), back = new Int32Array(F);
    let first = true;
    for (let t = 0; t < F; t++) {
      let bv = -Infinity, bi = -1;
      for (let d = lo; d <= hi; d++) {
        const p = t - d;
        if (p < 0) break;
        const v = cum[p] + pen[d];
        if (v > bv) { bv = v; bi = p; }
      }
      if (bi < 0) { cum[t] = loc[t]; back[t] = -1; continue; }
      cum[t] = loc[t] + bv;
      if (first && loc[t] < 0.01 * locMax) back[t] = -1;
      else { back[t] = bi; first = false; }
    }
    // beat สุดท้าย: local max ของ cumscore ตัวท้ายที่สูงเกินครึ่งของ median
    const maxes = [];
    for (let t = 1; t < F - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxes.push(t);
    let last = F - 1;
    if (maxes.length) {
      const vals = maxes.map((t) => cum[t]).sort((a, b) => a - b);
      const med = vals[vals.length >> 1];
      for (let i = maxes.length - 1; i >= 0; i--) if (cum[maxes[i]] * 2 > med) { last = maxes[i]; break; }
    }
    const idx = [];
    for (let t = last; t >= 0; t = back[t]) { idx.push(t); if (back[t] < 0) break; }
    idx.reverse();
    // ตัด beat หัว/ท้ายที่ onset อ่อนมาก (ช่วงเงียบ)
    let smRms = 0;
    for (let i = 0; i < F; i++) smRms += loc[i] * loc[i];
    const thr = 0.5 * Math.sqrt(smRms / F);
    let a = 0, b = idx.length;
    while (a < b && loc[idx[a]] < thr) a++;
    while (b > a && loc[idx[b - 1]] < thr) b--;
    const beats = idx.slice(a, b).map((i) => on.t0 + i / fps);
    let bpm = (60 * fps) / period;
    if (beats.length > 8) {
      const d = [];
      for (let i = 1; i < beats.length; i++) d.push(beats[i] - beats[i - 1]);
      d.sort((p, q) => p - q);
      bpm = 60 / d[d.length >> 1];
    }
    return { bpm, beats };
  }

  // กริด "ครึ่ง beat" ครอบทั้งเพลง [0, duration] — ต่อหัว/ท้ายด้วยคาบของ beat
  function tatumGrid(beats, bpm, duration, sub) {
    sub = sub || 2;
    const P = 60 / bpm;
    let bs = beats.slice();
    if (bs.length < 2) { bs = []; for (let t = 0; t < duration; t += P) bs.push(t); }
    const pre = [];
    for (let t = bs[0] - P; t > -P * 0.5; t -= P) pre.unshift(Math.max(0, t));
    const post = [];
    for (let t = bs[bs.length - 1] + P; t < duration + P * 0.5; t += P) post.push(t);
    const all = pre.concat(bs, post).filter((t, i, arr) => i === 0 || t > arr[i - 1] + 1e-3);
    const grid = [];
    for (let i = 0; i + 1 < all.length; i++) {
      for (let k = 0; k < sub; k++) grid.push({ t: all[i] + ((all[i + 1] - all[i]) * k) / sub, onBeat: k === 0, beat: i });
    }
    grid.push({ t: all[all.length - 1], onBeat: true, beat: all.length - 1 });
    if (grid[0].t > 0) grid.unshift({ t: 0, onBeat: false, beat: -1 });
    const out = grid.filter((g) => g.t < duration);
    out.push({ t: duration, onBeat: true, beat: -1, end: true });
    return out;
  }

  /* ---------- semitone spectrogram + tuning ---------- */
  const NLO = 32, NHI = 102, NB = NHI - NLO + 1;       // ช่องสเปกตรัม (MIDI G#1..F#7)
  const NOTE_LO = 32, NOTE_HI = 90, NN = NOTE_HI - NOTE_LO + 1; // โน้ตที่ให้ NNLS อธิบาย

  async function noteSpectrogram(x, sr, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    const N = opts.fftN || (sr > 16000 ? 16384 : 8192);
    const HOP = opts.hop || N / 8;
    const F = Math.floor((x.length - N) / HOP) + 1;
    if (F < 8) { const e = new Error('short'); e.code = 'short'; throw e; }
    const fp = makeFFT(N), win = hann(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const binHz = sr / N;
    const kMin = Math.max(2, Math.floor(midiHz(NLO - 0.7) / binHz));
    const kMax = Math.min(N / 2 - 2, Math.ceil(midiHz(NHI + 0.7) / binHz));
    const mag = new Float32Array(kMax + 2);
    const pre = new Float64Array(kMax + 3);
    const AVG_W = 14;
    const framePeaks = new Array(F);
    const rms = new Float32Array(F);
    let tunC = 0, tunS = 0;
    for (let fr = 0; fr < F; fr++) {
      const off = fr * HOP;
      let e = 0;
      for (let i = 0; i < N; i++) { const v = x[off + i] * win[i]; re[i] = v; im[i] = 0; e += v * v; }
      rms[fr] = Math.sqrt(e / N);
      fft(fp, re, im);
      for (let k = kMin - 1; k <= kMax + 1; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      pre[kMin - 1] = 0;
      for (let k = kMin - 1; k <= kMax + 1; k++) pre[k + 1] = pre[k] + mag[k];
      const peaks = [];
      for (let k = kMin; k <= kMax; k++) {
        const m = mag[k];
        if (m <= mag[k - 1] || m < mag[k + 1] || m <= 1e-6) continue;
        const a0 = Math.max(kMin - 1, k - AVG_W), b0 = Math.min(kMax + 1, k + AVG_W);
        const local = (pre[b0 + 1] - pre[a0]) / (b0 - a0 + 1);
        if (m < local * 1.7) continue;
        const am = mag[k - 1], cm = mag[k + 1];
        const den = am - 2 * m + cm;
        const d = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (am - cm) / den)) : 0;
        const midi = 69 + 12 * Math.log2(((k + d) * binHz) / 440);
        peaks.push(midi, m);
        const dev = midi - Math.round(midi), w = Math.sqrt(m);
        tunC += w * Math.cos(2 * Math.PI * dev);
        tunS += w * Math.sin(2 * Math.PI * dev);
      }
      framePeaks[fr] = peaks;
      if ((fr & 31) === 0) { chk(); onPct((fr / F) * 0.9); await tick(); }
    }
    const tuning = Math.atan2(tunS, tunC) / (2 * Math.PI);
    const S = new Float32Array(F * NB);
    for (let fr = 0; fr < F; fr++) {
      const peaks = framePeaks[fr], base = fr * NB;
      for (let i = 0; i < peaks.length; i += 2) {
        const pos = peaks[i] - tuning - NLO;
        if (pos < -0.5 || pos > NB - 0.5) continue;
        const i0 = Math.floor(pos), f = pos - i0, m = peaks[i + 1];
        if (i0 >= 0) S[base + i0] += m * (1 - f);
        if (i0 + 1 < NB) S[base + i0 + 1] += m * f;
      }
      framePeaks[fr] = null;
    }
    onPct(1);
    return { S, F, rms, frameSec: HOP / sr, t0: N / 2 / sr, tuningCents: Math.round(tuning * 100) };
  }

  /* ---------- NNLS: สเปกตรัม = Σ activation × template ฮาร์มอนิกของโน้ต ---------- */
  let nnlsDictCache = null;
  function noteDict(s) {
    if (nnlsDictCache && nnlsDictCache.s === s) return nnlsDictCache;
    const cols = []; // sparse: [idx[], w[]]
    const dense = [];
    for (let n = NOTE_LO; n <= NOTE_HI; n++) {
      const col = new Float64Array(NB);
      for (let h = 1; h <= 24; h++) {
        const p = n + 12 * Math.log2(h) - NLO;
        if (p > NB - 1) break;
        const i0 = Math.floor(p), f = p - i0, a = Math.pow(s, h - 1);
        col[i0] += a * (1 - f);
        if (f > 0 && i0 + 1 < NB) col[i0 + 1] += a * f;
      }
      dense.push(col);
      const idx = [], w = [];
      for (let i = 0; i < NB; i++) if (col[i] > 1e-6) { idx.push(i); w.push(col[i]); }
      cols.push({ idx: Int16Array.from(idx), w: Float64Array.from(w) });
    }
    const G = new Float64Array(NN * NN);
    for (let a = 0; a < NN; a++) {
      for (let b = a; b < NN; b++) {
        let s2 = 0;
        for (let i = 0; i < NB; i++) s2 += dense[a][i] * dense[b][i];
        G[a * NN + b] = s2; G[b * NN + a] = s2;
      }
    }
    nnlsDictCache = { s, cols, G };
    return nnlsDictCache;
  }

  // coordinate-descent NNLS ต่อเฟรม (warm start จากเฟรมก่อน — เพลงต่อเนื่อง ลู่เข้าเร็ว)
  async function nnlsNotes(S, F, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop;
    const { cols, G } = noteDict(opts.shape || 0.7);
    const sweeps = opts.sweeps || 12;
    const A = new Float32Array(F * NN);
    const a = new Float64Array(NN), b = new Float64Array(NN), g = new Float64Array(NN);
    for (let fr = 0; fr < F; fr++) {
      const base = fr * NB;
      let any = 0;
      for (let j = 0; j < NN; j++) {
        const c = cols[j];
        let s = 0;
        for (let k = 0; k < c.idx.length; k++) s += c.w[k] * S[base + c.idx[k]];
        b[j] = s; any += s;
      }
      if (any <= 1e-9) { a.fill(0); continue; }
      // g = G a − b
      for (let j = 0; j < NN; j++) {
        let s = -b[j];
        const row = j * NN;
        for (let k = 0; k < NN; k++) if (a[k]) s += G[row + k] * a[k];
        g[j] = s;
      }
      for (let it = 0; it < sweeps; it++) {
        let moved = 0;
        for (let j = 0; j < NN; j++) {
          const gjj = G[j * NN + j];
          let aj = a[j] - g[j] / gjj;
          if (aj < 0) aj = 0;
          const d = aj - a[j];
          if (d !== 0) {
            a[j] = aj; moved += Math.abs(d);
            for (let k = 0; k < NN; k++) g[k] += d * G[k * NN + j];
          }
        }
        if (moved < 1e-7 * any) break;
      }
      const ob = fr * NN;
      for (let j = 0; j < NN; j++) A[ob + j] = a[j];
      if ((fr & 63) === 0) { chk(); await tick(); }
    }
    return A;
  }

  // activation → chroma (treble) + bass chroma ต่อเฟรม
  function notesToChroma(A, F, opts) {
    opts = opts || {};
    const tre = new Float32Array(F * 12), bas = new Float32Array(F * 12);
    const wT = new Float32Array(NN), wB = new Float32Array(NN);
    const hiStart = opts.treHi || 84, hiW = opts.treHiW || 10;
    const bassTop = opts.bassTop || 47;
    const pw = opts.compress || 1;
    for (let j = 0; j < NN; j++) {
      const n = NOTE_LO + j;
      wT[j] = n < 40 ? 0.5 + 0.5 * ((n - NOTE_LO) / 8) : (n > hiStart ? Math.max(0.2, 1 - (n - hiStart) / hiW) : 1);
      wB[j] = n <= bassTop ? 1 : Math.max(0, 1 - (n - bassTop) / 10);
    }
    for (let f = 0; f < F; f++) {
      const ob = f * NN, cb = f * 12;
      for (let j = 0; j < NN; j++) {
        let v = A[ob + j];
        if (!v) continue;
        if (pw !== 1) v = Math.pow(v, pw);
        const pc = (NOTE_LO + j) % 12;
        tre[cb + pc] += v * wT[j];
        bas[cb + pc] += v * wB[j];
      }
    }
    return { tre, bas };
  }

  // เฉลี่ยฟีเจอร์รายเฟรมลงช่วง grid (เฟรมที่กึ่งกลางอยู่ในช่วง; ไม่มีเลยใช้เฟรมใกล้สุด)
  function syncToGrid(feat, dim, F, frameSec, t0, grid) {
    const T = grid.length - 1;
    const out = new Float32Array(T * dim);
    for (let i = 0; i < T; i++) {
      const a = grid[i].t, b = grid[i + 1].t;
      let f0 = Math.ceil((a - t0) / frameSec), f1 = Math.ceil((b - t0) / frameSec) - 1;
      f0 = Math.max(0, f0); f1 = Math.min(F - 1, f1);
      if (f1 < f0) { const fc = Math.max(0, Math.min(F - 1, Math.round(((a + b) / 2 - t0) / frameSec))); f0 = f1 = fc; }
      const n = f1 - f0 + 1;
      for (let f = f0; f <= f1; f++) for (let k = 0; k < dim; k++) out[i * dim + k] += feat[f * dim + k] / n;
    }
    return out;
  }

  /* ---------- ศัพท์คอร์ด v2 + HMM ---------- */
  // bass: ช่วงเสียงที่ยอมให้อยู่ที่เบส (inversion) + prior ลบ (root ไม่มีโทษ)
  const QV2 = [
    { suf: '',     iv: [0, 4, 7],     w: [1, 1, 0.85],        prior: 0 },
    { suf: 'm',    iv: [0, 3, 7],     w: [1, 1, 0.85],        prior: 0 },
    { suf: '7',    iv: [0, 4, 7, 10], w: [1, 1, 0.8, 0.85],   prior: -0.1 },
    { suf: 'm7',   iv: [0, 3, 7, 10], w: [1, 1, 0.8, 0.85],   prior: -0.1 },
    { suf: 'maj7', iv: [0, 4, 7, 11], w: [1, 1, 0.8, 0.85],   prior: -0.1 },
    { suf: 'sus4', iv: [0, 5, 7],     w: [1, 1, 0.85],        prior: -0.35, ext: true },
    { suf: 'sus2', iv: [0, 2, 7],     w: [1, 1, 0.85],        prior: -0.45, ext: true },
    { suf: 'dim',  iv: [0, 3, 6],     w: [1, 1, 1],           prior: -0.4, ext: true },
    { suf: 'aug',  iv: [0, 4, 8],     w: [1, 1, 1],           prior: -0.5, ext: true },
    { suf: 'm7b5', iv: [0, 3, 6, 10], w: [1, 1, 1, 0.85],     prior: -0.3, ext: true },
  ];

  function buildV2(qualities) {
    const labels = [], tpl = [], meta = [];
    for (let r = 0; r < 12; r++) {
      qualities.forEach((Q, q) => {
        const t = new Float32Array(12);
        Q.iv.forEach((iv, i) => { t[mod12(r + iv)] += Q.w[i]; });
        labels.push(SHARP[r] + Q.suf);
        tpl.push(l2norm(t));
        meta.push({ root: r, q, bassPcs: Q.iv.map((iv) => mod12(r + iv)) });
      });
    }
    return { labels, tpl, meta };
  }

  // diatonic ของคีย์ในรูปชุด (root, suffix) — รวม sus/7sus ของ V และ vii° ของเมเจอร์
  function diatonicV2(key) {
    const set = diatonicLabels(key);
    const m = /^([A-G]#?)(m?)$/.exec(key || '');
    if (!m) return set;
    const r = SHARP.indexOf(m[1]);
    const add = (off, suf) => set.add(SHARP[mod12(r + off)] + suf);
    if (!m[2]) { add(11, 'dim'); add(11, 'm7b5'); add(7, 'sus4'); add(2, 'sus4'); add(0, 'sus4'); add(5, 'sus2'); add(0, 'sus2'); }
    else { add(2, 'dim'); add(2, 'm7b5'); add(7, 'sus4'); add(0, 'sus4'); add(11, 'dim'); }
    return set;
  }

  async function decodeSeq(tre, bas, energy, T, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop;
    const quals = opts.qualities || QV2;
    const { labels, tpl, meta } = buildV2(quals);
    const C = labels.length, S = C + 1;
    const BETA = opts.beta || 4;
    const bassW = opts.bassWeight != null ? opts.bassWeight : 0.3;
    const STAY = opts.stay != null ? opts.stay : 0.8;
    const offPen = opts.offBeatPenalty != null ? opts.offBeatPenalty : 0.4;
    const KEY_BONUS = opts.keyBonus != null ? opts.keyBonus : 0.5;
    const onBeat = opts.onBeat || null; // Uint8Array T: 1 = ช่องนี้เริ่มบน beat
    // น้ำหนักหลักฐานต่อช่อง (≈ จำนวนเฟรมที่เฉลี่ยมา) — ช่องยาวต้องมีน้ำหนักมากกว่า
    // ไม่งั้นโทษการเปลี่ยนคอร์ด (คิดต่อช่อง) จะชนะหลักฐานจนคอร์ดติดกันถูกรวบเป็นคอร์ดเดียว
    const wts = opts.weights || null;
    const ip = opts.invPen != null ? opts.invPen : 0.2;
    const invPen = [0, -ip, -ip * 1.4, -ip * 1.4]; // โทษของ inversion: 3rd / 5th / 7th อยู่ที่เบส
    let maxE = 0;
    for (let i = 0; i < T; i++) if (energy[i] > maxE) maxE = energy[i];
    const silentThr = Math.max(1e-6, maxE * 0.02);
    const sims = new Float32Array(T * S);
    const bassArg = new Uint8Array(T * C); // index ของ iv ที่ชนะที่เบส (0 = root)
    const cn = new Float32Array(12), bn = new Float32Array(12);
    for (let i = 0; i < T; i++) {
      let s = 0, sb = 0;
      for (let k = 0; k < 12; k++) { cn[k] = tre[i * 12 + k]; s += cn[k] * cn[k]; bn[k] = bas[i * 12 + k]; sb += bn[k] * bn[k]; }
      s = Math.sqrt(s); sb = Math.sqrt(sb);
      const silent = energy[i] < silentThr || s < 1e-9;
      const row = i * S;
      if (silent) { sims[row + C] = 0.7; continue; }
      // สัดส่วนพลังเบส: เบสเบามาก (เพลงไม่มีเบส) → ลดน้ำหนักเบสลง
      const bw = sb > 1e-9 ? bassW : 0;
      for (let c = 0; c < C; c++) {
        const t = tpl[c];
        let d = 0;
        for (let k = 0; k < 12; k++) d += (cn[k] / s) * t[k];
        if (bw) {
          const bp = meta[c].bassPcs;
          let bestB = -1, arg = 0;
          const nb = opts.bassInv === false ? 1 : bp.length;
          for (let j = 0; j < nb; j++) {
            const v = bn[bp[j]] / sb + invPen[j];
            if (v > bestB) { bestB = v; arg = j; }
          }
          bassArg[i * C + c] = arg;
          d = (1 - bw) * d + bw * Math.max(0, bestB);
        }
        sims[row + c] = d > 0 ? d : 0;
      }
      sims[row + C] = 0.2;
    }
    const prior = new Float32Array(S);
    for (let c = 0; c < C; c++) prior[c] = quals[meta[c].q].prior;
    const logStay = Math.log(STAY), logSwitch = Math.log((1 - STAY) / (S - 1));
    const bp = new Uint8Array(T * S);
    async function viterbi(bonus) {
      let dpPrev = new Float64Array(S), dpCur = new Float64Array(S);
      const emit = wts
        ? (i, c) => wts[i] * (BETA * Math.log(sims[i * S + c] + 1e-3) + prior[c] + (bonus ? bonus[c] : 0))
        : (i, c) => BETA * Math.log(sims[i * S + c] + 1e-3) + prior[c] + (bonus ? bonus[c] : 0);
      for (let c = 0; c < S; c++) dpPrev[c] = emit(0, c);
      for (let i = 1; i < T; i++) {
        let bi = 0;
        for (let c = 1; c < S; c++) if (dpPrev[c] > dpPrev[bi]) bi = c;
        const sw0 = logSwitch - (onBeat && !onBeat[i] ? offPen : 0);
        const row = i * S;
        for (let c = 0; c < S; c++) {
          let best = dpPrev[c] + logStay, from = c;
          const sw = dpPrev[bi] + sw0;
          if (bi !== c && sw > best) { best = sw; from = bi; }
          dpCur[c] = best + emit(i, c);
          bp[row + c] = from;
        }
        const t = dpPrev; dpPrev = dpCur; dpCur = t;
        if ((i & 511) === 0) { chk(); await tick(); }
      }
      const path = new Uint8Array(T);
      let cur = 0;
      for (let c = 1; c < S; c++) if (dpPrev[c] > dpPrev[cur]) cur = c;
      for (let i = T - 1; i >= 0; i--) { path[i] = cur; cur = bp[i * S + cur]; }
      return path;
    }
    let path = await viterbi(null);
    let key = opts.key || null;
    if (!key && opts.keyFn) key = opts.keyFn(path, labels, C);
    if (key && KEY_BONUS) {
      const dia = diatonicV2(key);
      const bonus = new Float32Array(S);
      for (let c = 0; c < C; c++) if (dia.has(labels[c])) bonus[c] = KEY_BONUS;
      path = await viterbi(bonus);
    }
    let confSum = 0, confN = 0;
    for (let i = 0; i < T; i++) if (path[i] < C) { confSum += sims[i * S + path[i]]; confN++; }
    return { path, labels, meta, C, key, bassArg, confidence: confN ? Math.round((confSum / confN) * 100) / 100 : 0 };
  }

  /* ---------- pipeline เต็ม: เสียง mono → คอร์ด/คีย์/beat ---------- */
  async function analyzeSong(x, sr, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop;
    const stage = opts.onStage || noop; // (stage, frac) — 'beats' | 'chords'
    const duration = x.length / sr;
    const o = Object.assign({}, opts.tune || {});
    const P = (st, a, b) => ({ tick, chk, onPct: (p) => stage(st, a + p * (b - a)) });

    // 1) beat
    const on = await onsetEnvelope(x, sr, P('beats', 0, 0.9));
    let bt = on ? trackBeats(on, duration, o) : { bpm: 100, beats: [] };
    if (!(bt.bpm > 30 && bt.bpm < 260)) bt = { bpm: 100, beats: [] };
    stage('beats', 1);

    // 2) spectrogram → NNLS → chroma
    const hop = o.hop || (duration > 420 ? 2048 : 1024);
    let sp, tre, bas;
    if (o.front === 'v1') {
      const ch = await analyzeChroma(x, sr, Object.assign({ hop, fftN: o.fftN }, P('chords', 0, 0.7)));
      sp = { F: ch.F, rms: ch.rms, frameSec: ch.frameSec, t0: ch.t0, tuningCents: ch.tuningCents };
      tre = ch.chroma; bas = ch.bass;
    } else {
      sp = await noteSpectrogram(x, sr, Object.assign({ hop, fftN: o.fftN }, P('chords', 0, 0.45)));
      chk();
      const A = await nnlsNotes(sp.S, sp.F, Object.assign({ shape: o.shape, sweeps: o.sweeps }, P('chords', 0.45, 0.7)));
      ({ tre, bas } = notesToChroma(A, sp.F, o));
    }
    stage('chords', 0.7);

    // 3) เฉลี่ยตามกริดครึ่ง beat (หรือรายเฟรม ถ้าตั้ง grid:'frame')
    let grid;
    if (o.grid === 'frame') {
      grid = [{ t: 0, onBeat: true }];
      for (let f = 1; f < sp.F; f++) grid.push({ t: sp.t0 + (f - 0.5) * sp.frameSec, onBeat: true });
      grid.push({ t: duration, onBeat: true, end: true });
    } else grid = tatumGrid(bt.beats, bt.bpm, duration, o.grid === 'beat' ? 1 : (o.sub || 2));
    const T = grid.length - 1;
    const tre2 = syncToGrid(tre, 12, sp.F, sp.frameSec, sp.t0, grid);
    const bas2 = syncToGrid(bas, 12, sp.F, sp.frameSec, sp.t0, grid);
    const en2 = syncToGrid(sp.rms, 1, sp.F, sp.frameSec, sp.t0, grid);
    const onBeat = new Uint8Array(T);
    for (let i = 0; i < T; i++) onBeat[i] = grid[i].onBeat ? 1 : 0;
    // น้ำหนักหลักฐาน = ความยาวช่องเทียบเฟรมอ้างอิง ~0.093s (ยกกำลัง durPow: เฉลี่ยแล้ว noise ลด ไม่เป็นอิสระเต็มที่)
    const refSec = o.refSec || 1024 / 11025, dPow = o.durPow != null ? o.durPow : 1;
    const weights = new Float32Array(T);
    for (let i = 0; i < T; i++) weights[i] = Math.pow(Math.max(0.02, grid[i + 1].t - grid[i].t) / refSec, dPow);
    chk(); await tick();

    // 4) HMM 2 รอบ: หา key จากรอบแรก → ให้โบนัสคอร์ดในคีย์
    const keyFn = (path, labels, C) => {
      const segs0 = [];
      for (let i = 0; i < T; i++) {
        const ch = path[i] < C ? labels[path[i]] : null;
        const t0 = grid[i].t, t1 = grid[i + 1].t;
        if (segs0.length && segs0[segs0.length - 1].chord === ch) segs0[segs0.length - 1].t1 = t1;
        else segs0.push({ chord: ch, t0, t1 });
      }
      const k = detectKey(tre2, T);
      return refineKeyWithChords(k, segs0.map((s) => ({ chord: s.chord ? s.chord.replace(/(sus4|sus2|dim|aug|m7b5)$/, (q) => (q === 'dim' || q === 'm7b5' ? 'm' : '')) : null, t0: s.t0, t1: s.t1 })));
    };
    let dec;
    if (o.decoder === 'v1') {
      const d1 = await decodeChords(tre2, bas2, en2, T, Object.assign({ frameSec: T ? duration / T : 0.1, tick, chk }, o.v1 || {}));
      dec = { path: d1.path, labels: d1.labels, C: d1.nChords, key: d1.key, confidence: d1.confidence };
    } else {
      const quals = o.vocab === 'basic' ? QV2.filter((q) => !q.ext) : QV2;
      dec = await decodeSeq(tre2, bas2, en2, T, Object.assign({ onBeat, keyFn, tick, chk, qualities: quals, weights: o.durPow === 0 ? null : weights }, o));
    }
    stage('chords', 0.95);

    // 5) segment (วินาที) + รวมช่วงสั้น
    const raw = [];
    for (let i = 0; i < T; i++) {
      const ch = dec.path[i] < dec.C ? dec.labels[dec.path[i]] : null;
      const t0 = grid[i].t, t1 = grid[i + 1].t;
      if (raw.length && raw[raw.length - 1].chord === ch) raw[raw.length - 1].t1 = t1;
      else raw.push({ chord: ch, t0, t1 });
    }
    const segs = raw;
    stage('chords', 1);
    return {
      engine: ENGINE_VERSION,
      segs, key: dec.key, confidence: dec.confidence, tuningCents: sp.tuningCents,
      bpm: bt.bpm, beats: bt.beats, phase: bt.beats.length ? bt.beats[0] : 0, durationSec: duration,
    };
  }

  return {
    SHARP, QUALITIES, ENGINE_VERSION,
    makeFFT, fft, hann,
    detectTempo, analyzeChroma, decodeChords, toSegments,
    onsetEnvelope, trackBeats, noteSpectrogram, nnlsNotes, notesToChroma, decodeSeq, analyzeSong,
    isolateCenter, prepForASR,
    detectKey, refineKeyWithChords, diatonicLabels,
    gridRows, chordAt, graphemes, cleanChunks, layoutLyricLines,
  };
});
