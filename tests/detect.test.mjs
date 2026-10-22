import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';

const LAT = 36.446, LON = 136.647, T0 = 1e12;
// 1 秒ごとの点を作る。seg: [{ sec, spd [km/h], agl(i) , alt(i), hdg }]
function track(segs, opts = {}) {
  const out = [];
  let x = 0, y = 0, t = T0, i = 0;
  const rnd = mulberry(opts.seed || 1);
  for (const s of segs) {
    for (let k = 0; k < s.sec; k++, i++) {
      const v = s.spd / 3.6, h = ((s.hdg ?? 0) * Math.PI) / 180;
      x += v * Math.sin(h) + (s.drift ?? 0); y += v * Math.cos(h);
      const nx = (opts.posNoise ?? 0) * (rnd() - 0.5), ny = (opts.posNoise ?? 0) * (rnd() - 0.5);
      const p = C.fromXY(LAT, LON, x + nx, y + ny);
      const agl = typeof s.agl === 'function' ? s.agl(k, rnd) : s.agl;
      out.push({ t, lat: p.lat, lon: p.lon, alt: (s.alt ? s.alt(k, rnd) : 600) , spd: v, agl, altAcc: s.altAcc ?? 5 });
      t += 1000;
    }
  }
  return out;
}
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 1 点ずつ増やしながら判定を走らせ、最初に離陸と判断した時刻を返す（実際のアプリと同じ使い方）
function firstTakeoff(fx) {
  for (let i = 1; i <= fx.length; i++) {
    const w = fx.slice(Math.max(0, i - 240), i);
    const t = C.detectTakeoff(w);
    if (t != null) return { t, at: fx[i - 1].t };
  }
  return null;
}
function firstLanding(fx, terrain = true) {
  for (let i = 1; i <= fx.length; i++) {
    const t = C.detectLanding(fx.slice(Math.max(0, i - 200), i), terrain);
    if (t != null) return t;
  }
  return null;
}

test('foot launch is detected and dated to the start of the run', () => {
  const fx = track([
    { sec: 30, spd: 0, agl: 2 },                      // テイクオフで準備
    { sec: 4, spd: 18, agl: 1 },                      // 助走
    { sec: 120, spd: 35, agl: null },                 // 飛行（地形データ無しでも判定できる）
  ]);
  const r = firstTakeoff(fx);
  assert.ok(r, 'takeoff should be detected');
  assert.equal(r.t, T0 + 30000);
  assert.ok(r.at - (T0 + 30000) <= 15000, 'within ~15 s of launch');
});

test('walking, aborted runs and GPS spikes are not takeoffs', () => {
  // テイクオフ周りを歩く・準備で動き回る
  const walk = track([{ sec: 600, spd: 5, hdg: 40, agl: 1 }, { sec: 60, spd: 9, agl: 1 }]);
  assert.equal(firstTakeoff(walk), null);
  // 助走して途中でやめる（4 秒だけ時速 20km）を何度か
  const abort = track([
    { sec: 30, spd: 0, agl: 1 }, { sec: 4, spd: 20, agl: 1 }, { sec: 30, spd: 0, agl: 1 },
    { sec: 5, spd: 22, agl: 1 }, { sec: 60, spd: 2, agl: 1 },
  ]);
  assert.equal(firstTakeoff(abort), null);
  // 止まっているのに GPS の速度が 2 秒だけ跳ねる
  const spike = track([{ sec: 60, spd: 0, agl: 1 }, { sec: 2, spd: 60, agl: 1 }, { sec: 60, spd: 0, agl: 1 }]);
  assert.equal(firstTakeoff(spike), null);
  // 位置の精度が悪い時は判定しない
  const fx = track([{ sec: 30, spd: 0, agl: 2 }, { sec: 120, spd: 35, agl: null }]);
  for (const f of fx) f.acc = 40;
  assert.equal(firstTakeoff(fx), null);
});

