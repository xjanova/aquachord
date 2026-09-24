'use strict';
/* songs.cjs — ชุดเพลงจำลองสำหรับ benchmark (ground truth = ชื่อคอร์ดตาม grammar AquaChord)
   แต่ละรายการ: [คอร์ด, จำนวน beat, {push:true}?]  'N' = ไม่มีคอร์ด (กลองล้วน)
   ci:true = อยู่ในชุดเร็วที่รันใน CI
   ตัวก่อกวนที่ใส่ (ดู synth.cjs): color (เติม 9/6/11 ในการเล่นแต่ label ยังเป็น triad), riff (ไลน์เครื่องดนตรี
   อื่นที่มีโน้ตนอกคอร์ด: fills/strings/arp), harmony (เสียงประสานคู่สามในท่อนฮุค), wow (จูนแกว่งแบบเทปเก่า),
   push (คอร์ดมาก่อนจังหวะ), transpose (เปลี่ยนคีย์), drift (tempo แกว่ง), mix.hp/lp (มือถือ/mp3) */

const V = (bars, extra) => Object.assign({ bars }, extra || {});

const SONGS = [
  {
    name: 'pop-C-slash', ci: true, style: 'pop', bpm: 100, seed: 101, detune: 18, drift: 0.008,
    color: 0.3, riff: { type: 'fills', level: 0.5, octave: 74 },
    inst: { pad: true, gtr: 'pop', bass: 'pop' }, drumStyle: 'pop',
    mix: { lp: 4500, vocal: 1.3 },
    sections: [
      V([['C', 4], ['G/B', 4], ['Am', 4], ['F', 4]], { key: 'C', drums: 'light', dyn: 0.6 }),
      V([['C', 4], ['G/B', 4], ['Am', 4], ['Am/G', 4], ['F', 4], ['C/E', 4], ['Dm7', 2], ['G7', 2], ['C', 4]],
        { key: 'C', drums: 'full', vocal: true, repeat: 2, dyn: 0.75 }),
      V([['F', 4], ['G', 4, { push: true }], ['Em7', 4], ['Am', 4, { push: true }], ['F', 4], ['G', 4], ['Csus4', 2], ['C', 2], ['C', 4]],
        { key: 'C', drums: 'full', vocal: true, harmony: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'ballad-Eb-modulate', ci: false, style: 'ballad', bpm: 72, seed: 202, detune: -35, drift: 0.03,
    color: 0.2, riff: { type: 'strings', level: 0.6, octave: 70 },
    inst: { pad: true, piano: true, bass: 'ballad' }, drumStyle: 'ballad',
    mix: { lp: 4200, reverb: 0.4, rt: 2.2, vocal: 1.35 },
    vocal: { rhythm: [1, 1, 2, 0.5, 0.5, 1.5, 3], lo: 58, hi: 77 },
    sections: [
      V([['Ebmaj7', 4], ['Abmaj7', 4]], { key: 'Eb', drums: 'none', dyn: 0.55, pad: false }),
      V([['Eb', 4], ['Bb/D', 4], ['Cm7', 4], ['Gm7', 4], ['Abmaj7', 4], ['Eb/G', 4], ['Fm7', 4], ['Bb7sus4', 2], ['Bb7', 2]],
        { key: 'Eb', drums: 'light', vocal: true, dyn: 0.7, flat: true }),
      V([['Abmaj7', 4], ['Bb', 4], ['Gm7', 4], ['Cm7', 4], ['Fm7', 4], ['Bb7', 4], ['Eb', 4]],
        { key: 'Eb', drums: 'full', vocal: true, harmony: true, dyn: 0.95, flat: true }),
      V([['Abmaj7', 4], ['Bb', 4], ['Gm7', 4], ['Cm7', 4], ['Fm7', 4], ['Bb7', 4], ['Eb', 4]],
        { key: 'E', transpose: 1, drums: 'full', vocal: true, harmony: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'lukthung-Am', ci: true, style: 'lukthung', bpm: 128, seed: 303, detune: 38, drift: 0.01,
    riff: { type: 'fills', level: 0.6, octave: 76 }, wow: { depth: 15, period: 9 },
    inst: { pad: true, gtr: 'chuck', bass: 'oompah' }, drumStyle: 'lukthung',
    mix: { lp: 3800, drive: 2.2, hiss: 0.004, vocal: 1.4 },
    vocal: { ornament: true, vibrato: 45, rhythm: [0.5, 0.5, 1, 1, 2, 1.5], lo: 60, hi: 79 },
    sections: [
      V([['Am', 4], ['Am', 4], ['Dm', 4], ['E7', 4]], { key: 'Am', drums: 'full', dyn: 0.8 }),
      V([['Am', 4], ['Am', 4], ['Dm', 4], ['Am', 4], ['G', 4], ['C', 4], ['E7', 4], ['Am', 4]],
        { key: 'Am', drums: 'full', vocal: true, repeat: 2, dyn: 0.8 }),
      V([['F', 4], ['G', 4], ['C', 4], ['Am', 4], ['Dm', 4], ['Am', 4], ['E7', 4], ['Am', 4]],
        { key: 'Am', drums: 'full', vocal: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'rock-G-sus', ci: false, style: 'rock', bpm: 132, seed: 404, detune: -12,
    color: 0.3, riff: { type: 'fills', level: 0.5, octave: 67 },
    inst: { gtr: 'rock', bass: 'eighths' }, drumStyle: 'rock',
    mix: { drums: 1.0, drive: 2.6, lp: 5000, vocal: 1.2 },
    sections: [
      V([['G', 4], ['Dsus4', 2], ['D', 2], ['Em', 4], ['Cadd9', 4]], { key: 'G', drums: 'full', dyn: 0.9 }),
      V([['G', 4], ['D/F#', 4], ['Em', 4], ['C', 4], ['G', 4], ['D/F#', 4], ['Csus2', 4], ['D', 4]],
        { key: 'G', drums: 'full', vocal: true, repeat: 2, dyn: 0.8 }),
      V([['C', 4], ['D', 4], ['G', 4], ['Em', 4], ['C', 4], ['D', 4], ['Gsus4', 2], ['G', 2], ['G', 4]],
        { key: 'G', drums: 'full', vocal: true, harmony: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'jazz-Dm-7ths', ci: true, style: 'jazz', bpm: 110, seed: 505, detune: 8,
    inst: { pad: true, piano: true, bass: 'walk' }, drumStyle: 'shuffle',
    mix: { drums: 0.5, vocal: 1.2, reverb: 0.3 },
    sections: [
      V([['Em7b5', 4], ['A7', 4], ['Dm7', 8], ['Gm7', 4], ['C7', 4], ['Fmaj7', 4], ['Bbmaj7', 4]], { key: 'Dm', drums: 'light', vocal: true, dyn: 0.8 }),
      V([['Em7b5', 4], ['A7', 4], ['Dm7', 4], ['Dm7/C', 4], ['Bbmaj7', 4], ['A7', 4], ['Dm7', 8]], { key: 'Dm', drums: 'light', vocal: true, dyn: 0.9 }),
      V([['Em7b5', 4], ['A7', 4], ['Dm7', 8], ['Gm7', 4], ['C7', 4], ['Fmaj7', 4], ['Bbmaj7', 4]], { key: 'Dm', drums: 'light', vocal: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'pop-D-keychange', ci: true, style: 'pop', bpm: 116, seed: 606, detune: 25, drift: 0.01,
    riff: { type: 'arp', level: 0.4, octave: 76 },
    inst: { pad: true, gtr: 'folk', bass: 'pop' }, drumStyle: 'pop',
    mix: { lp: 4600, vocal: 1.3 },
    sections: [
      V([['D', 4], ['A', 4], ['Bm', 4], ['G', 4]], { key: 'D', drums: 'light', dyn: 0.6 }),
      V([['D', 4], ['A/C#', 4], ['Bm', 4], ['Bm/A', 4], ['G', 4], ['D/F#', 4], ['Em7', 4], ['A7sus4', 2], ['A7', 2]],
        { key: 'D', drums: 'full', vocal: true, dyn: 0.75 }),
      V([['G', 4], ['A', 4, { push: true }], ['F#m', 4], ['Bm', 4], ['Em7', 4], ['A', 4], ['D', 4], ['D', 4]],
        { key: 'D', drums: 'full', vocal: true, harmony: true, dyn: 0.95 }),
      V([['G', 4], ['A', 4, { push: true }], ['F#m', 4], ['Bm', 4], ['Em7', 4], ['A', 4], ['D', 4], ['D', 4]],
        { key: 'E', transpose: 2, drums: 'full', vocal: true, harmony: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'ballad-F-dim-aug', ci: false, style: 'ballad', bpm: 76, seed: 707, detune: -22, drift: 0.025,
    riff: { type: 'strings', level: 0.5, octave: 72 },
    inst: { pad: true, piano: true, bass: 'ballad' }, drumStyle: 'ballad',
    mix: { lp: 4000, reverb: 0.35, rt: 2.0 },
    vocal: { rhythm: [1, 1, 2, 0.5, 0.5, 1.5], lo: 57, hi: 76 },
    sections: [
      V([['Bbmaj7', 4], ['C7sus4', 4]], { key: 'F', drums: 'none', dyn: 0.55, flat: true }),
      V([['F', 4], ['Faug', 4], ['Dm', 4], ['D7', 4], ['Gm', 4], ['Bbm', 4], ['F/C', 4], ['C7', 4]],
        { key: 'F', drums: 'light', vocal: true, dyn: 0.75 }),
      V([['F', 4], ['F#dim', 4], ['Gm7', 4], ['C7', 4], ['Am7', 4], ['D7', 4], ['Gm7', 2], ['C7', 2], ['F', 4]],
        { key: 'F', drums: 'light', vocal: true, dyn: 0.9 }),
    ],
  },
  {
    name: 'lukthung-G-phone', ci: true, style: 'lukthung', bpm: 136, seed: 808, detune: -40, drift: 0.012,
    riff: { type: 'fills', level: 0.5, octave: 76 }, wow: { depth: 20, period: 7 },
    inst: { pad: true, gtr: 'chuck', bass: 'oompah' }, drumStyle: 'lukthung',
    mix: { hp: 140, lp: 3200, hiss: 0.006, drive: 2.0, vocal: 1.45 },
    vocal: { ornament: true, vibrato: 50, rhythm: [0.5, 0.5, 1, 1, 2], lo: 62, hi: 79 },
    sections: [
      V([['G', 4], ['C', 4], ['D7', 4], ['G', 4]], { key: 'G', drums: 'full', dyn: 0.8 }),
      V([['G', 4], ['G', 4], ['C', 4], ['G', 4], ['Em', 4], ['Am', 4], ['D7', 4], ['G', 4]],
        { key: 'G', drums: 'full', vocal: true, repeat: 2, dyn: 0.85 }),
      V([['C', 4], ['D', 4], ['Bm', 4], ['Em', 4], ['Am', 4], ['Dsus4', 2], ['D7', 2], ['G', 4], ['G', 4]],
        { key: 'G', drums: 'full', vocal: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'pop-F#m-minor', ci: false, style: 'pop', bpm: 92, seed: 909, detune: 12, drift: 0.01,
    color: 0.3,
    inst: { pad: true, gtr: 'pop', bass: 'pop' }, drumStyle: 'pop',
    mix: { vocal: 1.6, reverb: 0.35, lp: 4400 },
    sections: [
      V([['F#m', 4], ['D', 4], ['A', 4], ['E', 4]], { key: 'F#m', drums: 'light', dyn: 0.6 }),
      V([['F#m', 4], ['D', 4], ['A', 4], ['E', 4], ['Bm7', 4], ['D', 4], ['E7sus4', 2], ['E7', 2], ['F#m', 4]],
        { key: 'F#m', drums: 'full', vocal: true, repeat: 2, dyn: 0.75 }),
      V([['D', 4], ['E', 4], ['C#m7', 4], ['F#m', 4], ['Bm7', 4], ['E', 4], ['A', 4], ['C#7', 4]],
        { key: 'F#m', drums: 'full', vocal: true, harmony: true, dyn: 1.0 }),
    ],
  },
  {
    name: 'blues-E-shuffle', ci: false, style: 'blues', bpm: 104, seed: 1010, detune: 15,
    riff: { type: 'fills', level: 0.6, octave: 71 },
    inst: { pad: true, gtr: 'pop', bass: 'walk' }, drumStyle: 'shuffle',
    mix: { vocal: 1.2 },
    sections: [
      V([['E7', 4], ['A7', 4], ['E7', 8], ['A7', 8], ['E7', 8], ['B7', 4], ['A7', 4], ['E7', 4], ['B7', 4]],
        { key: 'E', drums: 'full', vocal: true, repeat: 2, dyn: 0.9 }),
    ],
  },
  {
    name: 'folk-Bb-capo', ci: true, style: 'folk', bpm: 84, seed: 1111, detune: -30,
    color: 0.4,
    inst: { gtr: 'folk' },
    mix: { reverb: 0.2, vocal: 1.35 },
    sections: [
      V([['Bb', 4], ['F/A', 4], ['Gm', 4], ['Gm/F', 4], ['Eb', 4], ['Bb/D', 4], ['Cm7', 4], ['F', 4]],
        { key: 'Bb', vocal: true, repeat: 2, dyn: 0.8, flat: true }),
      V([['Eb', 4], ['F', 4], ['Dm7', 4], ['Gm', 4], ['Cm7', 4], ['F7sus4', 2], ['F', 2], ['Bb', 4], ['Bb', 4]],
        { key: 'Bb', vocal: true, dyn: 1.0, flat: true }),
    ],
  },
  {
    name: 'edm-F#m-sidechain', ci: false, style: 'edm', bpm: 124, seed: 1212, detune: 5, subBass: true, sidechain: true,
    riff: { type: 'arp', level: 0.5, octave: 76 },
    inst: { pad: true, bass: 'eighths' }, drumStyle: 'edm',
    mix: { drive: 2.5, lp: 5000, vocal: 1.3, reverb: 0.3 },
    sections: [
      // vi–IV–I–V ที่วนเริ่มจาก F#m — ศูนย์กลางเสียงคือ F#m (relative ของ A)
      V([['F#m', 4], ['D', 4], ['A', 4], ['E', 4]], { key: 'F#m', drums: 'light', dyn: 0.6 }),
      V([['F#m', 4], ['D', 4], ['A', 4], ['E', 4]], { key: 'F#m', drums: 'full', vocal: true, repeat: 3, dyn: 1.0 }),
      V([['D', 4], ['E', 4], ['C#m', 4], ['F#m', 4]], { key: 'F#m', drums: 'none', vocal: true, dyn: 0.7 }),
      V([['F#m', 4], ['D', 4], ['A', 4], ['E', 4]], { key: 'F#m', drums: 'full', vocal: true, repeat: 2, dyn: 1.0 }),
    ],
  },
];

module.exports = { SONGS };
