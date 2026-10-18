// 計算ロジック（DOM に依存しない純粋関数）。node からもテストできるようにしている。

export const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export const norm360 = (a) => ((a % 360) + 360) % 360;
export const norm180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

// 2点間の距離 [m]
export function distance(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 方位 [deg, 北=0 時計回り]
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return norm360(deg(Math.atan2(y, x)));
}

// 基準点からの東西・南北オフセット [m]（狭い範囲の平面近似）
export function toXY(lat0, lon0, lat, lon) {
  return {
    x: rad(lon - lon0) * R_EARTH * Math.cos(rad(lat0)),
    y: rad(lat - lat0) * R_EARTH,
  };
}

export function fromXY(lat0, lon0, x, y) {
  return {
    lat: lat0 + deg(y / R_EARTH),
    lon: lon0 + deg(x / (R_EARTH * Math.cos(rad(lat0)))),
  };
}

// fixes の最後から windowSec 秒分を返す
export function recent(fixes, windowSec) {
  if (!fixes.length) return [];
  const tEnd = fixes[fixes.length - 1].t;
  let i = fixes.length - 1;
  while (i > 0 && tEnd - fixes[i - 1].t <= windowSec * 1000) i--;
  return fixes.slice(i);
}

// 高度の線形回帰による昇降率 [m/s]（GPS バリオ）
export function verticalSpeed(fixes, windowSec = 5) {
  const w = recent(fixes, windowSec);
  if (w.length < 3) return null;
  const t0 = w[0].t;
  let n = 0, st = 0, sa = 0, stt = 0, sta = 0;
  for (const f of w) {
    if (f.alt == null) continue;
    const t = (f.t - t0) / 1000;
    n++; st += t; sa += f.alt; stt += t * t; sta += t * f.alt;
  }
  const den = n * stt - st * st;
  if (n < 3 || den === 0) return null;
  return (n * sta - st * sa) / den;
}

// 各 fix の対地速度ベクトル（東向き vx, 北向き vy [m/s]）
export function velocity(f, prev) {
  if (f.spd != null && f.hdg != null && !Number.isNaN(f.hdg) && f.spd >= 0) {
    return { vx: f.spd * Math.sin(rad(f.hdg)), vy: f.spd * Math.cos(rad(f.hdg)) };
  }
  if (!prev) return null;
  const dt = (f.t - prev.t) / 1000;
  if (dt <= 0) return null;
  const p = toXY(prev.lat, prev.lon, f.lat, f.lon);
  return { vx: p.x / dt, vy: p.y / dt };
}

// 対地速度 [m/s] と進行方位
export function groundTrack(fixes) {
  const n = fixes.length;
  if (!n) return null;
  const f = fixes[n - 1];
  const v = velocity(f, fixes[n - 2]);
  if (!v) return null;
  const spd = Math.hypot(v.vx, v.vy);
  return { spd, hdg: spd > 0.5 ? norm360(deg(Math.atan2(v.vx, v.vy))) : null };
}

// 円への最小二乗フィット（Kasa 法）: 旋回中の対地速度ベクトルの円の中心が風ベクトル
function fitCircle(pts) {
  const n = pts.length;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2;
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  let err = 0;
  for (const p of pts) err += (Math.hypot(p.x - mx - uc, p.y - my - vc) - r) ** 2;
  return { cx: uc + mx, cy: vc + my, r, rms: Math.sqrt(err / n) };
}

// 旋回から風を推定。1 周（300°以上）回っていれば結果を返す。
// 戻り値: { speed [m/s], from [deg 風が吹いてくる方向], airspeed [m/s] }
export function estimateWind(fixes, windowSec = 60) {
  const w = recent(fixes, windowSec);
  if (w.length < 10) return null;
  const pts = [];
  let turned = 0, lastHdg = null;
  for (let i = 1; i < w.length; i++) {
    const v = velocity(w[i], w[i - 1]);
    if (!v) continue;
    const spd = Math.hypot(v.vx, v.vy);
    if (spd < 2) continue;
    const hdg = deg(Math.atan2(v.vx, v.vy));
    if (lastHdg != null) turned += norm180(hdg - lastHdg);
    lastHdg = hdg;
    pts.push({ x: v.vx, y: v.vy });
  }
  if (pts.length < 10 || Math.abs(turned) < 300) return null;
  const c = fitCircle(pts);
  if (!c || c.rms > c.r * 0.35) return null;
  const speed = Math.hypot(c.cx, c.cy);
  return {
    speed,
    from: norm360(deg(Math.atan2(c.cx, c.cy)) + 180),
    airspeed: c.r,
  };
}

