/* practice.js — ฝึกเล่นกับไมค์: ฟังกีตาร์ผ่านไมโครโฟน แล้วตัดสินว่าเล่นโน้ต/คอร์ดถูกและตรงจังหวะไหม
   เสียงประมวลผลบนเครื่องเท่านั้น — ไฟล์นี้ไม่มี fetch/XHR/WebSocket ใด ๆ ไม่มีการอัปโหลดเสียง
   ใช้ได้ทั้งเบราว์เซอร์ (window.Practice) และ Node (module.exports → tools/test-practice.cjs)
   ไม่แตะ DOM — UI อยู่ฝั่ง app.js

   ท่อสัญญาณ
   mic (echoCancellation/noiseSuppression/autoGainControl = ปิด) → AudioWorklet (เฉลี่ยทุกช่อง +
   low-pass Butterworth อันดับ 6 + decimate เหลือ ~11–16kHz แล้วส่งก้อน ~10.7ms กลับ main thread
   แบบวน buffer pool) → analyzer ทุก hop (~10.7ms):
     1. level = RMS dBFS (หน้าต่าง ~21ms) + noise floor แบบ min-statistics 3 วินาที → gate
     2. onset = SuperFlux (log-magnitude, FFT ~21ms, lag 2 เฟรม, max-filter ±1 bin) + threshold ปรับตัว
        (median) + ต้องดังขึ้นจริง ≥0.5dB → เวลาละเอียดด้วย energy envelope (~1ms)
     3. pitch = YIN (CMND + parabolic) ย่าน ~70–1500Hz (E2…F#6) + กันผิดออกเทฟด้วยสเปกตรัม +
        ขัดความถี่ด้วยยอดฮาร์มอนิกจาก FFT ยาว
     4. chroma = ยอดสเปกตรัมจาก FFT ~93ms + harmonic attribution (ยอดที่เป็นฮาร์มอนิกจำนวนเต็มของยอด
        ที่ต่ำกว่าถูกโอนพลังงานคืนให้ fundamental) → ตัดสินคอร์ดด้วย pitch class ไม่สนท่าจับ
        + chromaOn/noteOn = เฉพาะ "ส่วนที่ดังขึ้นหลัง onset" (หักสเปกตรัมก่อน onset) → โน้ต/คอร์ดเก่า
        ที่ยังดังค้างไม่ปนการตัดสินโน้ต/คอร์ดใหม่
   follower: onset (หรือ pitch เปลี่ยนแบบ legato) → "attack" เก็บหลักฐาน ~150ms (median pitch, chroma,
   พลังงานใหม่ตามโน้ต, YIN d'(τ) เฉลี่ย) → จับคู่กับ event ในหน้าต่างเวลา (timed) หรือรอจนเล่นถูก (wait)
   คอร์ดที่รอบแรกไม่ผ่านจะดูซ้ำที่ ~350ms (คอร์ดเก่าที่ค้างจางแล้ว) — เวลา dt ยังนับจาก onset เดิม
   hot path ต่อเฟรม (analyzer + follower) ไม่จองหน่วยความจำใหม่ — ใช้ typed array ที่จองไว้ตอนสร้าง
   เทสต์: node tools/test-practice.cjs

   API (เบราว์เซอร์)
   Practice.available() → { ok, reason, worklet }   reason: insecure|no-getusermedia|no-audiocontext|no-processor
   Practice.permission() → Promise<'granted'|'denied'|'prompt'|'unknown'> · Practice.devices() → [{deviceId,label}]
   Practice.open({ audioContext, onFrame, onError, deviceId, a4, gateDb, echoCancellation, forceScriptProcessor, signal })
     → Promise<session>  (เรียกใน user gesture; ส่ง Music.audioCtx() มาเพื่อใช้นาฬิกาเดียวกับเสียงที่แอปเล่น)
     error.code: denied|no-mic|busy|insecure|aborted|ctx-closed|failed · เรียกซ้ำระหว่างเปิดอยู่ = ได้ session เดิม
   onFrame(f) ทุก ~10.7ms — f ถูกใช้ซ้ำ (copy ถ้าจะเก็บ): { t, level(dBFS), gate, midi|null, hz, cents, conf,
     chroma(Float32Array 12, max=1), onset, onsetT, tuneCents, … }
   session: { audioContext, sampleRate, analysisRate, worklet, clockShared, deviceLabel, latencyMs, estimatedLatencyMs,
     calibration, stats, onFrame, onError, follow(), calibrate(), close(), closed }
   session.follow(expected, opts) → ctrl
     expected: [{ t, d, midi }] (หลายตัว t เดียวกัน = ท่าจับ/คอร์ดแบบโน้ต) หรือ [{ t, d, chord: 'Am7' }] (ปนกันได้)
     opts: mode 'timed'|'wait', tempo (0.5–1.25), startAt (วินาทีเพลง), at (เวลา ctx ที่ startAt เริ่ม; ค่าเริ่มต้น = ตอนนี้),
           leadIn, latencyMs (ค่าเริ่มต้น session.latencyMs ?? estimatedLatencyMs), windowMs (100), okFactor (2.5),
           allowOctave, autoTune (true), chordThreshold (0.55),
           onJudge({ i, idx, t, kind, result:'hit'|'miss'|'early'|'late', dtMs, played, skipped? }),
           onAttempt({ i, ok:false, played, dtMs }), onTime(songT), onWait({ i, idx, t }), onDone(summary)
     ctrl: { stop()→summary, pause(), resume(), skip(), summary(), songTime(ctxT), ctxTimeOf(songT), done, waiting, paused }
     summary: { mode, tempo, total, judged, hits, early, late, misses, skipped, extras, accuracy, onTimeRate, avgDtMs, avgAbsDtMs, stopped? }
   session.calibrate({ volume }) → Promise<latencyMs|null>  (null = ไม่ได้ยิน/ไม่นิ่ง เช่นใส่หูฟัง; ดู session.calibration.reason)
   session.close() — หยุด track ไมค์ ถอด node (ไม่ปิด AudioContext ของแอป) */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.Practice = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const mod12 = (n) => ((n % 12) + 12) % 12;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const nearestPow2 = (x) => 1 << Math.round(Math.log2(Math.max(2, x)));
  const midiName = (m) => { const r = Math.round(m); return SHARP[mod12(r)] + (Math.floor(r / 12) - 1); };

  /* ---------------- พารามิเตอร์ (จูนกับ tools/test-practice.cjs) ---------------- */
  const P = {
    hopSec: 0.0107,        // ระยะห่างเฟรมวิเคราะห์
    shortSec: 0.0213,      // FFT สั้น (onset + level)
    longSec: 0.0853,       // FFT ยาว (chroma + ขัด pitch)
    fmin: 70, fmax: 1500,  // ย่าน pitch (E2 = 82Hz … E6 = 1319Hz)
    yinTh: 0.15,           // YIN absolute threshold
    gamma: 200,            // log compression ของ flux
    fluxDelta: 0.012,      // flux ขั้นต่ำ (หลัง normalize ต่อ bin)
    fluxK: 2.2,            // คูณ median ของ flux ย้อนหลัง
    mioi: 0.08,            // ระยะห่างขั้นต่ำระหว่าง onset (สายสุดท้ายของสตรัมกว้าง ~50–70ms ไม่นับเป็นโน้ตใหม่; 16th @185bpm ยังแยกได้)
    onsetBias: 0,          // ชดเชยเวลา onset (วินาที) — วัดจากเทสต์
    onsetRiseDb: 0.5,      // onset ต้องทำให้ระดับดังขึ้นอย่างน้อยเท่านี้ (เทียบ 4 เฟรมก่อน)…
    onsetStrongK: 2.2,     // …เว้นแต่ flux เกิน threshold กี่เท่า
    gateAbs: -66, gateCap: -42, gateOverFloor: 9,
    peakRelDb: 40, maxPeaks: 40, chromaFmax: 3600,
    attrH: 10, fKnee: 700,  // harmonic attribution สูงสุด h10 · น้ำหนักยอดลดลงเหนือ 700Hz
    octK: 0.25,            // ฮาร์มอนิกคี่ของ hz/2 เทียบยอดที่ hz เกินนี้ → YIN ผิดออกเทฟขึ้น ลด hz ลงครึ่ง
    onSub: 0.85,           // คอร์ด: หักสเปกตรัมก่อน onset กี่เท่า (โน้ตใช้ 1 เสมอ)
    lateEl0: 0.16,         // คอร์ดรอบสอง: chroma ช่วงหลัง (คอร์ดเก่าที่ค้างจางแล้ว) เริ่มที่นี่
    attackR: 0.15,         // วินาทีของหลักฐานหลัง onset (โน้ตเดี่ยว + คอร์ดรอบแรก)
    attackR2: 0.35,        // คอร์ด/ท่าจับที่รอบแรกไม่ผ่าน → เก็บ chroma ต่อถึงนี้แล้วดูซ้ำ
    chordEl0: 0.07,        // เริ่มเก็บ chroma หลัง onset (หน้าต่าง FFT ยาว ~93ms คร่อมเสียงเก่า)
  };
  // ตัดสินผล
  const CONF_MIN = 0.72;      // ความมั่นใจ pitch ขั้นต่ำที่นับเป็นหลักฐาน
  const NOTE_TOL = 0.5;       // semitone
  const CHORD_THR = 0.55;     // คะแนน chroma ขั้นต่ำของคอร์ด/ท่าจับหลายโน้ต (ROC ใน tools/test-practice.cjs)
  const NOTE_CHROMA_THR = 0.6;// fallback โน้ตเดี่ยวเมื่อ YIN ไม่ได้ผล (เทียบ pitch class)
  const LEG_N = 4, LEG_CONF = 0.85;

  /* ---------------- FFT (radix-2, ตารางจองครั้งเดียวต่อขนาด) ---------------- */
  const fftPlans = new Map();
  function fftPlan(n) {
    let p = fftPlans.get(n);
    if (p) return p;
    const levels = Math.round(Math.log2(n));
    const cosT = new Float32Array(n >> 1), sinT = new Float32Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / n); sinT[i] = Math.sin((2 * Math.PI * i) / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    p = { n, cosT, sinT, rev };
    fftPlans.set(n, p);
    return p;
  }
  function fft(p, re, im) {
    const n = p.n, cosT = p.cosT, sinT = p.sinT, rev = p.rev;
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) { let t = re[i]; re[i] = re[r]; re[r] = t; t = im[i]; im[i] = im[r]; im[r] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half, wr = cosT[k], wi = sinT[k];
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
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  }

  /* ---------------- low-pass + decimation ---------------- */
  // Butterworth เป็น biquad ต่อกัน (RBJ) → [b0,b1,b2,a1,a2]×ส่วน (a0 = 1)
  function designLowpass(sr, fc, order) {
    const out = [];
    const ns = order >> 1;
    for (let k = 0; k < ns; k++) {
      const q = 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order)));
      const w0 = (2 * Math.PI * fc) / sr, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q), a0 = 1 + al;
      out.push((1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0);
    }
    return out;
  }
  // ต้อง self-contained (ไม่อ้างตัวแปรภายนอก) — ถูก stringify ใส่ AudioWorklet ด้วย
  function makeLowpass(coef) {
    const ns = (coef.length / 5) | 0;
    const c = new Float64Array(coef);
    const z = new Float64Array(ns * 2 + 2);
    return {
      tick(x) {
        x += 1e-20; // กัน denormal ตอนเงียบ
        for (let s = 0, o = 0; s < ns; s++, o += 5) {
          const y = c[o] * x + z[2 * s];
          z[2 * s] = c[o + 1] * x - c[o + 3] * y + z[2 * s + 1];
          z[2 * s + 1] = c[o + 2] * x - c[o + 4] * y;
          x = y;
        }
        return x;
      },
      reset() { z.fill(0); },
    };
  }
  // อัตราวิเคราะห์ ~11–16kHz: 44.1/48k → ÷4, 96k → ÷8, 16k → ÷1
  function decimationFor(srIn) {
    const D = Math.max(1, Math.floor(srIn / 11000));
    const out = srIn / D;
    return { D, rate: out, coef: D > 1 ? designLowpass(srIn, Math.min(0.36 * out, 4500), 6) : [] };
  }
  function makeDecimator(srIn) {
    const cfg = decimationFor(srIn);
    const lp = cfg.coef.length ? makeLowpass(cfg.coef) : null;
    let ph = 0;
    return {
      D: cfg.D, rate: cfg.rate,
      // x (อัตราเข้า) → out (อัตราวิเคราะห์) คืนจำนวนที่เขียน
      run(x, n, out) {
        let k = 0;
        const D = cfg.D;
        for (let i = 0; i < n; i++) {
          const v = lp ? lp.tick(x[i]) : x[i];
          if (++ph >= D) { ph = 0; out[k++] = v; }
        }
        return k;
      },
    };
  }

  /* ---------------- YIN (ไม่จองหน่วยความจำ) ---------------- */
  // x[off .. off+W+tauMax] ; d = Float32Array(tauMax+2) ; ผลลง res[0]=tau (ทศนิยม, -1 = ไม่พบ), res[1]=conf
  function yinCore(x, off, W, tauMin, tauMax, d, th, res) {
    let e0 = 0;
    for (let j = 0; j < W; j++) { const v = x[off + j]; e0 += v * v; }
    let eT = e0, run = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      const a = x[off + tau - 1], b = x[off + tau + W - 1];
      eT += b * b - a * a;
      let r = 0;
      for (let j = 0, o = off + tau; j < W; j++) r += x[off + j] * x[o + j];
      let dt = e0 + eT - 2 * r;
      if (dt < 0) dt = 0;
      run += dt;
      d[tau] = run > 0 ? (dt * tau) / run : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < th) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (d[t] < d[best]) best = t;
      tau = best;
    }
    let ft = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c;
      if (den > 0) ft = tau + clamp((0.5 * (a - c)) / den, -0.5, 0.5);
    }
    let conf = 1 - d[tau];
    if (tau >= tauMax) conf -= 0.3;
    res[0] = ft; res[1] = conf < 0 ? 0 : conf > 1 ? 1 : conf;
    return ft;
  }

  /* ---------------- ยอดสเปกตรัม → chroma ---------------- */
  // mag = |X| normalize แล้ว (sine แอมพลิจูด A → ~A) ; เติม pf/pa (เรียงตามความถี่) คืนจำนวนยอด
  function pickPeaks(mag, N, sr, kLo, kHi, floorAmp, relDb, pf, pa, maxP) {
    let mx = 0;
    for (let k = kLo; k <= kHi; k++) if (mag[k] > mx) mx = mag[k];
    if (!(mx > floorAmp)) return 0;
    const thr = Math.max(floorAmp, mx * Math.pow(10, -relDb / 20));
    let np = 0;
    for (let k = kLo; k <= kHi; k++) {
      const m = mag[k];
      if (m <= thr || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const den = a - 2 * b + c;
      let dk = 0, pk = b;
      if (den < 0) { dk = clamp((0.5 * (a - c)) / den, -0.5, 0.5); pk = b - 0.25 * (a - c) * dk; }
      const f = ((k + dk) * sr) / N, amp = Math.exp(pk);
      if (np < maxP) { pf[np] = f; pa[np] = amp; np++; }
      else {
        let mi = 0;
        for (let q = 1; q < np; q++) if (pa[q] < pa[mi]) mi = q;
        if (amp > pa[mi]) { pf[mi] = f; pa[mi] = amp; }
      }
    }
    for (let i = 1; i < np; i++) { // insertion sort ตามความถี่
      const f = pf[i], a = pa[i];
      let j = i - 1;
      while (j >= 0 && pf[j] > f) { pf[j + 1] = pf[j]; pa[j + 1] = pa[j]; j--; }
      pf[j + 1] = f; pa[j + 1] = a;
    }
    return np;
  }
  // harmonic attribution: ยอด j ที่ ≈ h×ยอด i (h=2..8, ±38 cents) → พลังงานไปเข้า pitch class ของ i
  // น้ำหนักลดลงเหนือ fKnee — ฮาร์มอนิกสูง (h9+) ของหลายโน้ตปนกันจนเป็น pitch class นอกคอร์ด
  // sal (ไม่บังคับ): Float32Array(128) สะสมพลังงานตามโน้ต MIDI ของ fundamental (แยกออกเทฟได้)
  // ownMin: fundamental ต้องแรงอย่างน้อยกี่เท่าของฮาร์มอนิกจึงรับเป็นเจ้าของ (โหมด "ส่วนที่ดังขึ้น" ใช้เข้มกว่า
  // — โน้ตเก่าที่ไม่ได้ดีดซ้ำไม่ควรรับพลังงานของโน้ตใหม่ที่บังเอิญเป็นฮาร์มอนิกของมัน)
  function peaksToChroma(pf, pa, np, a4, own, chroma, sal, ownMin) {
    for (let k = 0; k < 12; k++) chroma[k] = 0;
    if (sal) sal.fill(0);
    let tot = 0;
    const HMAX = P.attrH, kn = P.fKnee, om = ownMin || 0.05;
    for (let j = 0; j < np; j++) {
      own[j] = j;
      if (!(pa[j] > 0)) continue;
      for (let i = 0; i < j; i++) {
        if (own[i] !== i || pa[i] < om * pa[j]) continue;
        const r = pf[j] / pf[i], h = Math.round(r);
        if (h < 2 || h > HMAX || Math.abs(r / h - 1) > (h > 6 ? 0.012 : 0.022)) continue;
        own[j] = i; break;
      }
      const m = 69 + 12 * Math.log2(pf[own[j]] / a4);
      const r = Math.round(m), dev = m - r, ad = dev < 0 ? -dev : dev;
      const fr = pf[j] / kn;
      const pc = ((r % 12) + 12) % 12, w = pa[j] / (1 + fr * fr);
      chroma[pc] += w * (1 - ad);
      chroma[(pc + (dev > 0 ? 1 : 11)) % 12] += w * ad;
      if (sal && r >= 0 && r < 128) sal[r] += w;
      tot += w;
    }
    return tot;
  }

  /* ---------------- analyzer แบบสตรีม ---------------- */
  function createAnalyzer(sr, opts) {
    opts = opts || {};
    const a4 = opts.a4 || 440;
    const HOP = Math.max(32, Math.round(sr * P.hopSec));
    const NS = nearestPow2(sr * P.shortSec);
    const NL = nearestPow2(sr * P.longSec);
    const TAU_MIN = Math.max(2, Math.floor(sr / P.fmax));
    const TAU_MAX = Math.ceil(sr / P.fmin);
    const YW = Math.max(TAU_MAX, Math.round(sr * 0.016));
    const YL = YW + TAU_MAX + 2;
    const REG = NS + 2 * HOP;               // ช่วงหาเวลา onset ละเอียด
    const LIN = Math.max(NL, YL, REG);
    let RING = 1;
    while (RING < LIN + HOP) RING <<= 1;
    const MASK = RING - 1;
    const ring = new Float32Array(RING), lin = new Float32Array(LIN);
    const planS = fftPlan(NS), planL = fftPlan(NL);
    const winS = hann(NS), winL = hann(NL);
    const sre = new Float32Array(NS), sim = new Float32Array(NS);
    const lre = new Float32Array(NL), lim = new Float32Array(NL), lmag = new Float32Array(NL / 2 + 1);
    const prevX = new Float32Array(NS / 2 + 1), prev2X = new Float32Array(NS / 2 + 1), curX = new Float32Array(NS / 2 + 1);
    const kS0 = Math.max(2, Math.round((86 * NS) / sr));
    const kL0 = Math.max(2, Math.floor((65 * NL) / sr));
    const kL1 = Math.min(NL / 2 - 2, Math.ceil((Math.min(P.chromaFmax, 0.42 * sr) * NL) / sr));
    const yd = new Float32Array(TAU_MAX + 2), yres = new Float64Array(2);
    const pf = new Float32Array(P.maxPeaks), pa = new Float32Array(P.maxPeaks), own = new Int16Array(P.maxPeaks);
    const craw = new Float32Array(12);
    // สเปกตรัมก่อน onset: วงเก็บ |X| ของ FFT ยาว 6 เฟรมล่าสุด (~64ms; onset ถูกแจ้งช้ากว่าจริง 2–4 hop) → ตอน onset เลือกเฟรมที่จบก่อน onset
    const NB2 = NL / 2 + 1, MR = 6, magR = [], magRT = new Float64Array(MR), magRG = new Float32Array(MR), preMag = new Float32Array(NB2);
    for (let i = 0; i < MR; i++) magR.push(new Float32Array(NB2));
    let magRPos = 0, havePre = false;
    magRT.fill(-1e9);
    const pf2 = new Float32Array(P.maxPeaks), pa2 = new Float32Array(P.maxPeaks), pa3 = new Float32Array(P.maxPeaks), cscr = new Float32Array(12);
    const FH = 16, fh = new Float32Array(FH), fsort = new Float32Array(FH);
    const NBLK = 30, mins = new Float32Array(NBLK);
    const EW = Math.max(8, Math.round(sr * 0.008)); // หน้าต่าง energy envelope สำหรับเวลา onset
    const cum = new Float64Array(REG + 1);
    const gateFixed = opts.gateDb != null && isFinite(+opts.gateDb) ? +opts.gateDb : null;

    const frame = {
      t: 0, level: -120, gate: P.gateAbs, noiseDb: -120,
      midi: null, hz: 0, cents: 0, conf: 0,
      chroma: new Float32Array(12), chromaW: 0, chromaRaw: null,
      chromaOn: new Float32Array(12), chromaOnW: 0, // chroma ดิบของส่วนที่ดังขึ้นหลัง onset ล่าสุด
      noteOn: new Float32Array(128),                 // เหมือนกันแต่แยกตามโน้ต MIDI (หาโน้ตใหม่ขณะโน้ตเก่ายังดัง)
      yinCurve: null, rate: 0,                       // YIN CMND d'(τ) ของเฟรม (ใช้ตรวจ "คาบที่คาด") · อัตราวิเคราะห์
      onset: false, onsetT: 0, flux: 0, tuneCents: 0,
    };
    frame.chromaRaw = craw;
    frame.yinCurve = yd; frame.rate = sr;
    let w = 0, sinceHop = 0, nFrames = 0;
    let fPrev = 0, fPrev2 = 0, lvPrev = -120, fhPos = 0, fhN = 0, lvHPos = 0;
    const lvH = new Float32Array(4).fill(-120); // level ของเฟรม t-2 … t-5
    let lastOnsetT = -1e9, blkMin = 0, blkCnt = 0, minsPos = 0, minsN = 0, nf = -120;
    let tune = 0, prevMidi = null;

    function linearize() {
      const start = w - LIN;
      for (let j = 0; j < LIN; j++) lin[j] = start + j >= 0 ? ring[(start + j) & MASK] : 0;
    }
    function median16() {
      const n = fhN < FH ? fhN : FH;
      for (let i = 0; i < n; i++) {
        const v = fh[i];
        let j = i - 1;
        while (j >= 0 && fsort[j] > v) { fsort[j + 1] = fsort[j]; j--; }
        fsort[j + 1] = v;
      }
      return n ? fsort[n >> 1] : 0;
    }
    function refineOnset(tNow) {
      const off = LIN - REG;
      cum[0] = 0;
      for (let j = 0; j < REG; j++) { const v = lin[off + j]; cum[j + 1] = cum[j] + v * v; }
      let iMax = EW, eMax = -1;
      for (let i = EW; i <= REG; i += 2) { const e = cum[i] - cum[i - EW]; if (e > eMax) { eMax = e; iMax = i; } }
      let base = Infinity;
      for (let i = EW; i <= iMax; i += 2) { const e = cum[i] - cum[i - EW]; if (e < base) base = e; }
      const thr = base + 0.25 * (eMax - base);
      let iOn = iMax;
      for (let i = iMax; i >= EW; i--) { if (cum[i] - cum[i - EW] <= thr) { iOn = i; break; } }
      const idx = iOn - 0.25 * EW; // ดัชนีตัวอย่างในช่วง REG
      return tNow - (REG - 1 - idx) / sr + P.onsetBias;
    }

    function analyze(tNow) {
      nFrames++;
      linearize();
      const f = frame;
      f.t = tNow; f.onset = false;
      // 1) level (หน้าต่างสั้น)
      let ss = 0;
      for (let j = LIN - NS; j < LIN; j++) ss += lin[j] * lin[j];
      const level = 10 * Math.log10(ss / NS + 1e-12);
      f.level = level;
      // noise floor (min-statistics)
      if (blkCnt === 0 || level < blkMin) blkMin = level;
      if (++blkCnt >= 10) {
        mins[minsPos] = blkMin; minsPos = (minsPos + 1) % NBLK; if (minsN < NBLK) minsN++;
        blkCnt = 0;
        let m = Infinity;
        for (let i = 0; i < minsN; i++) if (mins[i] < m) m = mins[i];
        nf = m;
      }
      const gate = gateFixed != null ? gateFixed : clamp(nf + P.gateOverFloor, P.gateAbs, P.gateCap);
      f.gate = gate; f.noiseDb = nf;
      // 2) onset: spectral flux (log-mag)
      for (let j = 0; j < NS; j++) { sre[j] = lin[LIN - NS + j] * winS[j]; sim[j] = 0; }
      fft(planS, sre, sim);
      // SuperFlux: เทียบกับค่าสูงสุดของ bin ข้างเคียงในเฟรมก่อน → กันคลื่นต่ำ (ไฟฮัม/โน้ตต่ำ) ที่ leakage
      // แกว่งตามเฟสหน้าต่างสั้นจนเป็น onset หลอก
      let flux = 0;
      const sc = 4 / NS, half = NS >> 1;
      // lag μ=2 เฟรม (หน้าต่างไม่ทับกัน) → สตรัมที่กระจาย 30–40ms ยังให้ยอด flux ชัด
      for (let k = kS0 - 1; k <= half; k++) curX[k] = Math.log(1 + P.gamma * Math.sqrt(sre[k] * sre[k] + sim[k] * sim[k]) * sc);
      for (let k = kS0; k < half; k++) {
        let pm = prev2X[k];
        if (prev2X[k - 1] > pm) pm = prev2X[k - 1];
        if (prev2X[k + 1] > pm) pm = prev2X[k + 1];
        const dX = curX[k] - pm;
        if (dX > 0) flux += dX;
      }
      for (let k = kS0 - 1; k <= half; k++) { prev2X[k] = prevX[k]; prevX[k] = curX[k]; }
      flux /= half - kS0;
      f.flux = flux;
      // peak picking: เฟรมก่อนหน้า (fPrev) เป็นยอดและเกิน threshold ปรับตัว?
      const thr = P.fluxDelta + P.fluxK * median16();
      const tCand = tNow - HOP / sr;
      // ระดับต้องดังขึ้นจริง (กันโน้ตห่างครึ่งเสียงที่ดังพร้อมกัน "beat" ~20Hz จน flux แกว่งเป็น onset หลอก)
      // ยกเว้น flux แรงมาก (ดีดซ้ำสายที่ยังดังอยู่: ระดับขึ้นน้อยแต่ transient คม)
      let lvMin = lvH[0];
      for (let i = 1; i < 4; i++) if (lvH[i] < lvMin) lvMin = lvH[i];
      const rise = Math.max(level, lvPrev) - lvMin;
      if (nFrames > 5 && fPrev > thr && fPrev > fPrev2 && fPrev >= flux &&
          (level > gate || lvPrev > gate) && tCand - lastOnsetT > P.mioi &&
          (rise >= P.onsetRiseDb || fPrev > P.onsetStrongK * thr)) {
        f.onset = true;
        f.onsetT = refineOnset(tNow);
        lastOnsetT = tCand;
        let bi = -1;
        for (let i = 0; i < MR; i++) if (magRT[i] > -1e8 && magRT[i] <= f.onsetT && (bi < 0 || magRT[i] > magRT[bi])) bi = i;
        if (bi >= 0) { const src = magR[bi], g = magRG[bi]; for (let k = 0; k < NB2; k++) preMag[k] = src[k] * g; } else preMag.fill(0);
        havePre = true;
      }
      fh[fhPos] = fPrev; fhPos = (fhPos + 1) % FH; if (fhN < FH) fhN++;
      lvH[lvHPos] = lvPrev; lvHPos = (lvHPos + 1) & 3;
      fPrev2 = fPrev; fPrev = flux; lvPrev = level;

      // 3) + 4) pitch / chroma — เฉพาะเมื่อดังเกิน gate
      f.midi = null; f.hz = 0; f.cents = 0; f.conf = 0; f.chromaW = 0;
      const ch = f.chroma;
      f.chromaOnW = 0;
      if (level <= gate) {
        for (let k = 0; k < 12; k++) { ch[k] = 0; craw[k] = 0; f.chromaOn[k] = 0; }
        f.noteOn.fill(0);
        yd.fill(1);
        magR[magRPos].fill(0); magRT[magRPos] = tNow; magRG[magRPos] = 1; magRPos = (magRPos + 1) % MR;
        prevMidi = null;
        f.tuneCents = tune * 100;
        return f;
      }
      // FFT ยาว → ยอด → chroma
      for (let j = 0; j < NL; j++) { lre[j] = lin[LIN - NL + j] * winL[j]; lim[j] = 0; }
      fft(planL, lre, lim);
      const scl = 4 / NL;
      for (let k = 0; k <= NL / 2; k++) lmag[k] = Math.sqrt(lre[k] * lre[k] + lim[k] * lim[k]) * scl;
      const floorAmp = Math.pow(10, (gate - 12) / 20);
      const np = pickPeaks(lmag, NL, sr, kL0, kL1, floorAmp, P.peakRelDb, pf, pa, P.maxPeaks);
      const tot = np ? peaksToChroma(pf, pa, np, a4, own, craw) : 0;
      let cmx = 0;
      for (let k = 0; k < 12; k++) if (craw[k] > cmx) cmx = craw[k];
      for (let k = 0; k < 12; k++) ch[k] = cmx > 0 ? craw[k] / cmx : 0;
      f.chromaW = tot;
      // chroma ของส่วนที่ดังขึ้นหลัง onset: ยอดเดิม (ตำแหน่งจากสเปกตรัมปัจจุบัน) แต่แอมพลิจูด = ส่วนที่
      // เพิ่มจาก |X| ก่อน onset ที่ความถี่เดียวกัน (หักทีละ bin ตรง ๆ ทำให้ยอดเบี้ยวไป semitone ข้าง ๆ)
      if (havePre && np) {
        const g = P.onSub, kf = NL / sr;
        for (let p = 0; p < np; p++) {
          // แอมพลิจูดก่อน onset ต้องวัดแบบเดียวกับยอดปัจจุบัน (parabolic บนยอดใกล้ ±1 bin) — ไม่งั้น
          // scalloping ของ Hann (~1.4dB) ทำให้โน้ตเก่าที่นิ่ง ๆ ดูเหมือน "ดังขึ้น" 0–17%
          const x = pf[p] * kf, k0 = Math.floor(x), fr = x - k0;
          let km = k0 - 1;
          for (let k = k0; k <= k0 + 2; k++) if (preMag[k] > preMag[km]) km = k;
          let pre = preMag[k0] * (1 - fr) + preMag[k0 + 1] * fr;
          if (km > 0 && km < NB2 - 1 && preMag[km] > preMag[km - 1] && preMag[km] >= preMag[km + 1]) {
            const a = Math.log(preMag[km - 1] + 1e-12), b = Math.log(preMag[km] + 1e-12), c = Math.log(preMag[km + 1] + 1e-12);
            const den = a - 2 * b + c;
            const dk = den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
            const pk = Math.exp(b - 0.25 * (a - c) * dk);
            if (pk > pre) pre = pk;
          }
          const v = pa[p] - pre, vc = pa[p] - g * pre;
          pf2[p] = pf[p]; pa2[p] = vc > 0 ? vc : 0;     // คอร์ด: หักบางส่วน (โน้ตร่วมที่ดีดซ้ำยังเหลือบ้าง)
          // แยกโน้ต: หักเต็ม + เพิ่มขึ้นน้อยกว่า 15% ของยอดเอง = นอยส์/beat ของโน้ตเก่า ไม่ใช่การดีดใหม่
          pa3[p] = v > 0.15 * pa[p] ? v : 0;
        }
        f.chromaOnW = peaksToChroma(pf2, pa2, np, a4, own, f.chromaOn, null, 0.2);
        peaksToChroma(pf2, pa3, np, a4, own, cscr, f.noteOn, 0.2);
      } else f.chromaOnW = np ? peaksToChroma(pf, pa, np, a4, own, f.chromaOn, f.noteOn) : 0;
      // ระดับปลายหน้าต่าง (21ms ล่าสุด) เทียบทั้งหน้าต่างยาว: โน้ตเก่าที่ปล่อย/จางลงในหน้าต่าง → |X| ของหน้าต่างยาว
      // เกินระดับที่ยังเหลือจริง → ย่อสเปกตรัมก่อน onset ตามนี้ (โน้ตที่ดังค้างคงที่ ≈ 1 → หักเต็ม)
      let lss = 0;
      for (let j = LIN - NL; j < LIN; j++) lss += lin[j] * lin[j];
      const gRec = Math.sqrt((ss / NS) / (lss / NL + 1e-20));
      magR[magRPos].set(lmag); magRT[magRPos] = tNow; magRG[magRPos] = gRec < 1 ? gRec : 1; magRPos = (magRPos + 1) % MR;
      // YIN บนหน้าต่างล่าสุด
      yinCore(lin, LIN - YL, YW, TAU_MIN, TAU_MAX, yd, P.yinTh, yres);
      const conf = yres[1];
      if (yres[0] > 0 && conf >= 0.5) {
        let hz = sr / yres[0];
        // กันผิดออกเทฟขึ้น (fundamental อ่อน: ไมค์มือถือ/ห้องกลืนย่านต่ำ → dip แรกของ YIN ตกที่ P/2 หรือ P/3)
        // ดูจากสเปกตรัม: มีฮาร์มอนิกคี่ของ hz/2 (ที่ 0.5·hz, 1.5·hz) หรือ h1/h2 ของ hz/3 ชัดพอเทียบยอดที่ hz → ลดลง
        let a1 = 0, aHalf = 0, aThird = 0;
        for (let p = 0; p < np; p++) {
          const r = pf[p] / hz;
          if (Math.abs(r - 1) < 0.03) { if (pa[p] > a1) a1 = pa[p]; }
          else if (Math.abs(r - 0.5) < 0.015 || Math.abs(r - 1.5) < 0.045) aHalf += pa[p];
          else if (Math.abs(r - 1 / 3) < 0.01 || Math.abs(r - 2 / 3) < 0.02) aThird += pa[p];
        }
        if (a1 > 0) {
          if (aHalf > P.octK * a1 && hz / 2 >= P.fmin) hz /= 2;
          else if (aThird > P.octK * a1 && hz / 3 >= P.fmin) hz /= 3;
        }
        // ขัดด้วยยอดฮาร์มอนิก k=1..4 ของ FFT ยาว (แม่นกว่า YIN มากที่โน้ตสูง)
        let sw = 0, sf = 0;
        for (let p = 0; p < np; p++) {
          const r = pf[p] / hz, k = Math.round(r);
          if (k < 1 || k > 4 || Math.abs(r / k - 1) > 0.025) continue;
          sf += (pa[p] * pf[p]) / k; sw += pa[p];
        }
        if (sw > 0) hz = sf / sw;
        const midi = 69 + 12 * Math.log2(hz / a4);
        f.hz = hz; f.midi = midi; f.conf = conf;
        f.cents = Math.round((midi - Math.round(midi)) * 100);
        // ประมาณค่าจูนรวมของกีตาร์ (เฉพาะเฟรมนิ่ง ๆ มั่นใจสูง)
        if (conf > 0.9 && prevMidi !== null && Math.abs(midi - prevMidi) < 0.04) {
          const mm = midi - tune, dev = mm - Math.round(mm);
          tune = clamp(tune + 0.004 * dev, -0.45, 0.45);
        }
        prevMidi = midi;
      } else prevMidi = null;
      f.tuneCents = tune * 100;
      return f;
    }

    return {
      sampleRate: sr, hop: HOP, sizes: { NS, NL, YW, TAU_MIN, TAU_MAX },
      frame,
      // x: ตัวอย่างอัตรา sr, t0 = เวลา (วินาที, นาฬิกา AudioContext) ของ x[0]; เรียก cb(frame) ทุก hop
      push(x, n, t0, cb) {
        for (let i = 0; i < n; i++) {
          ring[w & MASK] = x[i]; w++;
          if (++sinceHop >= HOP) {
            sinceHop = 0;
            const fr = analyze(t0 + i / sr);
            if (cb) cb(fr);
          }
        }
      },
      reset() {
        ring.fill(0); prevX.fill(0); prev2X.fill(0); fh.fill(0); lvH.fill(-120); lvHPos = 0; w = 0; sinceHop = 0; nFrames = 0; fPrev = fPrev2 = 0;
        fhPos = fhN = 0; lastOnsetT = -1e9; minsN = minsPos = blkCnt = 0; nf = -120; tune = 0; prevMidi = null;
        havePre = false; magRT.fill(-1e9);
      },
      get tuneCents() { return tune * 100; },
    };
  }

  /* ---------------- ชื่อคอร์ด → pitch class (ไม่พึ่ง music.js) ---------------- */
  const LETTER = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const CHORD_RE = /^\s*([A-G])([#b♯♭]*)(.*?)(?:\/([A-G])([#b♯♭]*))?\s*$/;
  function accVal(s) { let v = 0; for (let i = 0; i < s.length; i++) v += s[i] === '#' || s[i] === '♯' ? 1 : -1; return v; }
  const ALT = { b5: 6, '#5': 8, '+5': 8, b9: 13, '#9': 15, '+9': 15, '#11': 18, '+11': 18, b13: 20, '-5': 6, '-9': 13, '-13': 20 };
  function parseQuality(q) {
    let s = String(q || '').replace(/[()\s]/g, '').replace(/[Δ∆]/g, 'maj').replace(/°/g, 'dim').replace(/ø7?/g, 'm7b5');
    if (s === '5') return { req: [0, 7], opt: [] };
    let third = 4, thirdReq = true, fifth = 7, fifthReq = false, sev = null;
    const ext = [], extOpt = [];
    let m;
    if ((m = /^(min|mi|m(?!aj)|-)/.exec(s))) { third = 3; s = s.slice(m[0].length); }
    if ((m = /^(dim|o)/.exec(s))) {
      third = 3; fifth = 6; fifthReq = true; s = s.slice(m[0].length);
      if (s[0] === '7') { sev = 9; s = s.slice(1); }
    } else if ((m = /^(aug|\+(?![0-9]))/.exec(s))) { fifth = 8; fifthReq = true; s = s.slice(m[0].length); }
    let majX = false;
    if ((m = /^(maj|Maj|MAJ|ma|M)/.exec(s))) { majX = true; s = s.slice(m[0].length); }
    if ((m = /^(6\/9|69|13|11|9|7|6|2)/.exec(s))) {
      const n = m[1];
      s = s.slice(n.length);
      if (n === '6') ext.push(9);
      else if (n === '69' || n === '6/9') ext.push(9, 14);
      else if (n === '2') ext.push(14);
      else {
        if (sev == null) sev = majX ? 11 : 10;
        if (n === '9') ext.push(14);
        else if (n === '11') { ext.push(17); extOpt.push(14); thirdReq = false; }
        else if (n === '13') { ext.push(21); extOpt.push(14, 17); }
      }
    }
    let guard = 0;
    while (s.length && guard++ < 16) {
      if ((m = /^sus(2|4)?/.exec(s))) { third = m[1] === '2' ? 2 : 5; thirdReq = true; s = s.slice(m[0].length); continue; }
      if ((m = /^add(b|#)?(2|4|9|11|13)/.exec(s))) {
        const base = { 2: 14, 4: 17, 9: 14, 11: 17, 13: 21 }[m[2]];
        ext.push(base + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0));
        s = s.slice(m[0].length); continue;
      }
      if ((m = /^([b#+-])(5|9|11|13)/.exec(s))) {
        const v = ALT[m[1] + m[2]];
        if (m[2] === '5') { fifth = v; fifthReq = true; } else if (v != null) ext.push(v);
        s = s.slice(m[0].length); continue;
      }
      if ((m = /^(no|omit)(3|5)/.exec(s))) { if (m[2] === '3') third = null; else fifth = null; s = s.slice(m[0].length); continue; }
      s = s.slice(1); // อักขระที่ไม่รู้จัก → ข้าม (ผ่อนปรน)
    }
    const req = [0], opt = [];
    if (third != null) (thirdReq ? req : opt).push(third);
    if (fifth != null) (fifthReq ? req : opt).push(fifth);
    if (sev != null) req.push(sev);
    for (const x of ext) req.push(x);
    for (const x of extOpt) opt.push(x);
    return { req, opt };
  }
  // คืน { root, bass, req, opt (bitmask 12 บิต), pcs: [...] } หรือ null
  function parseChord(name) {
    if (typeof name !== 'string') return null;
    const m = CHORD_RE.exec(name);
    if (!m) return null;
    const root = mod12(LETTER[m[1].toLowerCase()] + accVal(m[2]));
    const iv = parseQuality(m[3]);
    let req = 0, opt = 0;
    for (const x of iv.req) req |= 1 << mod12(root + x);
    for (const x of iv.opt) opt |= 1 << mod12(root + x);
    let bass = null;
    if (m[4]) { bass = mod12(LETTER[m[4].toLowerCase()] + accVal(m[5])); req |= 1 << bass; }
    opt &= ~req;
    const pcs = [];
    for (let k = 0; k < 12; k++) if ((req | opt) & (1 << k)) pcs.push(k);
    return { root, bass, req, opt, pcs, name };
  }
  function specOf(chord) {
    if (typeof chord === 'string') return parseChord(chord);
    if (Array.isArray(chord)) { let req = 0; for (const p of chord) if (isFinite(+p)) req |= 1 << mod12(Math.round(+p)); return req ? { req, opt: 0 } : null; }
    if (chord && typeof chord === 'object' && (chord.req || chord.pcs)) {
      if (chord.req != null) return { req: chord.req | 0, opt: chord.opt | 0 };
      return specOf(chord.pcs);
    }
    return null;
  }

  /* ---------------- ให้คะแนน chroma กับชุด pitch class ---------------- */
  const SC = { pres: 0.2, explPow: 1, outKnee: 0.25, outW: 0.5 };
  // c: chroma 12 ค่า (สเกลใดก็ได้) ; req/opt: bitmask → 0..1
  // cNew (ไม่บังคับ): chroma ของ "ส่วนที่ดังขึ้นหลัง onset" — ใช้วัดว่าพลังงานใหม่เป็นโน้ตของคอร์ดไหม
  // (คอร์ดเก่าที่ยังค้างไม่ถูกนับเป็นโน้ตเกิน) ส่วน coverage วัดจาก c (โน้ตร่วมที่ยังดังอยู่นับว่ามี)
  function scorePcs(c, req, opt, cNew) {
    let mx = 0;
    for (let k = 0; k < 12; k++) { const v = c[k] > 0 ? c[k] : 0; if (v > mx) mx = v; }
    if (!(mx > 0) || !req) return 0;
    const e = cNew || c;
    let tot = 0, emx = 0;
    for (let k = 0; k < 12; k++) { const v = e[k] > 0 ? e[k] : 0; tot += v; if (v > emx) emx = v; }
    if (!(emx > 0)) return 0;
    const set = req | opt;
    let inE = 0, outMx = 0, nReq = 0, logCov = 0;
    for (let k = 0; k < 12; k++) {
      const v = c[k] > 0 ? c[k] : 0, u = e[k] > 0 ? e[k] : 0, bit = 1 << k;
      if (set & bit) inE += u; else if (u > outMx) outMx = u;
      if (req & bit) { nReq++; logCov += Math.log(clamp(v / (SC.pres * mx), 1e-3, 1)); }
    }
    const cov = Math.exp(logCov / nReq);
    const expl = inE / tot;
    const out = outMx / emx;
    const pen = out > SC.outKnee ? (out - SC.outKnee) / (1 - SC.outKnee) : 0;
    return clamp(cov * Math.pow(expl, SC.explPow) * (1 - SC.outW * pen), 0, 1);
  }
  function matchChord(chroma, chord) {
    const sp = specOf(chord);
    return sp ? scorePcs(chroma, sp.req, sp.opt) : 0;
  }
  function matchNotes(chroma, midis) {
    let req = 0;
    for (const m of midis || []) if (isFinite(+m)) req |= 1 << mod12(Math.round(+m));
    return req ? scorePcs(chroma, req, 0) : 0;
  }
  // เดาว่าผู้เล่นตีคอร์ดอะไร (ไว้แสดงใน played)
  const GUESS_Q = ['', 'm', '7', 'm7', 'maj7', 'sus4', 'sus2', '5', 'dim', 'aug', '6', 'm6', 'add9'];
  const GUESS = [];
  for (const q of GUESS_Q) for (let r = 0; r < 12; r++) { const sp = parseChord(SHARP[r] + q); GUESS.push({ name: SHARP[r] + q, req: sp.req, opt: sp.opt }); }
  function guessChord(chroma) {
    let best = null, bs = -1;
    for (let i = 0; i < GUESS.length; i++) {
      const s = scorePcs(chroma, GUESS[i].req, GUESS[i].opt);
      if (s > bs + 0.02) { bs = s; best = GUESS[i].name; }
    }
    return { name: bs >= 0.25 ? best : null, score: bs };
  }

  /* ---------------- pure helpers สำหรับเทสต์ ---------------- */
  function pitchYin(buf, sr, opts) {
    opts = opts || {};
    const tauMin = Math.max(2, Math.floor(sr / (opts.fmax || P.fmax)));
    const tauMax = Math.ceil(sr / (opts.fmin || P.fmin));
    let W = Math.max(tauMax, Math.round(sr * 0.016));
    if (W + tauMax + 2 > buf.length) W = buf.length - tauMax - 2;
    if (W < tauMax * 0.5) return null;
    const d = new Float32Array(tauMax + 2), res = new Float64Array(2);
    yinCore(buf, buf.length - (W + tauMax + 2), W, tauMin, tauMax, d, opts.threshold || P.yinTh, res);
    if (!(res[0] > 0)) return null;
    const hz = sr / res[0], midi = 69 + 12 * Math.log2(hz / (opts.a4 || 440));
    return { hz, midi, cents: Math.round((midi - Math.round(midi)) * 100), conf: res[1] };
  }
  function chromaOf(buf, sr, opts) {
    opts = opts || {};
    const N = nearestPow2(sr * P.longSec);
    const re = new Float32Array(N), im = new Float32Array(N), w = hann(N);
    const off = buf.length - N;
    for (let j = 0; j < N; j++) re[j] = (off + j >= 0 ? buf[off + j] : 0) * w[j];
    fft(fftPlan(N), re, im);
    const mag = new Float32Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * (4 / N);
    const pf = new Float32Array(P.maxPeaks), pa = new Float32Array(P.maxPeaks), own = new Int16Array(P.maxPeaks);
    const kLo = Math.max(2, Math.floor((65 * N) / sr)), kHi = Math.min(N / 2 - 2, Math.ceil((Math.min(P.chromaFmax, 0.42 * sr) * N) / sr));
    const np = pickPeaks(mag, N, sr, kLo, kHi, 1e-5, P.peakRelDb, pf, pa, P.maxPeaks);
    const c = new Float32Array(12);
    if (np) peaksToChroma(pf, pa, np, opts.a4 || 440, own, c);
    let mx = 0;
    for (let k = 0; k < 12; k++) if (c[k] > mx) mx = c[k];
    if (mx > 0) for (let k = 0; k < 12; k++) c[k] /= mx;
    return c;
  }
  // วิเคราะห์ทั้งก้อน (จองหน่วยความจำได้ — ใช้ในเทสต์/ออฟไลน์): คืนอาร์เรย์สำเนาเฟรม
  function analyzeBuffer(signal, srIn, opts) {
    opts = opts || {};
    const dec = makeDecimator(srIn);
    const an = createAnalyzer(dec.rate, opts);
    const frames = [];
    const CH = 512, tmp = new Float32Array(CH), out = new Float32Array(CH);
    let inPos = 0, outPos = 0;
    while (inPos < signal.length) {
      const n = Math.min(CH, signal.length - inPos);
      for (let i = 0; i < n; i++) tmp[i] = signal[inPos + i];
      const k = dec.run(tmp, n, out);
      an.push(out, k, outPos / dec.rate, (f) => {
        const c = Object.assign({}, f);
        c.chroma = Float32Array.from(f.chroma);
        c.chromaOn = Float32Array.from(f.chromaOn);
        c.noteOn = Float32Array.from(f.noteOn);
        c.chromaRaw = Float32Array.from(f.chromaRaw);
        c.yinCurve = Float32Array.from(f.yinCurve);
        frames.push(c);
        if (opts.onFrame) opts.onFrame(f);
      });
      inPos += n; outPos += k;
    }
    return { frames, rate: dec.rate, D: dec.D, analyzer: an };
  }

  /* ---------------- follower: ตัดสิน event ตามเวลา ---------------- */
  function buildEvents(expected, startAt, hitS, okS, tempo) {
    const items = [];
    (Array.isArray(expected) ? expected : []).forEach((e, i) => {
      if (!e || !isFinite(+e.t)) return;
      const t = +e.t;
      if (t < startAt - 1e-6) return;
      let midis = null;
      if (Array.isArray(e.midi)) midis = e.midi.filter((x) => isFinite(+x)).map(Number);
      else if (e.midi != null && isFinite(+e.midi)) midis = [+e.midi];
      if (midis && !midis.length) midis = null;
      const chord = typeof e.chord === 'string' && e.chord.trim() ? e.chord.trim() : Array.isArray(e.chord) && e.chord.length ? e.chord : null;
      if (!midis && !chord) return;
      items.push({ i, t, d: isFinite(+e.d) ? +e.d : 0, midis, chord });
    });
    items.sort((a, b) => a.t - b.t || a.i - b.i);
    const evs = [];
    for (const it of items) {
      const last = evs[evs.length - 1];
      if (last && Math.abs(it.t - last.t) <= 0.001) {
        last.idx.push(it.i);
        if (it.chord && !last.chord) last.chord = it.chord;
        if (it.midis) last.midis = (last.midis || []).concat(it.midis);
        last.d = Math.max(last.d, it.d);
        continue;
      }
      evs.push({ i: it.i, idx: [it.i], t: it.t, d: it.d, midis: it.midis ? it.midis.slice() : null, chord: it.chord });
    }
    const out = [];
    for (const ev of evs) {
      if (ev.chord) {
        const sp = specOf(ev.chord);
        if (!sp) continue; // ชื่อคอร์ดอ่านไม่ออก (เช่น N.C.) → ไม่ตัดสิน
        ev.kind = 'chord'; ev.req = sp.req; ev.opt = sp.opt;
      } else {
        const u = Array.from(new Set(ev.midis.map((m) => Math.round(m * 100) / 100)));
        if (u.length === 1) { ev.kind = 'note'; ev.midi = u[0]; } else {
          ev.kind = 'shape'; ev.req = 0; ev.opt = 0;
          for (const m of u) ev.req |= 1 << mod12(Math.round(m));
          if ((ev.req & (ev.req - 1)) === 0) { ev.kind = 'note'; ev.midi = Math.min.apply(null, u); ev.octaves = u; }
        }
      }
      ev.status = 0; ev.result = null; ev.dtMs = null; ev.wrong = null; ev.armC = null;
      out.push(ev);
    }
    // หน้าต่างรับ: ±okS แต่ไม่เลยเวลา event ข้างเคียง (จับคู่ด้วย pitch อยู่แล้ว จึงซ้อนกันได้)
    // หน้าต่าง hit: ±hitS แต่ไม่เกินครึ่งช่องว่าง (โน้ตถี่ ๆ ทั้งช่องนับเป็น hit)
    const minW = 0.035 * tempo;
    for (let k = 0; k < out.length; k++) {
      const ev = out[k];
      const gp = k > 0 ? ev.t - out[k - 1].t : Infinity, gn = k + 1 < out.length ? out[k + 1].t - ev.t : Infinity;
      ev.before = Math.min(okS, Math.max(0.9 * gp, minW));
      ev.after = Math.min(okS, Math.max(0.9 * gn, minW));
      ev.hitB = Math.min(hitS, Math.max(0.5 * gp, minW));
      ev.hitA = Math.min(hitS, Math.max(0.5 * gn, minW));
    }
    return out;
  }

  // env.now() = เวลาปัจจุบันบนนาฬิกาเดียวกับ frame.t (AudioContext.currentTime)
  function createFollower(expected, opts, env) {
    opts = opts || {};
    const mode = opts.mode === 'wait' ? 'wait' : 'timed';
    const tempo = clamp(isFinite(+opts.tempo) && +opts.tempo > 0 ? +opts.tempo : 1, 0.25, 2);
    const startAt = isFinite(+opts.startAt) ? +opts.startAt : 0;
    const latency = (isFinite(+opts.latencyMs) ? +opts.latencyMs : 0) / 1000;
    const allowOctave = !!opts.allowOctave;
    const autoTune = opts.autoTune !== false;
    const hitS = clamp((isFinite(+opts.windowMs) ? +opts.windowMs : 100) / 1000, 0.03, 0.5); // วินาทีของเพลง = ±100ms/tempo ตามเวลาจริง
    const okS = hitS * (isFinite(+opts.okFactor) ? clamp(+opts.okFactor, 1, 5) : 2.5);
    const chordThr = isFinite(+opts.chordThreshold) ? +opts.chordThreshold : CHORD_THR;
    const cbs = { onJudge: opts.onJudge, onTime: opts.onTime, onDone: opts.onDone, onAttempt: opts.onAttempt, onWait: opts.onWait };
    const safe = (fn, arg) => { if (typeof fn === 'function') { try { fn(arg); } catch (e) { if (typeof console !== 'undefined') console.error('[Practice]', e); } } };
    const now = () => env.now();
    const evs = buildEvents(expected, startAt, hitS, okS, tempo);

    // นาฬิกาเพลงแบบเป็นช่วง ๆ (หยุด/เล่นต่อ/รอ) — เก็บประวัติไว้แปลงเวลาเฟรมที่มาช้า
    const segs = [];
    const at0 = isFinite(+opts.at) ? +opts.at : now() + (isFinite(+opts.leadIn) ? +opts.leadIn : 0);
    segs.push({ c: at0, s: startAt, r: tempo });
    function songAt(c) {
      for (let k = segs.length - 1; k > 0; k--) { const g = segs[k]; if (c >= g.c) return g.s + (c - g.c) * g.r; }
      return segs[0].s + (c - segs[0].c) * tempo;
    }
    function rateAt(c) {
      for (let k = segs.length - 1; k > 0; k--) if (c >= segs[k].c) return segs[k].r;
      return tempo;
    }
    function ctxAt(s) { const g = segs[segs.length - 1]; return g.r > 0 ? g.c + (s - g.s) / g.r : Infinity; }
    let userPaused = false, frozen = false;
    function setRate(c) {
      const r = userPaused || frozen ? 0 : tempo;
      const g = segs[segs.length - 1];
      if (g.r === r) return;
      const cc = Math.max(c, g.c);
      segs.push({ c: cc, s: songAt(cc), r });
      if (segs.length > 512) segs.splice(1, 256);
    }

    let p0 = 0, done = false, stopped = false, summary = null, extras = 0, lastConsumedT = -1e9;
    let lastDataT = -1e9, lastFrameWall = 0;
    // attack เดียวที่ใช้ซ้ำ (ไม่จองใหม่ต่อเฟรม)
    const A = { on: false, ext: false, t: 0, midi: null, prev: null, preLv: -120, peakLv: -120, pitch: new Float32Array(48), np: 0, chroma: new Float64Array(12), chNew: new Float64Array(12), nc: 0, nn: new Float64Array(128), nnN: 0, late: new Float64Array(12), lateN: 0 };
    let curNN = null; // หลักฐานโน้ตใหม่ของ attack ที่กำลังตัดสิน (null = ไม่มี)
    let ycA = null, ycN = 0, ycRate = 0, curYC = null, curYCN = 0; // ผลรวม YIN d'(τ) ของ attack
    let curPrev = null; // โน้ตก่อนหน้า (อาจยังดังค้าง) ของ attack ที่กำลังตัดสิน
    let lateMode = false; // phase 2 ด้วย chroma ช่วงหลัง: ลองทั้งช่วงหลังและทั้งก้อน
    const lvR = new Float32Array(4).fill(-120), lvRT = new Float64Array(4).fill(-1e9);
    let lvRPos = 0, curRise = 99; // ระดับเฟรมล่าสุด (หา "ก่อน onset") · ส่วนที่ดังขึ้นของ attack (dB)
    let lastOnsetT = -1e9, lastNote = null, lastOnsetPrev = null, lmRound = null, lmCount = 0, lmT0 = 0, lmSum = 0;

    function tuneOff(f) { return autoTune ? clamp((f.tuneCents || 0) / 100, -0.4, 0.4) : 0; }

    // สัดส่วนพลังงานใหม่ของโน้ตที่คาดเทียบโน้ตใหม่ที่เด่นสุด (0..1)
    function newNoteSupport(ev) {
      const nn = curNN;
      let mx = 0;
      for (let k = 28; k < 100; k++) if (nn[k] > mx) mx = nn[k];
      if (!(mx > 0)) return 0;
      const m = Math.round(ev.midi);
      // ดีดซ้ำโน้ตเดิมที่ fundamental อ่อน (ไมค์มือถือ): พลังงานใหม่ไปโผล่ที่ h2 (m+12) และ h3 (m+19) พร้อมกัน
      // ต้องมี "ทั้งคู่" — เล่นออกเทฟบนทับ (ได้แต่ m+12) หรือเล่นโน้ต h3 ทับ (ได้แต่ m+19) จะไม่ผ่าน
      let v = nn[m] + (m + 19 < 128 ? 2 * Math.min(nn[m + 12], nn[m + 19]) : 0);
      if (allowOctave) for (let o = m % 12; o < 100; o += 12) if (nn[o] > v) v = nn[o];
      return Math.min(1, v / mx);
    }
    // ตัดสินจากพลังงานที่ "ดังขึ้นหลัง onset" แยกตามโน้ต (harmonic attribution → fundamental)
    function newNoteVerdict(ev) {
      const nn = curNN;
      if (!nn) return 0;
      let mx = 0, arg = -1, tot = 0;
      for (let k = 28; k < 100; k++) { tot += nn[k]; if (nn[k] > mx) { mx = nn[k]; arg = k; } }
      if (!(mx > 0)) return 0;
      const m = Math.round(ev.midi);
      let v = nn[m];
      if (allowOctave) for (let o = m % 12; o < 100; o += 12) if (nn[o] > v) v = nn[o];
      const oct = Math.max(nn[m - 12] || 0, nn[m + 12] || 0);
      if (v >= 0.6 * mx && (allowOctave || v >= 0.8 * oct)) return 1;
      // ปฏิเสธได้เฉพาะเมื่อโน้ตใหม่ที่เด่นไม่สัมพันธ์เชิงฮาร์มอนิกกับโน้ตที่คาด (h2,h3,h4,h5,h6 ทั้งขึ้น/ลง) —
      // ฮาร์มอนิกของโน้ตใหม่มักทับฮาร์มอนิกโน้ตเก่า/เสียงก้องทำให้ "ส่วนที่ดังขึ้น" เอียงไปออกเทฟ/ฟิฟธ์
      const dd = Math.abs(arg - m);
      const related = dd === 0 || dd === 12 || dd === 19 || dd === 24 || dd === 28 || dd === 31 || dd === 7 || dd === 5;
      if (!related && v < 0.25 * mx && mx >= 0.35 * tot) return -1;
      return 0;
    }
    // ค่า d'(τ) เฉลี่ยของ attack ต่ำสุดในช่วง τ±3%
    function ycMin(t0, t1) {
      const n = curYC.length - 1;
      let lo = Math.max(1, Math.floor(t0)), hi = Math.min(n - 1, Math.ceil(t1)), m = Infinity;
      for (let t = lo; t <= hi; t++) if (curYC[t] < m) m = curYC[t];
      return m / curYCN;
    }
    // คาบที่คาดเป็นคาบมูลฐานจริงไหม: d'(τ) ต่ำ และ τ/2, τ/3, τ/4 ไม่ต่ำพอ ๆ กัน (ไม่งั้นคือเล่นออกเทฟ/ฮาร์มอนิกบน)
    function periodicVerdict(ev, margin) {
      if (!curYC || !ycRate) return 0;
      const mg = margin || 0.12;
      const tau = ycRate / (440 * Math.pow(2, (ev.midi - 69) / 12));
      if (tau < 3 || tau * 1.03 >= curYC.length - 1) return 0;
      const a = ycMin(tau * 0.97, tau * 1.03);
      if (!(a <= 0.15)) return 0;
      if (!allowOctave) {
        for (let k = 2; k <= 4; k++) {
          const tk = tau / k;
          if (tk < 2) break;
          if (ycMin(tk * 0.97, tk * 1.03) < a + mg) return 0;
        }
      }
      return 1;
    }
    function matches(ev, midi, chroma, chNew) {
      if (ev.kind === 'note') {
        const nv = newNoteVerdict(ev);  // 1 = โน้ตที่คาดคือเสียงใหม่เด่น · -1 = เสียงใหม่เป็นโน้ตอื่นชัด ๆ · 0 = ไม่รู้
        if (midi !== null) {
          const d = midi - ev.midi;
          let ok = Math.abs(d) <= NOTE_TOL;
          if (!ok && allowOctave) { const o = d - 12 * Math.round(d / 12); ok = Math.abs(o) <= NOTE_TOL && Math.abs(d) < 36.5; }
          if (!ok && ev.octaves) for (const m of ev.octaves) if (Math.abs(midi - m) <= NOTE_TOL) ok = true;
          // โน้ตที่คาด = โน้ตก่อนหน้าที่อาจยังดัง: YIN อาจได้ยินแค่โน้ตเก่า (หรือ fundamental ของส่วนผสม เมื่อ
          // โน้ตใหม่เป็นฮาร์มอนิกของโน้ตเก่า เช่น ออกเทฟ/12th) → ต้องเห็นว่าโน้ตนี้ "ดังขึ้นใหม่" จริง หรือ
          // ดังขึ้นชัด (≥8dB) และสัญญาณไม่ได้เป็นคาบที่ τ/2, τ/3 (= ไม่ใช่โน้ตฮาร์มอนิกที่สูงกว่าครอบอยู่)
          if (ok && curNN && curPrev !== null && Math.round(midi) === curPrev && newNoteSupport(ev) < 0.3 &&
              !(curRise >= 8 && periodicVerdict(ev, 0.25) > 0)) return false;
          if (ok) return nv >= 0; // YIN อาจได้ยินโน้ตเก่าที่ยังดัง ถ้าเสียงใหม่เป็นโน้ตอื่นชัด ๆ → ไม่นับ
          // YIN ล็อกโน้ตเก่าที่ดังกว่า: ดูว่าเสียงที่ดังขึ้นใหม่/คาบของสัญญาณยืนยันโน้ตที่คาดไหม
          return nv > 0 || (nv === 0 && periodicVerdict(ev) > 0);
        }
        if (nv !== 0) return nv > 0;
        if (periodicVerdict(ev) > 0) return true;
        // chroma บอกแค่ pitch class (ไม่รู้ออกเทฟ) → ใช้เป็นทางสุดท้ายได้เฉพาะเมื่อยอมรับต่างออกเทฟ
        return allowOctave && chroma ? scorePcs(chroma, 1 << mod12(Math.round(ev.midi)), 0, chNew) >= NOTE_CHROMA_THR : false;
      }
      if (!chroma) return false;
      if (scorePcs(chroma, ev.req, ev.opt, chNew) >= chordThr) return true;
      return lateMode && A.nc >= 2 && scorePcs(A.chroma, ev.req, ev.opt, A.chNew) >= chordThr;
    }
    // played สำหรับ UI: hit → โน้ตที่คาด (ยืนยันแล้วว่าเล่น) · ผิด → สิ่งที่ได้ยินจริงเท่าที่บอกได้
    function describe(ev, midi, chroma, chNew, hit) {
      if (ev.kind === 'note') {
        const m0 = Math.round(ev.midi);
        if (hit) {
          const c = midi !== null && Math.abs(midi - ev.midi) <= NOTE_TOL ? Math.round((midi - ev.midi) * 100) : 0;
          return { midi: m0, cents: c, name: midiName(m0) };
        }
        let pick = midi !== null ? Math.round(midi) : null, cents = midi !== null ? Math.round((midi - Math.round(midi)) * 100) : 0;
        if (curNN) {
          let mx = 0, arg = -1;
          for (let k = 28; k < 100; k++) if (curNN[k] > mx) { mx = curNN[k]; arg = k; }
          // YIN ไม่มีผล หรือได้ยินโน้ตเก่าที่ยังค้าง → ใช้โน้ตที่ "ดังขึ้นใหม่" เด่นสุดแทน
          if (arg >= 0 && (pick === null || (pick !== arg && pick === curPrev))) { pick = arg; cents = 0; }
        }
        return pick === null ? null : { midi: pick, cents, name: midiName(pick) };
      }
      if (chroma) {
        const g = guessChord(chNew || chroma);
        const top = [];
        let mx = 0;
        for (let k = 0; k < 12; k++) if (chroma[k] > mx) mx = chroma[k];
        for (let k = 0; k < 12; k++) if (mx > 0 && chroma[k] >= 0.35 * mx) top.push(SHARP[k]);
        return { chord: g.name, pcs: top, score: Math.round(scorePcs(chroma, ev.req, ev.opt, chNew) * 100) / 100 };
      }
      return null;
    }
    function finalize(ev, res, dtMs, played, skipped) {
      if (ev.status) return;
      ev.status = 1; ev.result = res; ev.dtMs = dtMs == null ? null : Math.round(dtMs * 10) / 10;
      while (p0 < evs.length && evs[p0].status) p0++;
      const out = { i: ev.i, idx: ev.idx.slice(), t: ev.t, kind: ev.kind, result: res, dtMs: ev.dtMs, played: played || null };
      if (skipped) out.skipped = true;
      if (skipped) ev.skipped = true;
      safe(cbs.onJudge, out);
      if (p0 >= evs.length) finish(false);
    }
    function finish(byStop) {
      if (done) return summary;
      done = true;
      summary = summarize();
      if (byStop) summary.stopped = true;
      safe(cbs.onDone, summary);
      return summary;
    }
    function summarize() {
      let hits = 0, early = 0, late = 0, misses = 0, skipped = 0, sd = 0, sa = 0, nd = 0;
      for (const ev of evs) {
        if (!ev.status) continue;
        if (ev.result === 'hit') hits++; else if (ev.result === 'early') early++; else if (ev.result === 'late') late++; else misses++;
        if (ev.skipped) skipped++;
        if (ev.result !== 'miss' && ev.dtMs != null && mode === 'timed') { sd += ev.dtMs; sa += Math.abs(ev.dtMs); nd++; }
      }
      const judged = hits + early + late + misses;
      return {
        mode, tempo, total: evs.length, judged, hits, early, late, misses, skipped, extras,
        accuracy: judged ? (hits + early + late) / judged : 0,
        onTimeRate: judged ? hits / judged : 0,
        avgDtMs: nd ? Math.round((sd / nd) * 10) / 10 : null,
        avgAbsDtMs: nd ? Math.round((sa / nd) * 10) / 10 : null,
      };
    }

    // phase 1 = ดูครั้งแรก (~R หลัง onset) · phase 2 = ดูซ้ำเฉพาะคอร์ด/ท่าจับ เมื่อเก็บ chroma ได้นานขึ้น
    // (คอร์ดเก่าที่ยังค้างตอนเปลี่ยนคอร์ดจางลงแล้ว) — เวลา dt ยังนับจาก onset เดิม
    // คืน 'hit' (ใช้ attack แล้ว) | 'defer' (รอดูซ้ำ) | 'none'
    function onAttack(tA, midi, chroma, chNew, phase) {
      if (done || stopped) return 'none';
      const sA = songAt(tA);
      const chordOnly = phase === 2;
      if (mode === 'timed') {
        if (rateAt(tA) === 0) return 'none'; // ระหว่าง pause ไม่นับ
        let best = -1, bestAbs = Infinity, near = -1, nearAbs = Infinity, chordCand = false;
        for (let k = p0; k < evs.length; k++) {
          const ev = evs[k];
          if (ev.t - okS - 0.05 > sA) break;
          if (ev.status) continue;
          if (chordOnly && ev.kind === 'note') continue;
          const dt = sA - ev.t;
          if (dt < -ev.before || dt > ev.after) continue;
          const ad = Math.abs(dt);
          if (ev.kind !== 'note') chordCand = true;
          if (ad < nearAbs) { nearAbs = ad; near = k; }
          if (ad < bestAbs && matches(ev, midi, chroma, chNew)) { bestAbs = ad; best = k; }
        }
        if (best >= 0) {
          const ev = evs[best], dt = sA - ev.t;
          const res = dt < -ev.hitB ? 'early' : dt > ev.hitA ? 'late' : 'hit';
          finalize(ev, res, (dt / tempo) * 1000, describe(ev, midi, chroma, chNew, true));
          return 'hit';
        }
        if (phase === 1 && chordCand && chroma) return 'defer';
        if (near >= 0) {
          const ev = evs[near];
          ev.wrong = describe(ev, midi, chroma, chNew);
          safe(cbs.onAttempt, { i: ev.i, ok: false, played: ev.wrong, dtMs: Math.round(((sA - ev.t) / tempo) * 1000) });
        } else extras++;
        return 'none';
      }
      // wait: นับเฉพาะ event ปัจจุบัน และต้องเป็น attack ใหม่กว่าตัวที่ปิด event ก่อนหน้า
      // (เล่นนำนาฬิกาได้ — wait = "รอฉัน" ไม่ได้บังคับให้รอนาฬิกา)
      const ev = evs[p0];
      if (!ev || tA <= lastConsumedT + 0.005) return 'none';
      if (chordOnly && ev.kind === 'note') return 'none';
      if (matches(ev, midi, chroma, chNew)) {
        const armC = ev.armC != null ? ev.armC : ctxAt(ev.t);
        lastConsumedT = tA;
        finalize(ev, 'hit', isFinite(armC) ? (tA - armC) * 1000 : 0, describe(ev, midi, chroma, chNew, true));
        if (frozen) { frozen = false; setRate(now()); }
        return 'hit';
      }
      if (phase === 1 && ev.kind !== 'note' && chroma) return 'defer';
      ev.wrong = describe(ev, midi, chroma, chNew);
      safe(cbs.onAttempt, { i: ev.i, ok: false, played: ev.wrong, dtMs: null });
      return 'none';
    }

    function startAttack(t) {
      A.on = true; A.ext = false; A.t = t; A.np = 0; A.nc = 0; A.midi = null; A.nnN = 0; A.prev = lastNote;
      A.preLv = 0; A.peakLv = -120; lastOnsetPrev = lastNote;
      for (let i = 0; i < 4; i++) if (lvRT[i] <= t + 0.005 && lvR[i] < A.preLv) A.preLv = lvR[i];
      if (A.preLv === 0) A.preLv = -120;
      for (let k = 0; k < 12; k++) { A.chroma[k] = 0; A.chNew[k] = 0; A.late[k] = 0; }
      A.lateN = 0;
      A.nn.fill(0);
      if (ycA) ycA.fill(0);
      ycN = 0;
      lastOnsetT = t;
    }
    function resolveAttack() {
      if (A.ext) { // ดูซ้ำ (phase 2) แล้วปิด — ใช้ chroma ช่วงหลังถ้ามีพอ (คอร์ดเก่าจางแล้ว)
        A.on = false; A.ext = false;
        if (A.lateN >= 3) { lateMode = true; onAttack(A.t, A.midi, A.late, A.late, 2); lateMode = false; }
        else if (A.nc >= 2) onAttack(A.t, A.midi, A.chroma, A.chNew, 2);
        return;
      }
      let midi = null;
      if (A.np >= 2) {
        const a = A.pitch, n = A.np;
        for (let i = 1; i < n; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
        const med = n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
        let ok = 0;
        for (let i = 0; i < n; i++) if (Math.abs(a[i] - med) <= 0.5) ok++;
        if (ok >= 0.6 * n) midi = med;
      }
      const hasChroma = A.nc >= 2;
      if (midi !== null) lastNote = Math.round(midi);
      A.midi = midi;
      if (midi === null && !hasChroma && A.nnN < 2 && ycN < 3) { A.on = false; return; }
      curNN = A.nnN >= 2 ? A.nn : null;
      curYC = ycN >= 3 ? ycA : null; curYCN = ycN; curPrev = A.prev; curRise = A.peakLv - A.preLv;
      const r = onAttack(A.t, midi, hasChroma ? A.chroma : null, hasChroma ? A.chNew : null, 1);
      curNN = null; curYC = null; curPrev = null;
      if (r === 'defer') A.ext = true; // เก็บ chroma ต่อจนถึง attackR2 หรือ onset ถัดไป
      else A.on = false;
    }
    function legatoTrack(f, tI) {
      if (f.midi === null || f.conf < LEG_CONF || f.level < f.gate + 6) { lmRound = null; lmCount = 0; return; }
      const m = f.midi - tuneOff(f), r = Math.round(m);
      if (Math.abs(m - r) > 0.35) { lmRound = null; lmCount = 0; return; }
      if (r !== lmRound) { lmRound = r; lmCount = 1; lmT0 = tI; lmSum = m; return; }
      lmCount++; lmSum += m;
      if (lmCount !== LEG_N) return;
      if (A.on || tI - lastOnsetT < 0.2) { lastNote = r; return; }
      if (lastNote === r) return;
      // กลับไปเป็นโน้ตที่ดังค้างอยู่ก่อน onset ล่าสุด = โน้ตเก่าโผล่หลังโน้ตใหม่จาง ไม่ใช่การเล่นใหม่
      if (r === lastOnsetPrev) { lastNote = r; return; }
      lastNote = r;
      onAttack(lmT0 - 0.012, lmSum / lmCount, null, null, 1);
    }
    function advance(tData) {
      if (mode !== 'timed' || done) return;
      const s = songAt(tData), mN = (P.attackR + 0.03) * tempo, mC = (P.attackR2 + 0.03) * tempo;
      for (let k = p0; k < evs.length; k++) {
        const ev = evs[k];
        if (ev.status) continue;
        if (ev.t + ev.after + (ev.kind === 'note' ? mN : mC) < s) finalize(ev, 'miss', null, ev.wrong);
        else break;
      }
    }

    const api = {
      mode, tempo, events: evs,
      // ป้อนเฟรมจาก analyzer (frame.t = เวลาจับเสียง, ยังไม่หัก latency)
      frame(f) {
        if (done || stopped) return;
        const tI = f.t - latency;
        lastDataT = tI; lastFrameWall = now();
        if (f.onset) {
          const to = f.onsetT - latency;
          if (A.on) { resolveAttack(); if (A.on) resolveAttack(); } // ถ้ายัง defer อยู่ → ดูซ้ำด้วยหลักฐานที่มี
          startAttack(to);
        }
        if (A.on) {
          const el = tI - A.t;
          if (!A.ext && f.level > A.peakLv) A.peakLv = f.level;
          if (!A.ext && f.midi !== null && f.conf >= CONF_MIN && el >= 0.018 && A.np < A.pitch.length) A.pitch[A.np++] = f.midi - tuneOff(f);
          if (!A.ext && el >= 0.03 && f.noteOn && f.chromaOnW > 0) { const nn = f.noteOn; for (let k = 28; k < 100; k++) A.nn[k] += nn[k]; A.nnN++; }
          if (!A.ext && el >= 0.02 && f.yinCurve && f.level > f.gate) {
            const yc = f.yinCurve;
            if (!ycA || ycA.length !== yc.length) { ycA = new Float64Array(yc.length); ycN = 0; } // จองครั้งแรกครั้งเดียว
            for (let k = 0; k < yc.length; k++) ycA[k] += yc[k];
            ycN++; ycRate = f.rate;
          }
          // หลักฐานคอร์ด: chroma ปกติ (วัด coverage — โน้ตร่วมที่ยังดังนับว่ามี) + chroma "ส่วนที่ดังขึ้นหลัง onset"
          // (วัดโน้ตเกิน — คอร์ดเก่าที่ยังค้างไม่นับ) + chroma ช่วงหลัง (ดูซ้ำรอบสองเมื่อคอร์ดเก่าจางแล้ว)
          if (el >= P.chordEl0 && f.chromaW > 0) {
            const raw = f.chromaRaw, on = f.chromaOn;
            const late = el >= P.lateEl0;
            for (let k = 0; k < 12; k++) {
              const v = raw ? raw[k] : f.chroma[k] * f.chromaW;
              A.chroma[k] += v;
              A.chNew[k] += on ? on[k] : v;
              if (late) A.late[k] += v;
            }
            A.nc++;
            if (late) A.lateN++;
          }
          if (el >= (A.ext ? P.attackR2 : P.attackR)) resolveAttack();
        }
        lvR[lvRPos] = f.level; lvRT[lvRPos] = tI; lvRPos = (lvRPos + 1) & 3;
        legatoTrack(f, tI);
        advance(tI);
      },
      // เรียกถี่ ๆ (rAF) — เดินนาฬิกา, หยุดรอใน mode wait, onTime
      tick(c) {
        if (done || stopped) return;
        if (c == null) c = now();
        if (mode === 'wait' && !frozen && !userPaused && p0 < evs.length) {
          const ev = evs[p0];
          if (songAt(c) >= ev.t) {
            const g = segs[segs.length - 1];
            const cc = Math.max(ctxAt(ev.t), g.c);
            ev.armC = cc; frozen = true;
            segs.push({ c: cc, s: ev.t, r: 0 });
            safe(cbs.onWait, { i: ev.i, idx: ev.idx.slice(), t: ev.t });
          }
        }
        // ไมค์เงียบหาย (ไม่มีเฟรม > 1 วินาที) → ใช้นาฬิกาแทนเพื่อไม่ค้าง
        if (mode === 'timed' && lastFrameWall > 0 && c - lastFrameWall > 1.0) advance(c - latency - 0.5);
        if (typeof cbs.onTime === 'function') safe(cbs.onTime, songAt(c));
      },
      songTime(c) { return songAt(c == null ? now() : c); },
      ctxTimeOf(s) { return ctxAt(s); },
      pause() { if (done || userPaused) return; userPaused = true; setRate(now()); },
      resume() { if (done || !userPaused) return; userPaused = false; setRate(now()); },
      skip() {
        if (done) return;
        const ev = evs[p0];
        if (!ev) return;
        lastConsumedT = Math.max(lastConsumedT, lastDataT);
        if (A.on && mode === 'wait') { A.on = false; A.ext = false; }
        finalize(ev, 'miss', null, ev.wrong, true);
        if (frozen) { frozen = false; setRate(now()); }
      },
      stop() { if (stopped) return summary || summarize(); stopped = true; return finish(true); },
      summary() { return summary || summarize(); },
      get done() { return done; },
      get paused() { return userPaused; },
      get waiting() { return frozen; },
    };
    if (!evs.length) { api.tick = () => {}; Promise.resolve().then(() => finish(false)); }
    return api;
  }

  /* ---------------- ส่วนเบราว์เซอร์ ---------------- */
  const hasWin = typeof window !== 'undefined' && typeof navigator !== 'undefined';
  function mkErr(code, msg, cause) {
    const e = new Error(msg || ('practice: ' + code));
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }
  function available() {
    if (!hasWin) return { ok: false, reason: 'no-window', worklet: false };
    if (window.isSecureContext === false) return { ok: false, reason: 'insecure', worklet: false };
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') return { ok: false, reason: 'no-getusermedia', worklet: false };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return { ok: false, reason: 'no-audiocontext', worklet: false };
    const worklet = typeof window.AudioWorkletNode === 'function' && !!AC.prototype && 'audioWorklet' in AC.prototype;
    const sp = !!(AC.prototype && AC.prototype.createScriptProcessor);
    if (!worklet && !sp) return { ok: false, reason: 'no-processor', worklet: false };
    return { ok: true, reason: null, worklet };
  }
  async function permission() {
    try {
      if (!hasWin || !navigator.permissions || !navigator.permissions.query) return 'unknown';
      const st = await navigator.permissions.query({ name: 'microphone' });
      return st.state || 'unknown';
    } catch (e) { return 'unknown'; }
  }
  async function devices() {
    try {
      if (!hasWin || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const ds = await navigator.mediaDevices.enumerateDevices();
      return ds.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || '' }));
    } catch (e) { return []; }
  }

  // AudioWorklet: โหลดจาก Blob ที่สร้างจากโค้ดในไฟล์นี้เอง (ไม่ต้องมีไฟล์แยก, ใช้ออฟไลน์ได้)
  function workletMain(makeLowpass) {
    class AqPracticeProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.D = o.D || 1; this.hop = o.hop || 128;
        this.lp = o.coef && o.coef.length ? makeLowpass(o.coef) : null;
        this.ph = 0; this.fill = 0; this.f0 = 0; this.alive = true;
        this.pool = [];
        for (let i = 0; i < 6; i++) this.pool.push(new Float32Array(this.hop));
        this.buf = this.pool.pop();
        this.port.onmessage = (e) => {
          const d = e.data;
          if (d === 'stop') { this.alive = false; return; }
          if (d && d.b && d.b.length === this.hop && this.pool.length < 16) this.pool.push(d.b);
        };
      }
      process(inputs) {
        if (!this.alive) return false;
        const inp = inputs[0];
        if (!inp || inp.length === 0) return true;
        const nch = inp.length, len = inp[0].length, D = this.D, lp = this.lp, inv = 1 / nch;
        const base = currentFrame; // eslint-disable-line no-undef
        for (let i = 0; i < len; i++) {
          let x = inp[0][i];
          for (let c = 1; c < nch; c++) x += inp[c][i];
          x *= inv;
          if (lp) x = lp.tick(x);
          if (++this.ph >= D) {
            this.ph = 0;
            if (this.fill === 0) this.f0 = base + i;
            this.buf[this.fill++] = x;
            if (this.fill === this.hop) {
              const b = this.buf;
              this.port.postMessage({ b, f: this.f0 }, [b.buffer]);
              this.buf = this.pool.length ? this.pool.pop() : new Float32Array(this.hop);
              this.fill = 0;
            }
          }
        }
        return true;
      }
    }
    registerProcessor('aq-practice', AqPracticeProcessor); // eslint-disable-line no-undef
  }
  const workletLoaded = typeof WeakMap === 'function' ? new WeakMap() : null;
  function loadWorklet(ctx) {
    let p = workletLoaded && workletLoaded.get(ctx);
    if (p) return p;
    const src = 'const makeLowpass = ' + makeLowpass.toString() + ';\n(' + workletMain.toString() + ')(makeLowpass);\n';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } });
    if (workletLoaded) workletLoaded.set(ctx, p);
    p.catch(() => { if (workletLoaded) workletLoaded.delete(ctx); });
    return p;
  }

  // สัญญาณวัด latency: chirp 700→3500Hz ยาว 25ms (คมกว่าคลิกล้วนเมื่อทำ matched filter)
  function chirp(sr, dur, f0, f1) {
    const n = Math.round(sr * dur), x = new Float32Array(n), k = (f1 - f0) / dur;
    for (let i = 0; i < n; i++) {
      const t = i / sr, u = i / (n - 1);
      const env = u < 0.1 ? 0.5 - 0.5 * Math.cos(Math.PI * u / 0.1) : u > 0.9 ? 0.5 - 0.5 * Math.cos(Math.PI * (1 - u) / 0.1) : 1;
      x[i] = env * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
    }
    return x;
  }

  // วิเคราะห์เสียงที่ไมค์อัดได้ระหว่าง calibrate: matched filter หา chirp แต่ละครั้ง → latency (ms) หรือเหตุผลที่ล้มเหลว
  // cap = ตัวอย่างอัตรา wsr เริ่มที่เวลา capStart · times = เวลา (นาฬิกาเดียวกัน) ที่สั่งเล่น chirp
  function calibAnalyze(cap, capStart, times, wsr, cfg) {
    const tpl = chirp(wsr, cfg.dur, cfg.f0, cfg.f1), tn = tpl.length;
    let tE = 0;
    for (let j = 0; j < tn; j++) tE += tpl[j] * tpl[j];
    const tNorm = Math.sqrt(tE);
    const maxLag = Math.round(cfg.maxLag * wsr);
    const lags = [], peaks = [];
    for (const T of times) {
      const s0 = Math.round((T - capStart) * wsr);
      if (s0 < 0 || s0 + maxLag + tn > cap.length) continue;
      let e = 0;
      for (let j = 0; j < tn; j++) e += cap[s0 + j] * cap[s0 + j];
      let best = -1, bestN = 0, bestRaw = 0, sumSq = 0;
      for (let L = 0; L < maxLag; L++) {
        if (L > 0) { const a = cap[s0 + L - 1], b = cap[s0 + L + tn - 1]; e += b * b - a * a; }
        let r = 0;
        for (let j = 0, o = s0 + L; j < tn; j++) r += tpl[j] * cap[o + j];
        sumSq += r * r;
        const nc = Math.abs(r) / (tNorm * Math.sqrt(Math.max(e, 0)) + 1e-9);
        if (Math.abs(r) > bestRaw) { bestRaw = Math.abs(r); best = L; bestN = nc; }
      }
      const rms = Math.sqrt(sumSq / maxLag);
      const pr = rms > 0 ? bestRaw / rms : 0;
      peaks.push({ lagMs: Math.round((best / wsr) * 10000) / 10, ncc: Math.round(bestN * 100) / 100, peakToRms: Math.round(pr * 10) / 10 });
      if (best >= 0 && bestN >= 0.3 && pr >= 5) lags.push(best / wsr);
    }
    const K = times.length;
    const base = { clicks: K, heard: lags.length, peaks };
    // ได้ยินไม่ถึง 60% → ใส่หูฟัง/ปิดเสียง/ไมค์ไกล → ใช้ค่าไม่ได้ (คืน null)
    if (lags.length < Math.ceil(K * 0.6)) return Object.assign(base, { ok: false, reason: 'not-heard', latencyMs: null });
    lags.sort((a, b) => a - b);
    const med = lags[lags.length >> 1];
    const good = lags.filter((l) => Math.abs(l - med) <= 0.004);
    const spreadMs = Math.round((good.length ? good[good.length - 1] - good[0] : 0) * 10000) / 10;
    if (good.length < Math.ceil(K * 0.6)) return Object.assign(base, { ok: false, reason: 'inconsistent', latencyMs: null, spreadMs });
    const mean = good.reduce((a, b) => a + b, 0) / good.length;
    return Object.assign(base, { ok: true, reason: null, latencyMs: Math.round(mean * 10000) / 10, spreadMs });
  }
  // ตารางเวลา chirp ของ calibrate (ห่าง 0.66s + jitter ไม่สม่ำเสมอ กันจับผิดรอบ)
  const CALIB = { K: 5, SP: 0.66, jit: [0, 0.09, 0.03, 0.12, 0.06], dur: 0.025, f0: 700, f1max: 3500, maxLag: 0.55 };

  let live = null, opening = null, openGen = 0; // openGen: closeAll() ระหว่างรอสิทธิ์ไมค์ → ยกเลิก open ที่ค้าง

  function open(opts) {
    opts = opts || {};
    const av = available();
    if (!av.ok) return Promise.reject(mkErr(av.reason));
    if (live && !live.closed) {
      if (!opts.audioContext || opts.audioContext === live.audioContext) {
        if (opts.onFrame !== undefined) live.onFrame = opts.onFrame;
        return Promise.resolve(live);
      }
      live.close();
    }
    if (opening) return opening;
    opening = doOpen(opts).finally(() => { opening = null; });
    return opening;
  }

  async function doOpen(opts) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const gen = openGen;
    const cancelled = () => gen !== openGen || !!(opts.signal && opts.signal.aborted);
    let ctx = opts.audioContext || null, ownCtx = false;
    if (ctx && ctx.state === 'closed') throw mkErr('ctx-closed');
    if (!ctx) { ctx = new AC(); ownCtx = true; }
    if (ctx.state === 'suspended') {
      try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]); } catch (e) { /* ต้องมี user gesture */ }
    }
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: { ideal: 0.01 } };
    if (opts.echoCancellation) audio.echoCancellation = true;
    if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e) {
      if (ownCtx) try { ctx.close(); } catch (e2) { /* ignore */ }
      const n = e && e.name;
      const code = n === 'NotAllowedError' || n === 'PermissionDeniedError' ? 'denied'
        : n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError' ? 'no-mic'
          : n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError' ? 'busy'
            : n === 'SecurityError' ? 'insecure' : 'failed';
      throw mkErr(code, 'practice: microphone ' + code, e);
    }
    const stopTracks = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } };
    if (cancelled()) { stopTracks(); if (ownCtx) ctx.close(); throw mkErr('aborted'); }
    const track = stream.getAudioTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    let src;
    let clockShared = true;
    try {
      src = ctx.createMediaStreamSource(stream);
    } catch (e) {
      // Firefox: AudioContext กับไมค์คนละ sample rate → ใช้ context ของเราเองที่ rate เท่าไมค์
      if (!settings.sampleRate) { stopTracks(); if (ownCtx) ctx.close(); throw mkErr('failed', 'practice: cannot connect microphone', e); }
      if (ownCtx) try { ctx.close(); } catch (e2) { /* ignore */ }
      ctx = new AC({ sampleRate: settings.sampleRate }); ownCtx = true; clockShared = !opts.audioContext;
      try { src = ctx.createMediaStreamSource(stream); } catch (e3) { stopTracks(); ctx.close(); throw mkErr('failed', 'practice: cannot connect microphone', e3); }
    }
    const sr = ctx.sampleRate;
    const dcfg = decimationFor(sr);
    const wsr = dcfg.rate;
    const analyzer = createAnalyzer(wsr, { a4: opts.a4, gateDb: opts.gateDb });
    const hop = analyzer.hop;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let node = null, useWorklet = false;
    const av = available();
    if (av.worklet && !opts.forceScriptProcessor) {
      try {
        await loadWorklet(ctx);
        node = new window.AudioWorkletNode(ctx, 'aq-practice', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          processorOptions: { D: dcfg.D, hop, coef: dcfg.coef },
        });
        useWorklet = true;
      } catch (e) { node = null; }
    }
    if (cancelled()) {
      stopTracks();
      try { src.disconnect(); sink.disconnect(); if (node) node.disconnect(); } catch (e) { /* ignore */ }
      if (ownCtx) ctx.close();
      throw mkErr('aborted');
    }

    const S = {
      audioContext: ctx, sampleRate: sr, analysisRate: wsr, worklet: useWorklet, clockShared,
      deviceLabel: (track && track.label) || '', closed: false,
      latencyMs: null, calibration: null,
      estimatedLatencyMs: Math.round(1000 * ((ctx.baseLatency || 0) + (ctx.outputLatency || 0.01) + (settings.latency || 0.01)) + (useWorklet ? 0 : (2048 / sr) * 1000)),
      onFrame: typeof opts.onFrame === 'function' ? opts.onFrame : null,
      onError: typeof opts.onError === 'function' ? opts.onError : null,
      frame: analyzer.frame,
      stats: { frames: 0, avgMs: 0, maxMs: 0 },
    };
    let follower = null, followTimer = null, rafId = 0, calib = null;
    const perf = typeof performance !== 'undefined' ? performance : Date;

    function emit(f) {
      S.stats.frames++;
      if (S.onFrame) { try { S.onFrame(f); } catch (e) { console.error('[Practice] onFrame', e); } }
      if (follower) follower.frame(f);
    }
    function onChunk(b, n, t0) {
      if (S.closed) return;
      const t1 = perf.now();
      if (calib) calibFeed(b, n, t0);
      analyzer.push(b, n, t0, emit);
      const ms = perf.now() - t1;
      S.stats.avgMs = S.stats.avgMs * 0.98 + ms * 0.02;
      if (ms > S.stats.maxMs) S.stats.maxMs = ms;
    }

    let sp = null;
    if (useWorklet) {
      node.port.onmessage = (e) => {
        const d = e.data;
        if (!d || !d.b) return;
        onChunk(d.b, d.b.length, d.f / sr);
        if (!S.closed) { try { node.port.postMessage({ b: d.b }, [d.b.buffer]); } catch (err) { /* ignore */ } }
      };
      src.connect(node); node.connect(sink);
    } else {
      // ScriptProcessor (Safari เก่า) — ทำงานบน main thread, latency สูงกว่า → แนะนำ calibrate
      const BS = 2048, nch = Math.max(1, Math.min(2, settings.channelCount || 1));
      sp = ctx.createScriptProcessor(BS, nch, 1);
      const dec = makeDecimator(sr), mono = new Float32Array(BS), out = new Float32Array(BS);
      sp.onaudioprocess = (e) => {
        const ib = e.inputBuffer, nc = ib.numberOfChannels, len = ib.length;
        const c0 = ib.getChannelData(0);
        if (nc > 1) { const c1 = ib.getChannelData(1); for (let i = 0; i < len; i++) mono[i] = 0.5 * (c0[i] + c1[i]); } else mono.set(c0);
        const k = dec.run(mono, len, out);
        const t0 = (isFinite(e.playbackTime) ? e.playbackTime : ctx.currentTime) - len / sr;
        onChunk(out, k, t0);
      };
      src.connect(sp); sp.connect(sink);
    }
    if (track) {
      track.addEventListener('ended', () => {
        if (S.closed) return;
        if (S.onError) { try { S.onError(mkErr('ended', 'practice: microphone disconnected')); } catch (e) { /* ignore */ } }
        S.close();
      });
    }

    function stopTicking() {
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = 0;
      if (followTimer) clearInterval(followTimer);
      followTimer = null;
    }
    S.follow = function (expected, fo) {
      if (S.closed) throw mkErr('closed');
      if (calib) throw mkErr('busy', 'practice: calibrating'); // เสียง chirp จะถูกนับเป็นการเล่น
      fo = Object.assign({}, fo || {});
      if (follower) { const old = follower; follower = null; stopTicking(); old.stop(); }
      if (fo.latencyMs == null) fo.latencyMs = S.latencyMs != null ? S.latencyMs : S.estimatedLatencyMs;
      const userDone = fo.onDone;
      let me = null;
      fo.onDone = (sum) => { if (follower === me) { follower = null; stopTicking(); } if (typeof userDone === 'function') userDone(sum); };
      me = createFollower(expected, fo, { now: () => ctx.currentTime });
      follower = me;
      const loop = () => { if (follower !== me) return; me.tick(ctx.currentTime); rafId = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(loop) : 0; };
      if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(loop);
      followTimer = setInterval(() => { if (follower === me) me.tick(ctx.currentTime); }, 100); // แท็บพื้นหลัง (rAF หยุด)
      return {
        stop: () => { const s = me.stop(); if (follower === me) { follower = null; stopTicking(); } return s; },
        pause: () => me.pause(),
        resume: () => me.resume(),
        skip: () => me.skip(),
        summary: () => me.summary(),
        songTime: (c) => me.songTime(c),
        ctxTimeOf: (s) => me.ctxTimeOf(s),
        get done() { return me.done; },
        get waiting() { return me.waiting; },
        get paused() { return me.paused; },
        latencyMs: fo.latencyMs,
      };
    };

    /* ---- calibrate: เล่น chirp ออกลำโพง แล้วหาในไมค์ด้วย matched filter ---- */
    function calibFeed(b, n, t0) {
      const c = calib, cap = c.cap;
      for (let i = 0; i < n; i++) {
        const idx = Math.round((t0 + i / wsr - c.capStart) * wsr);
        if (idx >= 0 && idx < cap.length) cap[idx] = b[i];
      }
      if (t0 + n / wsr >= c.end && !c.analyzing) { c.analyzing = true; setTimeout(() => finishCalib(null), 0); }
    }
    function finishCalib(reasonOverride) {
      const c = calib;
      if (!c) return;
      calib = null;
      clearTimeout(c.timer);
      try { c.gain.disconnect(); } catch (e) { /* ignore */ }
      let result;
      if (reasonOverride) result = { ok: false, reason: reasonOverride, latencyMs: null, heard: 0, clicks: c.times.length };
      else result = analyzeCalib(c);
      S.calibration = result;
      if (result.ok) S.latencyMs = result.latencyMs;
      c.resolve(result.ok ? result.latencyMs : null);
    }
    function analyzeCalib(c) { return calibAnalyze(c.cap, c.capStart, c.times, wsr, c); }
    S.calibrate = function (co) {
      if (S.closed) return Promise.reject(mkErr('closed'));
      if (calib) return calib.promise;
      if (follower && !follower.done) return Promise.reject(mkErr('busy'));
      co = co || {};
      const K = CALIB.K;
      const c = { dur: CALIB.dur, f0: CALIB.f0, f1: Math.min(CALIB.f1max, 0.4 * wsr), maxLag: CALIB.maxLag, times: [], analyzing: false };
      const t0 = ctx.currentTime + 0.3;
      for (let k = 0; k < K; k++) c.times.push(t0 + k * CALIB.SP + CALIB.jit[k]);
      c.capStart = t0 - 0.05;
      c.end = c.times[K - 1] + c.maxLag + c.dur + 0.05;
      c.cap = new Float32Array(Math.ceil((c.end - c.capStart) * wsr) + 64);
      const buf = ctx.createBuffer(1, Math.round(sr * c.dur), sr);
      buf.getChannelData(0).set(chirp(sr, c.dur, c.f0, c.f1));
      c.gain = ctx.createGain();
      c.gain.gain.value = clamp(co.volume != null ? +co.volume : 0.5, 0.05, 1);
      c.gain.connect(ctx.destination);
      for (const T of c.times) { const s = ctx.createBufferSource(); s.buffer = buf; s.connect(c.gain); s.start(T); }
      c.promise = new Promise((resolve) => { c.resolve = resolve; });
      c.timer = setTimeout(() => { if (calib === c) finishCalib('no-input'); }, (c.end - ctx.currentTime + 2.5) * 1000);
      calib = c;
      return c.promise;
    };

    S.close = function () {
      if (S.closed) return;
      S.closed = true;
      if (follower) { const f = follower; follower = null; stopTicking(); f.stop(); }
      if (calib) finishCalib('closed');
      stopTracks();
      try { src.disconnect(); } catch (e) { /* ignore */ }
      if (node) { try { node.port.postMessage('stop'); node.port.onmessage = null; node.disconnect(); } catch (e) { /* ignore */ } }
      if (sp) { try { sp.onaudioprocess = null; sp.disconnect(); } catch (e) { /* ignore */ } }
      try { sink.disconnect(); } catch (e) { /* ignore */ }
      if (ownCtx) { try { ctx.close(); } catch (e) { /* ignore */ } }
      if (live === S) live = null;
    };
    live = S;
    return S;
  }
  function closeAll() { openGen++; if (live) live.close(); }

  return {
    VERSION, NOTE_TOLERANCE: NOTE_TOL, CHORD_THRESHOLD: CHORD_THR,
    available, permission, devices, open, closeAll,
    get session() { return live; },
    // pure helpers (ทดสอบใน Node)
    _pitchYin: pitchYin, _chroma: chromaOf, _matchChord: matchChord, _matchNotes: matchNotes,
    _parseChord: parseChord, _scorePcs: scorePcs, _guessChord: guessChord,
    _createAnalyzer: createAnalyzer, _createFollower: createFollower, _makeDecimator: makeDecimator,
    _decimationFor: decimationFor, _analyzeBuffer: analyzeBuffer, _chirp: chirp, _calibAnalyze: calibAnalyze, _calib: CALIB,
    _params: P, _scoreParams: SC,
  };
});
