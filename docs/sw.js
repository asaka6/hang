// オフラインで動かすためのサービスワーカー（アプリ本体をキャッシュ）
const CACHE = 'hg-v2.8.0';
const TILE_CACHE = 'hg-tiles'; // 地図タイル（アプリ更新でも消さない）
const TILE_HOSTS = ['cyberjapandata.gsi.go.jp', 'a.tile.opentopomap.org'];
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'calc.js', 'tiles.js', 'terrain.js', 'mvt.js',
  'presets/SHISHIKU_20260501.wpt', 'presets/2025Tonami_waypoint.wpt', 'presets/names-ja.json',
  'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ネットにつながる時は最新を取りに行き、つながらない時はキャッシュを使う
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 地図タイルは保存済みを優先（電波が無くても表示できる）
  if (TILE_HOSTS.includes(new URL(e.request.url).hostname)) {
    e.respondWith(
      caches.open(TILE_CACHE).then((c) => c.match(e.request.url).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) c.put(e.request.url, res.clone());
        return res;
      }))),
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