// 旋回率 [deg/s]（正 = 右旋回）
export function turnRate(fixes, windowSec = 8) {
  const w = recent(fixes, windowSec);
  if (w.length < 3) return 0;
  let turned = 0, lastHdg = null;
  for (let i = 1; i < w.length; i++) {
    const v = velocity(w[i], w[i - 1]);
    if (!v || Math.hypot(v.vx, v.vy) < 2) continue;
    const hdg = deg(Math.atan2(v.vx, v.vy));
    if (lastHdg != null) turned += norm180(hdg - lastHdg);
    lastHdg = hdg;
  }
  const dt = (w[w.length - 1].t - w[0].t) / 1000;
  return dt > 0 ? turned / dt : 0;
}

// 滑空比 L/D（直近 windowSec 秒の水平距離 / 高度損失）
export function glideRatio(fixes, windowSec = 30) {
  const w = recent(fixes, windowSec);
  if (w.length < 5) return null;
  let d = 0;
  for (let i = 1; i < w.length; i++) d += distance(w[i - 1].lat, w[i - 1].lon, w[i].lat, w[i].lon);
  const loss = w[0].alt - w[w.length - 1].alt;
  if (loss <= 3) return loss < -3 ? Infinity : null; // 上昇中は ∞
  return d / loss;
}

// 風を考慮した対地滑空比（ポーラーの最良 L/D とトリム速度から）
// trackHdg: 目標への方位, wind: estimateWind() の結果
export function groundGlide(bestLD, trimKmh, trackHdg, wind) {
  const va = trimKmh / 3.6;
  if (!wind) return bestLD;
  // 風が吹いていく方向と目標方位のなす角
  const to = rad(norm360(wind.from + 180) - trackHdg);
  const tail = wind.speed * Math.cos(to);
  const cross = wind.speed * Math.sin(to);
  const along = Math.sqrt(Math.max(0, va * va - cross * cross));
  const vg = along + tail;
  if (vg <= 0.3) return 0; // 向かい風で進めない
  return (bestLD * vg) / va;
}

// ゴール情報: 距離・方位・必要 L/D・到着高度
export function goalInfo(pos, alt, goal, opts, wind) {
  const dist = distance(pos.lat, pos.lon, goal.lat, goal.lon);
  const brg = bearing(pos.lat, pos.lon, goal.lat, goal.lon);
  const above = alt - (goal.alt || 0) - (opts.margin || 0);
  const reqLD = above > 0 ? dist / above : Infinity;
  const gLD = groundGlide(opts.bestLD, opts.trimKmh, brg, wind);
  const arrival = gLD > 0 ? alt - dist / gLD - (goal.alt || 0) : -Infinity;
  return { dist, brg, reqLD, groundLD: gLD, arrival };
}

// ---- ウェイポイントの読み込み ----

// 名前・コードから地点の種類を推定する
// 日本の大会でよく使うコード: GL = ゴール/メインランディング, SL = サブランディング,
// TO = テイクオフ, NG = 進入禁止・危険地点
export function classifyWaypoint(code = '', desc = '') {
  const c = code.toUpperCase(), d = desc.toUpperCase();
  if (/^NG/.test(c)) return 'nogo';
  if (/^(GL|SL|LD)/.test(c) || /(^|[^A-Z])(LD|LZ|GOAL)([^A-Z]|$)|LANDING/.test(d)) return 'landing';
  if (/^TO/.test(c) || /TAKE ?OFF/.test(d)) return 'takeoff';
  return 'turnpoint';
}

function makeWp(code, desc, lat, lon, alt, kind) {
  kind ||= classifyWaypoint(code, desc);
  return {
    name: desc || code, code: desc ? code : '', lat, lon, alt,
    kind, landing: kind === 'landing',
  };
}

// SeeYou .cup 形式: name,code,country,lat,lon,elev,style,...
// 緯度 "3540.123N" (DDMM.mmm), 経度 "13912.345E" (DDDMM.mmm), 標高 "1234.0m" / "4000ft"
function parseCupCoord(s, degDigits) {
  const m = s.trim().match(/^(\d+)(\d\d\.\d+)([NSEW])$/i);
  if (!m || m[1].length !== degDigits) return null;
  let v = Number(m[1]) + Number(m[2]) / 60;
  if (/[SW]/i.test(m[3])) v = -v;
  return v;
}

