/* tracks.js — แกนแกะ "ไลน์เพลงจริง" หลายเครื่องดนตรี → แทร็กโน้ตแบบ MIDI (TrackSet v1)
   ฟังก์ชันล้วน ไม่แตะ DOM/WebAudio/โมเดล — ใช้ได้ทั้ง Web Worker (self.Tracks) และ Node (module.exports)
   ตัวรันโมเดล (Basic Pitch / Demucs) ถูก "ฉีด" เข้ามาเป็นฟังก์ชัน → เทสต์ใน Node ด้วยตัวปลอมได้ (tools/test-tracks.cjs)

   lite (ทุกเครื่อง):  HPSS (median filter) → กลองจากส่วน percussive (onset ต่อชิ้น + NMF ระดับ event: kick/snare/hat)
                      → Basic Pitch บนส่วน harmonic → แยก bass (เสียงต่ำสุด เส้นเดียว) / melody (เส้นเด่นจาก riff.js
                      จับคู่กับโน้ต Basic Pitch) / harmony (ที่เหลือ)
   full (WebGPU):     Demucs 6 stem (หน้าต่าง 7.8s ซ้อน 25% fade เชิงเส้น เหมือน infer.py อ้างอิง; กราฟ iSTFT ถูกแก้ตอนโหลด
                      ให้เร็วขึ้น ~4.7×) → กลองจาก stem กลอง → Basic Pitch ต่อ stem (bass/guitar/piano/other)
                      + vocals = เส้นทำนองร้อง (เพลงบรรเลง: หาเส้นทำนองจาก stem ที่เป็นเส้นเดียวที่สุด → melody)
   หลังจากนั้นทั้งสองโหมด: quantize onset เข้ากริด 16th เฉพาะจุดที่หลักฐานจังหวะรอบ ๆ ชัด (ความยาวโน้ต/ช่วงพักคงของจริง)

   TrackSet v1: { v:1, source, bpm, phase, duration, tracks:[{ id, kind, program, notes:[{t,d,midi,vel}] }] } */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.Tracks = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  const noTick = () => Promise.resolve();
  const noop = () => {};

  function getDSP() {
    if (root && root.DSP && root.DSP.makeFFT) return root.DSP;
    if (typeof require === 'function') { try { return require('./dsp.js'); } catch (e) { /* ด้านล่าง */ } }
    throw new Error('tracks.js ต้องการ dsp.js');
  }
  function getRiff() {
    if (root && root.Riff && root.Riff.extract) return root.Riff;
    if (typeof require === 'function') { try { return require('./riff.js'); } catch (e) { /* ไม่มีก็ได้ */ } }
    return null;
  }

  const r3 = (x) => Math.round(x * 1000) / 1000;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const byT = (a, b) => a.t - b.t || a.midi - b.midi;

  /* ================= GM / TrackSet ================= */
  const GM = { KICK: 36, SNARE: 38, HAT: 42, OPEN_HAT: 46, CRASH: 49, TOM_LO: 45, TOM_MID: 47, TOM_HI: 50 };
  // โปรแกรม GM (0-based) ต่อแทร็ก — ใช้แค่เป็นค่าเริ่มต้นตอนเล่นเสียง/ส่งออก MIDI
  const PROGRAM = { drums: 0, bass: 33, melody: 73, vocals: 53, guitar: 27, piano: 0, harmony: 0, other: 48 };
  const KIND = { drums: 'drums' };
  const ORDER = ['drums', 'bass', 'melody', 'vocals', 'guitar', 'piano', 'harmony', 'other'];

  /* ================= resample ================= */
  // windowed-sinc (Blackman) lowpass, fc = cutoff/sr (รอบต่อแซมเปิล)
  function sincLP(fc, taps) {
    const h = new Float32Array(taps), half = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const m = i - half;
      const s = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      h[i] = s * w; sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    return h;
  }
  const DEC_TAPS = 63;
  let decH2 = null;
  // decimate จำนวนเต็ม (lowpass ก่อน) — ใช้ 44.1k→22.05k และ 22.05k→11.025k
  function decimate(x, factor) {
    factor = Math.round(factor);
    if (factor <= 1) return Float32Array.from(x);
    const h = factor === 2 ? (decH2 || (decH2 = sincLP(0.45 / 2, DEC_TAPS))) : sincLP(0.45 / factor, DEC_TAPS);
    const half = (DEC_TAPS - 1) >> 1, n = x.length;
    const out = new Float32Array(Math.floor(n / factor));
    for (let o = 0; o < out.length; o++) {
      const c = o * factor;
      let acc = 0;
      if (c - half >= 0 && c + half < n) {
        for (let i = 0, j = c - half; i < DEC_TAPS; i++, j++) acc += x[j] * h[i];
      } else {
        for (let i = 0; i < DEC_TAPS; i++) { const j = c + i - half; if (j >= 0 && j < n) acc += x[j] * h[i]; }
      }
      out[o] = acc;
    }
    return out;
  }

  // อัตราส่วนใด ๆ: polyphase windowed-sinc (ตาราง 256 เฟส) — เช่น 48k→44.1k, 22.05k→16k
  function resample(x, srIn, srOut) {
    if (!x || !x.length) return new Float32Array(0);
    if (Math.abs(srIn - srOut) < 1e-6) return Float32Array.from(x);
    const ratio = srIn / srOut;
    if (Math.abs(ratio - Math.round(ratio)) < 1e-9 && ratio >= 2) return decimate(x, ratio);
    const fc = 0.46 * Math.min(1, srOut / srIn);  // cutoff (รอบต่อแซมเปิลขาเข้า)
    const zc = 10;                                 // zero crossing ต่อข้าง
    const halfW = Math.ceil(zc / (2 * fc));
    const P = 256, W = 2 * halfW + 1;
    const tab = new Float32Array((P + 1) * W);
    for (let p = 0; p <= P; p++) {
      const frac = p / P;
      let s = 0;
      for (let k = 0; k < W; k++) {
        const d = k - halfW - frac;  // ระยะจากจุดที่ต้องการ
        const sinc = Math.abs(d) < 1e-9 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
        const u = d / (halfW + 1);
        const w = Math.abs(u) >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * u);
        tab[p * W + k] = sinc * w; s += sinc * w;
      }
      for (let k = 0; k < W; k++) tab[p * W + k] /= s || 1;
    }
    const n = x.length, outLen = Math.floor(n / ratio);
    const out = new Float32Array(outLen);
    for (let o = 0; o < outLen; o++) {
      const pos = o * ratio;
      const i0 = Math.floor(pos);
      const p = Math.round((pos - i0) * P);
      const base = p * W;
      const j0 = i0 - halfW;
      let acc = 0;
      if (j0 >= 0 && j0 + W <= n) {
        for (let k = 0; k < W; k++) acc += x[j0 + k] * tab[base + k];
      } else {
        for (let k = 0; k < W; k++) { const j = j0 + k; if (j >= 0 && j < n) acc += x[j] * tab[base + k]; }
      }
      out[o] = acc;
    }
    return out;
  }

  function mixdown(chans, len) {
    const n = len != null ? len : Math.min.apply(null, chans.map((c) => c.length));
    const out = new Float32Array(n);
    const g = 1 / chans.length;
    chans.forEach((c) => { for (let i = 0; i < n; i++) out[i] += c[i] * g; });
    return out;
  }

  // RMS ต่อช่วง (ใช้ gate โน้ตจาก bleed/เงียบ + ตรวจว่า stem มีเสียงจริงไหม)
  function rmsEnvelope(x, sr, winSec) {
    const W = Math.max(1, Math.round(sr * (winSec || 0.05)));
    const n = Math.ceil(x.length / W);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const a = i * W, b = Math.min(x.length, a + W);
      for (let j = a; j < b; j++) s += x[j] * x[j];
      env[i] = Math.sqrt(s / Math.max(1, b - a));
    }
    return { env, sec: W / sr };
  }
  function quantile(arr, q) {
    if (!arr.length) return 0;
    const a = Float32Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
  }

  /* ================= HPSS (median filtering, Fitzgerald 2010) =================
     STFT N=1024 hop 256 @22.05kHz (46/11.6ms) · median ตามเวลา 17 เฟรม (~0.2s → โน้ตที่ยาว ≥ ~0.1s อยู่ฝั่ง harmonic)
     · median ตามความถี่ 17 bin (~370Hz) · soft mask (Wiener p=2)
     สตรีมทีละเฟรม: เก็บแค่ 17 เฟรมล่าสุด → RAM คงที่ ไม่ขึ้นกับความยาวเพลง (นอกจากเอาต์พุต)
     คืน harmonic (เวลา, ยาวเท่าขาเข้า) + พลังงาน percussive เป็นแถบความถี่ต่อเฟรม (ให้ detectDrums) */
  const BAND_EDGES = [30, 60, 90, 120, 160, 200, 250, 320, 400, 500, 650, 800, 1000, 1300, 1700, 2200, 3000, 4000, 5500, 7500, 11025];
  const NB = BAND_EDGES.length - 1;

  // แทนค่า oldV ด้วย newV ในช่วงที่เรียงแล้ว a[off..off+m) แล้วเลื่อนให้ยังเรียงอยู่
  function sReplace(a, off, m, oldV, newV) {
    let lo = off, hi = off + m - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < oldV) lo = mid + 1; else hi = mid; }
    let i = lo;
    if (newV > oldV) {
      while (i + 1 < off + m && a[i + 1] < newV) { a[i] = a[i + 1]; i++; }
    } else if (newV < oldV) {
      while (i > off && a[i - 1] > newV) { a[i] = a[i - 1]; i--; }
    }
    a[i] = newV;
  }

  async function hpss(x, sr, opts) {
    opts = opts || {};
    const D = getDSP();
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    const N = opts.n || (sr > 30000 ? 2048 : 1024), H = N >> 2;
    const LT = opts.kTime || 17, LF = opts.kFreq || 17;
    const ht = LT >> 1, hf = LF >> 1;
    const K = N / 2 + 1;
    const wantHarm = opts.harmonic !== false;
    const hMargin = opts.hMargin != null ? opts.hMargin : 1;   // >1 = ส่วน harmonic เข้มงวดขึ้น (กันกลองรั่ว)
    const pMargin = opts.pMargin != null ? opts.pMargin : 1;   // >1 = ส่วน percussive (กลอง) ต้องชนะ harmonic ขาด (Driedger 2014)
    const fp = D.makeFFT(N), win = D.hann(N);
    const len = x.length;
    const F = Math.floor(len / H) + 1;               // เฟรม c มีจุดกึ่งกลางที่แซมเปิล c·H
    const harm = wantHarm ? new Float32Array(len) : null;
    const wsum = wantHarm ? new Float32Array(len) : null;
    const bands = new Float32Array(F * NB);
    // bin → band
    const bandOf = new Int8Array(K).fill(-1);
    const bandCnt = new Float32Array(NB);
    for (let k = 1; k < K; k++) {
      const hz = (k * sr) / N;
      for (let b = 0; b < NB; b++) if (hz >= BAND_EDGES[b] && hz < BAND_EDGES[b + 1]) { bandOf[k] = b; bandCnt[b]++; break; }
    }
    const re = new Float32Array(N), im = new Float32Array(N);
    const magRing = new Float32Array(LT * K);
    const sw = new Float32Array(K * LT);              // หน้าต่าง median ตามเวลา (เรียงแล้ว) ต่อ bin
    const CR = ht + 1;
    const reRing = new Float32Array(CR * K), imRing = new Float32Array(CR * K);
    const fw = new Float32Array(LF);                   // หน้าต่าง median ตามความถี่
    const Pm = new Float32Array(K);
    const bandSum = new Float32Array(NB);
    let pushed = 0;
    // เติมเฟรมศูนย์ ht เฟรมก่อนเริ่ม → หน้าต่างเต็ม LT ตั้งแต่เฟรม 0 (ทุกช่องเริ่มเป็น 0 อยู่แล้ว)
    // sw เริ่มเป็นศูนย์ทั้งหมด = หน้าต่างที่มีศูนย์ LT ตัว (เรียงแล้ว) → ใช้ sReplace ได้ตั้งแต่แรก
    pushed = ht;
    const zeros = new Float32Array(K);

    function push(mag) {
      const slot = pushed % LT;
      const old = slot * K;
      for (let k = 0; k < K; k++) {
        const ov = magRing[old + k], nv = mag[k];
        if (ov !== nv) sReplace(sw, k * LT, LT, ov, nv);
        magRing[old + k] = nv;
      }
      pushed++;
    }

    const curMag = new Float32Array(K);
    function processCenter(c) {
      const mslot = ((c + ht) % LT) * K;
      const cslot = (c % CR) * K;
      // median ตามความถี่ของเฟรม c (นอกช่วง = 0)
      fw.fill(0);
      // เริ่มหน้าต่างที่ k=0: bin -hf..hf → ใส่ bin 0..hf
      for (let k = 0; k <= hf && k < K; k++) sReplace(fw, 0, LF, 0, magRing[mslot + k]);
      for (let k = 0; k < K; k++) {
        Pm[k] = fw[hf];
        // เลื่อนหน้าต่าง: ออก k-hf, เข้า k+hf+1
        const outK = k - hf, inK = k + hf + 1;
        const ov = outK >= 0 ? magRing[mslot + outK] : 0;
        const nv = inK < K ? magRing[mslot + inK] : 0;
        if (ov !== nv) sReplace(fw, 0, LF, ov, nv);
      }
      bandSum.fill(0);
      for (let k = 0; k < K; k++) {
        const h = sw[k * LT + ht], p = Pm[k] * hMargin;
        const h2 = h * h, p2 = p * p;
        const mh = h2 + p2 > 1e-20 ? h2 / (h2 + p2) : 0;
        const b = bandOf[k];
        if (b >= 0) {
          const hp = h * pMargin, pp = Pm[k];
          const mp = pp * pp + hp * hp > 1e-20 ? (pp * pp) / (pp * pp + hp * hp) : 0;
          bandSum[b] += magRing[mslot + k] * mp;
        }
        if (wantHarm) { re[k] = reRing[cslot + k] * mh; im[k] = imRing[cslot + k] * mh; }
      }
      const bo = c * NB;
      for (let b = 0; b < NB; b++) bands[bo + b] = bandCnt[b] ? bandSum[b] / bandCnt[b] : 0;
      if (wantHarm) {
        // iFFT ของสเปกตรัมจริง: เติมครึ่งบนแบบ conjugate แล้วใช้ ifft(X) = conj(fft(conj X))/N
        for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
        for (let k = 0; k < N; k++) im[k] = -im[k];
        D.fft(fp, re, im);
        const off = c * H - N / 2;
        for (let i = 0; i < N; i++) {
          const j = off + i;
          if (j < 0 || j >= len) continue;
          const w = win[i];
          harm[j] += (re[i] / N) * w;
          wsum[j] += w * w;
        }
      }
    }

    for (let j = 0; j < F + ht; j++) {
      if (j < F) {
        const off = j * H - N / 2;
        for (let i = 0; i < N; i++) {
          const s = off + i;
          re[i] = (s >= 0 && s < len ? x[s] : 0) * win[i]; im[i] = 0;
        }
        D.fft(fp, re, im);
        const cslot = (j % CR) * K;
        for (let k = 0; k < K; k++) {
          const a = re[k], b = im[k];
          reRing[cslot + k] = a; imRing[cslot + k] = b;
          curMag[k] = Math.sqrt(a * a + b * b);
        }
        push(curMag);
      } else push(zeros);
      const c = j - ht;
      if (c >= 0) processCenter(c);
      if ((j & 255) === 0) { chk(); onPct(j / (F + ht)); await tick(); }
    }
    if (wantHarm) for (let i = 0; i < len; i++) if (wsum[i] > 1e-6) harm[i] /= wsum[i];
    onPct(1);
    return { harmonic: harm, bands, F, nb: NB, frameSec: H / sr, t0: 0, sr, N, H };
  }

  /* ================= กลอง: onset ต่อชิ้น → NMF ระดับ event (kick/snare/hat + junk) =================
     1. แถบความถี่ percussive normalize ต่อแถบ (หาร p99 ทั้งเพลง แล้ว ^0.5) — ไฮแฮตที่เบามีน้ำหนักเท่าแถบต่ำ
     2. onset ต่อชิ้นจากกลุ่มแถบของตัวเอง (kick 30–160Hz · snare 160–500Hz + 650–5.5kHz · hat ≥ 5.5kHz)
        threshold = median เฉพาะที่ ±0.5s ×1.5 + 10% ของ p99 → รวม onset ที่ห่าง ≤ 2 เฟรมเป็น event เดียว
     3. เวกเตอร์ "ส่วนที่เพิ่มขึ้น" ของแต่ละ event (ยอดหลัง − พื้นก่อน ต่อแถบ) → NMF แบบ KL 4 component:
        kick/snare/hat (เรียน template จากเพลงเอง ดึงกลับหา prior ตาม blend) + junk (หัวโน้ตของเครื่องดนตรีอื่น)
        โดนพร้อมกันหลายชิ้น (kick+hat, snare+hat) แยกได้เพราะ NMF เป็นผลบวก
     4. ตัดสินว่ามีชิ้นนั้นไหม: activation ≥ τ × ค่าอ้างอิงของชิ้นนั้น
        (kick/snare: p95 ทุก event · hat: p90 ของ event ที่ hat เด่นจริง — กัน hat ที่ซ้อน snare ดันค่าอ้างอิงจนไฮแฮตเบาหาย) */
  const TPL = {
    kick: [1, 1, 1, 0.8, 0.4, 0.25, 0.15, 0.1, 0.08, 0.06, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.04, 0.03, 0.02, 0.02],
    snare: [0.05, 0.05, 0.08, 0.2, 0.5, 0.8, 0.8, 0.7, 0.6, 0.6, 0.65, 0.7, 0.75, 0.8, 0.8, 0.7, 0.55, 0.4, 0.25, 0.15],
    hat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.02, 0.03, 0.05, 0.08, 0.15, 0.3, 0.6, 1, 1],
    junk: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.05, 0.05],
  };
  const COMP = ['kick', 'snare', 'hat', 'junk'];
  const GROUP = { kick: [0, 1, 2, 3], snare: [4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16], hat: [17, 18, 19] };
  // หน้าต่าง STFT 46ms: จุดกึ่งกลางเฟรมที่ onset function พุ่งสุดเทียบจังหวะตีจริง (วัดจากเทสต์สังเคราะห์)
  const DRUM_BIAS = 0.004;

  async function detectDrums(perc, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    const { bands, F, frameSec } = perc;
    const B = perc.nb || NB, C = COMP.length, CD = 3;
    if (!F || F < 16) return [];
    const eps = 1e-9;
    // 1) normalize ต่อแถบ
    const Y = new Array(B);
    const col = new Float32Array(F);
    let any = false;
    for (let b = 0; b < B; b++) {
      for (let f = 0; f < F; f++) col[f] = bands[f * B + b];
      const ref = quantile(col, 0.99);
      const g = ref > 1e-9 ? 1 / ref : 0;
      const y = new Float32Array(F);
      for (let f = 0; f < F; f++) y[f] = Math.sqrt(col[f] * g);
      if (g > 0) any = true;
      Y[b] = y;
    }
    if (!any) return [];
    onPct(0.1); await tick();
    // 2) onset ต่อชิ้น
    const cand = [];
    const half = Math.round(0.5 / frameSec);
    ['kick', 'snare', 'hat'].forEach((nm, ci) => {
      const gr = GROUP[nm];
      const o = new Float32Array(F);
      for (let f = 1; f < F; f++) {
        let sum = 0;
        for (const b of gr) { const d = Y[b][f] - Y[b][f - 1]; if (d > 0) sum += d; }
        o[f] = sum / gr.length;
      }
      const p99 = quantile(o, 0.99);
      if (!(p99 > 0)) return;
      // median เฉพาะที่ ±0.5s (คิดเป็นบล็อก 0.25s เพื่อความเร็ว)
      const blk = Math.max(1, Math.round(0.25 / frameSec));
      const nBlk = Math.ceil(F / blk);
      const bmed = new Float32Array(nBlk);
      for (let k = 0; k < nBlk; k++) {
        const a0 = Math.max(0, k * blk - half), b0 = Math.min(F, k * blk + blk + half);
        bmed[k] = quantile(o.subarray(a0, b0), 0.5);
      }
      for (let f = 3; f < F - 3; f++) {
        const v = o[f];
        if (v <= 0) continue;
        let mx = true;
        for (let u = f - 3; u <= f + 3; u++) if (o[u] > v) { mx = false; break; }
        if (!mx) continue;
        const thr = bmed[Math.floor(f / blk)] * 1.5 + 0.1 * p99;
        if (v < thr) continue;
        // ตำแหน่งยอดละเอียดกว่าเฟรม (parabola)
        const a = o[f - 1], c = o[f + 1], den = a - 2 * v + c;
        const d = den < 0 ? clamp(0.5 * (a - c) / den, -0.5, 0.5) : 0;
        cand.push({ f, ff: f + d, k: ci, v: v / p99 });
      }
    });
    if (!cand.length) return [];
    cand.sort((a, b) => a.f - b.f);
    const ev = [];
    for (const c of cand) {
      const p = ev[ev.length - 1];
      if (p && c.f - p.f <= 2) { if (c.v > p.v) { p.ff = c.ff; p.v = c.v; } continue; }
      ev.push({ f: c.f, ff: c.ff, v: c.v });
    }
    const E = ev.length;
    // 3) เวกเตอร์ส่วนที่เพิ่มขึ้นต่อ event
    const Rv = new Float32Array(B * E);
    for (let e = 0; e < E; e++) {
      const f = ev[e].f;
      for (let b = 0; b < B; b++) {
        const y = Y[b];
        let post = 0, pre = Infinity;
        for (let u = Math.max(0, f - 1); u <= Math.min(F - 1, f + 2); u++) if (y[u] > post) post = y[u];
        for (let u = Math.max(0, f - 5); u <= Math.max(0, f - 2); u++) if (y[u] < pre) pre = y[u];
        Rv[b * E + e] = Math.max(0, post - (isFinite(pre) ? pre : 0));
      }
    }
    onPct(0.25); await tick();
    // NMF ระดับ event
    const W0 = new Float64Array(B * C);
    COMP.forEach((nm, c) => {
      let s = 0;
      for (let b = 0; b < B; b++) s += TPL[nm][b];
      for (let b = 0; b < B; b++) W0[b * C + c] = TPL[nm][b] / s + 1e-3;
    });
    const W = Float64Array.from(W0);
    const A = new Float64Array(C * E).fill(1);
    const blendKS = opts.blend != null ? opts.blend : 0.15;
    const BL = [blendKS, blendKS, 0.5, 0];
    const wh = new Float64Array(B);
    const IT = opts.iterations || 120;
    for (let it = 0; it < IT; it++) {
      for (let e = 0; e < E; e++) {
        for (let b = 0; b < B; b++) { let s = 0; for (let c = 0; c < C; c++) s += W[b * C + c] * A[c * E + e]; wh[b] = s; }
        for (let c = 0; c < C; c++) {
          let num = 0, den = 0;
          for (let b = 0; b < B; b++) { num += W[b * C + c] * Rv[b * E + e] / (wh[b] + eps); den += W[b * C + c]; }
          A[c * E + e] *= num / (den + eps);
        }
      }
      if (it >= 20 && (it & 1) === 0) {
        const nw = new Float64Array(B * C);
        const asum = new Float64Array(C);
        for (let e = 0; e < E; e++) {
          for (let b = 0; b < B; b++) { let s = 0; for (let c = 0; c < C; c++) s += W[b * C + c] * A[c * E + e]; wh[b] = Rv[b * E + e] / (s + eps); }
          for (let c = 0; c < C; c++) {
            const a = A[c * E + e];
            asum[c] += a;
            for (let b = 0; b < B; b++) nw[b * C + c] += a * wh[b];
          }
        }
        for (let c = 0; c < C; c++) {
          let tot = 0;
          for (let b = 0; b < B; b++) { nw[b * C + c] = W[b * C + c] * nw[b * C + c] / (asum[c] + eps); tot += nw[b * C + c]; }
          for (let b = 0; b < B; b++) W[b * C + c] = (1 - BL[c]) * nw[b * C + c] / (tot + eps) + BL[c] * W0[b * C + c];
        }
      }
      if ((it & 15) === 0) { chk(); onPct(0.25 + 0.65 * it / IT); await tick(); }
    }
    if (opts.debug && typeof opts.debug === 'object') Object.assign(opts.debug, { W, A, E, ev });
    // 4) ตัดสิน
    const refs = [];
    for (let c = 0; c < CD; c++) {
      const v = new Float32Array(E);
      for (let e = 0; e < E; e++) v[e] = A[c * E + e];
      let ref = quantile(v, 0.95);
      if (c === 2) {
        const dom = [];
        for (let e = 0; e < E; e++) {
          let tot = 0;
          for (let cc = 0; cc < C; cc++) tot += A[cc * E + e];
          if (A[c * E + e] >= 0.6 * tot) dom.push(A[c * E + e]);
        }
        if (dom.length >= 4) ref = Math.min(ref, quantile(dom, 0.9));
      }
      refs.push(ref > 0 ? ref : 1);
    }
    const TAU = [opts.kickTau != null ? opts.kickTau : 0.5, opts.snareTau != null ? opts.snareTau : 0.4, opts.hatTau != null ? opts.hatTau : 0.4];
    const bias = opts.onsetBias != null ? opts.onsetBias : DRUM_BIAS;
    const out = [];
    const T0 = 18, T1 = 19;
    for (let e = 0; e < E; e++) {
      const t = Math.max(0, ev[e].ff * frameSec + (perc.t0 || 0) + bias);
      for (let c = 0; c < CD; c++) {
        const a = A[c * E + e];
        if (a < TAU[c] * refs[c]) continue;
        const vel = clamp(0.9 * Math.pow(a / refs[c], 0.7), 0.05, 1);
        let midi = c === 0 ? GM.KICK : c === 1 ? GM.SNARE : GM.HAT;
        let decay = 0.05;
        if (c === 2) {
          // หางเสียงแถบสูงสุด: เฟรมจนกว่าจะตกต่ำกว่า 30% ของส่วนที่ขึ้นมา → hat เปิด / crash
          const f = ev[e].f;
          const hv = (u) => 0.5 * (Y[T0][u] + Y[T1][u]);
          let pk = 0;
          for (let u = f; u <= Math.min(F - 1, f + 2); u++) pk = Math.max(pk, hv(u));
          const base = hv(Math.max(0, f - 3));
          const stop = base + 0.3 * (pk - base);
          let g = Math.min(F - 1, f + 2);
          while (g + 1 < F && hv(g + 1) >= stop) g++;
          decay = (g - f) * frameSec;
          // snare ที่ดังพร้อมกันยืดหางแถบสูง → ตัดสิน open/crash เฉพาะเมื่อ snare ไม่เด่น
          const snareWeak = A[E + e] < 0.3 * refs[1];
          if (snareWeak && decay > 0.5 && vel > 0.6) midi = GM.CRASH;
          else if (snareWeak && decay > 0.14) midi = GM.OPEN_HAT;
        }
        // ไฮแฮตปิดสั้นเสมอ (หางยาวที่วัดได้มาจาก crash/snare ที่ดังทับ)
        out.push({ t, d: midi === GM.HAT ? clamp(decay + 0.04, 0.05, 0.2) : clamp(decay + 0.04, 0.05, 1.5), midi, vel });
      }
    }
    out.sort(byT);
    onPct(1);
    return out;
  }

  async function drumsFromSignal(x, sr, opts) {
    opts = opts || {};
    const onPct = opts.onPct || noop;
    const p = await hpss(x, sr, Object.assign({}, opts, { harmonic: false, onPct: (f) => onPct(0.6 * f) }));
    return detectDrums(p, Object.assign({}, opts, { onPct: (f) => onPct(0.6 + 0.4 * f) }));
  }

  /* ================= Basic Pitch (Spotify, ICASSP 2022) =================
     พอร์ตจาก basic_pitch/inference.py + note_creation.py:
     เสียง 22050Hz mono · หน้าต่าง 43844 แซมเปิล (2s − 1 hop) · hop หน้าต่าง 36164 · เติมศูนย์ 3840 ด้านหน้า
     เอาต์พุตต่อหน้าต่าง 172 เฟรม (hop 256 = 11.6ms) ตัดหัวท้าย 15 เฟรม → ต่อกัน
     เวลาเฟรมคำนวณตรงจากตำแหน่งหน้าต่าง (ต้นฉบับใช้สูตรประมาณ + "magic number" 0.0018s แทน) */
  const BP = { SR: 22050, HOP: 256, NS: 43844, NFR: 172, TRIM: 15, PAD: 3840, WHOP: 36164, KEEP: 142, NP: 88, MIDI0: 21 };
  const BP_ONSET_BIAS = 0;  // วัดในเบราว์เซอร์กับโมเดลจริง: onset คลาดเฉลี่ย 0–1ms → ไม่ต้องชดเชย

  function bpFrameTime(f) {
    const w = Math.floor(f / BP.KEEP), j = f - w * BP.KEEP + BP.TRIM;
    return (w * BP.WHOP + j * BP.HOP - BP.PAD) / BP.SR;
  }

  /* runModel(input Float32Array(B·43844), B) → Promise<{ note: Float32Array(B·172·88), onset: Float32Array(B·172·88) }>
     หน้าต่างที่เงียบมาก (เทียบระดับดังของทั้งไฟล์) ข้ามการรันโมเดล — Basic Pitch normalize ต่อหน้าต่าง
     (log-CQT min/max) ทำให้หน้าต่างที่มีแต่ bleed/นอยส์ถูกขยายจนกลายเป็นโน้ตขยะ */
  async function bpPosteriors(x, runModel, opts) {
    opts = opts || {};
    const chk = opts.chk || noop, onPct = opts.onPct || noop, tick = opts.tick || noTick;
    const batch = Math.max(1, opts.batch || 4);
    const len = x.length;
    const padLen = len + BP.PAD;
    const nWin = Math.max(1, Math.ceil(padLen / BP.WHOP));
    const nOut = Math.max(0, Math.min(nWin * BP.KEEP, Math.floor(len / BP.HOP) + 1));
    const note = new Float32Array(nOut * BP.NP), onset = new Float32Array(nOut * BP.NP);
    // ระดับอ้างอิง: p95 ของ RMS 0.1s
    const { env, sec } = rmsEnvelope(x, BP.SR, 0.1);
    const ref = quantile(env, 0.95);
    const gate = ref * Math.pow(10, -(opts.gateDb != null ? opts.gateDb : 45) / 20);
    const xs = (i) => { const k = i - BP.PAD; return k >= 0 && k < len ? x[k] : 0; };
    const wins = [];
    for (let w = 0; w < nWin; w++) {
      // พลังงานช่วงที่หน้าต่างนี้ "เก็บ" (เฟรม 15..156)
      const a = Math.max(0, (w * BP.WHOP + BP.TRIM * BP.HOP - BP.PAD) / BP.SR), b = Math.max(0, (w * BP.WHOP + (BP.TRIM + BP.KEEP) * BP.HOP - BP.PAD) / BP.SR);
      let mx = 0;
      for (let i = Math.floor(a / sec); i <= Math.min(env.length - 1, Math.floor(b / sec)); i++) if (env[i] > mx) mx = env[i];
      if (mx > gate && ref > 1e-6) wins.push(w);
    }
    let done = 0;
    for (let i0 = 0; i0 < wins.length; i0 += batch) {
      chk();
      const ws = wins.slice(i0, i0 + batch), B = ws.length;
      const inp = new Float32Array(B * BP.NS);
      ws.forEach((w, bi) => {
        const s0 = w * BP.WHOP, o = bi * BP.NS;
        for (let i = 0; i < BP.NS; i++) inp[o + i] = xs(s0 + i);
      });
      const r = await runModel(inp, B, ws);
      ws.forEach((w, bi) => {
        for (let j = BP.TRIM; j < BP.TRIM + BP.KEEP; j++) {
          const f = w * BP.KEEP + (j - BP.TRIM);
          if (f >= nOut) break;
          const src = (bi * BP.NFR + j) * BP.NP, dst = f * BP.NP;
          for (let p = 0; p < BP.NP; p++) { note[dst + p] = r.note[src + p]; onset[dst + p] = r.onset[src + p]; }
        }
      });
      done += B;
      onPct(done / Math.max(1, wins.length));
      await tick();
    }
    onPct(1);
    return { note, onset, F: nOut, windows: nWin, ran: wins.length };
  }

  /* output_to_notes_polyphonic (พอร์ตตรงจาก basic-pitch) + melodia trick
     เปลี่ยนแค่การหา argmax ซ้ำ ๆ ของ melodia trick เป็นไล่ cell ตามค่าที่เรียงไว้ครั้งเดียว — ผลเท่ากัน
     เพราะ remaining_energy มีแต่ถูกตั้งเป็น 0 (ค่าที่เหลือไม่เปลี่ยน) แต่เร็วกว่ามาก (O(n log n) แทน O(โน้ต × เซลล์)) */
  function bpNotes(post, opts) {
    opts = opts || {};
    const onsetThr = opts.onsetThresh != null ? opts.onsetThresh : 0.55;   // ต้นฉบับ 0.5 — ส่วน harmonic จาก HPSS มี onset หลอกมากกว่า
    const frameThr = opts.frameThresh != null ? opts.frameThresh : 0.3;
    const minLen = opts.minNoteLen != null ? opts.minNoteLen : 5;     // เฟรม (5 ≈ 58ms — ค่าเดโมของ basic-pitch)
    const tol = opts.energyTol != null ? opts.energyTol : 11;
    const melodia = opts.melodia !== false;
    const melMinLen = opts.melodiaMinLen != null ? opts.melodiaMinLen : 22;  // เฟรม (~0.26s)
    const melAmp = opts.melodiaAmp != null ? opts.melodiaAmp : 0.5;
    const inferOn = opts.inferOnsets !== false;
    const minMidi = opts.minMidi != null ? opts.minMidi : 21, maxMidi = opts.maxMidi != null ? opts.maxMidi : 108;
    const { F } = post;
    const P = BP.NP, MAXI = P - 1;
    const frames = post.note;
    if (!F) return [];
    const pLo = Math.max(0, minMidi - BP.MIDI0), pHi = Math.min(MAXI, maxMidi - BP.MIDI0);
    const fr = Float32Array.from(frames);
    let on = Float32Array.from(post.onset);
    // constrain_frequency
    if (pLo > 0 || pHi < MAXI) {
      for (let f = 0; f < F; f++) for (let p = 0; p < P; p++) if (p < pLo || p > pHi) { fr[f * P + p] = 0; on[f * P + p] = 0; }
    }
    // get_infered_onsets: min ของผลต่าง 1 และ 2 เฟรม (ติดลบ = 0) สเกลให้ยอดเท่ากับ onset สูงสุด แล้วเอา max
    if (inferOn) {
      let maxOn = 0, maxD = 0;
      const diff = new Float32Array(F * P);
      for (let f = 0; f < F; f++) for (let p = 0; p < P; p++) {
        const i = f * P + p;
        if (on[i] > maxOn) maxOn = on[i];
        if (f < 2) continue;
        const d1 = fr[i] - fr[i - P], d2 = fr[i] - fr[i - 2 * P];
        let d = d1 < d2 ? d1 : d2;
        if (d < 0) d = 0;
        diff[i] = d; if (d > maxD) maxD = d;
      }
      if (maxD > 0) {
        const s = maxOn / maxD;
        for (let i = 0; i < F * P; i++) { const d = diff[i] * s; if (d > on[i]) on[i] = d; }
      }
    }
    // argrelmax ตามเวลา ≥ onsetThr → เรียงจากท้ายเพลงมาหน้า (time desc, pitch desc เหมือน np.where()[::-1])
    const ons = [];
    for (let f = 1; f < F - 1; f++) for (let p = 0; p < P; p++) {
      const i = f * P + p, v = on[i];
      if (v >= onsetThr && v > on[i - P] && v > on[i + P]) ons.push(i);
    }
    ons.reverse();
    const rem = Float32Array.from(fr);
    const notes = [];
    for (const idx of ons) {
      const s = Math.floor(idx / P), p = idx - s * P;
      if (s >= F - 1) continue;
      let i = s + 1, k = 0;
      while (i < F - 1 && k < tol) { if (rem[i * P + p] < frameThr) k++; else k = 0; i++; }
      i -= k;
      if (i - s <= minLen) continue;
      let amp = 0;
      for (let f = s; f < i; f++) {
        rem[f * P + p] = 0;
        if (p < MAXI) rem[f * P + p + 1] = 0;
        if (p > 0) rem[f * P + p - 1] = 0;
        amp += fr[f * P + p];
      }
      notes.push({ s, e: i, p, amp: amp / (i - s) });
    }
    if (melodia) {
      const cells = [];
      for (let i = 0; i < F * P; i++) if (rem[i] > frameThr) cells.push(i);
      cells.sort((a, b) => rem[b] - rem[a] || a - b);
      for (const idx of cells) {
        if (!(rem[idx] > frameThr)) continue; // ถูกลบไปแล้วโดยโน้ตก่อนหน้า
        const mid = Math.floor(idx / P), p = idx - mid * P;
        rem[idx] = 0;
        let i = mid + 1, k = 0;
        while (i < F - 1 && k < tol) {
          if (rem[i * P + p] < frameThr) k++; else k = 0;
          rem[i * P + p] = 0;
          if (p < MAXI) rem[i * P + p + 1] = 0;
          if (p > 0) rem[i * P + p - 1] = 0;
          i++;
        }
        const iEnd = i - 1 - k;
        i = mid - 1; k = 0;
        while (i > 0 && k < tol) {
          if (rem[i * P + p] < frameThr) k++; else k = 0;
          rem[i * P + p] = 0;
          if (p < MAXI) rem[i * P + p + 1] = 0;
          if (p > 0) rem[i * P + p - 1] = 0;
          i--;
        }
        const iStart = i + 1 + k;
        if (iEnd - iStart <= minLen) continue;
        let amp = 0;
        for (let f = iStart; f < iEnd; f++) amp += fr[f * P + p];
        amp /= iEnd - iStart;
        // โน้ตที่ไม่มี onset: เก็บเฉพาะเสียงค้างยาวและชัด (pad/คอร์ดค้างที่หัวโน้ตนุ่ม) — สั้น/เบา ส่วนใหญ่เป็นขยะ
        if (iEnd - iStart < melMinLen || amp < melAmp) continue;
        notes.push({ s: iStart, e: iEnd, p, amp, noOnset: true });
      }
    }
    const bias = opts.onsetBias != null ? opts.onsetBias : BP_ONSET_BIAS;
    const raw = post.onset;
    // โน้ตเดียวกันที่ต่อกันสนิท (ช่องว่าง ≤ 2 เฟรม) และ onset ดิบของตัวหลังอ่อน (< reonset) = การแตกโน้ตหลอก
    // (beating ของเสียงคอรัส/vibrato) → รวมเป็นโน้ตเดียว · การดีดซ้ำจริงมี onset ดิบ ~0.8 (วัดจากเพลงสังเคราะห์)
    const reTh = opts.reonset != null ? opts.reonset : 0.6;
    const onvOf = (n) => { let v = 0; for (let f = Math.max(0, n.s - 2); f <= Math.min(F - 1, n.s + 2); f++) v = Math.max(v, raw[f * P + n.p]); return v; };
    if (reTh > 0) {
      notes.sort((a, b) => a.p - b.p || a.s - b.s);
      const kept = [];
      for (const n of notes) {
        const q = kept[kept.length - 1];
        if (q && q.p === n.p && n.s - q.e <= 2 && n.s >= q.s && onvOf(n) < reTh) {
          const len = n.e - q.s;
          q.amp = (q.amp * (q.e - q.s) + n.amp * (n.e - n.s)) / Math.max(1, len - Math.max(0, n.s - q.e));
          q.e = Math.max(q.e, n.e);
          continue;
        }
        kept.push(n);
      }
      notes.length = 0;
      kept.forEach((n) => notes.push(n));
    }
    return notes.map((n) => {
      const t = Math.max(0, bpFrameTime(n.s) + bias);
      const e = bpFrameTime(n.e) + bias;
      // onv = onset posterior ดิบ (ก่อนรวม inferred onset) รอบจุดเริ่ม — ใช้แยกการดีดซ้ำจริงกับการแตกโน้ตหลอก
      const onv = onvOf(n);
      return { t, d: Math.max(0.02, e - t), midi: n.p + BP.MIDI0, vel: clamp(n.amp, 0, 1), amp: n.amp, onv, noOnset: !!n.noOnset };
    }).sort(byT);
  }

  // ตัดโน้ตที่ช่วงนั้นสัญญาณแทบเงียบ (bleed ของ stem / หาง reverb) — เทียบกับระดับดังของทั้งไฟล์
  function gateNotes(notes, x, sr, gateDb) {
    if (!notes.length) return notes;
    const { env, sec } = rmsEnvelope(x, sr, 0.05);
    const ref = quantile(env, 0.95);
    if (!(ref > 0)) return [];
    const thr = ref * Math.pow(10, -gateDb / 20);
    return notes.filter((n) => {
      const a = Math.floor(n.t / sec), b = Math.min(env.length - 1, Math.floor((n.t + Math.min(n.d, 0.25)) / sec));
      let mx = 0;
      for (let i = Math.max(0, a); i <= b; i++) if (env[i] > mx) mx = env[i];
      return mx >= thr;
    });
  }

  /* ================= แยกบทบาท: bass / melody / harmony ================= */
  const GHOST = [12, 19, 24];
  const isGhostIv = (d) => GHOST.indexOf(d) >= 0;
  const overlap = (a, b) => Math.max(0, Math.min(a.t + a.d, b.t + b.d) - Math.max(a.t, b.t));

  // ค้นแบบ binary search บน array ที่เรียงตาม t แล้ว: index แรกที่ t ≥ x
  function lowerT(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < x) lo = m + 1; else hi = m; }
    return lo;
  }
  // โน้ตที่กำลังดังอยู่ ณ เวลา t (เริ่มก่อน t และยังไม่จบ) — sorted ตาม t, maxD = ความยาวโน้ตยาวสุด
  function soundingAt(sorted, t, maxD, skip) {
    const out = [];
    for (let i = lowerT(sorted, t - maxD - 1e-6); i < sorted.length && sorted[i].t <= t; i++) {
      const m = sorted[i];
      if (m !== skip && m.t + m.d > t) out.push(m);
    }
    return out;
  }
  const maxDur = (arr) => arr.reduce((a, n) => Math.max(a, n.d), 0);

  // ฮาร์มอนิกหลอก: สูงกว่าโน้ตอีกตัว 12/19/24 semitone, เริ่มพร้อมกัน (±40ms), ไม่ดังกว่า และ "อยู่ในเงา" ของโน้ตนั้น
  // (ยาวไม่เกินโน้ตต้นทาง) — คอร์ดจริงเป็นฮาร์มอนิกของรากเบสเสมอ (C–G–C–E) แต่มักค้างนานกว่าเบส จึงไม่ถูกตัด
  function dropGhosts(notes, refs) {
    const rs = (refs || notes).slice().sort(byT);
    return notes.filter((n) => {
      for (let i = lowerT(rs, n.t - 0.04); i < rs.length && rs[i].t <= n.t + 0.04; i++) {
        const r = rs[i];
        if (r !== n && isGhostIv(n.midi - r.midi) && n.vel <= r.vel * 1.05 && n.d <= r.d * 1.3 + 0.03 && overlap(n, r) >= 0.7 * n.d) return false;
      }
      return true;
    });
  }

  // เส้นเดียว: ตัดโน้ตที่ทับกันให้ต่อกัน (โน้ตใหม่เริ่ม → ตัวก่อนหยุด) — เริ่มพร้อมกันเลือกตามกติกา prefer
  function monophonic(notes, prefer) {
    const src = notes.slice().sort(byT);
    const out = [], dropped = [];
    for (const n0 of src) {
      const n = Object.assign({}, n0);
      const p = out[out.length - 1];
      if (p && n.t < p.t + p.d - 1e-6) {
        if (n.t - p.t < 0.05) {
          const takeNew = prefer === 'low' ? n.midi < p.midi : prefer === 'high' ? n.midi > p.midi : n.vel * n.d > p.vel * p.d;
          if (takeNew) { dropped.push(p); out[out.length - 1] = n; } else dropped.push(n);
          continue;
        }
        p.d = Math.max(0.02, n.t - p.t);
      }
      out.push(n);
    }
    return { notes: out, dropped };
  }

  function pickBass(notes, opts) {
    opts = opts || {};
    const hard = opts.bassMax != null ? opts.bassMax : 47, soft = opts.bassSoft != null ? opts.bassSoft : 55;
    const cands = [], rest = [];
    const sorted = notes.slice().sort(byT), md = maxDur(sorted);
    for (const n of sorted) {
      if (n.midi <= hard) { cands.push(n); continue; }
      if (n.midi <= soft) {
        // 48–55: เป็นเบสได้ถ้าเป็นเสียงต่ำสุด ณ ตอนนั้น และไม่ใช่ส่วนหนึ่งของคอร์ดที่ดีดพร้อมกัน
        let simult = 0;
        for (let i = lowerT(sorted, n.t - 0.05); i < sorted.length && sorted[i].t <= n.t + 0.05; i++) {
          if (sorted[i] !== n && sorted[i].midi > n.midi) simult++;
        }
        const lower = soundingAt(sorted, n.t + 0.03, md, n).some((m) => m.midi < n.midi);
        if (!lower && simult < 2) { cands.push(n); continue; }
      }
      rest.push(n);
    }
    // ghost ของเบส (ฮาร์มอนิกที่ 2/3 ของเบสที่ Basic Pitch แยกเป็นโน้ต) → ทิ้ง
    const clean = dropGhosts(cands);
    const ghosts = cands.filter((n) => clean.indexOf(n) < 0);
    const m = monophonic(clean, 'low');
    return { bass: m.notes, rest: rest.concat(m.dropped), ghosts };
  }

  // เส้นเมโลดี้: โน้ต Basic Pitch ที่ตรงกับเส้นเด่นจาก riff.js (pitch ตรง หรือออกเทฟเมื่อเริ่มพร้อมกัน)
  // เวลา/ความยาวเอาจาก Basic Pitch (แม่นกว่า) · ช่วงที่ Basic Pitch ไม่เจอแต่ riff มั่นใจ → ใช้โน้ตจาก riff
  function pickMelody(notes, line, opts) {
    opts = opts || {};
    const used = new Set();
    const mel = [];
    const sorted = notes.slice().sort(byT);
    for (const r of line) {
      const rEnd = r.t + r.d;
      let found = false;
      for (let i = lowerT(sorted, r.t - 0.08); i < sorted.length; i++) {
        const n = sorted[i];
        if (n.t > rEnd) break;
        if (used.has(n)) continue;
        const dm = n.midi - r.midi;
        const startOk = n.t >= r.t - 0.08 && n.t <= rEnd - 0.04;
        if (dm === 0 && startOk) { used.add(n); mel.push(n); found = true; continue; }
        if (Math.abs(dm) === 12 && Math.abs(n.t - r.t) <= 0.05) { used.add(n); mel.push(n); found = true; }
      }
      if (!found && (r.conf || 0) >= (opts.lineConf != null ? opts.lineConf : 0.45) && r.d >= 0.08) {
        mel.push({ t: r.t, d: r.d, midi: r.midi, vel: clamp(0.3 + 0.6 * (r.conf || 0), 0.05, 1), fromLine: true });
      }
    }
    // ทำเป็นเส้นเดียว — โน้ต Basic Pitch ที่หลุดออก (ไม่ได้อยู่ในเส้น) กลับไปเป็น harmony ผ่าน rest ด้านล่าง
    const m = monophonic(mel, 'vel');
    const melSet = new Set(m.notes.map((n) => n.t.toFixed(4) + ':' + n.midi));
    const rest = sorted.filter((n) => !melSet.has(n.t.toFixed(4) + ':' + n.midi));
    return { melody: m.notes, rest };
  }

  // ไม่มี riff.js → skyline: โน้ตสูงสุด ณ จุดเริ่ม ที่ห่างโน้ตรองลงมา ≥ 3 semitone
  function skyline(notes, minMidi) {
    const s = notes.filter((n) => n.midi >= minMidi).sort(byT);
    const md = maxDur(s);
    const mel = s.filter((n) => {
      const top = soundingAt(s, n.t + 0.03, md, n).reduce((a, m) => Math.max(a, m.midi), -1);
      return top < 0 || n.midi >= top + 3;
    });
    const m = monophonic(mel, 'high');
    const set = new Set(m.notes.map((n) => n.t.toFixed(4) + ':' + n.midi));
    return { melody: m.notes, rest: notes.filter((n) => !set.has(n.t.toFixed(4) + ':' + n.midi)) };
  }

  // เติมเส้นทำนอง: โน้ตบนสุด ณ จุดเริ่ม (สูงกว่าโน้ตอื่นที่ดังอยู่ ≥ 2 semitone) ที่อยู่ใกล้โน้ตเมโลดี้เดิม ≤ 0.8s
  // และไม่ทับโน้ตเมโลดี้ — ช่วงที่ riff หลุด (เสียงลีดเบากว่าคอร์ดชั่วขณะ) แต่ Basic Pitch เจอ
  function extendMelody(mel, pool, opts) {
    if (!mel.length) return { melody: mel, rest: pool };
    const ms = mel.slice().sort(byT);
    const lo = Math.max(opts.melodyMin != null ? opts.melodyMin : 50, quantile(ms.map((n) => n.midi), 0.1) - 3);
    const ps = pool.slice().sort(byT), md = maxDur(ps);
    const add = [];
    for (const n of ps) {
      if (n.midi < lo) continue;
      const near = ms[Math.min(ms.length - 1, lowerT(ms, n.t))], prev = ms[Math.max(0, lowerT(ms, n.t) - 1)];
      const dist = Math.min(near ? Math.abs(near.t - n.t) : 9, prev ? Math.abs(n.t - (prev.t + prev.d)) : 9);
      if (dist > (opts.extendGap != null ? opts.extendGap : 0.8)) continue;
      if (ms.some((m) => overlap(m, n) > 0.3 * Math.min(m.d, n.d))) continue;
      const top = soundingAt(ps, n.t + 0.03, md, n).reduce((a, m) => Math.max(a, m.midi), -1);
      if (top >= 0 && n.midi < top + (opts.extendIv != null ? opts.extendIv : 2)) continue;
      add.push(n);
    }
    if (!add.length) return { melody: mel, rest: pool };
    const m = monophonic(mel.concat(add), 'vel');
    const set = new Set(m.notes.map((n) => n.t.toFixed(4) + ':' + n.midi));
    return { melody: m.notes, rest: pool.filter((n) => !set.has(n.t.toFixed(4) + ':' + n.midi)) };
  }

  function splitLite(bpNotesList, line, opts) {
    opts = opts || {};
    const b = pickBass(bpNotesList, opts);
    let pool = b.rest;
    // ห้ามเมโลดี้ซ้ำกับเบส: riff เกาะเส้นเบส (หรือออกเทฟของเบส) ตอนไม่มีลีด → ตัดโน้ตของเส้นที่ pitch class
    // ตรงกับเบสที่ดังอยู่ และโน้ตที่ต่ำกว่า melodyMin (D3)
    const mMin = opts.melodyMin != null ? opts.melodyMin : 50;
    const bs = b.bass.slice().sort(byT), bmd = maxDur(bs);
    const lineOk = (line || []).filter((r) => r.midi >= mMin &&
      !soundingAt(bs, r.t + Math.min(0.05, r.d / 2), bmd, null).some((n) => ((r.midi - n.midi) % 12 + 12) % 12 === 0));
    let mres = line ? pickMelody(pool, lineOk, opts) : skyline(pool, 55);
    if (line && opts.extendMelody !== false) mres = extendMelody(mres.melody, mres.rest, opts);
    pool = mres.rest;
    // harmony: ทิ้งฮาร์มอนิกหลอกของเมโลดี้/เบส + โน้ตสั้นมากที่เบา
    let harmony = dropGhosts(pool, pool.concat(mres.melody, b.bass));
    harmony = harmony.filter((n) => n.d >= 0.06 && !(n.d < 0.1 && n.vel < 0.4));
    return { bass: b.bass, melody: mres.melody, harmony };
  }

  /* ================= quantize เข้ากริด 16th (เฉพาะที่หลักฐานจังหวะชัด) =================
     1. ปรับ BPM ละเอียด ±1.5% ให้ onset ทั้งหมดลงกริด 16th มากสุด (circular statistics)
     2. phase ของกริดหาแบบ "เฉพาะที่" (onset รอบ ๆ ±6s) — เพลงเล่นสดที่ tempo ไหลก็ยังตามทัน
     3. snap เฉพาะ onset ที่ R เฉพาะที่ ≥ 0.45 และห่างกริด ≤ 30% ของช่อง (สวิง/triplet/rubato ไม่ถูกบิด)
     4. เวลาจบโน้ตคงของจริง (ไม่ยืดเสียงหลอก) · โน้ตเส้นเดียวที่ตกช่องเดียวกันเก็บตัวเด่นกว่า */
  function quantizeTracks(tracks, bpm, phase, opts) {
    opts = opts || {};
    const res = { applied: false, bpm: bpm > 0 ? bpm : null, phase: isFinite(phase) ? phase : null, snapped: 0, total: 0 };
    if (!(bpm > 0)) return res;
    const ev = [];
    tracks.forEach((tr) => tr.notes.forEach((n) => ev.push({ t: n.t, w: (tr.kind === 'drums' ? 1.5 : 1) * Math.max(0.1, n.vel) })));
    if (ev.length < 8) return res;
    ev.sort((a, b) => a.t - b.t);
    const R = (step) => {
      let c = 0, s = 0, w = 0;
      for (const e of ev) { const a = (2 * Math.PI * e.t) / step; c += e.w * Math.cos(a); s += e.w * Math.sin(a); w += e.w; }
      return Math.sqrt(c * c + s * s) / (w || 1);
    };
    let best = { R: -1, i: 0, bpm };
    for (let i = -15; i <= 15; i++) {
      const b = bpm * (1 + i * 0.001);
      const r = R(60 / b / 4);
      if (r > best.R + 1e-9 || (Math.abs(r - best.R) <= 1e-9 && Math.abs(i) < Math.abs(best.i))) best = { R: r, i, bpm: b };
    }
    const step = 60 / best.bpm / 4;
    res.bpm = Math.round(best.bpm * 100) / 100;
    res.R = Math.round(best.R * 100) / 100;
    // phase เฉพาะที่ด้วย two-pointer บนผลรวมสะสม
    const n = ev.length;
    const cs = new Float64Array(n + 1), sn = new Float64Array(n + 1), ws = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * ev[i].t) / step;
      cs[i + 1] = cs[i] + ev[i].w * Math.cos(a); sn[i + 1] = sn[i] + ev[i].w * Math.sin(a); ws[i + 1] = ws[i] + ev[i].w;
    }
    const HW = opts.window != null ? opts.window : 6;
    const lowerIdx = (t) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].t < t) lo = m + 1; else hi = m; } return lo; };
    const localGrid = (t) => {
      const a = lowerIdx(t - HW), b = lowerIdx(t + HW + 1e-9);
      const c = cs[b] - cs[a], s = sn[b] - sn[a], w = ws[b] - ws[a];
      if (b - a < 6 || w <= 0) return null;
      return { R: Math.sqrt(c * c + s * s) / w, phi: (Math.atan2(s, c) / (2 * Math.PI)) * step };
    };
    const rMin = opts.minR != null ? opts.minR : 0.45, devMax = opts.maxDev != null ? opts.maxDev : 0.3;
    const snapT = (t) => {
      const g = localGrid(t);
      if (!g || g.R < rMin) return null;
      const k = Math.round((t - g.phi) / step);
      const q = g.phi + k * step;
      if (Math.abs(t - q) > devMax * step) return null;
      return Math.max(0, q);
    };
    // beat ไหนใน 4 ช่อง 16th: kick/snare (หรือโน้ตทั้งหมดถ่วงความยาว) ตกช่องไหนบ่อยสุด
    const g0 = { phi: (Math.atan2(sn[n], cs[n]) / (2 * Math.PI)) * step };
    const sc = [0, 0, 0, 0];
    const drums = tracks.find((t) => t.kind === 'drums');
    const beatEv = drums ? drums.notes.filter((x) => x.midi === GM.KICK || x.midi === GM.SNARE) : [];
    (beatEv.length >= 4 ? beatEv : ev.map((e) => ({ t: e.t, vel: e.w, d: 0.15 }))).forEach((x) => {
      const k = ((Math.round((x.t - g0.phi) / step) % 4) + 4) % 4;
      sc[k] += (x.vel || 0.5) * (beatEv.length >= 4 ? 1 : 1 + Math.min(4, (x.d || 0) / step));
    });
    let bk = 0;
    for (let k = 1; k < 4; k++) if (sc[k] > sc[bk]) bk = k;
    const beat = step * 4;
    let origin = g0.phi + bk * step;
    origin = ((origin % beat) + beat) % beat;
    res.phase = Math.round(origin * 1000) / 1000;

    tracks.forEach((tr) => {
      const mono = tr.mono;
      const out = [];
      tr.notes.forEach((nn) => {
        res.total++;
        const q = snapT(nn.t);
        const n2 = Object.assign({}, nn);
        if (q != null) {
          const end = nn.t + nn.d;
          n2.t = q; n2.d = Math.max(0.03, end - q);
          res.snapped++;
        }
        out.push(n2);
      });
      out.sort(byT);
      // ตกจุดเดียวกัน: กลองชิ้นเดียวกัน / แทร็กเส้นเดียว → เก็บตัวเด่น
      const ded = [];
      for (const x of out) {
        const p = ded[ded.length - 1];
        const same = p && Math.abs(p.t - x.t) < 1e-4 && (mono || p.midi === x.midi);
        if (same) { if (x.vel * x.d > p.vel * p.d) ded[ded.length - 1] = x; continue; }
        ded.push(x);
      }
      if (mono) for (let i = 0; i + 1 < ded.length; i++) if (ded[i].t + ded[i].d > ded[i + 1].t) ded[i].d = Math.max(0.02, ded[i + 1].t - ded[i].t);
      tr.notes = ded;
    });
    res.applied = true;
    return res;
  }

  /* ================= ประกอบ TrackSet ================= */
  function cleanNote(n) {
    return { t: r3(Math.max(0, n.t)), d: r3(Math.max(0.01, n.d)), midi: Math.round(clamp(n.midi, 0, 127)), vel: Math.round(clamp(n.vel, 0, 1) * 100) / 100 };
  }
  function makeTrack(id, notes, extra) {
    return Object.assign({ id, kind: KIND[id] || 'pitched', program: PROGRAM[id] != null ? PROGRAM[id] : 0, notes: notes.slice().sort(byT) }, extra || {});
  }
  function finalize(source, raw, opts) {
    opts = opts || {};
    const duration = r3(opts.duration || 0);
    const tracks = raw.filter((t) => t.notes && t.notes.length);
    let q = { applied: false, bpm: opts.bpm > 0 ? opts.bpm : null, phase: isFinite(opts.phase) ? opts.phase : null };
    if (opts.quantize !== false && opts.bpm > 0) q = quantizeTracks(tracks, +opts.bpm, +opts.phase || 0, opts.qOpts);
    tracks.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    const ts = {
      v: 1, source,
      bpm: q.bpm != null ? Math.round(q.bpm * 100) / 100 : null,
      phase: q.phase != null ? Math.round(q.phase * 1000) / 1000 : null,
      duration,
      tracks: tracks.map((t) => ({
        id: t.id, kind: t.kind, program: t.program,
        notes: t.notes.filter((n) => n.t < duration + 0.5 || !duration).map(cleanNote).sort((a, b) => a.t - b.t || a.midi - b.midi),
      })).filter((t) => t.notes.length),
    };
    return { ts, quant: q };
  }

  /* ================= โหมด lite ================= */
  // x: mono 22050Hz · opts.runBP (ดู bpPosteriors) · opts.bpm/phase · tick/chk/onPct(frac, key)
  async function lite(x, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop;
    const onPct = opts.onPct || noop;
    const sr = BP.SR;
    const duration = opts.duration || x.length / sr;
    const tm = {};
    let t0 = Date.now();
    onPct(0, 'hpss');
    const hp = await hpss(x, sr, { tick, chk, onPct: (f) => onPct(0.18 * f, 'hpss'), hMargin: opts.hMargin });
    tm.hpss = Date.now() - t0; t0 = Date.now();
    onPct(0.18, 'drums');
    const drums = await detectDrums(hp, { tick, chk, onPct: (f) => onPct(0.18 + 0.04 * f, 'drums') });
    tm.drums = Date.now() - t0; t0 = Date.now();
    chk();
    onPct(0.22, 'notes');
    const post = await bpPosteriors(hp.harmonic, opts.runBP, { tick, chk, batch: opts.batch, onPct: (f) => onPct(0.22 + 0.5 * f, 'notes') });
    let notes = bpNotes(post, opts.bpOpts);
    notes = gateNotes(notes, hp.harmonic, sr, 40);
    tm.bp = Date.now() - t0; t0 = Date.now();
    chk();
    onPct(0.72, 'melody');
    let line = null;
    const Riff = opts.riff === false ? null : getRiff();
    if (Riff) {
      const h11 = decimate(hp.harmonic, 2);
      const rr = await Riff.extract(h11, sr / 2, { tick, chk, onPct: (f) => onPct(0.72 + 0.24 * f, 'melody') });
      line = rr.notes;
    }
    tm.riff = Date.now() - t0; t0 = Date.now();
    const sp = splitLite(notes, line, opts);
    const raw = [
      makeTrack('drums', drums),
      makeTrack('bass', sp.bass, { mono: true }),
      makeTrack('melody', sp.melody, { mono: true }),
      makeTrack('harmony', sp.harmony),
    ];
    const fin = finalize('lite', raw, { duration, bpm: opts.bpm, phase: opts.phase, quantize: opts.quantize, qOpts: opts.qOpts });
    tm.split = Date.now() - t0;
    onPct(1, 'done');
    return Object.assign(fin.ts, { _debug: opts.debug ? { tm, quant: fin.quant, bpWindows: post.windows, bpRan: post.ran, rawNotes: notes.length, line: line ? line.length : null } : undefined });
  }

  /* ================= แก้กราฟ Demucs ตอนโหลด: iSTFT จาก ConvTranspose → MatMul + overlap-add =================
     โมเดล ONNX ฝัง inverse STFT เป็น ConvTranspose 2 ตัว (kernel 4096, stride 1024) — kernel ConvTranspose ของ
     WebGPU ช้ามาก (วัดบน GTX 1070 Ti: 3.9 จาก 4.8 วินาทีต่อหน้าต่าง) ทั้งที่คณิตศาสตร์คือ matmul ธรรมดา:
       ConvTranspose(X[n,C,T], W[C,1,K], stride S) = overlap-add( (Xᵀ · W[C,K]) แบ่งเป็น K/S ช่วง ยาว S )
     จึงเขียนกราฟใหม่: Transpose → MatMul (×2 สาขา) → Add → Reshape [n,T,K/S,S] → Gather ทีละช่วง → Pad เลื่อน → Add
     ผลลัพธ์ชื่อเดิม (/real_istft/Add_output_0) → โหนดถัดไปไม่ต้องแก้ · ผลเท่าเดิม (เทสต์: ต่างสูงสุด ~1e-5)
     แก้ protobuf ตรง ๆ แบบไม่ต้องมีไลบรารี: คัดลอกช่วงไบต์เดิม + แทรกโหนด/initializer ใหม่ — คืน null ถ้าโครงสร้างไม่ตรง */
  const PB = (() => {
    function rdVar(b, p) {
      let x = 0, s = 1, c;
      do { c = b[p++]; x += (c & 127) * s; s *= 128; } while (c & 128);
      return [x, p];
    }
    function fields(b, a, e) {
      const out = [];
      let p = a;
      while (p < e) {
        const s = p;
        let k;
        [k, p] = rdVar(b, p);
        const f = Math.floor(k / 8), w = k & 7;
        if (w === 0) { let v; [v, p] = rdVar(b, p); out.push({ f, w, v, s, e: p }); }
        else if (w === 2) { let L; [L, p] = rdVar(b, p); out.push({ f, w, a: p, b: p + L, s, e: p + L }); p += L; }
        else if (w === 5) { out.push({ f, w, s, e: p + 4 }); p += 4; }
        else if (w === 1) { out.push({ f, w, s, e: p + 8 }); p += 8; }
        else throw new Error('protobuf wire type ' + w);
      }
      return out;
    }
    const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    const str = (b, x) => (td ? td.decode(b.subarray(x.a, x.b)) : Buffer.from(b.subarray(x.a, x.b)).toString('utf8'));
    const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const utf8 = (s) => (te ? te.encode(s) : Uint8Array.from(Buffer.from(s, 'utf8')));
    function varint(n) {
      const o = [];
      while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); }
      o.push(n);
      return Uint8Array.from(o);
    }
    function cat(parts) {
      let n = 0;
      parts.forEach((p) => { n += p.length; });
      const out = new Uint8Array(n);
      let o = 0;
      parts.forEach((p) => { out.set(p, o); o += p.length; });
      return out;
    }
    const key = (f, w) => varint(f * 8 + w);
    const fLen = (f, bytes) => cat([key(f, 2), varint(bytes.length), bytes]);
    const fStr = (f, s) => fLen(f, utf8(s));
    const fVar = (f, v) => cat([key(f, 0), varint(v)]);
    // ค่า int64 ติดลบเป็น varint 10 ไบต์ (two's complement)
    function i64(v) {
      if (v >= 0) return varint(v);
      let x = BigInt.asUintN(64, BigInt(v));
      const o = [];
      while (x >= 128n) { o.push(Number(x & 127n) | 128); x >>= 7n; }
      o.push(Number(x));
      return Uint8Array.from(o);
    }
    function attrInt(name, v) { return fLen(5, cat([fStr(1, name), fVar(20, 2), cat([key(3, 0), i64(v)])])); }
    function attrInts(name, arr) { return fLen(5, cat([fStr(1, name), fVar(20, 7)].concat(arr.map((v) => cat([key(8, 0), i64(v)]))))); }
    function node(op, name, ins, outs, attrs) {
      return fLen(1, cat(ins.map((s) => fStr(1, s)).concat(outs.map((s) => fStr(2, s)), [fStr(3, name), fStr(4, op)], attrs || [])));
    }
    function initI64(name, dims, vals) {
      const raw = new Uint8Array(vals.length * 8);
      const dv = new DataView(raw.buffer);
      vals.forEach((v, i) => dv.setBigInt64(i * 8, BigInt(v), true));
      return fLen(5, cat(dims.map((d) => fVar(1, d)).concat([fVar(2, 7), fStr(8, name), fLen(9, raw)])));
    }
    return { rdVar, fields, str, varint, cat, key, fLen, node, initI64, attrInt, attrInts };
  })();

  function patchDemucsIstft(bytes) {
    try {
      const b = bytes;
      const top = PB.fields(b, 0, b.length);
      const g = top.find((x) => x.f === 7 && x.w === 2);
      if (!g) return null;
      const gf = PB.fields(b, g.a, g.b);
      const info = gf.map((x) => {
        if (x.f !== 1 || x.w !== 2) return null;
        const nf = PB.fields(b, x.a, x.b);
        const get = (f) => nf.filter((y) => y.f === f && y.w === 2).map((y) => PB.str(b, y));
        const attrs = {};
        nf.filter((y) => y.f === 5).forEach((y) => {
          const af = PB.fields(b, y.a, y.b);
          const nm = af.find((z) => z.f === 1);
          if (!nm) return;
          const ints = [];
          af.filter((z) => z.f === 8).forEach((z) => {
            if (z.w === 0) ints.push(z.v);
            else if (z.w === 2) { let p = z.a; while (p < z.b) { let v; [v, p] = PB.rdVar(b, p); ints.push(v); } }
          });
          const one = af.find((z) => z.f === 3 && z.w === 0);
          attrs[PB.str(b, nm)] = ints.length ? ints : one ? [one.v] : [];
        });
        return { op: (get(4)[0] || ''), name: (get(3)[0] || ''), ins: get(1), outs: get(2), attrs };
      });
      const cts = [];
      info.forEach((n, i) => { if (n && n.op === 'ConvTranspose' && /istft/i.test(n.name)) cts.push(i); });
      if (cts.length !== 2) return null;
      const A = info[cts[0]], B = info[cts[1]];
      const addIdx = info.findIndex((n) => n && n.op === 'Add' && n.ins.length === 2 &&
        n.ins.indexOf(A.outs[0]) >= 0 && n.ins.indexOf(B.outs[0]) >= 0);
      if (addIdx < 0) return null;
      // ต้องเป็นกรณีธรรมดา: 1 มิติ, ไม่มี pad/dilation/group, kernel หารด้วย stride ลงตัว, ผลไม่ถูกใช้ที่อื่น
      const K = (A.attrs.kernel_shape || [])[0], S = (A.attrs.strides || [])[0];
      const plain = (n) => (n.attrs.kernel_shape || []).length === 1 && n.attrs.kernel_shape[0] === K && (n.attrs.strides || [])[0] === S &&
        !(n.attrs.pads || []).some((v) => v) && !(n.attrs.dilations || [1]).some((v) => v !== 1) && !((n.attrs.group || [1])[0] > 1) &&
        !(n.attrs.output_padding || []).some((v) => v) && n.ins.length === 2;
      if (!K || !S || K % S || !plain(A) || !plain(B)) return null;
      const used = (name) => info.some((n, i) => n && i !== addIdx && n.ins.indexOf(name) >= 0);
      if (used(A.outs[0]) || used(B.outs[0])) return null;
      const R = K / S, P = '/aq_istft/';
      const out = info[addIdx].outs[0];
      const nodes = [], inits = [];
      inits.push(PB.initI64(P + 'shape_w', [2], [0, -1]));
      inits.push(PB.initI64(P + 'shape_f', [4], [0, 0, R, S]));
      inits.push(PB.initI64(P + 'shape_r', [3], [0, 1, -1]));
      [A, B].forEach((n, k) => {
        nodes.push(PB.node('Transpose', P + 'T' + k, [n.ins[0]], [P + 'T' + k + '_out'], [PB.attrInts('perm', [0, 2, 1])]));
        nodes.push(PB.node('Reshape', P + 'W' + k, [n.ins[1], P + 'shape_w'], [P + 'W' + k + '_out']));
        nodes.push(PB.node('MatMul', P + 'M' + k, [P + 'T' + k + '_out', P + 'W' + k + '_out'], [P + 'M' + k + '_out']));
      });
      nodes.push(PB.node('Add', P + 'Msum', [P + 'M0_out', P + 'M1_out'], [P + 'Msum_out']));
      nodes.push(PB.node('Reshape', P + 'F', [P + 'Msum_out', P + 'shape_f'], [P + 'F_out']));
      for (let j = 0; j < R; j++) {
        inits.push(PB.initI64(P + 'idx' + j, [], [j]));
        inits.push(PB.initI64(P + 'pad' + j, [6], [0, 0, j * S, 0, 0, (R - 1 - j) * S]));
        nodes.push(PB.node('Gather', P + 'G' + j, [P + 'F_out', P + 'idx' + j], [P + 'G' + j + '_out'], [PB.attrInt('axis', 2)]));
        nodes.push(PB.node('Reshape', P + 'R' + j, [P + 'G' + j + '_out', P + 'shape_r'], [P + 'R' + j + '_out']));
        nodes.push(PB.node('Pad', P + 'P' + j, [P + 'R' + j + '_out', P + 'pad' + j], [P + 'P' + j + '_out']));
      }
      let acc = P + 'P0_out';
      for (let j = 1; j < R; j++) {
        const o = j === R - 1 ? out : P + 'S' + j + '_out';
        nodes.push(PB.node('Add', P + 'S' + j, [acc, P + 'P' + j + '_out'], [o]));
        acc = o;
      }
      if (R === 1) nodes.push(PB.node('Identity', P + 'S1', [acc], [out]));
      // ประกอบกราฟใหม่: ตัดโหนดเดิม 3 ตัว แทรกโหนดใหม่ตรงตำแหน่ง Add (หลัง Gather ที่ป้อนเข้าแล้ว — ยังเรียงตาม topology)
      const parts = [];
      gf.forEach((x, i) => {
        if (i === cts[0] || i === cts[1]) return;
        if (i === addIdx) { nodes.forEach((n) => parts.push(n)); return; }
        parts.push(b.subarray(x.s, x.e));
      });
      inits.forEach((t) => parts.push(t));
      const graph = PB.cat(parts);
      const outParts = [];
      top.forEach((x) => {
        if (x === g) { outParts.push(PB.key(7, 2), PB.varint(graph.length), graph); return; }
        outParts.push(b.subarray(x.s, x.e));
      });
      return PB.cat(outParts);
    } catch (e) {
      return null;
    }
  }

  /* ================= โหมด full: แยก stem (Demucs) ================= */
  const DM = { SR: 44100, N: 343980, STEMS: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] };
  DM.OV = Math.floor(DM.N / 4);
  DM.STRIDE = DM.N - DM.OV;

  /* L,R: stereo 44.1kHz · runDemucs(Float32Array(2·N) [L|R]) → Promise<Float32Array(6·2·N)> ลำดับ [stem][ch][n]
     overlap-add แบบ infer.py (fade เชิงเส้น 25%) แล้วลดเหลือ mono 22050Hz ทีละหน้าต่าง (เส้นตรง → ผลเท่ากับลดทีหลัง)
     RAM: เก็บแค่ 6 stem × 22050Hz (เพลง 4 นาที ≈ 127MB) ไม่เก็บ 44.1kHz สเตอริโอทั้ง 6 (≈ 500MB) */
  async function separate(L, R, runDemucs, opts) {
    opts = opts || {};
    const chk = opts.chk || noop, onPct = opts.onPct || noop, tick = opts.tick || noTick;
    const N = DM.N, OV = DM.OV, ST = DM.STRIDE;
    const total = L.length;
    const nCh = Math.max(1, Math.ceil(total / ST));
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 1;
    for (let i = 0; i < OV; i++) { const v = OV > 1 ? i / (OV - 1) : 1; win[i] = v; win[N - 1 - i] = v; }
    const out22 = Math.floor(total / 2);
    const num = DM.STEMS.map(() => new Float32Array(out22));
    const den = new Float32Array(out22);
    const h = decH2 || (decH2 = sincLP(0.45 / 2, DEC_TAPS));
    const half = (DEC_TAPS - 1) >> 1;
    const inp = new Float32Array(2 * N);
    const mono = new Float32Array(N);
    for (let ci = 0; ci < nCh; ci++) {
      chk();
      const start = ci * ST, end = Math.min(start + N, total), clen = end - start;
      inp.fill(0);
      inp.set(L.subarray(start, end), 0);
      inp.set(R.subarray(start, end), N);
      const o = await runDemucs(inp, ci, nCh);
      chk();
      const j0 = start & 1;
      for (let s = 0; s < DM.STEMS.length; s++) {
        const a = (s * 2) * N, b = (s * 2 + 1) * N;
        for (let j = 0; j < clen; j++) mono[j] = 0.5 * (o[a + j] + o[b + j]) * win[j];
        const dst = num[s];
        for (let j = j0; j < clen; j += 2) {
          const g = (start + j) >> 1;
          if (g >= out22) break;
          let acc = 0;
          if (j - half >= 0 && j + half < clen) {
            for (let k = 0, q = j - half; k < DEC_TAPS; k++, q++) acc += mono[q] * h[k];
          } else {
            for (let k = 0; k < DEC_TAPS; k++) { const q = j + k - half; if (q >= 0 && q < clen) acc += mono[q] * h[k]; }
          }
          dst[g] += acc;
        }
      }
      for (let j = j0; j < clen; j += 2) { const g = (start + j) >> 1; if (g < out22) den[g] += win[j]; }
      onPct((ci + 1) / nCh, ci + 1, nCh);
      await tick();
    }
    const stems = {};
    DM.STEMS.forEach((nm, s) => {
      const x = num[s];
      for (let i = 0; i < out22; i++) x[i] = den[i] > 1e-4 ? x[i] / den[i] : x[i];
      stems[nm] = x;
    });
    // มีเสียงจริงไหม: p95 ของ RMS 0.5s เทียบผลรวมทุก stem (−30dB)
    const mixEnv = rmsEnvelope(mixdown(DM.STEMS.map((nm) => stems[nm])), BP.SR, 0.5).env;
    const mixRef = quantile(mixEnv, 0.95) * DM.STEMS.length; // mixdown หารด้วยจำนวน stem
    const level = {}, present = {};
    DM.STEMS.forEach((nm) => {
      const r = quantile(rmsEnvelope(stems[nm], BP.SR, 0.5).env, 0.95);
      level[nm] = mixRef > 0 ? Math.round(20 * Math.log10(Math.max(1e-9, r / mixRef)) * 10) / 10 : -120;
      present[nm] = level[nm] > (opts.presentDb != null ? opts.presentDb : -30);
    });
    return { stems, sr: BP.SR, level, present, chunks: nCh };
  }

  // stem → ช่วงอื่น ๆ ที่ pipeline ใช้
  function instrumental11k(stems) {
    const n = stems.bass.length;
    const m = new Float32Array(n);
    ['bass', 'guitar', 'piano', 'other'].forEach((k) => { const s = stems[k]; for (let i = 0; i < n; i++) m[i] += s[i]; });
    return decimate(m, 2);
  }

  // โน้ตเดียวกัน (pitch ตรง, เริ่ม ±50ms, ทับกัน ≥ 50%) โผล่หลาย stem = เสียงรั่ว (Demucs แบ่งเสียงเดียวกันให้หลาย stem)
  // → เก็บไว้ในแทร็กที่ดังกว่า (เส้นทำนอง/เบสได้เปรียบเล็กน้อย) ตัดออกจากแทร็กอื่น
  function dedupeAcross(raw) {
    const pitched = raw.filter((t) => t.kind !== 'drums');
    const pri = { vocals: 1.15, melody: 1.15, bass: 1.1 };
    const all = [];
    pitched.forEach((tr, ti) => tr.notes.forEach((n) => all.push({ n, ti, w: n.vel * (pri[tr.id] || 1) })));
    all.sort((a, b) => a.n.t - b.n.t);
    const drop = new Set();
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (drop.has(a)) continue;
      for (let j = i + 1; j < all.length && all[j].n.t - a.n.t <= 0.05; j++) {
        const b = all[j];
        if (b.ti === a.ti || drop.has(b) || b.n.midi !== a.n.midi) continue;
        if (overlap(a.n, b.n) < 0.5 * Math.min(a.n.d, b.n.d)) continue;
        if (a.w >= b.w) drop.add(b); else { drop.add(a); break; }
      }
    }
    if (!drop.size) return;
    const dn = new Set(Array.from(drop).map((x) => x.n));
    pitched.forEach((tr) => { tr.notes = tr.notes.filter((n) => !dn.has(n)); });
  }

  /* ================= โหมด full: stem → แทร็ก =================
     drums → detectDrums · bass → Basic Pitch → เส้นเดียว (เสียงต่ำสุด) · guitar/piano/other → Basic Pitch (หลายเสียง)
     vocals → เส้นทำนองร้อง (Basic Pitch ∩ เส้นเด่นของ riff.js) — ไม่มีเสียงร้อง (เพลงบรรเลง) → หาเส้นทำนอง
     จาก stem ที่ "เป็นเส้นเดียว" มากที่สุดใน guitar/piano/other แล้วย้ายโน้ตเหล่านั้นไปแทร็ก melody */
  async function fromStems(sep, opts) {
    opts = opts || {};
    const tick = opts.tick || noTick, chk = opts.chk || noop, onPct = opts.onPct || noop;
    const { stems, present } = sep;
    const sr = BP.SR;
    const duration = opts.duration || stems.drums.length / sr;
    const Riff = opts.riff === false ? null : getRiff();
    const raw = [];
    const tm = {};
    let t0 = Date.now();
    const pitched = ['bass', 'vocals', 'guitar', 'piano', 'other'].filter((k) => present[k]);
    const wt = { drums: 0.6, bass: 1, vocals: 1.8, guitar: 1, piano: 1, other: 1, melody: 1.5 };
    const jobs = (present.drums ? ['drums'] : []).concat(pitched, Riff && !present.vocals ? ['melody'] : []);
    const totW = jobs.reduce((s, k) => s + wt[k], 0) || 1;
    let acc = 0;
    const span = (k) => { const a = acc / totW, b = (acc + wt[k]) / totW; return (f) => onPct(a + (b - a) * clamp(f, 0, 1), k); };
    const done = (k) => { tm[k] = Date.now() - t0; t0 = Date.now(); acc += wt[k]; };
    if (present.drums) {
      chk();
      const P = span('drums'); P(0);
      raw.push(makeTrack('drums', await drumsFromSignal(stems.drums, sr, { tick, chk, onPct: P, blend: 0 })));
      done('drums');
    }
    const poly = {};
    let melody = null;
    for (const k of pitched) {
      chk();
      const P = span(k); P(0);
      const x = stems[k];
      const post = await bpPosteriors(x, opts.runBP, { tick, chk, batch: opts.batch, gateDb: 40, onPct: (f) => P(k === 'vocals' && Riff ? 0.55 * f : f) });
      const bo = Object.assign({}, opts.bpOpts);
      if (k === 'bass') bo.maxMidi = 67;
      let notes = gateNotes(bpNotes(post, bo), x, sr, 35);
      if (k === 'bass') {
        raw.push(makeTrack('bass', monophonic(dropGhosts(notes), 'low').notes, { mono: true }));
      } else if (k === 'vocals') {
        let mel;
        if (Riff) {
          const rr = await Riff.extract(decimate(x, 2), sr / 2, { tick, chk, onPct: (f) => P(0.55 + 0.45 * f) });
          const pm = pickMelody(notes, rr.notes.filter((r) => r.midi >= 45), opts);
          mel = extendMelody(pm.melody, pm.rest, opts).melody;
        } else mel = monophonic(notes, 'vel').notes;
        raw.push(makeTrack('vocals', mel, { mono: true }));
      } else {
        poly[k] = dropGhosts(notes).filter((n) => n.d >= 0.06 && !(n.d < 0.1 && n.vel < 0.4));
      }
      done(k);
    }
    // เพลงบรรเลง: เส้นทำนองจาก stem ที่เป็นเส้นเดียวชัดที่สุด
    if (Riff && !present.vocals) {
      const P = span('melody'); P(0);
      const cands = Object.keys(poly).filter((k) => poly[k].length >= 8);
      let best = null;
      for (let i = 0; i < cands.length; i++) {
        chk();
        const k = cands[i];
        const rr = await Riff.extract(decimate(stems[k], 2), sr / 2, { tick, chk, onPct: (f) => P((i + f) / cands.length) });
        if (!rr.notes.length) continue;
        const pm = pickMelody(poly[k], rr.notes.filter((r) => r.midi >= (opts.melodyMin != null ? opts.melodyMin : 50)), opts);
        const ex = extendMelody(pm.melody, pm.rest, opts);
        const fromBP = ex.melody.filter((n) => !n.fromLine).length;
        const score = fromBP * (rr.monoRatio >= 0.28 ? 1 : 0.3);
        if (fromBP >= 8 && (!best || score > best.score)) best = { k, score, melody: ex.melody, rest: ex.rest };
      }
      if (best) { melody = best.melody; poly[best.k] = best.rest; }
      done('melody');
    }
    if (melody) raw.push(makeTrack('melody', melody, { mono: true }));
    Object.keys(poly).forEach((k) => raw.push(makeTrack(k, poly[k])));
    dedupeAcross(raw);
    const fin = finalize('full', raw, { duration, bpm: opts.bpm, phase: opts.phase, quantize: opts.quantize, qOpts: opts.qOpts });
    onPct(1, 'done');
    return Object.assign(fin.ts, { _debug: opts.debug ? { tm, quant: fin.quant, level: sep.level, present } : undefined });
  }

  return {
    GM, PROGRAM, BP, DM, BAND_EDGES,
    decimate, resample, mixdown, rmsEnvelope,
    hpss, detectDrums, drumsFromSignal,
    bpFrameTime, bpPosteriors, bpNotes, gateNotes,
    splitLite, pickBass, pickMelody, monophonic, dropGhosts, quantizeTracks, finalize, makeTrack,
    lite, separate, instrumental11k, fromStems, patchDemucsIstft,
    _pb: PB,
  };
});
