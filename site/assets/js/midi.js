/* midi.js — เขียนไฟล์ Standard MIDI (type 1) จากแทร็กที่แกะได้ (TrackSet v1) หรือโน้ตชุดเดียว
   - แทร็กแรก = conductor (ชื่อเพลง, tempo, 4/4) · แทร็กละเครื่องดนตรี มีชื่อ + program GM
   - กลองอยู่ช่อง 10 (channel index 9) ตามมาตรฐาน GM · เวลาโน้ตคงตามวินาทีจริงของเพลง (tempo คงที่)
   - ใช้ได้ทั้งในเบราว์เซอร์ (window.Midi) และ Node (require) — เทสต์ใน tools/test-midi.cjs */
(function (root) {
  'use strict';
  const PPQ = 480;
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function Bytes() { this.a = []; }
  Bytes.prototype.push1 = function (b) { this.a.push(b & 255); };
  Bytes.prototype.pushN = function (arr) { for (let i = 0; i < arr.length; i++) this.a.push(arr[i] & 255); };
  Bytes.prototype.vlq = function (n) {
    n = Math.max(0, Math.floor(n));
    const tmp = [n & 0x7f];
    n = Math.floor(n / 128);
    while (n > 0) { tmp.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    this.pushN(tmp);
  };
  Bytes.prototype.text = function (type, s) {
    const b = enc ? Array.from(enc.encode(String(s))) : Array.from(String(s)).map((c) => c.charCodeAt(0) & 255);
    const clipped = b.slice(0, 255);
    this.push1(0); this.pushN([0xff, type]); this.vlq(clipped.length); this.pushN(clipped);
  };

  function chunk(out, type, data) {
    for (let i = 0; i < 4; i++) out.push(type.charCodeAt(i));
    const n = data.length;
    out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    for (let i = 0; i < n; i++) out.push(data[i]);
  }

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const isNum = (x) => typeof x === 'number' && isFinite(x);

  /* trackSet: { bpm, tracks:[{ id, name?, kind:'drums'|'pitched', program, notes:[{t,d,midi,vel}] }] }
     opts: { title, bpm (ทับ), names: {id: 'ชื่อแสดง'}, include: Set|Array ของ id ที่จะส่งออก } */
  function fromTrackSet(trackSet, opts) {
    opts = opts || {};
    const bpm = clamp(isNum(opts.bpm) ? opts.bpm : (isNum(trackSet && trackSet.bpm) && trackSet.bpm > 0 ? trackSet.bpm : 120), 20, 300);
    const spb = 60 / bpm;
    const tick = (sec) => Math.max(0, Math.round((sec / spb) * PPQ));
    const include = opts.include ? new Set(opts.include) : null;
    const tracks = ((trackSet && trackSet.tracks) || []).filter((tr) => tr && Array.isArray(tr.notes) && tr.notes.length && (!include || include.has(tr.id)));

    const files = [];
    // conductor
    const cd = new Bytes();
    if (opts.title) cd.text(0x03, opts.title);
    cd.text(0x01, 'AquaChord');
    const us = Math.round(60000000 / bpm);
    cd.pushN([0x00, 0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255]);
    cd.pushN([0x00, 0xff, 0x58, 0x04, 4, 2, 24, 8]);
    cd.pushN([0x00, 0xff, 0x2f, 0x00]);
    files.push(cd.a);

    let nextCh = 0;
    tracks.forEach((tr) => {
      const drums = tr.kind === 'drums';
      let ch;
      if (drums) ch = 9;
      else { if (nextCh === 9) nextCh++; ch = Math.min(15, nextCh++); }
      const evs = [];
      tr.notes.forEach((n) => {
        if (!n || !isNum(n.t) || !isNum(n.midi)) return;
        const key = clamp(Math.round(n.midi), 0, 127);
        const on = tick(n.t);
        const off = Math.max(on + 1, tick(n.t + Math.max(0.02, isNum(n.d) ? n.d : 0.25)));
        const vel = clamp(Math.round((isNum(n.vel) ? n.vel : 0.8) * 127), 1, 127);
        evs.push([on, 1, 0x90 | ch, key, vel], [off, 0, 0x80 | ch, key, 0]);
      });
      // เวลาเดียวกัน: ปล่อยโน้ตเก่าก่อนกดโน้ตใหม่
      evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const b = new Bytes();
      b.text(0x03, (opts.names && opts.names[tr.id]) || tr.name || tr.id || 'Track');
      if (!drums) b.pushN([0x00, 0xc0 | ch, clamp(Math.round(tr.program || 0), 0, 127)]);
      let last = 0;
      evs.forEach((e) => { b.vlq(e[0] - last); b.pushN([e[2], e[3], e[4]]); last = e[0]; });
      b.pushN([0x00, 0xff, 0x2f, 0x00]);
      files.push(b.a);
    });

    const out = [];
    chunk(out, 'MThd', [0, 1, (files.length >> 8) & 255, files.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
    files.forEach((d) => chunk(out, 'MTrk', d));
    return new Uint8Array(out);
  }

  // โน้ตชุดเดียว (เช่น แท็บฟิงเกอร์สไตล์) → ไฟล์ MIDI 1 แทร็ก
  function fromNotes(notes, opts) {
    opts = opts || {};
    return fromTrackSet({ bpm: opts.bpm, tracks: [{ id: opts.name || 'Guitar', kind: 'pitched', program: isNum(opts.program) ? opts.program : 25, notes }] }, opts);
  }

  function download(bytes, filename) {
    const blob = new Blob([bytes], { type: 'audio/midi' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(filename || 'aquachord.mid').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const api = { fromTrackSet, fromNotes, download, PPQ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Midi = api;
})(typeof window !== 'undefined' ? window : null);
