import * as C from './calc.js';
import { createSim } from './sim.js';
import * as T from './tiles.js';
import * as G from './terrain.js';

const VERSION = '1.6.1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------- 保存 ----------

function load(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem('hg.' + key));
    return v == null ? def : v;
  } catch { return def; }
}
function save(key, v) {
  try { localStorage.setItem('hg.' + key, JSON.stringify(v)); } catch { /* 容量不足など */ }
}

// フライトの点列は大きくなるので IndexedDB に保存
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('hg', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('logs', { keyPath: 'id' });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put: (store, v, k) => tx(store, 'readwrite', (s) => s.put(v, k)),
    get: (store, k) => tx(store, 'readonly', (s) => s.get(k)),
    del: (store, k) => tx(store, 'readwrite', (s) => s.delete(k)),
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  };
})();

// ---------- 状態 ----------

const DEFAULTS = {
  pilot: '', glider: '', bestLD: 7.5, trimKmh: 35, margin: 100,
  altOffset: 0, theme: 'day', varioWindow: 5, ldWindow: 30, autoStartKmh: 15,
  mapWidth: 3000, trackUp: true, windUnit: 'ms', mapLayer: 'simple', saveRadiusKm: 10, voice: 'on',
};
const settings = { ...DEFAULTS, ...load('settings', {}) };
if (!settings.simpleMap) { settings.mapLayer = 'simple'; settings.simpleMap = true; save('settings', settings); }
if (settings.mapLayer !== 'none' && !T.LAYERS[settings.mapLayer]) settings.mapLayer = 'simple'; // 無くなった地図の種類
let waypoints = load('waypoints', []);
let goal = load('goal', null);
let task = load('task', null); // XCTrack の .xctsk から読み込んだ大会タスク
let prog = load('taskProg', null);


const S = {
  running: false, demo: false,
  fixes: [],
  flightStart: null, flightEnd: null, takeoff: null,
  fastCount: 0, slowSince: null,
  wind: null, windT: 0,
  circling: false, circleStart: null, thermals: [],
  lastThermal: null, lastGain: null, thermalEnd: 0,
  lowWarnT: 0, lowWarned: false, unlockUntil: 0,
  fixAt: 0, prevFixAt: 0, viewUp: 0, magHdg: null, follow: true, panCenter: null, panUp: 0,
  watchId: null, simTimer: null, wakeLock: null,
  lastSaved: 0, dirty: true,
};

const alt = (f) => (f && f.alt != null ? f.alt + settings.altOffset : null);
const last = () => S.fixes[S.fixes.length - 1];

// ---------- 位置の受信 ----------

function onPosition(p) {
  const c = p.coords;
  onFix({
    t: p.timestamp || Date.now(),
    lat: c.latitude, lon: c.longitude,
    alt: c.altitude, acc: c.accuracy,
    spd: c.speed != null && c.speed >= 0 ? c.speed : null,
    hdg: c.heading != null && c.heading >= 0 && !Number.isNaN(c.heading) ? c.heading : null,
  });
}

function onFix(f) {
  updateGpsBadge(f.acc);
  if (f.acc != null && f.acc > 50) return; // 精度の悪い点は捨てる
  const prev = last();
  if (prev && f.t <= prev.t) return;
  // 速度・方位が来ない端末は位置差から求める
  if (f.spd == null || f.hdg == null) {
    const v = C.velocity({ ...f, spd: null }, prev);
    if (v) {
      f.spd = Math.hypot(v.vx, v.vy);
      if (f.spd > 0.5) f.hdg = C.norm360((Math.atan2(v.vx, v.vy) * 180) / Math.PI);
    }
  }
  S.fixes.push(f);
  S.prevFixAt = S.fixAt; S.fixAt = performance.now();
  f.v = C.verticalSpeed(S.fixes, 3) ?? 0; // 軌跡の色分け用
  detectFlight(f);
  detectThermal(f);
  if (task && prog && prog.startT == null && !S.gateSpoken) {
    const gates = C.startGates(task, f.t);
    if (gates.length && f.t >= gates[0] && f.t - gates[0] < 120000) { S.gateSpoken = true; speak('スタートが開きました'); }
  }
  if (task && prog) {
    const np = C.taskStep(task, prog, prev, f);
    if (np !== prog) {
      if (np.idx !== prog.idx) {
        beep(np.idx >= task.turnpoints.length ? 3 : 2);
        const passed = task.turnpoints[np.idx - 1];
        const next = task.turnpoints[np.idx];
        if (np.idx >= task.turnpoints.length) speak('ゴールしました');
        else if (passed.type === 'SSS') speak(`スタートしました。次は ${next.name}`);
        else speak(`${passed.type === 'ESS' ? 'イーエスエス' : 'ターンポイント'} 通過。次は ${next.name}`);
      } else if (np.startT !== prog.startT) { beep(1); speak('スタートを切り直しました'); }
      prog = np;
      save('taskProg', prog);
    }
  }
  if (S.circling && f.t - S.windT > 5000) {
    const w = C.estimateWind(S.fixes);
    if (w) { S.wind = w; S.windT = f.t; }
  }
  if (!S.demo && f.t - S.lastSaved > 15000) {
    S.lastSaved = f.t;
    saveCurrent();
  }
  S.dirty = true;
  render();
}

function detectFlight(f) {
  const kmh = (f.spd || 0) * 3.6;
  if (S.flightStart == null) {
    S.fastCount = kmh > settings.autoStartKmh ? S.fastCount + 1 : 0;
    if (S.fastCount >= 5) {
      const w = C.recent(S.fixes, 10);
      S.flightStart = w[0].t;
      S.takeoff = { lat: w[0].lat, lon: w[0].lon, alt: w[0].alt };
      S.flightEnd = null;
      onTakeoff();
    }
    return;
  }
  if (S.flightEnd != null) return;
  const vs = Math.abs(C.verticalSpeed(S.fixes, 10) ?? 0);
  if (kmh < 4 && vs < 0.3) {
    S.slowSince ??= f.t;
    if (f.t - S.slowSince > 60000) {
      S.flightEnd = S.slowSince;
      if (!S.demo) saveLog();
      onLanding();
    }
  } else {
    S.slowSince = null;
  }
}

function detectThermal(f) {
  const tr = Math.abs(C.turnRate(S.fixes, 8));
  if (!S.circling && tr > 8) {
    S.circling = true;
    S.circleStart = f;
  } else if (S.circling && tr < 4) {
    S.circling = false;
    S.thermalEnd = f.t;
    const dt = (f.t - S.circleStart.t) / 1000;
    const climb = dt > 0 ? (f.alt - S.circleStart.alt) / dt : 0;
    if (dt > 20 && climb > 0.2) {
      // 旋回中に一番よく上がった地点をサーマルとして記録
      const w = S.fixes.filter((x) => x.t >= S.circleStart.t);
      const best = w.reduce((a, b) => (b.v > a.v ? b : a), w[0]);
      S.thermals.push({ lat: best.lat, lon: best.lon, climb });
      if (S.thermals.length > 30) S.thermals.shift();
      S.lastThermal = climb;
      S.lastGain = f.alt - S.circleStart.alt;
    }
  }
}

// ---------- 開始・停止 ----------

