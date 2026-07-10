/* i18n — ไทย/อังกฤษ สลับได้ เก็บใน localStorage */
(function () {
  const DICT = {
    th: {
      'install': 'ติดตั้งแอป',
      'nav.home': 'แกะเพลง',
      'nav.library': 'คลังเพลง',
      'nav.settings': 'ตั้งค่า',

      'hero.badge': 'ขับเคลื่อนด้วย AI',
      'hero.title1': 'แกะคอร์ดทุกเพลง',
      'hero.title2': 'ด้วยพลัง AI',
      'hero.lead': 'วางลิงก์วิดีโอหรืออัปโหลดไฟล์เสียง แล้วให้ AI แกะคอร์ด เนื้อเพลง และแท็บกีตาร์ให้ทันที ฟังเสียงโน้ตได้ แก้ไขได้ บันทึกไว้เล่นซ้ำได้',

      'ingest.url': 'จากลิงก์',
      'ingest.file': 'อัปโหลดไฟล์',
      'ingest.urlPlaceholder': 'วางลิงก์ YouTube หรือลิงก์ไฟล์เสียง...',
      'ingest.dropTitle': 'ลากไฟล์มาวาง หรือแตะเพื่อเลือก',
      'ingest.dropHint': 'รองรับ mp3, wav, m4a, flac, ogg, opus',
      'ingest.dropFile': 'เลือกไฟล์แล้ว:',
      'ingest.start': 'เริ่มแกะเพลง',
      'ingest.copyright': 'ใช้เพื่อการศึกษาส่วนตัวเท่านั้น · คุณต้องมีสิทธิ์ในไฟล์เสียงที่นำมาแกะ',
      'ingest.needInput': 'กรุณาวางลิงก์หรือเลือกไฟล์ก่อน',
      'ingest.badUrl': 'ลิงก์ไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
      'ingest.urlNotSupported': 'ลิงก์วิดีโอ/สตรีมมิงยังแกะไม่ได้ — ดาวน์โหลดเป็นไฟล์เสียง (mp3, m4a...) แล้วอัปโหลดแทน',

      'recent.title': 'เล่นล่าสุด',
      'recent.viewAll': 'ดูทั้งหมด',

      'job.title': 'กำลังแกะเพลง...',
      'job.cancel': 'ยกเลิก',
      'job.stage.ingest': 'อ่านไฟล์เสียง',
      'job.stage.prep': 'เตรียมสัญญาณเสียง',
      'job.stage.beats': 'จับจังหวะ (BPM)',
      'job.stage.chords': 'วิเคราะห์คอร์ด',
      'job.stage.key': 'หาคีย์เพลง',
      'job.stage.assemble': 'ประกอบเป็นแผ่นคอร์ด',
      'job.done': 'แกะเพลงเสร็จแล้ว!',
      'job.realNote': 'วิเคราะห์บนเครื่องของคุณ 100% — ไฟล์เสียงไม่ถูกอัปโหลดขึ้นเซิร์ฟเวอร์',
      'job.err.decode': 'อ่านไฟล์เสียงนี้ไม่ได้ — ไฟล์อาจเสียหรือเบราว์เซอร์ไม่รองรับฟอร์แมตนี้',
      'job.err.short': 'ไฟล์เสียงสั้นเกินไป (ต้องยาวอย่างน้อย 5 วินาที)',
      'job.err.fetch': 'ดึงไฟล์จากลิงก์ไม่สำเร็จ (ปลายทางไม่อนุญาต) — ดาวน์โหลดไฟล์แล้วอัปโหลดแทน',
      'job.err.tooBig': 'ไฟล์ใหญ่เกิน 80 MB — ลองแปลงเป็น mp3 ก่อน',
      'job.err.generic': 'เกิดข้อผิดพลาดระหว่างแกะเพลง กรุณาลองใหม่',
      'sheet.header': 'AI วิเคราะห์บนเครื่อง',
      'sheet.aiNote': 'คอร์ดจากการวิเคราะห์อัตโนมัติ อาจคลาดเคลื่อนบางช่วง — แตะ "แก้ไข" เพื่อปรับได้',
      'sheet.noChords': 'ไม่พบคอร์ดชัดเจนในไฟล์นี้ — อาจเป็นเสียงพูดหรือเพอร์คัชชันล้วน',

      'library.title': 'คลังเพลงของฉัน',
      'library.search': 'ค้นหาเพลง ศิลปิน หรือผู้แกะ...',
      'library.all': 'ทั้งหมด',
      'library.fav': 'รายการโปรด',
      'library.empty.title': 'ยังไม่มีเพลงในคลัง',
      'library.empty.desc': 'เริ่มแกะเพลงแรกของคุณได้เลย แล้วเพลงจะถูกบันทึกไว้ที่นี่',
      'library.empty.cta': 'แกะเพลงแรก',
      'library.count': 'เพลง',
      'library.by': 'แกะโดย',
      'library.plays': 'เล่น',
      'library.delete': 'ลบเพลงนี้?',
      'library.deleteDesc': 'การลบไม่สามารถย้อนกลับได้',
      'library.deleted': 'ลบเพลงแล้ว',

      'song.transpose': 'คีย์',
      'song.capo': 'คาโป้',
      'song.fontSize': 'ขนาดตัวอักษร',
      'song.scroll': 'เลื่อนอัตโนมัติ',
      'song.play': 'เล่นคอร์ด',
      'song.edit': 'แก้ไข',
      'song.tapHint': 'แตะที่คอร์ดเพื่อฟังเสียง',
      'song.notFound': 'ไม่พบเพลงนี้',
      'song.strum': 'ดีดทั้งเพลง',
      'song.original': 'คีย์เดิม',

      'editor.title': 'แก้ไขเพลง',
      'editor.new': 'สร้างเพลงใหม่',
      'editor.songTitle': 'ชื่อเพลง',
      'editor.artist': 'ศิลปิน',
      'editor.creator': 'ผู้แกะ',
      'editor.key': 'คีย์',
      'editor.body': 'คอร์ดและเนื้อเพลง (ChordPro)',
      'editor.preview': 'ตัวอย่าง',
      'editor.save': 'บันทึก',
      'editor.saved': 'บันทึกแล้ว',
      'editor.leaveConfirm': 'ออกโดยไม่บันทึกการเปลี่ยนแปลง?',
      'editor.help': 'ใส่คอร์ดในวงเล็บเหลี่ยม เช่น [C] [Am] วางไว้หน้าคำที่ต้องการ',

      'settings.title': 'ตั้งค่า',
      'settings.language': 'ภาษา',
      'settings.languageDesc': 'เปลี่ยนภาษาของแอป',
      'settings.data': 'ข้อมูล',
      'settings.export': 'ส่งออกเพลงทั้งหมด',
      'settings.exportDesc': 'บันทึกเป็นไฟล์ .json ไว้สำรองหรือย้ายเครื่อง',
      'settings.import': 'นำเข้าเพลง',
      'settings.importDesc': 'นำเข้าจากไฟล์ .aquachord.json',
      'settings.imported': 'นำเข้าเพลงแล้ว',
      'settings.exported': 'ส่งออกแล้ว',
      'settings.about': 'เกี่ยวกับ',
      'settings.copyright': 'นโยบายลิขสิทธิ์',
      'settings.copyrightDesc': 'อ่านก่อนเผยแพร่เพลง',
      'settings.version': 'เวอร์ชัน',

      'copyright.title': 'ก่อนเริ่มใช้ AquaChord',
      'copyright.p1': 'AquaChord ช่วยแกะคอร์ด เนื้อเพลง และแท็บด้วย AI เพื่อการเรียนรู้และฝึกซ้อมส่วนตัว',
      'copyright.li1': 'ผลการแกะจะถูกเก็บไว้ในเครื่องของคุณเท่านั้น จนกว่าคุณจะเลือกแชร์เอง',
      'copyright.li2': 'เพลงส่วนใหญ่มีลิขสิทธิ์ การนำไปเผยแพร่หรือใช้เชิงพาณิชย์ต้องได้รับอนุญาต',
      'copyright.li3': 'โปรดใช้ไฟล์เสียงที่คุณมีสิทธิ์ใช้งาน',
      'copyright.accept': 'ยอมรับและเริ่มใช้งาน',

      'toast.installed': 'ติดตั้งแอปแล้ว',
      'common.cancel': 'ยกเลิก',
      'common.confirm': 'ยืนยัน',
      'common.close': 'ปิด',
      'common.back': 'กลับ',
    },
    en: {
      'install': 'Install App',
      'nav.home': 'Transcribe',
      'nav.library': 'Library',
      'nav.settings': 'Settings',

      'hero.badge': 'Powered by AI',
      'hero.title1': 'Transcribe any song',
      'hero.title2': 'with AI',
      'hero.lead': 'Paste a video link or upload an audio file, and let AI extract chords, lyrics, and guitar tabs instantly. Hear the notes, edit freely, and save for later.',

      'ingest.url': 'From link',
      'ingest.file': 'Upload file',
      'ingest.urlPlaceholder': 'Paste a YouTube or audio file link...',
      'ingest.dropTitle': 'Drag a file here, or tap to choose',
      'ingest.dropHint': 'Supports mp3, wav, m4a, flac, ogg, opus',
      'ingest.dropFile': 'Selected file:',
      'ingest.start': 'Start transcribing',
      'ingest.copyright': 'For personal study only · You must have rights to the audio you transcribe',
      'ingest.needInput': 'Please paste a link or choose a file first',
      'ingest.badUrl': 'Invalid link, please check again',
      'ingest.urlNotSupported': 'Video/streaming links are not supported yet — download the audio (mp3, m4a...) and upload it instead',

      'recent.title': 'Recently played',
      'recent.viewAll': 'View all',

      'job.title': 'Transcribing...',
      'job.cancel': 'Cancel',
      'job.stage.ingest': 'Reading audio file',
      'job.stage.prep': 'Preparing signal',
      'job.stage.beats': 'Detecting tempo (BPM)',
      'job.stage.chords': 'Analyzing chords',
      'job.stage.key': 'Finding the key',
      'job.stage.assemble': 'Assembling chord sheet',
      'job.done': 'Transcription complete!',
      'job.realNote': '100% on-device analysis — your audio never leaves this device',
      'job.err.decode': 'Could not read this audio file — it may be corrupted or unsupported by this browser',
      'job.err.short': 'Audio is too short (needs at least 5 seconds)',
      'job.err.fetch': 'Could not fetch from that link (blocked by the source) — download the file and upload it instead',
      'job.err.tooBig': 'File exceeds 80 MB — try converting to mp3 first',
      'job.err.generic': 'Something went wrong while transcribing, please try again',
      'sheet.header': 'analyzed on-device by AI',
      'sheet.aiNote': 'Chords are auto-detected and may be off in places — tap "Edit" to fix them',
      'sheet.noChords': 'No clear chords found — this may be speech or percussion only',

      'library.title': 'My Library',
      'library.search': 'Search songs, artists, or transcribers...',
      'library.all': 'All',
      'library.fav': 'Favorites',
      'library.empty.title': 'No songs yet',
      'library.empty.desc': 'Transcribe your first song and it will be saved here.',
      'library.empty.cta': 'Transcribe first song',
      'library.count': 'songs',
      'library.by': 'by',
      'library.plays': 'plays',
      'library.delete': 'Delete this song?',
      'library.deleteDesc': 'This action cannot be undone.',
      'library.deleted': 'Song deleted',

      'song.transpose': 'Key',
      'song.capo': 'Capo',
      'song.fontSize': 'Font size',
      'song.scroll': 'Auto-scroll',
      'song.play': 'Play chords',
      'song.edit': 'Edit',
      'song.tapHint': 'Tap a chord to hear it',
      'song.notFound': 'Song not found',
      'song.strum': 'Strum whole song',
      'song.original': 'Original key',

      'editor.title': 'Edit Song',
      'editor.new': 'New Song',
      'editor.songTitle': 'Song title',
      'editor.artist': 'Artist',
      'editor.creator': 'Transcriber',
      'editor.key': 'Key',
      'editor.body': 'Chords & lyrics (ChordPro)',
      'editor.preview': 'Preview',
      'editor.save': 'Save',
      'editor.saved': 'Saved',
      'editor.leaveConfirm': 'Leave without saving changes?',
      'editor.help': 'Put chords in square brackets like [C] [Am] before the word they land on.',

      'settings.title': 'Settings',
      'settings.language': 'Language',
      'settings.languageDesc': 'Change the app language',
      'settings.data': 'Data',
      'settings.export': 'Export all songs',
      'settings.exportDesc': 'Save as .json to back up or move devices',
      'settings.import': 'Import songs',
      'settings.importDesc': 'Import from an .aquachord.json file',
      'settings.imported': 'Songs imported',
      'settings.exported': 'Exported',
      'settings.about': 'About',
      'settings.copyright': 'Copyright policy',
      'settings.copyrightDesc': 'Read before publishing songs',
      'settings.version': 'Version',

      'copyright.title': 'Before you start',
      'copyright.p1': 'AquaChord uses AI to transcribe chords, lyrics, and tabs for personal learning and practice.',
      'copyright.li1': 'Results are stored only on your device until you choose to share them.',
      'copyright.li2': 'Most songs are copyrighted; publishing or commercial use needs permission.',
      'copyright.li3': 'Please only use audio you have the rights to.',
      'copyright.accept': 'Accept and start',

      'toast.installed': 'App installed',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.close': 'Close',
      'common.back': 'Back',
    },
  };

  const LANGS = ['th', 'en'];
  let current = localStorage.getItem('aq.lang') || 'th';
  if (!LANGS.includes(current)) current = 'th';

  const listeners = new Set();

  function t(key) {
    return (DICT[current] && DICT[current][key]) || (DICT.th[key]) || key;
  }

  function applyStatic(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    (root || document).querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
  }

  function setLang(lang) {
    if (!LANGS.includes(lang)) return;
    current = lang;
    localStorage.setItem('aq.lang', lang);
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);
    applyStatic();
    listeners.forEach((fn) => fn(lang));
  }

  function toggle() { setLang(current === 'th' ? 'en' : 'th'); }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function get() { return current; }

  document.documentElement.setAttribute('lang', current);
  document.documentElement.setAttribute('data-lang', current);

  window.I18N = { t, setLang, toggle, onChange, get, applyStatic, LANGS };
})();
