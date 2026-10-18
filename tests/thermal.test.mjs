import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';

const opts = { bestLD: 7.5, trimKmh: 35, margin: 100 };
const LAT = 36.45, LON = 136.64;

test('sun position', () => {
  // 東京 夏至の正午: 南、高い
  const noon = C.sunPosition(Date.UTC(2026, 5, 21, 2, 45), 35.7, 139.7);
  assert.ok(Math.abs(noon.az - 180) < 15, `az ${noon.az}`);
  assert.ok(noon.el > 70 && noon.el < 80, `el ${noon.el}`);
  // 獅子吼 10 月の朝 9 時: 南東、低め
  const am = C.sunPosition(Date.UTC(2026, 9, 18, 0, 0), LAT, LON);
  assert.ok(am.az > 115 && am.az < 150, `az ${am.az}`);
  assert.ok(am.el > 20 && am.el < 40, `el ${am.el}`);
  // 夜は地平線の下
  assert.ok(C.sunPosition(Date.UTC(2026, 9, 18, 14, 0), LAT, LON).el < 0);
});

test('clock direction', () => {
  assert.equal(C.clockDir(0, 0), 12);
  assert.equal(C.clockDir(90, 0), 3);
  assert.equal(C.clockDir(270, 0), 9);
  assert.equal(C.clockDir(10, 300), 2);
});

// 北に向かって上る斜面（= 南向きの斜面）。y=0 から北は 0.25 の勾配、その先は尾根
const southSlope = (lat, lon) => {
  const { y } = C.toXY(LAT, LON, lat, lon);
  return 100 + Math.max(0, Math.min(1500, y + 1000)) * 0.25;
};

test('terrain aspect and slope', () => {
  const tr = C.terrainAt(LAT, LON, southSlope);
  assert.ok(Math.abs(C.norm180(tr.aspect - 180)) < 1, `aspect ${tr.aspect}`);
  assert.ok(Math.abs(tr.slope - 0.25) < 0.01);
});

test('thermal candidate on a sunny slope', () => {
  const c = C.thermalCandidate({
    pos: { lat: LAT, lon: LON }, alt: 1000, t: Date.UTC(2026, 9, 18, 3, 0),
    landing: { lat: LAT - 0.01, lon: LON, alt: 100 }, opts, elev: southSlope,
    sun: { az: 180, el: 45 },
  });
  assert.ok(c, 'should find a candidate');
  assert.equal(c.reason, '日の当たる斜面');
  assert.ok(c.dist < 2500);
});

test('recent thermal wins when strong, and is skipped when it would not leave enough height to get home', () => {
  const th = C.fromXY(LAT, LON, 600, 0);
  const inp = {
    pos: { lat: LAT, lon: LON }, alt: 600, t: Date.UTC(2026, 9, 18, 3, 0),
    thermals: [{ lat: th.lat, lon: th.lon, climb: 2.5, t: Date.UTC(2026, 9, 18, 2, 55) }],
    landing: { lat: LAT, lon: LON, alt: 100 }, opts,
  };
  const c = C.thermalCandidate(inp);
  assert.equal(c.reason, 'さっき上がった場所');
  assert.ok(Math.abs(c.dist - 600) < 5);
  assert.ok(Math.abs(c.brg - 90) < 1);
  // 低くて、行ったら着陸地に帰れない
  assert.equal(C.thermalCandidate({ ...inp, alt: 300 }), null);
  // 上がらなかった軌跡が重なると点数が下がる
  const searched = C.thermalCandidate({ ...inp, recent: [{ lat: th.lat, lon: th.lon, v: -1 }] });
  assert.ok(searched.score < c.score);
});

test('prefers the previous candidate and places ahead', () => {
  const a = C.fromXY(LAT, LON, 0, 700), b = C.fromXY(LAT, LON, 0, -700); // 北と南に同じ強さ
  const inp = {
    pos: { lat: LAT, lon: LON }, alt: 900, t: 0, opts,
    thermals: [{ ...a, climb: 1.5, t: 0 }, { ...b, climb: 1.5, t: 0 }],
  };
  assert.ok(Math.abs(C.thermalCandidate({ ...inp, hdg: 0 }).brg) < 1 || C.thermalCandidate({ ...inp, hdg: 0 }).brg > 359); // 前（北）
  assert.ok(Math.abs(C.thermalCandidate({ ...inp, hdg: 180 }).brg - 180) < 1); // 前（南）
  // 南向きでも、前回の候補（北）があればそちらを続ける
  const prevNorth = C.thermalCandidate({ ...inp, hdg: 0 });
  const thermals = [{ ...a, climb: 1.5, t: 0 }, { ...b, climb: 1.6, t: 0 }];
  assert.ok(C.thermalCandidate({ ...inp, thermals, prev: prevNorth }).brg > 359 || C.thermalCandidate({ ...inp, thermals, prev: prevNorth }).brg < 1);
});

test('turn back warning', () => {
  // 着陸地は南（180°）、北へ飛んでいて余裕 40 m → 警告
  assert.equal(C.turnBackNeeded(40, 180, 0), true);
  // 着陸地へ向かっている時は言わない
  assert.equal(C.turnBackNeeded(40, 180, 170), false);
  // 余裕が十分なら言わない
  assert.equal(C.turnBackNeeded(200, 180, 0), false);
});
