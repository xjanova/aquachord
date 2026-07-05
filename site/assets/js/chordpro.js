/* chordpro.js — parse ChordPro + render คอร์ดเหนือเนื้อร้อง + transpose */
(function () {
  const DIRECTIVE_RE = /^\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}$/;
  const SECTION_LABELS = {
    sov: 'Verse', eov: null, soc: 'Chorus', eoc: null,
    sob: 'Bridge', eob: null, soi: 'Intro', eoi: null,
  };

  // parse -> { meta, lines: [{type:'label'|'chords'|'lyric'|'blank', ...}] }
  function parse(text) {
    const meta = {};
    const lines = [];
    (text || '').split(/\r?\n/).forEach((raw) => {
      const line = raw.replace(/\s+$/,'');
      const dm = line.trim().match(DIRECTIVE_RE);
      if (dm) {
        const name = dm[1].toLowerCase();
        const val = dm[2];
        if (['title','t'].includes(name)) meta.title = val;
        else if (['artist','st','subtitle'].includes(name)) meta.artist = val;
        else if (name === 'key') meta.key = val;
        else if (['tempo','bpm'].includes(name)) meta.tempo = val;
        else if (name === 'capo') meta.capo = val;
        else if (name === 'c' || name === 'comment') lines.push({ type: 'label', text: val });
        else if (SECTION_LABELS[name] !== undefined) {
          if (SECTION_LABELS[name]) lines.push({ type: 'label', text: SECTION_LABELS[name] });
        }
        return;
      }
      if (line.trim() === '') { lines.push({ type: 'blank' }); return; }
      lines.push({ type: 'line', segs: splitLine(line) });
    });
    return { meta, lines };
  }

  // "[C]hello [G]world" -> [{chord:'C',text:'hello '},{chord:'G',text:'world'}]
  function splitLine(line) {
    const segs = [];
    const re = /\[([^\]]+)\]/g;
    let last = 0, m;
    let pendingChord = null;
    while ((m = re.exec(line)) !== null) {
      const text = line.slice(last, m.index);
      if (text || pendingChord !== null) segs.push({ chord: pendingChord, text });
      pendingChord = m[1];
      last = re.lastIndex;
    }
    const tail = line.slice(last);
    segs.push({ chord: pendingChord, text: tail });
    return segs;
  }

  // render -> HTML string. opts: {steps, keyHint, onlyChordsLine}
  function render(text, opts) {
    opts = opts || {};
    const { lines } = parse(text);
    const steps = opts.steps || 0;
    const keyHint = opts.keyHint;
    let html = '';
    lines.forEach((ln) => {
      if (ln.type === 'label') {
        html += `<div class="cp-section-label">${esc(ln.text)}</div>`;
      } else if (ln.type === 'blank') {
        html += `<div class="cp-line blank"></div>`;
      } else if (ln.type === 'line') {
        html += `<div class="cp-line">`;
        ln.segs.forEach((s) => {
          let chordHtml = '';
          if (s.chord != null) {
            const disp = steps ? Music.transposeChord(s.chord, steps, keyHint) : s.chord;
            const playable = Music.isChord(s.chord);
            chordHtml = `<span class="seg-chord${playable ? '' : ' na'}" data-chord="${esc(disp)}">${esc(disp)}</span>`;
          } else {
            chordHtml = `<span class="seg-chord empty-chord"></span>`;
          }
          html += `<span class="seg">${chordHtml}<span class="seg-text">${esc(s.text) || ''}</span></span>`;
        });
        html += `</div>`;
      }
    });
    return html || `<div class="muted">—</div>`;
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }

  window.ChordPro = { parse, render };
})();
