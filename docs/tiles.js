// 背景地図（タイル）の読み込み・描画・オフライン保存
import { decodeTile } from './mvt.js';

export const TILE_CACHE = 'hg-tiles';
const R = 6378137;

const GSI = (id, ext = 'png') => `https://cyberjapandata.gsi.go.jp/xyz/${id}/{z}/{x}/{y}.${ext}`;

// sources を上から順に重ねて描く。op: 'multiply' は下の地図に影を掛け合わせる
export const LAYERS = {
  // 飛ぶ時にパッと見て分かるよう、地形の影の上に主な道路・川・鉄道だけを描く（文字・記号なし）
  simple: {
    name: 'シンプル（道路＋地形）', attr: '出典: 国土地理院', wash: 0,
    sources: [
      { url: GSI('hillshademap'), max: 16, wash: 0.55 },
      { url: GSI('experimental_bvmap', 'pbf'), max: 16, vector: true },
    ],
  },
  terrain: {
    name: '地形だけ', attr: '出典: 国土地理院', wash: 0.5,
    sources: [{ url: GSI('hillshademap'), max: 16 }],
  },
  'gsi-std': { name: '地理院 標準地図', attr: '出典: 国土地理院', sources: [{ url: GSI('std'), max: 18 }] },
  'gsi-photo': { name: '地理院 航空写真', attr: '出典: 国土地理院', sources: [{ url: GSI('seamlessphoto', 'jpg'), max: 18 }] },
  otm: {
    name: 'OpenTopoMap（等高線）', attr: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    sources: [{ url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', max: 17 }],
  },
};

const fill = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

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
  const urls = [];
  for (const src of LAYERS[layer].sources) {
    const zMax = Math.min(src.max, radiusM <= 6000 ? 16 : 15);
    for (let z = 8; z <= zMax; z++) {
      for (const t of tilesAround(lat, lon, z <= 11 ? Math.max(radiusM, 30000) : radiusM, z)) urls.push(fill(src.url, t.z, t.x, t.y));
    }
  }
  return urls;
}

// ---- 画面表示用のタイル（メモリ上） ----

const mem = new Map(); // url -> { img, ok, failed }
let onLoad = () => {};
export function setOnTileLoad(fn) { onLoad = fn; }

function getTile(tpl, z, x, y, request) {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return null;
  const url = fill(tpl, z, x, y);
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
export function drawTiles(ctx, layer, P, center, pxPerM, radiusPx, dpr, night = false) {
  const L = LAYERS[layer];
  if (!L) return;
  for (const src of L.sources) {
    ctx.save();
    ctx.globalCompositeOperation = src.op || 'source-over';
    ctx.globalAlpha = src.alpha ?? 1;
    if (src.vector) drawVectorSource(ctx, src, P, center, pxPerM, radiusPx, dpr);
    else drawSource(ctx, src, P, center, pxPerM, radiusPx, dpr);
    ctx.restore();
    if (src.wash) {
      // 影を薄くして、上に描く道路を目立たせる
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = night ? `rgba(0,0,0,${src.wash})` : `rgba(255,255,255,${src.wash})`;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
    }
  }
}

// ---- ベクトルタイル（道路・川・鉄道） ----

const vmem = new Map(); // url -> { ok, failed, items }

// 線の種類ごとの見た目（幅は画面上の px）。上から順に描く
const STYLE = {
  water: { fill: '#a9cfee' },
  river: { color: '#8dbbe8', width: 1.1 }, // 小さな川・用水路が多いので細く薄く
  rail: { color: '#6b6b6b', width: 2 },
  road3: { color: '#ffffff', width: 1.6, casing: '#7a7a7a' }, // 市町村道（広いものだけ）
  road1: { color: '#fff7c2', width: 2.6, casing: '#8a7a3a' }, // 都道府県道
  road0: { color: '#ffd24a', width: 3.4, casing: '#8a6400' }, // 国道
  roadX: { color: '#f08a24', width: 4.2, casing: '#7a3d00' }, // 高速道路
};
const ORDER = ['water', 'river', 'rail', 'road3', 'road1', 'road0', 'roadX'];

function roadKind(p) {
  if (p.motorway === 1 || p.rdCtg === 3) return 'roadX';
  if (p.rdCtg === 0) return 'road0';
  if (p.rdCtg === 1) return 'road1';
  return (p.rnkWidth ?? 0) >= 2 ? 'road3' : null; // 細い道は出さない
}

function buildItems(layers) {
  const items = {};
  const add = (kind, f) => {
    const path = new Path2D();
    for (const part of f.parts) {
      part.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    }
    (items[kind] ||= []).push(path);
  };
  const ext = (layers.road || layers.river || layers.waterarea || layers.railway || { extent: 4096 }).extent;
  for (const f of (layers.waterarea || {}).features || []) if (f.type === 3) add('water', f);
  for (const f of (layers.river || {}).features || []) if (f.type === 2) add('river', f);
  for (const f of (layers.railway || {}).features || []) if (f.type === 2) add('rail', f);
  for (const f of (layers.road || {}).features || []) {
    const k = f.type === 2 && roadKind(f.props);
    if (k) add(k, f);
  }
  return { items, ext };
}

function getVector(tpl, z, x, y) {
  const url = fill(tpl, z, x, y);
  let t = vmem.get(url);
  if (t) { vmem.delete(url); vmem.set(url, t); return t; }
  t = { ok: false, failed: false, items: null, ext: 4096 };
  vmem.set(url, t);
  if (vmem.size > 300) vmem.delete(vmem.keys().next().value);
  fetch(url, { mode: 'cors' })
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    .then((buf) => {
      const b = buildItems(decodeTile(buf, ['road', 'river', 'waterarea', 'railway']));
      t.items = b.items; t.ext = b.ext; t.ok = true; onLoad();
    })
    .catch(() => { t.failed = true; });
  return t;
}

function drawVectorSource(ctx, src, P, center, pxPerM, radiusPx, dpr) {
  // 道路は拡大しても線のままなので、細かすぎる道が増えないよう少し粗いズームを使う
  const z = zoomFor(pxPerM, center.lat, src.max, 1);
  const tiles = tilesAround(center.lat, center.lon, radiusPx / pxPerM, z);
  if (tiles.length > 120) return;
  const drawn = [];
  for (const { x, y } of tiles) {
    const t = getVector(src.url, z, x, y);
    if (!t.ok) continue;
    const p0 = P(yToLat(y, z), xToLon(x, z));
    const p1 = P(yToLat(y, z), xToLon(x + 1, z));
    const p2 = P(yToLat(y + 1, z), xToLon(x, z));
    const k = t.ext;
    drawn.push({ t, m: [(dpr * (p1[0] - p0[0])) / k, (dpr * (p1[1] - p0[1])) / k, (dpr * (p2[0] - p0[0])) / k, (dpr * (p2[1] - p0[1])) / k, dpr * p0[0], dpr * p0[1]], unit: k / Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) });
  }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // 種類ごとに全タイルを描く（道路の縁取りが他のタイルの道に重ならないように）
  for (const kind of ORDER) {
    const st = STYLE[kind];
    for (const pass of st.casing ? ['casing', 'fill'] : ['fill']) {
      for (const { t, m, unit } of drawn) {
        const paths = t.items[kind];
        if (!paths) continue;
        ctx.setTransform(...m);
        for (const path of paths) {
          if (st.fill) { ctx.fillStyle = st.fill; ctx.fill(path); continue; }
          ctx.strokeStyle = pass === 'casing' ? st.casing : st.color;
          ctx.lineWidth = (pass === 'casing' ? st.width + 2 : st.width) * unit;
          ctx.stroke(path);
        }
      }
    }
  }
}

function drawSource(ctx, src, P, center, pxPerM, radiusPx, dpr) {
  const z = zoomFor(pxPerM, center.lat, src.max, dpr);
  const radiusM = radiusPx / pxPerM;
  const tiles = tilesAround(center.lat, center.lon, radiusM, z);
  if (tiles.length > 300) return;
  for (const { x, y } of tiles) {
    // 読めていなければ親タイル（粗い地図）の一部を引き伸ばして使う
    let t = getTile(src.url, z, x, y, true), dz = 0;
    while ((!t || !t.ok) && dz < 4 && z - dz > 0) {
      dz++;
      t = getTile(src.url, z - dz, x >> dz, y >> dz, t && t.failed);
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
    // 継ぎ目が出ないよう少し重ねる（影の重ね掛けは重ねると線が出るのでぴったり）
    const d = src.op ? 256 : 256.8;
    ctx.drawImage(t.img, sx, sy, sz, sz, 0, 0, d, d);
  }
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
  vmem.clear();
  try { await caches.delete(TILE_CACHE); } catch { /* なし */ }
}
