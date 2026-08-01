// FC Pocket サービスワーカー
// ネットワーク優先 + キャッシュフォールバック:
// オンライン時は常に最新版を取得し、オフライン時はキャッシュで動作する
const CACHE = 'fcp-v2';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/main.js',
  './js/nes.js',
  './js/cpu.js',
  './js/ppu.js',
  './js/apu.js',
  './js/mappers.js',
  './js/demo.js',
  './js/qix.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
