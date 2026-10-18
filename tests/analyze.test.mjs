import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';
import { createSim } from './sim.js';

test('analyze a flight with glides and thermals', () => {
  // 5 秒待機 → 40 秒滑空 → 75 秒旋回（+2 m/s）→ 40 秒滑空 → 75 秒旋回
  const sim = createSim({ start: Date.UTC(2026, 9, 18, 3, 0), windSpeed: 3, windFrom: 270 });
  const fixes = [];
  for (let i = 0; i < 240; i++) {
    const f = sim.step(1);
    fixes.push({ t: f.t, lat: f.lat, lon: f.lon, alt: f.alt });
  }
  const a = C.analyzeFlight(fixes);
  assert.equal(a.thermals.length, 2, JSON.stringify(a.thermals.map((t) => [t.start, t.end])));
  for (const th of a.thermals) {
    assert.ok(Math.abs(th.climb - 2) < 0.3, `climb ${th.climb}`);
    assert.ok(th.sec > 55 && th.sec < 80, `sec ${th.sec}`);
  }
  assert.ok(Math.abs(a.stats.maxClimb - 2) < 0.2);
  assert.ok(Math.abs(a.stats.maxSink + 1.1) < 0.2);
  assert.equal(a.stats.sec, 239);
  assert.ok(a.stats.track > 1500);
  assert.equal(a.stats.thermalCount, 2);
  assert.ok(a.stats.bestThermal.climb > 1.7);
  // 滑空中は上昇率がマイナス
  assert.ok(Math.abs(a.v[30] + 1.1) < 0.05);
});

test('analyze copes with tiny logs', () => {
  const a = C.analyzeFlight([{ t: 0, lat: 36, lon: 136, alt: 100 }]);
  assert.equal(a.thermals.length, 0);
  assert.equal(a.stats.sec, 0);
});
