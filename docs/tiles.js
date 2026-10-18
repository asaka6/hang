// 背景地図（タイル）の読み込み・描画・オフライン保存

export const TILE_CACHE = 'hg-tiles';
const R = 6378137;

export const LAYERS = {
  simple: {
    name: 'シンプル（地形だけ）', max: 16, attr: '出典: 国土地理院', wash: 0.5,
    url: 'https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png',
  },
  'gsi-std': {
    name: '地理院 標準地図', max: 18, attr: '出典: 国土地理院',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
  },
  'gsi-pale': {
    name: '地理院 淡色地図', max: 18, attr: '出典: 国土地理院',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  },
  'gsi-photo': {
    name: '地理院 航空写真', max: 18, attr: '出典: 国土地理院',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  },
  otm: {
    name: 'OpenTopoMap（等高線）', max: 17, attr: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
  },
};

export const tileUrl = (layer, z, x, y) =>
  LAYERS[layer].url.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// Web メルカトルのタイル座標
const rad = (d) => (d * Math.PI) / 180;
export const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToY = (lat, z) =>
  ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * 2 ** z;
export const xToLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const yToLat = (y, z) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z)) * 180) / Math.PI;

// 画面の 1px にタイルの 1px が近くなるズーム
export function zoomFor(pxPerM, lat, max, dpr = 1) {
  // 高解像度の画面（iPhone など）では少し細かい地図を使ってくっきり見せる
  const z = Math.round(Math.log2((2 * Math.PI * R * Math.cos(rad(lat)) * pxPerM) / 256) + (dpr >= 2 ? 0.45 : 0));
  return Math.max(5, Math.min(max, z));
}

// 中心から半径 radiusM の範囲にかかるタイル
export function tilesAround(lat, lon, radiusM, z) {
  const dLat = (radiusM / R) * (180 / Math.PI);
  const dLon = dLat / Math.cos(rad(lat));
  const x0 = Math.floor(lonToX(lon - dLon, z)), x1 = Math.floor(lonToX(lon + dLon, z));
  const y0 = Math.floor(latToY(lat + dLat, z)), y1 = Math.floor(latToY(lat - dLat, z));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  return out;
}

// オフライン保存するタイルの一覧（広域は粗く、飛ぶ範囲は細かく）
export function tilesForSave(layer, lat, lon, radiusM) {
  const zMax = Math.min(LAYERS[layer].max, radiusM <= 6000 ? 16 : 15);
  let list = [];
  for (let z = 8; z <= zMax; z++) list = list.concat(tilesAround(lat, lon, z <= 11 ? Math.max(radiusM, 30000) : radiusM, z));
  return list.map((t) => tileUrl(layer, t.z, t.x, t.y));
}

// ---- 画面表示用のタイル（メモリ上） ----

const mem = new Map(); // url -> { img, ok, failed }
let onLoad = () => {};
export function setOnTileLoad(fn) { onLoad = fn; }

function getTile(layer, z, x, y, request) {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const url = tileUrl(layer, z, x, y);
  let t = mem.get(url);
  if (t) {
    mem.delete(url); mem.set(url, t); // LRU
    return t;
  }
  if (!request) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  t = { img, ok: false, failed: false };
  img.onload = () => { t.ok = true; onLoad(); };
  img.onerror = () => { t.failed = true; onLoad(); };
  img.src = url;
  mem.set(url, t);
  if (mem.size > 500) mem.delete(mem.keys().next().value);
  return t;
}

// P(lat, lon) -> [x, y] は画面座標（CSS px）への変換。回転していても良い。
// radiusPx: 中心（自機）から画面の一番遠い角までの距離
export function drawTiles(ctx, layer, P, center, pxPerM, radiusPx, dpr) {
  const L = LAYERS[layer];
  if (!L) return;
  const z = zoomFor(pxPerM, center.lat, L.max, dpr);
  const radiusM = radiusPx / pxPerM;
  const tiles = tilesAround(center.lat, center.lon, radiusM, z);
  if (tiles.length > 300) return;
  ctx.save();
  for (const { x, y } of tiles) {
    // 読めていなければ親タイル（粗い地図）の一部を引き伸ばして使う
    let t = getTile(layer, z, x, y, true), dz = 0;
    while ((!t || !t.ok) && dz < 4 && z - dz > 0) {
      dz++;
      t = getTile(layer, z - dz, x >> dz, y >> dz, t && t.failed);
    }
    if (!t || !t.ok) continue;
    const k = 2 ** dz, sz = 256 / k;
    const sx = (x % k) * sz, sy = (y % k) * sz;
    const p0 = P(yToLat(y, z), xToLon(x, z));
    const p1 = P(yToLat(y, z), xToLon(x + 1, z));
    const p2 = P(yToLat(y + 1, z), xToLon(x, z));
    ctx.setTransform(
      (dpr * (p1[0] - p0[0])) / 256, (dpr * (p1[1] - p0[1])) / 256,
      (dpr * (p2[0] - p0[0])) / 256, (dpr * (p2[1] - p0[1])) / 256,
      dpr * p0[0], dpr * p0[1],
    );
    ctx.drawImage(t.img, sx, sy, sz, sz, 0, 0, 256.8, 256.8); // 継ぎ目が出ないよう少し重ねる
  }
  ctx.restore();
}

// ---- オフライン保存 ----

export async function saveTiles(urls, onProgress) {
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) await cache.put(url, res);
          else if (res.status !== 404) failed++; // 海の上など、タイルが無い場所は 404
        }
      } catch { failed++; }
      done++;
      onProgress(done, urls.length, failed);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed };
}

export async function savedTileCount() {
  try { return (await (await caches.open(TILE_CACHE)).keys()).length; } catch { return 0; }
}

export async function clearTiles() {
  mem.clear();
  try { await caches.delete(TILE_CACHE); } catch { /* なし */ }
}
