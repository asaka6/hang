import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';

const GEO = '$FormatGEO\r\n' +
  'A04017    N 36 26 22.30    E 136 38 27.65   170  SANROKU EKI\r\n' +
  'GL1014    N 36 26 34.72    E 136 38 17.83   148  MAIN LD\r\n' +
  'TO1061    N 36 26 47.29    E 136 38 50.81   617  TAKEOFF\r\n' +
  'NG1002    N 36 38 54.00    E 137 11 15.00    24  TOYAMA-AP\r\n' +
  'SL1006    N 36 35 14.14    E 136 53 09.61    55  OYABEGAWALD\r\n';

// 獅子吼の座学で配布されたタスクと同じ形式
const XCTSK = '{"version":1,"taskType":"CLASSIC","turnpoints":[{"radius":100,"waypoint":{"lon":136.6410138888889,"lat":36.439527777777776,"altSmoothed":170,"name":"A04017","description":"SANROKU EKI"},"type":"SSS"},{"radius":200,"waypoint":{"lon":136.6321638888889,"lat":36.444088888888885,"altSmoothed":140,"name":"A03014","description":"KONCHYU KAN"}},{"radius":100,"waypoint":{"lon":136.6382861111111,"lat":36.44297777777778,"altSmoothed":148,"name":"GL1014","description":"MAIN LD"},"type":"ESS"}],"sss":{"type":"RACE","direction":"EXIT","timeGates":["02:00:00Z"]},"goal":{"type":"CYLINDER","deadline":"05:00:00Z"},"earthModel":"WGS84"}';

const XCFG = JSON.stringify({
  info: { exportType: 'backup', versionName: '0.9.12.6' },
  layout: {}, airspaceSelectedChannels: [],
  preferences: {
    'Pilot.Name': 'Test Pilot', 'Glider.Name': 'RELAX2',
    'Glider.TrimSpeed': 35.0, 'Glider.GoalGlideRatio': 7.5,
    'Unit.WindSpeed': 'm/s', 'Display.Theme': 'BlackHCTheme',
    'Navigation.WaypointFiles': { files: ['SHISHIKU_20260501.wpt'] },
    'Airspace.Files': ['2025Tonami_ctr.txt'],
    'Navigation.State': {
      _active: 'org.xcontest.XCTrack.navig.TaskToWaypoint',
      'org.xcontest.XCTrack.navig.TaskToWaypoint': [{ lon: 136.6382861111111, lat: 36.44297777777778, altSmoothed: 148, name: 'GL1014', description: 'MAIN LD' }],
    },
  },
});

test('FormatGEO waypoints', () => {
  const r = C.readAnyFile(GEO, 'SHISHIKU_20260501.wpt');
  assert.equal(r.kind, 'waypoints');
  const w = r.data;
  assert.equal(w.length, 5);
  assert.equal(w[0].name, 'SANROKU EKI');
  assert.equal(w[0].code, 'A04017');
  assert.ok(Math.abs(w[0].lat - (36 + 26 / 60 + 22.3 / 3600)) < 1e-9);
  assert.ok(Math.abs(w[0].lon - (136 + 38 / 60 + 27.65 / 3600)) < 1e-9);
  assert.equal(w[0].alt, 170);
  assert.deepEqual(w.map((x) => x.kind), ['turnpoint', 'landing', 'takeoff', 'nogo', 'landing']);
  assert.equal(w[1].landing, true);
});

test('xctsk task', () => {
  const r = C.readAnyFile(XCTSK, 'task.xctsk');
  assert.equal(r.kind, 'task');
  const t = r.data;
  assert.equal(t.turnpoints.length, 3);
  assert.equal(t.turnpoints[0].type, 'SSS');
  assert.equal(t.turnpoints[1].radius, 200);
  assert.equal(t.turnpoints[2].name, 'MAIN LD');
  assert.equal(t.sss.direction, 'EXIT');
  // 11:30 JST = 02:30Z → ゲートは同じ日の 02:00Z
  const t0 = Date.UTC(2026, 4, 5, 2, 30);
  assert.deepEqual(C.startGates(t, t0), [Date.UTC(2026, 4, 5, 2, 0)]);
});

test('task progress: start exit after gate, turnpoint, goal', () => {
  const task = C.parseTask(XCTSK);
  const [sss, tp2, goal] = task.turnpoints;
  const gate = Date.UTC(2026, 4, 5, 2, 0);
  let prog = C.newTaskProgress(task);
  const at = (p, t, dLat = 0) => ({ lat: p.lat + dLat, lon: p.lon, t });
  const step = (a, b) => (prog = C.taskStep(task, prog, a, b));
  // ゲート前にシリンダーを出てもスタートにならない
  step(at(sss, gate - 60000), at(sss, gate - 59000, 0.002));
  assert.equal(prog.idx, 0);
  // ゲート後に中から外へ出るとスタート
  step(at(sss, gate + 1000), at(sss, gate + 2000, 0.002));
  assert.equal(prog.idx, 1);
  assert.equal(prog.startT, gate + 2000);
  // 再スタート
  step(at(sss, gate + 5000), at(sss, gate + 6000, 0.002));
  assert.equal(prog.startT, gate + 6000);
  // TP2 のシリンダーに入る
  step(at(sss, gate + 7000), at(tp2, gate + 8000, 0.001));
  assert.equal(prog.idx, 2);
  const info = C.taskInfo(task, prog, at(tp2, 0), 600, { bestLD: 7.5, trimKmh: 35, margin: 0 }, null);
  assert.equal(info.tp.name, 'MAIN LD');
  assert.ok(info.remaining > 400 && info.remaining < 700, info.remaining);
  // ゴール
  step(at(tp2, gate + 9000), at(goal, gate + 10000));
  assert.equal(prog.idx, 3);
  assert.equal(prog.goalT, gate + 10000);
  assert.equal(prog.essT, gate + 10000);
  assert.equal(C.taskInfo(task, prog, at(goal, 0), 600, { bestLD: 7.5, trimKmh: 35 }, null), null);
});

test('xcfg settings backup', () => {
  const r = C.readAnyFile(XCFG, '2026-05-03_backup-00.xcfg');
  assert.equal(r.kind, 'settings');
  const s = r.data;
  assert.equal(s.pilot, 'Test Pilot');
  assert.equal(s.glider, 'RELAX2');
  assert.deepEqual(s.settings, { trimKmh: 35, bestLD: 7.5, windUnit: 'ms', theme: 'night' });
  assert.equal(s.goal.name, 'MAIN LD');
  assert.equal(s.goal.landing, true);
  assert.deepEqual(s.waypointFiles, ['SHISHIKU_20260501.wpt']);
  assert.equal(s.task, undefined);
});

test('unknown files give a clear error', () => {
  assert.throws(() => C.readAnyFile('hello', 'x.txt'), /読み込めません/);
  assert.throws(() => C.readAnyFile('XCTSK:{"taskType":"CLASSIC","version":2}', 'x'), /QR/);
});
