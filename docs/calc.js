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

// XCTrack の地点 { lat, lon, altSmoothed, name, description }
function wpFromXc(w) {
  return makeWp(w.name || '', w.description || '', w.lat, w.lon, w.altSmoothed ?? w.alt ?? 0);
}

// ---- XCTrack 設定バックアップ (.xcfg) ----

// 本アプリで使える項目だけ取り出す（画面レイアウトや音の設定は XCTrack 専用、大会タスクは使わないので対象外）
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
    const toWp = nav['org.xcontest.XCTrack.navig.TaskToWaypoint'];
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
    if (obj.turnpoints) return { kind: 'task', data: null }; // 大会タスクは使わない
    throw new Error('対応していない JSON ファイルです');
  }
  if (/^XCTSK:/.test(t)) return { kind: 'task', data: null };
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

// ---- サーマル誘導 ----

// 太陽の方位・高度 [deg]（NOAA の簡易式）
export function sunPosition(t, lat, lon) {
  const jd = t / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = norm360(280.46 + 0.9856474 * n);
  const g = rad(norm360(357.528 + 0.9856003 * n));
  const lambda = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const eps = rad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = norm360(280.46061837 + 360.98564736629 * n);
  const ha = rad(norm360(gmst + lon - deg(ra)));
  const la = rad(lat);
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { az: norm360(deg(az)), el: deg(el) };
}

// 時計の方向（進行方向を 12 時として 1〜12）
export function clockDir(brg, hdg) {
  const c = Math.round(norm360(brg - hdg) / 30) % 12;
  return c === 0 ? 12 : c;
}

// ある地点の地形の特徴: 斜面の向き（下り方向）・傾き・尾根らしさ
// elev(lat, lon) は標高 [m] か null を返す関数
export function terrainAt(lat, lon, elev, step = 60) {
  const h = elev(lat, lon);
  if (h == null) return null;
  const n = fromXY(lat, lon, 0, step), s = fromXY(lat, lon, 0, -step);
  const e = fromXY(lat, lon, step, 0), w = fromXY(lat, lon, -step, 0);
  const hn = elev(n.lat, n.lon), hs = elev(s.lat, s.lon), he = elev(e.lat, e.lon), hw = elev(w.lat, w.lon);
  if ([hn, hs, he, hw].some((v) => v == null)) return null;
  const dx = (he - hw) / (2 * step), dy = (hn - hs) / (2 * step);
  const slope = Math.hypot(dx, dy); // 勾配（tan）
  const aspect = norm360(deg(Math.atan2(-dx, -dy))); // 斜面が向いている方位（下る方向）
  const ridge = h - (hn + hs + he + hw) / 4; // 周りより高い = 尾根・張り出し
  return { h, slope, aspect, ridge };
}

// サーマルが出ていそうな場所を 1 つ選ぶ。
// in: { pos, alt, hdg, t, wind, thermals, recent, landing, opts, elev, sun, sunFactor, prev }
//   thermals: 今回のフライトで上がった場所 [{ lat, lon, climb, t }]
//   recent: 直近の軌跡（上がらなかった所を避ける）
//   landing: 戻る着陸地 { lat, lon, alt }
//   prev: 前回案内した候補（コロコロ変わらないよう少し優先する）
// out: { lat, lon, dist, brg, reason, score } または null
export function thermalCandidate(inp) {
  const { pos, alt, hdg, t, wind, thermals = [], recent = [], landing, opts, elev, sun, sunFactor = 1, prev } = inp;
  const cands = [];
  const reachable = (p) => {
    const d1 = distance(pos.lat, pos.lon, p.lat, p.lon);
    const g1 = groundGlide(opts.bestLD, opts.trimKmh, bearing(pos.lat, pos.lon, p.lat, p.lon), wind);
    if (g1 <= 0) return null;
    let left = alt - d1 / g1;
    if (landing) {
      const d2 = distance(p.lat, p.lon, landing.lat, landing.lon);
      const g2 = groundGlide(opts.bestLD, opts.trimKmh, bearing(p.lat, p.lon, landing.lat, landing.lon), wind);
      if (g2 <= 0) return null;
      if (left - d2 / g2 - (landing.alt || 0) < (opts.margin || 0)) return null; // 行ったら帰れない
    }
    return { d1, left };
  };
  // 上がらなかった場所の近くは避ける
  const searched = (p) => recent.some((f) => (f.v ?? 0) < 0.3 && distance(f.lat, f.lon, p.lat, p.lon) < 150);

  // 1) 今回上がった場所（新しく強いほど高得点。20 分くらいで薄れる）
  for (const th of thermals) {
    const age = (t - (th.t ?? t)) / 60000;
    if (age > 30 || th.climb < 0.3) continue;
    cands.push({ lat: th.lat, lon: th.lon, base: 3 * th.climb * Math.exp(-age / 20), reason: 'さっき上がった場所' });
  }

  // 2) 地形: 日の当たる斜面・尾根・風上の斜面
  if (elev) {
    const R = 2400, step = 240;
    const sunOk = sun && sun.el > 8;
    const sunW = sunOk ? Math.sin(rad(sun.el)) * sunFactor : 0;
    for (let x = -R; x <= R; x += step) {
      for (let y = -R; y <= R; y += step) {
        if (Math.hypot(x, y) > R || Math.hypot(x, y) < 200) continue;
        const p = fromXY(pos.lat, pos.lon, x, y);
        const tr = terrainAt(p.lat, p.lon, elev);
        if (!tr) continue;
        if (alt - tr.h < 250) continue; // 地面に近すぎる場所には行かせない
        const steep = Math.min(1, tr.slope / 0.35);
        const sunScore = sunOk ? Math.max(0, Math.cos(rad(tr.aspect - sun.az))) * steep * sunW : 0;
        const ridgeScore = Math.max(0, Math.min(1, tr.ridge / 15));
        const windScore = wind && wind.speed > 1.5 && wind.speed < 9
          ? Math.max(0, Math.cos(rad(tr.aspect - wind.from))) * steep * 0.5 : 0;
        const base = 1.2 * sunScore + 0.8 * ridgeScore * (0.5 + sunW) + windScore;
        if (base < 0.35) continue;
        const reason = ridgeScore * 0.8 > sunScore * 1.2 && ridgeScore * 0.8 > windScore ? '尾根'
          : windScore > sunScore * 1.2 ? '風上の斜面' : '日の当たる斜面';
        cands.push({ lat: p.lat, lon: p.lon, base, reason });
      }
    }
  }

  let best = null;
  for (const c of cands) {
    const r = reachable(c);
    if (!r) continue;
    let score = c.base / (1 + r.d1 / 900); // 近いほど良い
    if (searched(c)) score *= 0.3;
    // 後ろに戻ると旋回で高度を失うので、前の方を少し優先
    if (hdg != null) score *= 0.75 + 0.25 * Math.cos(rad(bearing(pos.lat, pos.lon, c.lat, c.lon) - hdg));
    if (prev && distance(prev.lat, prev.lon, c.lat, c.lon) < 250) score *= 1.4;
    if (!best || score > best.score) best = { lat: c.lat, lon: c.lon, dist: r.d1, brg: bearing(pos.lat, pos.lon, c.lat, c.lon), reason: c.reason, score };
  }
  return best;
}

