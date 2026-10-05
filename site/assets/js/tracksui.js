/* tracksui.js — หน้าจอ "แกะทุกเครื่องดนตรี" ในหน้าเพลง
   - แทร็กแบบ MIDI (TrackSet จาก stems.js ใน IndexedDB): เล่นพร้อมกัน · mute/solo/ความดัง · piano roll · ความเร็ว
   - ดูรายแทร็ก: โน้ตสากล (notation.js + abcjs) · แท็บกีตาร์/เบส · ตารางกลอง · ส่งออก .mid
   - ฟิงเกอร์สไตล์ (finger.js): รวมทำนอง+เบส+คอร์ดเป็นแท็บกีตาร์เดี่ยว เล่น/ส่งออก/ฝึก
   - ฝึกผ่านไมค์ (practice.js): ฟังกีตาร์ผู้เล่นเทียบกับโน้ต/คอร์ด · โหมดตามจังหวะ/รอจนถูก · ดนตรีประกอบแบบปิดแทร็กที่ฝึก
   ข้อความทั้งหมดของโมดูลนี้เพิ่มผ่าน I18N.extend */
(function () {
  I18N.extend({
    th: {
      'track.drums': 'กลอง', 'track.bass': 'เบส', 'track.guitar': 'กีตาร์', 'track.piano': 'เปียโน',
      'track.harmony': 'คอร์ด/ฮาร์โมนี', 'track.melody': 'ทำนอง', 'track.vocals': 'ทำนองร้อง', 'track.other': 'อื่น ๆ (ซินธ์/เครื่องสาย)',
      'track.fingerstyle': 'ฟิงเกอร์สไตล์',
      'tracks.title': 'แกะทุกเครื่องดนตรี',
      'tracks.none': 'ยังไม่มีแทร็กเครื่องดนตรีของเพลงนี้ — ให้ AI แกะไลน์ กลอง เบส ทำนอง และคอร์ด ออกมาเป็นโน้ตแบบ MIDI (เล่นพร้อมกัน เลือกเครื่องดนตรี ส่งออก .mid ได้)',
      'tracks.mode': 'วิธีแกะ',
      'tracks.mode.lite': 'พื้นฐาน (CPU) — ทุกเครื่อง',
      'tracks.mode.full': 'AI แยกเครื่องดนตรี (GPU) — แม่นกว่า ~285 MB',
      'tracks.mode.fullNo': 'AI แยกเครื่องดนตรี (GPU) — ต้องมี GPU',
      'tracks.fromFile': 'แกะทุกเครื่องดนตรีจากไฟล์เพลงนี้',
      'tracks.redo': 'แกะแทร็กใหม่',
      'tracks.redoQ': 'แกะแทร็กใหม่จากไฟล์?',
      'tracks.redoDesc': 'แทร็กเดิมจะถูกแทนที่ (คอร์ดและเนื้อร้องไม่เปลี่ยน)',
      'tracks.midi': 'ส่งออก MIDI (.mid)',
      'tracks.midiDone': 'ส่งออกไฟล์ MIDI แล้ว — เปิดในโปรแกรมดนตรีได้ทุกตัว',
      'tracks.notes': '{n} โน้ต',
      'tracks.view': 'โน้ต',
      'tracks.practice': 'ฝึก',
      'tracks.mute': 'ปิดเสียง', 'tracks.solo': 'ฟังเดี่ยว', 'tracks.vol': 'ความดัง',
      'tracks.speed': 'ความเร็ว',
      'tracks.source.lite': 'CPU · แยกด้วย DSP',
      'tracks.source.full': 'AI · GPU แยกเครื่องดนตรี',
      'tracks.note': 'แกะอัตโนมัติ (Beta) — โน้ตอาจคลาดเคลื่อน โดยเฉพาะเพลงที่เครื่องดนตรีซ้อนกันแน่น · ลากบนแผงโน้ตเพื่อเลื่อนดู แตะเพื่อกระโดดไปตำแหน่งนั้น',
      'tracks.done': 'แกะทุกเครื่องดนตรีเสร็จแล้ว!',
      'tracks.doneFallback': 'แกะเสร็จแล้ว (GPU ใช้ไม่ได้ จึงใช้โหมดพื้นฐานแทน)',
      'tracks.err': 'แกะแทร็กเครื่องดนตรีไม่สำเร็จบนเครื่องนี้',
      'tracks.none2': 'ไม่พบไลน์เครื่องดนตรีที่ชัดพอ',
      'tracks.enable': 'แกะทุกเครื่องดนตรีเป็นแทร็ก MIDI',
      'tracks.hint': 'กลอง เบส ทำนอง คอร์ด (และกีตาร์ เปียโน เสียงร้อง ในโหมด GPU) เป็นโน้ตแบบ MIDI เล่นพร้อมกัน/เลือกเครื่องดนตรี/ส่งออก .mid ได้ · ใช้เวลาเพิ่ม · โหมด GPU ดาวน์โหลดโมเดลครั้งแรก ~285 MB และแกะคอร์ดจากดนตรีที่ตัดกลอง/เสียงร้องออก (แม่นขึ้น)',
      'tv.staff': 'โน้ตสากล', 'tv.tab': 'แท็บ', 'tv.grid': 'ตารางกลอง', 'tv.solfege': 'โน้ตไทย',
      'tv.topVoice': 'แทร็กนี้มีหลายเสียงพร้อมกัน — โน้ตสากล/แท็บแสดงเฉพาะเสียงบนสุด (ดูครบใน piano roll และไฟล์ MIDI)',
      'tv.noNotation': 'ยังโหลดระบบโน้ตสากลไม่ได้',
      'finger.title': 'ฟิงเกอร์สไตล์ — กีตาร์เดี่ยวทั้งเพลง',
      'finger.desc': 'รวมทำนอง เบส และคอร์ดของเพลง เป็นแท็บกีตาร์ตัวเดียวที่เล่นได้จริง',
      'finger.style': 'สไตล์',
      'finger.style.melody-bass': 'ทำนอง + เบส',
      'finger.style.travis': 'แทรวิส (โป้งสลับเบส)',
      'finger.style.arpeggio': 'อาร์เปจโจ (เกา p-i-m-a)',
      'finger.style.chord-melody': 'คอร์ดเมโลดี้',
      'finger.level': 'ระดับ',
      'finger.easy': 'ง่าย', 'finger.normal': 'ปกติ',
      'finger.make': 'สร้างแท็บฟิงเกอร์สไตล์',
      'finger.play': 'เล่น', 'finger.capo': 'คาโป้ {n}', 'finger.noCapo': 'ไม่ใช้คาโป้',
      'finger.w.melody-octave': 'ย้ายทำนองทั้งเพลง {n} ออกเทฟให้อยู่ช่วงที่เล่นสบาย', 'finger.w.phrase-octave': 'ย้ายออกเทฟ {n} วลีเพื่อให้เล่นได้',
      'finger.w.note-octave': 'โน้ต {n} ตัวอยู่นอกช่วงกีตาร์ — ย้ายออกเทฟเฉพาะตัว', 'finger.w.repaired': 'ตัดโน้ตประกอบ {n} ตัวเพื่อให้เล่นได้จริง',
      'finger.w.unplayable': 'ยังมี {n} จุดที่อาจเล่นยาก', 'finger.w.easy-high-position': 'บางช่วงต้องขึ้นไปตำแหน่งเฟรต {n}',
      'finger.w.bpm-estimated': 'ไม่มีจังหวะของเพลง — ประมาณเอง {n} BPM', 'finger.w.no-melody': 'ไม่มีทำนอง — เล่นแพทเทิร์นคอร์ดอย่างเดียว',
      'finger.w.no-chords': 'ไม่มีคอร์ด — ใช้ทำนอง/เบสอย่างเดียว',
      'finger.noMelody': 'ยังไม่มีทำนองของเพลงนี้ — แกะทุกเครื่องดนตรีหรือแกะแท็บโซโล่ก่อน จะได้แท็บที่มีทำนอง (ตอนนี้สร้างได้แบบคอร์ด+เบส)',
      'finger.source': 'ทำนองจาก: {src}',
      'finger.src.melody': 'แทร็กทำนอง', 'finger.src.vocals': 'ทำนองร้อง', 'finger.src.riff': 'แท็บโซโล่', 'finger.src.none': 'ไม่มี (คอร์ด+เบสอย่างเดียว)',
      'practice.title': 'ฝึกผ่านไมค์',
      'practice.start': 'เริ่มฝึก', 'practice.stop': 'หยุดฝึก',
      'practice.timed': 'ตามจังหวะ', 'practice.wait': 'รอจนเล่นถูก',
      'practice.backing': 'เปิดดนตรีประกอบ (ปิดแทร็กที่ฝึก)',
      'practice.calibrate': 'วัดความหน่วงไมค์',
      'practice.calibrated': 'ความหน่วงไมค์ {ms} ms',
      'practice.calFail': 'วัดความหน่วงไม่ได้ (ใส่หูฟังอยู่?) — ใช้ค่าเดิม',
      'practice.hit': 'ถูก', 'practice.miss': 'พลาด', 'practice.score': 'แม่น {p}%',
      'practice.listen': 'กำลังฟัง…', 'practice.target': 'ต้องเล่น',
      'practice.skip': 'ข้าม',
      'practice.noMic': 'ใช้ไมค์ไม่ได้ — อนุญาตไมค์ในเบราว์เซอร์ หรือเปิดผ่าน https',
      'practice.done': 'จบรอบฝึก — แม่น {p}% ({h}/{n})',
      'practice.privacy': 'เสียงจากไมค์ประมวลผลในเครื่องเท่านั้น ไม่มีการอัดหรือส่งออกไปไหน · เปิดดนตรีประกอบควรใส่หูฟัง (เสียงจากลำโพงจะถูกนับเป็นการเล่น)',
      'practice.denied': 'เบราว์เซอร์ไม่ได้อนุญาตไมค์ — กดไอคอนแม่กุญแจข้างที่อยู่เว็บแล้วอนุญาตไมโครโฟน',
      'practice.busy': 'ไมค์ถูกแอปอื่นใช้อยู่ — ปิดแอปนั้นแล้วลองอีกครั้ง',
      'practice.noDevice': 'ไม่พบไมโครโฟนในเครื่องนี้',
      'practice.offTime': 'ถูกโน้ตแต่{w}',
      'practice.early': 'เร็วไป', 'practice.late': 'ช้าไป',
      'practice.chords': 'ฝึกคอร์ดทั้งเพลง',
    },
    en: {
      'track.drums': 'Drums', 'track.bass': 'Bass', 'track.guitar': 'Guitar', 'track.piano': 'Piano',
      'track.harmony': 'Chords / harmony', 'track.melody': 'Melody', 'track.vocals': 'Vocal melody', 'track.other': 'Other (synth/strings)',
      'track.fingerstyle': 'Fingerstyle',
      'tracks.title': 'Every instrument',
      'tracks.none': 'No instrument tracks for this song yet — let the AI transcribe the drum, bass, melody and chord lines into MIDI-like notes (play together, pick instruments, export .mid)',
      'tracks.mode': 'Method',
      'tracks.mode.lite': 'Basic (CPU) — any device',
      'tracks.mode.full': 'AI stem separation (GPU) — more accurate, ~285 MB',
      'tracks.mode.fullNo': 'AI stem separation (GPU) — needs a GPU',
      'tracks.fromFile': 'Transcribe every instrument from the audio file',
      'tracks.redo': 'Re-transcribe tracks',
      'tracks.redoQ': 'Re-transcribe the tracks from a file?',
      'tracks.redoDesc': 'The current tracks will be replaced (chords and lyrics stay the same)',
      'tracks.midi': 'Export MIDI (.mid)',
      'tracks.midiDone': 'MIDI file exported — opens in any music app',
      'tracks.notes': '{n} notes',
      'tracks.view': 'Notes',
      'tracks.practice': 'Practice',
      'tracks.mute': 'Mute', 'tracks.solo': 'Solo', 'tracks.vol': 'Volume',
      'tracks.speed': 'Speed',
      'tracks.source.lite': 'CPU · DSP split',
      'tracks.source.full': 'AI · GPU stem separation',
      'tracks.note': 'Automatic (Beta) — notes may be off, especially in dense mixes · drag the note view to scroll, tap to jump there',
      'tracks.done': 'Every instrument transcribed!',
      'tracks.doneFallback': 'Done (the GPU was unavailable, so the basic mode was used)',
      'tracks.err': 'Instrument transcription failed on this device',
      'tracks.none2': 'No instrument line was clear enough',
      'tracks.enable': 'Transcribe every instrument to MIDI tracks',
      'tracks.hint': 'Drums, bass, melody, chords (plus guitar, piano and vocals in GPU mode) as MIDI-like notes you can play together, solo and export as .mid · takes longer · GPU mode downloads ~285 MB once and decodes chords from the mix without drums/vocals (more accurate)',
      'tv.staff': 'Staff', 'tv.tab': 'Tab', 'tv.grid': 'Drum grid', 'tv.solfege': 'Thai solfège',
      'tv.topVoice': 'This track is polyphonic — staff/tab show the top voice only (all notes are in the piano roll and the MIDI file)',
      'tv.noNotation': 'The notation engine could not load',
      'finger.title': 'Fingerstyle — the whole song on one guitar',
      'finger.desc': 'Combines the melody, bass and chords into one playable guitar tab',
      'finger.style': 'Style',
      'finger.style.melody-bass': 'Melody + bass',
      'finger.style.travis': 'Travis (alternating thumb)',
      'finger.style.arpeggio': 'Arpeggio (p-i-m-a)',
      'finger.style.chord-melody': 'Chord melody',
      'finger.level': 'Level',
      'finger.easy': 'Easy', 'finger.normal': 'Normal',
      'finger.make': 'Make fingerstyle tab',
      'finger.play': 'Play', 'finger.capo': 'Capo {n}', 'finger.noCapo': 'No capo',
      'finger.w.melody-octave': 'Whole melody moved {n} octave(s) into a comfortable range', 'finger.w.phrase-octave': '{n} phrase(s) moved an octave to stay playable',
      'finger.w.note-octave': '{n} note(s) outside guitar range moved an octave', 'finger.w.repaired': 'Dropped {n} fill note(s) to keep it playable',
      'finger.w.unplayable': '{n} spot(s) may still be hard to play', 'finger.w.easy-high-position': 'Some passages go up to fret {n}',
      'finger.w.bpm-estimated': 'No song tempo — estimated {n} BPM', 'finger.w.no-melody': 'No melody — chord pattern only',
      'finger.w.no-chords': 'No chords — melody/bass only',
      'finger.noMelody': 'No melody for this song yet — transcribe every instrument or the solo tab first to include the melody (chords + bass only for now)',
      'finger.source': 'Melody from: {src}',
      'finger.src.melody': 'melody track', 'finger.src.vocals': 'vocal melody', 'finger.src.riff': 'solo tab', 'finger.src.none': 'none (chords + bass only)',
      'practice.title': 'Practice with the mic',
      'practice.start': 'Start practice', 'practice.stop': 'Stop',
      'practice.timed': 'In time', 'practice.wait': 'Wait for me',
      'practice.backing': 'Backing track (without the practiced part)',
      'practice.calibrate': 'Measure mic latency',
      'practice.calibrated': 'Mic latency {ms} ms',
      'practice.calFail': 'Could not measure latency (headphones on?) — keeping the previous value',
      'practice.hit': 'Hit', 'practice.miss': 'Miss', 'practice.score': '{p}% accurate',
      'practice.listen': 'Listening…', 'practice.target': 'Play',
      'practice.skip': 'Skip',
      'practice.noMic': 'Microphone unavailable — allow the mic in the browser or open over https',
      'practice.done': 'Round finished — {p}% accurate ({h}/{n})',
      'practice.privacy': 'Mic audio is processed on this device only; nothing is recorded or uploaded · use headphones with backing music (speaker sound counts as playing)',
      'practice.denied': 'Microphone permission was blocked — click the lock icon next to the address and allow the microphone',
      'practice.busy': 'The microphone is in use by another app — close it and try again',
      'practice.noDevice': 'No microphone found on this device',
      'practice.offTime': 'Right note, {w}',
      'practice.early': 'too early', 'practice.late': 'too late',
      'practice.chords': 'Practice the chords of the song',
    },
  });

  const COLORS = { drums: '#fb7185', bass: '#38bdf8', guitar: '#3df5d0', piano: '#c084fc', harmony: '#818cf8', melody: '#facc15', vocals: '#f472b6', other: '#94a3b8', fingerstyle: '#3df5d0' };
  const GUITAR = { tuning: [40, 45, 50, 55, 59, 64], names: ['E', 'A', 'D', 'G', 'B', 'e'] };
  const BASS = { tuning: [28, 33, 38, 43], names: ['E', 'A', 'D', 'G'] };
  const NAMES_TH = (id) => A().t('track.' + id);
  const A = () => window.AppAPI;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  let cur = null;

  /* ---------------- ชิ้นช่วยเหลือ ---------------- */
  function monoTop(notes) {
    // หลายเสียงพร้อมกัน → เก็บเสียงสูงสุดของแต่ละจังหวะเริ่ม (±30 ms) และตัดโน้ตที่ทับกัน
    const out = [];
    const sorted = notes.slice().sort((a, b) => a.t - b.t || b.midi - a.midi);
    sorted.forEach((n) => {
      const last = out[out.length - 1];
      if (last && Math.abs(n.t - last.t) < 0.03) { if (n.midi > last.midi) out[out.length - 1] = Object.assign({}, n); return; }
      out.push(Object.assign({}, n));
    });
    for (let i = 0; i < out.length - 1; i++) out[i].d = Math.max(0.03, Math.min(out[i].d, out[i + 1].t - out[i].t));
    return out;
  }
  function isPoly(notes) {
    for (let i = 1; i < notes.length; i++) if (notes[i].t < notes[i - 1].t + (notes[i - 1].d || 0) - 0.05) return true;
    return false;
  }
  function gridOf(ts, song) {
    const bpm = +ts.bpm > 0 ? +ts.bpm : (parseFloat(song.tempo) || 0);
    if (!bpm) return { bpm: 0, phase: 0 };
    const phase = A().barPhase(bpm, ts.phase != null ? ts.phase : 0, song.timeline);
    return { bpm, phase };
  }
  // วินาที → จังหวะ (สำหรับ notation.js ที่ใช้หน่วย beat)
  function toMelody(notes, bpm, phase, song) {
    const spb = 60 / bpm;
    const mk = (song.key || 'C').match(/^([A-G][#b]?m?)/);
    return {
      notes: notes.map((n) => ({ t: (n.t - phase) / spb, d: Math.max(0.25, n.d / spb), p: n.midi })).filter((n) => n.t > -8),
      timeSig: [4, 4], keySig: mk ? mk[1] : 'C', tempo: Math.round(bpm),
    };
  }
  function chordTimeline(song) {
    if (Array.isArray(song.timeline) && song.timeline.length) {
      const out = [];
      song.timeline.forEach((e) => { if (e.chord && Music.isChord(e.chord) && (!out.length || out[out.length - 1].chord !== e.chord)) out.push({ t: +e.t || 0, chord: e.chord }); });
      return out;
    }
    const bar = (60 / (parseFloat(song.tempo) || 90)) * 4;
    return A().songChords(song.chordpro).map((c, i) => ({ t: i * bar, chord: c }));
  }
  function stopMixer() { if (cur && cur.mixer) { cur.mixer.pause(); } }

  /* =====================================================================
     แทร็กเครื่องดนตรี
     ===================================================================== */
  function mount(song, els) {
    teardown();
    cur = { song, els, mixer: null, ts: null, sel: null, viewStart: 0, drag: null, practice: null, fingerNotes: null, fingerMixer: null };
    renderTracks();
    renderFinger();
  }
  function teardown() {
    if (!cur) return;
    if (cur.mixer) cur.mixer.destroy();
    if (cur.fingerMixer) cur.fingerMixer.destroy();
    stopPractice();
    if (cur.ro) cur.ro.disconnect();
    cur = null;
  }

  function capsHTML(caps) {
    const full = caps && caps.fullOK;
    const pref = A().ls.get('aq.tracks.mode', full ? 'full' : 'lite');
    const sel = pref === 'full' && full ? 'full' : 'lite';
    return `<div class="segctl tr-mode" role="radiogroup" aria-label="${A().esc(A().t('tracks.mode'))}">
      <button type="button" class="ingest-tab ${sel === 'lite' ? 'active' : ''}" role="radio" aria-checked="${sel === 'lite'}" data-mode="lite">${A().ic('settings')}${A().t('tracks.mode.lite')}</button>
      <button type="button" class="ingest-tab ${sel === 'full' ? 'active' : ''}" role="radio" aria-checked="${sel === 'full'}" data-mode="full" ${full ? '' : 'disabled'}>${A().ic('spark')}${A().t(full ? 'tracks.mode.full' : 'tracks.mode.fullNo')}</button>
    </div>`;
  }
  function wireModes(root) {
    $$('[data-mode]', root).forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return;
      A().ls.set('aq.tracks.mode', b.dataset.mode);
      $$('[data-mode]', root).forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-checked', on); });
    }));
  }
  function chosenMode(root) { const b = $('[data-mode].active', root); return b ? b.dataset.mode : 'lite'; }
  function startFromFile(mode) {
    A().pickFile((f) => A().startJob({ kind: 'file', file: f, tracks: mode, tracksFor: cur.song.id, riff: !A().loadRiff(cur.song.id) }));
  }

  function renderTracks() {
    const el = cur.els.tracksEl;
    if (!el) return;
    if (!window.Stems || !window.TrackStore) { el.hidden = true; return; }
    const t = A().t, tf = A().tf, ic = A().ic, esc = A().esc;
    const head = (extra) => `<div class="panel-head"><div><div class="eyebrow small">MULTITRACK · MIDI <span class="chip chip-beta">Beta</span>${extra || ''}</div><h2 class="section-title">${t('tracks.title')}</h2></div>`;
    el.innerHTML = `${head()}</div><p class="panel-note">${A().t('gpu.checking')}</p>`;
    const song = cur.song;
    Promise.all([TrackStore.get(song.id), Stems.capabilities ? Stems.capabilities().catch(() => null) : Promise.resolve(null)]).then(([ts, caps]) => {
      if (!cur || cur.song !== song) return;
      cur.caps = caps;
      if (!ts || !Array.isArray(ts.tracks) || !ts.tracks.length) {
        el.innerHTML = `${head()}</div>
          <p class="panel-note">${t('tracks.none')}</p>
          ${capsHTML(caps)}
          <div class="spot-actions"><button class="button primary" type="button" id="trFromFile">${ic('upload')}${t('tracks.fromFile')}</button></div>`;
        wireModes(el);
        $('#trFromFile', el).addEventListener('click', () => startFromFile(chosenMode(el)));
        return;
      }
      cur.ts = ts;
      const g = gridOf(ts, song);
      cur.grid = g;
      // แทร็กโหลดเสร็จหลังแผงฟิงเกอร์สไตล์วาดแล้ว → วาดใหม่ให้ใช้ทำนอง/เบสจากแทร็ก (ถ้ายังไม่ได้เรียบเรียง)
      if (!cur.fingerNotes) renderFinger();
      const tracks = ts.tracks.filter((x) => x.notes && x.notes.length);
      el.innerHTML = `${head(` <span class="chip">${t(ts.source === 'full' ? 'tracks.source.full' : 'tracks.source.lite')}</span>`)}
          <div class="tab-actions">
            <button class="button secondary sm" type="button" id="trMidi">${ic('download')}${t('tracks.midi')}</button>
            <button class="icon-btn" type="button" id="trRedo" title="${esc(t('tracks.redo'))}" aria-label="${esc(t('tracks.redo'))}">${ic('reset')}</button>
          </div>
        </div>
        <div class="transport">
          <button class="button primary sm" type="button" id="trPlay">${ic('play')}${t('finger.play')}</button>
          <button class="icon-btn" type="button" id="trStop" aria-label="stop">${ic('stop')}</button>
          <span class="tr-time" id="trTime">0:00</span>
          <input type="range" id="trPos" min="0" max="1000" value="0" aria-label="position" />
          <label class="mini-field tr-speed"><span class="sr-only">${t('tracks.speed')}</span>
            <select id="trSpeed">${['0.5', '0.75', '1', '1.25'].map((v) => A().opt(v, v + '×', A().ls.get('aq.tracks.speed', '1'))).join('')}</select></label>
        </div>
        <div class="roll-wrap"><canvas class="roll" id="trRoll" aria-label="piano roll"></canvas></div>
        <div class="mixer" id="trMixer">
          ${tracks.map((tr) => `
            <div class="mx-row" data-tr="${esc(tr.id)}" style="--c:${COLORS[tr.id] || '#94a3b8'}">
              <i class="mx-dot"></i>
              <span class="mx-name"><b>${esc(NAMES_TH(tr.id))}</b><small>${esc(tf('tracks.notes', { n: tr.notes.length }))}</small></span>
              <button type="button" class="mx-btn" data-mx="mute" aria-pressed="false" title="${esc(t('tracks.mute'))}">M</button>
              <button type="button" class="mx-btn" data-mx="solo" aria-pressed="false" title="${esc(t('tracks.solo'))}">S</button>
              <input type="range" class="mx-vol" data-mx="vol" min="0" max="150" value="100" aria-label="${esc(t('tracks.vol'))}" />
              <button type="button" class="mx-btn wide" data-mx="view">${t('tracks.view')}</button>
              ${window.Practice && tr.kind !== 'drums' ? `<button type="button" class="mx-btn wide" data-mx="practice">${ic('mic')}${t('tracks.practice')}</button>` : ''}
            </div>`).join('')}
        </div>
        <div class="track-view" id="trView"></div>
        <p class="panel-note">${t('tracks.note')}</p>`;

      const mixer = cur.mixer = Mixer.create({ tracks });
      mixer.setTempo(parseFloat(A().ls.get('aq.tracks.speed', '1')) || 1);
      const playBtn = $('#trPlay', el), pos = $('#trPos', el), timeEl = $('#trTime', el);
      const paintBtn = () => { playBtn.innerHTML = mixer.playing ? `${ic('stop')}${t('song.stop')}` : `${ic('play')}${t('finger.play')}`; };
      playBtn.addEventListener('click', () => {
        if (mixer.playing) { mixer.pause(); A().keepAwake(false); }
        else { A().stopOtherAudio(); mixer.play(); A().keepAwake(true); }
        paintBtn();
      });
      $('#trStop', el).addEventListener('click', () => { mixer.stop(); paintBtn(); A().keepAwake(false); });
      mixer.onEnd(() => { paintBtn(); A().keepAwake(false); });
      mixer.onTime((tm) => {
        timeEl.textContent = A().fmtClock(tm) + ' / ' + A().fmtClock(mixer.duration);
        if (!cur.drag) pos.value = Math.round((tm / Math.max(0.01, mixer.duration)) * 1000);
        drawRoll(tm);
      });
      pos.addEventListener('input', () => { mixer.seek((pos.value / 1000) * mixer.duration); });
      $('#trSpeed', el).addEventListener('change', (e) => { A().ls.set('aq.tracks.speed', e.target.value); mixer.setTempo(parseFloat(e.target.value) || 1); });
      $('#trMidi', el).addEventListener('click', () => {
        const names = {}; tracks.forEach((tr) => { names[tr.id] = NAMES_TH(tr.id); });
        Midi.download(Midi.fromTrackSet({ bpm: g.bpm || ts.bpm, tracks }, { title: song.title, names }), (song.title || 'aquachord') + '.mid');
        A().toast(t('tracks.midiDone'), { kind: 'ok' });
      });
      $('#trRedo', el).addEventListener('click', () => {
        A().confirmDialog({ title: t('tracks.redoQ'), body: t('tracks.redoDesc'), ok: t('tracks.fromFile') }).then((ok) => {
          if (!ok) return;
          const m = A().modal(`<h2>${ic('spark')} ${esc(t('tracks.mode'))}</h2>${capsHTML(cur.caps)}<div class="modal-actions"><button class="button primary" type="button" data-go>${ic('upload')}${t('tracks.fromFile')}</button></div>`);
          wireModes(m.root);
          $('[data-go]', m.root).addEventListener('click', () => { const mode = chosenMode(m.root); m.close(); startFromFile(mode); });
        });
      });
      $$('.mx-row', el).forEach((row) => {
        const id = row.dataset.tr;
        $$('[data-mx]', row).forEach((b) => {
          const act = b.dataset.mx;
          if (act === 'vol') { b.addEventListener('input', () => { mixer.setVolume(id, b.value / 100); }); return; }
          b.addEventListener('click', () => {
            if (act === 'mute' || act === 'solo') {
              const on = b.getAttribute('aria-pressed') !== 'true';
              b.setAttribute('aria-pressed', on); b.classList.toggle('on', on);
              if (act === 'mute') mixer.setMute(id, on); else mixer.setSolo(id, on);
              $$('.mx-row', el).forEach((r) => r.classList.toggle('dim', !mixer.state(r.dataset.tr).audible));
              drawRoll(mixer.time);
            } else if (act === 'view') { showTrack(id); }
            else if (act === 'practice') { const tr = tracks.find((x) => x.id === id); practiceTrack(tr); }
          });
        });
      });
      setupRoll();
      showTrack(tracks.find((x) => x.id === 'melody' || x.id === 'vocals') ? (tracks.find((x) => x.id === 'melody') || tracks.find((x) => x.id === 'vocals')).id : tracks[0].id);
      timeEl.textContent = '0:00 / ' + A().fmtClock(mixer.duration);
      renderFinger();
    });
  }

  /* ---------------- piano roll ---------------- */
  function setupRoll() {
    const cv = $('#trRoll', cur.els.tracksEl);
    if (!cv) return;
    cur.roll = cv;
    const resize = () => { const r = cv.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); drawRoll(cur.mixer ? cur.mixer.time : 0); };
    if ('ResizeObserver' in window) { cur.ro = new ResizeObserver(resize); cur.ro.observe(cv); }
    resize();
    let down = null;
    cv.addEventListener('pointerdown', (e) => { down = { x: e.clientX, v: cur.viewStart, moved: false }; cur.drag = true; try { cv.setPointerCapture(e.pointerId); } catch (er) {} });
    cv.addEventListener('pointermove', (e) => {
      if (!down) return;
      const span = spanOf(cv);
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 4) down.moved = true;
      if (down.moved && !(cur.mixer && cur.mixer.playing)) { cur.viewStart = Math.max(0, down.v - (dx / cv.clientWidth) * span); drawRoll(cur.mixer.time); }
    });
    const end = (e) => {
      if (!down) return;
      if (!down.moved && cur.mixer) {
        const r = cv.getBoundingClientRect(), span = spanOf(cv);
        const base = cur.mixer.playing ? Math.max(0, cur.mixer.time - span * 0.25) : cur.viewStart;
        cur.mixer.seek(Math.max(0, base + ((e.clientX - r.left) / r.width) * span));
      }
      down = null; cur.drag = false;
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', () => { down = null; cur.drag = false; });
  }
  function spanOf(cv) { return cv.clientWidth < 600 ? 6 : 12; }
  function drawRoll(tm) {
    if (!cur || !cur.roll || !cur.mixer) return;
    const cv = cur.roll, x = cv.getContext('2d');
    const W = cv.width, H = cv.height, dpr = W / Math.max(1, cv.clientWidth);
    const span = spanOf(cv);
    let v0 = cur.mixer.playing ? Math.max(0, tm - span * 0.25) : cur.viewStart;
    if (!cur.mixer.playing && (tm < v0 || tm > v0 + span)) { v0 = Math.max(0, tm - span * 0.25); cur.viewStart = v0; }
    x.clearRect(0, 0, W, H);
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, 0, W, H);
    const tracks = cur.mixer.tracks;
    const hasDrums = tracks.some((t) => t.kind === 'drums');
    const drumH = hasDrums ? Math.round(H * 0.2) : 0;
    let lo = 127, hi = 0;
    tracks.forEach((t) => { if (t.kind !== 'drums') t.notes.forEach((n) => { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }); });
    if (lo > hi) { lo = 48; hi = 72; }
    lo -= 2; hi += 2;
    const pitchH = H - drumH;
    const rowH = pitchH / (hi - lo + 1);
    const xOf = (s) => ((s - v0) / span) * W;
    // ตารางจังหวะ
    const g = cur.grid || {};
    if (g.bpm) {
      const beat = 60 / g.bpm;
      let k = Math.ceil((v0 - g.phase) / beat);
      for (let b = g.phase + k * beat; b < v0 + span; b += beat, k++) {
        const xx = xOf(b);
        x.fillStyle = k % 4 === 0 ? 'rgba(190,240,236,0.18)' : 'rgba(190,240,236,0.06)';
        x.fillRect(Math.round(xx), 0, Math.max(1, dpr * (k % 4 === 0 ? 1.2 : 1)), H);
      }
    }
    // แถว C ของแต่ละออกเทฟ
    x.fillStyle = 'rgba(255,255,255,0.03)';
    for (let m = lo; m <= hi; m++) if (m % 12 === 0) x.fillRect(0, pitchH - (m - lo + 1) * rowH, W, rowH);
    if (drumH) { x.fillStyle = 'rgba(251,113,133,0.06)'; x.fillRect(0, pitchH, W, drumH); }
    tracks.forEach((t) => {
      const audible = cur.mixer.state(t.id).audible;
      x.fillStyle = COLORS[t.id] || '#94a3b8';
      x.globalAlpha = audible ? 0.9 : 0.18;
      t.notes.forEach((n) => {
        if (n.t + n.d < v0 || n.t > v0 + span) return;
        const xx = xOf(n.t), ww = Math.max(2 * dpr, (n.d / span) * W);
        if (t.kind === 'drums') {
          const row = n.midi <= 36 ? 3 : (n.midi === 38 || n.midi === 40 || n.midi === 37) ? 2 : (n.midi === 42 || n.midi === 44 || n.midi === 46) ? 1 : 0;
          const rh = drumH / 4;
          x.fillRect(xx, pitchH + row * rh + rh * 0.15, Math.max(3 * dpr, ww * 0.3), rh * 0.7);
        } else {
          const y = pitchH - (n.midi - lo + 1) * rowH;
          x.fillRect(xx, y, ww, Math.max(2 * dpr, rowH - dpr));
        }
      });
    });
    x.globalAlpha = 1;
    const px = xOf(tm);
    x.fillStyle = '#ffffff'; x.fillRect(Math.round(px), 0, Math.max(1, 2 * dpr), H);
  }

  /* ---------------- ดูรายแทร็ก: โน้ตสากล / แท็บ / ตารางกลอง ---------------- */
  function showTrack(id) {
    const ts = cur.ts, tr = ts.tracks.find((x) => x.id === id);
    const host = $('#trView', cur.els.tracksEl);
    if (!tr || !host) return;
    cur.sel = id;
    $$('.mx-row', cur.els.tracksEl).forEach((r) => r.classList.toggle('sel', r.dataset.tr === id));
    const t = A().t, esc = A().esc, g = cur.grid;
    if (tr.kind === 'drums') {
      host.innerHTML = `<div class="tv-head"><b style="color:${COLORS.drums}">${esc(NAMES_TH(id))}</b><span class="chip">${t('tv.grid')}</span></div>${drumGridHTML(tr.notes, g)}`;
      return;
    }
    const poly = isPoly(tr.notes);
    const mono = poly ? monoTop(tr.notes) : tr.notes;
    const isBass = id === 'bass';
    const mode = A().ls.get('aq.tv.mode', 'staff');
    host.innerHTML = `<div class="tv-head"><b style="color:${COLORS[id] || '#fff'}">${esc(NAMES_TH(id))}</b>
        <div class="segctl compact" role="tablist">
          <button type="button" class="ingest-tab ${mode === 'staff' ? 'active' : ''}" data-tv="staff">${t('tv.staff')}</button>
          <button type="button" class="ingest-tab ${mode === 'tab' ? 'active' : ''}" data-tv="tab">${t('tv.tab')}</button>
          <button type="button" class="ingest-tab ${mode === 'sol' ? 'active' : ''}" data-tv="sol">${t('tv.solfege')}</button>
        </div></div>
      ${poly ? `<p class="panel-note">${t('tv.topVoice')}</p>` : ''}
      <div class="tv-body" id="tvBody"></div>`;
    const body = $('#tvBody', host);
    const paint = (m) => {
      A().ls.set('aq.tv.mode', m);
      $$('[data-tv]', host).forEach((b) => b.classList.toggle('active', b.dataset.tv === m));
      if (m === 'tab') {
        const conf = isBass ? BASS : GUITAR;
        let fretted = mono;
        if (window.Riff && Riff.assignFrets) { try { fretted = Riff.assignFrets(mono, { tuning: conf.tuning }); } catch (e) { fretted = mono; } }
        body.innerHTML = `<div class="tab-wrap">${A().tabBarsHTML(fretted.filter((n) => n.s != null), g.bpm || null, g.phase, { names: conf.names })}</div>`;
        return;
      }
      if (!window.Notation || !g.bpm) { body.innerHTML = `<p class="panel-note">${t('tv.noNotation')}</p>`; return; }
      body.innerHTML = '<div class="nt-host"></div>';
      try {
        Notation.render($('.nt-host', body), { melody: toMelody(mono, g.bpm, g.phase, cur.song), key: cur.song.key, tempo: g.bpm }, { thaiSolfege: m === 'sol', solfegeMode: 'movable', maxBarsPerLine: 4 });
      } catch (e) { body.innerHTML = `<p class="panel-note">${t('tv.noNotation')}</p>`; }
    };
    $$('[data-tv]', host).forEach((b) => b.addEventListener('click', () => paint(b.dataset.tv)));
    paint(mode);
  }

  function drumGridHTML(notes, g) {
    const bpm = g.bpm || 120, beat = 60 / bpm, step = beat / 4, bar = beat * 4, ph = g.bpm ? g.phase : 0;
    const ROWS = [['CR', (k) => k === 49 || k === 57 || k === 51 || k === 59 || (k >= 41 && k <= 50 && k !== 42 && k !== 44 && k !== 46)], ['HH', (k) => k === 42 || k === 44 || k === 46], ['SN', (k) => k === 37 || k === 38 || k === 40], ['BD', (k) => k === 35 || k === 36]];
    const bars = new Map();
    notes.forEach((n) => {
      const b = Math.floor((n.t - ph + step * 0.5) / bar);
      const s = Math.floor(((n.t - ph - b * bar) + step * 0.5) / step);
      if (!bars.has(b)) bars.set(b, {});
      const cell = bars.get(b);
      ROWS.forEach(([nm, f], r) => { if (f(n.midi)) cell[r + ':' + Math.min(15, Math.max(0, s))] = Math.max(cell[r + ':' + s] || 0, n.vel || 0.8); });
    });
    const keys = Array.from(bars.keys()).sort((a, b) => a - b);
    const first = keys.length ? keys[0] : 0;
    return `<div class="dg-wrap">${keys.map((b) => {
      const cell = bars.get(b);
      return `<div class="dg-bar"><span class="tab-num">${b - first + 1} <i>${A().fmtClock(Math.max(0, ph + b * bar))}</i></span>
        ${ROWS.map(([nm], r) => `<div class="dg-row"><i>${nm}</i>${Array.from({ length: 16 }, (_, s) => { const v = cell[r + ':' + s]; return `<span class="dg-cell${s % 4 === 0 ? ' beat' : ''}${v ? ' on' : ''}" ${v ? `style="opacity:${(0.45 + v * 0.55).toFixed(2)}"` : ''}></span>`; }).join('')}</div>`).join('')}
      </div>`;
    }).join('')}</div>`;
  }

  /* =====================================================================
     ฟิงเกอร์สไตล์
     ===================================================================== */
  function melodySource() {
    const ts = cur.ts;
    if (ts) {
      const m = ts.tracks.find((x) => x.id === 'melody' && x.notes.length);
      if (m) return { src: 'melody', notes: m.notes };
      const v = ts.tracks.find((x) => x.id === 'vocals' && x.notes.length);
      if (v) return { src: 'vocals', notes: monoTop(v.notes) };
    }
    const r = A().loadRiff(cur.song.id);
    if (r && r.notes && r.notes.length) return { src: 'riff', notes: r.notes.map((n) => ({ t: n.t, d: n.d, midi: Number.isFinite(+n.midi) ? +n.midi : 0 })).filter((n) => n.midi) };
    return { src: 'none', notes: [] };
  }
  function renderFinger() {
    const el = cur && cur.els.fingerEl;
    if (!el) return;
    if (!window.Finger) { el.hidden = true; return; }
    el.hidden = false;
    const t = A().t, tf = A().tf, ic = A().ic, esc = A().esc, ls = A().ls;
    const ms = melodySource();
    const STY = ['melody-bass', 'travis', 'arpeggio', 'chord-melody'];
    const style = ls.get('aq.finger.style', 'travis'), level = ls.get('aq.finger.level', 'easy');
    el.innerHTML = `<div class="panel-head"><div><div class="eyebrow small">FINGERSTYLE · TAB</div><h2 class="section-title">${t('finger.title')}</h2></div></div>
      <p class="panel-note">${t('finger.desc')} · ${esc(tf('finger.source', { src: t('finger.src.' + ms.src) }))}</p>
      ${ms.src === 'none' ? `<p class="panel-note warn-note">${t('finger.noMelody')}</p>` : ''}
      <div class="play-row">
        <label class="mini-field play-style"><span>${t('finger.style')}</span><select id="fgStyle">${STY.map((s) => A().opt(s, t('finger.style.' + s), style)).join('')}</select></label>
        <label class="mini-field play-style"><span>${t('finger.level')}</span><select id="fgLevel">${A().opt('easy', t('finger.easy'), level)}${A().opt('normal', t('finger.normal'), level)}</select></label>
        <button class="button primary" type="button" id="fgMake">${ic('guitar')}${t('finger.make')}</button>
      </div>
      <div id="fgOut"></div>`;
    $('#fgStyle', el).addEventListener('change', (e) => ls.set('aq.finger.style', e.target.value));
    $('#fgLevel', el).addEventListener('change', (e) => ls.set('aq.finger.level', e.target.value));
    $('#fgMake', el).addEventListener('click', () => makeFinger(ms));
  }
  // คำเตือนจาก Finger เป็นรหัส "code: รายละเอียด" → ข้อความตามภาษาที่เลือก (รหัสที่ไม่รู้จักไม่แสดง)
  function fingerWarnings(ws) {
    const out = [];
    (ws || []).forEach((w) => {
      const m = /^([a-z-]+)(?::\s*(.*))?$/.exec(String(w));
      if (!m) return;
      const k = 'finger.w.' + m[1];
      if (A().t(k) === k) return;
      const num = /([+-]?\d+)/.exec(m[2] || '');
      out.push(A().tf(k, { n: num ? num[1] : '' }));
    });
    return out;
  }
  function makeFinger(ms) {
    const el = cur.els.fingerEl, out = $('#fgOut', el);
    const t = A().t, tf = A().tf, ic = A().ic, esc = A().esc;
    const song = cur.song;
    let g = cur.grid && cur.grid.bpm ? cur.grid : (() => { const bpm = parseFloat(song.tempo) || 0; return bpm ? { bpm, phase: A().barPhase(bpm, 0, song.timeline) } : { bpm: 0, phase: 0 }; })();
    const bassTr = cur.ts && cur.ts.tracks.find((x) => x.id === 'bass');
    let res;
    try {
      res = Finger.arrange({
        melody: ms.notes, bass: bassTr ? bassTr.notes : [], chords: chordTimeline(song),
        bpm: g.bpm || null, phase: g.bpm ? g.phase : null, key: song.key,
        style: $('#fgStyle', el).value, difficulty: $('#fgLevel', el).value, capo: 'auto',
      });
    } catch (e) { A().toast(t('tracks.err'), { kind: 'warn' }); return; }
    const notes = (res && res.notes) || [];
    cur.fingerNotes = notes;
    if (cur.fingerMixer) cur.fingerMixer.destroy();
    // เพลงไม่มี BPM → ใช้กริดที่ตัวเรียบเรียงอนุมานจากจุดเปลี่ยนคอร์ด
    if (!g.bpm && res.bpm) g = { bpm: res.bpm, phase: +res.phase || 0 };
    // n.midi = เสียงที่ได้ยินจริง (รวมคาโป้แล้ว) · n.f นับจากคาโป้
    const capo = +res.capo || 0;
    const sounding = notes.map((n) => Object.assign({}, n, { vel: n.role === 'melody' ? 0.95 : 0.7 }));
    cur.fingerMixer = Mixer.create({ tracks: [{ id: 'fingerstyle', kind: 'pitched', program: 25, notes: sounding }] });
    out.innerHTML = `<div class="tab-actions fg-actions">
        <button class="button primary sm" type="button" id="fgPlay">${ic('play')}${t('finger.play')}</button>
        <span class="chip">${esc(capo ? tf('finger.capo', { n: capo }) : t('finger.noCapo'))}</span>
        <span class="chip">${esc(tf('tracks.notes', { n: notes.length }))}</span>
        <button class="icon-btn" type="button" id="fgMidi" title="${esc(t('tracks.midi'))}" aria-label="${esc(t('tracks.midi'))}">${ic('download')}</button>
        <button class="icon-btn" type="button" id="fgTxt" title="${esc(t('tab.download'))}" aria-label="${esc(t('tab.download'))}">${ic('copy')}</button>
        ${window.Practice ? `<button class="button secondary sm" type="button" id="fgPractice">${ic('mic')}${t('tracks.practice')}</button>` : ''}
      </div>
      <div class="tab-wrap fg-tab" id="fgTab">${A().tabBarsHTML(notes, g.bpm || null, g.phase, { names: GUITAR.names })}</div>
      ${fingerWarnings(res.warnings).length ? `<p class="panel-note">${esc(fingerWarnings(res.warnings).slice(0, 3).join(' · '))}</p>` : ''}`;
    const fm = cur.fingerMixer, playBtn = $('#fgPlay', out), tab = $('#fgTab', out);
    const btns = $$('.tab-note', tab);
    const paint = () => { playBtn.innerHTML = fm.playing ? `${ic('stop')}${t('song.stop')}` : `${ic('play')}${t('finger.play')}`; };
    let lastI = -1;
    fm.onTime((tm) => {
      // ไฮไลต์โน้ตที่กำลังเล่น
      let i = lastI;
      while (i + 1 < notes.length && notes[i + 1].t <= tm + 0.01) i++;
      if (i !== lastI) {
        btns.forEach((b) => { const n = notes[+b.dataset.i]; b.classList.toggle('now', !!n && n.t <= tm && n.t + Math.max(0.12, n.d) > tm); });
        const b = btns.find((x) => x.classList.contains('now'));
        if (b && fm.playing) { const r = b.parentElement.getBoundingClientRect(); if (r.bottom > innerHeight - 90 || r.top < 80) b.parentElement.scrollIntoView({ block: 'center', behavior: A().motionOn() ? 'smooth' : 'auto' }); }
        lastI = i;
      }
    });
    fm.onEnd(() => { paint(); lastI = -1; btns.forEach((b) => b.classList.remove('now')); });
    playBtn.addEventListener('click', () => { if (fm.playing) fm.pause(); else { A().stopOtherAudio(); stopMixer(); lastI = -1; fm.play(0); } paint(); });
    tab.addEventListener('click', (e) => {
      const b = e.target.closest('.tab-note'); if (!b) return;
      const n = sounding[+b.dataset.i]; if (n) Music.note(n.midi, 0, 1.2, 0.32, { guitar: true, bright: true });
    });
    $('#fgMidi', out).addEventListener('click', () => {
      Midi.download(Midi.fromNotes(sounding, { bpm: g.bpm || 100, name: t('track.fingerstyle'), title: song.title }), (song.title || 'aquachord') + ' (fingerstyle).mid');
      A().toast(t('tracks.midiDone'), { kind: 'ok' });
    });
    $('#fgTxt', out).addEventListener('click', () => {
      let txt = '';
      try { txt = Finger.toAsciiTab ? Finger.toAsciiTab(notes, { bpm: g.bpm || undefined, phase: g.bpm ? g.phase : undefined, capo }) : ''; } catch (e) { txt = ''; }
      const blob = new Blob([`${song.title || 'AquaChord'} — Fingerstyle (AquaChord)\n${capo ? 'Capo ' + capo + '\n' : ''}\n${txt}\n`], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = (song.title || 'tab').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) + ' (fingerstyle).txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    const pr = $('#fgPractice', out);
    if (pr) pr.addEventListener('click', () => practiceNotes(sounding, { tabEl: tab, label: t('track.fingerstyle'), backing: null }));
  }

  /* =====================================================================
     ฝึกผ่านไมค์
     ===================================================================== */
  function stopPractice() {
    if (!cur || !cur.practice) return;
    const p = cur.practice;
    cur.practice = null;
    try { p.follow && p.follow.stop(); } catch (e) {}
    try { p.session && p.session.close(); } catch (e) {}
    if (p.backing) { try { p.backing.destroy(); } catch (e) {} }
    if (p.dock) p.dock.remove();
    document.body.classList.remove('pd-open');
    A().keepAwake(false);
  }
  function practiceTrack(tr) {
    const notes = isPoly(tr.notes) ? monoTop(tr.notes) : tr.notes;
    const others = cur.ts.tracks.filter((x) => x.id !== tr.id);
    practiceNotes(notes, { label: NAMES_TH(tr.id), backingTracks: others, tabEl: null });
  }
  function micErrorText(e) {
    const c = e && e.code;
    return A().t(c === 'denied' ? 'practice.denied' : c === 'busy' ? 'practice.busy' : c === 'no-mic' ? 'practice.noDevice' : 'practice.noMic');
  }
  function practiceNotes(expected, o) {
    if (!window.Practice) return;
    stopPractice();
    A().stopOtherAudio(); stopMixer();
    const av = Practice.available();
    const t = A().t, tf = A().tf, ic = A().ic, esc = A().esc, ls = A().ls;
    if (!av || !av.ok) { A().toast(t('practice.noMic'), { kind: 'warn', ms: 6000 }); return; }
    const dock = document.createElement('div');
    dock.className = 'practice-dock';
    dock.innerHTML = `<div class="pd-head"><b>${ic('mic')} ${esc(t('practice.title'))} · ${esc(o.label || '')}</b><button type="button" class="icon-btn" data-pd="close" aria-label="${esc(t('practice.stop'))}">${ic('close')}</button></div>
      <div class="pd-main">
        <div class="pd-meter"><i id="pdLevel"></i></div>
        <div class="pd-now"><small>${t('practice.target')}</small><b id="pdTarget">—</b></div>
        <div class="pd-now"><small>${t('practice.listen')}</small><b id="pdHeard">—</b></div>
        <div class="pd-score"><b id="pdScore">0%</b><small id="pdCount">0/0</small></div>
      </div>
      <div class="pd-ctl">
        <div class="segctl compact"><button type="button" class="ingest-tab ${ls.get('aq.pr.mode', 'wait') === 'wait' ? 'active' : ''}" data-pm="wait">${t('practice.wait')}</button><button type="button" class="ingest-tab ${ls.get('aq.pr.mode', 'wait') === 'timed' ? 'active' : ''}" data-pm="timed">${t('practice.timed')}</button></div>
        <label class="mini-field"><span class="sr-only">${t('tracks.speed')}</span><select data-pd="tempo">${['0.5', '0.75', '1'].map((v) => A().opt(v, v + '×', ls.get('aq.pr.tempo', '0.75'))).join('')}</select></label>
        ${o.backingTracks && o.backingTracks.length ? `<label class="switch-row"><span class="switch"><input type="checkbox" data-pd="backing" ${ls.get('aq.pr.backing', '1') === '1' ? 'checked' : ''} /><i></i></span><span class="switch-text">${t('practice.backing')}</span></label>` : ''}
        <button type="button" class="button primary sm" data-pd="go">${ic('play')}${t('practice.start')}</button>
        <button type="button" class="button secondary sm" data-pd="skip" hidden>${t('practice.skip')}</button>
        <button type="button" class="button ghost sm" data-pd="cal">${t('practice.calibrate')}</button>
      </div>
      <p class="pd-note">${t('practice.privacy')}</p>`;
    document.body.appendChild(dock);
    document.body.classList.add('pd-open'); // เว้นที่ท้ายหน้าให้เลื่อนแท็บขึ้นมาเหนือแถบฝึกได้
    const state = cur.practice = { dock, session: null, follow: null, backing: null, hits: 0, judged: 0, nextI: -1 };
    const setRunning = (on) => dock.classList.toggle('running', on);
    // เลื่อนแท็บให้โน้ตถัดไปอยู่เหนือแถบฝึกเสมอ
    const followTab = (i) => {
      if (!o.tabEl || i < 0 || i === state.nextI) return;
      state.nextI = i;
      $$('.tab-note.next', o.tabEl).forEach((b) => b.classList.remove('next'));
      const b = o.tabEl.querySelector(`.tab-note[data-i="${i}"]`);
      if (!b) return;
      b.classList.add('next');
      const r = b.getBoundingClientRect(), dockTop = dock.getBoundingClientRect().top;
      if (r.bottom > dockTop - 16 || r.top < 90) {
        const y = scrollY + r.top - Math.max(100, (dockTop - r.height) * 0.4);
        scrollTo({ top: Math.max(0, y), behavior: A().motionOn() ? 'smooth' : 'auto' });
      }
    };
    const nm = (m) => (m == null ? '—' : Music.SHARP[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1));
    $$('[data-pm]', dock).forEach((b) => b.addEventListener('click', () => { ls.set('aq.pr.mode', b.dataset.pm); $$('[data-pm]', dock).forEach((x) => x.classList.toggle('active', x === b)); }));
    $('[data-pd="tempo"]', dock).addEventListener('change', (e) => ls.set('aq.pr.tempo', e.target.value));
    const bk = $('[data-pd="backing"]', dock); if (bk) bk.addEventListener('change', () => ls.set('aq.pr.backing', bk.checked ? '1' : '0'));
    $('[data-pd="close"]', dock).addEventListener('click', stopPractice);
    const markTab = (idx, cls) => {
      if (!o.tabEl) return;
      idx.forEach((i) => {
        const b = o.tabEl.querySelector(`.tab-note[data-i="${i}"]`);
        if (b) { b.classList.remove('hit', 'miss', 'off'); b.classList.add(cls); }
      });
    };
    const ensureSession = () => state.session ? Promise.resolve(state.session) : Practice.open({
      audioContext: Music.audioCtx(),
      onFrame: (f) => {
        const lv = $('#pdLevel', dock); if (lv) lv.style.width = Math.max(0, Math.min(100, (f.level + 60) * 1.7)) + '%';
        const h = $('#pdHeard', dock); if (h) h.textContent = f.midi != null && f.conf > 0.5 ? nm(f.midi) : '—';
      },
    }).then((s) => { state.session = s; return s; });
    $('[data-pd="cal"]', dock).addEventListener('click', () => {
      ensureSession().then((s) => s.calibrate()).then((ms) => {
        if (ms == null) { A().toast(t('practice.calFail'), { kind: 'warn' }); return; }
        ls.set('aq.pr.latency', String(Math.round(ms)));
        A().toast(tf('practice.calibrated', { ms: Math.round(ms) }), { kind: 'ok' });
      }).catch((e) => A().toast(micErrorText(e), { kind: 'warn', ms: 6000 }));
    });
    const goBtn = $('[data-pd="go"]', dock), skipBtn = $('[data-pd="skip"]', dock);
    goBtn.addEventListener('click', () => {
      if (state.follow) { // หยุดรอบปัจจุบัน
        try { state.follow.stop(); } catch (e) {}
        state.follow = null; setRunning(false);
        if (state.backing) { state.backing.destroy(); state.backing = null; }
        goBtn.innerHTML = `${ic('play')}${t('practice.start')}`; skipBtn.hidden = true;
        return;
      }
      ensureSession().then((s) => {
        if (!cur || cur.practice !== state) return;
        const mode = ls.get('aq.pr.mode', 'wait');
        const tempo = parseFloat(ls.get('aq.pr.tempo', '0.75')) || 0.75;
        state.hits = 0; state.judged = 0;
        if (o.tabEl) $$('.tab-note', o.tabEl).forEach((b) => b.classList.remove('hit', 'miss', 'off'));
        const startAt = expected.length ? Math.max(0, expected[0].t - 1.5) : 0;
        A().keepAwake(true);
        // ดนตรีประกอบกับนาฬิกาตัดสินเริ่มที่เวลา AudioContext เดียวกัน (ถ้าใช้นาฬิกาเดียวกันได้)
        const wantBacking = mode === 'timed' && bk && bk.checked && o.backingTracks && o.backingTracks.length;
        const ctxStart = s.clockShared !== false ? s.audioContext.currentTime + 0.15 : null;
        const lat = parseFloat(ls.get('aq.pr.latency', ''));
        state.follow = s.follow(expected, {
          mode, tempo, startAt, latencyMs: Number.isFinite(lat) ? lat : undefined,
          at: wantBacking && ctxStart != null ? ctxStart : undefined,
          onTime: (tm) => {
            const ni = expected.findIndex((e) => e.t + 0.05 >= tm), next = expected[ni];
            const tg = $('#pdTarget', dock); if (tg) tg.textContent = next ? (next.chord || nm(next.midi)) : '—';
            followTab(ni);
          },
          onJudge: (j) => {
            const right = j.result === 'hit' || j.result === 'early' || j.result === 'late';
            state.judged++; if (right) state.hits++;
            markTab(Array.isArray(j.idx) && j.idx.length ? j.idx : [j.i], j.result === 'hit' ? 'hit' : right ? 'off' : 'miss');
            if (j.result === 'early' || j.result === 'late') { const h = $('#pdHeard', dock); if (h) h.title = tf('practice.offTime', { w: t('practice.' + j.result) }); }
            $('#pdScore', dock).textContent = Math.round((state.hits / Math.max(1, state.judged)) * 100) + '%';
            $('#pdCount', dock).textContent = `${state.hits}/${state.judged}`;
          },
          onDone: (sum) => {
            const p = sum && sum.accuracy != null ? Math.round(sum.accuracy * 100) : Math.round((state.hits / Math.max(1, state.judged)) * 100);
            A().toast(tf('practice.done', { p, h: sum ? sum.hits : state.hits, n: sum ? (sum.hits + sum.misses) : state.judged }), { kind: 'ok', ms: 6000 });
            state.follow = null; setRunning(false); goBtn.innerHTML = `${ic('play')}${t('practice.start')}`; skipBtn.hidden = true;
            if (o.tabEl) $$('.tab-note.next', o.tabEl).forEach((b) => b.classList.remove('next'));
            if (state.backing) { state.backing.destroy(); state.backing = null; }
            A().keepAwake(false);
          },
        });
        // ดนตรีประกอบ (ปิดแทร็กที่ฝึก) — เฉพาะโหมดตามจังหวะ
        if (wantBacking) {
          state.backing = Mixer.create({ tracks: o.backingTracks });
          state.backing.setTempo(tempo);
          state.backing.play(startAt, ctxStart);
        }
        goBtn.innerHTML = `${ic('stop')}${t('practice.stop')}`;
        skipBtn.hidden = mode !== 'wait';
        state.nextI = -1; setRunning(true);
      }).catch((e) => {
        if (e && e.code === 'busy' && state.session) return; // กำลัง calibrate อยู่
        A().toast(micErrorText(e), { kind: 'warn', ms: 6000 });
      });
    });
    skipBtn.addEventListener('click', () => { if (state.follow && state.follow.skip) state.follow.skip(); });
  }
  // ฝึกคอร์ดทั้งเพลง (ใช้จากหน้าเพลง)
  function practiceChords(song) {
    const tl = chordTimeline(song);
    const exp = tl.map((e, i) => ({ t: e.t, d: Math.max(0.5, (tl[i + 1] ? tl[i + 1].t : e.t + 2) - e.t), chord: e.chord }));
    practiceNotes(exp, { label: A().t('practice.chords') });
  }

  window.TracksUI = { mount, teardown, practiceChords, monoTop, toMelody };
})();
