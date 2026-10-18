import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';
import { createSim } from '../docs/sim.js';

function fly(seconds, opts) {
  const sim = createSim({ start: Date.UTC(2026, 9, 18, 2, 0, 0), ...opts });
  const fixes = [];
  for (let i = 0; i < seconds; i++) fixes.push(sim.step(1));
  return fixes;
}

test('distance and bearing', () => {
  const d = C.distance(35, 139, 35, 140);
  assert.ok(Math.abs(d - 91290) < 300, d);
  assert.ok(Math.abs(C.bearing(35, 139, 36, 139)) < 0.01);
  assert.ok(Math.abs(C.bearing(35, 139, 35, 140) - 90) < 1);
});

test('wind estimate while circling', () => {
  // 5 s 待機 + 40 s 滑空 + 60 s 旋回
  const fixes = fly(105, { windSpeed: 5, windFrom: 300, airspeed: 11 });
  const w = C.estimateWind(fixes);
  assert.ok(w, 'wind should be estimated');
  assert.ok(Math.abs(w.speed - 5) < 0.3, `speed ${w.speed}`);
  assert.ok(Math.abs(C.norm180(w.from - 300)) < 3, `from ${w.from}`);
  assert.ok(Math.abs(w.airspeed - 11) < 0.3, `airspeed ${w.airspeed}`);
});

test('no wind estimate on straight glide', () => {
  const fixes = fly(40);
  assert.equal(C.estimateWind(fixes), null);
});

test('vertical speed and glide ratio', () => {
  const fixes = fly(40); // 滑空中 -1.1 m/s
  assert.ok(Math.abs(C.verticalSpeed(fixes) + 1.1) < 0.01);
  const ld = C.glideRatio(fixes, 20);
  assert.ok(ld > 5 && ld < 20, `ld ${ld}`);
  const climbing = fly(90);
  assert.ok(Math.abs(C.verticalSpeed(climbing) - 2) < 0.01);
  assert.ok(C.turnRate(climbing) > 10);
});

test('ground glide with wind', () => {
  const w = { speed: 5, from: 0 }; // 北風
  assert.equal(C.groundGlide(10, 36, 90, null), 10);
  assert.ok(C.groundGlide(10, 36, 180, w) > 14); // 追い風
  assert.ok(C.groundGlide(10, 36, 0, w) < 6); // 向かい風
  assert.equal(C.groundGlide(10, 18, 0, w), 0); // 進めない
});

test('goal info', () => {
  const g = C.goalInfo({ lat: 36, lon: 140 }, 1000, { lat: 36.09, lon: 140, alt: 0 }, { bestLD: 10, trimKmh: 36, margin: 0 }, null);
  assert.ok(Math.abs(g.dist - 10008) < 20);
  assert.ok(Math.abs(g.arrival - (1000 - g.dist / 10)) < 0.01);
  assert.ok(Math.abs(g.reqLD - g.dist / 1000) < 0.01);
});

test('cup parsing', () => {
  const cup = `name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc
"Ashio TO","ASTO",JP,3622.500N,13923.250E,1000.0m,1,,,,
"LZ, main","LZ",JP,3620.000N,13920.000E,200ft,3,,,,
-----Related Tasks-----
"task"`;
  const w = C.parseWaypoints(cup, 'a.cup');
  assert.equal(w.length, 2);
  assert.equal(w[0].name, 'Ashio TO');
  assert.ok(Math.abs(w[0].lat - (36 + 22.5 / 60)) < 1e-9);
  assert.ok(Math.abs(w[0].lon - (139 + 23.25 / 60)) < 1e-9);
  assert.equal(w[0].alt, 1000);
  assert.equal(w[1].name, 'LZ, main');
  assert.ok(Math.abs(w[1].alt - 60.96) < 0.01);
  assert.equal(w[1].landing, true);
  assert.equal(w[0].landing, false);
});

test('IGC output', () => {
  const fixes = [
    { t: Date.UTC(2026, 9, 18, 3, 4, 5, 200), lat: 36.5, lon: 139.25, alt: 1234.4 },
    { t: Date.UTC(2026, 9, 18, 3, 4, 5, 900), lat: 36.5, lon: 139.25, alt: 1234 },
    { t: Date.UTC(2026, 9, 18, 3, 4, 6), lat: -0.5, lon: -1.999999, alt: -5 },
  ];
  const igc = C.toIGC(fixes, { pilot: 'Taro', glider: 'Wills Wing' }).split('\r\n');
  assert.ok(igc[0].startsWith('AXXX'));
  assert.ok(igc.includes('HFDTEDATE:181026,01'));
  assert.ok(igc.includes('HFPLTPILOTINCHARGE:Taro'));
  const b = igc.filter((l) => l.startsWith('B'));
  assert.equal(b.length, 2);
  assert.equal(b[0], 'B0304053630000N13915000EA0000001234');
  assert.equal(b[1], 'B0304060030000S00200000WA00000-0005');
  for (const l of b) assert.equal(l.length, 35);
});
