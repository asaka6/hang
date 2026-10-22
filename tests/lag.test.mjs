import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';

// 半径 100m で 25 秒に 1 周。北側（方位 0°）ほどよく上がる、コアが北にずれたサーマル
const LAT = 36.45, LON = 136.64;
function circlingFixes(turns = 3) {
  const fixes = [];
  for (let s = 0; s <= turns * 25; s++) {
    const ang = (s / 25) * 2 * Math.PI; // 円の中心から見た方位（0 = 北）
    // 上昇率 1 + 1.5·cos(ang) を積分した高度
    const alt = 800 + s + 1.5 * (25 / (2 * Math.PI)) * Math.sin(ang);
    const p = C.fromXY(LAT, LON, 100 * Math.sin(ang), 100 * Math.cos(ang));
    fixes.push({ t: 1e12 + s * 1000, lat: p.lat, lon: p.lon, alt });
  }
  return fixes;
}

// 上昇率が一番強い点の、円の中心からの方位
function peakBearing(fixes, v) {
  let best = 0;
  for (let i = 5; i < fixes.length - 5; i++) if (v[i] > v[best] || best < 5) best = i;
  return C.bearing(LAT, LON, fixes[best].lat, fixes[best].lon);
}

test('trailing vario puts the core behind, centred vario puts it in the right place', () => {
  const fixes = circlingFixes();
  const trailing = fixes.map((_, i) => C.verticalSpeed(fixes.slice(0, i + 1), 3) ?? 0);
  const centred = fixes.map((_, i) => C.centeredVario(fixes, i) ?? 0);
  const late = C.norm180(peakBearing(fixes, trailing));
  const right = C.norm180(peakBearing(fixes, centred));
  assert.ok(Math.abs(late) >= 10, `trailing peak should lag behind north, got ${late}`);
  assert.ok(Math.abs(right) <= 5, `centred peak should be near north, got ${right}`);
});

test('analyzeFlight uses the lag-free vario', () => {
  const fixes = circlingFixes();
  const a = C.analyzeFlight(fixes);
  assert.ok(Math.abs(C.norm180(peakBearing(fixes, a.v))) <= 5);
});

test('centred vario at the newest point uses what is available', () => {
  const fixes = circlingFixes(1);
  const v = C.centeredVario(fixes, fixes.length - 1);
  assert.ok(v != null && Number.isFinite(v));
});
