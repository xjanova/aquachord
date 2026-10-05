/* lyricfix.js — "ใส่เนื้อร้องที่ถูกต้อง แล้วให้ AI จัดให้ตรงเพลง"
   ผู้ใช้วางเนื้อเพลงจริง → เทียบทีละตัวอักษรกับข้อความที่ Whisper ถอดได้ (มีเวลา/คอร์ดกำกับ) → ใช้ข้อความของผู้ใช้
   แต่คงจังหวะ/ตำแหน่งคอร์ดจากเสียงจริง · ทำงานในเครื่องล้วน ไม่มีเครือข่าย · ไม่แตะ DOM
   ใช้ได้ทั้งเบราว์เซอร์ (window.LyricFix) และ Node (module.exports → tools/test-lyricfix.cjs)

   หลักการเทียบ
   - หน่วยเทียบ = ตัวอักษรหลังทำให้เป็นรูปกลาง: ตัดวรรณยุกต์/ไม้ไต่คู้/การันต์/ๆ/ฯ/ช่องว่าง/เครื่องหมาย,
     พยัญชนะเสียงเดียวกันเป็นตัวเดียว (ศ ษ→ส, ธ ฑ ฒ→ท, ณ→น …), ใ→ไ, อังกฤษตัวเล็ก ไม่มีเครื่องหมายเสียง
     (Whisper ผิดวรรณยุกต์/ตัวสะกดบ่อย แต่ลำดับเสียงยังตรง)
   - รอบแรก: Needleman–Wunsch แบบไม่คิดโทษช่องว่างหัวท้าย (ข้อความหลอนต้นเพลง/เครดิตในเนื้อไม่ทำให้เพี้ยน)
     เกิน ~12M เซลล์ใช้แถบรอบเส้นทแยง
   - ท่อนซ้ำ: ช่วงที่ AI ได้ยินแต่ไม่ตรงกับเนื้อส่วนไหนเลย (เช่นฮุกรอบสองที่เนื้อเขียนแค่ "ซ้ำ *") →
     Smith–Waterman หาท่อนในเนื้อที่ตรงที่สุด แล้วใส่เนื้อท่อนนั้นซ้ำตรงเวลานั้น

   API
   LyricFix.cleanUserLyrics(text) → [line]   (ตัดป้ายท่อนเช่น [Chorus], "ท่อน 1", "(ซ้ำ)", "x2" และวงเล็บเหลี่ยม/ปีกกาที่ชนกับ ChordPro)
   LyricFix.alignToChunks(text, chunks, {duration}) → { chunks:[{t0,t1,text}], match, lines, repeats }
       chunks = ผล Whisper [{t0,t1,text}] → ได้ chunk ใหม่บรรทัดละ 1 ของเนื้อผู้ใช้ เวลาตามเสียงจริง
   LyricFix.spreadLines(text, regions) → { chunks, match:0, rough:true }   (ไม่มีผลถอดเสียง: กระจายตามช่วงที่มีเสียงร้อง)
   LyricFix.voicedRegions(pcm, sr) → [{t0,t1}]
   LyricFix.lyricLineCount(chordpro) → จำนวนบรรทัดเนื้อร้องในชีต
   LyricFix.rewriteChordPro(chordpro, text, {note}) → { chordpro, match, lines, repeats } | null (ชีตไม่มีบรรทัดเนื้อ)
       เพลงที่มีเนื้อจาก AI อยู่แล้ว — ไม่ต้องใช้ไฟล์เสียง: ย้ายคอร์ดทุกตัวไปไว้บนพยางค์เดียวกันในเนื้อของผู้ใช้ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.LyricFix = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const MAX_TEXT = 20000;       // ตัวอักษรสูงสุดของเนื้อที่ผู้ใช้วาง
  const FULL_CELLS = 12e6;      // เกินนี้ใช้ DP แบบแถบ
  const MATCH = 2, MISS = -1, GAP = -1;
  const MIN_RUN = 10;           // ช่วงที่ AI ได้ยินแต่ไม่ตรงเนื้อ ยาวเท่านี้ขึ้นไป → ลองหาท่อนซ้ำ
  const MAX_PASSES = 24;

  /* ---------------- grapheme (ห้ามแทรกคอร์ดกลางสระ/วรรณยุกต์) ---------------- */
  let segmenter = null;
  function graphemes(s) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      if (!segmenter) segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' });
      return Array.from(segmenter.segment(s), (x) => x.segment);
    }
    const out = [];
    const COMB = /[̀-ͯัำ-ฺ็-๎‍️]/;
    for (const ch of s) {
      if (out.length && COMB.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  /* ---------------- รูปกลางสำหรับเทียบ ---------------- */
  const HOMO = {
    'ศ': 'ส', 'ษ': 'ส', 'ซ': 'ส', 'ธ': 'ท', 'ฑ': 'ท', 'ฒ': 'ท', 'ฆ': 'ค', 'ฅ': 'ค', 'ฃ': 'ข',
    'ณ': 'น', 'ฬ': 'ล', 'ญ': 'ย', 'ภ': 'พ', 'ฏ': 'ต', 'ฎ': 'ด', 'ฐ': 'ถ', 'ฌ': 'ช', 'ใ': 'ไ',
  };
  const DROP = /[็-๎ๆฯ]/; // ไม้ไต่คู้ วรรณยุกต์ การันต์ นิคหิต ยามักการ ๆ ฯ
  const THAI = /[ก-ฺเ-ๅ]/, LETTER = /[\p{L}\p{N}]/u;
  // หนึ่ง grapheme → รหัสหน่วยเทียบ (0..n ตัว)
  function unitCodes(g) {
    const out = [];
    const s = g.normalize('NFD').toLowerCase();
    for (const ch of s) {
      if (DROP.test(ch)) continue;
      if (!THAI.test(ch) && !LETTER.test(ch)) continue;
      out.push((HOMO[ch] || ch).codePointAt(0));
    }
    return out;
  }
  // บรรทัด → stream: codes + บรรทัด/ตำแหน่ง grapheme ของแต่ละหน่วย
  function buildStream(lines) {
    const codes = [], line = [], gi = [], lineStart = [], lineEnd = [], lineG = [];
    lines.forEach((text, li) => {
      const g = graphemes(text);
      lineG.push(g);
      lineStart.push(codes.length);
      g.forEach((gr, k) => { unitCodes(gr).forEach((c) => { codes.push(c); line.push(li); gi.push(k); }); });
      lineEnd.push(codes.length);
    });
    return { codes: Int32Array.from(codes), line: Int32Array.from(line), gi: Int32Array.from(gi), lineStart, lineEnd, lineG, n: codes.length };
  }

  /* ---------------- เนื้อร้องของผู้ใช้ → บรรทัดสะอาด ---------------- */
  // ป้ายท่อนทั้งบรรทัด (ไม่ใช่เนื้อ) — ระวังคำไทยที่ขึ้นต้นเหมือนป้าย เช่น "ท่อนนี้…" "ซ้ำเติม…" ต้องไม่โดนตัด
  const LABEL_RE = /^[\s[(（【*#]*(?:intro|verse\s*\d*|repeat(?:\s+\w+)?|chorus\s*\d*|pre[-\s]?chorus|hook|bridge|outro|solo|instrumental|interlude|refrain|break|coda|ending|rap|ท่อน\s*(?:\d+|[a-z]|ฮุก|แร็พ|แร็ป|ร้อง|ดนตรี|โซโล่?|จบ|ส่ง|เวิร์ส|คอรัส|พิเศษ)?|ฮุก|คอรัส|โซโล่?|ดนตรี|เกริ่น|ซ้ำ(?:ท่อน|อีก(?:ครั้ง|รอบ)?)?|\*+|#+)[\s\d.:*#)\]）】]*(?:\s*[x×]\s*\d+)?\s*$/i;
  function cleanUserLyrics(text) {
    const lines = [];
    String(text == null ? '' : text).slice(0, MAX_TEXT).split(/\r?\n/).forEach((raw) => {
      let s = raw.replace(/\s+/g, ' ').trim();
      if (!s) return;
      if (s.length <= 40 && LABEL_RE.test(s)) return;                   // ป้ายท่อน
      s = s.replace(/\s*[(（[]\s*(ซ้ำ|repeat|x\s*\d+|×\s*\d+)[^)）\]]*[)）\]]\s*$/i, '') // (ซ้ำ *) / (x2) ท้ายบรรทัด
        .replace(/\s+[x×]\s*\d+\s*$/i, '')
        .replace(/^[*#\s]+|[*#\s]+$/g, '')
        .replace(/[[]/g, '(').replace(/[\]]/g, ')')                         // [ ] = คอร์ดใน ChordPro
        .replace(/[{}]/g, '');                                              // { } = directive
      s = s.trim();
      if (!s) return;
      if (!/[\p{L}\p{N}]/u.test(s)) return;
      lines.push(s);
    });
    return lines;
  }

  /* ---------------- จัดแนว (global แบบไม่คิดโทษหัวท้าย) ---------------- */
  // A = ข้อความจาก AI (n), B = เนื้อผู้ใช้ (m) → anchors [{i,j,eq}] เรียงตาม i
  function alignGlobal(A, B, a0, a1) {
    a0 = a0 || 0; a1 = a1 == null ? A.length : a1;
    const n = a1 - a0, m = B.length;
    if (!n || !m) return [];
    const banded = n * m > FULL_CELLS;
    const W = banded ? Math.max(600, Math.abs(n - m) + 400) : m;
    const NEG = -1e9;
    let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    // แถว 0: ข้ามหัวเนื้อผู้ใช้ได้ฟรี
    for (let j = 0; j <= m; j++) prev[j] = (!banded || j <= W) ? 0 : NEG;
    const lo = new Int32Array(n + 1), tr = new Array(n + 1);
    lo[0] = 0;
    // บัฟเฟอร์สองแถวสลับกัน: ช่วงที่แถวเดิมในบัฟเฟอร์เคยเขียนไว้ (แบบแถบต้องล้างให้เป็น NEG ก่อนใช้ซ้ำ)
    let prevSpan = [0, m], curSpan = [0, m];
    let best = NEG, bi = 0, bj = 0;
    // คอลัมน์สุดท้ายของแถว 0
    if (prev[m] > best) { best = prev[m]; bi = 0; bj = m; }
    for (let i = 1; i <= n; i++) {
      const c = banded ? Math.round((i * m) / n) : 0;
      const l = banded ? Math.max(0, c - W) : 0, h = banded ? Math.min(m, c + W) : m;
      lo[i] = l;
      const t = new Uint8Array(h - l + 1);
      if (banded) { cur.fill(NEG, Math.max(0, Math.min(curSpan[0], l) - 1), Math.min(m, Math.max(curSpan[1], h) + 1) + 1); curSpan = [l, h]; }
      const ai = A[a0 + i - 1];
      for (let j = l; j <= h; j++) {
        if (j === 0) { cur[0] = 0; t[0] = 3; continue; }  // ข้ามหัวข้อความ AI ได้ฟรี
        const d = prev[j - 1] + (ai === B[j - 1] ? MATCH : MISS);
        const u = prev[j] + GAP;
        const L = cur[j - 1] + GAP;
        let v = d, k = 0;
        if (u > v) { v = u; k = 1; }
        if (L > v) { v = L; k = 2; }
        cur[j] = v; t[j - l] = k;
      }
      tr[i] = t;
      if (h === m && cur[m] > best) { best = cur[m]; bi = i; bj = m; }   // ท้ายเนื้อผู้ใช้ (ข้ามท้าย AI ฟรี)
      const tmp = prev; prev = cur; cur = tmp;
      const ts = prevSpan; prevSpan = curSpan; curSpan = ts;
    }
    // แถวสุดท้าย (ข้ามท้ายเนื้อผู้ใช้ฟรี)
    const lN = lo[n], tN = tr[n];
    for (let j = lN; j <= Math.min(m, lN + tN.length - 1); j++) if (prev[j] > best) { best = prev[j]; bi = n; bj = j; }
    // traceback
    const out = [];
    let i = bi, j = bj;
    while (i > 0 && j > 0) {
      const t = tr[i], k = t[j - lo[i]];
      if (k === 3) break;
      if (k === 0) { out.push({ i: a0 + i - 1, j: j - 1, eq: A[a0 + i - 1] === B[j - 1] }); i--; j--; }
      else if (k === 1) i--;
      else j--;
    }
    out.reverse();
    return out;
  }

  /* ---------------- local (Smith–Waterman) หาท่อนซ้ำ ---------------- */
  function alignLocal(A, a0, a1, B) {
    const n = a1 - a0, m = B.length;
    if (!n || !m || n * m > 20e6) return null;
    let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    const tr = new Array(n + 1);
    let best = 0, bi = 0, bj = 0;
    for (let i = 1; i <= n; i++) {
      const t = new Uint8Array(m + 1);
      cur[0] = 0;
      const ai = A[a0 + i - 1];
      for (let j = 1; j <= m; j++) {
        const d = prev[j - 1] + (ai === B[j - 1] ? MATCH : MISS);
        const u = prev[j] + GAP, L = cur[j - 1] + GAP;
        let v = 0, k = 3;
        if (d > v) { v = d; k = 0; }
        if (u > v) { v = u; k = 1; }
        if (L > v) { v = L; k = 2; }
        cur[j] = v; t[j] = k;
        if (v > best) { best = v; bi = i; bj = j; }
      }
      tr[i] = t;
      const tmp = prev; prev = cur; cur = tmp;
    }
    if (!best) return null;
    const out = [];
    let i = bi, j = bj;
    while (i > 0 && j > 0) {
      const k = tr[i][j];
      if (k === 3) break;
      if (k === 0) { out.push({ i: a0 + i - 1, j: j - 1, eq: A[a0 + i - 1] === B[j - 1] }); i--; j--; }
      else if (k === 1) i--;
      else j--;
    }
    out.reverse();
    return out;
  }

  /* ---------------- หลายรอบ: global + ท่อนซ้ำ ---------------- */
  // pass = { anchors (เฉพาะตัวที่ตรง), a0, a1 (ช่วง AI ที่ pass นี้ครอบ), b0, b1, primary }
  function mkPass(anchors, primary, aLo, aHi) {
    const eq = anchors.filter((x) => x.eq);
    if (!eq.length) return null;
    return {
      anchors: eq, primary,
      a0: primary ? aLo : eq[0].i, a1: primary ? aHi : eq[eq.length - 1].i + 1,
      b0: eq[0].j, b1: eq[eq.length - 1].j + 1,
    };
  }
  function alignAll(SA, SB) {
    const A = SA.codes, B = SB.codes;
    const passes = [];
    const g = mkPass(alignGlobal(A, B), true, 0, A.length);
    if (!g) return { passes, match: 0, repeats: 0 };
    passes.push(g);
    // ช่วง AI ที่ไม่มี anchor ยาว ≥ MIN_RUN โดยเนื้อผู้ใช้แทบไม่ขยับ → ผู้สมัครท่อนซ้ำ
    const runs = [];
    const an = g.anchors;
    const pushRun = (a, b) => { if (b - a >= MIN_RUN) runs.push([a, b]); };
    pushRun(0, an[0].i);
    for (let k = 1; k < an.length; k++) {
      const da = an[k].i - an[k - 1].i, db = an[k].j - an[k - 1].j;
      if (da - db >= MIN_RUN) pushRun(an[k - 1].i + 1, an[k].i);
    }
    pushRun(an[an.length - 1].i + 1, A.length);
    let repeats = 0;
    while (runs.length && passes.length < MAX_PASSES) {
      const [a, b] = runs.shift();
      const loc = alignLocal(A, a, b, B);
      if (!loc) continue;
      const eqN = loc.filter((x) => x.eq).length;
      if (eqN < Math.max(8, 0.45 * Math.min(b - a, loc.length))) continue;
      const p = mkPass(loc, false);
      if (!p) continue;
      passes.push(p); repeats++;
      pushRun(a, p.a0); pushRun(p.a1, b);
    }
    // อัตราตรง = หน่วยเนื้อผู้ใช้ที่มีคู่ตรงอย่างน้อยหนึ่งครั้ง
    const hit = new Uint8Array(B.length);
    passes.forEach((p) => p.anchors.forEach((x) => { hit[x.j] = 1; }));
    let h = 0; for (let k = 0; k < hit.length; k++) h += hit[k];
    return { passes, match: B.length ? h / B.length : 0, repeats };
  }

  // แปลงตำแหน่งขอบ (ก่อนหน่วย x) ข้าม stream ด้วย anchors ของ pass — ระหว่าง anchor ใช้เส้นตรง นอกช่วงต่อเส้นความชัน 1
  function interp(an, keyIn, keyOut, x) {
    const N = an.length;
    if (x <= an[0][keyIn]) return an[0][keyOut] - (an[0][keyIn] - x);
    if (x >= an[N - 1][keyIn] + 1) return an[N - 1][keyOut] + 1 + (x - an[N - 1][keyIn] - 1);
    let lo = 0, hi = N - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (an[mid][keyIn] <= x) lo = mid; else hi = mid; }
    const p = an[lo], q = an[hi];
    if (x <= p[keyIn]) return p[keyOut];
    // ขอบ x อยู่ระหว่าง p และ q (ขอบหลัง p = p+1)
    const spanIn = q[keyIn] - p[keyIn], spanOut = q[keyOut] - p[keyOut];
    if (spanIn <= 0) return q[keyOut];
    return p[keyOut] + ((x - p[keyIn]) / spanIn) * spanOut;
  }
  // ตำแหน่งคอร์ด: ขอบ AI x → ขอบในเนื้อผู้ใช้ · ถ้าตรงนั้นเนื้อผู้ใช้มีพยางค์ที่ AI ไม่ได้ยิน (คำหาย)
  // คอร์ดไปเกาะ "ต้นช่อง" = ต่อจากพยางค์ล่าสุดที่ตรงกัน (เสียงที่ร้องถัดมาจริงคือคำที่หายนั้น)
  function chordA2B(p, x) {
    const an = p.anchors, N = an.length;
    if (x <= an[0].i) return Math.max(0, an[0].j - (an[0].i - x));
    if (x > an[N - 1].i) return an[N - 1].j + 1 + (x - an[N - 1].i - 1);
    let lo = 0, hi = N - 1; // an[lo].i < x <= an[hi].i
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (an[mid].i < x) lo = mid; else hi = mid; }
    const P = an[lo], Q = an[hi];
    return P.j + 1 + Math.min(x - P.i - 1, Q.j - P.j - 1);
  }
  const b2a = (p, y) => interp(p.anchors, 'j', 'i', y);
  // pass ที่ครอบหน่วย AI ตำแหน่ง i (ท่อนซ้ำมาก่อน global)
  function passOfA(passes, i) {
    for (let k = passes.length - 1; k >= 1; k--) if (i >= passes[k].a0 && i < passes[k].a1) return passes[k];
    return passes[0];
  }
  // บรรทัดเนื้อผู้ใช้ที่ pass ใช้: global = ทุกบรรทัด, ท่อนซ้ำ = บรรทัดที่หน่วยส่วนใหญ่อยู่ในช่วง b0..b1
  function linesOfPass(p, SB) {
    const out = [];
    SB.lineStart.forEach((s, u) => {
      const e = SB.lineEnd[u];
      if (e <= s) return;
      if (p.primary) { out.push(u); return; }
      const ov = Math.min(e, p.b1) - Math.max(s, p.b0);
      if (ov >= 0.5 * (e - s)) out.push(u);
    });
    return out;
  }

  /* ---------------- เส้นทางที่ 1: chunk ของ Whisper (มีเวลา) ---------------- */
  function alignToChunks(text, chunks, opts) {
    opts = opts || {};
    const duration = +opts.duration || 0;
    const lines = cleanUserLyrics(text);
    const src = (chunks || []).filter((c) => c && String(c.text || '').trim());
    if (!lines.length) return { chunks: [], match: 0, lines: 0, repeats: 0 };
    if (!src.length) return { chunks: [], match: 0, lines: lines.length, repeats: 0 };
    const SA = buildStream(src.map((c) => String(c.text)));
    const SB = buildStream(lines);
    if (!SA.n || !SB.n) return { chunks: [], match: 0, lines: lines.length, repeats: 0 };
    // เวลาขอบหน่วย AI: ภายใน chunk กระจายเท่า ๆ กัน
    const tB = new Float64Array(SA.n + 1);
    src.forEach((c, k) => {
      const s = SA.lineStart[k], e = SA.lineEnd[k];
      const t0 = +c.t0 || 0;
      const t1 = c.t1 != null && +c.t1 > t0 ? +c.t1 : t0 + Math.max(1, (e - s) * 0.18);
      for (let x = s; x < e; x++) tB[x] = t0 + ((x - s) / Math.max(1, e - s)) * (t1 - t0);
      tB[e] = t1;
    });
    const unitDur = (() => {
      let tot = 0, cnt = 0;
      src.forEach((c, k) => { const n = SA.lineEnd[k] - SA.lineStart[k]; if (n > 0 && c.t1 > c.t0) { tot += c.t1 - c.t0; cnt += n; } });
      return cnt ? Math.min(0.6, Math.max(0.08, tot / cnt)) : 0.2;
    })();
    const timeAt = (x) => {
      if (x <= 0) return Math.max(0, tB[0] + x * unitDur);
      if (x >= SA.n) return tB[SA.n] + (x - SA.n) * unitDur;
      const i = Math.floor(x), f = x - i;
      return tB[i] + f * (tB[i + 1] - tB[i]);
    };
    const R = alignAll(SA, SB);
    if (!R.passes.length) return { chunks: [], match: 0, lines: lines.length, repeats: 0 };
    const out = [];
    R.passes.forEach((p) => {
      linesOfPass(p, SB).forEach((u) => {
        const s = SB.lineStart[u], e = SB.lineEnd[u];
        if (p.primary && R.passes.length > 1 && passOfA(R.passes, Math.max(0, Math.min(SA.n - 1, Math.round(b2a(p, s))))) !== p) return;
        let t0 = timeAt(b2a(p, s)), t1 = timeAt(b2a(p, e));
        if (!(t1 > t0)) t1 = t0 + (e - s) * unitDur;
        out.push({ t0, t1, text: lines[u], u, primary: p.primary });
      });
    });
    out.sort((x, y) => x.t0 - y.t0 || x.u - y.u);
    // ไม่ซ้อนกัน · ยาวอย่างน้อย 0.4s · อยู่ในเพลง
    const res = [];
    out.forEach((c) => {
      const prev = res[res.length - 1];
      let t0 = Math.max(0, c.t0);
      if (prev && t0 < prev.t0 + 0.2) t0 = prev.t0 + 0.2;
      if (prev && prev.t1 > t0) prev.t1 = Math.max(prev.t0 + 0.2, t0);
      let t1 = Math.max(c.t1, t0 + 0.4);
      if (duration) { t0 = Math.min(t0, Math.max(0, duration - 0.2)); t1 = Math.min(t1, duration); if (t1 <= t0) t1 = t0 + 0.2; }
      res.push({ t0: r2(t0), t1: r2(t1), text: c.text });
    });
    return { chunks: res, match: r2(R.match), lines: lines.length, repeats: R.repeats };
  }
  const r2 = (x) => Math.round(x * 100) / 100;

  /* ---------------- เส้นทางสำรอง: ไม่มีผลถอดเสียง → กระจายตามช่วงที่มีเสียงร้อง ---------------- */
  function voicedRegions(pcm, sr) {
    if (!pcm || !pcm.length || !sr) return [];
    const hop = Math.round(sr * 0.05), n = Math.floor(pcm.length / hop);
    if (n < 4) return [];
    const env = new Float32Array(n);
    for (let k = 0; k < n; k++) { let s = 0; for (let x = k * hop; x < (k + 1) * hop; x++) s += pcm[x] * pcm[x]; env[k] = Math.sqrt(s / hop); }
    const sorted = Float32Array.from(env).sort();
    const floor = sorted[Math.floor(n * 0.2)], p95 = sorted[Math.floor(n * 0.95)];
    const th = Math.max(floor * 2.5, p95 * 0.12, 1e-4);
    const regs = [];
    let st = -1, quiet = 0;
    for (let k = 0; k <= n; k++) {
      const on = k < n && env[k] > th;
      if (on) { if (st < 0) st = k; quiet = 0; }
      else if (st >= 0 && (++quiet >= 8 || k === n)) { const e = k - quiet + 1; if ((e - st) * 0.05 >= 0.6) regs.push({ t0: r2(st * 0.05), t1: r2(e * 0.05) }); st = -1; quiet = 0; }
    }
    return regs;
  }
  function spreadLines(text, regions) {
    const lines = cleanUserLyrics(text);
    const regs = (regions || []).filter((r) => r.t1 > r.t0);
    if (!lines.length || !regs.length) return { chunks: [], match: 0, lines: lines.length, rough: true };
    const w = lines.map((l) => Math.max(1, graphemes(l).length));
    const W = w.reduce((a, b) => a + b, 0);
    const total = regs.reduce((a, r) => a + (r.t1 - r.t0), 0);
    // ตำแหน่งบนเส้นเวลาที่ "มีเสียงร้อง" ต่อกัน → เวลาจริง
    const at = (v) => {
      for (const r of regs) { const d = r.t1 - r.t0; if (v <= d) return r.t0 + v; v -= d; }
      return regs[regs.length - 1].t1;
    };
    const out = [];
    let acc = 0;
    lines.forEach((l, k) => {
      const a = (acc / W) * total; acc += w[k];
      const b = (acc / W) * total;
      out.push({ t0: r2(at(a)), t1: r2(Math.max(at(a) + 0.4, at(b - 0.01))), text: l });
    });
    return { chunks: out, match: 0, lines: lines.length, rough: true };
  }

  /* ---------------- เส้นทางที่ 2: เขียนชีต ChordPro เดิมใหม่ด้วยเนื้อผู้ใช้ ---------------- */
  const DIRECTIVE = /^\s*\{.*\}\s*$/;
  const CHORD_TOKEN = /\[([^\]]+)\]/g;
  // บรรทัดกริดคอร์ด: เอาคอร์ด/| /(×n) ออกแล้วไม่เหลืออะไร
  const isGridLine = (s) => !s.replace(CHORD_TOKEN, '').replace(/[|\s]+/g, '').replace(/\(?[x×]\d+\)?/gi, '').replace(/[-–—.:]+/g, '');
  function classify(chordpro) {
    return String(chordpro || '').split(/\r?\n/).map((raw) => {
      if (!raw.trim()) return { type: 'blank', raw };
      if (DIRECTIVE.test(raw)) return { type: 'dir', raw };
      if (isGridLine(raw)) return { type: 'grid', raw };
      // บรรทัดเนื้อ: แยกข้อความกับคอร์ด (ตำแหน่งคอร์ด = ก่อน grapheme ที่ pos)
      const chords = [];
      let text = '', last = 0, m;
      CHORD_TOKEN.lastIndex = 0;
      while ((m = CHORD_TOKEN.exec(raw)) !== null) {
        text += raw.slice(last, m.index);
        chords.push({ pos: graphemes(text).length, chord: m[1] });
        last = CHORD_TOKEN.lastIndex;
      }
      text += raw.slice(last);
      return { type: 'lyric', raw, text, chords };
    });
  }
  function lyricLineCount(chordpro) {
    return classify(chordpro).filter((l) => l.type === 'lyric' && /[\p{L}\p{N}]/u.test(l.text)).length;
  }

  function rewriteChordPro(chordpro, text, opts) {
    opts = opts || {};
    const rows = classify(chordpro);
    const lyr = rows.filter((r) => r.type === 'lyric' && /[\p{L}\p{N}]/u.test(r.text));
    const lines = cleanUserLyrics(text);
    if (!lyr.length || !lines.length) return null;
    const SA = buildStream(lyr.map((r) => r.text));
    const SB = buildStream(lines);
    if (!SA.n || !SB.n) return null;
    const R = alignAll(SA, SB);
    if (!R.passes.length) return null;
    const lyrIdx = new Map(lyr.map((r, k) => [r, k]));

    // 1) สำเนาบรรทัดผู้ใช้ต่อ pass → บรรทัดเดิมที่เป็นเจ้าของ (ตามตำแหน่งต้นบรรทัด)
    const copies = []; // {u, p, k (บรรทัดเนื้อเดิม), aPos, chords:Map(pos→[chord])}
    R.passes.forEach((p) => {
      linesOfPass(p, SB).forEach((u) => {
        const s = SB.lineStart[u];
        const aPos = Math.max(0, Math.min(SA.n - 1, Math.round(b2a(p, s))));
        copies.push({ u, p, k: SA.line[aPos], aPos, chords: new Map() });
      });
    });
    // global: บรรทัดผู้ใช้ที่ตกในช่วงที่ท่อนซ้ำครอง ให้ท่อนซ้ำเป็นเจ้าของแทน (กันซ้ำสองชุด)
    const own = copies.filter((c) => c.p.primary ? passOfA(R.passes, c.aPos) === c.p : true);

    // 2) ย้ายคอร์ด: ขอบ AI → pass ที่ครอบ → ขอบผู้ใช้ → สำเนาบรรทัดของ pass นั้น
    const orphan = new Map(); // k → [chord] ที่วางไม่ได้ (คงไว้เป็นบรรทัดคอร์ดล้วน)
    lyr.forEach((r, k) => {
      const s = SA.lineStart[k], e = SA.lineEnd[k];
      const G = SA.lineG[k].length;
      r.chords.forEach((c) => {
        // หน่วย AI แรกที่ grapheme ≥ pos (ท้ายบรรทัด → ขอบหลังหน่วยสุดท้าย)
        let x = e;
        for (let q = s; q < e; q++) if (SA.gi[q] >= c.pos) { x = q; break; }
        const atEnd = c.pos >= G || x === e;
        const p = passOfA(R.passes, Math.max(s, Math.min(e - 1, atEnd ? e - 1 : x)));
        let y = chordA2B(p, atEnd ? e : x);
        const cands = own.filter((o) => o.p === p);
        if (!cands.length) { (orphan.get(k) || orphan.set(k, []).get(k)).push(c.chord); return; }
        // ต้นบรรทัดเดิม → ยึดต้นบรรทัดผู้ใช้ที่ใกล้ (±3 หน่วย)
        if (c.pos === 0) {
          let bestU = null, bd = 4;
          cands.forEach((o) => { const d = Math.abs(SB.lineStart[o.u] - y); if (d < bd) { bd = d; bestU = o; } });
          if (bestU) { addChord(bestU, 0, c.chord); return; }
        }
        y = Math.round(y);
        let tgt = null;
        for (const o of cands) { if (y >= SB.lineStart[o.u] && y < SB.lineEnd[o.u]) { tgt = o; break; } }
        if (tgt) { addChord(tgt, SB.gi[y], c.chord); return; }
        // ตกท้ายบรรทัด/ช่องว่างระหว่างบรรทัด → ท้ายบรรทัดผู้ใช้ก่อนหน้า หรือต้นบรรทัดถัดไป
        let before = null, after = null;
        cands.forEach((o) => {
          if (SB.lineEnd[o.u] <= y && (!before || SB.lineEnd[o.u] > SB.lineEnd[before.u])) before = o;
          if (SB.lineStart[o.u] >= y && (!after || SB.lineStart[o.u] < SB.lineStart[after.u])) after = o;
        });
        if (atEnd && before) addChord(before, SB.lineG[before.u].length, c.chord);
        else if (after) addChord(after, 0, c.chord);
        else if (before) addChord(before, SB.lineG[before.u].length, c.chord);
        else (orphan.get(k) || orphan.set(k, []).get(k)).push(c.chord);
      });
    });
    function addChord(o, pos, chord) {
      const list = o.chords.get(pos) || [];
      if (list[list.length - 1] !== chord) list.push(chord);
      o.chords.set(pos, list);
    }
    const render = (o) => {
      const g = SB.lineG[o.u];
      let s = '';
      for (let i = 0; i <= g.length; i++) {
        const cs = o.chords.get(i);
        if (cs) s += cs.map((c) => '[' + c + ']').join('');
        if (i < g.length) s += g[i];
      }
      return s;
    };
    // 3) ประกอบชีต: บรรทัดที่ไม่ใช่เนื้อคงเดิม · บรรทัดเนื้อเดิม k → บรรทัดผู้ใช้ของกลุ่ม k
    const byK = new Map();
    own.forEach((o) => { (byK.get(o.k) || byK.set(o.k, []).get(o.k)).push(o); });
    byK.forEach((list) => list.sort((a, b) => a.aPos - b.aPos || a.u - b.u));
    const out = [];
    rows.forEach((r) => {
      if (r.type !== 'lyric' || !lyrIdx.has(r)) {
        if (r.type === 'dir' && opts.replaceNote && opts.replaceNote[0] && r.raw.includes(opts.replaceNote[0])) { out.push(r.raw.replace(opts.replaceNote[0], opts.replaceNote[1])); return; }
        out.push(r.raw); return;
      }
      const k = lyrIdx.get(r);
      const list = byK.get(k) || [];
      list.forEach((o) => out.push(render(o)));
      const orph = orphan.get(k);
      if (orph && orph.length) out.push(orph.map((c) => '[' + c + ']').join(' '));
    });
    // บรรทัดว่างติดกันเกิน 1 → ยุบ
    const clean = [];
    out.forEach((l) => { if (!l.trim() && clean.length && !clean[clean.length - 1].trim()) return; clean.push(l); });
    return { chordpro: clean.join('\n'), match: r2(R.match), lines: lines.length, repeats: R.repeats };
  }

  return {
    MAX_TEXT, cleanUserLyrics, alignToChunks, spreadLines, voicedRegions, lyricLineCount, rewriteChordPro,
    _test: { unitCodes, buildStream, alignGlobal, alignLocal, alignAll, graphemes, classify },
  };
});
