// 地面の標高（国土地理院 標高タイル dem_png・約 10m メッシュ）から対地高度を出す
import { lonToX, latToY, TILE_CACHE } from './tiles.js';

export const DEM_Z = 14;
export const demUrl = (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${DEM_Z}/${x}/${y}.png`;

const tiles = new Map(); // "x/y" -> { data: ImageData | null, loading, failed }

function loadTile(x, y, onLoad) {
  const key = `${x}/${y}`;
  const t = { data: null, loading: true, failed: false };
  tiles.set(key, t);
  if (tiles.size > 40) tiles.delete(tiles.keys().next().value);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      t.data = ctx.getImageData(0, 0, 256, 256).data;
    } catch { t.failed = true; }
    t.loading = false;
    onLoad && onLoad();
  };
  img.onerror = () => { t.loading = false; t.failed = true; };
  img.src = demUrl(x, y);
  return t;
}

// 標高 [m]。まだ読めていない・日本の外（データなし）は null
export function elevation(lat, lon, onLoad) {
  const fx = lonToX(lon, DEM_Z), fy = latToY(lat, DEM_Z);
  const x = Math.floor(fx), y = Math.floor(fy);
  const t = tiles.get(`${x}/${y}`) || loadTile(x, y, onLoad);
  if (!t.data) return null;
  const px = Math.min(255, Math.floor((fx - x) * 256)), py = Math.min(255, Math.floor((fy - y) * 256));
  const i = (py * 256 + px) * 4;
  const v = t.data[i] * 65536 + t.data[i + 1] * 256 + t.data[i + 2];
  if (v === 8388608) return null; // 無効値（海など）
  return (v >= 8388608 ? v - 16777216 : v) * 0.01;
}

// オフライン保存用: 半径内の標高タイル
export function demUrlsAround(lat, lon, radiusM) {
  const dLat = (radiusM / 6378137) * (180 / Math.PI);
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const x0 = Math.floor(lonToX(lon - dLon, DEM_Z)), x1 = Math.floor(lonToX(lon + dLon, DEM_Z));
  const y0 = Math.floor(latToY(lat + dLat, DEM_Z)), y1 = Math.floor(latToY(lat - dLat, DEM_Z));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(demUrl(x, y));
  return out;
}

export { TILE_CACHE };
