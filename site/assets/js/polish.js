/* polish.js — เกลาโน้ตที่ถอดได้ให้สมบูรณ์ตามหลักดนตรี (ใช้ได้ทั้งเบราว์เซอร์ window.Polish · worker · Node)
   โน้ตที่ถอดจากโมเดล (Basic Pitch / Demucs) มักไม่สมบูรณ์:
     เสียงยาวถูกตัดเป็นท่อน · ทำนองหลุดออกเทฟ · เสียงในคอร์ดเข้าช้ากว่าคอร์ด · ปล่อยเสียงเร็ว (ลากเสียงไม่พอ)
     · เสียงหลุดคอร์ดสั้น ๆ ที่เป็นเสียงรบกวน · บางช่วงคอร์ดถอดตกหล่นไปทั้งช่วง
   polish(trackSet, { chords:[{t, chord}], skip:[ชื่อกติกา] }) → TrackSet ใหม่ (ของเดิมไม่ถูกแก้) + _polish = จำนวนที่แก้แต่ละกติกา
   ใช้ bpm/phase ของ TrackSet (กริด 16th) · ไม่แตะกลอง · โน้ตที่เติมขึ้นใหม่มี fill: 1 (UI แสดงต่างจากของที่ถอดได้)
   วัดกับเพลงสังเคราะห์ที่รู้โน้ตจริง 3 เพลง × lite/full (โมเดลจริงในเบราว์เซอร์) — F1 onset±50ms + pitch ตรง:
     ทำนอง lite 72→75 · full 79→88 · คอร์ด lite 39→45 · full 70→74 (ท่อนแตก 0.49→0.25 ต่อโน้ต) · เบสคงเดิม 83/91
   เทสต์: tools/test-polish.cjs */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.Polish = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const r3 = (x) => Math.round(x * 1000) / 1000;
  const byT = (a, b) => a.t - b.t || a.midi - b.midi;
  function cleanNote(n) {
    const o = { t: r3(Math.max(0, n.t)), d: r3(Math.max(0.01, n.d)), midi: Math.round(Math.max(0, Math.min(127, n.midi))), vel: Math.round(Math.max(0, Math.min(1, n.vel || 0)) * 100) / 100 };
    if (n.fill) o.fill = 1;
    return o;
  }

  const MONO_IDS = { bass: 1, melody: 1, vocals: 1 };
  const TUNE_IDS = { melody: 1, vocals: 1 }; // เบสกระโดดออกเทฟเป็นปกติ (root → octave) ไม่แก้ออกเทฟ
  const CHORD_IDS = { harmony: 1, piano: 1, guitar: 1, other: 1 };
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  // ชื่อคอร์ด → pitch class (root, 3rd, 5th, 7th/6th/9th/sus) — พอสำหรับตัดสินว่าโน้ตอยู่ในคอร์ดไหม
  function chordPcs(sym) {
    const m = /^([A-G])([#b]?)(.*)$/.exec(String(sym || '').trim());
    if (!m) return null;
    const root = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12;
    let q = m[3].split('/')[0];
    const bass = m[3].includes('/') ? /\/([A-G])([#b]?)/.exec(m[3]) : null;
    const iv = new Set([0]);
    const minor = /^m(?!aj)/.test(q), dim = /dim|°|b5|ø/.test(q), aug = /aug|\+/.test(q);
    const sus2 = /sus2/.test(q), sus4 = /sus4?(?!2)/.test(q) && /sus/.test(q);
    if (sus2) iv.add(2); else if (sus4) iv.add(5); else iv.add(minor || dim ? 3 : 4);
    iv.add(dim ? 6 : aug ? 8 : 7);
    if (/maj7|M7|Δ/.test(q)) iv.add(11); else if (/7|9|11|13/.test(q)) iv.add(dim && /7/.test(q) && !/m7b5|ø/.test(q) ? 9 : 10);
    if (/6/.test(q)) iv.add(9);
    if (/9|add9|add2/.test(q)) iv.add(2);
    const out = new Set([...iv].map((x) => (root + x) % 12));
    if (bass) out.add((PC[bass[1]] + (bass[2] === '#' ? 1 : bass[2] === 'b' ? 11 : 0)) % 12);
    return out;
  }
  function polish(ts, opts) {
    opts = opts || {};
    const stats = { merged: 0, octave: 0, aligned: 0, extended: 0, dropped: 0, filled: 0 };
    const off = new Set(opts.skip || []); // ปิดบางกติกา (เทสต์วัดผลทีละข้อ)
    if (!ts || !Array.isArray(ts.tracks)) return ts;
    const bpm = +ts.bpm > 0 ? +ts.bpm : (+opts.bpm > 0 ? +opts.bpm : 0);
    const beat = bpm ? 60 / bpm : 0.5, step = beat / 4;
    const ph = Number.isFinite(+ts.phase) ? +ts.phase : (+opts.phase || 0);
    const offGrid = (t) => (bpm ? Math.abs(((t - ph) / step) - Math.round((t - ph) / step)) > 0.25 : false);
    const chords = (opts.chords || []).filter((c) => c && c.chord).map((c) => ({ t: +c.t || 0, pcs: chordPcs(c.chord) })).filter((c) => c.pcs).sort((a, b) => a.t - b.t);
    const chordAt = (t) => { let lo = 0, hi = chords.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (chords[m].t <= t + 1e-6) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? chords[k] : null; };
    const nextChordT = (t) => { for (const c of chords) if (c.t > t + 1e-6) return c.t; return Infinity; };

    const tracks = ts.tracks.map((tr) => {
      if (tr.kind === 'drums' || !Array.isArray(tr.notes)) return tr;
      let notes = tr.notes.map((n) => Object.assign({}, n)).sort(byT);
      const mono = !!MONO_IDS[tr.id], chordy = !!CHORD_IDS[tr.id];
      // แทร็กจาก stem ที่แยกแล้ว (full): ความดังของโน้ตเชื่อได้ · lite ถอดจากมิกซ์ทั้งเพลง ความดังขึ้นลงตามเครื่องอื่น
      const isolated = ts.source === 'full';

      // 2) ออกเทฟหลุด (ทำนอง/เสียงร้อง): เทียบค่ากลางของโน้ตรอบ ๆ ±1.5 วิ (ไม่นับตัวเอง)
      //    วัดแล้ว: ทำนอง F1 +3/+8 · ใช้กับเบสแล้วแย่ลง −6/−12 (เบสกระโดดออกเทฟจริง)
      if (TUNE_IDS[tr.id] && !off.has('octave') && notes.length >= 5) {
        const orig = notes.map((n) => n.midi);
        notes.forEach((n, i) => {
          const ctx = [];
          for (let j = i - 1; j >= 0 && notes[j].t >= n.t - 1.5; j--) ctx.push(orig[j]);
          for (let j = i + 1; j < notes.length && notes[j].t <= n.t + 1.5; j++) ctx.push(orig[j]);
          if (ctx.length < 3) return;
          ctx.sort((a, b) => a - b);
          const med = ctx[ctx.length >> 1], diff = orig[i] - med;
          if (!(Math.abs(diff) >= 10 && Math.abs(diff - 12 * Math.sign(diff)) < Math.abs(diff))) return;
          // ต้องเป็น "ยอดแหลมเดี่ยว": โน้ตก่อน/หลังติดกันอยู่ใกล้กันเอง (≤ 7) แต่ห่างตัวนี้ ≥ 10 ทั้งคู่
          // (เส้นทำนองจากตัวจับ pitch ในมิกซ์ (lite) หลุดออกเทฟเป็นช่วงยาว → ค่ากลางรอบ ๆ อาจผิดเอง ห้ามย้าย)
          const p = orig[i - 1], q = orig[i + 1];
          if (p == null || q == null || Math.abs(p - q) > 7 || Math.abs(orig[i] - p) < 10 || Math.abs(orig[i] - q) < 10) return;
          n.midi = orig[i] - 12 * Math.sign(diff); stats.octave++;
        });
        notes.sort(byT);
      }

      // 1) รวมท่อน: เสียงเดียวกันต่อกันสนิท ตัวหลังไม่ใช่การดีดใหม่
      //    ต้องเริ่มไม่ตรงกริด 16th · หรือ (แทร็กคอร์ดจาก stem ที่แยกแล้ว) เบากว่าตัวหน้า = เสียงเดิมที่ยังกังวาน
      //    วัดแล้ว: ใช้ "เบากว่า" กับคอร์ด lite (ถอดจากมิกซ์) แย่ลง −0.7/−1.2 · full ดีขึ้น +2.2/+4.1
      const byMidi = new Map();
      notes.forEach((n) => { if (!byMidi.has(n.midi)) byMidi.set(n.midi, []); byMidi.get(n.midi).push(n); });
      const kill = new Set();
      if (!off.has('merge')) byMidi.forEach((arr) => {
        for (let i = 0; i + 1 < arr.length; i++) {
          const a = arr[i], b = arr[i + 1];
          if (kill.has(a)) continue;
          const gap = b.t - (a.t + a.d);
          if (gap > 0.03 || gap < -a.d * 0.5) continue;
          if (!(offGrid(b.t) || (!mono && isolated && (b.vel || 0) < (a.vel || 0) - 0.03))) continue;
          a.d = Math.max(a.d, b.t + b.d - a.t); a.vel = Math.max(a.vel || 0, b.vel || 0);
          kill.add(b); arr[i + 1] = a; stats.merged++;
        }
      });
      notes = notes.filter((n) => !kill.has(n));

      // 3) คอร์ดเข้าช้า: เลื่อนโน้ตในคอร์ดไปเริ่มที่จุดโจมตีของคอร์ด (≥ 2 โน้ตเริ่มพร้อมกัน ±20 ms) ภายใน 1 จังหวะ
      if (chordy && !off.has('align') && notes.length >= 3) {
        const attacks = [];
        for (let i = 0; i < notes.length; ) {
          let j = i; while (j + 1 < notes.length && notes[j + 1].t - notes[i].t <= 0.02) j++;
          if (j > i) attacks.push({ t: notes[i].t, midis: new Set(notes.slice(i, j + 1).map((x) => x.midi)), end: Math.max(...notes.slice(i, j + 1).map((x) => x.t + x.d)) });
          i = j + 1;
        }
        let ai = 0;
        notes.forEach((n) => {
          while (ai + 1 < attacks.length && attacks[ai + 1].t <= n.t) ai++;
          const at = attacks[ai];
          if (!at || at.t >= n.t - 0.02 || n.t - at.t > beat || at.midis.has(n.midi)) return;
          const c = chordAt(at.t);
          if (!c || !c.pcs.has(((n.midi % 12) + 12) % 12) || nextChordT(at.t) <= n.t) return;
          // ช่วงก่อนหน้าต้องไม่มีเสียงเดียวกันดังอยู่แล้ว (จะได้ไม่ซ้อนกันเอง)
          if (notes.some((m) => m !== n && m.midi === n.midi && m.t < n.t && m.t + m.d > at.t + 0.02)) return;
          const end = n.t + n.d; n.t = at.t; n.d = end - at.t; at.midis.add(n.midi); stats.aligned++;
        });
        notes.sort(byT);
      }

      // 5) เสียงหลุดคอร์ดสั้น ๆ เบา ๆ ในแทร็กคอร์ด = เสียงรบกวน (โน้ตผ่านจริงมักไม่เบาและสั้นพร้อมกัน)
      if (chordy && !off.has('drop') && chords.length) {
        const vs = notes.map((n) => n.vel || 0).sort((a, b) => a - b), vMed = vs.length ? vs[vs.length >> 1] : 0;
        notes = notes.filter((n) => {
          const c = chordAt(n.t + Math.min(n.d, beat) / 2);
          if (!c || c.pcs.has(((n.midi % 12) + 12) % 12)) return true;
          const keep = n.d >= beat * 0.75 || (n.vel || 0) >= vMed;
          if (!keep) stats.dropped++;
          return keep;
        });
      }

      // 6) เติมเสียงคอร์ดที่หายไป (แทร็กคอร์ด): ช่วงคอร์ดที่แทบไม่มีเสียงในคอร์ด (< 2 เสียงตลอดจังหวะแรก)
      //    แต่ช่วงก่อนและหลังมีเครื่องนี้เล่นอยู่ = ถอดตกหล่น (ช่วงที่เงียบติดกันหลายช่วง = พักจริง ไม่เติม)
      //    เติมด้วยท่าที่แทร็กนี้เคยเล่นคอร์ดเดียวกัน (เพลงมักใช้ท่าเดิมซ้ำ) · โน้ตที่เติมมี fill: 1 ให้ UI แสดงต่างจากของจริง
      if (chordy && !off.has('fill') && chords.length >= 3 && notes.length >= 8) {
        const segs = chords.map((c, i) => ({ t: c.t, end: Math.min(i + 1 < chords.length ? chords[i + 1].t : c.t + beat * 8, c.t + beat * 8), c, sym: (opts.chords || []).find((x) => Math.abs((+x.t || 0) - c.t) < 1e-6) }));
        const toneCount = (sg) => { const pcs = new Set(); notes.forEach((n) => { if (n.t < sg.t + beat && n.t + n.d > sg.t + 0.02 && sg.c.pcs.has(((n.midi % 12) + 12) % 12)) pcs.add(n.midi); }); return pcs; };
        const have = segs.map(toneCount);
        const memory = new Map(); // ชื่อคอร์ด → ท่าที่เล่นล่าสุด
        // ช่วงเสียงหลักของแทร็ก (ควอร์ไทล์ 25–75% ± 3) — ท่าที่จำมาจากโน้ตที่ถอดอาจมีเสียงเบส/เสียงสูงหลงมา
        const ps = notes.map((n) => n.midi).sort((x, y) => x - y);
        const lo = ps[Math.floor(ps.length * 0.25)] - 3, hi = ps[Math.floor(ps.length * 0.75)] + 3, mid = ps[ps.length >> 1];
        const inReg = (m) => m >= lo && m <= hi;
        // ท่าปิดรอบค่ากลาง: เสียงในคอร์ด 3 ตัวที่ใกล้ค่ากลางของแทร็กที่สุด
        const closeVoicing = (pcs) => { const c = []; for (let x = lo; x <= hi; x++) if (pcs.has(x % 12)) c.push(x); return c.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid)).slice(0, 3); };
        const added = [];
        segs.forEach((sg, i) => {
          const key = sg.sym ? sg.sym.chord : '';
          if (have[i].size >= 2) { memory.set(key, [...have[i]]); return; }
          if (sg.end - sg.t < beat * 0.9 || i === 0 || i === segs.length - 1) return;
          if (have[i - 1].size < 2 || have[i + 1].size < 2) return;
          // ท่าที่แทร็กนี้เคยเล่นคอร์ดเดียวกัน (เฉพาะเสียงในช่วงหลัก) · ไม่พอ 2 เสียง → ท่าปิดรอบค่ากลาง
          let voicing = (memory.get(key) || []).filter(inReg);
          if (voicing.length < 2) voicing = closeVoicing(sg.c.pcs);
          const want = [...new Set(voicing)].filter((m) => inReg(m) && sg.c.pcs.has(((m % 12) + 12) % 12) && !have[i].has(m));
          want.forEach((m) => added.push({ t: sg.t, d: Math.max(0.1, sg.end - sg.t - 0.02), midi: m, vel: 0.55, fill: 1 }));
          if (want.length) memory.set(key, [...new Set([...have[i], ...want])]);
        });
        if (added.length) { notes = notes.concat(added).sort(byT); stats.filled = (stats.filled || 0) + added.length; }
      }

      // 4) ลากเสียงให้พอ (เส้นเดียว): ดังไม่ถึงครึ่งช่องถึงโน้ตถัดไปที่ห่างไม่เกิน 1 จังหวะ → ยืดชิดโน้ตถัดไป
      if (mono && !off.has('extend')) {
        for (let i = 0; i + 1 < notes.length; i++) {
          const a = notes[i], b = notes[i + 1];
          const room = b.t - a.t;
          if (room <= 0 || room > beat + 1e-6 || a.d >= room * 0.5) continue;
          a.d = Math.max(a.d, room - 0.02); stats.extended++;
        }
      }
      return Object.assign({}, tr, { notes: notes.map(cleanNote).sort(byT) });
    });
    return Object.assign({}, ts, { tracks, _polish: stats });
  }

  return { polish, chordPcs };
});
