import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../docs/calc.js';

const GEO = '$FormatGEO\r\n' +
  'A04017    N 36 26 22.30    E 136 38 27.65   170  SANROKU EKI\r\n' +
  'GL1014    N 36 26 34.72    E 136 38 17.83   148  MAIN LD\r\n' +
  'TO1061    N 36 26 47.29    E 136 38 50.81   617  TAKEOFF\r\n' +
  'NG1002    N 36 38 54.00    E 137 11 15.00    24  TOYAMA-AP\r\n' +
  'SL1006    N 36 35 14.14    E 136 53 09.61    55  OYABEGAWALD\r\n';

// 獅子吼の座学で配布されたタスクと同じ形式（アプリでは使わない）
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

test('xctsk task files are recognised but not used', () => {
  const r = C.readAnyFile(XCTSK, 'task.xctsk');
  assert.equal(r.kind, 'task');
  assert.equal(r.data, null);
  assert.equal(C.readAnyFile('XCTSK:{"taskType":"CLASSIC","version":2}', 'x').kind, 'task');
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
});
