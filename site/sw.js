/* AquaChord service worker — precache app shell, offline-first */
const CACHE = 'aquachord-1.0.0';
const ASSETS = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/favicon.svg',
  './assets/logo.png',
  './assets/logo-mark.png',
  './assets/js/i18n.js',
  './assets/js/music.js',
  './assets/js/chordpro.js',
  './assets/js/store.js',
  './assets/js/demo.js',
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
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // อย่าแตะ backend หรือหลังบ้าน — ให้วิ่ง network ตรง ๆ (กัน API/หน้าแอดมินถูกแคช)
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/'))) return;
  // Google Fonts: stale-while-revalidate
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(
      caches.open(CACHE).then((c) => c.match(req).then((hit) => {
        const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }))
    );
    return;
  }
  if (url.origin !== location.origin) return;
  // app shell: cache-first, fall back to network, then index for navigations
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => req.mode === 'navigate' ? caches.match('./index.html') : undefined))
  );
});
