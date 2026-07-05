/* demo.js — เพลงสาธิต (แต่งเอง ปลอดลิขสิทธิ์) + fake pipeline
   *** โหมดสาธิต: จำลอง pipeline 6 ขั้นตามเอกสาร docs/02/03/05 ***
   เมื่อมี backend จริง ให้แทน runFakePipeline ด้วยการเรียก POST /api/jobs (docs/03) */
(function () {
  const STAGES = ['ingest', 'separate', 'chords', 'lyrics', 'tabs', 'assemble'];

  // เพลงสาธิตแต่งเอง — ไม่มีลิขสิทธิ์ของผู้อื่น
  const DEMO_SONGS = [
    {
      title: 'Clear Water / คลื่นใส',
      artist: 'AquaChord Demo',
      creator: 'AquaChord AI',
      key: 'C',
      tempo: '92',
      capo: 0,
      chordpro:
`{title: Clear Water / คลื่นใส}
{artist: AquaChord Demo}
{key: C}
{tempo: 92}

{c: Intro}
[C] [G] [Am] [F]

{sov}
[C]มองทะเลสีคราม [G]ลมพัดผ่านหัวใจ
[Am]ฟองคลื่นขาวละไม [F]ลอยไปตามสายลม
[C]แสงแดดทอประกาย [G]สะท้อนบนผืนน้ำ
[Am]ใจที่เคยระกำ [F]ค่อยสงบลงตรงนี้
{eov}

{soc}
[F]ปล่อยใจ[G]ล่องลอย [Em]ไปกับ[Am]คลื่น
[F]ให้ทะเล[G]กล่อมเกลา หัว[C]ใจ
[F]โอบไอ[G]ทะเล [Em]อุ่นละ[Am]มุน
[Dm]คืนความสดใส [G]กลับคืน[C]มา
{eoc}`,
    },
    {
      title: 'Emerald Morning / เช้ามรกต',
      artist: 'AquaChord Demo',
      creator: 'AquaChord AI',
      key: 'G',
      tempo: '76',
      capo: 2,
      chordpro:
`{title: Emerald Morning / เช้ามรกต}
{artist: AquaChord Demo}
{key: G}
{tempo: 76}

{sov}
[G]Sunlight on the [D]water so clear
[Em]Morning is [C]calling me here
[G]Green of the [D]hills meets the [Em]sea
[C]This is where [D]I want to [G]be
{eov}

{soc}
[C]Breathe in the [G]emerald air
[D]Let all your [Em]worries go
[C]Float on the [G]tide without a [D]care
[C]Slow, so [D]slow[G]
{eoc}`,
    },
  ];

  function buildSongDoc(base) {
    return Object.assign({
      id: Store.uid(),
      schemaVersion: 1,
      tabs: [],
      source: { kind: 'demo' },
      confidence: { chords: 0.82, lyrics: 0.78 },
      isPublic: false,
      favorite: 0,
      playCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, base);
  }

  // จำลอง pipeline: เรียก onProgress ทีละขั้น แล้ว resolve เป็น SongDoc
  function runFakePipeline(input, onProgress, signal) {
    return new Promise((resolve, reject) => {
      let i = 0;
      const pick = DEMO_SONGS[Math.floor(Math.random() * DEMO_SONGS.length)];
      const doc = buildSongDoc(JSON.parse(JSON.stringify(pick)));
      // ถ้าเป็น url ให้ตั้ง source
      if (input.kind === 'url') doc.source = { kind: 'url', ref: input.url };
      else if (input.kind === 'file') doc.source = { kind: 'upload', ref: input.name };

      function tick() {
        if (signal && signal.aborted) { reject(new Error('cancelled')); return; }
        if (i >= STAGES.length) {
          onProgress({ stage: 'done', percent: 100 });
          setTimeout(() => resolve(doc), 350);
          return;
        }
        const stage = STAGES[i];
        const pct = Math.round(((i + 1) / STAGES.length) * 100);
        onProgress({ stage, percent: pct });
        i++;
        setTimeout(tick, 850 + Math.random() * 700);
      }
      setTimeout(tick, 400);
    });
  }

  window.Demo = { STAGES, DEMO_SONGS, runFakePipeline, buildSongDoc };
})();