function parseElev(s) {
  if (!s) return 0;
  const m = String(s).trim().match(/^(-?[\d.]+)\s*(m|ft)?$/i);
  if (!m) return 0;
  const v = Number(m[1]);
  return m[2] && m[2].toLowerCase() === 'ft' ? v * 0.3048 : v;
}

function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCup(text) {
  const wps = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^-----Related Tasks/i.test(line)) break;
    const c = splitCsv(line);
    if (c.length < 6) continue;
    const lat = parseCupCoord(c[3], 2);
    const lon = parseCupCoord(c[4], 3);
    if (lat == null || lon == null) continue; // ヘッダ行など
    const style = Number(c[6]);
    const name = c[0].trim() || c[1].trim();
    // style 2〜5 は着陸可能な地点
    const kind = [2, 3, 4, 5].includes(style) ? 'landing' : classifyWaypoint(c[1].trim(), name);
    wps.push({ ...makeWp('', name, lat, lon, parseElev(c[5]), kind), code: c[1].trim() });
  }
  return wps;
}

// FormatGEO（XCTrack・大会でよく使う .wpt）:
// $FormatGEO
// A01014    N 36 26 39.52    E 136 38 02.31   141  TURUGI YOCHIEN
export function parseGeo(text) {
  const wps = [];
  const re = /^(\S+)\s+([NS])\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([EW])\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(-?[\d.]+)\s*(.*)$/i;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(re);
    if (!m) continue;
    let lat = Number(m[3]) + Number(m[4]) / 60 + Number(m[5]) / 3600;
    let lon = Number(m[7]) + Number(m[8]) / 60 + Number(m[9]) / 3600;
    if (/S/i.test(m[2])) lat = -lat;
    if (/W/i.test(m[6])) lon = -lon;
    wps.push(makeWp(m[1], m[11].trim(), lat, lon, Number(m[10])));
  }
  return wps;
}

// OziExplorer .wpt: No,Name,Lat,Lon,... で 15 列目が標高 [ft]
export function parseOzi(text) {
  const wps = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(',').map((s) => s.trim());
    if (c.length >= 15 && c[2] !== '' && !Number.isNaN(Number(c[2])) && !Number.isNaN(Number(c[3]))) {
      const altFt = Number(c[14]);
      wps.push(makeWp('', c[1], Number(c[2]), Number(c[3]), altFt > -777 ? altFt * 0.3048 : 0));
    }
  }
  return wps;
}

export function parseWaypoints(text, filename = '') {
  if (/^\s*\$FormatGEO/i.test(text)) return parseGeo(text);
  if (/OziExplorer/i.test(text)) return parseOzi(text);
  if (/\.cup$/i.test(filename)) return parseCup(text);
  for (const parse of [parseCup, parseGeo, parseOzi]) {
    const w = parse(text);
    if (w.length) return w;
  }
  return [];
}

// ---- XCTrack タスク (.xctsk) ----

function wpFromXc(w) {
  return makeWp(w.name || '', w.description || '', w.lat, w.lon, w.altSmoothed ?? w.alt ?? 0);
}

export function parseTask(obj) {
  if (typeof obj === 'string') {
    if (/^XCTSK:/.test(obj.trim())) throw new Error('QR コード形式のタスク (XCTSK:) には未対応です。.xctsk ファイルを使ってください');
    obj = JSON.parse(obj);
  }
  if (!obj || !Array.isArray(obj.turnpoints) || !obj.turnpoints.length) {
    throw new Error('タスクのターンポイントが見つかりません（.xctsk の version 1 形式に対応）');
  }
  return {
    taskType: obj.taskType || 'CLASSIC',
    turnpoints: obj.turnpoints.map((tp) => ({
      ...wpFromXc(tp.waypoint),
      radius: Number(tp.radius) || 400,
      type: tp.type || '', // SSS / ESS / TAKEOFF / ''
    })),
    sss: obj.sss ? {
      type: obj.sss.type || 'RACE',
      direction: obj.sss.direction || 'EXIT',
      timeGates: obj.sss.timeGates || [],
    } : null,
    goal: { type: (obj.goal && obj.goal.type) || 'CYLINDER', deadline: obj.goal && obj.goal.deadline },
  };
}

