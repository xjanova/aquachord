/* trackstore.js — เก็บแทร็กเครื่องดนตรีที่แกะได้ (TrackSet) ไว้ใน IndexedDB แยกจาก SongDoc
   (ข้อมูลโน้ตหลายพันตัวต่อเพลง — localStorage จุไม่พอ) · เบราว์เซอร์ที่ไม่มี IndexedDB (โหมดส่วนตัวบางตัว)
   → เก็บในหน่วยความจำระหว่างเปิดหน้า และแจ้งผ่าน TrackStore.persistent = false */
(function () {
  const DB = 'aquachord', STORE = 'tracks', VER = 1;
  const mem = new Map();
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        if (!window.indexedDB) { resolve(null); return; }
        const req = indexedDB.open(DB, VER);
        req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      if (!db) { api.persistent = false; resolve(fn(null)); return; }
      try {
        const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
        const r = fn(st);
        // r = IDBRequest → ค่าของคำขอ (ไม่พบคีย์ = undefined → null) — อย่าคืนตัว request เอง (truthy)
        t.oncomplete = () => resolve(typeof IDBRequest !== 'undefined' && r instanceof IDBRequest ? (r.result === undefined ? null : r.result) : r);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      } catch (e) { reject(e); }
    }));
  }

  const api = {
    persistent: true,
    get(id) { return tx('readonly', (st) => (st ? st.get(id) : mem.get(id) || null)).then((r) => r || null).catch(() => mem.get(id) || null); },
    put(id, value) { mem.set(id, value); return tx('readwrite', (st) => (st ? st.put(value, id) : null)).then(() => true).catch(() => false); },
    del(id) { mem.delete(id); return tx('readwrite', (st) => (st ? st.delete(id) : null)).then(() => true).catch(() => false); },
    clear() { mem.clear(); return tx('readwrite', (st) => (st ? st.clear() : null)).then(() => true).catch(() => false); },
  };
  window.TrackStore = api;
})();
