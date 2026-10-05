/* AquaChord service worker — precache app shell, offline-first */
const CACHE = 'aquachord-1.7.0';
const ASSETS = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/brand/logo-520.webp',
  './assets/brand/mark-96.webp',
  './assets/brand/mark-64.png',
  './assets/guide/face-160.webp',
  './assets/mascot.webp',
  './assets/mascot-sm.webp',
  './assets/js/i18n.js',
  './assets/js/music.js',
  './assets/js/chordpro.js',
  './assets/js/store.js',
  './assets/js/dsp.js',
  './assets/js/lyricfix.js',
  './assets/js/riff.js',
  './assets/js/finger.js',
  './assets/js/practice.js',
  './assets/js/lyrics.js',
  './assets/js/lyrics-worker.js',
  './assets/js/stems.js',
  './assets/js/stems-worker.js',
  './assets/js/tracks.js',
  './assets/js/analyze.js',
  './assets/js/notation.js',
  './assets/js/midi.js',
  './assets/js/trackstore.js',
  './assets/js/mixer.js',
  './assets/js/tracksui.js',
  './assets/js/fx.js',
  './assets/js/guide.js',
  './assets/js/app.js',
  './manifest.webmanifest',
  './icons/pwa-192.png',
  './icons/pwa-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    // ลบเฉพาะแคชแอปเวอร์ชันเก่า — แคชโมเดล AI (aq-models-v1 / transformers-cache) ใหญ่หลายร้อย MB ต้องอยู่ข้ามการอัปเดต
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('aquachord-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // อย่าแตะ backend หรือหลังบ้าน — ให้วิ่ง network ตรง ๆ (กัน API/หน้าแอดมินถูกแคช)
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/'))) return;
  // คลิปวิดีโอไกด์ / คำขอแบบ Range → ปล่อยเบราว์เซอร์จัดการเอง (Cache API เก็บ 206 ไม่ได้)
  if (req.headers.has('range') || url.pathname.includes('/assets/guide/clips/')) return;
  // Google Fonts: stale-while-revalidate
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(
      caches.open(CACHE).then((c) => c.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }))
    );
    return;
  }
  if (url.origin !== location.origin) return;
  // app shell: cache-first, fall back to network, then index for navigations
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => req.mode === 'navigate' ? caches.match('./index.html') : undefined))
  );
});