test('landing is detected after 90 seconds standing still on the ground', () => {
  const fx = track([
    { sec: 60, spd: 30, agl: 80 },
    { sec: 5, spd: 10, agl: 3 },
    { sec: 110, spd: 0, agl: (k, r) => 2 + r(), alt: (k, r) => 150 + (r() - 0.5) * 2 },
  ], { posNoise: 6, seed: 3 });
  const t = firstLanding(fx);
  assert.ok(t != null);
  assert.ok(t >= T0 + 64000 && t <= T0 + 70000, `landing start ${(t - T0) / 1000}`);
});

test('hovering in strong wind is never a landing', () => {
  // リッジで向かい風に浮く: 対地速度ほぼ 0、少しずつ流され、高さが揺れる
  const ridge = track([
    { sec: 300, spd: 1, hdg: 0, drift: 0.3, agl: (k) => 40 + 6 * Math.sin(k / 9), alt: (k) => 700 + 6 * Math.sin(k / 9) },
  ]);
  assert.equal(firstLanding(ridge), null);
  // 斜面すれすれ（対地 10m）でもほぼ止まって浮いている
  const low = track([
    { sec: 300, spd: 1, hdg: 180, drift: 0.2, agl: (k) => 10 + 4 * Math.sin(k / 7), alt: (k) => 650 + 4 * Math.sin(k / 7) },
  ]);
  assert.equal(firstLanding(low), null);
  // 高く上がったまま、GPS がほとんど動かない（対地 200m）
  const high = track([{ sec: 300, spd: 0, agl: 200, alt: (k, r) => 900 + (r() - 0.5) * 2 }], { posNoise: 4 });
  assert.equal(firstLanding(high), null);
});

test('without terrain data, landing needs 150 seconds standing still', () => {
  const still = (sec) => track([{ sec: 30, spd: 30, agl: null }, { sec, spd: 0, agl: null, alt: (k, r) => 150 + (r() - 0.5) * 2 }], { posNoise: 6 });
  assert.equal(firstLanding(still(120), false), null);
  assert.ok(firstLanding(still(160), false) != null);
});

test('landing is detected while walking away with the glider', () => {
  const fx = track([
    { sec: 60, spd: 30, agl: 80 },
    { sec: 6, spd: 15, agl: (k) => 12 - k * 2 },            // 進入して降りる
    { sec: 5, spd: 0, agl: 1 },
    { sec: 120, spd: 4, hdg: 90, agl: (k, r) => 1 + (r() - 0.5) * 8 }, // 担いで歩く（GPS の高さのばらつき込み）
  ], { seed: 5 });
  const at = (() => { for (let i = 1; i <= fx.length; i++) { const t = C.detectWalkingLanding(fx.slice(Math.max(0, i - 200), i)); if (t != null) return { t, i }; } return null; })();
  assert.ok(at, 'walking landing should be detected');
  assert.ok(at.t >= T0 + 60000 && at.t <= T0 + 67000, `touchdown ${(at.t - T0) / 1000}`);
  // 止まって判定するほうは、歩いていると判定しない
  assert.equal(firstLanding(fx), null);
});

test('walking rule never fires in flight', () => {
  // リッジで地面すれすれ（対地 10m）に浮いてゆっくり流れる
  const hover = track([{ sec: 300, spd: 3, hdg: 0, agl: (k) => 10 + 4 * Math.sin(k / 7) }]);
  for (let i = 1; i <= hover.length; i++) assert.equal(C.detectWalkingLanding(hover.slice(Math.max(0, i - 200), i)), null);
  // 地形データが無い時は判定しない
  const noTerrain = track([{ sec: 200, spd: 3, agl: null }]);
  assert.equal(C.detectWalkingLanding(noTerrain), null);
});

test('manual landing time goes back to touchdown, not when the button was pressed', () => {
  const fx = track([
    { sec: 60, spd: 30, agl: 80 },
    { sec: 4, spd: 12, agl: (k) => 10 - k * 3 },
    { sec: 200, spd: 4, agl: 1 },                            // 歩いてから「着陸した」を押す
  ]);
  const t = C.landingTime(fx);
  assert.ok(t >= T0 + 60000 && t <= T0 + 64000, `touchdown ${(t - T0) / 1000}`);
});
