/* riff.js — แกะลายโซโล่/ริฟฟ์กีตาร์ (เมโลดี้เด่นเส้นเดียว) จากเสียง → โน้ต → สาย/เฟรต → แท็บ
   ใช้ได้ทั้งเบราว์เซอร์ (window.Riff) และ Node (module.exports) — ฟังก์ชันล้วน ไม่แตะ DOM/WebAudio
   ใช้ FFT/hann ของ dsp.js (ต้องโหลด dsp.js ก่อนเรียก extract ในเบราว์เซอร์) · เทสต์: tools/test-riff.cjs

   extract (predominant melody):
   1. STFT hop ~11.6ms หน้าต่าง ~93ms → ยอดสเปกตรัมจริงเท่านั้น (≤40dB ใต้ยอดสูงสุดของเฟรม)
   2. salience แบบ harmonic summation บนกริด log-pitch MIDI 39–89 ละเอียด 0.2 semitone
      ยอดที่ f โหวต + ให้ f/h (h=1..10, น้ำหนัก 0.8^(h−1), กระจาย cos² ±0.8 st) และโหวต − ให้ f/(h−½)
   3. re-score ผู้สมัคร 8 อันดับด้วย (สัดส่วนยอดในช่วงฮาร์มอนิกที่ผู้สมัครอธิบายได้)² และลดน้ำหนัก
      ผู้สมัครที่ไม่มียอดที่ f0 จริง → แก้ผิดออกเทฟ/ฮาร์มอนิกของเสียงสว่าง + กด virtual pitch ของคอร์ด
   4. เก็บแค่ 5 ผู้สมัครต่อเฟรม → RAM ~70 ไบต์/เฟรม (เสียง 10 นาที ≈ 4MB)
   5. Viterbi เลือกเส้นทางต่อเนื่อง (ลงโทษการกระโดดไกล) + สถานะ "ไม่มีเมโลดี้" (voicing)
   6. ตัดเป็นโน้ตตาม pitch ที่เปลี่ยน + onset (spectral flux หน้าต่างสั้น 23ms) — ดีดซ้ำโน้ตเดิมก็แยกได้
   7. [ตัวเลือก] snap เข้ากริด 16th เมื่อรู้ BPM และ onset ลงกริดจริง (กัน BPM ผิดแล้วบิดริฟฟ์)
   assignFrets: DP เลือกสาย/เฟรตแบบมีตำแหน่งมือ (กล่อง 4–5 เฟรต) ให้ขยับมือน้อยสุด
   toAsciiTab: แท็บข้อความ e|B|G|D|A|E — 16th/ช่อง, 4/4, 4 ห้องต่อแถว */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.Riff = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  const STD_TUNING = [40, 45, 50, 55, 59, 64];
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noTick = () => Promise.resolve();
  const noop = () => {};

  function getDSP() {
    if (root && root.DSP && root.DSP.makeFFT) return root.DSP;
    if (typeof require === 'function') {
      try { return require('./dsp.js'); } catch (e) { /* ตกไป throw ข้างล่าง */ }
    }
    throw new Error('riff.js ต้องการ dsp.js (DSP.makeFFT/fft/hann)');
  }

  /* ---------------- พารามิเตอร์ (จูนกับ tools/test-riff.cjs) ---------------- */
  const MIDI_LO = 40, MIDI_HI = 88;   // E2 (สายเปล่าต่ำสุด) … E6 (เฟรต 24 สาย e)
  const G_LO = MIDI_LO - 1;           // กริด salience เผื่อขอบ 1 semitone
  const RES = 0.2;                    // semitone ต่อช่องกริด
  const NB = Math.round((MIDI_HI + 1 - G_LO) / RES) + 1;
  const NH = 10, ALPHA = 0.8;         // จำนวนฮาร์มอนิก + น้ำหนักลดหลั่น
  const SPREAD = 0.8;                 // ครึ่งความกว้างการกระจายโหวต (semitone)
  const SB = SPREAD / RES;            // … เป็นจำนวนช่อง
  const NEG = 0.6;                    // น้ำหนักโหวตลบ (ยอดที่อยู่กึ่งกลางระหว่างฮาร์มอนิกของผู้สมัคร)
  const MAX_PEAKS = 64, PEAK_DB = 40; // KS/ดิสทอร์ชันโน้ตต่ำมีฮาร์มอนิกแรง ~60 ยอด — ตัดเหลือ 24 แล้วผิดออกเทฟ
  const FMIN = 70, FMAX = 5000;
  const K = 5;                        // ผู้สมัคร pitch ต่อเฟรม (เก็บ)
  const K2 = 8;                       // ผู้สมัครก่อน re-score
  const UNEX = 2.0, UNEX_TOL = 0.13;  // เลขชี้กำลังสัดส่วนยอดที่อธิบายได้ / ระยะยอมรับ (หน่วยลำดับฮาร์มอนิก)
  const NO_F0 = 0.5;                  // ตัวคูณเมื่อไม่มียอดที่ f0 ของผู้สมัคร
  // Viterbi
  const THETA = 0.2;                  // salience (เทียบ ref) ต่ำกว่านี้ = ไม่มีเมโลดี้
  const VMAX = 2.5;
  const J0 = 0.6, J1 = 0.05;          // ค่าปรับเปลี่ยนโน้ต: J0 + J1·|Δsemitone|
  const VU = 1.6;                     // ค่าปรับสลับ มีเสียง↔เงียบ
  // ตัดโน้ต
  const MIN_NOTE = 0.06;              // วินาที
  const CONF_MIN = 0.22;
  const ONSET_BIAS = 0.004;           // ชดเชยเวลา onset (วินาที) — เทสต์วัดได้เร็วไป 2–6ms
  const MONO_MIN = 0.28;              // ต่ำกว่านี้ = ไฟล์มีแต่คอร์ด ไม่มีเส้นเมโลดี้เด่น

  const H_OFF = new Float32Array(NH + 1), H_W = new Float32Array(NH + 1);
  const N_OFF = new Float32Array(NH + 1);
  for (let h = 1; h <= NH; h++) {
    H_OFF[h] = 12 * Math.log2(h); H_W[h] = Math.pow(ALPHA, h - 1);
    N_OFF[h] = 12 * Math.log2(h - 0.5); // 0.5f, 1.5f, 2.5f, … ของผู้สมัคร f
  }
  const LUT_N = 100;
  const KERN = new Float32Array(LUT_N + 2);
  for (let i = 0; i <= LUT_N + 1; i++) {
    const d = Math.min(1, i / LUT_N);
    const c = Math.cos((Math.PI / 2) * d);
    KERN[i] = c * c;
  }

  const pow2 = (x) => Math.pow(2, Math.round(Math.log2(Math.max(16, x))));

  // ค่าลำดับที่ k (เริ่ม 0) จากน้อยไปมากใน a[0..n) — quickselect แบบ in-place (สลับลำดับใน a)
  function kthSmallest(a, n, k) {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
    }
    return a[k];
  }

  function percentile(arr, n, q) {
    if (!n) return 0;
    const a = Float32Array.from(arr.subarray ? arr.subarray(0, n) : arr.slice(0, n));
    a.sort();
    return a[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  }

  /* ---------------- ตัววิเคราะห์ต่อเฟรม (บัฟเฟอร์จองครั้งเดียว ใช้ซ้ำทุกเฟรม) ----------------
     frame(data, off, candP, candS, cb) → เขียนผู้สมัคร K ตัวลง candP/candS[cb..cb+K)
     คืน rms ของเฟรม; flux ของ onset อยู่ใน an.flux (เทียบกับเฟรมก่อนหน้าที่เรียก) */
  function makeAnalyzer(sr) {
    const D = getDSP();
    const N = pow2(sr * 0.093);           // 1024 @ 11025
    const NO = pow2(sr * 0.0232);         // 256  (onset)
    const HOP = Math.max(1, Math.round(sr * 0.0116)); // 128
    const fp = D.makeFFT(N), win = D.hann(N);
    const fpo = D.makeFFT(NO), wino = D.hann(NO);
    const re = new Float32Array(N), im = new Float32Array(N);
    const reo = new Float32Array(NO), imo = new Float32Array(NO);
    const binHz = sr / N;
    const k0 = Math.max(2, Math.floor(FMIN / binHz));
    const k1 = Math.min(N / 2 - 2, Math.ceil(Math.min(FMAX, sr * 0.45) / binHz));
    const mag = new Float32Array(N / 2 + 1);
    const ABS_FLOOR = 1e-4 * N;
    const peakDiv = Math.pow(10, -PEAK_DB / 20);
    const half = NO / 2;
    let lmPrev = new Float32Array(half), lmCur = new Float32Array(half);
    let first = true;
    const sal = new Float32Array(NB);
    const PK_CAP = 256;
    const pkF = new Float32Array(PK_CAP), pkA = new Float32Array(PK_CAP);
    const scr = new Float32Array(PK_CAP);
    const oOff = (N - NO) >> 1;
    const c2P = new Float32Array(K2), c2S = new Float32Array(K2);
    const an = { N, NO, HOP, sal, pkF, pkA, nPeaks: 0, flux: 0, frame };

    function frame(data, off, candP, candS, cb) {
      // --- onset: log-magnitude spectral flux หน้าต่างสั้น (กลางเฟรมเดียวกัน) + max filter กัน vibrato
      for (let i = 0; i < NO; i++) { reo[i] = data[off + oOff + i] * wino[i]; imo[i] = 0; }
      D.fft(fpo, reo, imo);
      for (let k = 1; k < half; k++) lmCur[k] = Math.log(1 + Math.sqrt(reo[k] * reo[k] + imo[k] * imo[k]));
      an.flux = 0;
      if (!first) {
        let fl = 0;
        for (let k = 2; k < half - 1; k++) {
          let r = lmPrev[k];
          if (lmPrev[k - 1] > r) r = lmPrev[k - 1];
          if (lmPrev[k + 1] > r) r = lmPrev[k + 1];
          const d = lmCur[k] - r;
          if (d > 0) fl += d;
        }
        an.flux = fl;
      }
      first = false;
      { const tmp = lmPrev; lmPrev = lmCur; lmCur = tmp; }

      // --- pitch frame
      let e = 0;
      for (let i = 0; i < N; i++) { const v = data[off + i] * win[i]; re[i] = v; im[i] = 0; e += v * v; }
      an.nPeaks = 0;
      sal.fill(0);
      for (let j = 0; j < K; j++) { candP[cb + j] = NaN; candS[cb + j] = 0; }
      if (e > 1e-10) {
        D.fft(fp, re, im);
        let mx = 0;
        for (let k = k0 - 1; k <= k1 + 1; k++) {
          const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
          mag[k] = m;
          if (k >= k0 && k <= k1 && m > mx) mx = m;
        }
        const thr = Math.max(mx * peakDiv, ABS_FLOOR);
        let np = 0;
        for (let k = k0; k <= k1 && np < PK_CAP; k++) {
          const m = mag[k];
          if (m < thr || m <= mag[k - 1] || m < mag[k + 1]) continue;
          // log-parabolic interpolation (แม่นกับหน้าต่าง Hann)
          const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m), c = Math.log(mag[k + 1] + 1e-12);
          const den = a - 2 * b + c;
          let d = den < 0 ? 0.5 * (a - c) / den : 0;
          if (d > 0.5) d = 0.5; else if (d < -0.5) d = -0.5;
          pkF[np] = (k + d) * binHz;
          pkA[np] = Math.exp(b - 0.25 * (a - c) * d);
          np++;
        }
        let use = np;
        if (np > MAX_PEAKS) {
          // เก็บ MAX_PEAKS ยอดที่แรงสุด — quickselect บนบัฟเฟอร์จองไว้ (ไม่จองหน่วยความจำต่อเฟรม → ไม่มี GC กระตุก)
          for (let i = 0; i < np; i++) scr[i] = pkA[i];
          const cut = kthSmallest(scr, np, np - MAX_PEAKS);
          let w = 0;
          for (let i = 0; i < np && w < MAX_PEAKS; i++) {
            if (pkA[i] >= cut) { pkF[w] = pkF[i]; pkA[w] = pkA[i]; w++; }
          }
          use = w;
        }
        an.nPeaks = use;
        // --- harmonic summation salience + หลักฐานลบแบบ SWIPE:
        // ยอดที่ f โหวต + ให้ f/h และโหวต − ให้ f/(h−½) — ผู้สมัครที่เป็นฮาร์มอนิกของโน้ตจริง
        // (2f0, 3f0, …) จะมียอดจริงตกช่องลบ จึงแพ้ f0 แม้เสียงสว่าง/ดิสทอร์ชันฮาร์มอนิกแบนเท่ากัน
        for (let p = 0; p < use; p++) {
          const pm = 69 + 12 * Math.log2(pkF[p] / 440);
          const amp = pkA[p];
          for (let h = 1; h <= NH; h++) {
            const w = amp * H_W[h];
            for (let sgn = 0; sgn < 2; sgn++) {
              const cpos = pm - (sgn ? N_OFF[h] : H_OFF[h]);
              if (cpos < G_LO - SPREAD) continue;
              const x = (cpos - G_LO) / RES;
              if (x - SB > NB - 1) continue;
              const ww = sgn ? -NEG * w : w;
              const bA = Math.max(0, Math.ceil(x - SB)), bB = Math.min(NB - 1, Math.floor(x + SB));
              for (let bb = bA; bb <= bB; bb++) {
                const dd = Math.abs(bb - x) / SB;
                sal[bb] += ww * KERN[(dd * LUT_N + 0.5) | 0];
              }
            }
            if (pm - H_OFF[h] < G_LO - SPREAD) break;
          }
        }
        // --- local maxima ของ salience → K2 อันดับแรก (parabolic refine)
        let n2 = 0;
        for (let bb = 1; bb < NB - 1; bb++) {
          const v = sal[bb];
          if (v <= 0 || v < sal[bb - 1] || v <= sal[bb + 1]) continue;
          const sa = sal[bb - 1], sc = sal[bb + 1];
          const den = sa - 2 * v + sc;
          let d = den < 0 ? 0.5 * (sa - sc) / den : 0;
          if (d > 0.5) d = 0.5; else if (d < -0.5) d = -0.5;
          const pitch = G_LO + (bb + d) * RES;
          if (pitch < MIDI_LO - 0.5 || pitch > MIDI_HI + 0.5) continue;
          const val = v - 0.25 * (sa - sc) * d;
          if (n2 === K2 && val <= c2S[K2 - 1]) continue;
          let j = n2 < K2 ? n2++ : K2 - 1;
          while (j > 0 && c2S[j - 1] < val) { c2S[j] = c2S[j - 1]; c2P[j] = c2P[j - 1]; j--; }
          c2S[j] = val; c2P[j] = pitch;
        }
        // --- re-score: คูณด้วย (สัดส่วนยอดที่ผู้สมัคร "อธิบายได้" ในช่วงฮาร์มอนิกของตัวเอง)^UNEX
        // f0 จริงอธิบายได้ทุกยอดของโน้ต แต่ k·f0 อธิบายได้แค่ ~1/k → แก้ octave/ฮาร์มอนิกผิดของเสียงสว่าง
        // (กีตาร์ดิสทอร์ชันที่ฮาร์มอนิกสูงแรงพอ ๆ กับ f0) และกดโน้ตของเครื่องดนตรีประกอบที่เบากว่าลีด
        // (มียอดของลีดเป็น "อธิบายไม่ได้" เยอะ) — เคยลองแบบเทียบเป็นคู่ F กับ F/k แล้วมิกซ์แย่ลงชัด
        let nc = 0;
        for (let c = 0; c < n2; c++) {
          const f0 = 440 * Math.pow(2, (c2P[c] - 69) / 12);
          let un = 0, ex = 0, hasF0 = false;
          for (let p = 0; p < use; p++) {
            const r = pkF[p] / f0;
            if (r < 0.75 || r > NH + 0.5) continue;
            const hr = Math.round(r);
            const w = pkA[p] * H_W[hr < 1 ? 1 : hr];
            if (hr >= 1 && Math.abs(r - hr) < UNEX_TOL) { ex += w; if (hr === 1) hasF0 = true; } else un += w;
          }
          const frac = ex / (ex + un + 1e-9);
          // ไม่มียอดที่ f0 เลย = มักเป็น virtual pitch (รากของคอร์ดที่เสียงประกอบสร้างขึ้น) → ลดน้ำหนัก
          const val = c2S[c] * Math.pow(frac, UNEX) * (hasF0 ? 1 : NO_F0);
          if (val <= 0) continue;
          if (nc === K && val <= candS[cb + K - 1]) continue;
          let j = nc < K ? nc++ : K - 1;
          while (j > 0 && candS[cb + j - 1] < val) {
            candS[cb + j] = candS[cb + j - 1]; candP[cb + j] = candP[cb + j - 1]; j--;
          }
          candS[cb + j] = val; candP[cb + j] = c2P[c];
        }
      }
      return Math.sqrt(e / N);
    }
    return an;
  }

  /* ================= extract: เสียง → โน้ต ================= */
  async function extract(data, sr, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    const an = makeAnalyzer(sr);
    const { N, HOP } = an;
    const hopSec = HOP / sr;
    const F = data && data.length >= N ? Math.floor((data.length - N) / HOP) + 1 : 0;
    const empty = { notes: [], voicedRatio: 0, monoRatio: 0, tuningCents: 0, grid: null };
    if (F < 16) { onPct(1); return empty; }
    const tc = (t) => (t * HOP + N / 2) / sr; // เวลากลางเฟรม

    const candP = new Float32Array(F * K);
    const candS = new Float32Array(F * K);
    const rmsA = new Float32Array(F);
    const flux = new Float32Array(F);
    for (let t = 0; t < F; t++) {
      rmsA[t] = an.frame(data, t * HOP, candP, candS, t * K);
      flux[t] = an.flux;
      if ((t & 63) === 0) { chk(); onPct(0.8 * (t / F)); await tick(); }
    }
    chk(); onPct(0.8);

    /* ---------- normalize: เทียบ salience กับระดับเมโลดี้ทั้งเพลง ---------- */
    const rmsRef = percentile(rmsA, F, 0.95);
    const silentThr = Math.max(1e-5, rmsRef * 0.02);
    const top = new Float32Array(F);
    let nTop = 0;
    for (let t = 0; t < F; t++) if (rmsA[t] >= silentThr && candS[t * K] > 0) top[nTop++] = candS[t * K];
    const ref = nTop >= 8 ? percentile(top, nTop, 0.97) : 0;
    if (!(ref > 0)) { onPct(1); return empty; }

    /* ---------- Viterbi: K ผู้สมัคร + สถานะเงียบ ---------- */
    const S = K + 1, U = K;
    const lnTheta = Math.log(THETA);
    const bp = new Uint8Array(F * S);
    let prev = new Float64Array(S), cur = new Float64Array(S);
    const em = new Float64Array(S);
    const emis = (t) => {
      const silent = rmsA[t] < silentThr;
      for (let j = 0; j < K; j++) {
        const p = candP[t * K + j];
        if (silent || p !== p) { em[j] = -1e9; continue; }
        const v = candS[t * K + j] / ref;
        em[j] = Math.log(Math.min(VMAX, Math.max(1e-3, v)));
      }
      em[U] = lnTheta;
    };
    emis(0);
    for (let j = 0; j < S; j++) prev[j] = em[j];
    for (let t = 1; t < F; t++) {
      emis(t);
      const pb = (t - 1) * K, cbase = t * K;
      for (let j = 0; j < S; j++) {
        let best = -Infinity, arg = 0;
        const pj = j < K ? candP[cbase + j] : NaN;
        for (let i = 0; i < S; i++) {
          let v = prev[i];
          if (i === U && j === U) { /* อยู่เงียบ */ }
          else if (i === U || j === U) v -= VU;
          else {
            const d = Math.abs(candP[pb + i] - pj);
            if (d > 0.6) v -= J0 + J1 * (d < 24 ? d : 24);
          }
          if (v > best) { best = v; arg = i; }
        }
        cur[j] = best + em[j];
        bp[t * S + j] = arg;
      }
      const tmp = prev; prev = cur; cur = tmp;
      if ((t & 2047) === 0) { chk(); onPct(0.8 + 0.1 * (t / F)); await tick(); }
    }
    const pitch = new Float32Array(F).fill(NaN);
    const vArr = new Float32Array(F);
    // poly = ผู้สมัครแรงสุดที่ "ไม่ใช่" ออกเทฟ/ฮาร์มอนิกของเส้นที่เลือก ÷ เส้นที่เลือก
    // เมโลดี้เดี่ยว ≈ 0 · คอร์ด (โน้ตหลายตัวแรงพอกัน) ≈ 0.5–1 → ใช้ตัดโน้ตขยะในท่อนที่มีแต่คอร์ด
    const poly = new Float32Array(F);
    {
      let s = 0;
      for (let j = 1; j < S; j++) if (prev[j] > prev[s]) s = j;
      for (let t = F - 1; t >= 0; t--) {
        if (s < K && candP[t * K + s] === candP[t * K + s]) {
          const cb = t * K, p0 = candP[cb + s], s0 = candS[cb + s];
          pitch[t] = p0; vArr[t] = s0 / ref;
          let rival = 0;
          for (let j = 0; j < K; j++) {
            const pj = candP[cb + j];
            if (j === s || pj !== pj || candS[cb + j] <= rival) continue;
            const d = Math.abs(pj - p0);
            let related = d < 0.6;
            for (let h = 2; h <= 6 && !related; h++) if (Math.abs(d - H_OFF[h]) < 0.5) related = true;
            if (!related) rival = candS[cb + j];
          }
          poly[t] = s0 > 0 ? rival / s0 : 1;
        }
        s = bp[t * S + s];
      }
    }
    chk(); onPct(0.92); await tick();

    /* ---------- tuning ทั้งเพลง (เพลงจูนไม่ตรง A440) ---------- */
    let tc_ = 0, ts_ = 0;
    for (let t = 0; t < F; t++) {
      const p = pitch[t];
      if (p !== p) continue;
      const w = Math.min(1, vArr[t]);
      const dev = p - Math.round(p);
      tc_ += w * Math.cos(2 * Math.PI * dev); ts_ += w * Math.sin(2 * Math.PI * dev);
    }
    const tune = (tc_ || ts_) ? Math.atan2(ts_, tc_) / (2 * Math.PI) : 0;

    /* ---------- onset peaks ---------- */
    const { onset, sm: onsetEnv } = pickOnsets(flux, F, hopSec);
    chk(); onPct(0.94); await tick();

    /* ---------- runs ของ pitch (หลัง quantize เป็น semitone) ---------- */
    const q = new Int16Array(F);
    for (let t = 0; t < F; t++) q[t] = pitch[t] === pitch[t] ? Math.round(pitch[t] - tune) : -1;
    let runs = toRuns(q, F);
    runs = cleanRuns(runs, Math.max(3, Math.round(0.045 / hopSec)), Math.max(2, Math.round(0.035 / hopSec)));
    chk(); onPct(0.96); await tick();

    /* ---------- ตัดเป็นโน้ต (แยกตาม onset ภายในโน้ตเดียวกัน) ---------- */
    const minSplit = Math.max(3, Math.round(0.05 / hopSec));
    const snapW0 = Math.round(0.07 / hopSec), snapW1 = Math.round(0.035 / hopSec);
    const rawNotes = [];
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      if (run.q < 0) continue;
      // จุดแยก: onset ที่ salience ของโน้ตนี้พุ่งขึ้นจริง (กันเสียงประกอบ/กลองมาแยกโน้ตยาว)
      const cuts = [run.a];
      for (let t = run.a + minSplit; t <= run.b - minSplit; t++) {
        if (!onset[t] || t - cuts[cuts.length - 1] < minSplit) continue;
        let before = Infinity, after = 0;
        for (let u = Math.max(run.a, t - 4); u <= t; u++) before = Math.min(before, vArr[u]);
        for (let u = t; u < Math.min(run.b, t + 6); u++) after = Math.max(after, vArr[u]);
        if (after > before * 1.12) cuts.push(t);
      }
      cuts.push(run.b);
      for (let c = 0; c + 1 < cuts.length; c++) {
        rawNotes.push({ a: cuts[c], b: cuts[c + 1], split: c > 0, legato: c === 0 && r > 0 && runs[r - 1].q >= 0 });
      }
    }
    // เวลาเริ่ม: snap หา onset ใกล้สุด (pitch เปลี่ยนช้ากว่าการดีดจริงเพราะหน้าต่างยาว)
    const notes = [];
    let voicedFrames = 0;
    for (let i = 0; i < rawNotes.length; i++) {
      const rn = rawNotes[i];
      let sf = rn.a, hasOnset = rn.split;
      if (!rn.split) {
        let best = -1, bd = Infinity;
        for (let u = Math.max(0, rn.a - snapW0); u <= Math.min(F - 1, rn.a + snapW1); u++) {
          if (onset[u] && Math.abs(u - rn.a) < bd) { bd = Math.abs(u - rn.a); best = u; }
        }
        if (best >= 0) { sf = best; hasOnset = true; }
      }
      // pitch = median ของเฟรมในโน้ต (หลังชดเชยจูน), conf = salience เฉลี่ย (ตัดที่ 1)
      const ps = [], pl = [];
      let cs = 0;
      for (let t = rn.a; t < rn.b; t++) {
        if (pitch[t] === pitch[t]) { ps.push(pitch[t] - tune); pl.push(poly[t]); }
        cs += Math.min(1, vArr[t]);
      }
      if (!ps.length) continue;
      ps.sort((x, y) => x - y);
      pl.sort((x, y) => x - y);
      const midi = Math.round(ps[ps.length >> 1]);
      const conf = cs / (rn.b - rn.a);
      const t0 = Math.max(0, tc(sf) - hopSec / 2 + ONSET_BIAS);
      const t1 = tc(rn.b - 1) + hopSec / 2;
      notes.push({ t: t0, e: t1, midi, conf, hasOnset, legato: rn.legato, fr: rn.b - rn.a, poly: pl[pl.length >> 1] });
    }
    chk(); onPct(0.97); await tick();
    // โน้ตที่ snap ถอยไปทับโน้ตก่อนหน้า → ตัดท้ายโน้ตก่อนหน้า
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].t < notes[i - 1].e) notes[i - 1].e = notes[i].t;
    }
    // legato จริง (hammer-on/pull-off/slide) = ติดกับโน้ตก่อน + ขยับไม่เกิน 5 semitone + ดังใกล้เคียงกัน
    // ไม่งั้นมักเป็นเสียงประกอบที่โผล่ขึ้นมาตอนลีดหางเสียงหมด
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i], p = notes[i - 1];
      if (n.legato) n.legato = !!p && Math.abs(p.midi - n.midi) <= 5 && n.conf >= 0.5 * p.conf;
    }
    // ทั้งไฟล์มีเส้นเมโลดี้เด่นจริงไหม: สัดส่วนเฟรมที่เลือกเส้นแล้วไม่มีคู่แข่งที่ไม่สัมพันธ์กัน
    // ไฟล์มีโซโล่/ริฟฟ์/เสียงร้อง ≥ ~0.37 · คอร์ดล้วน (pad, ดีดคอร์ด) ≤ ~0.2 (วัดใน test-riff)
    let vf = 0, mf = 0;
    for (let t = 0; t < F; t++) if (pitch[t] === pitch[t]) { vf++; if (poly[t] < 0.25) mf++; }
    const monoRatio = vf ? mf / vf : 0;
    const chordal = monoRatio < MONO_MIN;
    // กรอง: สั้นเกิน / salience ต่ำ / โน้ตลอย (ไม่มีการดีดและไม่ใช่ legato = มักเป็นเสียงประกอบช่วงพัก)
    // ไฟล์ที่มีแต่คอร์ด → เก็บเฉพาะโน้ตที่ไม่มีคู่แข่งเลย (ไม่ตัดทิ้งหมด กันโซโล่ reverb หนักหายเกลี้ยง)
    let out = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const d = n.e - n.t;
      if (d < MIN_NOTE || n.conf < CONF_MIN) continue;
      if (!n.hasOnset && !n.legato && n.conf < 0.45) continue;
      if (chordal && !(n.poly < 0.2)) continue;
      out.push(n);
    }
    // รวมโน้ตเดียวกันที่ห่างกันนิดเดียวและไม่มีการดีดใหม่
    const merged = [];
    for (const n of out) {
      const p = merged[merged.length - 1];
      if (p && p.midi === n.midi && n.t - p.e < 0.04 && !n.hasOnset) {
        p.conf = (p.conf * p.fr + n.conf * n.fr) / (p.fr + n.fr); p.fr += n.fr; p.e = n.e;
        continue;
      }
      merged.push(n);
    }
    // legato: ช่องว่างจิ๋วระหว่างโน้ต → ต่อความยาวโน้ตก่อนหน้า
    for (let i = 0; i + 1 < merged.length; i++) {
      const g = merged[i + 1].t - merged[i].e;
      if (g > 0 && g < 0.04) merged[i].e = merged[i + 1].t;
    }
    out = merged.map((n) => {
      voicedFrames += n.fr;
      return { t: r3(n.t), d: r3(n.e - n.t), midi: n.midi, conf: Math.round(n.conf * 100) / 100 };
    });

    /* ---------- [ตัวเลือก] quantize เข้ากริด 16th ---------- */
    let grid = null;
    if (+opts.bpm > 0 && out.length >= 4) {
      chk(); onPct(0.98); await tick();
      grid = fitGrid(out, +opts.bpm, +opts.phase || 0, { env: onsetEnv, F, N, HOP, sr });
      if (grid) out = quantize(out, grid);
    }
    onPct(1);
    return {
      notes: out,
      voicedRatio: Math.round((voicedFrames / F) * 1000) / 1000,
      monoRatio: Math.round(monoRatio * 100) / 100,
      tuningCents: Math.round(tune * 100),
      grid,
    };
  }

  const r3 = (x) => Math.round(x * 1000) / 1000;

  // onset = ยอด flux ที่เด่นกว่าค่าเฉลี่ยรอบข้าง (SuperFlux-style peak picking)
  function pickOnsets(flux, F, hopSec) {
    const sm = new Float32Array(F);
    for (let t = 0; t < F; t++) {
      const a = flux[Math.max(0, t - 1)], b = flux[t], c = flux[Math.min(F - 1, t + 1)];
      sm[t] = 0.25 * a + 0.5 * b + 0.25 * c;
    }
    const norm = percentile(sm, F, 0.99) || 1;
    for (let t = 0; t < F; t++) sm[t] /= norm;
    const onset = new Uint8Array(F);
    const preMax = 3, postMax = 3;
    const preAvg = Math.round(0.12 / hopSec), postAvg = Math.round(0.05 / hopSec);
    const minGap = Math.max(2, Math.round(0.045 / hopSec));
    let last = -1e9;
    // ผลรวมสะสมสำหรับค่าเฉลี่ยเคลื่อนที่
    const cs = new Float64Array(F + 1);
    for (let t = 0; t < F; t++) cs[t + 1] = cs[t] + sm[t];
    for (let t = 1; t < F - 1; t++) {
      const v = sm[t];
      if (v < 0.08) continue;
      let isMax = true;
      for (let u = Math.max(0, t - preMax); u <= Math.min(F - 1, t + postMax); u++) {
        if (sm[u] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      const a = Math.max(0, t - preAvg), b = Math.min(F, t + postAvg + 1);
      const mean = (cs[b] - cs[a]) / (b - a);
      if (v < mean * 1.25 + 0.05) continue;
      if (t - last < minGap) continue;
      onset[t] = 1; last = t;
    }
    return { onset, sm };
  }

  function toRuns(q, F) {
    const runs = [];
    for (let t = 0; t < F; t++) {
      const r = runs[runs.length - 1];
      if (r && r.q === q[t]) r.b = t + 1;
      else runs.push({ q: q[t], a: t, b: t + 1 });
    }
    return runs;
  }

  // เกลี่ย run: เติมช่องเงียบสั้นระหว่างโน้ตเดียวกัน + กลืน run สั้น (pitch แกว่งตอนเปลี่ยนโน้ต)
  function cleanRuns(runs, minRun, gapFill) {
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      // 1) ช่องเงียบสั้นคั่นโน้ตเดียวกัน → เติม
      for (let i = 1; i + 1 < runs.length; i++) {
        const r = runs[i];
        if (r.q < 0 && r.b - r.a < gapFill && runs[i - 1].q >= 0 && runs[i - 1].q === runs[i + 1].q) {
          r.q = runs[i - 1].q; changed = true;
        }
      }
      // 2) run มีเสียงที่สั้นเกิน → รวมกับเพื่อนบ้านที่ติดกันและ pitch ใกล้สุด (ไม่มี = เงียบ)
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.q < 0 || r.b - r.a >= minRun) continue;
        const L = i > 0 ? runs[i - 1] : null, R = i + 1 < runs.length ? runs[i + 1] : null;
        const dl = L && L.q >= 0 ? Math.abs(L.q - r.q) : Infinity;
        const dr = R && R.q >= 0 ? Math.abs(R.q - r.q) : Infinity;
        if (dl === Infinity && dr === Infinity) r.q = -1;
        else if (dl < dr || (dl === dr && (L.b - L.a) >= (R.b - R.a))) r.q = L.q;
        else r.q = R.q;
        changed = true;
      }
      // รวม run ที่ q เท่ากันติดกัน
      const m = [];
      for (const r of runs) {
        const p = m[m.length - 1];
        if (p && p.q === r.q) p.b = r.b; else m.push({ q: r.q, a: r.a, b: r.b });
      }
      runs = m;
      if (!changed) break;
    }
    return runs;
  }

  /* กริด 16th:
     1. phase ของกริด 16th จาก onset ของโน้ตเอง (circular mean) — snap เฉพาะเมื่อ onset กระจุกบนกริด
        จริง (R ≥ 0.5) ถ้า BPM ผิด (ครึ่ง/ไม่ตรง) หรือเล่นอิสระ R จะต่ำ → ไม่ snap (คืน null)
     2. 16th ไหนคือ "บนจังหวะ": พับ onset envelope (hop ~12ms) ลงคาบ beat แล้วดูตำแหน่งที่หนักสุด
        (กลอง/เบส/การเน้นจังหวะ) — ใช้ phase จาก DSP.detectTempo แค่เป็นตัวสำรองตอนหลักฐานไม่ชัด
        เพราะ phase นั้นวัดที่ต้นเฟรม 2048 จุด (เร็วกว่าจังหวะจริง ~0.1s ≈ ครึ่งหน้าต่าง) */
  function gridFit(notes, step) {
    let C = 0, Sn = 0, W = 0;
    for (const n of notes) {
      const w = Math.max(0.05, n.conf);
      const a = (2 * Math.PI * n.t) / step;
      C += w * Math.cos(a); Sn += w * Math.sin(a); W += w;
    }
    return { R: Math.sqrt(C * C + Sn * Sn) / (W || 1), phi: (Math.atan2(Sn, C) / (2 * Math.PI)) * step };
  }

  function fitGrid(notes, bpm0, beatPhase, ctx) {
    // BPM จากตัวจับจังหวะคลาดได้ ~1% → สะสมเป็นหลายสิบ ms ในริฟฟ์ยาว: ไล่คาบละเอียด ±2% หา R สูงสุด
    let best = null, bpm = bpm0;
    for (let i = -20; i <= 20; i++) {
      const b = bpm0 * (1 + i * 0.001);
      const g = gridFit(notes, 60 / b / 4);
      if (!best || g.R > best.R + 1e-9 || (Math.abs(g.R - best.R) <= 1e-9 && Math.abs(i) < Math.abs(best.i))) {
        best = { R: g.R, phi: g.phi, i }; bpm = b;
      }
    }
    const step = 60 / bpm / 4, beat = step * 4;
    const R = best.R, phi = best.phi;
    if (R < 0.5) return null;
    let off = -1, beatFrom = 'tempo';
    if (ctx && ctx.env) {
      const { env, F, N, HOP, sr } = ctx;
      const tA = notes[0].t - beat, tB = notes[notes.length - 1].t + beat;
      const sc = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        let s = 0, n = 0;
        const base = phi + k * step;
        for (let m = Math.ceil((tA - base) / beat); base + m * beat <= tB; m++) {
          const f = Math.round(((base + m * beat) * sr - N / 2) / HOP);
          if (f < 1 || f >= F - 1) continue;
          s += Math.max(env[f - 1], env[f], env[f + 1]); n++;
        }
        sc[k] = n ? s / n : 0;
      }
      const order = [0, 1, 2, 3].sort((x, y) => sc[y] - sc[x]);
      if (sc[order[0]] > 1.15 * sc[order[1]]) { off = order[0]; beatFrom = 'onset'; }
    }
    let origin;
    if (off >= 0) {
      const b0 = phi + off * step;
      origin = b0 + Math.round((beatPhase - b0) / beat) * beat; // จังหวะเดียวกับชีตคอร์ด (ใกล้สุด)
    } else {
      origin = phi + Math.round((beatPhase - phi) / step) * step;
    }
    return { bpm, step, phase: Math.round(origin * 1000) / 1000, R: Math.round(R * 100) / 100, beatFrom };
  }

  function quantize(notes, grid) {
    const step = grid.step, origin = grid.phase;
    const out = [];
    for (const n of notes) {
      const k = Math.round((n.t - origin) / step);
      const len = Math.max(1, Math.round(n.d / step));
      const p = out[out.length - 1];
      if (p && p._k === k) {
        // ตกช่องเดียวกัน → เก็บตัวที่เด่นกว่า
        if (n.conf * n.d > p.conf * p._d) out[out.length - 1] = { _k: k, _len: len, _d: n.d, midi: n.midi, conf: n.conf };
        continue;
      }
      out.push({ _k: k, _len: len, _d: n.d, midi: n.midi, conf: n.conf });
    }
    for (let i = 0; i < out.length; i++) {
      const nx = out[i + 1];
      if (nx && out[i]._k + out[i]._len > nx._k) out[i]._len = Math.max(1, nx._k - out[i]._k);
    }
    return out.map((n) => ({
      t: r3(origin + n._k * step), d: r3(n._len * step), midi: n.midi, conf: n.conf,
    }));
  }

  /* ================= assignFrets: โน้ต → สาย/เฟรต ================= */
  /* state = (สาย, เฟรต, ตำแหน่งมือ h = เฟรตนิ้วชี้) — เฟรตที่กดต้องอยู่ใน h..h+3 (h+4 = ยืดนิ้วก้อย)
     สายเปล่าเล่นได้ทุกตำแหน่งมือ · ค่าปรับ: ย้ายมือ (แพงขึ้นเมื่อโน้ตถี่), ข้ามสาย, เฟรต > 12 */
  function assignFrets(notes, opts) {
    opts = opts || {};
    const tuning = Array.isArray(opts.tuning) && opts.tuning.length === 6 ? opts.tuning.map(Number) : STD_TUNING;
    const capo = Math.max(0, Math.min(12, Math.round(+opts.capo || 0)));
    const maxRel = Math.max(5, (opts.maxFret != null ? +opts.maxFret : 20) - capo);
    const open = tuning.map((x) => x + capo);
    const lo = Math.min.apply(null, open), hi = Math.max.apply(null, open) + maxRel;
    const HMAX = Math.max(1, maxRel - 3);
    const list = (notes || []).filter((n) => n && isFinite(n.midi));
    const n = list.length;
    if (!n) return [];

    const states = new Array(n);
    for (let i = 0; i < n; i++) {
      let m = Math.round(list[i].midi), oct = 0;
      while (m < lo) { m += 12; oct++; }
      while (m > hi) { m -= 12; oct--; }
      const st = { s: [], f: [], h: [], c: [], oct };
      for (let s = 0; s < 6; s++) {
        const f = m - open[s];
        if (f < 0 || f > maxRel) continue;
        if (f === 0) {
          for (let h = 1; h <= HMAX; h++) { st.s.push(s); st.f.push(0); st.h.push(h); st.c.push(0.05 + 0.01 * h); }
        } else {
          for (let h = Math.max(1, f - 4); h <= Math.min(f, HMAX); h++) {
            let c = 0.01 * h;
            if (f > 12) c += 0.2 * (f - 12);
            if (f - h === 4) c += 0.5;
            st.s.push(s); st.f.push(f); st.h.push(h); st.c.push(c);
          }
        }
      }
      if (!st.s.length) { // จูนแปลก ๆ มีช่องโหว่ → วางสายที่ใกล้สุด
        let bs = 0, bf = Infinity;
        for (let s = 0; s < 6; s++) {
          const f = Math.max(0, Math.min(maxRel, m - open[s]));
          if (Math.abs(m - open[s] - f) < bf) { bf = Math.abs(m - open[s] - f); bs = s; }
        }
        const f = Math.max(0, Math.min(maxRel, m - open[bs]));
        st.s.push(bs); st.f.push(f); st.h.push(Math.max(1, Math.min(HMAX, f || 1))); st.c.push(5);
      }
      states[i] = st;
    }

    let dp = Float64Array.from(states[0].c);
    const back = new Array(n);
    for (let i = 1; i < n; i++) {
      const A = states[i - 1], B = states[i];
      const ioi = Math.max(0, (+list[i].t || 0) - (+list[i - 1].t || 0));
      const speed = ioi < 0.18 ? 1.5 : ioi < 0.35 ? 1 : ioi < 1 ? 0.6 : 0.3;
      const nd = new Float64Array(B.s.length);
      const bk = new Int32Array(B.s.length);
      for (let b = 0; b < B.s.length; b++) {
        let best = Infinity, arg = 0;
        for (let a = 0; a < A.s.length; a++) {
          let c = dp[a];
          const dh = Math.abs(B.h[b] - A.h[a]);
          if (dh) c += (0.6 + 0.25 * dh) * speed;
          const ds = Math.abs(B.s[b] - A.s[a]);
          if (ds > 1) c += 0.15 * (ds - 1);
          if (c < best) { best = c; arg = a; }
        }
        nd[b] = best + B.c[b];
        bk[b] = arg;
      }
      dp = nd; back[i] = bk;
    }
    let cur = 0;
    for (let b = 1; b < dp.length; b++) if (dp[b] < dp[cur]) cur = b;
    const pick = new Int32Array(n);
    for (let i = n - 1; i >= 0; i--) { pick[i] = cur; if (i > 0) cur = back[i][cur]; }
    return list.map((note, i) => {
      const st = states[i], k = pick[i];
      const o = Object.assign({}, note, { s: st.s[k], f: st.f[k] });
      if (st.oct) o.oct = st.oct; else delete o.oct;
      return o;
    });
  }

  /* ================= toAsciiTab: แท็บข้อความสำหรับคัดลอก/ส่งออก ================= */
  function stringNames(tuning) {
    const nm = tuning.map((m) => NAMES[((Math.round(m) % 12) + 12) % 12]);
    if (nm[5] === nm[0]) nm[5] = nm[5].toLowerCase(); // e บน vs E ล่าง
    return nm;
  }

  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // phase ของกริดจากโน้ตเอง: กริด 16th = circular mean ของ onset, beat = ตำแหน่ง 16th ที่โน้ต
  // (ถ่วงด้วยความยาว) ตกบ่อยสุด — ใช้เมื่อผู้เรียกไม่มี phase จาก extract
  function inferPhase(notes, step) {
    if (!notes.length) return 0;
    const g = gridFit(notes.map((n) => ({ t: n.t, conf: 1 })), step);
    const sc = [0, 0, 0, 0];
    notes.forEach((n) => {
      const k = ((Math.round((n.t - g.phi) / step) % 4) + 4) % 4;
      sc[k] += 1 + Math.min(4, (+n.d || 0) / step);
    });
    let best = 0;
    for (let k = 1; k < 4; k++) if (sc[k] > sc[best]) best = k;
    return g.phi + best * step;
  }

  function toAsciiTab(notes, opts) {
    opts = opts || {};
    const tuning = Array.isArray(opts.tuning) && opts.tuning.length === 6 ? opts.tuning : STD_TUNING;
    const capo = Math.max(0, Math.min(12, Math.round(+opts.capo || 0)));
    let ns = (notes || []).filter((n) => n && isFinite(n.t) && isFinite(n.midi));
    if (ns.some((n) => n.s == null || n.f == null)) ns = assignFrets(ns, { tuning, capo, maxFret: opts.maxFret });
    ns = ns.slice().sort((a, b) => a.t - b.t);
    const bpm = +opts.bpm > 0 ? +opts.bpm : 0;
    const names = stringNames(tuning);
    const nameW = Math.max.apply(null, names.map((x) => x.length));
    const lbl = (s) => names[s].padEnd(nameW);
    const head = 'Tuning: ' + tuning.map((m) => NAMES[((Math.round(m) % 12) + 12) % 12]).join(' ') +
      (bpm ? ' · BPM ' + Math.round(bpm) : '') + (capo ? ' · Capo ' + capo : '');
    const out = [head];

    const emitSystem = (cols, W, t0) => {
      // cols: [{cells:[6] | null, bar:boolean}] — bar=true คือเส้นห้อง
      out.push('');
      if (t0 != null) out.push('[' + fmtTime(t0) + ']');
      for (let s = 5; s >= 0; s--) {
        let line = lbl(s) + '|';
        for (const c of cols) {
          if (c.bar) { line += '|'; continue; }
          if (c.pad) { line += '-'.repeat(c.pad); continue; }
          const v = c.cells && c.cells[s] != null ? String(c.cells[s]) : '';
          line += v.padEnd(W, '-');
        }
        out.push(line);
      }
    };

    if (!ns.length) {
      const cols = [{ pad: 1 }];
      for (let k = 0; k < (bpm ? 16 : 8); k++) cols.push({ cells: null });
      cols.push({ bar: true });
      emitSystem(cols, 2, null);
      return out.join('\n') + '\n';
    }

    if (bpm) {
      const step = 60 / bpm / 4, SPB = 16;
      // ไม่ได้ส่ง phase มา → อนุมานจากโน้ตเอง (ไม่งั้นเส้นห้องเลื่อนจากกริดของโน้ตได้เกือบ 1 ช่อง)
      const phase = opts.phase != null && isFinite(+opts.phase) ? +opts.phase : inferPhase(ns, step);
      const perLine = Math.max(1, opts.barsPerLine || 4);
      const cells = new Map(); // stepIdx → {f:[6], conf:[6]}
      for (const n of ns) {
        const k = Math.round((n.t - phase) / step);
        let c = cells.get(k);
        if (!c) { c = { f: new Array(6).fill(null), w: new Array(6).fill(-1) }; cells.set(k, c); }
        const w = (+n.conf || 0) * (+n.d || 0);
        if (w > c.w[n.s]) { c.f[n.s] = n.f; c.w[n.s] = w; }
      }
      const ks = Array.from(cells.keys());
      const bar0 = Math.floor(Math.min.apply(null, ks) / SPB);
      const barN = Math.floor(Math.max.apply(null, ks) / SPB);
      for (let b = bar0; b <= barN; b += perLine) {
        const bars = [];
        for (let x = b; x < Math.min(b + perLine, barN + 1); x++) bars.push(x);
        let any = false, maxDig = 1;
        for (const x of bars) {
          for (let k = x * SPB; k < (x + 1) * SPB; k++) {
            const c = cells.get(k);
            if (!c) continue;
            any = true;
            c.f.forEach((f) => { if (f != null) maxDig = Math.max(maxDig, String(f).length); });
          }
        }
        if (!any) continue; // ทั้งแถวไม่มีโน้ต (ช่วงพักยาว) → ข้าม มี [เวลา] กำกับแถวถัดไป
        const W = maxDig + 1;
        const cols = [];
        bars.forEach((x) => {
          cols.push({ pad: 1 });
          for (let k = x * SPB; k < (x + 1) * SPB; k++) {
            const c = cells.get(k);
            cols.push({ cells: c ? c.f : null });
          }
          cols.push({ bar: true });
        });
        emitSystem(cols, W, phase + b * SPB * step);
      }
    } else {
      // ไม่รู้ BPM: เรียงตามเวลา ช่องว่างตามระยะห่าง ไม่มีเส้นห้อง
      const perLine = Math.max(4, opts.notesPerLine || 24);
      for (let i0 = 0; i0 < ns.length; i0 += perLine) {
        const grp = ns.slice(i0, i0 + perLine);
        let maxDig = 1;
        grp.forEach((n) => { maxDig = Math.max(maxDig, String(n.f).length); });
        const W = maxDig + 1;
        const cols = [{ pad: 1 }];
        grp.forEach((n, j) => {
          const cellsArr = new Array(6).fill(null);
          cellsArr[n.s] = n.f;
          cols.push({ cells: cellsArr });
          const nx = grp[j + 1];
          if (nx) {
            const gap = nx.t - n.t;
            const pad = gap < 0.25 ? 0 : gap < 0.6 ? 1 : 2;
            if (pad) cols.push({ pad });
          }
        });
        cols.push({ bar: true });
        emitSystem(cols, W, grp[0].t);
      }
    }
    return out.join('\n') + '\n';
  }

  return {
    STD_TUNING, extract, assignFrets, toAsciiTab,
    // ช่องสำหรับเทสต์/ดีบัก (ไม่ใช่ API สาธารณะ)
    _test: { makeAnalyzer, kthSmallest, pickOnsets, cleanRuns, fitGrid, quantize, inferPhase, stringNames },
  };
});