// "02:00:00Z" を、時刻 t に最も近い日付の UTC 時刻 [ms] にする
export function utcTimeNear(hms, t) {
  const m = /^(\d\d):(\d\d)(?::(\d\d))?Z?$/.exec(hms || '');
  if (!m) return null;
  const d = new Date(t);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) +
    ((+m[1] * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000;
  const day = 86400000;
  return [base - day, base, base + day].reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
}

export function startGates(task, t) {
  return ((task.sss && task.sss.timeGates) || []).map((g) => utcTimeNear(g, t)).filter((x) => x != null).sort((a, b) => a - b);
}

export function newTaskProgress(task) {
  let idx = 0;
  while (idx < task.turnpoints.length - 1 && task.turnpoints[idx].type === 'TAKEOFF') idx++;
  return { idx, startT: null, essT: null, goalT: null };
}

const insideTp = (tp, p) => distance(p.lat, p.lon, tp.lat, tp.lon) <= tp.radius;

// 新しい位置 f を受けてタスクの進行を更新する（変化がなければ同じオブジェクトを返す）
export function taskStep(task, prog, prev, f) {
  const tps = task.turnpoints;
  if (!prev || prog.idx >= tps.length) return prog;
  const sssIdx = tps.findIndex((tp) => tp.type === 'SSS');
  const crossedStart = () => {
    const gates = startGates(task, f.t);
    if (gates.length && f.t < gates[0]) return false;
    const sss = tps[sssIdx];
    const a = insideTp(sss, prev), b = insideTp(sss, f);
    return (task.sss && task.sss.direction === 'ENTER') ? !a && b : a && !b;
  };
  if (prog.idx === sssIdx) {
    return crossedStart() ? { ...prog, idx: prog.idx + 1, startT: f.t } : prog;
  }
  // スタート直後にもう一度スタートを切り直した場合はスタート時刻を更新
  if (sssIdx >= 0 && prog.idx === sssIdx + 1 && crossedStart()) prog = { ...prog, startT: f.t };
  const tp = tps[prog.idx];
  if (!insideTp(tp, f)) return prog;
  const next = { ...prog, idx: prog.idx + 1 };
  if (tp.type === 'ESS') next.essT = f.t;
  if (next.idx >= tps.length) { next.goalT = f.t; next.essT ??= f.t; }
  return next;
}

// 次のターンポイントからゴールまでの距離と到着高度（シリンダー中心を結ぶ簡易ルート）
export function taskInfo(task, prog, pos, alt, opts, wind) {
  const tps = task.turnpoints;
  if (prog.idx >= tps.length) return null;
  const tp = tps[prog.idx];
  const dCenter = distance(pos.lat, pos.lon, tp.lat, tp.lon);
  const toEdge = Math.abs(dCenter - tp.radius);
  const legs = [{ d: Math.max(0, dCenter - (prog.idx === tps.length - 1 ? tp.radius : 0)), brg: bearing(pos.lat, pos.lon, tp.lat, tp.lon) }];
  for (let i = prog.idx + 1; i < tps.length; i++) {
    const a = tps[i - 1], b = tps[i];
    let d = distance(a.lat, a.lon, b.lat, b.lon);
    if (i === tps.length - 1) d = Math.max(0, d - b.radius);
    legs.push({ d, brg: bearing(a.lat, a.lon, b.lat, b.lon) });
  }
  let remaining = 0, need = 0;
  for (const l of legs) {
    remaining += l.d;
    const g = groundGlide(opts.bestLD, opts.trimKmh, l.brg, wind);
    need += g > 0 ? l.d / g : Infinity;
  }
  const goal = tps[tps.length - 1];
  return {
    tp, toEdge, brg: legs[0].brg, remaining,
    arrival: alt - need - (goal.alt || 0),
    reqLD: alt - (goal.alt || 0) - (opts.margin || 0) > 0 ? remaining / (alt - (goal.alt || 0) - (opts.margin || 0)) : Infinity,
  };
}

// ---- XCTrack 設定バックアップ (.xcfg) ----

// 本アプリで使える項目だけ取り出す（画面レイアウトや音の設定は XCTrack 専用なので対象外）
export function parseXcfg(obj) {
  if (typeof obj === 'string') obj = JSON.parse(obj);
  const p = obj && obj.preferences;
  if (!p) throw new Error('XCTrack の設定ファイルではありません');
  const out = { settings: {}, info: obj.info || {} };
  if (p['Pilot.Name']) out.pilot = String(p['Pilot.Name']);
  if (p['Glider.Name']) out.glider = String(p['Glider.Name']);
  if (Number(p['Glider.TrimSpeed']) > 0) out.settings.trimKmh = Number(p['Glider.TrimSpeed']);
  if (Number(p['Glider.GoalGlideRatio']) > 0) out.settings.bestLD = Number(p['Glider.GoalGlideRatio']);
  if (p['Unit.WindSpeed']) out.settings.windUnit = /m\/s/.test(p['Unit.WindSpeed']) ? 'ms' : 'kmh';
  if (p['Display.Theme']) out.settings.theme = /black|dark|night/i.test(p['Display.Theme']) ? 'night' : 'day';
  const nav = p['Navigation.State'];
  if (nav && typeof nav === 'object') {
    const active = nav._active || '';
    const comp = nav['org.xcontest.XCTrack.navig.TaskCompetition'];
    const toWp = nav['org.xcontest.XCTrack.navig.TaskToWaypoint'];
    if (/TaskCompetition/.test(active) && comp) {
      try { out.task = parseTask(comp); } catch { /* 空のタスク */ }
    }
    if (/TaskToWaypoint/.test(active) && Array.isArray(toWp) && toWp[0]) out.goal = wpFromXc(toWp[0]);
  }
  out.waypointFiles = (p['Navigation.WaypointFiles'] && p['Navigation.WaypointFiles'].files) || [];
  out.airspaceFiles = p['Airspace.Files'] || [];
  return out;
}

// ファイルの中身から種類を判定して読み込む
export function readAnyFile(text, filename = '') {
  const t = text.replace(/^﻿/, '').trim();
  if (t.startsWith('{')) {
    const obj = JSON.parse(t);
    if (obj.preferences) return { kind: 'settings', data: parseXcfg(obj) };
    if (obj.turnpoints) return { kind: 'task', data: parseTask(obj) };
    throw new Error('対応していない JSON ファイルです');
  }
  if (/^XCTSK:/.test(t)) parseTask(t); // エラーメッセージを出す
  const wps = parseWaypoints(t, filename);
  if (wps.length) return { kind: 'waypoints', data: wps };
  throw new Error('ウェイポイント・タスク・XCTrack 設定のどれとしても読み込めませんでした');
}

// ---- IGC ----

const pad = (n, w) => String(n).padStart(w, '0');

function igcLat(lat) {
  const t = Math.round(Math.abs(lat) * 60000);
  return pad(Math.floor(t / 60000), 2) + pad(t % 60000, 5) + (lat >= 0 ? 'N' : 'S');
}

function igcLon(lon) {
  const t = Math.round(Math.abs(lon) * 60000);
  return pad(Math.floor(t / 60000), 3) + pad(t % 60000, 5) + (lon >= 0 ? 'E' : 'W');
}

function igcAlt(a) {
  const v = Math.round(a || 0);
  return v < 0 ? '-' + pad(-v, 4) : pad(v, 5);
}

export function toIGC(fixes, meta = {}) {
  if (!fixes.length) return '';
  const d = new Date(fixes[0].t);
  const date = pad(d.getUTCDate(), 2) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCFullYear() % 100, 2);
  const lines = [
    'AXXXHGI HangInstrument',
    `HFDTEDATE:${date},01`,
    `HFPLTPILOTINCHARGE:${meta.pilot || ''}`,
    'HFCM2CREW2:NIL',
    `HFGTYGLIDERTYPE:${meta.glider || ''}`,
    `HFGIDGLIDERID:${meta.gliderId || ''}`,
    'HFDTMGPSDATUM:WGS84',
    'HFRFWFIRMWAREVERSION:1.0',
    `HFRHWHARDWAREVERSION:${meta.device || 'iPhone'}`,
    'HFFTYFRTYPE:HangInstrument,PWA',
    'HFGPSRECEIVER:Phone GPS',
    'HFPRSPRESSALTSENSOR:NIL',
    'HFALGALTGPS:GEO',
    'HFALPALTPRESSURE:ISA',
    'HFCCLCOMPETITIONCLASS:HG',
  ];
  let lastSec = null;
  for (const f of fixes) {
    const t = new Date(f.t);
    const sec = Math.floor(f.t / 1000);
    if (sec === lastSec) continue; // 1 秒に 1 点
    lastSec = sec;
    const hms = pad(t.getUTCHours(), 2) + pad(t.getUTCMinutes(), 2) + pad(t.getUTCSeconds(), 2);
    const valid = f.alt != null ? 'A' : 'V';
    lines.push(`B${hms}${igcLat(f.lat)}${igcLon(f.lon)}${valid}00000${igcAlt(f.alt)}`);
  }
  return lines.join('\r\n') + '\r\n';
}
