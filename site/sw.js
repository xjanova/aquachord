/* AquaChord service worker — precache app shell, offline-first */
const CACHE = 'aquachord-1.4.0';
// แคชไฟล์ภายนอกที่โหลดตอนใช้งาน (ตัววาดโน้ต abcjs + เสียงเปียโน soundfont) — ไม่ลบตอนอัปเดตแอป
// → เปิดโน้ต/เล่นเสียงออฟไลน์ได้หลังใช้ครั้งแรก · จำกัดจำนวนไฟล์กันเครื่องเต็ม
const RT_CACHE = 'aquachord-rt-1';
const RT_MAX = 400;
const ASSETS = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/notation.css',
  './assets/favicon.svg',
  './assets/logo.png',
  './assets/logo-mark.png',
  './assets/mascot.webp',
  './assets/mascot-sm.webp',
  './assets/js/i18n.js',
  './assets/js/music.js',
  './assets/js/chordpro.js',
  './assets/js/store.js',
  './assets/js/notation.js',
  './assets/js/notation-editor.js',
  './assets/js/dsp.js',
  './assets/js/lyrics.js',
  './assets/js/lyrics-worker.js',
  './assets/js/analyze.js',
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
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== RT_CACHE).map((k) => caches.delete(k))))
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
  // abcjs (เวอร์ชันตรึง + SRI) และไฟล์เสียง soundfont: cache-first (ไฟล์ไม่เปลี่ยนตาม URL)
  if (isRuntimeAsset(url)) {
    e.respondWith(
      caches.open(RT_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) c.put(req, res.clone()).then(() => trimCache(c)).catch(() => {});
        return res;
      })))
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

function isRuntimeAsset(url) {
  return (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/abcjs@')) ||
    (url.hostname === 'paulrosen.github.io' && url.pathname.startsWith('/midi-js-soundfonts/'));
}

// เก็บไม่เกิน RT_MAX ไฟล์ — ลบตัวเก่าสุดก่อน (keys() เรียงตามลำดับที่ใส่)
function trimCache(c) {
  return c.keys().then((keys) => {
    if (keys.length <= RT_MAX) return undefined;
    return Promise.all(keys.slice(0, keys.length - RT_MAX).map((k) => c.delete(k)));
  });
}
