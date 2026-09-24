/* transcription.js — แปลงผลถอดเพลงจากเซิร์ฟเวอร์ GPU (TranscriptionResult v1 — docs/09 §4)
   เป็น SongDoc v2 (docs/09 §5): ChordPro ที่วางคอร์ดตรงขอบพยางค์, timeline, analysis, melody
   ข้อมูลมาจากเน็ตเวิร์ก → ตรวจ/ทำความสะอาดทุก field ก่อนใช้ (ตัวเลขต้อง finite, เรียงเวลา,
   label คอร์ดผ่าน Music.parseChord + whitelist) ไม่แตะ DOM — เทสต์ใน Node ได้ (tools/test-transcription.cjs)
   แนวคิดประกอบ ChordPro ยืมจาก analyze.js/dsp.js (grapheme ไทย, กริดห้อง, ×n, ⏱)
   แต่คัดลอก logic มาไว้ที่นี่ ไม่ผูกกับเอนจินในเครื่อง */
(function () {
  'use strict';

  const FORMAT = 'aquachord-transcription';
  const VERSION = 1;
  const CREATOR = 'AquaChord AI (GPU)';
  const MAX_DURATION = 3600;          // วินาที (node ตัดที่ 600 อยู่แล้ว — เผื่อไว้)
  const LIM = {
    beats: 20000, chords: 5000, sections: 200, lines: 2000, syls: 400,
    notes: 20000, warnings: 60, lyricsText: 20000, lineText: 500, bars: 4000,
  };
  const MAX_LINE_G = 48;              // grapheme ต่อบรรทัด — ยาวกว่านี้ตัดที่ขอบพยางค์
  const DUR_SET = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25]; // ความยาวโน้ตที่ใช้ได้ (docs/09 §5)

  /* ---------------- คำแปลของโมดูลนี้ ---------------- */
  const I18 = (typeof I18N !== 'undefined') ? I18N : null;
  if (I18 && I18.extend) {
    I18.extend({
      th: {
        'gpu.sheet.header': 'ถอดด้วย AI บนเซิร์ฟเวอร์ (GPU)',
        'gpu.sheet.lyricsUser': 'เนื้อร้องจากที่วางไว้ · AI จัดเวลาและวางคอร์ดให้ — ตำแหน่งอาจคลาดเคลื่อน แก้ไขได้ในหน้า Editor',
        'gpu.sheet.lyricsAsr': 'เนื้อร้องถอดโดย AI — คำและตำแหน่งคอร์ดอาจผิด แก้ไขได้ในหน้า Editor',
        'gpu.sheet.lyricsUntimed': '🎤 เนื้อร้อง (AI จัดเวลาไม่สำเร็จ — ยังไม่ได้วางคอร์ด)',
        'gpu.sheet.nonCommercial': 'ใช้โมเดล SheetSage2 (CC-BY-NC) — สำหรับใช้ส่วนตัว/การศึกษาเท่านั้น',
        'gpu.melody.name': 'ทำนองร้อง',
      },
      en: {
        'gpu.sheet.header': 'transcribed by server AI (GPU)',
        'gpu.sheet.lyricsUser': 'Lyrics as pasted · timing and chord placement by AI — may be off; fix in the Editor',
        'gpu.sheet.lyricsAsr': 'Lyrics transcribed by AI — words and chord placement may be wrong; fix in the Editor',
        'gpu.sheet.lyricsUntimed': '🎤 Lyrics (AI could not align them — chords not placed)',
        'gpu.sheet.nonCommercial': 'Made with the SheetSage2 model (CC-BY-NC) — personal/educational use only',
        'gpu.melody.name': 'Vocal melody',
      },
    });
  }
  const t = (k) => (I18 ? I18.t(k) : k);

  function mkErr(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

  /* ---------------- utils ---------------- */
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const r2 = (x) => Math.round(x * 100) / 100;
  const q4 = (x) => Math.round(x * 4) / 4;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;
  const BIDI = /[\u202A-\u202E\u2066-\u2069]/g; // กันข้อความสลับทิศหลอกตา

  // ข้อความหลายบรรทัด (lyricsText) — เก็บ \n ไว้
  function cleanText(s, max) {
    if (typeof s !== 'string') return '';
    return s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CTRL, '').replace(BIDI, '')
      .replace(/[ ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  }
  // ข้อความบรรทัดเดียวที่จะลง ChordPro — [ ] { } ใช้ไม่ได้ (parser จะตีเป็นคอร์ด/directive)
  function cleanLine(s, max) {
    if (typeof s !== 'string') return '';
    return s.replace(CTRL, '').replace(BIDI, '').replace(/[\r\n\t]+/g, ' ')
      .replace(/[[{]/g, '(').replace(/[\]}]/g, ')')
      .replace(/\s{2,}/g, ' ').trim().slice(0, max || LIM.lineText);
  }

  function prettyTitle(name) {
    return (name || '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  function baseName(name) {
    if (typeof name !== 'string') return '';
    const b = name.split(/[\\/]/).pop() || '';
    return b.replace(CTRL, '').replace(BIDI, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  }

  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  /* ---------------- grapheme ไทย (ห้ามแทรกคอร์ดคั่นสระ/วรรณยุกต์) ---------------- */
  let segmenter = null;
  const COMB = /[\u0300-\u036F\u0E31\u0E33-\u0E3A\u0E47-\u0E4E\u200D\uFE0F]/;
  const LEADING = /[\u0E40-\u0E44]/; // เ แ โ ใ ไ — เขียนก่อนพยัญชนะแต่ออกเสียงทีหลัง ต้องติดพยัญชนะตัวถัดไป
  function graphemes(s) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      if (!segmenter) segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' });
      return Array.from(segmenter.segment(s), (x) => x.segment);
    }
    const out = [];
    for (const ch of s) {
      if (out.length && COMB.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }
  // offset (UTF-16) ของขอบ grapheme ทุกจุด
  function boundaries(text) {
    const b = [0];
    let o = 0;
    for (const g of graphemes(text)) { o += g.length; b.push(o); }
    return b;
  }
  // เลื่อน offset ให้ตกขอบ grapheme (ถอยหลัง) + ไม่ตามหลังสระหน้า
  function snap(text, bounds, off) {
    off = clamp(off | 0, 0, text.length);
    if (bounds.indexOf(off) < 0) {
      let best = 0;
      for (const b of bounds) { if (b <= off) best = b; else break; }
      off = best;
    }
    while (off > 0 && LEADING.test(text[off - 1])) off -= 1;
    return off;
  }

  /* ---------------- คอร์ด: grammar docs/04 §3 (+ ชนิดที่ Music เล่นเสียงได้) ---------------- */
  const QUAL_OK = ['', 'm', '5', '6', 'm6', '7', 'maj7', 'm7', 'm7b5', 'dim', 'dim7', 'aug',
    'sus2', 'sus4', '7sus4', '9', 'maj9', 'm9', 'add9', '11', '13'];
  // สะกดต่างแต่ความหมายเดียวกัน (ไม่เตือน)
  const QUAL_ALIAS = {
    maj: '', M: '', min: 'm', mi: 'm', '-': 'm', M7: 'maj7', Maj7: 'maj7', ma7: 'maj7',
    min7: 'm7', mi7: 'm7', '-7': 'm7', '+': 'aug', sus: 'sus4', hdim7: 'm7b5', hdim: 'm7b5',
    'ø': 'm7b5', 'ø7': 'm7b5', o: 'dim', o7: 'dim7', '°': 'dim', '°7': 'dim7', min6: 'm6', maj6: '6',
    '7sus': '7sus4', min9: 'm9', maj9: 'maj9', add2: 'add9',
  };
  // ลดรูป (เตือน) — docs/09 §4: m(maj7) → m
  const QUAL_SIMPLIFY = { 'm(maj7)': 'm', mmaj7: 'm', mM7: 'm', minmaj7: 'm', 'min(maj7)': 'm' };
  const PCS = new Set(['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'Fb', 'F', 'E#', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'Cb']);
  const NC_RE = /^(N|NC|N\.C\.?|X|none|silence)$/i;

  // คืน {label} (null = N.C.) | {drop:true} + simplified
  function normChord(raw) {
    if (raw === null) return { label: null };
    if (typeof raw !== 'string') return { drop: true };
    const s = raw.trim();
    if (!s || NC_RE.test(s)) return { label: null };
    if (s.length > 24 || typeof Music === 'undefined') return { drop: true };
    const c = Music.parseChord(s);
    if (!c || !PCS.has(c.root)) return { drop: true };
    if (c.bass && !PCS.has(c.bass)) return { drop: true };
    let q = c.quality, simplified = false;
    if (QUAL_OK.indexOf(q) >= 0) { /* ok */ }
    else if (Object.prototype.hasOwnProperty.call(QUAL_ALIAS, q)) q = QUAL_ALIAS[q];
    else if (Object.prototype.hasOwnProperty.call(QUAL_SIMPLIFY, q)) { q = QUAL_SIMPLIFY[q]; simplified = true; }
    else {
      // ส่วนขยายที่ไม่รู้จัก → ตัดเหลือ prefix ที่รู้จักยาวที่สุด เช่น 7#9 → 7, maj7#11 → maj7
      let best = null;
      for (const k of QUAL_OK) if (k && q.indexOf(k) === 0 && (best === null || k.length > best.length)) best = k;
      if (best === null) return { drop: true };
      q = best; simplified = true;
    }
    return { label: c.root + q + (c.bass ? '/' + c.bass : ''), simplified };
  }

  function normKey(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.trim().match(/^([A-Ga-g])([#b♯♭]?)\s*:?\s*(m|min|minor|maj|major)?$/);
    if (!m) return null;
    const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
    const root = m[1].toUpperCase() + acc;
    if (!PCS.has(root)) return null;
    const minor = !!m[3] && /^m(in(or)?)?$/.test(m[3]);
    return root + (minor ? 'm' : '');
  }

  /* ---------------- ตรวจ + ทำความสะอาดผลจากเซิร์ฟเวอร์ ---------------- */
  function cleanTimes(raw, dur, cap, name, warn) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) { warn(name + ': not an array'); return []; }
    let bad = 0, unsorted = false;
    const arr = [];
    const src = raw.length > cap ? raw.slice(0, cap) : raw;
    if (raw.length > cap) warn(name + ': truncated to ' + cap);
    for (const x of src) {
      if (!isNum(x) || x < 0 || x > dur + 1) { bad++; continue; }
      if (arr.length && x < arr[arr.length - 1]) unsorted = true;
      arr.push(x);
    }
    if (bad) warn(name + ': dropped ' + bad + ' invalid value(s)');
    if (unsorted) { arr.sort((a, b) => a - b); warn(name + ': unsorted input was sorted'); }
    const out = [];
    for (const x of arr) if (!out.length || x - out[out.length - 1] >= 0.02) out.push(x);
    return out;
  }

  function cleanChords(raw, dur, warn) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) { warn('chords: not an array'); return []; }
    if (raw.length > LIM.chords) warn('chords: truncated to ' + LIM.chords);
    let bad = 0, unsorted = false, overlap = 0;
    const unknown = new Set(), simplified = new Set();
    const list = [];
    for (const c of raw.slice(0, LIM.chords)) {
      if (!c || typeof c !== 'object') { bad++; continue; }
      if (!isNum(c.t0) || !isNum(c.t1)) { bad++; continue; }
      const t0 = Math.max(0, c.t0), t1 = Math.min(dur, c.t1);
      if (t1 - t0 < 0.01) { bad++; continue; }
      const n = normChord(c.label === undefined ? null : c.label);
      if (n.drop) { unknown.add(String(c.label).slice(0, 16)); continue; }
      if (n.simplified) simplified.add(String(c.label).slice(0, 16) + '→' + n.label);
      if (list.length && t0 < list[list.length - 1].t0) unsorted = true;
      list.push({ t0, t1, label: n.label, conf: isNum(c.conf) ? clamp(c.conf, 0, 1) : null });
    }
    if (bad) warn('chords: dropped ' + bad + ' invalid segment(s)');
    if (unknown.size) warn('chords: dropped unknown label(s) ' + Array.from(unknown).slice(0, 8).join(', '));
    if (simplified.size) warn('chords: simplified ' + Array.from(simplified).slice(0, 8).join(', '));
    if (unsorted) { list.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1); warn('chords: unsorted input was sorted'); }
    const out = [];
    for (const s of list) {
      let prev = out[out.length - 1];
      if (prev && s.t0 < prev.t1) {
        overlap++;
        prev.t1 = s.t0;
        if (prev.t1 - prev.t0 < 0.01) { out.pop(); prev = out[out.length - 1]; }
      }
      if (prev && prev.label === s.label && s.t0 - prev.t1 < 0.05) { prev.t1 = Math.max(prev.t1, s.t1); continue; }
      out.push({ t0: s.t0, t1: s.t1, label: s.label, conf: s.conf });
    }
    if (overlap) warn('chords: fixed ' + overlap + ' overlap(s)');
    return out;
  }

  const SECTION_NAMES = {
    intro: 'Intro', verse: 'Verse', chorus: 'Chorus', refrain: 'Chorus', hook: 'Chorus', bridge: 'Bridge',
    outro: 'Outro', ending: 'Outro', coda: 'Outro', solo: 'Solo', inst: 'Instrumental', instrumental: 'Instrumental',
    interlude: 'Interlude', break: 'Break', prechorus: 'Pre-Chorus', 'pre-chorus': 'Pre-Chorus', pre_chorus: 'Pre-Chorus',
    postchorus: 'Post-Chorus', 'post-chorus': 'Post-Chorus',
  };
  function sectionDisplay(label) {
    const s = label.toLowerCase().replace(/\s+/g, '');
    const m = s.match(/^([a-z_-]+?)(\d*)$/);
    if (m && SECTION_NAMES[m[1]]) return SECTION_NAMES[m[1]] + (m[2] ? ' ' + m[2] : '');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function cleanSections(raw, dur, warn) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) { warn('sections: not an array'); return []; }
    let bad = 0;
    const out = [];
    for (const s of raw.slice(0, LIM.sections)) {
      if (!s || typeof s !== 'object' || !isNum(s.t) || s.t < 0 || s.t > dur + 1) { bad++; continue; }
      const label = cleanLine(s.label, 40);
      if (!label) { bad++; continue; }
      out.push({ t: s.t, label });
    }
    if (bad) warn('sections: dropped ' + bad + ' invalid item(s)');
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  const THAI = /[\u0E00-\u0E7F]/;
  function cleanLyrics(raw, dur, warn) {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) { warn('lyrics: not an object'); return null; }
    const source = raw.source === 'user' ? 'user' : 'asr';
    const language = typeof raw.language === 'string' && /^[a-z]{2,3}$/.test(raw.language) ? raw.language : '';
    const text = cleanText(raw.text, LIM.lyricsText);
    const lines = [];
    let bad = 0, untimed = 0;
    const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
    if (raw.lines != null && !Array.isArray(raw.lines)) warn('lyrics: lines is not an array');
    if (rawLines.length > LIM.lines) warn('lyrics: truncated to ' + LIM.lines + ' lines');
    for (const ln of rawLines.slice(0, LIM.lines)) {
      if (!ln || typeof ln !== 'object') { bad++; continue; }
      const syls = [];
      if (Array.isArray(ln.syllables)) {
        for (const s of ln.syllables.slice(0, LIM.syls)) {
          if (!s || typeof s !== 'object' || !isNum(s.t0) || !isNum(s.t1)) continue;
          const st = cleanLine(s.text, 60).replace(/\s+/g, '');
          if (!st) continue;
          const t0 = clamp(s.t0, 0, dur), t1 = clamp(Math.max(s.t1, s.t0 + 0.02), 0, dur + 1);
          syls.push({ t0, t1, text: st });
        }
        syls.sort((a, b) => a.t0 - b.t0);
      }
      let lt = cleanLine(ln.text, LIM.lineText);
      if (!lt && syls.length) {
        const thai = syls.some((s) => THAI.test(s.text));
        lt = cleanLine(syls.map((s) => s.text).join(thai ? '' : ' '), LIM.lineText);
      }
      if (!lt) { bad++; continue; }
      let t0 = isNum(ln.t0) ? ln.t0 : (syls.length ? syls[0].t0 : NaN);
      let t1 = isNum(ln.t1) ? ln.t1 : (syls.length ? syls[syls.length - 1].t1 : NaN);
      if (!isNum(t0) || t0 < 0 || t0 > dur + 1) { untimed++; continue; }
      if (!isNum(t1) || t1 <= t0) t1 = syls.length ? Math.max(t0 + 0.5, syls[syls.length - 1].t1) : t0 + 3;
      lines.push({ t0, t1: Math.min(t1, dur + 1), text: lt, syls });
    }
    if (bad) warn('lyrics: dropped ' + bad + ' empty/invalid line(s)');
    if (untimed) warn('lyrics: ' + untimed + ' line(s) without timing');
    lines.sort((a, b) => a.t0 - b.t0);
    const fullText = text || lines.map((l) => l.text).join('\n');
    if (!fullText && !lines.length) return null;
    return { source, language, text: fullText, lines, untimed };
  }

  function cleanNotes(raw, dur, warn) {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) { warn('melody: not an object'); return null; }
    const src = Array.isArray(raw.notes) ? raw.notes : [];
    if (src.length > LIM.notes) warn('melody: truncated to ' + LIM.notes + ' notes');
    let bad = 0;
    const notes = [];
    for (const n of src.slice(0, LIM.notes)) {
      if (!n || typeof n !== 'object' || !isNum(n.t0) || !isNum(n.t1) || !isNum(n.pitch)) { bad++; continue; }
      const p = Math.round(n.pitch);
      if (p < 0 || p > 127 || n.t0 < 0 || n.t0 > dur || n.t1 <= n.t0) { bad++; continue; }
      notes.push({ s0: n.t0, s1: Math.min(n.t1, dur + 1), p, conf: isNum(n.conf) ? clamp(n.conf, 0, 1) : 0.5 });
    }
    if (bad) warn('melody: dropped ' + bad + ' invalid note(s)');
    notes.sort((a, b) => a.s0 - b.s0);
    const source = raw.source === 'sheetsage2' ? 'sheetsage2' : 'fcpe';
    return { source, notes };
  }

  function medianDiff(arr) {
    if (arr.length < 2) return null;
    const d = [];
    for (let i = 1; i < arr.length; i++) d.push(arr[i] - arr[i - 1]);
    d.sort((a, b) => a - b);
    return d[d.length >> 1];
  }

  /* ตรวจทั้งก้อน → โครงสะอาดที่ใช้ต่อได้ปลอดภัย
     โยน Error{code:'format'|'version'} ถ้าไม่ใช่ผลของเราเลย — นอกนั้นซ่อมได้ + warnings */
  function normalize(result) {
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch (e) { throw mkErr('format', 'result is not JSON'); }
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw mkErr('format', 'result is not an object');
    if (result.format !== FORMAT) throw mkErr('format', 'unexpected format');
    if (result.version !== VERSION) throw mkErr('version', 'unsupported version');

    const warnings = [];
    const warn = (w) => { if (warnings.length < LIM.warnings) warnings.push(String(w).slice(0, 300)); };
    if (Array.isArray(result.warnings)) {
      result.warnings.slice(0, 30).forEach((w) => { const s = cleanLine(w, 300); if (s) warn(s); });
    }

    let dur = isNum(result.durationSec) && result.durationSec > 0 ? result.durationSec : NaN;
    if (!isNum(dur)) {
      // ไม่มีความยาว → ประมาณจากข้อมูลที่มี (ไม่ให้เลขประหลาดหลุดเข้ามา)
      let m = 0;
      const see = (x) => { if (isNum(x) && x > m && x <= MAX_DURATION) m = x; };
      (Array.isArray(result.chords) ? result.chords : []).forEach((c) => c && see(c.t1));
      (Array.isArray(result.beats) ? result.beats : []).forEach(see);
      dur = m > 0 ? m : 0;
      warn('durationSec: missing, estimated ' + r3(dur));
    }
    if (dur > MAX_DURATION) { warn('durationSec: clamped to ' + MAX_DURATION); dur = MAX_DURATION; }

    let timeSig = [4, 4];
    const ts = result.timeSig;
    if (Array.isArray(ts) && ts.length === 2 && Number.isInteger(ts[0]) && Number.isInteger(ts[1]) &&
        ts[0] >= 1 && ts[0] <= 16 && [1, 2, 4, 8, 16].indexOf(ts[1]) >= 0) timeSig = [ts[0], ts[1]];
    else if (ts != null) warn('timeSig: invalid, using 4/4');

    const beats = cleanTimes(result.beats, dur, LIM.beats, 'beats', warn);
    let downbeats = cleanTimes(result.downbeats, dur, LIM.beats, 'downbeats', warn);

    let tempo = isNum(result.tempo) && result.tempo >= 20 && result.tempo <= 400 ? result.tempo : NaN;
    if (!isNum(tempo)) {
      const md = medianDiff(beats);
      tempo = md && md > 0.15 && md < 3 ? 60 / md : 100;
      warn('tempo: invalid, using ' + Math.round(tempo));
    }
    if (!downbeats.length && beats.length) {
      downbeats = beats.filter((_, i) => i % timeSig[0] === 0);
    }

    const chords = cleanChords(result.chords, dur, warn);
    let key = normKey(result.key);
    if (!key) {
      if (result.key != null) warn('key: invalid label');
      key = keyFromChords(chords);
    }
    const mode = result.mode === 'open' || result.mode === 'sheetsage2' ? result.mode : null;
    if (!mode) warn('mode: missing/invalid');

    return {
      mode, durationSec: dur, tempo, timeSig, beats, downbeats, key, chords,
      sections: cleanSections(result.sections, dur, warn),
      lyrics: cleanLyrics(result.lyrics, dur, warn),
      melody: cleanNotes(result.melody, dur, warn),
      warnings,
    };
  }

  // คีย์สำรองเมื่อผลไม่มี/ผิด: คอร์ดที่เล่นนานที่สุด
  function keyFromChords(chords) {
    const tot = {};
    chords.forEach((c) => {
      if (!c.label) return;
      const pc = Music.parseChord(c.label);
      if (!pc) return;
      const minor = /^m(?!aj)/.test(pc.quality);
      const k = pc.root + (minor ? 'm' : '');
      tot[k] = (tot[k] || 0) + (c.t1 - c.t0);
    });
    let best = null;
    Object.keys(tot).forEach((k) => { if (!best || tot[k] > tot[best]) best = k; });
    return best;
  }

  /* ---------------- ห้อง/จังหวะ ---------------- */
  // ห้องครอบคลุม [a, b) จาก downbeats (+ เติมช่องโหว่/ต่อหัวท้ายด้วยความยาวห้องกลาง)
  function buildBars(r, a, b) {
    const num = r.timeSig[0];
    const spb = 60 / r.tempo;
    let D = r.downbeats.slice();
    let barLen = medianDiff(D);
    if (!barLen || barLen <= 0.2) barLen = num * spb;
    if (!D.length) D = [a];
    const starts = [];
    for (let i = 0; i < D.length; i++) {
      starts.push(D[i]);
      const next = D[i + 1];
      if (next != null && next - D[i] > barLen * 1.5) {
        const k = Math.round((next - D[i]) / barLen);
        for (let j = 1; j < k; j++) starts.push(D[i] + ((next - D[i]) * j) / k);
      }
    }
    // ต่อห้องถอยหลังเฉพาะเมื่อดนตรีเริ่มก่อน downbeat แรกเกินครึ่งห้อง (pickup สั้น ๆ ไม่ต้องมีห้องแยก)
    while (starts[0] - a > barLen * 0.5 && starts.length < LIM.bars) starts.unshift(starts[0] - barLen);
    while (starts[starts.length - 1] + barLen < b - spb * 0.5 && starts.length < LIM.bars) starts.push(starts[starts.length - 1] + barLen);
    const bars = [];
    let bi = 0;
    const B = r.beats;
    for (let i = 0; i < starts.length && bars.length < LIM.bars; i++) {
      const t0 = starts[i];
      const t1 = i + 1 < starts.length ? starts[i + 1] : t0 + barLen;
      if (t1 <= a || t0 >= b) continue;
      while (bi < B.length && B[bi] < t0 - 0.03) bi++;
      const beats = [];
      let j = bi;
      while (j < B.length && B[j] < t1 - 0.03) { beats.push(B[j]); j++; }
      if (!beats.length || beats.length > num * 2) {
        beats.length = 0;
        for (let k = 0; k < num; k++) beats.push(t0 + ((t1 - t0) * k) / num);
      }
      bars.push({ t0, t1, beats });
    }
    return bars;
  }

  function makeChordAt(chords) {
    const labeled = chords;
    return function chordAt(tm) {
      let lo = 0, hi = labeled.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (labeled[mid].t0 <= tm) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (ans < 0) return null;
      const s = labeled[ans];
      return tm < s.t1 ? s.label : null;
    };
  }

  function barTokens(bar, chordAt) {
    const tokens = [];
    for (let i = 0; i < bar.beats.length; i++) {
      const b0 = bar.beats[i], b1 = i + 1 < bar.beats.length ? bar.beats[i + 1] : bar.t1;
      const c = chordAt((b0 + b1) / 2) || 'N.C.';
      if (!tokens.length || tokens[tokens.length - 1] !== c) tokens.push(c);
    }
    return tokens;
  }

  /* ---------------- บรรทัดเนื้อร้อง: map พยางค์ → offset ในข้อความ ---------------- */
  function mapSyllables(line) {
    const text = line.text;
    const bounds = boundaries(text);
    const out = [];
    let cursor = 0, miss = 0;
    // เทียบแบบไม่สนตัวพิมพ์เฉพาะเมื่อ lowercase ไม่เปลี่ยนความยาว (offset ต้องตรงกับข้อความจริง)
    const lower = text.toLowerCase();
    const ci = lower.length === text.length;
    for (const s of line.syls) {
      const sl = s.text.toLowerCase();
      let idx = text.indexOf(s.text, cursor);
      if (idx < 0 && ci && sl.length === s.text.length) idx = lower.indexOf(sl, cursor);
      if (idx < 0) { miss++; continue; }
      out.push({ t0: s.t0, t1: s.t1, off: snap(text, bounds, idx), text: s.text });
      cursor = idx + s.text.length;
    }
    // map ได้น้อยกว่าครึ่ง = พยางค์ไม่ตรงกับข้อความ → ไม่ใช้ (ถอยไปใช้สัดส่วนเวลา)
    const ok = line.syls.length > 0 && out.length >= Math.ceil(line.syls.length / 2);
    return { text, bounds, syls: ok ? dedupOffsets(out) : [], miss };
  }
  function dedupOffsets(syls) {
    const out = [];
    for (const s of syls) {
      if (out.length && s.off <= out[out.length - 1].off) continue; // snap ชนกัน
      out.push(s);
    }
    return out;
  }

  // บรรทัดยาวเกิน → ตัดที่ขอบพยางค์ (หรือช่องว่าง) ใกล้กลางบรรทัด
  function splitLongLine(m, t0, t1) {
    const G = m.bounds.length - 1;
    if (G <= MAX_LINE_G) return [{ t0, t1, m }];
    const text = m.text;
    const mid = text.length / 2;
    let cut = -1, bestD = Infinity;
    for (let i = 1; i < m.bounds.length - 1; i++) {
      const o = m.bounds[i];
      if (text[o - 1] !== ' ' && text[o] !== ' ') continue;
      const d = Math.abs(o - mid);
      if (d < bestD) { bestD = d; cut = o; }
    }
    if (cut < 0) {
      for (const s of m.syls) { const d = Math.abs(s.off - mid); if (s.off > 0 && d < bestD) { bestD = d; cut = s.off; } }
    }
    if (cut < 0) cut = snap(text, m.bounds, Math.round(mid));
    if (cut <= 0 || cut >= text.length) return [{ t0, t1, m }];
    const leftT = text.slice(0, cut).replace(/\s+$/, ''), rightRaw = text.slice(cut);
    const rightT = rightRaw.replace(/^\s+/, '');
    const shift = cut + (rightRaw.length - rightT.length);
    const lSyl = m.syls.filter((s) => s.off < cut);
    const rSyl = m.syls.filter((s) => s.off >= shift).map((s) => Object.assign({}, s, { off: s.off - shift }));
    const tm = rSyl.length ? rSyl[0].t0 : t0 + (t1 - t0) * (cut / text.length);
    const mk = (tx, syls) => ({ text: tx, bounds: boundaries(tx), syls });
    return splitLongLine(mk(leftT, lSyl), t0, Math.max(t0, tm))
      .concat(splitLongLine(mk(rightT, rSyl), tm, t1));
  }

  // เวลา → offset ในบรรทัด: คอร์ดวาง "ก่อนพยางค์ที่กำลังร้องตอนคอร์ดเริ่ม"
  // (ถ้าเริ่มครึ่งหลังของพยางค์ยาว / ช่วงเว้น → พยางค์ถัดไป · เลยพยางค์สุดท้าย → ท้ายบรรทัด)
  function offsetAt(tm, ln) {
    const m = ln.m, text = m.text, syls = m.syls;
    if (syls.length) {
      if (tm <= syls[0].t0) return 0;
      for (let i = 0; i < syls.length; i++) {
        const s = syls[i], nx = syls[i + 1];
        const nextOff = nx ? nx.off : text.length;
        if (tm >= s.t0 && tm < s.t1) return (tm - s.t0) <= (s.t1 - s.t0) / 2 ? s.off : nextOff;
        if (tm >= s.t1 && (!nx || tm < nx.t0)) return nextOff;
      }
      return text.length;
    }
    // ไม่มีพยางค์ → สัดส่วนเวลาต่อ grapheme (แบบ analyze.js) แล้ว snap ขอบ
    const G = m.bounds.length - 1;
    const span = Math.max(0.001, ln.t1 - ln.t0);
    const gi = clamp(Math.round(((tm - ln.t0) / span) * G), 0, G);
    return snap(text, m.bounds, m.bounds[gi]);
  }

  function renderLyricLine(ln, events) {
    // events: [{off, label}] เรียงเวลา → ตำแหน่งเดียวกันกลางบรรทัดเก็บตัวท้าย (คอร์ดที่ดังตอนพยางค์นั้น)
    // ท้ายบรรทัดเก็บทุกตัว (คอร์ดช่วงเว้นระหว่างบรรทัด)
    const text = ln.m.text, L = text.length;
    const byOff = new Map();
    events.forEach((e) => {
      let off = e.off;
      if (off < L) off = snap(text, ln.m.bounds, off);
      const arr = byOff.get(off) || [];
      if (off < L) { arr.length = 0; arr.push(e.label); }
      else if (arr[arr.length - 1] !== e.label) arr.push(e.label);
      byOff.set(off, arr);
    });
    let out = '', last = 0, prev = null;
    Array.from(byOff.keys()).sort((a, b) => a - b).forEach((off) => {
      // ตัดคอร์ดซ้ำติดกันที่เกิดจากการยุบตำแหน่ง (เช่น C → G สั้น ๆ → C)
      const labels = byOff.get(off).filter((c) => { const keep = c !== prev; prev = c; return keep; });
      if (!labels.length) return;
      out += text.slice(last, off) + labels.map((c) => '[' + c + ']').join(off >= L ? ' ' : '');
      last = off;
    });
    return out + text.slice(last);
  }

  /* ---------------- ประกอบ ChordPro ---------------- */
  function header(title, key, tempo) {
    const bpm = Math.round(tempo);
    return `{title: ${title}}\n` + (key ? `{key: ${key}}\n` : '') + `{tempo: ${bpm}}\n\n` +
      `{c: 🚀 ${key ? 'Key ' + key + ' · ' : ''}${bpm} BPM · ${t('gpu.sheet.header')}}\n\n`;
  }

  function assemble(r, title) {
    const beatSec = 60 / r.tempo;
    const labeled = r.chords.filter((c) => c.label);
    const chordAt = makeChordAt(r.chords);
    const head = header(title, r.key, r.tempo);
    const lyr = r.lyrics;

    // บรรทัดเนื้อร้องที่มีเวลา → map พยางค์ + ตัดบรรทัดยาว
    let lines = [];
    if (lyr) {
      lyr.lines.forEach((l) => {
        const m = mapSyllables(l);
        lines = lines.concat(splitLongLine(m, l.t0, l.t1));
      });
      lines = lines.filter((l) => l.m.text);
    }

    const tail = [];
    if (lyr && lines.length) tail.push(`{c: 🎤 ${t(lyr.source === 'user' ? 'gpu.sheet.lyricsUser' : 'gpu.sheet.lyricsAsr')}}`);
    if (r.mode === 'sheetsage2') tail.push(`{c: ℹ ${t('gpu.sheet.nonCommercial')}}`);
    tail.push(`{c: ⚠ ${t('sheet.aiNote')}}`);
    // เนื้อร้องที่จัดเวลาไม่ได้ — ยังโชว์ข้อความให้ (ไม่ทิ้งเนื้อที่ผู้ใช้วาง)
    const untimedBlock = () => {
      if (!lyr || lines.length || !lyr.text) return '';
      const body = lyr.text.split('\n').map((s) => cleanLine(s)).join('\n').replace(/\n{3,}/g, '\n\n');
      return `{c: ${t('gpu.sheet.lyricsUntimed')}}\n${body}\n\n`;
    };

    if (!labeled.length && !lines.length) {
      return head + `{c: ${t('sheet.noChords')}}\n\n` + untimedBlock() + tail.join('\n') + '\n';
    }

    const musicStart = Math.min(labeled.length ? labeled[0].t0 : Infinity, lines.length ? lines[0].t0 : Infinity);
    const musicEnd = Math.max(labeled.length ? labeled[labeled.length - 1].t1 : 0, lines.length ? lines[lines.length - 1].t1 : 0);
    const bars = buildBars(r, musicStart, musicEnd);
    const barSec = bars.length ? (bars[bars.length - 1].t1 - bars[0].t0) / bars.length : beatSec * r.timeSig[0];
    const tol = Math.min(0.5, beatSec * 0.5);

    const out = [];
    let si = 0;
    let lastEmitted = null;   // คอร์ดตัวล่าสุดที่เขียนลงชีตแล้ว
    let sectionStart = true;  // ต้นท่อน → ย้ำคอร์ดแรกเสมอ
    const secs = r.sections;
    function pushLabel(text) {
      while (out.length && out[out.length - 1] === '') out.pop();
      if (out.length) out.push('');
      out.push(`{c: ${text}}`);
      sectionStart = true;
    }
    function sectionsUpTo(tm) {
      let any = false;
      while (si < secs.length && secs[si].t <= tm + tol) {
        const lab = sectionDisplay(secs[si++].label);
        if (out[out.length - 1] === `{c: ${lab}}`) continue;
        pushLabel(lab); any = true;
      }
      return any;
    }

    // ช่วงดนตรี (ไม่มีเนื้อ) → แถวคอร์ดละ 4 ห้อง (ห้องละตามจำนวน beat จริง) + ×n + ⏱
    // ห้องที่ทับช่วง [a, b) (รวมห้องที่ a ตกอยู่กลางห้อง เช่นอินโทรเริ่มก่อน downbeat)
    function emitGrid(a, b, stampEvery) {
      const bs = bars.filter((bar) => bar.t1 > a + tol && bar.t0 < b - tol);
      if (!bs.length) return;
      const items = [];
      let row = [], rowT = 0;
      const flush = () => { if (row.length) items.push({ type: 'row', t: rowT, text: row.join(' | ') }); row = []; };
      bs.forEach((bar) => {
        if (si < secs.length && secs[si].t <= bar.t0 + tol) {
          flush();
          while (si < secs.length && secs[si].t <= bar.t0 + tol) {
            const lab = sectionDisplay(secs[si++].label);
            const prev = items[items.length - 1];
            if (!(prev && prev.type === 'label' && prev.text === lab)) items.push({ type: 'label', text: lab });
          }
        }
        if (!row.length) rowT = bar.t0;
        row.push(barTokens(bar, chordAt).map((c) => '[' + c + ']').join(' '));
        if (row.length === 4) flush();
      });
      flush();
      if (!items.some((it) => it.type === 'row')) {
        items.forEach((it) => it.type === 'label' && pushLabel(it.text));
        return;
      }
      const lastOut = out[out.length - 1];
      if (out.length && lastOut !== '' && !/^\{c: /.test(lastOut)) out.push('');
      let rowNo = 0, stamped = false;
      for (let i = 0; i < items.length;) {
        const it = items[i];
        if (it.type === 'label') { pushLabel(it.text); stamped = false; i++; continue; }
        let n = 1;
        while (i + n < items.length && items[i + n].type === 'row' && items[i + n].text === it.text) n++;
        if (!stamped || (stampEvery && rowNo % stampEvery === 0)) { out.push(`{c: ⏱ ${fmtTime(it.t)}}`); stamped = true; }
        out.push(it.text + (n > 1 ? `   (×${n})` : ''));
        rowNo++;
        i += n;
      }
      out.push('');
      const lastRow = bs[bs.length - 1];
      lastEmitted = chordAt(Math.max(lastRow.t0, lastRow.t1 - 0.01));
      sectionStart = true; // เนื้อร้องหลังช่วงดนตรี = บล็อกใหม่ → ย้ำคอร์ดแรกให้อ่านง่าย
    }

    if (!lines.length) {
      sectionsUpTo(musicStart);
      emitGrid(musicStart, musicEnd, 4);
    } else {
      let cursor = musicStart;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const gap = ln.t0 - cursor;
        if (gap >= barSec * 0.9) {
          sectionsUpTo(cursor);
          emitGrid(cursor, ln.t0, 0);
        } else if (gap >= beatSec * 2 && out.length && out[out.length - 1] !== '') {
          out.push('');
          sectionStart = true;
        }
        if (sectionsUpTo(ln.t0)) { /* label ใหม่ = ต้นท่อน */ }

        // หน้าต่างคอร์ดของบรรทัด: ถึงบรรทัดถัดไป (ถ้าช่องว่างสั้น) ไม่งั้นถึงต้นห้องถัดไปหลังจบบรรทัด
        // (ส่วนที่เหลือเป็นกริด — คอร์ดระหว่างท้ายบรรทัดกับห้องแรกของกริดจึงไม่หาย)
        const nx = lines[i + 1];
        const nextStart = nx ? nx.t0 : musicEnd;
        let w1;
        if (nextStart - ln.t1 >= barSec * 0.9) {
          const nb = bars.find((bar) => bar.t0 >= ln.t1 - tol);
          w1 = Math.max(ln.t1, Math.min(nb ? nb.t0 : ln.t1, nextStart));
        } else w1 = Math.max(ln.t1, nextStart);
        const events = [];
        const lead = chordAt(ln.t0 + 0.001);
        if (lead && (lead !== lastEmitted || sectionStart)) events.push({ off: 0, label: lead });
        for (const c of labeled) {
          if (c.t0 <= ln.t0 + 0.001 || c.t0 >= w1) continue;
          const prevLabel = events.length ? events[events.length - 1].label : lastEmitted;
          if (c.label === prevLabel) continue;
          events.push({ off: offsetAt(c.t0, ln), label: c.label });
        }
        out.push(renderLyricLine(ln, events));
        // คอร์ดที่ยังดังอยู่ตอนจบหน้าต่าง (null = N.C. → บรรทัดถัดไปต้องเขียนคอร์ดใหม่)
        lastEmitted = chordAt(Math.max(ln.t0, w1 - 0.01));
        sectionStart = false;
        cursor = Math.max(cursor, w1);
      }
      if (musicEnd - cursor >= barSec * 0.9) {
        sectionsUpTo(cursor);
        emitGrid(cursor, musicEnd, 0);
      }
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return head + out.join('\n') + '\n\n' + untimedBlock() + tail.join('\n') + '\n';
  }

  /* ---------------- ทำนอง: วินาที → beat (MelodyTrack) ---------------- */
  // beat index แบบ piecewise-linear ตาม beats จริง, นอกช่วงต่อด้วย tempo
  function makeBeatMap(beats, tempo) {
    const spb = 60 / tempo;
    const B = beats, n = B.length;
    return function toBeat(tm) {
      if (n === 0) return tm / spb;
      if (n === 1 || tm <= B[0]) return (tm - B[0]) / spb;
      if (tm >= B[n - 1]) return (n - 1) + (tm - B[n - 1]) / spb;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (B[mid] <= tm) lo = mid; else hi = mid; }
      return lo + (tm - B[lo]) / (B[lo + 1] - B[lo]);
    };
  }

  // แยกความยาวเป็นค่าที่ใช้ได้ (greedy) — ทุกค่าหาร 0.25 ลงตัว จึงจบเสมอ
  function splitDur(d) {
    const out = [];
    let rem = Math.round(d * 4) / 4;
    let guard = 0;
    while (rem >= 0.25 - 1e-9 && guard++ < 1000) {
      const v = DUR_SET.find((x) => x <= rem + 1e-9);
      out.push(v);
      rem = Math.round((rem - v) * 4) / 4;
    }
    return out;
  }

  function buildMelody(r) {
    const mel = r.melody;
    if (!mel || !mel.notes.length) return null;
    const num = r.timeSig[0];
    const toBeat = makeBeatMap(r.beats, r.tempo);
    const zero = r.downbeats.length ? toBeat(r.downbeats[0]) : 0;
    const tb = (sec) => toBeat(sec) - zero;

    // 1) quantize 1/4 beat
    let notes = mel.notes.map((n) => {
      const tq = q4(tb(n.s0));
      let e = q4(tb(n.s1));
      if (e - tq < 0.25) e = tq + 0.25;
      return { t: tq, e, p: n.p, conf: n.conf, s0: n.s0, s1: n.s1 };
    });
    notes.sort((a, b) => a.t - b.t || b.conf - a.conf);
    // 2) ทำนองเสียงเดียว — ซ้อนกันให้ตัดตัวก่อน, เริ่มตรงกันเก็บตัวที่มั่นใจกว่า
    const mono = [];
    for (const n of notes) {
      const prev = mono[mono.length - 1];
      if (prev && n.t < prev.e) {
        if (n.t <= prev.t) {
          if (n.conf > prev.conf || (n.conf === prev.conf && n.s1 - n.s0 > prev.s1 - prev.s0)) mono[mono.length - 1] = n;
          continue;
        }
        prev.e = n.t;
      }
      mono.push(n);
    }
    notes = mono;

    // 3) พยางค์ → โน้ตตามเวลาที่ทับกัน (โน้ตแรกในพยางค์ได้คำ, โน้ตถัดไปในพยางค์เดียวกัน = "_")
    const syls = [];
    if (r.lyrics) r.lyrics.lines.forEach((l) => l.syls.forEach((s) => syls.push(s)));
    syls.sort((a, b) => a.t0 - b.t0);
    const TOL = 0.08;
    let ni = 0;
    for (const s of syls) {
      while (ni < notes.length && notes[ni].s0 < s.t0 - TOL) ni++;
      let first = null;
      for (let j = ni; j < notes.length && notes[j].s0 < s.t1 - TOL; j++) {
        if (notes[j].syl) continue;
        if (!first) { first = notes[j]; first.syl = s.text; } else notes[j].syl = '_';
      }
      if (!first) {
        // ไม่มีโน้ตเริ่มในพยางค์ → ให้โน้ตที่ทับพยางค์มากที่สุด (ถ้ายังว่าง)
        let best = null, bestOv = 0;
        for (let j = Math.max(0, ni - 3); j < Math.min(notes.length, ni + 3); j++) {
          const n = notes[j];
          const ov = Math.min(n.s1, s.t1) - Math.max(n.s0, s.t0);
          if (ov > bestOv && !n.syl) { bestOv = ov; best = n; }
        }
        if (best) best.syl = s.text;
      }
    }

    // 4) pickup: beat 0 = downbeat แรก; ถ้าโน้ตเริ่มก่อนเกิน 1 ห้อง เลื่อนศูนย์ถอยทีละห้อง
    const minT = notes[0].t;
    let shift = 0;
    if (minT < 0) shift = Math.floor(-minT / num) * num;
    notes.forEach((n) => { n.t += shift; n.e += shift; });
    const pickup = notes[0].t < 0 ? -notes[0].t : 0;

    // 5) ตำแหน่งเปลี่ยนคอร์ด (beat) — ใช้ตัดตัวหยุดและแปะชื่อคอร์ด
    const changes = r.chords.filter((c) => c.label).map((c) => ({ b: q4(tb(c.t0)) + shift, label: c.label }));

    // 6) เติมตัวหยุดช่องว่าง → ตัดที่เส้นกั้นห้อง → แยกความยาวที่ใช้ได้ (+ tie)
    const els = [];
    const pushSpan = (t0, t1, n) => {
      let a = t0;
      while (a < t1 - 1e-9) {
        const nextBar = Math.floor(a / num + 1e-9) * num + num;
        let b = Math.min(t1, nextBar);
        if (!n) { // ตัวหยุดตัดตรงคอร์ดเปลี่ยนด้วย ให้ชื่อคอร์ดลงตรงจังหวะ
          const ch = changes.find((c) => c.b > a + 1e-9 && c.b < b - 1e-9);
          if (ch) b = ch.b;
        }
        const parts = splitDur(b - a);
        let x = a;
        parts.forEach((d, i) => {
          const el = { t: x, d, p: n ? n.p : null };
          if (n) {
            if (x === t0 && n.syl) el.syl = n.syl;
            else if (x !== t0 && n.syl) el.syl = '_';
            const last = (b >= t1 - 1e-9) && i === parts.length - 1;
            if (!last) el.tie = true;
          }
          els.push(el);
          x += d;
        });
        a = b;
      }
    };
    // เริ่มที่ pickup (ถ้ามี) ไม่งั้นที่ beat 0 — ห้องก่อนเสียงร้องเป็นตัวหยุด (มีชื่อคอร์ดอินโทรกำกับ)
    let cur = Math.min(notes[0].t, 0);
    for (const n of notes) {
      if (n.t > cur + 1e-9) pushSpan(cur, n.t, null);
      pushSpan(n.t, n.e, n);
      cur = n.e;
      if (els.length > LIM.notes * 2) break;
    }

    // 7) ชื่อคอร์ด → element แรกที่เวลา ≥ จุดเปลี่ยน (ตัวหลังชนะถ้าลงตัวเดียวกัน)
    const endT = cur;
    let ei = 0;
    for (const c of changes) {
      if (c.b >= endT) break;
      while (ei < els.length && els[ei].t < c.b - 1e-6) ei++;
      if (ei >= els.length) break;
      els[ei].chord = c.label;
    }
    if (els.length && !els[0].chord) {
      // คอร์ดที่ดังค้างมาตั้งแต่ก่อนโน้ตแรก
      let lab = null;
      for (const c of changes) { if (c.b <= els[0].t + 1e-6) lab = c.label; else break; }
      if (lab) els[0].chord = lab;
    }

    const track = {
      name: t('gpu.melody.name'),
      timeSig: [r.timeSig[0], r.timeSig[1]],
      tempo: Math.round(r.tempo),
      notes: els.map((e) => {
        const o = { t: e.t, d: e.d, p: e.p };
        if (e.syl) o.syl = e.syl;
        if (e.chord) o.chord = e.chord;
        if (e.tie) o.tie = true;
        return o;
      }),
    };
    if (r.key) track.keySig = r.key;
    if (pickup > 0) track.pickup = pickup;
    return track;
  }

  /* ---------------- ประกอบ SongDoc v2 ---------------- */
  function toSongDoc(result, opts) {
    opts = opts || {};
    const r = normalize(result);
    const fileName = baseName(opts.fileName);
    const title = cleanLine(opts.title, 200) || cleanLine(prettyTitle(fileName), 200) || 'Untitled';

    const chordpro = assemble(r, title);
    const timeline = r.chords.filter((c) => c.label).map((c) => ({ t: Math.round(c.t0 * 10) / 10, chord: c.label }));
    const lyricsText = r.lyrics ? r.lyrics.text : '';

    let confSum = 0, confW = 0;
    r.chords.forEach((c) => { if (c.label && c.conf != null) { const w = c.t1 - c.t0; confSum += c.conf * w; confW += w; } });
    const confidence = {
      chords: confW > 0 ? r2(confSum / confW) : (timeline.length ? 0.6 : 0),
      lyrics: lyricsText ? (r.lyrics.source === 'user' ? 0.85 : 0.6) : 0,
    };

    let melody = null;
    if (r.melody) {
      melody = buildMelody(r);
      if (!melody && r.warnings.length < LIM.warnings) r.warnings.push('melody: no usable notes');
    }

    const now = Date.now();
    const doc = {
      id: Store.uid(),
      schemaVersion: 2,
      title,
      artist: '',
      creator: CREATOR,
      key: r.key || '',
      tempo: String(Math.round(r.tempo)),
      capo: 0,
      chordpro,
      tabs: [],
      timeline,
      lyricsText,
      source: { kind: 'upload', ref: fileName, durationSec: r3(r.durationSec) },
      confidence,
      analysis: {
        engine: 'gpu',
        mode: r.mode || undefined,
        durationSec: r3(r.durationSec),
        beats: r.beats.map(r3),
        downbeats: r.downbeats.map(r3),
        sections: r.sections.map((s) => ({ t: r3(s.t), label: s.label })),
        warnings: r.warnings.slice(),
      },
      vocalIsolated: !!lyricsText,
      isPublic: false,
      favorite: 0,
      playCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (!doc.analysis.mode) delete doc.analysis.mode;
    if (!lyricsText) doc.lyricsEmpty = true;
    if (melody) doc.melody = melody;
    return doc;
  }

  const api = {
    FORMAT, VERSION, toSongDoc, normalize,
    // ช่องสำหรับเทสต์ (ไม่ใช่ API สาธารณะ)
    _test: { normChord, normKey, graphemes, makeBeatMap, splitDur, buildMelody, assemble, cleanLine },
  };
  if (typeof window !== 'undefined') window.Transcription = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
