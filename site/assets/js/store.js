/* store.js — คลังเพลง + ตั้งค่า (localStorage) */
(function () {
  const KEY = 'aq.songs.v1';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch (e) { return []; }
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
    if (i >= 0) { list[i] = Object.assign({}, list[i], song); }
    else {
      song.createdAt = song.createdAt || now;
      song.favorite = song.favorite || 0;
      song.playCount = song.playCount || 0;
      list.push(song);
    }
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
      format: 'aquachord-export', version: 1, exportedAt: Date.now(), songs: load(),
    }, null, 2);
  }

  function importJSON(text) {
    const data = JSON.parse(text);
    if (data.format !== 'aquachord-export' || !Array.isArray(data.songs)) throw new Error('bad format');
    const list = load();
    let added = 0;
    data.songs.forEach((s) => {
      if (!s.id || !s.title) return;
      const i = list.findIndex((x) => x.id === s.id);
      if (i >= 0) list[i] = s; else { list.push(s); }
      added++;
    });
    saveAll(list);
    return added;
  }

  function uid() {
    return 'sg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  window.Store = { all, get, upsert, remove, toggleFav, markPlayed, count, exportJSON, importJSON, uid };
})();
