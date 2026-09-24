/* notation.js — โน้ตสากล (ABC) จาก SongDoc.melody + lead sheet จาก ChordPro + วาด/เล่น/ส่งออกด้วย abcjs
   หน่วยเวลา: 1 beat = ตัวดำ (1/4) เสมอ ไม่ว่าจังหวะอะไร · ABC ใช้ L:1/16 → 1 beat = 4 หน่วย
   ระดับเสียง ABC: 'C' = C4 (middle C, MIDI 60) · 'c' = C5 (72) · ',' ลด / "'" เพิ่มทีละ octave
   ส่วนแปลง (melodyToAbc, leadSheetFromChordPro, abcTuneToMelody) เป็นฟังก์ชันบริสุทธิ์ — เทสต์ใน Node ได้
   (tools/test-notation.cjs) ส่วน render/เล่นเสียงโหลด abcjs จาก CDN ครั้งแรกแล้ว SW แคชไว้ใช้ออฟไลน์ */
(function () {
  'use strict';

  const ABCJS_URL = 'https://cdn.jsdelivr.net/npm/abcjs@6.7.1/dist/abcjs-basic-min.js';
  // sha384 ของไฟล์ข้างบน (ตรวจแล้วว่าตรงกับไฟล์ใน npm tarball abcjs@6.7.1)
  const ABCJS_SRI = 'sha384-gO9mym1Z3WJwxNm4ZpC6ZQbMyiu+72akLTHzztpwTs6KYVd3NnfkQigzPk+Oqzqy';
  const SOUNDFONT_URL = 'https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/'; // ค่าเริ่มต้นของ abcjs

  const U = 4;                       // หน่วย L:1/16 ต่อ 1 beat
  const MAX_NOTES = 5000;            // เพดานกันหน้าเว็บค้าง (ข้อมูลใน localStorage ถูกแก้มือได้)
  const MAX_UNITS = 16 * 2000;       // ไม่เกิน ~2000 ห้อง 4/4
  const MAX_BARS_LEAD = 1000;
  const LETTERS = 'CDEFGAB';
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
  const SOL_TH = ['ด', 'ร', 'ม', 'ฟ', 'ซ', 'ล', 'ท'];
  const MARK_LOW = '\u0E3A';         // พินทุ ใต้ตัว = ต่ำลง 1 ช่วงเสียง
  const MARK_HIGH = '\u0E4D';        // นิคหิต บนตัว = สูงขึ้น 1 ช่วงเสียง
  const MAJOR_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
  const MAJOR_BY_PC = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_BY_PC = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const SHARP_ORDER = 'FCGDAEB', FLAT_ORDER = 'BEADGCF';
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const DUR_OK = [32, 24, 16, 12, 8, 6, 4, 3, 2, 1]; // ความยาว (หน่วย 1/16) ที่เขียนเป็นหัวโน้ตเดียวได้
  const ACC_ABC = { '-2': '__', '-1': '_', '0': '=', '1': '^', '2': '^^' };
  const ACC_SIGN = { '-2': '♭♭', '-1': '♭', '0': '', '1': '♯', '2': '♯♯' };
  const CHORD_RE = /^([A-G][#b]?)([A-Za-z0-9+#()°ø-]{0,12}?)(?:\/([A-G][#b]?))?$/;
  const TS_DEN = [1, 2, 4, 8, 16];
  const AMB = 'amb';                 // สถานะ accidental ในห้องที่ "กำกวม" → ตัวถัดไปต้องเขียนเครื่องหมายเสมอ

  const mod = (n, m) => ((n % m) + m) % m;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const normAcc = (x) => mod(x + 6, 12) - 6;
  const tr = (k) => (window.I18N ? I18N.t(k) : k);

  /* ---------------- คีย์ / การสะกดโน้ต ---------------- */
  function parseKeyName(k) {
    const m = String(k == null ? '' : k).trim().match(/^([A-Ga-g])([#b]?)(m?)$/);
    if (!m) return null;
    return { letter: m[1].toUpperCase(), acc: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, minor: m[3] === 'm' };
  }

  // ข้อมูลคีย์: เครื่องหมายประจำคีย์ (sig) + ชื่อสำหรับ ABC K: + ตำแหน่ง ด แบบ movable
  // ไมเนอร์ใช้ ด = คีย์เมเจอร์สัมพันธ์ (la-based minor แบบที่สอนกันในไทย เช่น Am → ด = C)
  function keyInfo(name, depth) {
    const k = parseKeyName(name) || { letter: 'C', acc: 0, minor: false };
    const li = LETTERS.indexOf(k.letter);
    const pc = mod(LETTER_PC[li] + k.acc, 12);
    const mli = k.minor ? (li + 2) % 7 : li;
    const mpc = k.minor ? mod(pc + 3, 12) : pc;
    const macc = normAcc(mpc - LETTER_PC[mli]);
    const majName = LETTERS[mli] + (macc === 1 ? '#' : macc === -1 ? 'b' : macc === 0 ? '' : '?');
    const fifths = MAJOR_FIFTHS[majName];
    if (fifths === undefined) {
      // คีย์ที่ไม่มีใครเขียน (D#, Fbm ...) → สะกดใหม่แบบ enharmonic ที่ใช้จริง
      if (depth) return keyInfo('C', 1);
      return keyInfo(k.minor ? MINOR_BY_PC[pc] + 'm' : MAJOR_BY_PC[pc], 1);
    }
    const sig = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
    if (fifths > 0) for (let i = 0; i < fifths; i++) sig[SHARP_ORDER[i]] = 1;
    else for (let i = 0; i < -fifths; i++) sig[FLAT_ORDER[i]] = -1;
    const nm = k.letter + (k.acc === 1 ? '#' : k.acc === -1 ? 'b' : '') + (k.minor ? 'm' : '');
    return { name: nm, tonicPc: pc, tonicLetter: li, minor: k.minor, fifths, sig, doLetter: mli, doPc: mpc, doAcc: macc };
  }

  function transposeKeyName(name, steps) {
    const ki = keyInfo(name);
    const n = Math.round(steps || 0);
    if (!n || mod(n, 12) === 0) return ki.name;
    const pc = mod(ki.tonicPc + n, 12);
    return ki.minor ? MINOR_BY_PC[pc] + 'm' : MAJOR_BY_PC[pc];
  }

  // MIDI → ตัวสะกด {li: index ใน CDEFGAB, acc: -2..2, oct: octave แบบ scientific (C4 = 60)}
  function spell(midi, ki) {
    const pc = mod(midi, 12);
    let li = -1, acc = 0;
    for (let i = 0; i < 7; i++) {
      const a = ki.sig[LETTERS[i]];
      if (mod(LETTER_PC[i] + a, 12) === pc) { li = i; acc = a; break; }
    }
    if (li < 0 && ki.minor && pc === mod(ki.tonicPc - 1, 12)) { // leading tone ของไมเนอร์ (G# ใน Am)
      li = (ki.tonicLetter + 6) % 7; acc = normAcc(pc - LETTER_PC[li]);
    }
    if (li < 0) { const i = LETTER_PC.indexOf(pc); if (i >= 0) { li = i; acc = 0; } }
    if (li < 0) {
      if (ki.fifths < 0 || (ki.fifths === 0 && (pc === 3 || pc === 10))) { li = LETTER_PC.indexOf(mod(pc + 1, 12)); acc = -1; }
      else { li = LETTER_PC.indexOf(mod(pc - 1, 12)); acc = 1; }
    }
    return { li, acc, oct: Math.floor((midi - acc) / 12) - 1 };
  }

  function abcLetter(sp) {
    const L = LETTERS[sp.li];
    return sp.oct >= 5 ? L.toLowerCase() + "'".repeat(sp.oct - 5) : L + ','.repeat(Math.max(0, 4 - sp.oct));
  }

  // ชื่อโน้ตสากลอ่านง่าย เช่น "F#4", "Bb3"
  function noteName(midi, keySig) {
    const sp = spell(midi, keyInfo(keySig || 'C'));
    return LETTERS[sp.li] + (sp.acc > 0 ? '#'.repeat(sp.acc) : 'b'.repeat(-sp.acc)) + sp.oct;
  }

  /* ---------------- โน้ตไทย (ด ร ม ฟ ซ ล ท) ---------------- */
  // fixed: ด = C · movable: ด = โทนิก (ไมเนอร์ → ด ของเมเจอร์สัมพันธ์ แบบ la-based)
  // ช่วงเสียงกลาง (ไม่มีจุด) = ด..ท ช่วงเดียว — เลือกตามทำนองให้มีจุดบน/ล่างน้อยที่สุด
  // (เสมอกัน → ช่วงที่ ด ใกล้ middle C ที่สุด) · ไม่มีโน้ตให้ดู → fixed ใช้ C4, movable ใช้ ด ใน G3..F#4
  function solfegeInfo(mode, ki, pitches) {
    const movable = mode === 'movable';
    const doPc = movable ? ki.doPc : 0;
    let midi = movable ? (doPc <= 6 ? 60 + doPc : 48 + doPc) : 60;
    if (pitches && pitches.length) {
      let best = null;
      for (let k = 2; k <= 6; k++) {
        const base = k * 12 + doPc;
        let out = 0;
        for (let i = 0; i < pitches.length; i++) if (pitches[i] < base || pitches[i] > base + 11) out++;
        const score = out * 100 + Math.abs(base - 60);
        if (best == null || score < best.score) best = { base, score };
      }
      midi = best.base;
    }
    const acc = movable ? ki.doAcc : 0;
    return { li: movable ? ki.doLetter : 0, midi, oct: Math.floor((midi - acc) / 12) - 1 };
  }
  function solfegeFor(midi, sp, doInfo) {
    const delta = (sp.oct * 7 + sp.li) - (doInfo.oct * 7 + doInfo.li);
    const deg = mod(delta, 7);
    const shift = Math.floor(delta / 7);
    const acc = clamp(midi - (doInfo.midi + shift * 12 + MAJOR_STEPS[deg]), -2, 2);
    const mark = shift < 0 ? MARK_LOW.repeat(Math.min(2, -shift)) : MARK_HIGH.repeat(Math.min(2, shift));
    return SOL_TH[deg] + mark + ACC_SIGN[acc];
  }
  function solfegeName(midi, keySig, mode) {
    const ki = keyInfo(keySig || 'C');
    return solfegeFor(midi, spell(midi, ki), solfegeInfo(mode, ki));
  }

  /* ---------------- คอร์ด ---------------- */
  function cleanChord(sym) {
    if (sym == null) return null;
    const s = String(sym).trim();
    if (!s || s.length > 20) return null;
    const m = s.match(CHORD_RE);
    return m ? s : null;
  }
  const PC_OF = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function rootPc(r) { return mod(PC_OF[r[0]] + (r[1] === '#' ? 1 : r[1] === 'b' ? -1 : 0), 12); }
  function transposeChordName(sym, steps, ki) {
    const s = cleanChord(sym);
    if (!s) return null;
    const n = Math.round(steps || 0);
    if (!n || mod(n, 12) === 0) return s;
    const m = s.match(CHORD_RE);
    const names = ki && ki.fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
    let out = names[mod(rootPc(m[1]) + n, 12)] + (m[2] || '');
    if (m[3]) out += '/' + names[mod(rootPc(m[3]) + n, 12)];
    return out;
  }

  /* ---------------- ทำความสะอาดข้อความที่จะใส่ใน ABC ---------------- */
  // ห้ามมี newline (กันแทรก header/field ใหม่), '%' (comment), และอักขระพิเศษของบรรทัด w:
  const CTRL_RE = new RegExp('[\x00-\x1f\x7f-\x9f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
  function cleanText(s, max) {
    return String(s == null ? '' : s).replace(CTRL_RE, ' ').replace(/[%\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max || 120);
  }
  // พยางค์ใต้โน้ต 1 ช่อง: เว้นวรรคในพยางค์ → '~' (แสดงเป็นช่องว่าง ไม่แยกพยางค์)
  // '-' ใน ABC คือขีดคั่นพยางค์ (abcjs วาดขีด) → ใช้ U+2010 ที่หน้าตาเหมือนกันแทน
  function sylToken(s) {
    let x = String(s == null ? '' : s).normalize('NFC').replace(CTRL_RE, ' ');
    x = x.replace(/[%\\|*_~"]/g, '').replace(/-/g, '\u2010').trim().replace(/\s+/g, '~');
    x = Array.from(x).slice(0, 24).join('');
    return x || '*';
  }
  function visLen(s) { return String(s || '').replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, '').length; }

  /* ---------------- เตรียม melody (ตรวจ + quantize) ---------------- */
  function normTimeSig(ts) {
    if (Array.isArray(ts) && ts.length === 2) {
      const n = Math.round(Number(ts[0])), d = Math.round(Number(ts[1]));
      if (n >= 1 && n <= 16 && TS_DEN.indexOf(d) >= 0) return [n, d];
    }
    return [4, 4];
  }
  function barUnits(ts) { return Math.max(1, Math.round(ts[0] * 16 / ts[1])); }
  function groupUnits(ts) { return (ts[1] === 8 && ts[0] % 3 === 0 && ts[0] > 3) ? 6 : 4; }

  function prepNotes(melody, transpose, warnings) {
    const src = (melody && Array.isArray(melody.notes)) ? melody.notes : [];
    const out = [];
    const n = Math.min(src.length, MAX_NOTES);
    if (src.length > MAX_NOTES) warnings.push('too-many-notes');
    for (let i = 0; i < n; i++) {
      const x = src[i];
      if (!x || typeof x !== 'object' || !isNum(x.t) || !isNum(x.d)) continue;
      const s = Math.round(x.t * U), len = Math.round(x.d * U);
      if (len < 1 || Math.abs(s) > MAX_UNITS) continue;
      let p = null;
      if (x.p != null) {
        if (!isNum(x.p)) continue;
        p = clamp(Math.round(x.p) + Math.round(transpose || 0), 12, 119);
      }
      out.push({ i, s, e: s + Math.min(len, MAX_UNITS), p, syl: x.syl, chord: x.chord, tie: x.tie === true });
    }
    out.sort((a, b) => a.s - b.s || a.i - b.i);
    const res = [];
    for (const nt of out) {
      const last = res[res.length - 1];
      if (last && nt.s < last.e) {
        if (nt.s <= last.s) { warnings.push('overlap'); continue; }
        last.e = nt.s; warnings.push('overlap');
      }
      res.push(nt);
    }
    return res;
  }

  /* ---------------- แบ่งความยาวเป็นหัวโน้ตที่เขียนได้ ---------------- */
  function splitNote(start, len, grp) {
    const out = [];
    let u = start, rem = len;
    while (rem > 0) {
      let piece = DUR_OK.find((d) => d <= rem);
      if (DUR_OK.indexOf(rem) < 0 && mod(u, grp) !== 0) {
        const toBeat = grp - mod(u, grp);
        if (toBeat < rem) piece = DUR_OK.find((d) => d <= toBeat);
      }
      out.push(piece); u += piece; rem -= piece;
    }
    return out;
  }
  // ตัวหยุด: ชิ้นต้องเริ่มตรงตำแหน่งที่หารความยาวตัวเองลงตัวในห้อง (เช่นตัวหยุดตัวขาวอยู่จังหวะ 1 หรือ 3 เท่านั้น)
  // จังหวะธรรมดาไม่ใช้ตัวหยุดประจุด · จังหวะผสม (6/8, 9/8, 12/8) ใช้ประจุดตามกลุ่ม · เต็มห้อง = ชิ้นเดียว
  function splitRest(start, len, grp, barU) {
    const sizes = grp === 6 ? [12, 6, 2, 1] : [16, 8, 4, 2, 1];
    const out = [];
    let u = start, rem = len;
    while (rem > 0) {
      const pos = mod(u, barU || 16);
      let piece;
      if (pos === 0 && barU && rem >= barU && DUR_OK.indexOf(barU) >= 0) piece = barU;
      else piece = sizes.find((c) => c <= rem && pos % c === 0) || 1;
      out.push(piece); u += piece; rem -= piece;
    }
    return out;
  }
  const durSuffix = (n) => (n === 1 ? '' : String(n));

  /* ---------------- ประกอบ ABC จาก "บาร์" ---------------- */
  // bars: [{tokens: [{u, len, p (MIDI|null), inv (ตัวหยุดล่องหน), i, first, tieNext, chord, label, syl, sol}]}]
  function emitAbc(head, bars, o) {
    const lineWidth = o.lineWidth || 740;
    const maxBars = clamp(o.maxBarsPerLine || 4, 1, 16);
    const firstExtra = 70 + Math.abs(o.ki.fifths) * 9;
    const hasLyr = bars.some((b) => b.tokens.some((t) => t.syl && t.syl !== '*' && t.syl !== '_'));
    const hasSol = !!o.solMode;
    // จัดบรรทัดตามความกว้างโดยประมาณ (โน้ตถี่/พยางค์ยาว → ห้องต่อบรรทัดน้อยลง — จอมือถือไม่เบียด)
    const lines = [];
    let cur = [], w = 0;
    bars.forEach((b) => {
      let bw = 16;
      b.tokens.forEach((t) => {
        let tw = t.inv ? 18 : 24;
        if (t.p != null && t.acc) tw += 8;
        if (hasLyr && t.syl) tw = Math.max(tw, visLen(t.syl) * 8.5 + 8);
        if (hasSol && t.sol) tw = Math.max(tw, visLen(t.sol) * 8.5 + 8);
        if (t.chord) tw = Math.max(tw, t.chord.length * 8 + 6);
        bw += tw;
      });
      const extra = (lines.length === 0 && cur.length === 0) ? firstExtra : 50;
      if (cur.length && (cur.length >= maxBars || w + bw > lineWidth)) { lines.push(cur); cur = []; w = 0; }
      if (!cur.length) w = (lines.length === 0) ? firstExtra : extra;
      cur.push(b); w += bw;
    });
    if (cur.length) lines.push(cur);

    let abc = head;
    const items = [], byStart = {}, noteItems = {};
    lines.forEach((ln, li) => {
      const lyr = [], sol = [];
      ln.forEach((b, bi) => {
        b.tokens.forEach((t, ti) => {
          if (ti > 0 && mod(t.u, o.grp) === 0) abc += ' ';
          let pre = '';
          if (t.label) pre += '"^' + t.label + '"';
          if (t.chord) pre += '"' + t.chord + '"';
          const start = abc.length;
          const body = t.p == null ? (t.inv ? 'x' : 'z') : t.accText + t.letter;
          abc += pre + body + durSuffix(t.len) + (t.tieNext ? '-' : '');
          const idx = items.length;
          items.push({ i: t.i, start, end: abc.length, rest: t.p == null, u: t.u, len: t.len, p: t.p, bar: b.index, line: li, first: !!t.first });
          byStart[start] = idx;
          if (t.i >= 0) (noteItems[t.i] || (noteItems[t.i] = [])).push(idx);
          if (t.p != null) { lyr.push(t.syl || '*'); sol.push(t.sol || '*'); }
        });
        const lastBar = li === lines.length - 1 && bi === ln.length - 1;
        abc += lastBar ? ' |]' : ' |';
        if (!lastBar && bi < ln.length - 1) abc += ' ';
      });
      abc += '\n';
      if (hasLyr && lyr.length) abc += 'w: ' + lyr.join(' ') + '\n';
      if (hasSol && sol.length) abc += 'w: ' + sol.join(' ') + '\n';
    });
    return { abc, noteMap: { items, byStart, noteItems }, lines: lines.length };
  }

  function header(o) {
    let h = 'X:1\n';
    const title = cleanText(o.title, 120);
    if (title) h += 'T:' + title + '\n';
    h += 'M:' + o.ts[0] + '/' + o.ts[1] + '\n';
    h += 'L:1/16\n';
    h += 'Q:1/4=' + o.tempo + '\n';
    h += '%%vocalfont "IBM Plex Sans Thai" 15\n';
    h += '%%gchordfont "IBM Plex Sans Thai" 14 bold\n';
    h += '%%annotationfont "IBM Plex Sans Thai" 13\n';
    h += 'K:' + o.ki.name + '\n';
    return h;
  }

  function tempoOf(x, dflt) {
    const n = typeof x === 'string' ? parseFloat(x) : x;
    return isNum(n) && n >= 20 && n <= 400 ? Math.round(n) : dflt;
  }

  /* ---------------- melody → ABC ----------------
     opts: {title, chords:[{t (beat), chord}] (ไม่ใส่ = ใช้ note.chord), transpose (ครึ่งเสียง),
            thaiSolfege, solfegeMode 'fixed'|'movable', keySig (สำรองถ้า melody ไม่มี), tempo,
            lineWidth, maxBarsPerLine, showTab (ใช้ตอน render เท่านั้น — แท็บเป็นพารามิเตอร์ของ abcjs)}
     คืน {abc, noteMap, key, timeSig, tempo, tokens, startU, endU, barU, warnings} */
  function melodyToAbc(melody, opts) {
    opts = opts || {};
    melody = melody && typeof melody === 'object' ? melody : {};
    const warnings = [];
    const transpose = isNum(opts.transpose) ? Math.round(opts.transpose) : 0;
    const ts = normTimeSig(melody.timeSig);
    const barU = barUnits(ts), grp = groupUnits(ts);
    const baseKey = parseKeyName(melody.keySig) ? melody.keySig : (parseKeyName(opts.keySig) ? opts.keySig : 'C');
    const ki = keyInfo(transposeKeyName(baseKey, transpose));
    const tempo = tempoOf(melody.tempo, tempoOf(opts.tempo, 90));
    const solMode = opts.thaiSolfege ? (opts.solfegeMode === 'movable' ? 'movable' : 'fixed') : null;
    const notes = prepNotes(melody, transpose, warnings);
    const doInfo = solfegeInfo(solMode, ki, notes.filter((n) => n.p != null).map((n) => n.p));

    // pickup (ตัวเกริ่นก่อนห้องแรก): t < 0 — ถ้าโน้ตเริ่มก่อน pickup ที่ประกาศไว้ ขยายให้ครอบ
    let pickupU = isNum(melody.pickup) ? clamp(Math.round(melody.pickup * U), 0, barU * 4) : 0;
    if (notes.length && notes[0].s < -pickupU) pickupU = Math.min(-notes[0].s, MAX_UNITS);
    const startU = -pickupU;

    // คอร์ด: จาก opts.chords หรือ note.chord
    const chordAt = new Map();
    if (Array.isArray(opts.chords)) {
      opts.chords.slice(0, MAX_NOTES).forEach((c) => {
        if (!c || !isNum(c.t)) return;
        const name = transposeChordName(c.chord, transpose, ki);
        if (!name) return;
        const u = clamp(Math.round(c.t * U), startU, startU + MAX_UNITS);
        chordAt.set(u, name);
      });
    } else {
      notes.forEach((nt) => { const name = transposeChordName(nt.chord, transpose, ki); if (name) chordAt.set(nt.s, name); });
    }

    let endU = notes.length ? notes[notes.length - 1].e : 0;
    chordAt.forEach((_, u) => { if (u + 1 > endU) endU = u + 1; });
    endU = Math.max(endU, startU + 1, 1);
    endU = Math.min(Math.ceil(endU / barU) * barU, startU + MAX_UNITS + barU);
    if (endU <= 0) endU = barU;

    // จุดตัด: เส้นกั้นห้อง + ต้น/ท้ายโน้ต + ตำแหน่งคอร์ด
    const bars = [];
    let ni = 0;
    let barStart = Math.floor(startU / barU) * barU;
    let bIndex = 0;
    const tokens = [];
    // โน้ตที่ถูกโยงต่อจากตัวก่อน (note.tie + เสียงเดียวกัน + ติดกันพอดี) — ต้องรู้ก่อนสร้างหัวโน้ต
    // เพราะ abcjs นับหัวโน้ตที่ถูกโยงต่อเป็นชิ้นต่อ (ไม่นับ accidental ของมัน) เหมือนชิ้นที่แยกข้ามห้อง
    const tiedIn = new Set();
    for (let q = 0; q + 1 < notes.length; q++) {
      const nt = notes[q], nx = notes[q + 1];
      if (nt.tie && nt.p != null && nx.p === nt.p && nx.s === nt.e) tiedIn.add(nx);
    }
    while (barStart < endU) {
      const bs = Math.max(barStart, startU), be = barStart + barU;
      const spans = []; // [a, b, noteObj|null]
      let u = bs;
      while (ni < notes.length && notes[ni].e <= bs) ni++;
      let k = ni;
      while (u < be) {
        const nt = k < notes.length ? notes[k] : null;
        if (nt && nt.s <= u && nt.e > u) {
          const b = Math.min(nt.e, be);
          spans.push([u, b, nt]); u = b;
          if (nt.e <= be) k++;
        } else {
          const b = nt ? Math.min(nt.s, be) : be;
          spans.push([u, b, null]); u = b;
        }
      }
      // ตัดตามตำแหน่งคอร์ดในห้อง (ต้องมีโน้ต/ตัวหยุดให้คอร์ดเกาะ)
      const cuts = [];
      chordAt.forEach((_, cu) => { if (cu > bs && cu < be) cuts.push(cu); });
      cuts.sort((a, b) => a - b);
      let pieces = spans;
      if (cuts.length) {
        pieces = [];
        spans.forEach(([a, b, nt]) => {
          let x = a;
          cuts.forEach((c) => { if (c > x && c < b) { pieces.push([x, c, nt]); x = c; } });
          pieces.push([x, b, nt]);
        });
      }
      // ตัวหยุดติดกันรวมเป็นก้อนเดียว (ถ้าไม่มีคอร์ดคั่น)
      const merged = [];
      pieces.forEach((pc) => {
        const last = merged[merged.length - 1];
        if (last && !last[2] && !pc[2] && !chordAt.has(pc[0])) last[1] = pc[1];
        else merged.push(pc.slice());
      });
      const barTokens = [];
      const barAcc = {};
      merged.forEach(([a, b, nt]) => {
        const lens = nt ? splitNote(a, b - a, grp) : splitRest(a, b - a, grp, barU);
        let x = a;
        lens.forEach((len, j) => {
          const tk = { u: x, len, p: nt ? nt.p : null, i: nt ? nt.i : -1, first: !!nt && x === nt.s, tieNext: false, chord: chordAt.get(x) || null };
          if (nt && nt.p != null) {
            const sp = spell(nt.p, ki);
            const key = sp.li + ':' + sp.oct;
            const eff = key in barAcc ? barAcc[key] : ki.sig[LETTERS[sp.li]];
            tk.acc = eff === AMB || sp.acc !== eff;
            tk.accText = tk.acc ? ACC_ABC[sp.acc] : '';
            // ชิ้นที่โยงต่อมา (ไม่ใช่หัวโน้ตแรก) + เขียน accidental: ตามมาตรฐาน ABC มีผลถึงท้ายห้อง
            // แต่ตัวเล่นเสียงของ abcjs ข้ามชิ้นที่โยงต่อ (ไม่นับ accidental ของมัน) → ตีความได้สองแบบ
            // → บังคับให้โน้ตตัวอักษร/ช่วงเสียงเดียวกันตัวถัดไปในห้องเขียน accidental ชัด ๆ เสมอ
            barAcc[key] = ((x !== nt.s || tiedIn.has(nt)) && tk.acc) ? AMB : sp.acc;
            tk.letter = abcLetter(sp);
            tk.sol = solMode ? (tk.first ? solfegeFor(nt.p, sp, doInfo) : '_') : null;
            if (x + len < nt.e) tk.tieNext = true; // ชิ้นกลางของโน้ตเดียวกัน (ข้ามห้อง/ถูกคอร์ดตัด)
            tk.syl = tk.first ? sylFor(nt) : '_';
          }
          barTokens.push(tk); tokens.push(tk);
          x += len;
          void j;
        });
      });
      bars.push({ index: bIndex++, start: bs, tokens: barTokens });
      barStart += barU;
    }

    // tie ระหว่างโน้ต (note.tie) → ผูกหัวโน้ตสุดท้ายของตัวก่อนกับหัวแรกของตัวที่ถูกโยงต่อ
    const firstTok = new Map();
    tokens.forEach((tk, idx) => { if (tk.first && tk.i >= 0) firstTok.set(tk.i, idx); });
    for (const nx of tiedIn) {
      const nextIdx = firstTok.get(nx.i);
      if (nextIdx == null || nextIdx === 0) continue;
      tokens[nextIdx - 1].tieNext = true;
      const nxTok = tokens[nextIdx];
      if (nxTok.syl === '*') nxTok.syl = '_';           // เสียงที่ผูกต่อ = ลากพยางค์เดิม
      if (solMode) nxTok.sol = '_';
    }

    const o = { ts, ki, grp, tempo, title: opts.title, lineWidth: opts.lineWidth, maxBarsPerLine: opts.maxBarsPerLine, solMode };
    const em = emitAbc(header(o), bars, o);
    return {
      abc: em.abc, noteMap: em.noteMap, key: ki.name, timeSig: ts, tempo, tokens,
      startU, endU, barU, lines: em.lines, warnings: Array.from(new Set(warnings)),
    };
  }

  function sylFor(nt) {
    const s = nt.syl;
    if (s == null) return '*';
    const x = String(s).trim();
    if (x === '_' || x === '-') return '_';
    return sylToken(x);
  }

  /* ---------------- ChordPro → lead sheet (เพลงที่ยังไม่มีทำนอง) ----------------
     แต่ละคอร์ดในบรรทัดที่ไม่มี '|' = 1 ห้อง · บรรทัดกริด "[C] [G] | [Am]" แบ่งห้องตาม '|'
     (หลายคอร์ดในห้องเดียวแบ่งจังหวะเท่า ๆ กัน) · "(×n)" ท้ายบรรทัด = เล่นซ้ำ n รอบ
     ห้องเป็นตัวหยุดล่องหน (x) + ชื่อคอร์ดด้านบน → เล่นเสียงได้เฉพาะคอร์ดประกอบ */
  function leadSheetFromChordPro(chordpro, timeSig, opts) {
    opts = opts || {};
    const ts = normTimeSig(timeSig);
    const barU = barUnits(ts), grp = groupUnits(ts);
    const transpose = isNum(opts.transpose) ? Math.round(opts.transpose) : 0;
    const baseKey = parseKeyName(opts.keySig) ? opts.keySig : 'C';
    const ki = keyInfo(transposeKeyName(baseKey, transpose));
    const tempo = tempoOf(opts.tempo, 90);
    const SECTION = { sov: 'Verse', soc: 'Chorus', sob: 'Bridge', soi: 'Intro' };
    const rawBars = [];
    let label = null;
    const lines = String(chordpro == null ? '' : chordpro).split(/\r?\n/);
    for (const raw of lines) {
      if (rawBars.length >= MAX_BARS_LEAD) break;
      const line = raw.trim();
      if (!line) continue;
      const dm = line.match(/^\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}$/);
      if (dm) {
        const nm = dm[1].toLowerCase();
        if (nm === 'c' || nm === 'comment') {
          const txt = cleanText(dm[2], 40);
          if (txt && !/^[⏱🎯⚠]/u.test(txt)) label = txt;
        } else if (SECTION[nm]) label = SECTION[nm];
        continue;
      }
      let rep = 1;
      const body = line.replace(/\(\s*[×x]\s*(\d+)\s*\)\s*$/i, (_, n) => { rep = clamp(parseInt(n, 10) || 1, 1, 8); return ''; });
      const chordsIn = (s) => Array.from(s.matchAll(/\[([^\]]*)\]/g), (m) => m[1].trim());
      let rowBars = [];
      if (body.indexOf('|') >= 0) {
        body.split('|').forEach((part) => { const cs = chordsIn(part); if (cs.length) rowBars.push(cs); });
      } else {
        chordsIn(body).forEach((c) => rowBars.push([c]));
      }
      if (!rowBars.length) continue;
      for (let r = 0; r < rep && rawBars.length < MAX_BARS_LEAD; r++) {
        rowBars.forEach((cs, j) => {
          if (rawBars.length >= MAX_BARS_LEAD) return;
          rawBars.push({ chords: cs, label: (r === 0 && j === 0) ? label : null });
        });
      }
      label = null;
    }
    const bars = [];
    const tokens = [];
    rawBars.forEach((rb, bi) => {
      const k = Math.max(1, Math.min(rb.chords.length, barU));
      const beats = Math.floor(barU / U);
      const per = k <= beats ? Math.floor(beats / k) * U : Math.max(1, Math.floor(barU / k));
      const barTokens = [];
      let u = bi * barU;
      for (let j = 0; j < k; j++) {
        const len = j === k - 1 ? (bi * barU + barU) - u : per;
        const c = rb.chords[j];
        const isNC = /^n\.?c\.?$/i.test(c || '');
        const name = isNC ? null : transposeChordName(c, transpose, ki);
        splitRest(u, len, grp, barU).forEach((l, q) => {
          const tk = { u, len: l, p: null, inv: true, i: -1, first: q === 0, tieNext: false,
            chord: q === 0 ? name : null, label: null };
          if (q === 0 && j === 0 && rb.label) tk.label = cleanText(rb.label, 40).replace(/"/g, "'");
          if (q === 0 && isNC) tk.label = (tk.label ? tk.label + ' · ' : '') + 'N.C.';
          barTokens.push(tk); tokens.push(tk);
          u += l;
        });
      }
      bars.push({ index: bi, start: bi * barU, tokens: barTokens });
    });
    if (!bars.length) { // ไม่มีคอร์ดเลย → ห้องว่าง 1 ห้อง (ตัวหยุดเต็มห้อง)
      const barTokens = [];
      let u = 0;
      splitRest(0, barU, grp, barU).forEach((l) => {
        const x = { u, len: l, p: null, inv: false, i: -1, first: false, tieNext: false, chord: null };
        barTokens.push(x); tokens.push(x); u += l;
      });
      bars.push({ index: 0, start: 0, tokens: barTokens });
    }
    const o = { ts, ki, grp, tempo, title: opts.title, lineWidth: opts.lineWidth, maxBarsPerLine: opts.maxBarsPerLine || 4, solMode: null };
    const em = emitAbc(header(o), bars, o);
    return { abc: em.abc, noteMap: em.noteMap, key: ki.name, timeSig: ts, tempo, tokens, startU: 0, endU: bars.length * barU, barU, lines: em.lines, bars: rawBars.length, warnings: [] };
  }

  // ชื่อคีย์จาก key object ของ abcjs ({root:'F', acc:'#'|'b'|'', mode:'m'|'Dor'|...}) → "F#m"
  // โหมดอื่น (Dorian, Mixolydian ...) แทนด้วยคีย์เมเจอร์ที่มีเครื่องหมายประจำคีย์เท่ากัน
  function keyNameFromAbc(k) {
    if (!k || !k.root || k.root === 'none' || k.root === 'HP' || k.root === 'Hp') return 'C';
    const acc = k.acc === '#' || k.acc === 'sharp' ? '#' : (k.acc === 'b' || k.acc === 'flat') ? 'b' : '';
    const mode = String(k.mode || '').toLowerCase();
    if (mode === '' || mode === 'maj' || mode === 'major' || mode === 'ion') return String(k.root).toUpperCase() + acc;
    if (mode === 'm' || mode === 'min' || mode === 'minor' || mode === 'aeo') return String(k.root).toUpperCase() + acc + 'm';
    let n = 0;
    (k.accidentals || []).forEach((a) => { if (a.acc === 'sharp') n++; else if (a.acc === 'flat') n--; });
    const hit = Object.keys(MAJOR_FIFTHS).find((x) => MAJOR_FIFTHS[x] === n);
    return hit || 'C';
  }

  /* ---------------- ABC (ที่ abcjs parse แล้ว) → melody ----------------
     ใช้ในแท็บ "ABC ขั้นสูง" (นำเข้า) — คิดเครื่องหมายประจำคีย์ + accidental ในห้อง (มีผลเฉพาะ octave เดียวกัน)
     tune = ABCJS.parseOnly(text)[0] · คืน {melody, warnings} */
  function abcTuneToMelody(tune) {
    const warnings = [];
    if (!tune || !Array.isArray(tune.lines)) throw new Error('bad tune');
    let ts = null, keyName = null, sig = null;
    const notes = [];
    let u = 0, firstBarLen = null, barStartU = 0;
    let barAcc = {};
    let lastNote = null, pendingTie = false;
    const ACC_VAL = { sharp: 1, flat: -1, natural: 0, dblsharp: 2, dblflat: -2, quartersharp: 0, quarterflat: 0 };
    const sigFromKey = (key) => {
      const s = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
      (key && key.accidentals || []).forEach((a) => { const L = String(a.note || '').toUpperCase(); if (L in s) s[L] = ACC_VAL[a.acc] || 0; });
      return s;
    };
    const tempo = tune.metaText && tune.metaText.tempo && isNum(tune.metaText.tempo.bpm)
      ? Math.round(tune.metaText.tempo.bpm * ((tune.metaText.tempo.duration && tune.metaText.tempo.duration[0]) ? tune.metaText.tempo.duration[0] * 4 : 1)) : null;
    for (const line of tune.lines) {
      if (!line.staff || !line.staff[0]) continue;
      const st = line.staff[0];
      if (!ts && st.meter && st.meter.value && st.meter.value[0]) {
        ts = normTimeSig([parseInt(st.meter.value[0].num, 10), parseInt(st.meter.value[0].den, 10)]);
      } else if (!ts && st.meter && st.meter.type === 'common_time') ts = [4, 4];
      else if (!ts && st.meter && st.meter.type === 'cut_time') ts = [2, 2];
      if (st.key && !keyName) keyName = keyNameFromAbc(st.key);
      if (st.key) sig = sigFromKey(st.key);
      if (!sig) sig = sigFromKey(null);
      if (line.staff.length > 1 || (st.voices && st.voices.length > 1)) warnings.push('multi-voice');
      const voice = (st.voices && st.voices[0]) || [];
      for (const el of voice) {
        if (el.el_type === 'bar') {
          if (firstBarLen === null && u > 0) firstBarLen = u;
          barStartU = u; barAcc = {};
          continue;
        }
        if (el.el_type === 'key') { sig = sigFromKey(el); continue; }
        if (el.el_type !== 'note') continue;
        if (notes.length >= MAX_NOTES) { warnings.push('too-many-notes'); break; }
        let dur = Array.isArray(el.duration) ? el.duration[0] : el.duration;
        if (!isNum(dur) || dur <= 0) continue;
        if (el.tripletMultiplier) dur *= el.tripletMultiplier;
        const lenQ = dur * 4 * U;
        let len = Math.round(lenQ);
        if (Math.abs(lenQ - len) > 0.01) warnings.push('quantized');
        if (len < 1) { len = 1; warnings.push('quantized'); }
        const note = { t: 0, d: len / U, p: null };
        note._u = u;
        if (!el.rest && el.pitches && el.pitches.length) {
          if (el.pitches.length > 1) warnings.push('chord-notes');
          const pt = el.pitches[el.pitches.length - 1];
          const step = pt.pitch; // 0 = C4
          const li = mod(step, 7), oct = 4 + Math.floor(step / 7);
          const L = LETTERS[li];
          const key = li + ':' + oct;
          let acc;
          if (pt.accidental && pt.accidental in ACC_VAL) { acc = ACC_VAL[pt.accidental]; barAcc[key] = acc; }
          else if (pendingTie && lastNote && lastNote._step === step) acc = lastNote._acc; // โน้ตที่โยงข้ามห้องโดยไม่เขียนเครื่องหมายซ้ำ = เสียงเดิม
          else acc = key in barAcc ? barAcc[key] : sig[L];
          note.p = clamp((oct + 1) * 12 + LETTER_PC[li] + acc, 0, 127);
          note._step = step; note._acc = acc;
          if (pt.startTie) note.tie = true;
        }
        if (el.lyric && el.lyric[0]) {
          const sy = String(el.lyric[0].syllable || '').trim();
          if (sy) note.syl = sy.slice(0, 24);
        }
        if (el.chord && el.chord.length) {
          const c = el.chord.find((x) => cleanChord(x.name) && (!x.position || x.position === 'default'));
          if (c) note.chord = String(c.name).trim();
        }
        // โน้ตที่ถูกผูกต่อจากตัวก่อน (เสียงเดิม) → เพิ่มความยาวให้ตัวก่อนแทนการสร้างโน้ตใหม่
        if (pendingTie && lastNote && lastNote.p != null && note.p === lastNote.p && lastNote._u + lastNote.d * U === u && !note.syl) {
          lastNote.d += note.d;
          lastNote.tie = !!note.tie;
          if (!lastNote.tie) delete lastNote.tie;
          pendingTie = !!note.tie;
          if (!lastNote.chord && note.chord) { /* คอร์ดกลางโน้ต — เก็บไว้กับโน้ตเดิมไม่ได้ ข้าม */ warnings.push('chord-mid-note'); }
          u += len;
          continue;
        }
        pendingTie = !!note.tie;
        notes.push(note);
        lastNote = note;
        u += len;
      }
      void barStartU;
    }
    ts = ts || [4, 4];
    const barU = barUnits(ts);
    let pickupU = 0;
    if (firstBarLen !== null && firstBarLen < barU) pickupU = firstBarLen;
    notes.forEach((n) => { n.t = (n._u - pickupU) / U; delete n._u; delete n._step; delete n._acc; if (n.tie !== true) delete n.tie; });
    const melody = { name: 'ทำนองร้อง', timeSig: ts, keySig: keyName && parseKeyName(keyName) ? keyInfo(keyName).name : 'C', notes };
    if (tempo && tempo >= 20 && tempo <= 400) melody.tempo = tempo;
    if (pickupU) melody.pickup = pickupU / U;
    return { melody, warnings: Array.from(new Set(warnings)) };
  }

  /* ================= ส่วนเบราว์เซอร์: โหลด abcjs / วาด / เล่นเสียง / ส่งออก ================= */
  let libPromise = null;
  function loadAbcjs() {
    if (window.ABCJS && window.ABCJS.renderAbc) return Promise.resolve(window.ABCJS);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      if (typeof document === 'undefined') { reject(Object.assign(new Error('no document'), { code: 'lib' })); return; }
      const s = document.createElement('script');
      s.src = ABCJS_URL;
      s.integrity = ABCJS_SRI;
      s.crossOrigin = 'anonymous';
      s.async = true;
      let done = false;
      const fail = (why) => {
        if (done) return; done = true;
        clearTimeout(timer); s.remove(); libPromise = null;
        reject(Object.assign(new Error('abcjs ' + why), { code: 'lib' }));
      };
      const timer = setTimeout(() => fail('timeout'), 25000);
      s.onload = () => {
        if (done) return;
        if (window.ABCJS && window.ABCJS.renderAbc) { done = true; clearTimeout(timer); resolve(window.ABCJS); }
        else fail('noglobal');
      };
      s.onerror = () => fail('load');
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function tempoForSong(song) {
    const m = song && song.melody;
    return tempoOf(m && m.tempo, tempoOf(song && song.tempo, tempoOf(song && song.bpm, 90)));
  }

  // สร้าง ABC สำหรับเพลง: มีทำนอง → melodyToAbc, ไม่มี → lead sheet จาก ChordPro
  function buildForSong(song, opts) {
    opts = opts || {};
    const mel = song && song.melody;
    const hasMelody = !!(mel && Array.isArray(mel.notes) && mel.notes.length);
    const keySig = (mel && parseKeyName(mel.keySig) && mel.keySig) || (song && parseKeyName(song.key) && song.key) || 'C';
    const common = { title: opts.title, transpose: opts.transpose || 0, lineWidth: opts.lineWidth, maxBarsPerLine: opts.maxBarsPerLine };
    if (hasMelody || opts.forceMelody) {
      const r = melodyToAbc(mel || { notes: [] }, Object.assign({}, common, {
        keySig, tempo: tempoForSong(song), chords: opts.chords,
        thaiSolfege: !!opts.thaiSolfege, solfegeMode: opts.solfegeMode,
      }));
      r.kind = 'melody';
      return r;
    }
    const r = leadSheetFromChordPro(song && song.chordpro, [4, 4], Object.assign({}, common, { keySig, tempo: tempoForSong(song) }));
    r.kind = 'lead';
    return r;
  }

  /* ---- ตัวควบคุมการวาด 1 ชุด ---- */
  const live = new Set(); // ตัวที่กำลังแสดง — หยุดเสียงทั้งหมดเมื่อเปลี่ยนหน้า
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', () => { live.forEach((c) => { if (!c.el.isConnected) c.destroy(); else c.stop(); }); });
    window.addEventListener('pagehide', () => live.forEach((c) => c.stop()));
  }

  function render(el, song, opts) {
    opts = Object.assign({}, opts || {});
    const ctl = {
      el, song, opts, tune: null, built: null, abc: '', noteMap: null, error: null,
      playing: false, destroyed: false, selected: -1,
      update, stop, play, toggle, destroy, select, highlightNote, exportMidi: () => exportMidi(ctl), exportAbc: () => exportAbc(ctl),
    };
    el.classList.add('nt-paper');
    el.innerHTML = `<div class="nt-loading">${esc(tr('nt.loading'))}</div>`;
    let lastW = 0, ro = null, resizeT = 0, pendingRedraw = false;

    function width() { return Math.max(240, Math.floor(el.clientWidth || (el.parentNode && el.parentNode.clientWidth) || 340)); }
    function draw(A) {
      if (ctl.destroyed) return;
      const w = width();
      lastW = w;
      const scale = clamp(isNum(opts.scale) ? opts.scale : (w < 520 ? 0.92 : 1), 0.6, 1.6);
      const staffwidth = Math.max(220, Math.floor((w - 8) / scale));
      ctl.built = buildForSong(song, Object.assign({}, opts, { lineWidth: staffwidth - 20, maxBarsPerLine: opts.maxBarsPerLine || (staffwidth > 900 ? 5 : 4) }));
      ctl.abc = ctl.built.abc;
      ctl.noteMap = ctl.built.noteMap;
      const params = {
        add_classes: true,
        staffwidth, scale,
        paddingtop: 4, paddingbottom: 8, paddingleft: 2, paddingright: 6,
        foregroundColor: 'currentColor',
        selectionColor: cssVar('--nt-select', '#0d9488'),
        clickListener: onClick,
      };
      if (opts.showTab) params.tablature = [{ instrument: 'guitar', label: tr('nt.tabLabel'), capo: clamp(Math.round(opts.capo || 0), 0, 11) }];
      el.innerHTML = '';
      const host = document.createElement('div');
      host.className = 'nt-svg';
      el.appendChild(host);
      try {
        const tunes = A.renderAbc(host, ctl.abc, params);
        ctl.tune = tunes && tunes[0];
      } catch (e) {
        ctl.error = e;
        el.innerHTML = `<div class="nt-error">⚠ ${esc(tr('nt.err.render'))}</div>`;
        return;
      }
      indexElements();
      if (ctl.selected >= 0) highlightNote(ctl.selected, 'nt-sel');
      if (opts.onRender) { try { opts.onRender(ctl); } catch (e) { /* UI ภายนอกพัง ไม่ให้ลาม */ } }
    }
    function indexElements() {
      ctl.elByStart = {};
      if (!ctl.tune || !ctl.tune.lines) return;
      ctl.tune.lines.forEach((ln) => (ln.staff || []).forEach((st) => (st.voices || []).forEach((v) => v.forEach((e) => {
        if (e && isNum(e.startChar) && e.abselem && e.abselem.elemset) {
          const arr = ctl.elByStart[e.startChar] || (ctl.elByStart[e.startChar] = []);
          e.abselem.elemset.forEach((x) => { if (x) arr.push(x); });
        }
      }))));
    }
    function onClick(abcElem) {
      if (!abcElem || !ctl.noteMap) return;
      const idx = ctl.noteMap.byStart[abcElem.startChar];
      if (idx == null) return;
      const it = ctl.noteMap.items[idx];
      if (opts.onSelect) opts.onSelect(it, ctl);
      else if (it.p != null) {
        select(it.i);
        try { if (window.Music) Music.pluck(it.p, 0, 1.2, 0.3); } catch (e) { /* ไม่มีเสียงก็ไม่เป็นไร */ }
      }
    }
    function highlightNote(noteIndex, cls) {
      cls = cls || 'nt-sel';
      el.querySelectorAll('.' + cls).forEach((x) => x.classList.remove(cls));
      if (noteIndex == null || noteIndex < 0 || !ctl.noteMap) return;
      const list = ctl.noteMap.noteItems[noteIndex] || [];
      let firstEl = null;
      list.forEach((ii) => {
        const els = ctl.elByStart && ctl.elByStart[ctl.noteMap.items[ii].start];
        (els || []).forEach((x) => { x.classList.add(cls); if (!firstEl) firstEl = x; });
      });
      return firstEl;
    }
    function highlightItem(itemIdx) {
      el.querySelectorAll('.nt-play').forEach((x) => x.classList.remove('nt-play'));
      if (itemIdx == null || itemIdx < 0) return null;
      const it = ctl.noteMap.items[itemIdx];
      const els = it.i >= 0 ? null : (ctl.elByStart[it.start] || []);
      let firstEl = null;
      if (els) els.forEach((x) => { x.classList.add('nt-play'); if (!firstEl) firstEl = x; });
      else {
        (ctl.noteMap.noteItems[it.i] || []).forEach((ii) => (ctl.elByStart[ctl.noteMap.items[ii].start] || []).forEach((x) => { x.classList.add('nt-play'); if (!firstEl) firstEl = x; }));
      }
      return firstEl;
    }
    ctl._highlightItem = highlightItem;
    function select(noteIndex) { ctl.selected = noteIndex; highlightNote(noteIndex, 'nt-sel'); }
    function update(newSong, newOpts) {
      if (newSong) ctl.song = song = newSong;
      if (newOpts) Object.assign(opts, newOpts);
      stop();
      if (window.ABCJS && window.ABCJS.renderAbc) draw(window.ABCJS);
      else ctl.ready = loadAbcjs().then((A) => { draw(A); return ctl; });
    }
    function destroy() {
      if (ctl.destroyed) return;
      stop();
      ctl.destroyed = true;
      live.delete(ctl);
      if (ro) ro.disconnect();
      clearTimeout(resizeT);
    }
    function stop() { stopPlayback(ctl); }
    function play(from) { return startPlayback(ctl, from); }
    function toggle(from) { return ctl.playing || ctl._starting ? (stop(), Promise.resolve(false)) : play(from); }

    live.add(ctl);
    ctl.ready = loadAbcjs().then((A) => {
      if (ctl.destroyed) return ctl;
      draw(A);
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
          clearTimeout(resizeT);
          resizeT = setTimeout(() => {
            if (ctl.destroyed || !el.isConnected) return;
            const w = width();
            if (Math.abs(w - lastW) < 24) return;
            if (ctl.playing) { pendingRedraw = true; return; } // วาดใหม่หลังหยุดเล่น (ไฮไลต์อ้างอิง element เดิม)
            draw(A);
          }, 160);
        });
        ro.observe(el);
      }
      ctl._afterStop = () => { if (pendingRedraw && !ctl.destroyed) { pendingRedraw = false; draw(A); } };
      return ctl;
    }).catch((e) => {
      ctl.error = e;
      if (!ctl.destroyed) el.innerHTML = `<div class="nt-error">⚠ ${esc(tr('nt.err.lib'))}</div>`;
      return ctl;
    });
    return ctl;
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- เล่นเสียง ----------------
     หลัก: abcjs synth (soundfont เปียโน + คอร์ดประกอบ) · สำรอง: เสียงดีดใน music.js (ออฟไลน์/โหลด soundfont ไม่ได้)
     ไฮไลต์โน้ตตามเวลาเอง (rAF เทียบกับ AudioContext.currentTime) — ใช้ได้ทั้งสองแบบ + เริ่มจากโน้ตไหนก็ได้ */
  function audioContext() {
    if (window.Music && Music.audioCtx) return Music.audioCtx();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw Object.assign(new Error('no audio'), { code: 'audio' });
    if (!audioContext._c) audioContext._c = new AC();
    if (audioContext._c.state === 'suspended') audioContext._c.resume();
    return audioContext._c;
  }

  function notify(ctl, key) {
    const msg = tr(key);
    if (ctl.opts.onError) ctl.opts.onError(msg, key);
    else if (typeof console !== 'undefined') console.warn('[notation]', key);
  }

  // สร้างชุดที่จะเล่น: ทั้งเพลง หรือเริ่มจากโน้ต index ที่ระบุ
  // (ตัดโน้ตก่อนหน้าทิ้งเป็น null เพื่อคง index เดิม → ไฮไลต์บนสกอร์หลักถูกตัว
  //  ส่วนที่เหลือของห้องแรกกลายเป็น pickup → เสียงเริ่มที่โน้ตนั้นทันที และเส้นกั้นห้องตรงเดิม)
  function playableBuild(ctl, fromNote) {
    const b = ctl.built;
    if (fromNote == null || fromNote < 0 || b.kind !== 'melody') return b;
    const mel = ctl.song.melody;
    const src = mel && mel.notes && mel.notes[fromNote];
    if (!src || !isNum(src.t)) return b;
    const t0 = src.t;
    const barBeats = barUnits(normTimeSig(mel.timeSig)) / U;
    const pick = mod(-t0, barBeats); // จำนวน beat จากโน้ตนี้ถึงเส้นกั้นห้องถัดไป
    const sub = Object.assign({}, mel, {
      pickup: pick,
      notes: mel.notes.map((n) => (n && isNum(n.t) && n.t >= t0 - 1e-9) ? Object.assign({}, n, { t: n.t - t0 - pick }) : null),
    });
    const r = melodyToAbc(sub, ctlBuildOpts(ctl));
    r.kind = 'melody';
    return r;
  }
  function ctlBuildOpts(ctl) {
    const s = ctl.song, o = ctl.opts;
    const keySig = (s.melody && parseKeyName(s.melody.keySig) && s.melody.keySig) || (parseKeyName(s.key) && s.key) || 'C';
    return { transpose: o.transpose || 0, keySig, tempo: tempoForSong(s), chords: o.chords };
  }

  async function startPlayback(ctl, fromNote) {
    if (ctl.playing || ctl._starting || ctl.destroyed || !ctl.built) return false;
    ctl._starting = true;
    ctl._stopReq = false;
    const token = (ctl._playToken = (ctl._playToken || 0) + 1);
    let ac;
    try { ac = audioContext(); } // ต้องเรียกใน gesture (iOS)
    catch (e) { ctl._starting = false; notify(ctl, 'nt.err.audio'); return false; }
    const pb = playableBuild(ctl, fromNote);
    const secPerU = 60 / (pb.tempo * U);
    setPlayState(ctl, true);
    let synth = null;
    try {
      const A = await loadAbcjs();
      if (token !== ctl._playToken || ctl._stopReq || ctl.destroyed) return false;
      const tune = A.parseOnly(pb.abc)[0];
      synth = new A.synth.CreateSynth();
      const init = await withTimeout(synth.init({
        audioContext: ac, visualObj: tune,
        options: { soundFontUrl: SOUNDFONT_URL, program: ctl.opts.program || 0, chordsOff: !!ctl.opts.chordsOff },
      }), 20000);
      if (init && init.loadingResponse && init.loadingResponse.error && init.loadingResponse.error.length &&
          !(init.loadingResponse.loaded && init.loadingResponse.loaded.length) && !(init.loadingResponse.cached && init.loadingResponse.cached.length)) {
        throw Object.assign(new Error('soundfont'), { code: 'soundfont' });
      }
      await withTimeout(synth.prime(), 20000);
      if (token !== ctl._playToken || ctl._stopReq || ctl.destroyed) { try { synth.stop(); } catch (e) {} return false; }
      if (ac.state === 'suspended') { try { await ac.resume(); } catch (e) {} }
      synth.start();
      ctl._synth = synth;
      const t0 = ac.currentTime;
      runClock(ctl, () => ac.currentTime - t0, pb, secPerU, token);
      return true;
    } catch (e) {
      if (token !== ctl._playToken || ctl._stopReq || ctl.destroyed) return false;
      try { if (synth) synth.stop(); } catch (x) { /* ignore */ }
      // โหลด soundfont/abcjs ไม่ได้ (ออฟไลน์) → เล่นด้วยเสียงดีดในเครื่องแทน
      if (window.Music && Music.pluck) {
        notify(ctl, 'nt.err.soundfont');
        fallbackPlay(ctl, ac, pb, secPerU, token);
        return true;
      }
      setPlayState(ctl, false);
      notify(ctl, 'nt.err.audio');
      return false;
    } finally {
      ctl._starting = false;
    }
  }

  function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
      Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  function setPlayState(ctl, on) {
    ctl.playing = on;
    if (ctl.opts.onPlayState) { try { ctl.opts.onPlayState(on); } catch (e) { /* ignore */ } }
  }

  // นาฬิกาไฮไลต์: token ของชุดที่เล่น → โน้ตบนสกอร์หลัก (ผ่าน index โน้ต หรือลำดับ token ถ้าเป็นชุดเดียวกัน)
  // clock() = วินาทีนับจากต้นชุดที่เล่น (ติดลบได้ช่วงเผื่อเวลาเริ่ม)
  function runClock(ctl, clock, pb, secPerU, token) {
    const toks = pb.tokens;
    const startU = pb.startU, endU = pb.endU;
    const sameBuild = pb === ctl.built;
    let k = 0, lastHi = -2;
    const tick = () => {
      if (token !== ctl._playToken || !ctl.playing || ctl.destroyed) return;
      const u = startU + clock() / secPerU;
      if (u >= endU + 0.5) { stopPlayback(ctl); return; }
      while (k < toks.length - 1 && toks[k].u + toks[k].len <= u) k++;
      const tk = toks[k];
      let hi = -1;
      if (tk && tk.u <= u && u < tk.u + tk.len) {
        if (sameBuild) hi = k;
        else if (tk.i >= 0 && ctl.noteMap) { const list = ctl.noteMap.noteItems[tk.i]; hi = list ? list[0] : -1; }
      }
      if (hi !== lastHi) {
        lastHi = hi;
        const first = ctl._highlightItem(hi);
        if (first && ctl.opts.follow !== false) followScroll(first);
      }
      ctl._raf = requestAnimationFrame(tick);
    };
    ctl._raf = requestAnimationFrame(tick);
  }

  function followScroll(node) {
    try {
      const r = node.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      if (r.top < 70 || r.bottom > vh - 110) window.scrollBy({ top: r.top - vh * 0.35, behavior: 'smooth' });
    } catch (e) { /* ignore */ }
  }

  // เล่นสำรองด้วย Karplus-Strong ของ music.js — จัดคิวล่วงหน้าทีละ ~1.2 วิ (ไม่สร้างบัฟเฟอร์ทั้งเพลงทีเดียว)
  function fallbackPlay(ctl, ac, pb, secPerU, token) {
    const toks = pb.tokens;
    const startU = pb.startU;
    const t0 = ac.currentTime + 0.08;
    let q = 0;
    let prevTie = false;
    const pump = () => {
      if (token !== ctl._playToken || !ctl.playing) return;
      const horizon = (ac.currentTime - t0) / secPerU + startU + 1.2 / secPerU;
      while (q < toks.length && toks[q].u < horizon) {
        const idx = q++;
        const tk = toks[idx];
        const when = Math.max(0, t0 + (tk.u - startU) * secPerU - ac.currentTime);
        if (tk.chord && window.Music && Music.chordToMidis) {
          Music.chordToMidis(tk.chord).forEach((m, j) => Music.pluck(m, when + j * 0.02, 1.4, 0.12));
        }
        if (tk.p != null && !prevTie) {
          // ความยาวทั้งเสียง (รวมชิ้นที่ผูกต่อกัน)
          let len = tk.len, j = idx;
          while (toks[j] && toks[j].tieNext && toks[j + 1]) { len += toks[j + 1].len; j++; }
          Music.pluck(tk.p, when, Math.min(2.5, Math.max(0.35, len * secPerU * 1.1)), 0.3);
        }
        prevTie = tk.p != null && tk.tieNext;
      }
      if (q < toks.length) ctl._pumpT = setTimeout(pump, 250);
    };
    pump();
    runClock(ctl, () => ac.currentTime - t0, pb, secPerU, token);
  }

  function stopPlayback(ctl) {
    ctl._playToken = (ctl._playToken || 0) + 1;
    ctl._stopReq = true;
    cancelAnimationFrame(ctl._raf);
    clearTimeout(ctl._pumpT);
    if (ctl._synth) { try { ctl._synth.stop(); } catch (e) { /* ignore */ } ctl._synth = null; }
    if (ctl._highlightItem && ctl.el) ctl.el.querySelectorAll('.nt-play').forEach((x) => x.classList.remove('nt-play'));
    const was = ctl.playing;
    if (was || ctl._starting) setPlayState(ctl, false);
    if (ctl._afterStop) ctl._afterStop();
  }

  /* ---------------- ส่งออก ---------------- */
  function fileBase(song) {
    const b = String((song && song.title) || 'aquachord').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60);
    return b || 'aquachord';
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function exportText(song, opts) {
    const b = buildForSong(song, Object.assign({}, opts || {}, { title: (song && song.title) || 'AquaChord', lineWidth: 740 }));
    return b.abc;
  }
  function exportAbc(ctlOrSong, opts) {
    const song = ctlOrSong && ctlOrSong.song ? ctlOrSong.song : ctlOrSong;
    const o = ctlOrSong && ctlOrSong.opts ? ctlOrSong.opts : (opts || {});
    download(new Blob([exportText(song, o)], { type: 'text/vnd.abc;charset=utf-8' }), fileBase(song) + '.abc');
  }
  async function exportMidi(ctlOrSong, opts) {
    const song = ctlOrSong && ctlOrSong.song ? ctlOrSong.song : ctlOrSong;
    const o = ctlOrSong && ctlOrSong.opts ? ctlOrSong.opts : (opts || {});
    const A = await loadAbcjs();
    const out = A.synth.getMidiFile(exportText(song, Object.assign({}, o, { thaiSolfege: false })), { midiOutputType: 'binary' });
    const bin = Array.isArray(out) ? out[0] : out;
    if (!bin || !bin.length) throw Object.assign(new Error('midi'), { code: 'midi' });
    download(new Blob([bin], { type: 'audio/midi' }), fileBase(song) + '.mid');
  }

  /* ---------------- UI ในหน้าเพลง (แท็บ "โน้ต") ---------------- */
  const PREF_KEY = 'aq.nt.prefs';
  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { p = {}; }
    return { tab: p.tab === true, sol: ['off', 'fixed', 'movable'].indexOf(p.sol) >= 0 ? p.sol : 'off' };
  }
  function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab: !!p.tab, sol: p.sol })); } catch (e) { /* โหมดส่วนตัว */ } }

  // host = กล่องว่างในหน้าเพลง · opts: {transpose, capo, size, toast(msg)}
  function mountSongView(host, song, opts) {
    opts = opts || {};
    const prefs = loadPrefs();
    const mel = song.melody;
    const hasMelody = !!(mel && Array.isArray(mel.notes) && mel.notes.length);
    host.innerHTML = `
      <div class="nt-bar">
        <button type="button" class="btn btn-sm nt-play-btn" data-nt="play" disabled>▶ ${esc(tr('nt.play'))}</button>
        <button type="button" class="nt-chip" data-nt="tab" aria-pressed="${prefs.tab}">🎸 ${esc(tr('nt.tab'))}</button>
        ${hasMelody ? `<div class="nt-seg" role="group" aria-label="${esc(tr('nt.solfege'))}">
          <span class="nt-seg-lbl">${esc(tr('nt.solfege'))}</span>
          <button type="button" data-sol="off" aria-pressed="${prefs.sol === 'off'}">${esc(tr('nt.sol.off'))}</button>
          <button type="button" data-sol="fixed" aria-pressed="${prefs.sol === 'fixed'}">${esc(tr('nt.sol.fixed'))}</button>
          <button type="button" data-sol="movable" aria-pressed="${prefs.sol === 'movable'}">${esc(tr('nt.sol.movable'))}</button>
        </div>` : ''}
      </div>
      ${hasMelody ? '' : `<div class="nt-hint">🎼 ${esc(tr(String(song.chordpro || '').indexOf('[') >= 0 ? 'nt.leadHint' : 'nt.emptyHint'))}</div>`}
      <div class="nt-staff"></div>
      <div class="sheet-actions">
        <a class="btn-ghost btn-sm" href="#/notes/${encodeURIComponent(song.id)}">✎ ${esc(tr(hasMelody ? 'nt.edit' : 'nt.create'))}</a>
        <button type="button" class="btn-ghost btn-sm" data-nt="midi">⬇ ${esc(tr('nt.midi'))}</button>
        <button type="button" class="btn-ghost btn-sm" data-nt="abc">⬇ ABC</button>
      </div>
      <div class="nt-ai muted">${hasMelody && song.analysis && song.analysis.engine === 'gpu' ? '🤖 ' + esc(tr('nt.aiNote')) : ''}</div>`;
    const toast = opts.toast || ((m) => console.warn(m));
    const playBtn = host.querySelector('[data-nt="play"]');
    const ctl = render(host.querySelector('.nt-staff'), song, {
      transpose: opts.transpose || 0, capo: opts.capo || 0, showTab: prefs.tab,
      thaiSolfege: prefs.sol !== 'off', solfegeMode: prefs.sol,
      scale: opts.size ? clamp(opts.size, 0.8, 1.6) * (window.innerWidth < 520 ? 0.9 : 1) : undefined,
      onError: (msg) => toast(msg),
      onPlayState: (on) => { playBtn.innerHTML = on ? '■ ' + esc(tr('nt.stop')) : '▶ ' + esc(tr('nt.play')); playBtn.classList.toggle('on', on); },
      onRender: () => { playBtn.disabled = false; },
    });
    ctl.ready.then(() => { if (ctl.error) playBtn.disabled = true; });
    playBtn.addEventListener('click', () => { ctl.toggle(); });
    host.querySelector('[data-nt="tab"]').addEventListener('click', (e) => {
      prefs.tab = !prefs.tab; savePrefs(prefs);
      e.currentTarget.setAttribute('aria-pressed', String(prefs.tab));
      ctl.update(null, { showTab: prefs.tab });
    });
    host.querySelectorAll('[data-sol]').forEach((b) => b.addEventListener('click', () => {
      prefs.sol = b.dataset.sol; savePrefs(prefs);
      host.querySelectorAll('[data-sol]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      ctl.update(null, { thaiSolfege: prefs.sol !== 'off', solfegeMode: prefs.sol });
    }));
    let exporting = false;
    host.querySelector('[data-nt="midi"]').addEventListener('click', async () => {
      if (exporting) return; exporting = true;
      try { await exportMidi(ctl); } catch (e) { toast(tr('nt.err.midi')); } finally { exporting = false; }
    });
    host.querySelector('[data-nt="abc"]').addEventListener('click', () => {
      try { exportAbc(ctl); } catch (e) { toast(tr('nt.err.midi')); }
    });
    return ctl;
  }

  /* ---------------- คำแปล ---------------- */
  if (window.I18N && I18N.extend) {
    I18N.extend({
      th: {
        'nt.tabChords': 'คอร์ด',
        'nt.tabNotes': 'โน้ต',
        'nt.newSong': 'ทำโน้ตเพลงใหม่',
        'nt.loading': 'กำลังเตรียมตัววาดโน้ต…',
        'nt.play': 'เล่น',
        'nt.stop': 'หยุด',
        'nt.tab': 'แท็บกีตาร์',
        'nt.tabLabel': 'กีตาร์',
        'nt.solfege': 'โน้ตไทย',
        'nt.sol.off': 'ปิด',
        'nt.sol.fixed': 'ด=C',
        'nt.sol.movable': 'ด=คีย์',
        'nt.edit': 'แก้ไขโน้ต',
        'nt.create': 'ทำโน้ตทำนอง',
        'nt.midi': 'ส่งออก MIDI',
        'nt.leadHint': 'เพลงนี้ยังไม่มีทำนอง — แสดงคอร์ดทีละห้องให้ก่อน แตะ "ทำโน้ตทำนอง" เพื่อใส่โน้ตเอง',
        'nt.emptyHint': 'ยังไม่มีทำนองและคอร์ด — แตะ "ทำโน้ตทำนอง" เพื่อเริ่มใส่โน้ต',
        'nt.aiNote': 'ทำนองถอดโดย AI — อาจคลาดเคลื่อน แก้ไขได้',
        'nt.err.lib': 'โหลดตัววาดโน้ตไม่สำเร็จ — ต้องต่ออินเทอร์เน็ตครั้งแรก (ครั้งต่อไปใช้ออฟไลน์ได้)',
        'nt.err.render': 'วาดโน้ตไม่สำเร็จ — ข้อมูลทำนองอาจเสีย ลองเปิดหน้าแก้ไขโน้ต',
        'nt.err.audio': 'เล่นเสียงไม่ได้บนอุปกรณ์นี้ — ลองแตะปุ่มเล่นอีกครั้งหรือปิดโหมดเงียบ',
        'nt.err.soundfont': 'โหลดเสียงเปียโนไม่สำเร็จ (ออฟไลน์?) — เล่นด้วยเสียงกีตาร์ในเครื่องแทน',
        'nt.err.midi': 'ส่งออกไฟล์ไม่สำเร็จ — ลองใหม่อีกครั้ง',
      },
      en: {
        'nt.tabChords': 'Chords',
        'nt.tabNotes': 'Notation',
        'nt.newSong': 'New melody',
        'nt.loading': 'Preparing the notation engine…',
        'nt.play': 'Play',
        'nt.stop': 'Stop',
        'nt.tab': 'Guitar tab',
        'nt.tabLabel': 'Guitar',
        'nt.solfege': 'Thai solfège',
        'nt.sol.off': 'Off',
        'nt.sol.fixed': 'Do=C',
        'nt.sol.movable': 'Do=key',
        'nt.edit': 'Edit notes',
        'nt.create': 'Write melody',
        'nt.midi': 'Export MIDI',
        'nt.leadHint': 'No melody yet — showing chords bar by bar. Tap "Write melody" to add notes.',
        'nt.emptyHint': 'No melody or chords yet — tap "Write melody" to start.',
        'nt.aiNote': 'Melody transcribed by AI — may be inaccurate, you can edit it',
        'nt.err.lib': 'Could not load the notation engine — you need to be online the first time (works offline afterwards)',
        'nt.err.render': 'Could not draw the notation — the melody data may be broken; try the note editor',
        'nt.err.audio': 'Audio cannot start on this device — tap play again or turn off silent mode',
        'nt.err.soundfont': 'Could not load the piano sounds (offline?) — using the built-in guitar sound instead',
        'nt.err.midi': 'Export failed — please try again',
      },
    });
  }

  window.Notation = {
    melodyToAbc, leadSheetFromChordPro, abcTuneToMelody, buildForSong,
    render, mountSongView, loadAbcjs, exportMidi, exportAbc, exportText,
    keyInfo, transposeKeyName, transposeChordName, spell, noteName, solfegeName, cleanChord,
    stopAll: () => live.forEach((c) => c.stop()),
    ABCJS_URL, ABCJS_SRI, SOUNDFONT_URL, U, MAX_NOTES,
  };
})();