async function start(demo = false) {
  $('#start').classList.add('hidden');
  S.demo = demo;
  S.running = true;
  requestWakeLock();
  if (demo) {
    // デモは今いる場所、なければ読み込んだテイクオフ（獅子吼など）から飛ぶ
    const to = waypoints.find((w) => w.kind === 'takeoff');
    const pos = last() || (to && { lat: to.lat, lon: to.lon, alt: to.alt });
    resetFlight();
    const sim = createSim(pos ? { lat0: pos.lat, lon0: pos.lon, alt0: pos.alt ?? 600 } : {});
    S.simTimer = setInterval(() => onFix(sim.step(1)), 250); // 4 倍速
    return;
  }
  await resumeCurrent();
  if (isFlying()) lockScreen(true); // 途中で再起動した時もそのまま飛行画面に
  if (!('geolocation' in navigator)) { alert('この端末では位置情報が使えません'); return; }
  S.watchId = navigator.geolocation.watchPosition(onPosition, (e) => {
    updateGpsBadge(null, e.code === 1 ? '許可なし' : 'エラー');
    if (e.code === 1) alert('位置情報が許可されていません。\n設定 → プライバシーとセキュリティ → 位置情報サービス → Safari（またはこのアプリ）で「使用中のみ」以上と「正確な位置情報」をオンにしてください。');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

async function stop() {
  if (S.simTimer) clearInterval(S.simTimer);
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.simTimer = null; S.watchId = null;
  if (!S.demo && S.flightStart != null && S.flightEnd == null) {
    S.flightEnd = last().t;
    await saveLog();
  }
  if (!S.demo) await db.del('kv', 'current').catch(() => {});
  S.running = false;
  lockScreen(false);
  releaseWakeLock();
  resetFlight();
  $('#start').classList.remove('hidden');
}

function resetFlight() {
  Object.assign(S, {
    fixes: [], flightStart: null, flightEnd: null, takeoff: null,
    fastCount: 0, slowSince: null, wind: null, windT: 0,
    circling: false, circleStart: null, thermals: [], lastThermal: null, lastGain: null, thermalEnd: 0,
    lowWarnT: 0, lowWarned: false, gateSpoken: false, dirty: true,
  });
}

// アプリが落ちたり再読み込みされても、30 分以内なら同じフライトを続ける
async function saveCurrent() {
  const { fixes, flightStart, flightEnd, takeoff, thermals, wind, windT } = S;
  await db.put('kv', { fixes, flightStart, flightEnd, takeoff, thermals, wind, windT }, 'current').catch(() => {});
}

async function resumeCurrent() {
  const cur = await db.get('kv', 'current').catch(() => null);
  if (!cur || !cur.fixes.length) return;
  const lastT = cur.fixes[cur.fixes.length - 1].t;
  if (Date.now() - lastT < 30 * 60000) {
    Object.assign(S, cur);
  } else if (cur.flightStart != null) {
    Object.assign(S, cur);
    S.flightEnd ??= lastT;
    await saveLog();
    resetFlight();
  }
  await db.del('kv', 'current').catch(() => {});
}

async function saveLog() {
  const fixes = S.fixes.filter((f) => f.t >= S.flightStart - 30000 && f.t <= (S.flightEnd || Infinity) + 30000);
  if (fixes.length < 10) return;
  let dist = 0, maxAlt = -Infinity;
  for (let i = 0; i < fixes.length; i++) {
    if (i) dist += C.distance(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);
    if (fixes[i].alt != null) maxAlt = Math.max(maxAlt, fixes[i].alt + settings.altOffset);
  }
  const slim = fixes.map(({ t, lat, lon, alt: a }) => ({ t, lat, lon, alt: a }));
  await db.put('logs', {
    id: S.flightStart, start: S.flightStart, end: S.flightEnd, dist, maxAlt,
    pilot: settings.pilot, glider: settings.glider, fixes: slim,
  });
  renderLogs();
}

// ---------- 画面スリープ防止 ----------

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
    }
  } catch { S.wakeLock = null; }
}
function releaseWakeLock() {
  if (S.wakeLock) S.wakeLock.release().catch(() => {});
  S.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.running && !S.wakeLock) requestWakeLock();
});

// ---------- 表示 ----------

const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));
const signed = (v, d = 1) => (v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(d));
const setText = (id, t) => { const e = document.getElementById(id); if (e.textContent !== t) e.textContent = t; };
const setUpDown = (id, v) => {
  const e = document.getElementById(id);
  e.classList.toggle('up', v > 0.1);
  e.classList.toggle('down', v < -0.1);
};

function updateGpsBadge(acc, msg) {
  const e = $('#gps');
  e.className = 'badge ' + (acc == null ? 'bad' : acc <= 10 ? 'ok' : acc <= 30 ? 'warn' : 'bad');
  e.textContent = msg ? `GPS ${msg}` : acc == null ? 'GPS --' : `GPS ±${Math.round(acc)}m`;
}

function render() {
  const f = last();
  if (!f) return;
  const a = alt(f);
  const gt = C.groundTrack(S.fixes);
  const vs = C.verticalSpeed(S.fixes, settings.varioWindow);
  const ld = C.glideRatio(S.fixes, settings.ldWindow);

  setText('v-alt', fmt(a));
  // 対地高度（国土地理院の標高データ）。取れない場所は離陸地点からの高さ
  const ground = G.elevation(f.lat, f.lon, () => { render(); });
  if (ground != null) { setText('agl-label', '対地高度'); setText('v-agl', fmt(a - ground)); }
  else { setText('agl-label', '離陸比'); setText('v-agl', S.takeoff ? signed(f.alt - S.takeoff.alt, 0) : '--'); }
  setText('v-spd', fmt(gt && gt.spd * 3.6));
  setText('v-vario', signed(vs));
  setUpDown('v-vario', vs);
  setText('v-ld', ld === Infinity ? '∞' : fmt(ld, ld != null && ld < 10 ? 1 : 0));
  drawVarioColumn(C.verticalSpeed(S.fixes, 3));

  // サーマルゲイン（今のサーマルで稼いだ高度）と平均上昇率
  const inThermal = S.circling && S.circleStart;
  const thermal = inThermal
    ? (f.alt - S.circleStart.alt) / Math.max(1, (f.t - S.circleStart.t) / 1000)
    : S.lastThermal;
  setText('v-thermal', signed(thermal));
  const gain = inThermal ? f.alt - S.circleStart.alt : S.lastGain;
  setText('v-gain', gain == null ? '--' : signed(gain, 0));
  setUpDown('v-gain', gain);

  const hdg = gt && gt.hdg != null ? gt.hdg : null;
  // 上の目標セルのコンパス（地図に重ねない）と、速度の下の風
  drawCompassCell();
  setText('v-windtxt', S.wind ? `風 ${settings.windUnit === 'ms' ? S.wind.speed.toFixed(1) + ' m/s' : Math.round(S.wind.speed * 3.6) + ' km/h'}` : '');

  // 目標は自動で選ぶ: タスクの次の TP → 設定したゴール → 一番近い着陸地
  const tg = currentTarget(f, a);
  if (tg) {
    setText('v-goal-name', tg.label);
    setText('v-goal-dist', fmt(tg.dist / 1000, tg.dist < 10000 ? 1 : 0));
    setText('v-goal-arr', fmt(tg.arrival));
    setUpDown('v-goal-arr', tg.arrival - settings.margin);
    setText('v-goal-ld', tg.reqLD > 99 ? '>99' : fmt(tg.reqLD, 1));
    setText('v-goal-sub', tg.sub);
    lowAltitudeWarning(f, tg);
  } else {
    setText('v-goal-name', task && prog ? 'タスク完了' : '目標なし');
    for (const id of ['v-goal-dist', 'v-goal-arr', 'v-goal-ld']) setText(id, '--');
    setText('v-goal-sub', task && prog && prog.goalT ? `ゴール ${clock(prog.goalT)}` : 'WP タブで着陸地を読み込むと自動で案内します');
  }

  // ステータスバー
  const rec = $('#rec');
  if (S.demo) { rec.textContent = 'デモ'; rec.className = 'badge warn'; }
  else if (S.flightStart != null && S.flightEnd == null) { rec.textContent = '● 飛行中'; rec.className = 'badge rec'; }
  else if (S.flightEnd != null) { rec.textContent = '着陸'; rec.className = 'badge ok'; }
  else { rec.textContent = '離陸待ち'; rec.className = 'badge'; }
  if (S.flightStart != null) {
    const sec = Math.floor(((S.flightEnd ?? f.t) - S.flightStart) / 1000);
    setText('ftime', `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`);
  }
}

const clock = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function taskStatus(now, ti) {
  const gates = C.startGates(task, now);
  const parts = [`ゴールまで ${(ti.remaining / 1000).toFixed(1)} km`];
  if (prog.startT == null && gates.length) {
    const next = gates.find((g) => g > now);
    parts.unshift(next ? `スタートまで ${mmss(next - now)}` : `スタート開放 ${clock(gates[0])}〜`);
  } else if (prog.startT != null) {
    parts.unshift(`スタート ${clock(prog.startT)} 経過 ${mmss(now - prog.startT)}`);
  }
  return parts.join(' ・ ');
}

