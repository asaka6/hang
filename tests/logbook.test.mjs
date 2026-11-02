import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';

const LAT = 36.443, LON = 136.638, T0 = Date.UTC(2026, 9, 31, 3, 0, 0);

// 区間ごとに一定速度で飛ぶ点列。legs: [{ hdg, sec, spd(m/s), sink(m/s) }]
function path(legs, alt0 = 300) {
  const out = [];
  let x = 0, y = 0, alt = alt0, t = T0;
  for (const L of legs) {
    for (let k = 0; k < L.sec; k++) {
      const r = (L.hdg * Math.PI) / 180;
      x += L.spd * Math.sin(r); y += L.spd * Math.cos(r); alt -= L.sink ?? 0; t += 1000;
      const p = C.fromXY(LAT, LON, x, y);
      out.push({ t, lat: p.lat, lon: p.lon, alt });
    }
  }
  return out;
}

test('IGC round trip', () => {
  const fx = path([{ hdg: 90, sec: 120, spd: 10, sink: 1 }]);
  const igc = C.toIGC(fx, { pilot: 'Taro', glider: 'Sport 2' });
  const r = C.parseIGC(igc);
  assert.equal(r.pilot, 'Taro');
  assert.equal(r.glider, 'Sport 2');
  assert.equal(r.fixes.length, fx.length);
  assert.equal(r.fixes[0].t, fx[0].t);
  assert.ok(Math.abs(r.fixes[50].lat - fx[50].lat) < 1e-4 && Math.abs(r.fixes[50].lon - fx[50].lon) < 1e-4);
  assert.equal(r.fixes[50].alt, Math.round(fx[50].alt));
});

test('trimFlight cuts waiting at takeoff and walking after landing', () => {
  const fx = path([
    { hdg: 0, sec: 120, spd: 0 },      // テイクオフで待つ
    { hdg: 0, sec: 4, spd: 5 },        // 助走
    { hdg: 200, sec: 300, spd: 11, sink: 1 },
    { hdg: 200, sec: 3, spd: 3 },      // 減速して着地
    { hdg: 90, sec: 300, spd: 1.2 },   // 担いで歩く
  ]);
  const tr = C.trimFlight(fx);
  const startSec = (tr[0].t - T0) / 1000, endSec = (tr[tr.length - 1].t - T0) / 1000;
  assert.ok(startSec >= 119 && startSec <= 122, `start ${startSec}`);
  assert.ok(endSec >= 424 && endSec <= 430, `end ${endSec}`);
});

test('approach: downwind, base and final are found on a left-hand pattern', () => {
  // 北へダウンウィンド 400m → 西へベース 200m → 南へファイナル 250m（左回り）
  const fx = path([
    { hdg: 0, sec: 40, spd: 10, sink: 1.2 },
    { hdg: 270, sec: 20, spd: 10, sink: 1.2 },
    { hdg: 180, sec: 25, spd: 10, sink: 1.6 },
  ], 150);
  const ground = 0;
  const a = C.analyzeApproach(fx, (f) => f.alt - ground, { lat: fx.at(-1).lat, lon: fx.at(-1).lon });
  assert.deepEqual(a.legs.map((l) => l.type), ['downwind', 'base', 'final']);
  assert.ok(Math.abs(C.norm180(a.finalHdg - 180)) < 3);
  assert.equal(a.side, 'left'); // ベース(西) → ファイナル(南) は左旋回 = 左回り
  const [dw, base, fin] = a.legs;
  assert.ok(dw.length > 300 && dw.length < 420, `downwind ${dw.length}`);
  assert.ok(base.length > 140 && base.length < 220, `base ${base.length}`);
  assert.ok(fin.length > 200 && fin.length < 260, `final ${fin.length}`);
  assert.ok(fin.aglStart > 30 && fin.aglStart < 80, `final AGL ${fin.aglStart}`);
  assert.equal(a.toLd, 0);
  assert.deepEqual(a.hints, []);
});

test('approach hints: short high final, far from the landing, no downwind', () => {
  const fx = path([
    { hdg: 270, sec: 30, spd: 10, sink: 0.5 },
    { hdg: 180, sec: 7, spd: 10, sink: 1 },
  ], 200);
  const a = C.analyzeApproach(fx, (f) => f.alt, C.fromXY(LAT, LON, 0, 2000));
  assert.ok(a.hints.some((h) => /ダウンウィンド/.test(h)));
  assert.ok(a.hints.some((h) => /ファイナルが短め/.test(h)));
  assert.ok(a.hints.some((h) => /高め/.test(h)));
  assert.ok(a.hints.some((h) => /ランディングから/.test(h)));
});

test('logbook stats and CSV', () => {
  const y = new Date().getFullYear();
  const logs = [
    { start: Date.UTC(y, 3, 1, 1), end: Date.UTC(y, 3, 1, 1, 10), place: '獅子吼', glider: 'Falcon', maxAlt: 700, dist: 4000 },
    { start: Date.UTC(y, 4, 1, 1), end: Date.UTC(y, 4, 1, 1, 30), place: '獅子吼', glider: 'Falcon', maxAlt: 900, dist: 9000, memo: 'サーマル "2本"' },
    { start: Date.UTC(y - 1, 4, 1, 1), end: Date.UTC(y - 1, 4, 1, 1, 5), place: 'つくばね', glider: 'Falcon' },
  ];
  const s = C.logbookStats(logs);
  assert.equal(s.count, 3);
  assert.equal(s.sec, 45 * 60);
  assert.equal(s.yearCount, 2);
  assert.equal(s.yearSec, 40 * 60);
  assert.deepEqual(s.byPlace.map((p) => [p.name, p.count]), [['獅子吼', 2], ['つくばね', 1]]);
  assert.equal(s.longest, logs[1]);
  const csv = C.logbookCSV(logs);
  assert.ok(csv.startsWith('﻿"No","日付"'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[1].includes('"つくばね"'));
  assert.ok(lines[3].includes('"サーマル ""2本"""'));
  assert.ok(lines[3].includes('"0:30:00"'));
});