// 着陸地から離れていて、高度の余裕（到着高度 − 安全マージン）が少ない = これ以上離れると戻れない
export function turnBackNeeded(reserve, brgToLanding, hdg, warnAt = 60) {
  if (hdg == null) return false;
  const away = Math.abs(norm180(brgToLanding - hdg)) > 100;
  return away && reserve < warnAt;
}

// ---- ログの分析（フライト後に詳しく見る用） ----

// fixes: [{ t, lat, lon, alt }] → 各点の上昇率・速度、旋回してサーマルにいた区間、まとめ
export function analyzeFlight(fixes) {
  const n = fixes.length;
  const v = new Array(n).fill(0), spd = new Array(n).fill(0), hdg = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const a = fixes[i - 1], b = fixes[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const d = distance(a.lat, a.lon, b.lat, b.lon);
    spd[i] = d / dt;
    if (spd[i] > 2) hdg[i] = bearing(a.lat, a.lon, b.lat, b.lon);
    // 上昇率: 直近 3 秒の傾き
    let j = i;
    while (j > 0 && b.t - fixes[j - 1].t <= 3000) j--;
    const w = fixes.slice(j, i + 1);
    v[i] = w.length >= 2 ? verticalSpeed(w, 3) ?? 0 : 0;
  }
  // 旋回: 直近 8 秒で向きが変わった量
  const circling = new Array(n).fill(false);
  let turned = 0, lo = 1;
  const dh = (i) => (hdg[i] != null && hdg[i - 1] != null ? norm180(hdg[i] - hdg[i - 1]) : 0);
  for (let i = 1; i < n; i++) {
    turned += dh(i);
    while (lo < i && fixes[i].t - fixes[lo].t > 8000) { turned -= dh(lo); lo++; }
    const dt = (fixes[i].t - fixes[lo].t) / 1000;
    circling[i] = dt > 3 && Math.abs(turned / dt) > 8;
  }
  // 旋回が 20 秒以上続いて上がった区間 = サーマル
  const thermals = [];
  for (let i = 0; i < n;) {
    if (!circling[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && (circling[j + 1] || (j + 4 < n && circling[j + 4]))) j++;
    const dt = (fixes[j].t - fixes[i].t) / 1000;
    const gain = fixes[j].alt - fixes[i].alt;
    if (dt >= 20 && gain / dt > 0.2) {
      let best = i;
      for (let k = i; k <= j; k++) if (v[k] > v[best]) best = k;
      thermals.push({ start: i, end: j, lat: fixes[best].lat, lon: fixes[best].lon, climb: gain / dt, gain, sec: dt });
    }
    i = j + 1;
  }
  let track = 0, maxAlt = -Infinity, minAlt = Infinity, maxClimb = 0, maxSink = 0, free = 0, maxSpd = 0;
  for (let i = 0; i < n; i++) {
    const f = fixes[i];
    if (i) track += distance(fixes[i - 1].lat, fixes[i - 1].lon, f.lat, f.lon);
    if (f.alt != null) { maxAlt = Math.max(maxAlt, f.alt); minAlt = Math.min(minAlt, f.alt); }
    if (Math.abs(v[i]) < 15) { maxClimb = Math.max(maxClimb, v[i]); maxSink = Math.min(maxSink, v[i]); } // GPS の飛びは除く
    if (spd[i] < 60) maxSpd = Math.max(maxSpd, spd[i]);
    free = Math.max(free, distance(fixes[0].lat, fixes[0].lon, f.lat, f.lon));
  }
  const bestThermal = thermals.reduce((a, b) => (!a || b.climb > a.climb ? b : a), null);
  return {
    v, spd, circling, thermals,
    stats: {
      sec: n > 1 ? (fixes[n - 1].t - fixes[0].t) / 1000 : 0,
      maxAlt, minAlt, maxClimb, maxSink, track, free, maxSpd,
      thermalCount: thermals.length,
      totalGain: thermals.reduce((s, t) => s + t.gain, 0),
      circlingSec: thermals.reduce((s, t) => s + t.sec, 0),
      bestThermal,
    },
  };
}