// ターンポイント通過などの合図音（スタートボタンを押した時に音声を有効化）
let audio = null;
function beep(n = 1) {
  if (!audio) return;
  for (let i = 0; i < n; i++) {
    const o = audio.createOscillator(), g = audio.createGain();
    const t0 = audio.currentTime + i * 0.25;
    o.frequency.value = 1400; g.gain.value = 0.4;
    o.connect(g); g.connect(audio.destination);
    o.start(t0); o.stop(t0 + 0.15);
  }
}

function currentTarget(f, a) {
  const ti = task && prog ? C.taskInfo(task, prog, f, a, settings, S.wind) : null;
  if (ti) {
    const n = task.turnpoints.length;
    const kind = ti.tp.type === 'SSS' ? 'スタート' : prog.idx === n - 1 ? 'ゴール' : ti.tp.type === 'ESS' ? 'ESS' : 'TP';
    return {
      label: `${kind} ${prog.idx + 1}/${n} ${ti.tp.name}`, p: ti.tp, dist: ti.toEdge, brg: ti.brg,
      arrival: ti.arrival, reqLD: ti.reqLD, sub: taskStatus(f.t, ti), landing: false,
    };
  }
  let wp = goal, label = goal && `ゴール ${goal.name}`;
  if (!wp) {
    // 一番近い着陸地
    let best = Infinity;
    for (const w of waypoints) {
      if (!w.landing) continue;
      const d = C.distance(f.lat, f.lon, w.lat, w.lon);
      if (d < best) { best = d; wp = w; }
    }
    label = wp && `最寄りLD ${wp.name}`;
  }
  if (!wp) return null;
  const g = C.goalInfo(f, a, wp, settings, S.wind);
  return { label, p: wp, dist: g.dist, brg: g.brg, arrival: g.arrival, reqLD: g.reqLD, sub: '', landing: wp.landing || !!goal };
}

// 着陸地への到着高度がマージンを下回ったら声で知らせる（1 分に 1 回まで）
function lowAltitudeWarning(f, tg) {
  // ランディングへの進入中（800m 以内）は高度が下がるのが当然なので知らせない
  if (S.flightStart == null || S.flightEnd != null || !tg.landing || tg.dist < 800) return;
  const low = tg.arrival < settings.margin;
  if (low && !S.lowWarned && f.t - S.lowWarnT > 60000) {
    S.lowWarned = true; S.lowWarnT = f.t;
    speak(tg.arrival < 0 ? `${tg.p.name} に届きません` : `${tg.p.name} まで高度に余裕がありません`);
  }
  if (!low && tg.arrival > settings.margin + 50) S.lowWarned = false;
}

// XCTrack のバリオカラム: 上昇は上へ緑、沈下は下へ赤
function drawVarioColumn(v) {
  const c = $('#vario-col');
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.body);
  ctx.fillStyle = css.getPropertyValue('--tile'); ctx.fillRect(0, 0, w, h);
  const mid = h / 2, k = (h / 2) / 5; // ±5 m/s
  ctx.strokeStyle = css.getPropertyValue('--muted'); ctx.lineWidth = 1;
  for (let i = -4; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i ? w * 0.6 : 0, mid - i * k); ctx.lineTo(w, mid - i * k); ctx.stroke(); }
  if (v == null) return;
  const vv = Math.max(-5, Math.min(5, v));
  ctx.fillStyle = vv >= 0 ? css.getPropertyValue('--up') : css.getPropertyValue('--down');
  ctx.fillRect(4, Math.min(mid, mid - vv * k), w - 8, Math.abs(vv * k));
}

// ---------- 音声案内 ----------

function speak(text) {
  if (window.__hang) window.__hang.spoken.push(text);
  if (settings.voice === 'off' || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* 音声なし */ }
}

// ---------- 離陸・着陸の自動動作 ----------

function onTakeoff() {
  speak(S.demo ? 'デモ飛行。テイクオフしました' : 'テイクオフ。記録を開始しました');
  showPage('main');
  lockScreen(true);
}

function onLanding() {
  speak(S.demo ? '着陸しました' : '着陸しました。記録を保存しました');
  lockScreen(false);
  showLandedSummary();
}

// 飛行中は画面をロックして、ハーネスや手袋が当たっても何も変わらないようにする
function lockScreen(on) {
  document.body.classList.toggle('locked', on);
  if (on) showPage('main');
}

function isFlying() { return S.flightStart != null && S.flightEnd == null; }

