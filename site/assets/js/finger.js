/* finger.js — เรียบเรียงกีตาร์โซโล่สไตล์ fingerstyle: ทำนอง + เบส + คอร์ด → โน้ตบนสาย/เฟรตที่คนเล่นได้จริง → แท็บ
   ใช้ได้ทั้งเบราว์เซอร์ (window.Finger) และ Node (module.exports) — ฟังก์ชันล้วน ไม่แตะ DOM/WebAudio
   ต้องการ music.js (Music.parseChord/chordNotes/transposeChord/transposeKey/shapeFor) · เทสต์: tools/test-finger.cjs

   arrange(input) → { notes:[{t,d,midi,s,f,role}], capo, key, bpm, phase, meter, chords, warnings, stats }
     s = สาย 0..5 (E ต่ำ → e สูง) · f = เฟรตนับจาก capo · midi = เสียงจริง (รวม capo) · phase = จังหวะ 1 ของห้อง
   ขั้นตอน:
   1. กริดจังหวะ: ใช้ bpm/phase ที่ให้มา (ไม่มี → ประมาณจากจังหวะเปลี่ยนคอร์ด + onset ทำนอง)
      แล้วเลือก "จังหวะ 1" ของห้องจากจุดเปลี่ยนคอร์ด (คอร์ดมักเปลี่ยนต้นห้อง)
   2. capo 'auto': ลอง capo 0–7 ให้ท่าคอร์ดเป็นคอร์ดเปิดมากสุด + ทำนองลงรีจิสเตอร์ที่เล่นง่าย (capo สูงมีค่าปรับ)
      เสียงที่ได้ยินไม่เปลี่ยน (เล่นตามเพลงต้นฉบับได้) — เปลี่ยนแค่ท่าจับ
   3. ทำนอง: ย้ายออกเทฟทั้งเพลง (หรือทั้งวลี) ให้อยู่ช่วง B3–E5 เทียบ capo (ง่าย: A3–B4) — จังหวะ/ทิศทางทำนองคงเดิม
   4. event: onset ทำนอง + ช่องเบส/เติมตามสไตล์ (เบส/เติมที่ห่างทำนอง ≤ ~1/32 โน้ต ถูกดึงมาดีดพร้อมทำนอง = pinch)
   5. DP เลือกตำแหน่งมือ h (เฟรตนิ้วชี้) ทีละ beat: ทุกโน้ตที่กดใน beat อยู่ในกล่อง h..h+3 (ปกติเหยียดถึง h+4)
      → ช่วงเฟรตใน beat ≤ 3/4 เสมอ · ย้ายมือ > 4 เฟรตระหว่าง beat ติดกันได้เฉพาะรอยต่อคอร์ด/วลี
      ค่าปรับ: สายของทำนอง (ชอบ G/B/e), ไม่อยู่ในท่าคอร์ด (Music.shapeFor), ตำแหน่งสูง, ทิ้งเบส/เติม
   6. ใส่โน้ตจริงตาม h ที่เลือก: เบส = root/5th บนสาย 6/5/4 · เติม = โน้ตในคอร์ดใต้ทำนอง (ต่ำกว่าทำนองเสมอ)
   7. หลังประมวล: สายเดียวกันดังได้ทีละโน้ต (โน้ตใหม่ตัดโน้ตเก่า), ตัดเสียงเบส/เติมที่สูงกว่าทำนองตอนทำนองเข้า,
      ตรวจกฎเล่นได้จริง (check) แล้วซ่อมโดยทิ้งโน้ตเติม/เบสที่ทำให้ผิด — ไม่ทิ้งทำนองเด็ดขาด
   toAsciiTab(notes|result, {bpm, phase, capo, meter, chords}) → แท็บข้อความหลายเสียง + บรรทัดคอร์ด + นับจังหวะ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.Finger = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  const OPEN = [40, 45, 50, 55, 59, 64];          // E2 A2 D3 G3 B3 E4
  const STYLES = ['melody-bass', 'travis', 'arpeggio', 'chord-melody'];
  const MAX_FRET = 20;        // เฟรตจริงสูงสุด (นับจากนัท)
  const MAX_REL = 15;         // เฟรตสูงสุดที่ใช้ (นับจาก capo) — fingerstyle ไม่ขึ้นสูงกว่านี้
  const BEAT_EPS = 0.02;      // โน้ตก่อนจังหวะไม่เกิน 20ms นับเป็น beat นั้น (นิยามเดียวกับ test-riff)
  const HAND = 3;             // มือหนึ่งตำแหน่ง = 4 เฟรต (นิ้วละเฟรต) ใช้วัดระยะย้ายมือ
  const JUMP_MAX = 5;         // ย้ายมือระหว่าง beat ติดกันได้ไม่เกินนี้ (ยกเว้นรอยต่อคอร์ด/วลี)
  const DP_JUMP = 4;          // DP เข้มกว่า 1 เฟรต เผื่อนิ้วก้อยเหยียด
  const MAX_VOICES = 4;       // ดีดพร้อมกันได้ไม่เกิน p-i-m-a
  const BIG = 1e4;
  const MAX_SONG = 3600;      // วินาที — กันอินพุตเวลาเพี้ยน (t = 1e9) ทำให้วนช่องจังหวะไม่จบ
  const ROLE_ID = { fill: 1, bass: 2, melody: 3 };
  const MEL_S = [3, 1.8, 0.7, 0.12, 0, 0];      // ค่าปรับสายของทำนอง: ชอบ G/B/e (เหลือสายต่ำให้เบส)
  const PCN = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const mod12 = (x) => ((x % 12) + 12) % 12;

  /* ---------------- dependency: music.js ---------------- */
  let MUSIC = null;
  function getMusic() {
    if (MUSIC) return MUSIC;
    const ok = (m) => m && typeof m.shapeFor === 'function' && typeof m.parseChord === 'function';
    if (root && ok(root.Music)) return (MUSIC = root.Music);
    if (root && root.window && ok(root.window.Music)) return (MUSIC = root.window.Music);
    if (typeof require === 'function') {
      // music.js เขียน window.Music ตรง ๆ — ใน Node ให้ window ชั่วคราวแล้วเก็บผลไว้
      const had = root && Object.prototype.hasOwnProperty.call(root, 'window');
      try {
        if (!had) root.window = {};
        try { delete require.cache[require.resolve('./music.js')]; } catch (e) { /* ไม่มีแคช */ }
        require('./music.js');
        if (ok(root.window.Music)) MUSIC = root.window.Music;
      } catch (e) { /* ตกไป throw ข้างล่าง */ }
      if (!had && root) { try { delete root.window; } catch (e) { root.window = undefined; } }
      if (MUSIC) return MUSIC;
    }
    throw new Error('finger.js ต้องการ music.js (Music.shapeFor/parseChord/chordNotes)');
  }

  function namePc(n) {
    if (!n) return null;
    const L = PCN[String(n)[0].toUpperCase()];
    if (L == null) return null;
    let p = L;
    for (let i = 1; i < n.length; i++) { if (n[i] === '#') p++; else if (n[i] === 'b') p--; }
    return mod12(p);
  }

  /* ---------------- อินพุต ---------------- */
  function normNotes(arr, mono) {
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach((n) => {
      if (!n) return;
      const t = +(n.t != null ? n.t : n.t0);
      let d = n.d != null ? +n.d : (n.t1 != null ? +n.t1 - t : NaN);
      const m = Math.round(+(n.midi != null ? n.midi : n.pitch));
      if (!isFinite(t) || !isFinite(m) || m < 12 || m > 120 || t > MAX_SONG) return;
      if (!(d > 0) || !isFinite(d)) d = 0.25;
      // ปัดเป็น ms ตั้งแต่ต้น: การแบ่ง beat ภายใน = การแบ่ง beat ของผู้ใช้ผลลัพธ์ (ไม่งั้นโน้ตชิดเส้น beat ตกคนละ beat)
      out.push({ t: r3(Math.max(0, t)), d: Math.max(0.001, r3(Math.min(d, 30))), midi: m });
    });
    out.sort((a, b) => a.t - b.t || b.midi - a.midi);
    if (!mono) return out;
    const res = [];
    for (const n of out) {
      const p = res[res.length - 1];
      if (p && n.t - p.t < 0.02) continue; // ซ้อนเวลาเดียวกัน → เก็บตัวสูงสุด (ทำนองเส้นเดียว)
      res.push(n);
    }
    for (let i = 0; i + 1 < res.length; i++) {
      if (res[i].t + res[i].d > res[i + 1].t) res[i].d = r3(res[i + 1].t - res[i].t);
    }
    return res;
  }

  function normChords(arr) {
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach((c) => {
      if (!c) return;
      const t = +(c.t != null ? c.t : c.t0);
      if (!isFinite(t) || t > MAX_SONG) return;
      out.push({ t: r3(Math.max(0, t)), chord: c.chord != null ? String(c.chord).trim().slice(0, 24) : '' });
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /* ---------------- คอร์ด → pitch class + ท่าจับ (เทียบ capo) ---------------- */
  function chordInfo(M, sym, capo, shapeKey) {
    if (!sym || /^(N\.?C\.?|N|X|-|\?)$/i.test(sym)) return null;
    const p = M.parseChord(sym);
    if (!p) return null;
    const pcs = [];
    (M.chordNotes(sym) || []).forEach((n) => { const x = namePc(n); if (x != null && !pcs.includes(x)) pcs.push(x); });
    if (!pcs.length) return null;
    const rootPc = namePc(p.root);
    const bassPc = p.bass ? namePc(p.bass) : rootPc;
    if (bassPc != null && !pcs.includes(bassPc)) pcs.push(bassPc);
    let altPc = null;
    for (const i of [7, 6, 8]) if (pcs.includes(mod12(rootPc + i))) { altPc = mod12(rootPc + i); break; }
    let thirdPc = null;
    for (const i of [4, 3, 5, 2]) if (pcs.includes(mod12(rootPc + i))) { thirdPc = mod12(rootPc + i); break; }
    if (altPc == null) altPc = thirdPc != null ? thirdPc : rootPc;
    if (thirdPc == null) thirdPc = altPc;
    const shapeSym = capo ? M.transposeChord(sym, -capo, shapeKey || 'C') : sym;
    const raw = M.shapeFor(shapeSym);
    const shape = Array.isArray(raw) && raw.length === 6 ? raw.map((x) => (x == null || x < 0 ? -1 : +x)) : null;
    let fMin = 0, fMax = 0, bassS = -1, opens = 0;
    if (shape) {
      const fr = shape.filter((x) => x > 0);
      if (fr.length) { fMin = Math.min.apply(null, fr); fMax = Math.max.apply(null, fr); }
      bassS = shape.findIndex((x) => x >= 0);
      opens = shape.filter((x) => x === 0).length;
    }
    return { sym, shapeSym, pcs, rootPc, bassPc, altPc, thirdPc, shape, fMin, fMax, bassS, opens };
  }

  // ความยากของท่าคอร์ด (ใช้เลือก capo): คอร์ดเปิด ≈ 0 · ทาบ ≥ 1.5 · ไม่มีท่า 3
  function shapeCost(info) {
    if (!info) return 0;
    if (!info.shape) return 3;
    if (info.opens >= 1 && info.fMax <= 4) return 0.15 * Math.max(0, 3 - info.opens);
    return 1.5 + 0.25 * Math.max(0, info.fMin - 1) + (info.fMax - info.fMin > 3 ? 0.5 : 0);
  }

  /* ---------------- กริดจังหวะ ---------------- */
  function circ(times, period) {
    let C = 0, S = 0;
    for (const t of times) { const a = (2 * Math.PI * t) / period; C += Math.cos(a); S += Math.sin(a); }
    const n = times.length || 1;
    return { R: Math.sqrt(C * C + S * S) / n, phi: (Math.atan2(S, C) / (2 * Math.PI)) * period };
  }

  function estimateGrid(chT, melT) {
    const useC = chT.length >= 3, useM = melT.length >= 6;
    if (!useC && !useM) return null;
    let best = null;
    for (let b = 60; b <= 180; b += 0.5) {
      const beat = 60 / b;
      let sc = 0, w = 0;
      if (useC) { sc += 1.2 * circ(chT, beat).R; w += 1.2; }
      if (useM) { sc += circ(melT, beat / 2).R; w += 1; }
      sc = sc / w - 0.0006 * Math.abs(b - 100);
      if (!best || sc > best.sc + 1e-9) best = { sc, bpm: b };
    }
    const beat = 60 / best.bpm;
    return { bpm: best.bpm, phase: circ(useC ? chT : melT, beat).phi };
  }

  // จังหวะ 1 ของห้อง = ตำแหน่ง beat (mod meter) ที่คอร์ดเปลี่ยนบ่อยสุด
  function downbeatOffset(chT, phase, beat, meter) {
    if (chT.length < 2 || meter < 2) return 0;
    const sc = new Array(meter).fill(0);
    chT.forEach((t, i) => {
      const k = Math.round((t - phase) / beat);
      const err = Math.abs(t - (phase + k * beat)) / beat;
      if (err > 0.25) return;
      sc[((k % meter) + meter) % meter] += i === 0 ? 1.5 : 1;
    });
    let o = 0;
    for (let i = 1; i < meter; i++) if (sc[i] > sc[o] + 1e-9) o = i;
    return o;
  }

  /* ---------------- ทำนอง: เลือกออกเทฟ ---------------- */
  function rangeOf(easy, capo, maxF) {
    return {
      lo: easy ? 57 : 59, hi: easy ? 71 : 76,               // ช่วงที่ชอบ (เทียบ capo)
      hiW: easy ? 2.5 : 1.2,                                // ง่าย: สูงเกิน B4 = ต้องขึ้นคอ → ปรับหนัก
      hardLo: 55, hardHi: Math.min(88, 64 + maxF - 1),      // G3 … เฟรตสูงสุดสาย e
      capo,
    };
  }
  function noteRangeCost(p, R) {
    let c = p < R.lo ? R.lo - p : p > R.hi ? (p - R.hi) * R.hiW : 0;
    if (p < R.hardLo || p > R.hardHi) c += 30;
    return c;
  }
  function octCost(notes, k, R) {
    let c = 0;
    for (const n of notes) c += noteRangeCost(n.midi - R.capo + 12 * k, R);
    return c;
  }
  function bestOct(notes, R, center, span) {
    let bk = center, bc = Infinity;
    for (let k = center - span; k <= center + span; k++) {
      const c = octCost(notes, k, R) + 0.01 * Math.abs(k);
      if (c < bc - 1e-9) { bc = c; bk = k; }
    }
    return { k: bk, c: bc };
  }

  function placeMelody(mel, R, beat) {
    const out = mel.map((n) => Object.assign({}, n, { oct: 0, phrase: 0 }));
    if (!out.length) return { mel: out, kG: 0, phraseShifts: 0, noteShifts: 0 };
    const g = bestOct(out, R, 0, 4);
    // วลี = ช่วงทำนองที่คั่นด้วยที่พัก ≥ ~1 beat
    const gapMin = Math.max(0.3, 0.9 * beat);
    const phrases = [[0]];
    for (let i = 1; i < out.length; i++) {
      const gap = out[i].t - (out[i - 1].t + out[i - 1].d);
      if (gap >= gapMin) phrases.push([i]); else phrases[phrases.length - 1].push(i);
    }
    let phraseShifts = 0, noteShifts = 0;
    phrases.forEach((idx, pi) => {
      const ns = idx.map((i) => out[i]);
      const base = octCost(ns, g.k, R);
      let k = g.k;
      for (const kk of [g.k - 1, g.k + 1]) {
        const c = octCost(ns, kk, R);
        if (c < base - (3 + 0.75 * ns.length) && c < octCost(ns, k, R)) k = kk;
      }
      if (k !== g.k) phraseShifts++;
      ns.forEach((n) => { n.oct = k; n.phrase = pi; });
    });
    out.forEach((n) => {
      let p = n.midi - R.capo + 12 * n.oct;
      // ตัวที่ยังหลุดช่วงที่เล่นได้ → ย้ายเฉพาะโน้ตนั้น (ไม่ควรเกิดกับทำนองปกติ)
      if (p < R.hardLo || p > R.hardHi) {
        while (p < R.hardLo) { p += 12; n.oct++; }
        while (p > R.hardHi) { p -= 12; n.oct--; }
        noteShifts++;
      }
      n.midi = n.midi + 12 * n.oct;
    });
    return { mel: out, kG: g.k, phraseShifts, noteShifts };
  }

  /* ---------------- เลือก capo ---------------- */
  function chooseCapo(M, want, rawCh, songEnd, mel, easy, key) {
    if (want !== 'auto' && want != null && want !== '' && isFinite(+want)) {
      return Math.max(0, Math.min(11, Math.round(+want)));
    }
    const ch = [];
    for (let i = 0; i < rawCh.length; i++) {
      const end = i + 1 < rawCh.length ? rawCh[i + 1].t : Math.max(songEnd, rawCh[i].t + 1);
      ch.push({ sym: rawCh[i].chord, w: Math.max(0.05, end - rawCh[i].t) });
    }
    let best = 0, bc = Infinity;
    for (let c = 0; c <= 7; c++) {
      const sk = key ? M.transposeKey(key, -c) : null;
      let cs = 0, W = 0;
      const cache = new Map();
      for (const x of ch) {
        if (!cache.has(x.sym)) cache.set(x.sym, chordInfo(M, x.sym, c, sk));
        const info = cache.get(x.sym);
        if (!info) continue;
        cs += x.w * shapeCost(info); W += x.w;
      }
      const maxF = Math.min(MAX_REL, MAX_FRET - c);
      const R = rangeOf(easy, c, maxF);
      const mc = mel.length ? bestOct(mel, R, 0, 4).c / mel.length : 0;
      // ง่าย: ทำนองต้องลงตำแหน่งต้นคอ → ให้น้ำหนักทำนองมาก (capo ช่วยดึงทำนองสูงลงมาได้โดยเสียงจริงไม่เปลี่ยน)
      const total = (easy ? 1 : 0.5) * (W ? cs / W : 0) + 0.08 * c + (c >= 5 ? 0.12 * (c - 4) : 0) + (easy ? 0.6 : 0.25) * mc;
      if (total < bc - 1e-9) { bc = total; best = c; }
    }
    return best;
  }

  /* ---------------- รูปแบบการดีดต่อสไตล์ (ช่องละ 1/8 โน้ต) ----------------
     คืน { bass: null|'root'|'alt', fills: [{mode, j}] } · mode: fill (สายเป้า G/B/e ตาม j) ·
     arp (i/m/a = j 0/1/2 ใต้ทำนอง) · harm (เสียงประสานติดใต้ทำนอง) */
  function slotReq(style, easy, b, off, meter) {
    const R = { bass: null, fills: [] };
    if (style === 'melody-bass') {
      if (!off && (b === 0 || (!easy && meter === 4 && b === 2))) R.bass = 'root';
    } else if (style === 'travis') {
      if (easy) {
        if (!off) {
          if (b === 0) R.bass = 'root';
          else if (meter >= 4 && b === 2) R.bass = 'alt';
          else R.fills.push({ mode: 'fill', j: b % 2 ? 0 : 1 });
        }
      } else if (!off) R.bass = b % 2 ? 'alt' : 'root';
      else R.fills.push({ mode: 'fill', j: [1, 0, 1, 2][b % 4] });
    } else if (style === 'arpeggio') {
      if (easy) {
        if (!off) {
          if (b === 0) R.bass = 'root';
          else R.fills.push({ mode: 'arp', j: (b - 1) % 3 });
        }
      } else {
        const pos = (b % 2) * 2 + off; // ทีละ 2 beat: p i m a
        if (pos === 0) R.bass = b === 0 ? 'root' : 'alt';
        else R.fills.push({ mode: 'arp', j: pos - 1 });
      }
    } else if (style === 'chord-melody') {
      if (!off && b === 0) {
        R.bass = 'root';
        for (let j = 0; j < (easy ? 1 : 2); j++) R.fills.push({ mode: 'harm', j });
      } else if (!off && meter === 4 && b === 2) {
        R.bass = 'root';
        if (!easy) for (let j = 0; j < 2; j++) R.fills.push({ mode: 'harm', j });
      }
    }
    return R;
  }

  /* ---------------- ใส่โน้ตลงสาย/เฟรต (กล่องมือ h) ---------------- */
  function newState() {
    return { end: new Float64Array(6), role: new Int8Array(6), midi: new Int16Array(6), lastMelS: -1, rootS: -1 };
  }
  function resetState(st) {
    st.end.fill(0); st.role.fill(0); st.midi.fill(0); st.lastMelS = -1; st.rootS = -1;
  }
  const fretOK = (f, h, A) => f === 0 || (f >= h && f <= h + A.box && f <= A.maxF);
  const fretCost = (f, h, A) => (f === 0 ? 0 : (f - h >= 4 ? 0.5 : 0) + (f > 12 ? 0.1 * (f - 12) : 0)); // h+4 = เหยียดนิ้วก้อย
  const fits = (info, h, A) => !info.shape || info.fMax === 0 || (info.fMin >= h && info.fMax <= h + A.box);

  function pickBass(A, ev, h, st, ceilS, ceilP, held) {
    const info = ev.info;
    const rootPc = ev.bassPc != null ? ev.bassPc : info.bassPc;
    const T = ev.bass === 'alt'
      ? [[info.altPc, 0], [info.thirdPc, 0.3], [rootPc, 0.5]]
      : [[rootPc, 0], [info.altPc, 0.8], [info.thirdPc, 1.1]];
    let best = null, bc = Infinity;
    const sMax = Math.min(2, ceilS - 1);
    for (let s = 0; s <= sMax; s++) {
      if (st.role[s] === 3 && st.end[s] > ev.t + 0.02) continue; // ห้ามตัดทำนองที่ยังดังอยู่
      for (let q = 0; q < T.length; q++) {
        const pc = T[q][0];
        if (pc == null || (q && T.slice(0, q).some((x) => x[0] === pc))) continue;
        for (let f = mod12(pc - A.openS[s]); f <= A.maxF; f += 12) {
          if (!fretOK(f, h, A)) continue;
          const midi = A.openS[s] + f;
          if (midi >= ceilP) continue;
          let c = T[q][1] + fretCost(f, h, A);
          if (ev.bass === 'alt') {
            if (s === st.rootS) c += 0.6; else if (st.rootS >= 0 && Math.abs(s - st.rootS) > 1) c += 0.1;
          } else c += info.bassS >= 0 ? (s === info.bassS ? 0 : 0.2 + 0.1 * Math.abs(s - info.bassS)) : 0.08 * s;
          if (held) { // จับท่าคอร์ดค้างไว้: ใช้เสียงในท่า · กดนอกท่า = ต้องปล่อยนิ้ว · สายเปล่าที่ท่าบอด (x) = เสียงแปลกปลอม
            const sf = info.shape[s];
            if (sf === f) c -= 0.15; else if (f > 0) c += 0.2; else if (sf < 0) c += 0.15;
          }
          if (midi - A.capo > 55) c += 0.5;
          if (c < bc) { bc = c; best = { s, f, midi, role: 'bass', cost: c }; }
        }
      }
    }
    return best;
  }

  function pickFill(A, ev, req, h, st, ceilS, ceilP, floorS, floorP, held, used, usedPc) {
    const info = ev.info;
    const topS = Math.min(5, ceilS - 1);
    if (topS < floorS) return null;
    let tS = req.mode === 'arp' ? topS - (2 - req.j) : req.mode === 'harm' ? topS - req.j : Math.min(topS, 3 + req.j);
    if (tS < floorS) tS = floorS;
    let best = null, bc = Infinity;
    for (let s = floorS; s <= topS; s++) {
      if (used & (1 << s)) continue;
      if (st.role[s] === 3 && st.end[s] > ev.t + 0.02) continue;
      for (const pc of info.pcs) {
        for (let f = mod12(pc - A.openS[s]); f <= A.maxF; f += 12) {
          if (!fretOK(f, h, A)) continue;
          const midi = A.openS[s] + f;
          if (midi >= ceilP || midi <= floorP) continue;
          let c = 0.3 * Math.abs(s - tS) + fretCost(f, h, A);
          if (held) c += info.shape[s] === f ? -0.2 : 0.25;          // อยู่ในท่าคอร์ดที่จับค้างไว้ = ไม่ต้องขยับนิ้ว
          if (usedPc & (1 << pc)) c += 0.08;                        // ซ้ำเสียง (root ซ้ำเป็นเรื่องปกติของคอร์ดเปิด)
          if (ceilP < 999 && pc === ceilP % 12) c += 0.12;          // ซ้ำเสียงทำนองต่ำกว่าออกเทฟ
          if (c < bc) { bc = c; best = { s, f, midi, role: 'fill', cost: c }; }
        }
      }
    }
    return best;
  }

  // ใส่โน้ตของ event หนึ่งในกล่องมือ h → { cost, picks } (ไม่แก้ state)
  function assignEvent(A, ev, h, st) {
    const info = ev.info;
    const held = !!(info && info.shape && fits(info, h, A));
    const mCands = [];
    if (ev.mel >= 0) {
      const m = A.mel[ev.mel].midi;
      for (let s = 0; s < 6; s++) {
        const f = m - A.openS[s];
        if (f < 0 || f > A.maxF || !fretOK(f, h, A)) continue;
        let c = MEL_S[s] + fretCost(f, h, A) + (f === 0 ? 0.03 : 0);
        if (held && f > 0 && info.shape[s] === f) c -= 0.2;
        if (st.lastMelS >= 0) c += 0.08 * Math.max(0, Math.abs(s - st.lastMelS) - 1);
        mCands.push({ s, f, midi: m, role: 'melody', cost: c });
      }
      if (!mCands.length) {
        // ไม่มีในกล่องนี้ → วางที่ใกล้กล่องสุด (ค่าปรับสูงมาก DP จะเลี่ยงเอง)
        let bs = -1, bd = Infinity;
        for (let s = 0; s < 6; s++) {
          const f = m - A.openS[s];
          if (f < 0 || f > A.maxF) continue;
          const dd = f < h ? h - f : f > h + A.box ? f - h - A.box : 0;
          if (dd < bd) { bd = dd; bs = s; }
        }
        if (bs < 0) bs = m < A.openS[0] ? 0 : 5;
        const f = Math.max(0, Math.min(A.maxF, m - A.openS[bs]));
        mCands.push({ s: bs, f, midi: A.openS[bs] + f, role: 'melody', cost: BIG * (1 + bd) });
      }
    } else mCands.push(null);

    // เพดาน: ทำนองที่ยังดังอยู่ตอนนี้ (event ที่ไม่มีทำนองเข้า)
    let ceilS0 = 6, ceilP0 = 999;
    if (ev.mel < 0) {
      if (ev.soundMel >= 0) ceilP0 = A.mel[ev.soundMel].midi;
      for (let s = 0; s < 6; s++) {
        if (st.role[s] === 3 && st.end[s] > ev.t + 0.02) { ceilS0 = s; ceilP0 = Math.min(ceilP0, st.midi[s]); }
      }
    }
    let best = null, bc = Infinity;
    for (const mc of mCands) {
      let cost = mc ? mc.cost : 0;
      const picks = mc ? [mc] : [];
      const ceilS = mc ? mc.s : ceilS0, ceilP = mc ? mc.midi : ceilP0;
      let used = mc ? 1 << mc.s : 0, usedPc = 0;
      let floorS = 2, floorP = 0;
      if (info && ev.bass) {
        const b = pickBass(A, ev, h, st, ceilS, ceilP, held);
        if (b) { cost += b.cost; picks.push(b); used |= 1 << b.s; usedPc |= 1 << mod12(b.midi); floorS = b.s + 1; floorP = b.midi; }
        else cost += ev.change ? 4 : 1.5;
      }
      if (info && ev.fills.length) {
        if (!ev.bass && ev.fills[0].mode === 'harm') floorS = 1;
        for (const rq of ev.fills) {
          const fp = pickFill(A, ev, rq, h, st, ceilS, ceilP, floorS, floorP, held, used, usedPc);
          if (fp) { cost += fp.cost; picks.push(fp); used |= 1 << fp.s; usedPc |= 1 << mod12(fp.midi); }
          else cost += 0.5;
        }
      }
      if (cost < bc) { bc = cost; best = picks; }
    }
    return { cost: bc, picks: best };
  }

  function commit(A, st, ev, picks) {
    for (const p of picks) {
      const d = p.role === 'melody' ? A.mel[ev.mel].d : p.role === 'bass' ? ev.bassD : ev.fillD;
      st.end[p.s] = ev.t + d; st.role[p.s] = ROLE_ID[p.role]; st.midi[p.s] = p.midi;
      if (p.role === 'melody') st.lastMelS = p.s;
      if (p.role === 'bass' && ev.bass === 'root') st.rootS = p.s;
    }
  }

  /* ---------------- ตรวจกฎเล่นได้จริง ---------------- */
  // ระยะย้ายมือขั้นต่ำระหว่าง 2 beat (มือคลุม p..p+HAND, a/b = เฟรตต่ำ/สูงสุดที่กดใน beat)
  function handShift(a1, b1, a2, b2) {
    const lo1 = Math.max(1, b1 - HAND), hi1 = Math.max(lo1, a1);
    const lo2 = Math.max(1, b2 - HAND), hi2 = Math.max(lo2, a2);
    if (hi1 < lo2) return lo2 - hi1;
    if (hi2 < lo1) return lo1 - hi2;
    return 0;
  }

  /* V: { capo, bpm, phase, span, changes:[t], mel:[{t,d}] } → [{type, k, t, idx:[note index], msg}] */
  function violations(notes, V) {
    const out = [];
    const beat = 60 / V.bpm, phase = V.phase;
    const beatOf = (t) => Math.floor((t - phase + BEAT_EPS) / beat);
    const maxF = MAX_FRET - V.capo;
    // ความถูกต้องของเสียง/ตำแหน่ง
    notes.forEach((n, i) => {
      if (!(n.s >= 0 && n.s <= 5) || n.f !== Math.round(n.f) || n.f < 0 || n.f > maxF || OPEN[n.s] + V.capo + n.f !== n.midi) {
        out.push({ type: 'pitch', t: n.t, idx: [i], msg: `s${n.s} f${n.f} ≠ ${n.midi}` });
      }
      if (!(n.d > 0) || !isFinite(n.t)) out.push({ type: 'time', t: n.t, idx: [i], msg: 'd ≤ 0' });
    });
    // สายเดียวกัน: ดังได้ทีละโน้ต
    const byS = [[], [], [], [], [], []];
    notes.forEach((n, i) => { if (n.s >= 0 && n.s <= 5) byS[n.s].push(i); });
    byS.forEach((list) => {
      list.sort((a, b) => notes[a].t - notes[b].t);
      for (let j = 1; j < list.length; j++) {
        const p = notes[list[j - 1]], q = notes[list[j]];
        if (q.t - p.t < 1e-6) out.push({ type: 'string', t: q.t, idx: [list[j - 1], list[j]], msg: `สาย ${q.s} ดีด 2 โน้ตพร้อมกัน` });
        else if (p.t + p.d > q.t + 1e-6) out.push({ type: 'overlap', t: q.t, idx: [list[j - 1]], msg: `สาย ${q.s} ยังดังทับโน้ตถัดไป` });
      }
    });
    // ดีดพร้อมกันเกินนิ้ว
    const byT = new Map();
    notes.forEach((n, i) => { const k = Math.round(n.t * 1000); if (!byT.has(k)) byT.set(k, []); byT.get(k).push(i); });
    byT.forEach((list) => {
      const fr = list.filter((i) => notes[i].f > 0);
      if (list.length > MAX_VOICES || fr.length > 4) out.push({ type: 'fingers', t: notes[list[0]].t, idx: list, msg: `ดีดพร้อมกัน ${list.length} เสียง (กด ${fr.length})` });
    });
    // ช่วงเฟรตใน beat + ย้ายมือ
    const byB = new Map();
    notes.forEach((n, i) => { if (n.f > 0) { const k = beatOf(n.t); if (!byB.has(k)) byB.set(k, []); byB.get(k).push(i); } });
    const range = (list) => { let a = Infinity, b = -Infinity; list.forEach((i) => { a = Math.min(a, notes[i].f); b = Math.max(b, notes[i].f); }); return [a, b]; };
    const changeBeats = new Set();
    (V.changes || []).forEach((t) => { changeBeats.add(beatOf(t)); changeBeats.add(beatOf(t + beat / 2)); });
    const restBeats = new Set();
    const ml = V.mel || [];
    ml.forEach((m, i) => { if (!i || m.t - (ml[i - 1].t + ml[i - 1].d) >= beat / 2 - 1e-6) restBeats.add(beatOf(m.t)); });
    byB.forEach((list, k) => {
      const [a, b] = range(list);
      if (b - a > V.span) out.push({ type: 'span', k, t: phase + k * beat, idx: list, msg: `beat ${k} ช่วงเฟรต ${a}–${b}` });
      const prev = byB.get(k - 1);
      if (!prev || changeBeats.has(k) || restBeats.has(k)) return;
      const [pa, pb] = range(prev);
      const sh = handShift(pa, pb, a, b);
      if (sh > JUMP_MAX) out.push({ type: 'jump', k, t: phase + k * beat, idx: prev.concat(list), msg: `ย้ายมือ ${sh} เฟรต (${pa}–${pb} → ${a}–${b})` });
    });
    // ทำนองต้องเป็นเสียงสูงสุดตอนเข้า
    const mels = notes.map((n, i) => i).filter((i) => notes[i].role === 'melody');
    if (mels.length) {
      const others = notes.map((n, i) => i).filter((i) => notes[i].role !== 'melody').sort((a, b) => notes[a].t - notes[b].t);
      let lo = 0;
      for (const mi of mels) {
        const m = notes[mi];
        while (lo < others.length && notes[others[lo]].t + 8 < m.t) lo++;
        for (let j = lo; j < others.length; j++) {
          const n = notes[others[j]];
          if (n.t > m.t + 1e-6) break;
          if (n.t + n.d > m.t + 1e-6 && n.midi >= m.midi) out.push({ type: 'top', t: m.t, idx: [others[j]], msg: `โน้ต ${n.role} ${n.midi} ดังทับทำนอง ${m.midi}` });
        }
      }
    }
    return out;
  }

  /* ---------------- หลังประมวล: ความยาวโน้ต ----------------
     ทำงานบนเวลาที่ปัดเป็นมิลลิวินาทีแล้ว (ปัดทีหลังจะทำให้โน้ตเกินโน้ตถัดไปบนสายเดียวกัน 1ms) */
  function fixDurations(notes, changes, own) {
    for (const n of notes) { n.t = r3(n.t); n.d = Math.max(0.001, r3(n.d)); }
    // 1) เบส/เติมหยุดที่จุดเปลี่ยนคอร์ดถัดไป (เสียงคอร์ดเก่าไม่ลากทับคอร์ดใหม่)
    //    จุดเปลี่ยนที่ห่างไม่เกิน own = จุดเปลี่ยนของโน้ตนี้เอง (เบสที่ดึงไปดีดพร้อมทำนองซึ่งมาก่อนนิดหน่อย)
    if (changes.length) {
      for (const n of notes) {
        if (n.role === 'melody') continue;
        let lo = 0, hi = changes.length;
        while (lo < hi) { const md = (lo + hi) >> 1; if (r3(changes[md]) <= n.t + own) lo = md + 1; else hi = md; }
        if (lo < changes.length && r3(changes[lo]) < n.t + n.d) n.d = r3(r3(changes[lo]) - n.t);
      }
    }
    // 2) สายเดียวกันดังทีละโน้ต
    const byS = [[], [], [], [], [], []];
    notes.forEach((n) => byS[n.s].push(n));
    byS.forEach((list) => {
      list.sort((a, b) => a.t - b.t);
      for (let j = 0; j + 1 < list.length; j++) {
        if (list[j].t + list[j].d > list[j + 1].t) list[j].d = r3(list[j + 1].t - list[j].t);
      }
    });
    // 3) ทำนองเข้า → เสียงอื่นที่สูงเท่า/กว่ายังดังอยู่ต้องหยุด
    const mel = notes.filter((n) => n.role === 'melody').sort((a, b) => a.t - b.t);
    if (mel.length) {
      const mt = mel.map((m) => m.t);
      for (const n of notes) {
        if (n.role === 'melody') continue;
        let lo = 0, hi = mt.length;
        while (lo < hi) { const md = (lo + hi) >> 1; if (mt[md] <= n.t + 1e-6) lo = md + 1; else hi = md; }
        for (let j = lo; j < mel.length && mel[j].t < n.t + n.d - 1e-6; j++) {
          if (mel[j].midi <= n.midi) { n.d = r3(mel[j].t - n.t); break; }
        }
      }
    }
    // 4) เบส/เติมที่ถูกตัดจนเหลือแค่เสียงคลิก (< 30ms) → ทิ้ง (ทำนองไม่ทิ้ง)
    const removed = { bass: 0, fill: 0 };
    for (let i = notes.length - 1; i >= 0; i--) {
      if (notes[i].role !== 'melody' && notes[i].d < 0.03) { removed[notes[i].role]++; notes.splice(i, 1); }
    }
    return removed;
  }

  /* ================= arrange ================= */
  function arrange(input) {
    input = input || {};
    const M = getMusic();
    const warnings = [];
    const style = STYLES.includes(input.style) ? input.style : 'melody-bass';
    if (input.style && !STYLES.includes(input.style)) warnings.push('style-unknown: ' + input.style + ' → melody-bass');
    const easy = input.difficulty === 'easy';
    const box = easy ? 3 : 4, spanMax = easy ? 4 : 5;
    const meter = [2, 3, 4, 5, 6, 7].includes(+input.meter) ? +input.meter : 4;

    const melIn = normNotes(input.melody, true);
    const bassIn = normNotes(input.bass, true);
    const rawCh = normChords(input.chords);
    const validCh = rawCh.filter((c) => M.parseChord(c.chord));
    if (!melIn.length) warnings.push('no-melody: เล่นเฉพาะแพทเทิร์นคอร์ด');
    if (!validCh.length) warnings.push(bassIn.length ? 'no-chords: ใช้เบสจากแทร็กเบส' : 'no-chords: เล่นเฉพาะทำนอง');

    /* ---- 1. กริดจังหวะ ---- */
    const chT = [];
    rawCh.forEach((c, i) => { if (!i || c.chord !== rawCh[i - 1].chord) chT.push(c.t); });
    let bpm = +input.bpm > 0 && isFinite(+input.bpm) ? Math.max(30, Math.min(300, +input.bpm)) : null;
    let phase = input.phase != null && input.phase !== '' && isFinite(+input.phase) ? +input.phase : null;
    if (!bpm) {
      const est = estimateGrid(chT, melIn.map((n) => n.t));
      bpm = est ? est.bpm : 90;
      if (phase == null && est) phase = est.phase;
      warnings.push('bpm-estimated: ' + bpm);
    }
    bpm = Math.round(bpm * 100) / 100; // ค่าเดียวกับที่คืนออกไป (ผู้ใช้ผลแบ่ง beat ได้ตรงกับภายใน)
    const beat = 60 / bpm, step = beat / 4, half = beat / 2, bar = beat * meter;
    if (phase == null) {
      const ts = chT.length >= 2 ? chT : melIn.map((n) => n.t);
      phase = ts.length ? circ(ts, beat).phi : 0;
    }
    phase += downbeatOffset(chT, phase, beat, meter) * beat;
    const tFirst = Math.min(melIn.length ? melIn[0].t : Infinity, rawCh.length ? rawCh[0].t : Infinity, bassIn.length ? bassIn[0].t : Infinity);
    const P = r3(isFinite(tFirst) ? phase - Math.ceil((phase - tFirst) / bar - 1e-9) * bar : phase);
    const snapT = (t) => r3(P + Math.round((t - P) / step) * step);
    const beatOf = (t) => Math.floor((t - P + BEAT_EPS) / beat);
    let songEnd = 0;
    melIn.forEach((n) => { songEnd = Math.max(songEnd, n.t + n.d); });
    bassIn.forEach((n) => { songEnd = Math.max(songEnd, n.t + n.d); });
    if (rawCh.length) songEnd = Math.max(songEnd, rawCh[rawCh.length - 1].t + bar);
    if (+input.duration > 0) songEnd = Math.max(songEnd, +input.duration);

    /* ---- 2. capo + คีย์ ---- */
    const key = input.key ? String(input.key) : guessKey(M, rawCh, songEnd);
    const capo = chooseCapo(M, input.capo == null ? 'auto' : input.capo, rawCh, songEnd, melIn, easy, key);
    const shapeKey = key ? M.transposeKey(key, -capo) : null;
    const maxF = Math.min(MAX_REL, MAX_FRET - capo);
    const openS = OPEN.map((x) => x + capo);

    /* ---- 3. ทำนองลงรีจิสเตอร์ที่เล่นได้ ---- */
    const R = rangeOf(easy, capo, maxF);
    const pm = placeMelody(melIn, R, beat);
    const mel = pm.mel;
    if (pm.kG) warnings.push('melody-octave: ' + (pm.kG > 0 ? '+' : '') + pm.kG + ' (ทั้งเพลง)');
    if (pm.phraseShifts) warnings.push('phrase-octave: ' + pm.phraseShifts + ' วลีย้ายออกเทฟต่างจากทั้งเพลง');
    if (pm.noteShifts) warnings.push('note-octave: ' + pm.noteShifts + ' โน้ตหลุดช่วงกีตาร์ ย้ายเฉพาะตัว');

    /* ---- 4. ช่วงคอร์ด ---- */
    const infoCache = new Map();
    const infoOf = (sym) => { if (!infoCache.has(sym)) infoCache.set(sym, chordInfo(M, sym, capo, shapeKey)); return infoCache.get(sym); };
    const segs = [];
    for (const c of rawCh) {
      // snap เข้ากริด 1/16 เฉพาะเมื่อใกล้กริดจริง (BPM ที่ประมาณเองคลาดได้ → เวลาคอร์ดจริงแม่นกว่า)
      const sn = snapT(c.t);
      const t = Math.abs(sn - c.t) <= 0.035 ? sn : c.t;
      const last = segs[segs.length - 1];
      if (last && last.chord === c.chord) continue;
      if (last && t - last.t < 1e-6) { last.chord = c.chord; last.t0 = c.t; continue; }
      segs.push({ t, t0: c.t, chord: c.chord });
    }
    for (let i = segs.length - 1; i > 0; i--) if (segs[i].chord === segs[i - 1].chord) segs.splice(i, 1);
    segs.forEach((s, i) => { s.end = i + 1 < segs.length ? segs[i + 1].t : Math.max(songEnd, s.t + step); s.info = infoOf(s.chord); });
    if (!segs.length && bassIn.length) {
      // ไม่มีคอร์ด แต่มีเบส → คอร์ดเทียม (root + 5th) ตามโน้ตเบส
      bassIn.forEach((b) => {
        const pc = mod12(b.midi), t = snapT(b.t);
        const last = segs[segs.length - 1];
        if (last && last.info.rootPc === pc) return;
        if (last && t - last.t < 1e-6) return;
        segs.push({ t, chord: null, info: { sym: null, shapeSym: null, pcs: [pc, mod12(pc + 7)], rootPc: pc, bassPc: pc, altPc: mod12(pc + 7), thirdPc: mod12(pc + 7), shape: null, fMin: 0, fMax: 0, bassS: -1, opens: 0 } });
      });
      segs.forEach((s, i) => { s.end = i + 1 < segs.length ? segs[i + 1].t : Math.max(songEnd, s.t + step); });
    }
    const segT = segs.map((s) => s.t);
    const segAt = (t) => {
      let lo = 0, hi = segT.length;
      while (lo < hi) { const md = (lo + hi) >> 1; if (segT[md] <= t) lo = md + 1; else hi = md; }
      const s = segs[lo - 1];
      return s && t < s.end ? s : null;
    };
    const changes = segs.filter((s) => s.info).map((s) => s.t);

    /* ---- 5. event ---- */
    const eps = Math.min(0.07, 0.6 * step);
    const melT = mel.map((n) => n.t);
    const lowerBound = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const md = (lo + hi) >> 1; if (arr[md] < t) lo = md + 1; else hi = md; } return lo; };
    const nearestMel = (t) => {
      const i = lowerBound(melT, t);
      let j = -1, bd = Infinity;
      for (const c of [i - 1, i]) if (c >= 0 && c < melT.length && Math.abs(melT[c] - t) < bd) { bd = Math.abs(melT[c] - t); j = c; }
      return j >= 0 && bd <= eps ? j : -1;
    };
    const soundingMel = (t) => { // ทำนองที่กำลังดังที่เวลา t (ไม่นับตัวที่เพิ่งจะเข้า)
      const i = lowerBound(melT, t + 1e-6) - 1;
      return i >= 0 && mel[i].t + mel[i].d > t + 0.02 ? i : -1;
    };
    const melSilent = (a, b) => {
      const i = lowerBound(melT, b) - 1;
      for (let j = i; j >= 0 && j >= i - 4; j--) if (mel[j].t < b && mel[j].t + mel[j].d > a + 0.01) return false;
      return true;
    };
    const busy = new Map();
    mel.forEach((n) => { const k = beatOf(n.t); busy.set(k, (busy.get(k) || 0) + 1); });
    const busyMax = easy ? 2 : 3;

    const melEv = mel.map((n, i) => ({ t: n.t, mel: i, bass: null, change: false, fills: [], bassPc: null }));
    const acc = new Map();
    // ref = เวลาจริงที่ต้องไม่คลาด (จุดเปลี่ยนคอร์ดก่อน snap) — ดึงไปดีดพร้อมทำนองได้เมื่อใกล้ทั้ง t และ ref
    const attach = (t, ref) => {
      const j = nearestMel(t);
      if (j >= 0 && (ref == null || Math.abs(melT[j] - ref) <= eps)) return melEv[j];
      const k = Math.round((t - P) / step);
      let ev = acc.get(k);
      if (!ev) { ev = { t: r3(Math.abs(P + k * step - t) < 1e-6 ? P + k * step : t), mel: -1, bass: null, change: false, fills: [], bassPc: null }; acc.set(k, ev); }
      return ev;
    };
    const addBass = (ev, kind, change) => { if (!ev.bass || kind === 'root') ev.bass = kind; if (change) ev.change = true; };
    const addFill = (ev, mode, j, tSlot) => {
      if (ev.mel >= 0 && mode !== 'harm') return;                 // นิ้วนั้นไปดีดทำนองแทน
      if (mode !== 'harm' && (busy.get(beatOf(tSlot)) || 0) >= busyMax) return; // ทำนองถี่ → ไม่เติม
      if (ev.fills.some((f) => f.mode === mode && f.j === j)) return;
      ev.fills.push({ mode, j });
    };
    // จุดเปลี่ยนคอร์ด: เบส root เสมอ (event ที่ถูกดึงไปดีดพร้อมทำนองซึ่งมาก่อนจุดเปลี่ยนนิดหน่อย ยังเป็นคอร์ดใหม่)
    for (const s of segs) {
      if (!s.info) continue;
      const ev = attach(s.t, s.t0 != null ? s.t0 : s.t);
      addBass(ev, 'root', true);
      ev.changeSeg = s;
      if (style === 'chord-melody') {
        const n = (easy ? 1 : 2) + (ev.mel < 0 && soundingMel(ev.t) < 0 ? 1 : 0);
        for (let j = 0; j < n; j++) addFill(ev, 'harm', j, ev.t);
      }
    }
    // ช่องตามสไตล์ (ทีละ 1/8)
    if (segs.length) {
      const qa = Math.ceil((segs[0].t - P) / half - 1e-6), qb = Math.ceil((songEnd - P) / half - 1e-6);
      const perBar = 2 * meter;
      for (let q = qa; q < qb; q++) {
        const ts = P + q * half;
        const seg = segAt(ts + 1e-4);
        if (!seg || !seg.info) continue;
        if (seg.end - ts < 0.75 * step && seg.end < songEnd - 1e-6) continue; // คอร์ดเปลี่ยนนอกกริดชิดหลังช่องนี้ → ให้จุดเปลี่ยนคอร์ดดีดแทน
        const pos = ((q % perBar) + perBar) % perBar, b = pos >> 1, off = pos & 1;
        const rq = slotReq(style, easy, b, off, meter);
        const restBeat = !off && melSilent(ts, ts + beat);
        if (style === 'melody-bass' && restBeat && (!easy || b === 0 || b === 2)) {
          rq.fills.push({ mode: 'fill', j: 1 });
          if (!easy && rq.bass) rq.fills.push({ mode: 'fill', j: 0 });
        }
        if (!rq.bass && !rq.fills.length) continue;
        const ev = attach(ts);
        if (rq.bass) addBass(ev, rq.bass, false);
        let extra = 0;
        if (style === 'chord-melody' && rq.fills.length && ev.mel < 0 && soundingMel(ev.t) < 0) extra = 1;
        rq.fills.forEach((f) => addFill(ev, f.mode, f.j, ts));
        if (extra) addFill(ev, 'harm', rq.fills.length, ts);
      }
    }
    const events = melEv.concat(Array.from(acc.values()).filter((e) => e.bass || e.fills.length));
    events.sort((a, b) => a.t - b.t || b.mel - a.mel);
    // คอร์ด/เบสจริง/ความยาวที่ตั้งใจให้ดัง
    const bassT = bassIn.map((b) => b.t);
    let nextBassT = Infinity;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const seg = ev.changeSeg || segAt(ev.t + (ev.mel >= 0 ? 0.03 : 1e-4));
      ev.info = seg ? seg.info : null;
      ev.segEnd = seg ? seg.end : ev.t + beat;
      ev.soundMel = ev.mel >= 0 ? -1 : soundingMel(ev.t);
      ev.bassD = Math.max(step, Math.min(2 * beat, nextBassT - ev.t, ev.segEnd - ev.t));
      ev.fillD = Math.max(step, Math.min((style === 'chord-melody' || ev.soundMel < 0 ? 2 : 1) * beat, ev.segEnd - ev.t));
      if (ev.bass && ev.info) {
        nextBassT = ev.t;
        if (bassIn.length && ev.bass === 'root') {
          // แทร็กเบสจริงที่ดังอยู่ตอนนี้และเป็นโน้ตในคอร์ด → ใช้แทน root (inversion/เบสเดิน)
          const j = lowerBound(bassT, ev.t + 0.06) - 1;
          if (j >= 0 && bassIn[j].t + bassIn[j].d > ev.t - 0.02) {
            const pc = mod12(bassIn[j].midi);
            if (ev.info.pcs.includes(pc)) ev.bassPc = pc;
          }
        }
      }
      if (!ev.info) { ev.bass = null; ev.fills = []; }
    }
    const evs = events.filter((e) => e.mel >= 0 || e.bass || e.fills.length);

    /* ---- 6. DP ตำแหน่งมือทีละ beat ---- */
    const A = { openS, box, maxF, capo, easy, mel };
    const beats = [];
    for (const ev of evs) {
      const k = beatOf(ev.t);
      const last = beats[beats.length - 1];
      if (last && last.k === k) last.evs.push(ev); else beats.push({ k, evs: [ev] });
    }
    const bndBeats = new Set();
    changes.forEach((t) => bndBeats.add(beatOf(t)));
    mel.forEach((m, i) => {
      if (!i || m.t - (mel[i - 1].t + mel[i - 1].d) >= beat / 2 - 1e-6 || m.phrase !== mel[i - 1].phrase) bndBeats.add(beatOf(m.t));
    });
    const NH = Math.max(1, maxF - box);
    const nB = beats.length;
    const posCost = (h) => (easy ? (h <= 1 ? 0 : h === 2 ? 0.05 : h === 3 ? 0.2 : h === 4 ? 0.6 : 1.1 + 0.8 * (h - 5)) : 0.03 * h + (h > 7 ? 0.12 * (h - 7) : 0));
    const notHeld = easy ? 0.35 : 0.2;
    const cost = new Float64Array(nB * NH);
    const st = newState();
    for (let bi = 0; bi < nB; bi++) {
      const list = beats[bi].evs;
      for (let h = 1; h <= NH; h++) {
        resetState(st);
        let c = posCost(h);
        for (const ev of list) {
          const r = assignEvent(A, ev, h, st);
          c += r.cost;
          if (ev.info && ev.info.shape && !fits(ev.info, h, A)) c += notHeld;
          commit(A, st, ev, r.picks);
        }
        cost[bi * NH + h - 1] = c;
      }
    }
    const back = new Int16Array(nB * NH);
    let dp = new Float64Array(NH), nd = new Float64Array(NH);
    for (let h = 0; h < NH; h++) dp[h] = cost[h];
    for (let bi = 1; bi < nB; bi++) {
      const bnd = beats[bi].k !== beats[bi - 1].k + 1 || bndBeats.has(beats[bi].k);
      for (let h2 = 0; h2 < NH; h2++) {
        let best = Infinity, arg = 0;
        for (let h1 = 0; h1 < NH; h1++) {
          let v = dp[h1];
          if (h1 !== h2) {
            const d = Math.abs(h1 - h2);
            v += (0.3 + 0.2 * d) * (bnd ? 0.35 : 1) * (easy ? 1.5 : 1);
            if (!bnd && d > DP_JUMP) v += BIG;
          }
          if (v < best) { best = v; arg = h1; }
        }
        nd[h2] = best + cost[bi * NH + h2];
        back[bi * NH + h2] = arg;
      }
      const tmp = dp; dp = nd; nd = tmp;
    }
    const hOf = new Int16Array(nB);
    if (nB) {
      let cur = 0;
      for (let h = 1; h < NH; h++) if (dp[h] < dp[cur]) cur = h;
      for (let bi = nB - 1; bi >= 0; bi--) { hOf[bi] = cur + 1; if (bi > 0) cur = back[bi * NH + cur]; }
    }

    /* ---- 7. ใส่โน้ตจริงตามตำแหน่งมือที่เลือก ---- */
    resetState(st);
    let notes = [];
    let dropBass = 0, dropFill = 0;
    beats.forEach((bt, bi) => {
      const h = hOf[bi];
      for (const ev of bt.evs) {
        const r = assignEvent(A, ev, h, st);
        commit(A, st, ev, r.picks);
        if (ev.bass && !r.picks.some((p) => p.role === 'bass')) dropBass++;
        dropFill += ev.fills.length - r.picks.filter((p) => p.role === 'fill').length;
        for (const p of r.picks) {
          const d = p.role === 'melody' ? mel[ev.mel].d : p.role === 'bass' ? ev.bassD : ev.fillD;
          const n = { t: ev.t, d, midi: p.midi, s: p.s, f: p.f, role: p.role };
          if (p.role === 'melody' && mel[ev.mel].oct) n.oct = mel[ev.mel].oct;
          notes.push(n);
        }
      }
    });
    const clicks = fixDurations(notes, changes, eps + 0.005);
    dropBass += clicks.bass; dropFill += clicks.fill;

    /* ---- 8. ตรวจ + ซ่อม (ทิ้งเติม/เบสที่ทำให้ผิดกฎ — ไม่แตะทำนอง) ---- */
    const V = { capo, bpm, phase: P, span: spanMax, changes, mel: mel.map((m) => ({ t: m.t, d: m.d })) };
    let viol = violations(notes, V);
    let repaired = 0;
    for (let iter = 0; iter < 200 && viol.length; iter++) {
      const v = viol.find((x) => x.idx.some((i) => notes[i].role !== 'melody'));
      if (!v) break;
      // ทิ้งโน้ตที่ไม่ใช่ทำนองซึ่งเฟรตห่างจากกลุ่มมากสุด (เติมก่อนเบส, เบสตรงจุดเปลี่ยนคอร์ดทิ้งท้ายสุด)
      const fr = v.idx.map((i) => notes[i].f).filter((f) => f > 0).sort((a, b) => a - b);
      const med = fr.length ? fr[fr.length >> 1] : 0;
      let worst = -1, ws = -Infinity;
      for (const i of v.idx) {
        const n = notes[i];
        if (n.role === 'melody') continue;
        const atChange = n.role === 'bass' && changes.some((t) => Math.abs(t - n.t) < eps + 1e-6);
        const sc = (n.f > 0 ? Math.abs(n.f - med) : 0) + (n.role === 'fill' ? 100 : atChange ? 0 : 50);
        if (sc > ws) { ws = sc; worst = i; }
      }
      if (worst < 0) break;
      if (notes[worst].role === 'bass') dropBass++; else dropFill++;
      notes.splice(worst, 1);
      repaired++;
      viol = violations(notes, V);
    }
    if (repaired) warnings.push('repaired: ทิ้งโน้ตประกอบ ' + repaired + ' ตัวเพื่อให้เล่นได้จริง');
    if (viol.length) warnings.push('unplayable: ' + viol.length + ' จุดยังผิดกฎ (' + Array.from(new Set(viol.map((v) => v.type))).join(', ') + ')');

    notes.sort((a, b) => a.t - b.t || a.s - b.s);
    notes = notes.map((n) => {
      const o = { t: n.t, d: n.d, midi: n.midi, s: n.s, f: n.f, role: n.role };
      if (n.oct) o.oct = n.oct;
      return o;
    });

    const fr = notes.filter((n) => n.f > 0).map((n) => n.f);
    const stats = {
      melody: notes.filter((n) => n.role === 'melody').length,
      bass: notes.filter((n) => n.role === 'bass').length,
      fill: notes.filter((n) => n.role === 'fill').length,
      maxFret: fr.length ? Math.max.apply(null, fr) : 0,
      positions: nB ? [Math.min.apply(null, Array.from(hOf)), Math.max.apply(null, Array.from(hOf))] : [0, 0],
      dropped: { bass: dropBass, fill: dropFill },
      melodyOctave: pm.kG,
      violations: viol.length,
    };
    if (easy && stats.positions[1] > 5) warnings.push('easy-high-position: ทำนองบางช่วงต้องขึ้นตำแหน่ง ' + stats.positions[1] + ' (ช่วงทำนองกว้างเกินตำแหน่งต้นคอ)');
    return {
      notes, capo, key: key || null, shapeKey: shapeKey || null, bpm, phase: P, meter,
      style, difficulty: easy ? 'easy' : 'normal',
      chords: segs.filter((s) => s.chord && s.info).map((s) => ({ t: r3(s.t), chord: s.chord, shape: s.info.shapeSym, frets: s.info.shape })),
      warnings, stats,
    };
  }

  function guessKey(M, rawCh, songEnd) {
    if (!rawCh.length) return null;
    const w = new Map();
    rawCh.forEach((c, i) => {
      const p = M.parseChord(c.chord);
      if (!p) return;
      const k = p.root + (/^m(?!aj)/.test(p.quality) ? 'm' : '');
      const end = i + 1 < rawCh.length ? rawCh[i + 1].t : songEnd;
      w.set(k, (w.get(k) || 0) + Math.max(0, end - c.t) + (i === rawCh.length - 1 ? 0.5 : 0));
    });
    let best = null, bw = -1;
    w.forEach((v, k) => { if (v > bw) { bw = v; best = k; } });
    return best;
  }

  // ตรวจผลของ arrange ตามกฎเล่นได้จริง (ให้ UI/เทสต์ใช้) → { ok, hard:[{type,t,msg}] }
  function check(res, opts) {
    opts = opts || {};
    if (!res || !Array.isArray(res.notes)) return { ok: false, hard: [{ type: 'input', t: 0, msg: 'ไม่มี notes' }] };
    const V = {
      capo: res.capo || 0, bpm: res.bpm || 90, phase: res.phase || 0,
      span: opts.span || (res.difficulty === 'easy' ? 4 : 5),
      changes: (res.chords || []).map((c) => c.t),
      mel: res.notes.filter((n) => n.role === 'melody').map((n) => ({ t: n.t, d: n.d })),
    };
    const hard = violations(res.notes, V).map((v) => ({ type: v.type, t: r3(v.t), msg: v.msg }));
    return { ok: !hard.length, hard };
  }

  /* ================= toAsciiTab: แท็บหลายเสียง ================= */
  const TAB_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];
  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function toAsciiTab(notes, opts) {
    if (notes && !Array.isArray(notes) && Array.isArray(notes.notes)) {
      const r = notes;
      opts = Object.assign({ bpm: r.bpm, phase: r.phase, capo: r.capo, meter: r.meter, chords: r.chords }, opts || {});
      notes = r.notes;
    }
    opts = opts || {};
    const capo = Math.max(0, Math.min(12, Math.round(+opts.capo || 0)));
    const ns = (notes || []).filter((n) => n && isFinite(+n.t) && n.s >= 0 && n.s <= 5 && n.f >= 0)
      .slice().sort((a, b) => a.t - b.t || a.s - b.s);
    const bpm = +opts.bpm > 0 ? +opts.bpm : 0;
    const head = 'Tuning: E A D G B E' + (bpm ? ' · BPM ' + Math.round(bpm) : '') + (capo ? ' · Capo ' + capo : '');
    const out = [head];
    const chords = (Array.isArray(opts.chords) ? opts.chords : [])
      .filter((c) => c && isFinite(+c.t) && (c.shape || c.chord))
      .map((c) => ({ t: +c.t, name: String(capo && c.shape ? c.shape : (c.chord || c.shape)) }))
      .sort((a, b) => a.t - b.t);
    const pri = (r) => (r === 'melody' ? 3 : r === 'bass' ? 2 : 1);
    let dropped = 0;

    // แถวหนึ่ง: cols = [{bar} | {pad:n} | {cells:[6]|null, cnt:'1'|'&'|'', chord:name}]
    const emit = (cols, W, t0) => {
      out.push('');
      if (t0 != null) out.push('[' + fmtTime(t0) + ']');
      const lines = [];
      for (let s = 5; s >= 0; s--) {
        let line = TAB_NAMES[s] + '|';
        for (const c of cols) {
          if (c.bar) line += '|';
          else if (c.pad) line += '-'.repeat(c.pad);
          else line += (c.cells && c.cells[s] != null ? String(c.cells[s]) : '').padEnd(W, '-');
        }
        lines.push(line);
      }
      const L = lines[0].length;
      // บรรทัดคอร์ด (ชื่อท่าจับ) — ยาวเท่าบรรทัดแท็บ ชื่อชนกันเลื่อนขวา ล้นขอบตัดทิ้ง
      const anyChord = cols.some((c) => c.chord);
      if (anyChord) {
        const arr = new Array(L).fill(' ');
        let x = 2, nextFree = 0;
        for (const c of cols) {
          const w = c.bar ? 1 : c.pad ? c.pad : W;
          if (c.chord) {
            let p = Math.max(x, nextFree);
            for (let i = 0; i < c.chord.length && p < L; i++, p++) arr[p] = c.chord[i];
            nextFree = p + 1;
          }
          x += w;
        }
        out.push(arr.join(''));
      }
      lines.forEach((l) => out.push(l));
      if (cols.some((c) => c.cnt)) {
        let cnt = '  ';
        for (const c of cols) {
          if (c.bar) cnt += ' ';
          else if (c.pad) cnt += ' '.repeat(c.pad);
          else cnt += (c.cnt || '').padEnd(W, ' ');
        }
        out.push(cnt);
      }
    };

    if (bpm) {
      const step = 60 / bpm / 4;
      const meter = [2, 3, 4, 5, 6, 7].includes(+opts.meter) ? +opts.meter : 4;
      const SPB = 4 * meter;
      const phase = opts.phase != null && isFinite(+opts.phase) ? +opts.phase : (ns.length ? ns[0].t : 0);
      const perLine = Math.max(1, opts.barsPerLine || (meter > 4 ? 2 : 4));
      const cells = new Map();
      const cell = (k) => { let c = cells.get(k); if (!c) { c = { f: new Array(6).fill(null), p: new Array(6).fill(0) }; cells.set(k, c); } return c; };
      for (const n of ns) {
        const k = Math.round((n.t - phase) / step);
        let c = cell(k);
        if (c.f[n.s] != null) {
          // สายเดียวกันตกช่อง 1/16 เดียวกัน (โน้ตเร็วกว่า 16th) → เลื่อนไปช่องถัดไปถ้าว่าง
          const c2 = cell(k + 1);
          if (c2.f[n.s] == null) c = c2;
          else if (pri(n.role) <= c.p[n.s]) { dropped++; continue; } else dropped++;
        }
        c.f[n.s] = n.f; c.p[n.s] = pri(n.role);
      }
      const chordAt = new Map();
      for (const ch of chords) {
        const k = Math.round((ch.t - phase) / step);
        chordAt.set(k, ch.name);
      }
      const ks = Array.from(cells.keys());
      if (!ks.length) {
        const cols = [{ pad: 1 }];
        for (let k = 0; k < SPB; k++) cols.push({ cells: null, cnt: k % 4 === 0 ? String(k / 4 + 1) : '' });
        cols.push({ bar: true });
        emit(cols, 2, null);
      } else {
        const bar0 = Math.floor(Math.min.apply(null, ks) / SPB), barN = Math.floor(Math.max.apply(null, ks) / SPB);
        for (let b = bar0; b <= barN; b += perLine) {
          const bEnd = Math.min(b + perLine, barN + 1);
          let any = false, maxDig = 1;
          for (let k = b * SPB; k < bEnd * SPB; k++) {
            const c = cells.get(k);
            if (!c) continue;
            any = true;
            c.f.forEach((f) => { if (f != null) maxDig = Math.max(maxDig, String(f).length); });
          }
          if (!any) continue; // แถวว่าง (พักยาว) — แถวถัดไปมี [เวลา] กำกับ
          const W = maxDig + 1;
          const cols = [];
          for (let x = b; x < bEnd; x++) {
            cols.push({ pad: 1 });
            for (let k = x * SPB; k < (x + 1) * SPB; k++) {
              const c = cells.get(k);
              const i = k - x * SPB;
              cols.push({ cells: c ? c.f : null, cnt: i % 4 === 0 ? String(i / 4 + 1) : i % 4 === 2 ? '&' : '', chord: chordAt.get(k) || null });
            }
            cols.push({ bar: true });
          }
          // คอร์ดที่เริ่มก่อนแถวนี้และยังเล่นอยู่ → แสดงต้นแถว
          if (chords.length && !cols[1].chord) {
            const tRow = phase + b * SPB * step;
            let cur = null;
            for (const ch of chords) { if (ch.t <= tRow + 1e-6) cur = ch.name; else break; }
            if (cur) cols[1].chord = '(' + cur + ')';
          }
          emit(cols, W, phase + b * SPB * step);
        }
      }
    } else {
      // ไม่รู้ BPM: คอลัมน์ละ onset (โน้ตพร้อมกันอยู่คอลัมน์เดียว) ช่องว่างตามระยะห่าง
      const groups = [];
      for (const n of ns) {
        const g = groups[groups.length - 1];
        if (g && n.t - g.t < 0.03) {
          if (g.cells[n.s] == null || pri(n.role) > g.p[n.s]) { if (g.cells[n.s] != null) dropped++; g.cells[n.s] = n.f; g.p[n.s] = pri(n.role); } else dropped++;
        } else {
          const cells = new Array(6).fill(null), p = new Array(6).fill(0);
          cells[n.s] = n.f; p[n.s] = pri(n.role);
          groups.push({ t: n.t, cells, p });
        }
      }
      let ci = 0;
      groups.forEach((g) => {
        while (ci < chords.length && chords[ci].t <= g.t + 0.03) { g.chord = chords[ci].name; ci++; }
      });
      const perLine = Math.max(4, opts.notesPerLine || 24);
      if (!groups.length) emit([{ pad: 1 }, { cells: null }, { cells: null }, { cells: null }, { cells: null }, { bar: true }], 2, null);
      for (let i0 = 0; i0 < groups.length; i0 += perLine) {
        const grp = groups.slice(i0, i0 + perLine);
        let maxDig = 1;
        grp.forEach((g) => g.cells.forEach((f) => { if (f != null) maxDig = Math.max(maxDig, String(f).length); }));
        const W = maxDig + 1;
        const cols = [{ pad: 1 }];
        grp.forEach((g, j) => {
          cols.push({ cells: g.cells, chord: g.chord || null });
          const nx = grp[j + 1];
          if (nx) { const gap = nx.t - g.t; const pad = gap < 0.25 ? 0 : gap < 0.6 ? 1 : 2; if (pad) cols.push({ pad }); }
        });
        cols.push({ bar: true });
        emit(cols, W, grp[0].t);
      }
    }
    if (dropped) out.push('', '(' + dropped + ' โน้ตเร็วกว่า 1/16 ไม่ได้แสดงในแท็บ)');
    return out.join('\n') + '\n';
  }

  /* ความยาว "เสียงจริง" ของกีตาร์สำหรับเล่น/ส่งออก MIDI
     ค่า d ใน arrange คือค่าโน้ตตามจังหวะ (มัธยฐาน ~0.2 วิ) — กีตาร์จริงสายที่ดีดแล้วยังกังวานจนกว่าจะดีดสายเดิมซ้ำ
     เล่นตาม d ตรง ๆ ทุกโน้ตถูกตัดก่อนโน้ตถัดไปบนสายเดียวกัน (วัดได้ ดังแค่ ~52% ของช่องว่าง) → ฟังขาด ๆ ไม่ลื่น
     ringOut: ยืดแต่ละโน้ตไปจนถึงโน้ตถัดไปบนสายเดียวกัน (เว้น gap) ไม่เกิน maxRing วินาที (เสียงสายจางไปเองก่อนอยู่แล้ว)
     ไม่สั้นกว่า d เดิม · ไม่แก้ t/s/f/midi · คืนอาร์เรย์ใหม่ (ลำดับเดิม) */
  function ringOut(notes, opts) {
    opts = opts || {};
    const maxRing = opts.maxRing > 0 ? opts.maxRing : 2.4;
    const gap = opts.gap != null ? opts.gap : 0.015;
    const list = (Array.isArray(notes) ? notes : (notes && notes.notes) || []).map((n, i) => ({ n, i }));
    const out = new Array(list.length);
    const byS = new Map();
    list.forEach((x) => { const k = Number.isFinite(+x.n.s) ? +x.n.s : 'm' + x.n.midi; if (!byS.has(k)) byS.set(k, []); byS.get(k).push(x); });
    byS.forEach((arr) => {
      arr.sort((a, b) => a.n.t - b.n.t);
      arr.forEach((x, j) => {
        const t = +x.n.t || 0, d0 = Math.max(0, +x.n.d || 0);
        const nx = arr[j + 1];
        const until = nx ? Math.max(0, (+nx.n.t || 0) - t - gap) : maxRing;
        out[x.i] = Object.assign({}, x.n, { d: r3(Math.max(d0, Math.min(maxRing, until))) });
      });
    });
    return out;
  }

  return {
    STYLES, OPEN, arrange, toAsciiTab, check, ringOut,
    // ช่องสำหรับเทสต์/ดีบัก (ไม่ใช่ API สาธารณะ)
    _test: { handShift, estimateGrid, chordInfo: (sym, capo) => chordInfo(getMusic(), sym, capo || 0, null), shapeCost, slotReq, violations },
  };
});
