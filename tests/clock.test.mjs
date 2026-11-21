import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 置き時計の計算部分は古い Safari 用の普通のスクリプトなので、vm で読み込んで試す
const ctx = {};
vm.runInNewContext(readFileSync(new URL('../docs/clock/clock-logic.js', import.meta.url), 'utf8'), ctx);
const L = ctx.ClockLogic;

test('time formatting 24h / 12h', () => {
  const d = new Date(2026, 10, 21, 0, 5, 9);
  assert.deepEqual({ ...L.formatTime(d, false) }, { main: '00:05', sec: '09', ampm: '' });
  assert.deepEqual({ ...L.formatTime(d, true) }, { main: '12:05', sec: '09', ampm: '午前' });
  assert.equal(L.formatTime(new Date(2026, 10, 21, 13, 0, 0), true).main, '1:00');
  assert.equal(L.formatTime(new Date(2026, 10, 21, 13, 0, 0), true).ampm, '午後');
});

test('date formatting with weekday', () => {
  assert.equal(L.formatDate(new Date(2026, 10, 21)), '11月21日（土）');
  assert.equal(L.formatDate(new Date(2026, 0, 4)), '1月4日（日）');
});

test('weather codes', () => {
  assert.equal(L.describe(0, 1).label, '快晴');
  assert.equal(L.describe(0, 0).icon, '🌙');
  assert.equal(L.describe(63, 1).label, '雨');
  assert.equal(L.describe(1234, 1).label, '—');
});

test('night range across midnight', () => {
  assert.equal(L.isNight(23, 22, 6), true);
  assert.equal(L.isNight(5, 22, 6), true);
  assert.equal(L.isNight(6, 22, 6), false);
  assert.equal(L.isNight(12, 22, 6), false);
  assert.equal(L.isNight(1, 0, 5), true);
  assert.equal(L.isNight(3, 7, 7), false);
});

const sample = {
  current: { time: '2026-11-21T17:45' },
  hourly: {
    time: ['2026-11-21T15:00', '2026-11-21T16:00', '2026-11-21T17:00', '2026-11-21T18:00', '2026-11-21T19:00'],
    temperature_2m: [12, 11.5, 10.2, 9.8, 9.1],
    apparent_temperature: [10, 9.4, 7.6, 6.9, 5.8],
    weather_code: [1, 2, 3, 61, 63],
    precipitation_probability: [0, 0, 10, 40, 70],
    is_day: [1, 1, 0, 0, 0],
  },
  daily: {
    time: ['2026-11-21', '2026-11-22', '2026-11-23'],
    weather_code: [3, 61, 0],
    temperature_2m_max: [14.4, 12.6, 16],
    temperature_2m_min: [6.5, 7.2, 4.4],
    precipitation_probability_max: [40, 80, 0],
  },
};

test('hourly forecast starts at the current hour', () => {
  const h = L.hourlyFrom(sample, 2);
  assert.equal(h.length, 2);
  assert.equal(h[0].hour, 17);
  assert.equal(h[0].now, true);
  assert.equal(h[1].hour, 18);
  assert.equal(h[1].pop, 40);
  assert.equal(h[0].feel, 7.6);
  assert.equal(h[1].now, false);
});

test('daily forecast labels', () => {
  const d = L.dailyFrom(sample, 7);
  assert.equal(d.length, 3);
  assert.equal(d[0].label, '今日');
  assert.equal(d[1].label, '明日');
  assert.equal(d[1].sunday, true);
  assert.equal(d[2].label, '月');
  assert.equal(d[0].max, 14);
  assert.equal(d[2].min, 4);
});

test('temperature graph points fit the box', () => {
  const pts = L.tempPoints([10, 12, 8, 9], 1000, 100, 10);
  assert.equal(pts.length, 4);
  for (const [x, y] of pts) {
    assert.ok(x > 0 && x < 1000);
    assert.ok(y >= 10 && y <= 90, String(y));
  }
  assert.ok(pts[1][1] < pts[2][1], 'warmer is higher');
});

test('temperature and feels-like share one scale', () => {
  const t = [10, 12];
  const f = [6, 8];
  const tp = L.tempPoints(t, 1000, 100, 10, f);
  const fp = L.tempPoints(f, 1000, 100, 10, t);
  assert.ok(fp[0][1] > tp[0][1], 'feels-like is drawn lower when colder');
  assert.equal(tp[1][1], 10);
  assert.equal(fp[0][1], 90);
});

test('hourly precipitation amount text', () => {
  assert.equal(L.formatMM(0), '-');
  assert.equal(L.formatMM(0.04), '-');
  assert.equal(L.formatMM(0.1), '0.1');
  assert.equal(L.formatMM(0.96), '1.0');
  assert.equal(L.formatMM(1.0), '1.0');
  assert.equal(L.formatMM(1.46), '1');
  assert.equal(L.formatMM(1.5), '2');
  assert.equal(L.formatMM(5.1), '5');
  assert.equal(L.formatMM(12.4), '12');
  assert.equal(L.formatMM(null), '');
});

test('precipitation chance in 10% steps', () => {
  assert.equal(L.roundPop(99), 100);
  assert.equal(L.roundPop(94), 90);
  assert.equal(L.roundPop(95), 100);
  assert.equal(L.roundPop(4), 0);
  assert.equal(L.roundPop(0), 0);
  assert.equal(L.roundPop(null), null);
});