// ステータスバーを長押し（約 1 秒）で 30 秒だけロック解除
let pressTimer = null;
$('#status').addEventListener('pointerdown', () => {
  if (!document.body.classList.contains('locked')) return;
  document.body.classList.add('show-hint');
  pressTimer = setTimeout(() => {
    document.body.classList.remove('locked', 'show-hint');
    S.unlockUntil = Date.now() + 30000;
    beep(1);
  }, 900);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('#status').addEventListener(ev, () => { clearTimeout(pressTimer); document.body.classList.remove('show-hint'); });
}
setInterval(() => {
  if (isFlying() && !document.body.classList.contains('locked') && Date.now() > S.unlockUntil) lockScreen(true);
}, 5000);

function showLandedSummary() {
  const fx = S.fixes.filter((x) => x.t >= S.flightStart && x.t <= S.flightEnd);
  if (fx.length < 2) return;
  let dist = 0, maxAlt = -Infinity, maxClimb = 0, maxSink = 0;
  for (let i = 1; i < fx.length; i++) {
    dist += C.distance(fx[i - 1].lat, fx[i - 1].lon, fx[i].lat, fx[i].lon);
    maxAlt = Math.max(maxAlt, alt(fx[i]));
    const v = Math.abs(fx[i].v || 0) < 15 ? fx[i].v || 0 : 0; // GPS の飛びは除く
    maxClimb = Math.max(maxClimb, v);
    maxSink = Math.min(maxSink, v);
  }
  const free = C.distance(fx[0].lat, fx[0].lon, fx[fx.length - 1].lat, fx[fx.length - 1].lon);
  const sec = Math.round((S.flightEnd - S.flightStart) / 1000);
  const rows = [
    ['滞空時間', `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`],
    ['最高高度', `${Math.round(maxAlt)} m`],
    ['最大上昇', `+${maxClimb.toFixed(1)} m/s`],
    ['最大シンク', `${maxSink.toFixed(1)} m/s`],
    ['トラック距離', `${(dist / 1000).toFixed(2)} km`],
    ['離陸からの直線距離', `${(free / 1000).toFixed(2)} km`],
  ];
  if (task && prog && prog.goalT) rows.push(['タスク', `ゴール ${clock(prog.goalT)}`]);
  $('#landed-list').innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join('');
  $('#landed-igc').hidden = S.demo;
  $('#landed').classList.remove('hidden');
}
$('#landed-close').addEventListener('click', () => $('#landed').classList.add('hidden'));
$('#landed-igc').addEventListener('click', async () => {
  const logs = (await db.all('logs').catch(() => [])).sort((a, b) => b.start - a.start);
  if (logs[0]) exportIGC(logs[0]);
});

function tickClock() {
  const d = new Date();
  setText('clock', `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
}

// ---------- マップ描画 ----------

function varioColor(v) {
  if (v > 2.5) return '#e00000';
  if (v > 1) return '#ff8000';
  if (v > 0.2) return '#e0c000';
  if (v > -1.5) return getComputedStyle(document.body).getPropertyValue('--track');
  return '#3060ff';
}

// ---------- 滑らかに動く地図 ----------

// GPS は 1 秒に 1 回なので、その間は速度と方位から今いる場所を予測して動かす
function predicted() {
  const f = last();
  if (!f) return null;
  const gt = C.groundTrack(S.fixes);
  if (!gt || gt.spd < 1 || gt.hdg == null) return { lat: f.lat, lon: f.lon, hdg: gt && gt.hdg };
  // デモは 4 倍速なので、GPS の時刻と実際の時間の比で進める
  const prev = S.fixes[S.fixes.length - 2];
  const rate = prev && S.fixAt > S.prevFixAt ? Math.max(0.5, Math.min(8, (f.t - prev.t) / (S.fixAt - S.prevFixAt))) : 1;
  const dt = Math.min(2, (rate * (performance.now() - S.fixAt)) / 1000);
  const r = (gt.hdg * Math.PI) / 180;
  const p = C.fromXY(f.lat, f.lon, gt.spd * Math.sin(r) * dt, gt.spd * Math.cos(r) * dt);
  return { lat: p.lat, lon: p.lon, hdg: gt.hdg };
}

// 地図の向き（進行方向アップ）も急に回らないよう少しずつ回す
let lastFrameAt = performance.now();
function smoothUp(target) {
  const now = performance.now();
  const k = Math.min(1, ((now - lastFrameAt) / 1000) * 3);
  lastFrameAt = now;
  if (target == null) return S.viewUp;
  S.viewUp = C.norm360(S.viewUp + C.norm180(target - S.viewUp) * k);
  return S.viewUp;
}

// Google マップのような青い現在地マーカー（向いている方向に光の扇）
function drawMe(ctx, x, y, rotDeg) {
  ctx.save();
  ctx.translate(x, y);
  if (rotDeg != null) {
    ctx.rotate((rotDeg * Math.PI) / 180);
    const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 52);
    g.addColorStop(0, 'rgba(66,133,244,0.55)');
    g.addColorStop(1, 'rgba(66,133,244,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 52, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); ctx.closePath(); ctx.fill();
  }
  ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 4;
  ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fillStyle = '#4285f4'; ctx.fill();
  ctx.restore();
}

// 今向いている方向: 動いている時は GPS の進行方向、止まっている時は iPhone の磁気コンパス
function headingNow(gpsHdg) {
  const gt = C.groundTrack(S.fixes);
  if (gpsHdg != null && gt && gt.spd >= 2) return { hdg: gpsHdg, src: 'GPS' };
  if (S.magHdg != null) return { hdg: S.magHdg, src: '磁気' };
  return { hdg: gpsHdg, src: 'GPS' };
}

// コンパス: 方位の目盛り（地図と同じ向き）、上の ▼ が今の方向、
// 青い矢印が目標の方向、灰色の矢印が風の吹いていく方向
function drawCompassCell() {
  const c = $('#compass');
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const me = predicted();
  const f = last();
  const tg = f && currentTarget(f, alt(f));
  const up = settings.trackUp ? S.viewUp : 0;
  drawCompass(ctx, w / 2, h / 2, Math.min(w, h) / 2 - 3, up, me && me.hdg, tg && me ? C.bearing(me.lat, me.lon, tg.p.lat, tg.p.lon) : null, { bgAlpha: 0, sub: false });
}

function drawCompass(ctx, cx, cy, r, up, gpsHdg, targetBrg, opt = {}) {
  const css = getComputedStyle(document.body);
  const fg = css.getPropertyValue('--fg'), bg = css.getPropertyValue('--bg');
  const { hdg, src } = headingNow(gpsHdg);
  const at = (deg, rr) => {
    const a = ((deg - up) * Math.PI) / 180;
    return [cx + Math.sin(a) * rr, cy - Math.cos(a) * rr];
  };
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  const a = opt.bgAlpha ?? 0.55;
  ctx.fillStyle = settings.theme === 'night' ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`;
  ctx.fill(); ctx.strokeStyle = fg; ctx.lineWidth = 2; ctx.stroke();
  // 目盛り
  const tiny = r < 30;
  for (let d = 0; d < 360; d += tiny ? 30 : 10) {
    const [x1, y1] = at(d, r - 2), [x2, y2] = at(d, r - (d % 30 ? 6 : tiny ? 5 : 11));
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = fg; ctx.lineWidth = d % 90 ? 1 : 2; ctx.stroke();
  }
  ctx.font = `bold ${Math.round(r * 0.28)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(tiny ? 11 : r * 0.28)}px sans-serif`;
  for (const [d, t] of tiny ? [[0, 'N']] : [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const [x, y] = at(d, r * 0.58);
    ctx.fillStyle = d === 0 ? '#e00000' : fg; ctx.fillText(t, x, y);
  }
  // 風（吹いていく方向）
  if (S.wind) {
    const [x1, y1] = at(S.wind.from, r * 0.85), [x2, y2] = at(S.wind.from + 180, r * 0.85);
    ctx.strokeStyle = '#888888'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const [hx, hy] = at(S.wind.from + 180, r * 0.85), [lx, ly] = at(S.wind.from + 180 - 14, r * 0.55), [rx, ry] = at(S.wind.from + 180 + 14, r * 0.55);
    ctx.fillStyle = '#888888'; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(lx, ly); ctx.lineTo(rx, ry); ctx.fill();
  }
  // 目標の方向
  if (targetBrg != null) {
    // 真ん中の数字に重ならないよう、外側だけに太い矢印
    const [tx, ty] = at(targetBrg, r * 0.92), [lx, ly] = at(targetBrg - 16, r * 0.5), [rx, ry] = at(targetBrg + 16, r * 0.5);
    const [bx, by] = at(targetBrg, r * 0.6);
    ctx.fillStyle = css.getPropertyValue('--accent');
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(lx, ly); ctx.lineTo(bx, by); ctx.lineTo(rx, ry); ctx.closePath(); ctx.fill();
  }
  // 今の方向（外側の ▼）と数字
  if (hdg != null) {
    const m = tiny ? 9 : 16;
    const [px, py] = at(hdg, r - 2), [lx, ly] = at(hdg - 12, r - m), [rx, ry] = at(hdg + 12, r - m);
    ctx.fillStyle = '#ff8000'; ctx.strokeStyle = bg; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(lx, ly); ctx.lineTo(rx, ry); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  if (tiny) { ctx.restore(); return; }
  ctx.font = `bold ${Math.round(r * 0.3)}px sans-serif`;
  ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.fillStyle = fg;
  const label = hdg != null ? `${String(Math.round(C.norm360(hdg)) % 360).padStart(3, '0')}°` : '---';
  ctx.strokeText(label, cx, cy); ctx.fillText(label, cx, cy);
  if (opt.sub === false) { ctx.restore(); return; }
  ctx.font = `${Math.round(Math.max(11, r * 0.2))}px sans-serif`;
  const sub = S.wind ? (settings.windUnit === 'ms' ? `風 ${S.wind.speed.toFixed(1)}m/s` : `風 ${Math.round(S.wind.speed * 3.6)}km/h`) : src;
  ctx.strokeText(sub, cx, cy + r + 12); ctx.fillText(sub, cx, cy + r + 12);
  ctx.restore();
}

// view: { center, up, me } を省くと自機中心・自動
function drawMap(canvas, widthM, small, view = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.body);
  const fg = css.getPropertyValue('--fg'), bg = css.getPropertyValue('--bg');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

  const me = predicted();
  // GPS が無い時はゴール・タスク・ウェイポイントの周りを表示（飛ぶ前の確認用）
  const f = view.center || me || mapCenter();
  if (!f) {
    ctx.fillStyle = fg; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('GPS 待ち…', w / 2, h / 2);
    return;
  }
  const up = view.up != null ? view.up : settings.trackUp ? smoothUp(me && me.hdg) : 0;
  const scale = w / widthM; // px / m
  const cx = w / 2, cy = h * (settings.trackUp && !view.center ? 0.62 : 0.5);
  const cos = Math.cos((-up * Math.PI) / 180), sin = Math.sin((-up * Math.PI) / 180);
  ctx.lineJoin = 'round'; // 文字の縁取りにトゲが出ないように
  const P = (lat, lon) => {
    const p = C.toXY(f.lat, f.lon, lat, lon);
    const x = p.x * cos - p.y * sin, y = p.x * sin + p.y * cos;
    return [cx + x * scale, cy - y * scale];
  };
  canvas._view = { f, up, scale, cx, cy }; // 指で動かす時に使う

  // 背景地図
  if (settings.mapLayer !== 'none') {
    T.drawTiles(ctx, settings.mapLayer, P, f, scale, Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)), dpr);
    // 軌跡や文字が見えるように少しだけ薄く（夜は暗く）する
    const wash = T.LAYERS[settings.mapLayer].wash ?? 0.12;
    ctx.fillStyle = settings.theme === 'night' ? 'rgba(0,0,0,0.45)' : `rgba(255,255,255,${wash})`;
    ctx.fillRect(0, 0, w, h);
  }

  // サーマル
  for (const t of S.thermals) {
    const [x, y] = P(t.lat, t.lon);
    ctx.beginPath();
    ctx.arc(x, y, 6 + Math.min(14, t.climb * 4), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(230,0,0,0.25)'; ctx.fill();
    ctx.strokeStyle = '#e00000'; ctx.lineWidth = 2; ctx.stroke();
    if (!small) { ctx.fillStyle = '#e00000'; ctx.font = 'bold 13px sans-serif'; ctx.fillText(`+${t.climb.toFixed(1)}`, x + 10, y - 10); }
  }

  // 軌跡（昇降で色分け）。最後は予測位置までつなぐ
  ctx.lineWidth = small ? 3 : 4; ctx.lineCap = 'round';
  const start = Math.max(1, S.fixes.length - (small ? 600 : 20000));
  let [px, py] = S.fixes.length ? P(S.fixes[start - 1].lat, S.fixes[start - 1].lon) : [0, 0];
  for (let i = start; i < S.fixes.length; i++) {
    const g = S.fixes[i];
    const [x, y] = P(g.lat, g.lon);
    ctx.strokeStyle = varioColor(g.v);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
    px = x; py = y;
  }
  if (me && S.fixes.length) {
    const [x, y] = P(me.lat, me.lon);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
  }

  // ウェイポイント
  ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left';
  for (const wp of waypoints) {
    const isGoal = goal && goal.lat === wp.lat && goal.lon === wp.lon;
    // 飛行画面では飛ぶのに必要な地点（着陸地・テイクオフ・危険・ゴール）だけ
    if (small && !isGoal && !wp.landing && wp.kind !== 'takeoff' && wp.kind !== 'nogo') continue;
    const [x, y] = P(wp.lat, wp.lon);
    if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
    ctx.strokeStyle = fg; ctx.lineWidth = 2;
    if (wp.kind === 'nogo') {
      ctx.strokeStyle = '#e00000'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(x - 8, y - 8); ctx.lineTo(x + 8, y + 8); ctx.moveTo(x + 8, y - 8); ctx.lineTo(x - 8, y + 8); ctx.stroke();
    } else if (wp.kind === 'takeoff') {
      ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 8, y + 6); ctx.lineTo(x - 8, y + 6); ctx.closePath();
      ctx.fillStyle = '#e0a000'; ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(x, y, isGoal ? 9 : 6, 0, Math.PI * 2);
      ctx.fillStyle = wp.landing ? '#00a040' : css.getPropertyValue('--accent');
      ctx.fill(); ctx.stroke();
    }
    if (!small || wp.landing || isGoal) {
      // 地図の上でも読めるよう白（夜は黒）で縁取り
      ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.strokeText(wp.name, x + 10, y + 5);
      ctx.fillStyle = fg; ctx.fillText(wp.name, x + 10, y + 5);
    }
  }

  // タスク: シリンダーと経路
  if (task) {
    const tps = task.turnpoints;
    ctx.lineWidth = 2; ctx.strokeStyle = '#a000c8';
    ctx.beginPath();
    tps.forEach((tp, i) => { const [x, y] = P(tp.lat, tp.lon); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    tps.forEach((tp, i) => {
      const [x, y] = P(tp.lat, tp.lon);
      const next = prog && i === prog.idx;
      const done = prog && i < prog.idx;
      ctx.beginPath(); ctx.arc(x, y, Math.max(3, tp.radius * scale), 0, Math.PI * 2);
      ctx.fillStyle = next ? 'rgba(160,0,200,0.18)' : 'rgba(160,0,200,0.06)';
      ctx.fill();
      ctx.lineWidth = next ? 4 : 2; ctx.strokeStyle = done ? '#999999' : '#a000c8';
      ctx.stroke();
      ctx.fillStyle = '#a000c8'; ctx.font = 'bold 14px sans-serif';
      ctx.fillText(`${i + 1}${tp.type === 'SSS' ? ' S' : tp.type === 'ESS' ? ' E' : ''}`, x - 4, y - Math.max(8, tp.radius * scale) - 4);
    });
  }
  if (S.takeoff) {
    const [x, y] = P(S.takeoff.lat, S.takeoff.lon);
    ctx.strokeStyle = fg; ctx.lineWidth = 2;
    ctx.strokeRect(x - 6, y - 6, 12, 12);
  }

  // 目標への線
  const fx = last();
  const tg = fx && currentTarget(fx, alt(fx));
  if (tg && me) {
    const [mx, my] = P(me.lat, me.lon);
    const [x, y] = P(tg.p.lat, tg.p.lon);
    ctx.setLineDash([8, 6]); ctx.strokeStyle = css.getPropertyValue('--accent'); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(x, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 現在地
  if (me) {
    const [x, y] = P(me.lat, me.lon);
    drawMe(ctx, x, y, me.hdg != null ? me.hdg - up : null);
  }

  // 地図タブだけ右上に小さく透けるコンパス（飛行画面は上の目標欄にある）
  if (!small) {
    const r = 36;
    drawCompass(ctx, w - r - 8, r + 8, r, up, me && me.hdg, tg && me ? C.bearing(me.lat, me.lon, tg.p.lat, tg.p.lon) : null, { bgAlpha: 0.35 });
  }

  const bar = niceScale(widthM / 4);
  ctx.strokeStyle = fg; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(10, h - 12); ctx.lineTo(10 + bar * scale, h - 12); ctx.stroke();
  ctx.fillStyle = fg; ctx.font = '13px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 10, h - 18);

  // 地図の出典（利用条件）
  if (settings.mapLayer !== 'none') {
    ctx.font = '10px sans-serif'; ctx.textAlign = small ? 'right' : 'left';
    ctx.fillStyle = fg;
    ctx.fillText(T.LAYERS[settings.mapLayer].attr, small ? w - 4 : 6, small ? h - 4 : 12);
  }
  if (!last()) {
    ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('GPS 待ち（地図の確認のみ）', w / 2, 24);
  }

  // 旋回中（と旋回をやめて 15 秒）は、地図の左上にサーマルアシストを小窓で出す
  if (small && fx && (S.circling || fx.t - S.thermalEnd < 15000)) {
    // 自分の位置（下寄りの真ん中）や目標を隠さないよう、左上に小さく
    const size = Math.min(w * 0.38, h * 0.45, 170);
    drawThermalInto(ctx, 6, 6, size, size);
  }
}

// GPS が無い時の地図の中心: タスクの最初 → ゴール → 最初のウェイポイント
function mapCenter() {
  const p = (task && task.turnpoints[0]) || goal || waypoints[0];
  return p ? { lat: p.lat, lon: p.lon } : null;
}

T.setOnTileLoad(() => { S.dirty = true; });

// ---------- 地図の保存（オフライン用） ----------

async function saveMapArea() {
  const c = last() || mapCenter();
  if (!c) return alert('GPS の位置もウェイポイントも無いため、保存する場所が決まりません');
  if (settings.mapLayer === 'none') return alert('背景地図が「なし」になっています');
  const km = Number(prompt(`${last() ? '現在地' : 'タスク／ゴール'}の周り何 km の地図を保存しますか？`, settings.saveRadiusKm));
  if (!km || km <= 0) return;
  if (km > 30) return alert('一度に保存できるのは半径 30 km までです');
  settings.saveRadiusKm = km; save('settings', settings);
  // 背景地図と、対地高度に使う標高データを一緒に保存
  const urls = T.tilesForSave(settings.mapLayer, c.lat, c.lon, km * 1000).concat(G.demUrlsAround(c.lat, c.lon, km * 1000));
  if (!confirm(`${T.LAYERS[settings.mapLayer].name}を ${urls.length} 枚（約 ${Math.ceil(urls.length * 0.02)} MB）保存します。\nWi-Fi のある所で行ってください。`)) return;
  const st = $('#map-status');
  st.hidden = false;
  const r = await T.saveTiles(urls, (d, n, fail) => { st.textContent = `地図を保存中 ${d} / ${n}` + (fail ? `（失敗 ${fail}）` : ''); });
  st.textContent = r.failed ? `保存完了（${r.failed} 枚失敗。もう一度押すと続きを保存します）` : '地図を保存しました。電波が無くても表示できます';
  setTimeout(() => { st.hidden = true; }, 5000);
  renderMapInfo();
}

async function renderMapInfo() {
  setText('map-saved', `${await T.savedTileCount()} 枚`);
}

$('#map-save').addEventListener('click', saveMapArea);
$('#map-save2').addEventListener('click', saveMapArea);
$('#map-clear').addEventListener('click', async () => {
  if (!confirm('保存した地図をすべて削除しますか？')) return;
  await T.clearTiles(); renderMapInfo(); S.dirty = true;
});
$('#map-layer').addEventListener('click', () => {
  const keys = ['none', ...Object.keys(T.LAYERS)];
  settings.mapLayer = keys[(keys.indexOf(settings.mapLayer) + 1) % keys.length];
  save('settings', settings); renderSettings(); S.dirty = true;
});

// 地図の自動ズーム: 目標までの距離に合わせる（1.5〜15 km）
function autoMapWidth() {
  const f = last();
  const tg = f && currentTarget(f, alt(f));
  if (!tg) return 3000;
  return Math.max(1500, Math.min(15000, tg.dist * 2.6));
}

// サーマルアシスト: 直近 2 分の軌跡を昇降の強さで色と大きさを変えて描く。
// 風で流された分を補正するので、サーマルのコア（一番上がる場所）が分かる。
function drawThermalInto(ctx, ox, oy, w, h) {
  const css = getComputedStyle(document.body);
  const fg = css.getPropertyValue('--fg');
  ctx.save();
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(ox, oy, w, h, 10) : ctx.rect(ox, oy, w, h);
  ctx.fillStyle = settings.theme === 'night' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
  ctx.fill(); ctx.strokeStyle = fg; ctx.lineWidth = 2; ctx.stroke();
  ctx.clip();
  const f = last();
  const gt = C.groundTrack(S.fixes);
  const up = settings.trackUp ? S.viewUp : 0;
  const widthM = 300, scale = Math.min(w, h) / widthM;
  const cx = ox + w / 2, cy = oy + h / 2;
  const cos = Math.cos((-up * Math.PI) / 180), sin = Math.sin((-up * Math.PI) / 180);
  const wind = S.wind && S.wind.speed > 0.5 ? S.wind : null;
  const wx = wind ? wind.speed * Math.sin(((wind.from + 180) * Math.PI) / 180) : 0;
  const wy = wind ? wind.speed * Math.cos(((wind.from + 180) * Math.PI) / 180) : 0;
  const P = (p) => {
    const q = C.toXY(f.lat, f.lon, p.lat, p.lon);
    const dt = (f.t - p.t) / 1000;
    const x0 = q.x + wx * dt, y0 = q.y + wy * dt; // 空気と一緒に流す
    const x = x0 * cos - y0 * sin, y = x0 * sin + y0 * cos;
    return [cx + x * scale, cy - y * scale];
  };
  const pts = C.recent(S.fixes, 120);
  // コア: 上昇している点の重み付き平均
  let sx = 0, sy = 0, sw = 0;
  for (const p of pts) {
    const [x, y] = P(p);
    const v = p.v || 0;
    if (v > 0) { sx += x * v; sy += y * v; sw += v; }
    ctx.beginPath();
    ctx.arc(x, y, 2 + Math.max(0, Math.min(5, v)) * 1.8, 0, Math.PI * 2);
    ctx.fillStyle = varioColor(v); ctx.globalAlpha = 0.25 + 0.75 * ((p.t - pts[0].t) / Math.max(1, f.t - pts[0].t));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (sw > 0) {
    ctx.beginPath(); ctx.arc(sx / sw, sy / sw, 12, 0, Math.PI * 2);
    ctx.strokeStyle = '#e00000'; ctx.lineWidth = 3; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
  drawMe(ctx, cx, cy, gt && gt.hdg != null ? gt.hdg - up : null);
  ctx.fillStyle = fg; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('サーマル', ox + 6, oy + 16);
  ctx.font = '11px sans-serif'; ctx.fillText('100 m', ox + 6, oy + h - 10);
  ctx.lineWidth = 2; ctx.strokeStyle = fg;
  ctx.beginPath(); ctx.moveTo(ox + 6, oy + h - 6); ctx.lineTo(ox + 6 + 100 * scale, oy + h - 6); ctx.stroke();
  ctx.restore();
}

function niceScale(m) {
  const p = 10 ** Math.floor(Math.log10(m));
  return [1, 2, 5, 10].map((k) => k * p).filter((v) => v <= m).pop();
}

// 地図ページの見え方（ピンチで拡大縮小、指で移動、「現在地」で戻る）
function mapPageView() {
  if (S.follow) return {};
  return { center: S.panCenter, up: S.panUp };
}

let lastDraw = 0;
function frame(now) {
  // 飛行中・GPS 受信中は 1 秒に 20 回描き直して地図を滑らかに動かす
  const moving = S.running && last() && now - lastDraw > 50;
  if (S.dirty || moving) {
    S.dirty = false;
    lastDraw = now;
    const page = document.querySelector('.page.active').id;
    if (page === 'page-main') drawMap($('#mini-map'), autoMapWidth(), true);
    if (page === 'page-map') drawMap($('#map'), settings.mapWidth, false, mapPageView());
  }
  requestAnimationFrame(frame);
}

// ---- 地図ページの指の操作 ----
{
  const cv = $('#map');
  const ptrs = new Map();
  let start = null;
  const snapshot = () => {
    const [a, b] = [...ptrs.values()];
    return {
      width: settings.mapWidth,
      center: S.follow ? (cv._view && cv._view.f) : S.panCenter,
      up: cv._view ? cv._view.up : 0,
      mid: b ? [(a.x + b.x) / 2, (a.y + b.y) / 2] : [a.x, a.y],
      dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
    };
  };
  cv.addEventListener('pointerdown', (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch { /* 指が離れた後など */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start = snapshot();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !start || !start.center) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = snapshot();
    if (start.dist && now.dist) settings.mapWidth = Math.max(150, Math.min(100000, (start.width * start.dist) / now.dist));
    const pxPerM = cv.clientWidth / settings.mapWidth;
    const dx = (now.mid[0] - start.mid[0]) / pxPerM, dy = (now.mid[1] - start.mid[1]) / pxPerM;
    if (Math.hypot(dx * pxPerM, dy * pxPerM) < 4 && !start.dist) return; // 少し触っただけ
    // 画面の動きを地図の向きに合わせて東西南北に直す
    const r = (start.up * Math.PI) / 180;
    const ex = -(dx * Math.cos(r) + dy * Math.sin(r)), ny = -(dx * Math.sin(r) - dy * Math.cos(r));
    const c = C.fromXY(start.center.lat, start.center.lon, ex, ny);
    S.follow = false; S.panCenter = { lat: c.lat, lon: c.lon }; S.panUp = start.up;
    $('#map-follow').hidden = false;
    S.dirty = true;
  });
  const end = (e) => {
    ptrs.delete(e.pointerId);
    start = ptrs.size ? snapshot() : null;
    save('settings', settings);
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    settings.mapWidth = Math.max(150, Math.min(100000, settings.mapWidth * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    S.dirty = true;
  }, { passive: false });
}
$('#map-follow').addEventListener('click', () => {
  S.follow = true; $('#map-follow').hidden = true; S.dirty = true;
});

// ---------- ウェイポイント ----------

const KIND = { turnpoint: '一般', landing: '着陸地', takeoff: 'TO', nogo: '危険' };

function renderTask() {
  const box = $('#task-box');
  box.hidden = !task;
  if (!task) return;
  const ul = $('#task-list');
  ul.innerHTML = '';
  const now = last() ? last().t : Date.now();
  const gates = C.startGates(task, now);
  setText('task-meta', `${task.sss ? (task.sss.direction === 'ENTER' ? '入るスタート' : '出るスタート') : 'スタートなし'}` +
    (gates.length ? ` ・ ゲート ${gates.map(clock).join(', ')}` : '') +
    (task.goal.deadline ? ` ・ 締切 ${clock(C.utcTimeNear(task.goal.deadline, now))}` : '') +
    (task.goal.type === 'LINE' ? ' ・ ゴールラインはシリンダーとして扱います' : ''));
  task.turnpoints.forEach((tp, i) => {
    const li = document.createElement('li');
    const state = !prog ? '' : i < prog.idx ? '✓ ' : i === prog.idx ? '▶ ' : '';
    li.className = i === (prog && prog.idx) ? 'goal' : '';
    li.innerHTML = '<div class="grow"><div class="name"></div><div class="meta"></div></div>';
    li.querySelector('.name').textContent = `${state}${i + 1}. ${tp.name}`;
    li.querySelector('.meta').textContent =
      `${tp.type === 'SSS' ? 'スタート' : tp.type === 'ESS' ? 'ESS' : tp.type === 'TAKEOFF' ? 'テイクオフ' : i === task.turnpoints.length - 1 ? 'ゴール' : 'TP'}` +
      ` ・ 半径 ${tp.radius} m` + (tp.code ? ` ・ ${tp.code}` : '');
    ul.appendChild(li);
  });
}

function setTask(t) {
  task = t;
  prog = t ? C.newTaskProgress(t) : null;
  save('task', task); save('taskProg', prog);
  renderTask(); S.dirty = true; render();
}

$('#task-prev').addEventListener('click', () => { if (prog && prog.idx > 0) { prog = { ...prog, idx: prog.idx - 1 }; save('taskProg', prog); renderTask(); render(); S.dirty = true; } });
$('#task-next').addEventListener('click', () => { if (prog && prog.idx < task.turnpoints.length) { prog = { ...prog, idx: prog.idx + 1 }; save('taskProg', prog); renderTask(); render(); S.dirty = true; } });
$('#task-reset').addEventListener('click', () => { if (confirm('タスクの進行を最初に戻しますか？')) setTask(task); });
$('#task-clear').addEventListener('click', () => { if (confirm('タスクを解除しますか？')) setTask(null); });

function renderWaypoints() {
  renderTask();
  const f = last();
  const list = waypoints.map((wp, i) => ({ wp, i, d: f ? C.distance(f.lat, f.lon, wp.lat, wp.lon) : null }));
  if (f) list.sort((a, b) => a.d - b.d);
  const ul = $('#wp-list');
  ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="hint">まだありません</li>';
  for (const { wp, i, d } of list) {
    const isGoal = goal && goal.lat === wp.lat && goal.lon === wp.lon;
    const li = document.createElement('li');
    li.className = (wp.landing ? 'landing ' : '') + (wp.kind === 'nogo' ? 'nogo ' : '') + (isGoal ? 'goal' : '');
    li.innerHTML = `<div class="grow"><div class="name"></div><div class="meta"></div></div>
      <button class="small" data-act="goal">${isGoal ? '★ゴール' : 'ゴール'}</button>
      <button class="small" data-act="land">${KIND[wp.kind] || (wp.landing ? '着陸地' : '一般')}</button>
      <button class="small danger" data-act="del">削除</button>`;
    li.querySelector('.name').textContent = wp.name;
    li.querySelector('.meta').textContent =
      (wp.code ? `${wp.code} ・ ` : '') + `標高 ${Math.round(wp.alt || 0)} m` + (d != null ? ` ・ ${(d / 1000).toFixed(1)} km` : '');
    li.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'goal') { goal = isGoal ? null : { ...wp }; save('goal', goal); }
      if (act === 'land') {
        // 一般 → 着陸地 → テイクオフ → 危険 → 一般 の順に切り替え
        const order = ['turnpoint', 'landing', 'takeoff', 'nogo'];
        wp.kind = order[(order.indexOf(wp.kind || (wp.landing ? 'landing' : 'turnpoint')) + 1) % order.length];
        wp.landing = wp.kind === 'landing';
        save('waypoints', waypoints);
      }
      if (act === 'del' && confirm(`${wp.name} を削除しますか？`)) {
        waypoints.splice(i, 1); save('waypoints', waypoints);
        if (isGoal) { goal = null; save('goal', goal); }
      }
      if (act) { renderWaypoints(); S.dirty = true; render(); }
    });
    ul.appendChild(li);
  }
}

$('#wp-add').addEventListener('click', () => {
  const f = last();
  if (!f) return alert('GPS の位置がまだ取れていません');
  const name = prompt('名前', `WP${waypoints.length + 1}`);
  if (!name) return;
  const landing = confirm('着陸可能な地点ですか？（OK = はい）');
  waypoints.push({ name, lat: f.lat, lon: f.lon, alt: alt(f) || 0, landing });
  save('waypoints', waypoints);
  renderWaypoints(); S.dirty = true;
});

$('#wp-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    try {
      importFile(C.readAnyFile(await file.text(), file.name), file.name);
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
  renderWaypoints(); renderSettings(); S.dirty = true; render();
});

function importFile({ kind, data }, name, quiet = false) {
  if (kind === 'waypoints') {
    const replace = !quiet && waypoints.length && confirm(`${name}\n${data.length} 件のウェイポイントを読み込みました。\n既存のウェイポイントを置き換えますか？（キャンセル = 追加）`);
    // 同じ地点の重複は追加しない
    const key = (w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`;
    const have = new Set((replace ? [] : waypoints).map(key));
    waypoints = (replace ? [] : waypoints).concat(data.filter((w) => !have.has(key(w))));
    save('waypoints', waypoints);
  } else if (kind === 'task') {
    setTask(data);
    if (!quiet) alert(`タスクを読み込みました（${data.turnpoints.length} ポイント）。\n計器画面に次のターンポイントが表示されます。`);
  } else if (kind === 'settings') {
    const lines = [];
    const s = data.settings;
    if (s.bestLD) lines.push(`ゴール滑空比 (L/D): ${s.bestLD}`);
    if (s.trimKmh) lines.push(`トリム速度: ${s.trimKmh} km/h`);
    if (s.windUnit) lines.push(`風速の単位: ${s.windUnit === 'ms' ? 'm/s' : 'km/h'}`);
    if (s.theme) lines.push(`テーマ: ${s.theme === 'night' ? '夜（黒背景）' : '昼（白背景）'}`);
    if (data.goal) lines.push(`ゴール: ${data.goal.name}`);
    if (data.task) lines.push(`タスク: ${data.task.turnpoints.length} ポイント`);
    if (!confirm(`XCTrack の設定から次の項目を取り込みます:\n\n${lines.join('\n')}\n\nよろしいですか？`)) return;
    Object.assign(settings, s);
    if (data.goal) { goal = data.goal; save('goal', goal); }
    if (data.task) setTask(data.task);
    // 配布された設定ファイルは他の人の名前が入っていることがあるので確認する
    if ((data.pilot || data.glider) && confirm(`パイロット名「${data.pilot || ''}」・機体名「${data.glider || ''}」も設定しますか？\n（他の人の設定ファイルならキャンセル）`)) {
      if (data.pilot) settings.pilot = data.pilot;
      if (data.glider) settings.glider = data.glider;
    }
    save('settings', settings);
    const files = data.waypointFiles.concat(data.airspaceFiles);
    alert('設定を取り込みました。' + (files.length ? `\n\nこの設定で使っていたファイル（別途読み込みが必要）:\n${files.join('\n')}` : '') +
      '\n\n※ 画面レイアウト・バリオ音・空域の設定は XCTrack 専用のため取り込みません。');
  }
}

// ---------- スカイ獅子吼 配布データ（Google ドライブ「Skyhang」） ----------
// アプリに同じものを入れてあるので電波が無くても使える。「最新を取り込む」でドライブから取り直す。
const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/1lLYPa8oH_ZAuEPT2EEqjIO94Hn5JmC0P';
const SCHOOL = [
  { name: '獅子吼 ウェイポイント', file: 'SHISHIKU_20260501.wpt', drive: '1Xvu_-27Ef2Ev0tuZyoJYFDXo3lr-mMbZ' },
  { name: 'つくばね（砺波）ウェイポイント', file: '2025Tonami_waypoint.wpt', drive: '1yYwu-D8g2hvERS7ymrEWgtTigOZ_SdIv' },
  { name: '獅子吼 タスク 2026-05-05', file: 'task_2026-05-05_1.xctsk', drive: '1S3FqmvZDs3VGoLBid0dOFCTrGR73HhAL' },
];
const driveUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

async function loadSchool(item, fromDrive) {
  let text = null;
  if (fromDrive) {
    try {
      const res = await fetch(driveUrl(item.drive), { cache: 'no-store' });
      if (res.ok) text = await res.text();
    } catch { /* 電波なし → アプリ内のものを使う */ }
  }
  if (text == null) text = await (await fetch(`presets/${item.file}`)).text();
  importFile(C.readAnyFile(text, item.file), item.file, true);
}

function renderSchool() {
  const box = $('#school-list');
  box.innerHTML = '';
  for (const item of SCHOOL) {
    const b = document.createElement('button');
    b.textContent = item.name;
    b.addEventListener('click', async () => {
      await loadSchool(item, false);
      renderWaypoints(); S.dirty = true; render();
      alert(`${item.name} を読み込みました`);
    });
    box.appendChild(b);
  }
}

$('#school-settings').addEventListener('click', () => {
  if (!confirm('スクール推奨の設定にしますか？\n\nゴール滑空比 (L/D) 7.5・トリム速度 35 km/h・風速 m/s\n（座学で配布された XCTrack 設定と同じ値）')) return;
  Object.assign(settings, { bestLD: 7.5, trimKmh: 35, windUnit: 'ms' });
  save('settings', settings); renderSettings(); render();
});
$('#school-update').addEventListener('click', async () => {
  const btn = $('#school-update');
  btn.disabled = true; btn.textContent = '取り込み中…';
  let ok = 0;
  for (const item of SCHOOL) {
    try { await loadSchool(item, true); ok++; } catch (e) { alert(`${item.name}: ${e.message}`); }
  }
  btn.disabled = false; btn.textContent = 'ドライブから最新を取り込む';
  renderWaypoints(); S.dirty = true; render();
  alert(`${ok} 件取り込みました（ウェイポイントは重複しないよう追加、タスクは最新に置き換え）`);
});
$('#school-folder').href = DRIVE_FOLDER;

$('#wp-goal-clear').addEventListener('click', () => { goal = null; save('goal', null); renderWaypoints(); render(); });
$('#wp-clear').addEventListener('click', () => {
  if (!confirm('全てのウェイポイントを削除しますか？')) return;
  waypoints = []; goal = null; save('waypoints', waypoints); save('goal', null);
  renderWaypoints(); render(); S.dirty = true;
});

// ---------- ログ ----------

async function renderLogs() {
  const logs = (await db.all('logs').catch(() => [])).sort((a, b) => b.start - a.start);
  const ul = $('#log-list');
  ul.innerHTML = '';
  if (!logs.length) ul.innerHTML = '<li class="hint">まだありません。離陸すると自動で記録が始まり、着陸後に保存されます。</li>';
  for (const lg of logs) {
    const d = new Date(lg.start);
    const min = Math.round((lg.end - lg.start) / 60000);
    const li = document.createElement('li');
    li.innerHTML = `<div class="grow"><div class="name"></div><div class="meta"></div></div>
      <button class="small" data-act="igc">IGC</button>
      <button class="small danger" data-act="del">削除</button>`;
    li.querySelector('.name').textContent =
      `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    li.querySelector('.meta').textContent =
      `${Math.floor(min / 60)}時間${min % 60}分 ・ 最高 ${Math.round(lg.maxAlt)} m ・ 移動 ${(lg.dist / 1000).toFixed(1)} km`;
    li.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (act === 'igc') exportIGC(lg);
      if (act === 'del' && confirm('このログを削除しますか？')) { await db.del('logs', lg.id); renderLogs(); }
    });
    ul.appendChild(li);
  }
}

async function exportIGC(lg) {
  const igc = C.toIGC(lg.fixes, { pilot: lg.pilot, glider: lg.glider });
  const d = new Date(lg.start);
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-HG-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.igc`;
  const file = new File([igc], name, { type: 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- 設定 ----------

const form = $('#settings');
function renderSettings() {
  $('#map-layer').textContent = settings.mapLayer === 'none' ? '地図なし' : T.LAYERS[settings.mapLayer].name.replace('地理院 ', '').replace(/（.*）/, '');
  for (const el of form.elements) if (el.name && el.name in settings) el.value = settings[el.name];
  setText('alt-offset', signed(settings.altOffset, 0));
  document.body.dataset.theme = settings.theme;
  $('#map-up').textContent = settings.trackUp ? '進行方向↑' : '北↑';
}
form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  settings[el.name] = el.type === 'number' ? Number(el.value) || DEFAULTS[el.name] : el.value;
  save('settings', settings);
  document.body.dataset.theme = settings.theme;
  S.dirty = true; render();
});
$('#alt-set').addEventListener('click', () => {
  const f = last();
  const elev = Number($('#elev').value);
  if (!f || f.alt == null) return alert('GPS 高度がまだ取れていません');
  if (!$('#elev').value) return alert('離陸場の標高を入力してください');
  settings.altOffset = Math.round(elev - f.alt);
  save('settings', settings); renderSettings(); render();
});
$('#alt-reset').addEventListener('click', () => { settings.altOffset = 0; save('settings', settings); renderSettings(); render(); });
$('#demo').addEventListener('click', async () => { await stop(); start(true); showPage('main'); });
$('#stop').addEventListener('click', () => { if (confirm('計器を停止しますか？（飛行中のログは保存されます）')) stop(); });

// ---------- ページ切替・マップ操作 ----------

function showPage(name) {
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  if (name === 'wp') renderWaypoints();
  if (name === 'log') renderLogs();
  if (name === 'set') renderMapInfo();
  S.dirty = true;
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
$$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
  const k = Number(b.dataset.zoom) > 0 ? 1 / 1.6 : 1.6;
  settings.mapWidth = Math.max(150, Math.min(100000, settings.mapWidth * k));
  save('settings', settings); S.dirty = true;
}));
$('#map-up').addEventListener('click', () => {
  settings.trackUp = !settings.trackUp;
  save('settings', settings); renderSettings(); S.dirty = true; render();
});
window.addEventListener('resize', () => { S.dirty = true; });

// iPhone の磁気コンパス（止まっている時の向き）。許可はタップした時にしか求められない
function startMagCompass() {
  const onOri = (e) => {
    let hdg = e.webkitCompassHeading;
    if (hdg == null && e.absolute && e.alpha != null) hdg = 360 - e.alpha;
    if (hdg == null) return;
    const turn = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    S.magHdg = C.norm360(hdg + turn);
  };
  const listen = () => {
    window.addEventListener('deviceorientationabsolute', onOri);
    window.addEventListener('deviceorientation', onOri);
  };
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') D.requestPermission().then((r) => { if (r === 'granted') listen(); }).catch(() => {});
  else if (D) listen();
}

function unlockAudio() {
  startMagCompass();
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* 音なし */ }
  // iPhone はタップした時に一度話させておかないと、後から自動で話せない
  if (settings.voice !== 'off' && 'speechSynthesis' in window) {
    try { const u = new SpeechSynthesisUtterance('計器をスタートします'); u.lang = 'ja-JP'; speechSynthesis.speak(u); } catch { /* なし */ }
  }
}
$('#start-btn').addEventListener('click', () => { unlockAudio(); start(false); });
$('#start-demo').addEventListener('click', () => { unlockAudio(); start(true); });

// ---------- 起動 ----------

if (window.navigator.standalone) $('#install-hint').hidden = true;
setText('version', `HG 計器 v${VERSION}`);
renderSettings();
renderSchool();
if (load('waypoints', null) == null) {
  loadSchool(SCHOOL[0], false).then(() => { S.dirty = true; }).catch(() => {});
}
tickClock();
setInterval(tickClock, 10000);
requestAnimationFrame(frame);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// テスト用フック
window.__hang = { S, onFix, settings, start, stop, db, importFile, getTask: () => ({ task, prog }), spoken: [] };
