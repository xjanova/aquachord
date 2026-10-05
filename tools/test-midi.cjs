#!/usr/bin/env node
/* test-midi.cjs — เขียนไฟล์ MIDI จาก TrackSet แล้วอ่านกลับด้วยตัวอ่านขนาดเล็กในไฟล์นี้ เทียบโน้ต/เวลา/ช่อง/ชื่อแทร็ก */
'use strict';
const path = require('path');
const Midi = require(path.join(__dirname, '..', 'site', 'assets', 'js', 'midi.js'));

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('✗ ' + msg); } else console.log('✓ ' + msg); };

function parse(bytes) {
  let p = 0;
  const u32 = () => (bytes[p++] << 24 >>> 0) + (bytes[p++] << 16) + (bytes[p++] << 8) + bytes[p++];
  const u16 = () => (bytes[p++] << 8) + bytes[p++];
  const str4 = () => String.fromCharCode(bytes[p++], bytes[p++], bytes[p++], bytes[p++]);
  const vlq = () => { let n = 0, b; do { b = bytes[p++]; n = n * 128 + (b & 0x7f); } while (b & 0x80); return n; };
  if (str4() !== 'MThd') throw new Error('no MThd');
  u32(); const format = u16(), ntr = u16(), ppq = u16();
  const tracks = [];
  for (let k = 0; k < ntr; k++) {
    if (str4() !== 'MTrk') throw new Error('no MTrk');
    const len = u32(), end = p + len;
    let t = 0, status = 0;
    const tr = { name: '', notes: [], tempo: null, program: null, open: new Map() };
    while (p < end) {
      t += vlq();
      let b = bytes[p];
      if (b & 0x80) { status = b; p++; } else b = status;
      if (status === 0xff) {
        const type = bytes[p++]; const l = vlq(); const data = bytes.slice(p, p + l); p += l;
        if (type === 0x03) tr.name = Buffer.from(data).toString('utf8');
        if (type === 0x51) tr.tempo = (data[0] << 16) | (data[1] << 8) | data[2];
      } else {
        const hi = status & 0xf0, ch = status & 15;
        if (hi === 0xc0) { tr.program = bytes[p++]; tr.ch = ch; }
        else {
          const key = bytes[p++], vel = bytes[p++];
          if (hi === 0x90 && vel > 0) tr.open.set(key, { t, vel, ch });
          else if (hi === 0x80 || (hi === 0x90 && vel === 0)) { const o = tr.open.get(key); if (o) { tr.notes.push({ on: o.t, off: t, key, vel: o.vel, ch: o.ch }); tr.open.delete(key); } }
        }
      }
    }
    tracks.push(tr);
  }
  return { format, ppq, tracks };
}

const bpm = 100, spb = 0.6;
const ts = {
  v: 1, bpm, tracks: [
    { id: 'bass', kind: 'pitched', program: 33, notes: [{ t: 0, d: 0.55, midi: 40, vel: 0.9 }, { t: 0.6, d: 0.55, midi: 43, vel: 0.8 }, { t: 1.2, d: 1.1, midi: 45, vel: 0.7 }] },
    { id: 'drums', kind: 'drums', program: 0, notes: [{ t: 0, d: 0.1, midi: 36, vel: 1 }, { t: 0.6, d: 0.1, midi: 38, vel: 0.9 }, { t: 0.3, d: 0.05, midi: 42, vel: 0.5 }] },
    { id: 'piano', kind: 'pitched', program: 0, notes: [{ t: 0, d: 1.2, midi: 60, vel: 0.6 }, { t: 0, d: 1.2, midi: 64, vel: 0.6 }, { t: 0, d: 1.2, midi: 67, vel: 0.6 }, { t: 1.2, d: 0.6, midi: 60, vel: 0.6 }, { t: 1.8, d: 0.6, midi: 60, vel: 0.6 }] },
    { id: 'empty', kind: 'pitched', program: 0, notes: [] },
  ],
};
const bytes = Midi.fromTrackSet(ts, { title: 'ทดสอบ เพลงไทย', names: { bass: 'เบส', drums: 'กลอง', piano: 'เปียโน' } });
const m = parse(bytes);
ok(m.format === 1 && m.ppq === Midi.PPQ, 'header type 1, PPQ ' + m.ppq);
ok(m.tracks.length === 4, 'conductor + 3 tracks (empty track omitted): ' + m.tracks.length);
ok(m.tracks[0].tempo === Math.round(60000000 / bpm), 'tempo meta ' + m.tracks[0].tempo);
ok(m.tracks[0].name === 'ทดสอบ เพลงไทย', 'UTF-8 title round-trips');
const bass = m.tracks[1], drums = m.tracks[2], piano = m.tracks[3];
ok(bass.name === 'เบส' && bass.program === 33, 'bass name + program 33');
ok(bass.notes.length === 3 && bass.notes.every((n, i) => n.on === Math.round(ts.tracks[0].notes[i].t / spb * 480)), 'bass onsets in ticks');
ok(bass.notes[2].off - bass.notes[2].on === Math.round(1.1 / spb * 480), 'bass duration preserved');
ok(drums.notes.length === 3 && drums.notes.every((n) => n.ch === 9) && drums.program === null, 'drums on channel 10, no program change');
ok(piano.notes.length === 5 && new Set(piano.notes.map((n) => n.ch)).size === 1 && piano.notes[0].ch !== 9, 'piano polyphony on its own channel');
// repeated same-pitch notes back-to-back must not be cut by the order of note-off/note-on
const back = piano.notes.filter((n) => n.key === 60).sort((a, b) => a.on - b.on);
ok(back.length === 3 && back[1].off - back[1].on > 0 && back[2].on === back[1].off, 'back-to-back same pitch keeps both notes');
const only = parse(Midi.fromTrackSet(ts, { include: ['drums'] }));
ok(only.tracks.length === 2 && only.tracks[1].notes.length === 3, 'include filter exports only selected tracks');
const one = parse(Midi.fromNotes([{ t: 0, d: 0.5, midi: 64 }], { bpm: 90, name: 'Fingerstyle' }));
ok(one.tracks.length === 2 && one.tracks[1].program === 25 && one.tracks[1].name === 'Fingerstyle', 'fromNotes → steel guitar track');

if (fails) { console.log(`\n✗ test-midi ล้มเหลว ${fails} ข้อ`); process.exit(1); }
console.log('\n✓ test-midi ผ่านทุกข้อ');
