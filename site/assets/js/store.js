/* store.js — คลังเพลง + ตั้งค่า (localStorage)
   SongDoc v2 (docs/04 + docs/09 §5): เพิ่ม melody (โน้ตทำนอง) + analysis (ผลวิเคราะห์ beat/ท่อน)
   - อ่านเมื่อไหร่ก็ migrate v1 → v2 ในหน่วยความจำ (ไม่ทิ้ง field ใด ๆ ของ v1.3.x: timeline, lyricsText,
     lyricsError, lyricsEmpty, tempo (string) ...) แล้วเขียนกลับเป็น v2 ตอนบันทึกครั้งถัดไป
   - localStorage แก้มือได้ → ตรวจ melody/analysis ทุกครั้งที่อ่าน (clamp ตัวเลข, ทิ้งโน้ตเสีย)
   - คีย์ที่เก็บยังเป็น 'aq.songs.v1' (โครงสร้างการเก็บ = array ของ SongDoc ไม่เปลี่ยน; เวอร์ชันของ
     เอกสารอยู่ที่ schemaVersion รายเพลง) — เครื่องมือ/เทสต์เดิมและโค้ดส่วนอื่นอ่านคีย์นี้อยู่ */
(function () {
  const KEY = 'aq.songs.v1';
  const SCHEMA = 2;
  const MAX_NOTES = 5000;
  const MAX_BEATS = 16 * 2000;          // เวลาโน้ตไม่เกิน ~2000 ห้อง 4/4
  const TS_DEN = [1, 2, 4, 8, 16];
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const KEY_RE = /^[A-G][#b]?m?$/;
  const CHORD_RE = /^[A-G][#b]?[A-Za-z0-9+#()°ø-]{0,12}(?:\/[A-G][#b]?)?$/;

  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const q4 = (x) => Math.round(x * 4) / 4; // quantize 1/4 beat (เขบ็ต 2 ชั้น)
  function str(x, max) {
    if (typeof x !== 'string') return '';
    // ตัด control char ที่ทำให้ข้อความพัง (คง \n ไว้ไม่ได้ในพยางค์/ชื่อ)
    return x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  }

  /* ---------- ตรวจ melody (MelodyTrack) ---------- */
  function cleanMelody(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    let ts = [4, 4];
    if (Array.isArray(m.timeSig) && m.timeSig.length === 2) {
      const n = Math.round(Number(m.timeSig[0])), d = Math.round(Number(m.timeSig[1]));
      if (n >= 1 && n <= 16 && TS_DEN.indexOf(d) >= 0) ts = [n, d];
    }
    const barBeats = ts[0] * 4 / ts[1];
    const out = { name: str(m.name, 80) || 'ทำนองร้อง', timeSig: ts };
    if (typeof m.keySig === 'string' && KEY_RE.test(m.keySig.trim())) out.keySig = m.keySig.trim();
    if (isNum(m.tempo) && m.tempo >= 20 && m.tempo <= 400) out.tempo = Math.round(m.tempo * 10) / 10;
    let pickup = isNum(m.pickup) ? clamp(q4(m.pickup), 0, barBeats) : 0;
    if (pickup >= barBeats) pickup = 0;
    if (pickup > 0) out.pickup = pickup;
    const src = Array.isArray(m.notes) ? m.notes.slice(0, MAX_NOTES) : [];
    const notes = [];
    src.forEach((x) => {
      if (!x || typeof x !== 'object') return;
      const t = Number(x.t), d = Number(x.d);
      if (!isNum(t) || !isNum(d)) return;
      const tq = q4(t), dq = q4(d);
      if (dq < 0.25 || dq > 64 || tq < -barBeats * 4 || tq > MAX_BEATS) return;
      let p = null;
      if (x.p !== null && x.p !== undefined) {
        const pn = Number(x.p);
        if (!isNum(pn)) return;
        p = clamp(Math.round(pn), 0, 127);
      }
      const n = { t: tq, d: dq, p };
      const syl = str(x.syl, 24);
      if (syl) n.syl = syl;
      const ch = str(x.chord, 20);
      if (ch && CHORD_RE.test(ch)) n.chord = ch;
      if (x.tie === true) n.tie = true;
      notes.push(n);
    });
    notes.sort((a, b) => a.t - b.t);
    out.notes = notes;
    return out;
  }

  /* ---------- ตรวจ analysis ---------- */
  function numArr(a, max) {
    if (!Array.isArray(a)) return undefined;
    const out = [];
    for (let i = 0; i < a.length && out.length < max; i++) {
      const v = Number(a[i]);
      if (isNum(v) && v >= 0 && v <= 36000) out.push(Math.round(v * 1000) / 1000);
    }
    return out;
  }
  function cleanAnalysis(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    const out = { engine: a.engine === 'gpu' ? 'gpu' : 'device' };
    if (a.mode === 'open' || a.mode === 'sheetsage2') out.mode = a.mode;
    if (isNum(a.durationSec) && a.durationSec >= 0 && a.durationSec <= 36000) out.durationSec = Math.round(a.durationSec * 1000) / 1000;
    const beats = numArr(a.beats, 20000); if (beats) out.beats = beats;
    const downbeats = numArr(a.downbeats, 5000); if (downbeats) out.downbeats = downbeats;
    if (Array.isArray(a.sections)) {
      out.sections = a.sections.slice(0, 200)
        .filter((s) => s && isNum(Number(s.t)) && Number(s.t) >= 0)
        .map((s) => ({ t: Math.round(Number(s.t) * 1000) / 1000, label: str(s.label, 40) }));
    }
    if (Array.isArray(a.warnings)) out.warnings = a.warnings.slice(0, 50).map((w) => str(w, 300)).filter(Boolean);
    return out;
  }

  /* ---------- migrate เอกสาร 1 เพลง (v1 → v2) ----------
     คืน null = ทิ้ง (ไม่ใช่ object) · ไม่ลบ field ที่ไม่รู้จัก (ของเวอร์ชันใหม่กว่าหรือ v1.3.x) */
  function migrate(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const d = Object.assign({}, s);
    // id ไปอยู่ใน href/data-attribute ของหน้าเว็บ → ต้องเป็นตัวอักษรปลอดภัยเท่านั้น (กันไฟล์นำเข้าที่แอบใส่ HTML)
    if (typeof d.id !== 'string' || !ID_RE.test(d.id)) d.id = uid();
    d.title = typeof d.title === 'string' ? d.title : (d.title == null ? '' : String(d.title));
    if (typeof d.chordpro !== 'string') d.chordpro = d.chordpro == null ? '' : String(d.chordpro);
    if ('melody' in d) {
      const m = cleanMelody(d.melody);
      if (m) d.melody = m; else delete d.melody;
    }
    if ('analysis' in d) {
      const a = cleanAnalysis(d.analysis);
      if (a) d.analysis = a; else delete d.analysis;
    }
    d.schemaVersion = SCHEMA;
    return d;
  }

  let corruptSaved = false;
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return []; }
    if (!raw) return [];
    let list;
    try { list = JSON.parse(raw); }
    catch (e) {
      // ข้อมูลเสีย → เก็บสำเนาไว้ก่อน (ไม่ให้การบันทึกครั้งถัดไปเขียนทับจนกู้ไม่ได้)
      if (!corruptSaved) {
        corruptSaved = true;
        try { localStorage.setItem(KEY + '.corrupt.' + Date.now(), raw); } catch (x) { /* เต็ม */ }
      }
      return [];
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    let reId = false;
    list.forEach((s) => {
      const d = migrate(s);
      if (!d) return;
      if (seen.has(d.id)) d.id = uid(); // id ซ้ำ (ไฟล์ถูกแก้) → แยกเป็นคนละเพลง ไม่ให้ทับกัน
      if (!s || d.id !== s.id) reId = true;
      seen.add(d.id);
      out.push(d);
    });
    // id ที่สร้างใหม่ต้องคงที่ (ไม่งั้นลิงก์ #/song/<id> หายทุกครั้งที่อ่าน) → เขียนกลับทันที
    if (reId) { try { saveAll(out); } catch (e) { /* เต็ม — ใช้ในหน่วยความจำไปก่อน */ } }
    return out;
  }
  function saveAll(list) { localStorage.setItem(KEY, JSON.stringify(list)); }

  function all() {
    return load().sort((a, b) => (b.lastPlayedAt || b.updatedAt || 0) - (a.lastPlayedAt || a.updatedAt || 0));
  }
  function get(id) { return load().find((s) => s.id === id) || null; }

  function upsert(song) {
    const list = load();
    const now = Date.now();
    const i = list.findIndex((s) => s.id === song.id);
    song.updatedAt = now;
    if (i >= 0) { list[i] = migrate(Object.assign({}, list[i], song)); }
    else {
      song.createdAt = song.createdAt || now;
      song.favorite = song.favorite || 0;
      song.playCount = song.playCount || 0;
      list.push(migrate(song));
    }
    const saved = i >= 0 ? list[i] : list[list.length - 1];
    // ให้ตัวที่ผู้เรียกถืออยู่ตรงกับที่บันทึก (id/schemaVersion/melody ที่ผ่านการตรวจแล้ว)
    song.id = saved.id;
    song.schemaVersion = SCHEMA;
    if ('melody' in saved) song.melody = saved.melody; else delete song.melody;
    if ('analysis' in saved) song.analysis = saved.analysis; else delete song.analysis;
    saveAll(list);
    return song;
  }

  function remove(id) { saveAll(load().filter((s) => s.id !== id)); }

  function toggleFav(id) {
    const list = load();
    const s = list.find((x) => x.id === id);
    if (s) { s.favorite = s.favorite ? 0 : 1; saveAll(list); return s.favorite; }
    return 0;
  }

  function markPlayed(id) {
    const list = load();
    const s = list.find((x) => x.id === id);
    if (s) { s.playCount = (s.playCount || 0) + 1; s.lastPlayedAt = Date.now(); saveAll(list); }
  }

  function count() { return load().length; }

  function exportJSON() {
    return JSON.stringify({
      format: 'aquachord-export', version: SCHEMA, exportedAt: Date.now(), songs: load(),
    }, null, 2);
  }

  // รับไฟล์ export ทั้ง version 1 และ 2 · เพลงที่เสียข้ามทีละเพลง ไม่ล้มทั้งไฟล์
  function importJSON(text) {
    const data = JSON.parse(text);
    if (!data || data.format !== 'aquachord-export' || !Array.isArray(data.songs)) throw new Error('bad format');
    if (data.version !== undefined && data.version !== 1 && data.version !== 2) throw new Error('bad version');
    const list = load();
    let added = 0;
    data.songs.slice(0, 5000).forEach((s) => {
      if (!s || typeof s !== 'object' || !s.id || !s.title) return;
      const d = migrate(s);
      if (!d) return;
      const i = list.findIndex((x) => x.id === d.id);
      if (i >= 0) list[i] = d; else { list.push(d); }
      added++;
    });
    saveAll(list);
    return added;
  }

  function uid() {
    return 'sg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  window.Store = { all, get, upsert, remove, toggleFav, markPlayed, count, exportJSON, importJSON, uid, cleanMelody, cleanAnalysis, migrate, SCHEMA };
})();
