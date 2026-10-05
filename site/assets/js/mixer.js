/* mixer.js — เล่นแทร็กเครื่องดนตรีที่แกะได้ (TrackSet) พร้อมกันทั้งวง แบบ MIDI player
   เลือกเปิด/ปิด (mute) · เดี่ยว (solo) · ความดังรายแทร็ก · ความเร็ว ×0.5–1.25 · เลื่อนตำแหน่ง
   จัดคิวด้วยนาฬิกา Web Audio (มองล่วงหน้า 0.35 วิ) · เสียงจาก music.js (กลองสังเคราะห์/เบส/กีตาร์/เปียโน/ลีด/เสียงร้อง) */
(function () {
  // เสียงที่ใช้เล่นแต่ละแทร็ก
  const VOICE = { drums: 'drum', bass: 'bass', guitar: 'guitar', piano: 'piano', harmony: 'piano', melody: 'lead', vocals: 'voice', other: 'lead', fingerstyle: 'guitar' };
  const GAIN = { drums: 0.9, bass: 0.95, guitar: 0.8, piano: 0.75, harmony: 0.55, melody: 0.7, vocals: 0.75, other: 0.5, fingerstyle: 0.9 };

  function create(trackSet, opts) {
    opts = opts || {};
    const c = Music.audioCtx();
    const tracks = (trackSet.tracks || []).filter((t) => t && Array.isArray(t.notes) && t.notes.length);
    const state = {};
    tracks.forEach((t) => { state[t.id] = { mute: false, solo: false, vol: 1 }; });
    let duration = 0;
    tracks.forEach((t) => t.notes.forEach((n) => { duration = Math.max(duration, (+n.t || 0) + (+n.d || 0)); }));
    const events = [];
    tracks.forEach((t) => t.notes.forEach((n) => events.push({ tr: t.id, n })));
    events.sort((a, b) => a.n.t - b.n.t);

    let bus = null, gains = {}, playing = false, t0 = 0, from = 0, tempo = 1, idx = 0, timer = 0, gen = 0;
    const listeners = { time: [], end: [] };

    function audible(id) {
      const anySolo = Object.keys(state).some((k) => state[k].solo);
      const s = state[id];
      return !!s && !s.mute && (!anySolo || s.solo);
    }
    function applyGains() {
      Object.keys(gains).forEach((id) => {
        const g = gains[id].gain, v = audible(id) ? (GAIN[id] || 0.7) * state[id].vol : 0;
        g.cancelScheduledValues(c.currentTime); g.setTargetAtTime(v, c.currentTime, 0.02);
      });
    }
    function build() {
      bus = c.createGain(); bus.gain.value = 1;
      bus.connect(Music.output());
      gains = {};
      tracks.forEach((t) => { const g = c.createGain(); g.connect(bus); gains[t.id] = g; });
      applyGains();
      Object.keys(gains).forEach((id) => { gains[id].gain.value = audible(id) ? (GAIN[id] || 0.7) * state[id].vol : 0; });
    }
    function now() { return playing ? Math.min(duration, from + (c.currentTime - t0) * tempo) : from; }

    function pump(g) {
      if (!playing || g !== gen) return;
      const horizon = c.currentTime + 0.35;
      while (idx < events.length) {
        const e = events[idx];
        const at = t0 + (e.n.t - from) / tempo;
        if (at > horizon) break;
        idx++;
        if (at < c.currentTime - 0.05) continue; // ตกหล่น (แท็บพื้นหลัง) → ข้าม ไม่ระเบิดเสียงทีเดียว
        const tr = tracks.find((x) => x.id === e.tr);
        const voice = VOICE[e.tr] || (tr && tr.kind === 'drums' ? 'drum' : 'piano');
        const vel = Math.max(0.15, Math.min(1, +e.n.vel || 0.8));
        Music.noteAt(e.n.midi, Math.max(at, c.currentTime), Math.max(0.05, (+e.n.d || 0.25) / tempo), (voice === 'drum' ? 1 : 0.34) * vel, { voice, dest: gains[e.tr] });
      }
      if (idx >= events.length && now() >= duration - 0.01) { stopInternal(true); return; }
      timer = setTimeout(() => pump(g), 60);
    }
    function emitTime() {
      if (!playing) return;
      const t = now();
      listeners.time.forEach((fn) => { try { fn(t); } catch (e) {} });
      requestAnimationFrame(emitTime);
    }
    function stopInternal(ended) {
      playing = false; gen++; clearTimeout(timer);
      if (bus) {
        try { bus.gain.cancelScheduledValues(c.currentTime); bus.gain.setTargetAtTime(0, c.currentTime, 0.015); } catch (e) {}
        const old = bus; setTimeout(() => { try { old.disconnect(); } catch (e) {} }, 400);
        bus = null;
      }
      if (ended) { from = 0; listeners.end.forEach((fn) => { try { fn(); } catch (e) {} }); }
      listeners.time.forEach((fn) => { try { fn(from); } catch (e) {} });
    }

    const api = {
      tracks, duration,
      get playing() { return playing; },
      get time() { return now(); },
      get tempo() { return tempo; },
      play(at, ctxStart) { // ctxStart = เวลา AudioContext ที่ให้ตำแหน่ง at เริ่มดัง (ซิงก์กับตัวฝึกผ่านไมค์)
        if (playing) stopInternal(false);
        if (at != null) from = Math.max(0, Math.min(duration, at));
        if (from >= duration - 0.05) from = 0;
        build();
        playing = true; gen++;
        t0 = ctxStart != null && ctxStart > c.currentTime + 0.01 ? ctxStart : c.currentTime + 0.08;
        idx = 0; while (idx < events.length && events[idx].n.t < from - 0.02) idx++;
        pump(gen); emitTime();
      },
      pause() { if (!playing) return; from = now(); stopInternal(false); },
      stop() { from = 0; if (playing) stopInternal(false); else listeners.time.forEach((fn) => fn(0)); },
      seek(t) { const was = playing; if (was) stopInternal(false); from = Math.max(0, Math.min(duration, t)); if (was) api.play(); else listeners.time.forEach((fn) => fn(from)); },
      setTempo(f) { const t = now(); tempo = Math.max(0.25, Math.min(2, f)); if (playing) { from = t; api.play(); } },
      setMute(id, b) { if (state[id]) { state[id].mute = !!b; applyGains(); } },
      setSolo(id, b) { if (state[id]) { state[id].solo = !!b; applyGains(); } },
      setVolume(id, v) { if (state[id]) { state[id].vol = Math.max(0, Math.min(1.5, v)); applyGains(); } },
      state(id) { return Object.assign({ audible: audible(id) }, state[id]); },
      onTime(fn) { listeners.time.push(fn); },
      onEnd(fn) { listeners.end.push(fn); },
      destroy() { stopInternal(false); listeners.time = []; listeners.end = []; },
    };
    return api;
  }

  window.Mixer = { create, VOICE };
})();
