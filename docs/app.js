import * as C from './calc.js';
import { createSim } from './sim.js';

const VERSION = '1.1.0';
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
  pilot: '', glider: '', bestLD: 11, trimKmh: 38, margin: 100,
  altOffset: 0, theme: 'day', varioWindow: 5, ldWindow: 30, autoStartKmh: 15,
  zoom: 4, trackUp: true, windUnit: 'ms',
};
const settings = { ...DEFAULTS, ...load('settings', {}) };
let waypoints = load('waypoints', []);
let goal = load('goal', null);
let task = load('task', null); // XCTrack の .xctsk から読み込んだ大会タスク
let prog = load('taskProg', null);

const ZOOMS = [200, 400, 800, 1500, 3000, 6000, 12000, 25000, 50000]; // 画面幅 [m]

const S = {
  running: false, demo: false,
  fixes: [],
  flightStart: null, flightEnd: null, takeoff: null,
  fastCount: 0, slowSince: null,
  wind: null, windT: 0,
  circling: false, circleStart: null, thermals: [],
  lastThermal: null,
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
  f.v = C.verticalSpeed(S.fixes, 3) ?? 0; // 軌跡の色分け用
  detectFlight(f);
  detectThermal(f);
  if (task && prog) {
    const np = C.taskStep(task, prog, prev, f);
    if (np !== prog) {
      if (np.idx !== prog.idx) beep(np.idx >= task.turnpoints.length ? 3 : 2);
      else if (np.startT !== prog.startT) beep(1);
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
    const dt = (f.t - S.circleStart.t) / 1000;
    const climb = dt > 0 ? (f.alt - S.circleStart.alt) / dt : 0;
    if (dt > 20 && climb > 0.2) {
      // 旋回中に一番よく上がった地点をサーマルとして記録
      const w = S.fixes.filter((x) => x.t >= S.circleStart.t);
      const best = w.reduce((a, b) => (b.v > a.v ? b : a), w[0]);
      S.thermals.push({ lat: best.lat, lon: best.lon, climb });
      if (S.thermals.length > 30) S.thermals.shift();
      S.lastThermal = climb;
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
    const pos = last();
    resetFlight();
    const sim = createSim(pos ? { lat0: pos.lat, lon0: pos.lon, alt0: pos.alt ?? 600 } : {});
    S.simTimer = setInterval(() => onFix(sim.step(1)), 250); // 4 倍速
    return;
  }
  await resumeCurrent();
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
  releaseWakeLock();
  resetFlight();
  $('#start').classList.remove('hidden');
}

function resetFlight() {
  Object.assign(S, {
    fixes: [], flightStart: null, flightEnd: null, takeoff: null,
    fastCount: 0, slowSince: null, wind: null, windT: 0,
    circling: false, circleStart: null, thermals: [], lastThermal: null, dirty: true,
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
  setText('v-agl', S.takeoff ? signed(f.alt - S.takeoff.alt, 0) : '--');
  setText('v-spd', fmt(gt && gt.spd * 3.6));
  setText('v-vario', signed(vs));
  setUpDown('v-vario', vs);
  setText('v-ld', ld === Infinity ? '∞' : fmt(ld, ld != null && ld < 10 ? 1 : 0));

  const thermal = S.circling && S.circleStart
    ? (f.alt - S.circleStart.alt) / Math.max(1, (f.t - S.circleStart.t) / 1000)
    : S.lastThermal;
  setText('v-thermal', signed(thermal));

  const hdg = gt && gt.hdg != null ? gt.hdg : null;
  const rel = (b) => (settings.trackUp && hdg != null ? b - hdg : b);
  if (S.wind) {
    setText('v-wind', settings.windUnit === 'ms' ? fmt(S.wind.speed, 1) : fmt(S.wind.speed * 3.6));
    // 矢印は風が吹いていく向き
    $('#v-wind-arrow').style.transform = `rotate(${rel(S.wind.from + 180)}deg)`;
    const age = Math.round((f.t - S.windT) / 60000);
    setText('v-wind-sub', `${Math.round(S.wind.from)}°から ${age ? age + '分前' : '今'}`);
  }

  const ti = task && prog ? C.taskInfo(task, prog, f, a, settings, S.wind) : null;
  if (ti) {
    const n = task.turnpoints.length;
    const tpType = ti.tp.type === 'SSS' ? 'スタート' : ti.tp.type === 'ESS' && prog.idx === n - 1 ? 'ゴール' : ti.tp.type === 'ESS' ? 'ESS' : prog.idx === n - 1 ? 'ゴール' : 'TP';
    setText('v-goal-name', `タスク ${prog.idx + 1}/${n} ${tpType} ${ti.tp.name} (${ti.tp.radius}m)`);
    setText('v-goal-dist', fmt(ti.toEdge / 1000, ti.toEdge < 10000 ? 1 : 0));
    setText('v-goal-arr', fmt(ti.arrival));
    setUpDown('v-goal-arr', ti.arrival - settings.margin);
    setText('v-goal-ld', ti.reqLD > 99 ? '>99' : fmt(ti.reqLD, 1));
    $('#v-goal-arrow').style.transform = `rotate(${hdg != null ? ti.brg - hdg : ti.brg}deg)`;
    setText('v-goal-sub', taskStatus(f.t, ti));
  } else if (goal) {
    const g = C.goalInfo(f, a, goal, settings, S.wind);
    setText('v-goal-sub', '');
    setText('v-goal-name', `ゴール ${goal.name}`);
    setText('v-goal-dist', fmt(g.dist / 1000, g.dist < 10000 ? 1 : 0));
    setText('v-goal-arr', fmt(g.arrival));
    setUpDown('v-goal-arr', g.arrival - settings.margin);
    setText('v-goal-ld', g.reqLD > 99 ? '>99' : fmt(g.reqLD, 1));
    $('#v-goal-arrow').style.transform = `rotate(${hdg != null ? g.brg - hdg : g.brg}deg)`;
  } else {
    setText('v-goal-name', task && prog ? 'タスク完了' : 'ゴール 未設定（WPタブで設定）');
    setText('v-goal-sub', task && prog && prog.goalT ? `ゴール ${clock(prog.goalT)}` : '');
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

function drawMap(canvas, widthM, small) {
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

  const f = last();
  if (!f) {
    ctx.fillStyle = fg; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('GPS 待ち…', w / 2, h / 2);
    return;
  }
  const gt = C.groundTrack(S.fixes);
  const up = settings.trackUp && gt && gt.hdg != null ? gt.hdg : 0;
  const scale = w / widthM; // px / m
  const cx = w / 2, cy = h * (settings.trackUp ? 0.62 : 0.5);
  const cos = Math.cos((-up * Math.PI) / 180), sin = Math.sin((-up * Math.PI) / 180);
  const P = (lat, lon) => {
    const p = C.toXY(f.lat, f.lon, lat, lon);
    const x = p.x * cos - p.y * sin, y = p.x * sin + p.y * cos;
    return [cx + x * scale, cy - y * scale];
  };

  // サーマル
  for (const t of S.thermals) {
    const [x, y] = P(t.lat, t.lon);
    ctx.beginPath();
    ctx.arc(x, y, 6 + Math.min(14, t.climb * 4), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(230,0,0,0.25)'; ctx.fill();
    ctx.strokeStyle = '#e00000'; ctx.lineWidth = 2; ctx.stroke();
    if (!small) { ctx.fillStyle = '#e00000'; ctx.font = 'bold 13px sans-serif'; ctx.fillText(`+${t.climb.toFixed(1)}`, x + 10, y - 10); }
  }

  // 軌跡（昇降で色分け）
  ctx.lineWidth = small ? 3 : 4; ctx.lineCap = 'round';
  const start = Math.max(1, S.fixes.length - (small ? 600 : 20000));
  let [px, py] = P(S.fixes[start - 1].lat, S.fixes[start - 1].lon);
  for (let i = start; i < S.fixes.length; i++) {
    const g = S.fixes[i];
    const [x, y] = P(g.lat, g.lon);
    ctx.strokeStyle = varioColor(g.v);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
    px = x; py = y;
  }

  // ウェイポイント
  ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left';
  for (const wp of waypoints) {
    const [x, y] = P(wp.lat, wp.lon);
    if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
    const isGoal = goal && goal.lat === wp.lat && goal.lon === wp.lon;
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
    if (!small || wp.landing || isGoal) { ctx.fillStyle = fg; ctx.fillText(wp.name, x + 10, y + 5); }
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

  // 次の目標（タスクの次のターンポイント、なければゴール）への線
  const target = task && prog && prog.idx < task.turnpoints.length ? task.turnpoints[prog.idx] : goal;
  if (target) {
    const [x, y] = P(target.lat, target.lon);
    ctx.setLineDash([8, 6]); ctx.strokeStyle = css.getPropertyValue('--accent'); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 自機
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((((gt && gt.hdg != null ? gt.hdg : 0) - up) * Math.PI) / 180);
  ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(14, 10); ctx.lineTo(0, 4); ctx.lineTo(-14, 10); ctx.closePath();
  ctx.fillStyle = fg; ctx.fill();
  ctx.restore();

  // 北マーク・風・縮尺
  ctx.save();
  ctx.translate(26, 30);
  ctx.rotate((-up * Math.PI) / 180);
  ctx.fillStyle = '#e00000';
  ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(7, 4); ctx.lineTo(-7, 4); ctx.fill();
  ctx.fillStyle = fg; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', 0, 18);
  ctx.restore();

  if (S.wind) {
    ctx.save();
    ctx.translate(w - 34, 34);
    ctx.rotate(((S.wind.from + 180 - up) * Math.PI) / 180);
    ctx.strokeStyle = fg; ctx.fillStyle = fg; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(0, -10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(9, -6); ctx.lineTo(-9, -6); ctx.fill();
    ctx.restore();
    ctx.fillStyle = fg; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(settings.windUnit === 'ms' ? `${S.wind.speed.toFixed(1)}m/s` : `${Math.round(S.wind.speed * 3.6)}km/h`, w - 34, 72);
  }

  const bar = niceScale(widthM / 4);
  ctx.strokeStyle = fg; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(10, h - 12); ctx.lineTo(10 + bar * scale, h - 12); ctx.stroke();
  ctx.fillStyle = fg; ctx.font = '13px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 10, h - 18);
}

function niceScale(m) {
  const p = 10 ** Math.floor(Math.log10(m));
  return [1, 2, 5, 10].map((k) => k * p).filter((v) => v <= m).pop();
}

function frame() {
  if (S.dirty) {
    S.dirty = false;
    const page = document.querySelector('.page.active').id;
    if (page === 'page-main') drawMap($('#mini-map'), S.circling ? 400 : ZOOMS[Math.min(settings.zoom, 5)], true);
    if (page === 'page-map') drawMap($('#map'), ZOOMS[settings.zoom], false);
  }
  requestAnimationFrame(frame);
}

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

function importFile({ kind, data }, name) {
  if (kind === 'waypoints') {
    const replace = waypoints.length && confirm(`${name}\n${data.length} 件のウェイポイントを読み込みました。\n既存のウェイポイントを置き換えますか？（キャンセル = 追加）`);
    // 同じ地点の重複は追加しない
    const key = (w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`;
    const have = new Set((replace ? [] : waypoints).map(key));
    waypoints = (replace ? [] : waypoints).concat(data.filter((w) => !have.has(key(w))));
    save('waypoints', waypoints);
  } else if (kind === 'task') {
    setTask(data);
    alert(`タスクを読み込みました（${data.turnpoints.length} ポイント）。\n計器画面に次のターンポイントが表示されます。`);
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
  for (const el of form.elements) if (el.name && el.name in settings) el.value = settings[el.name];
  setText('alt-offset', signed(settings.altOffset, 0));
  setText('wind-unit', settings.windUnit === 'ms' ? 'm/s' : 'km/h');
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
  S.dirty = true;
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
$$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
  settings.zoom = Math.max(0, Math.min(ZOOMS.length - 1, settings.zoom - Number(b.dataset.zoom)));
  save('settings', settings); S.dirty = true;
}));
$('#map-up').addEventListener('click', () => {
  settings.trackUp = !settings.trackUp;
  save('settings', settings); renderSettings(); S.dirty = true; render();
});
window.addEventListener('resize', () => { S.dirty = true; });

function unlockAudio() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* 音なし */ }
}
$('#start-btn').addEventListener('click', () => { unlockAudio(); start(false); });
$('#start-demo').addEventListener('click', () => { unlockAudio(); start(true); });

// ---------- 起動 ----------

if (window.navigator.standalone) $('#install-hint').hidden = true;
setText('version', `HG 計器 v${VERSION}`);
renderSettings();
tickClock();
setInterval(tickClock, 10000);
requestAnimationFrame(frame);
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// テスト用フック
window.__hang = { S, onFix, settings, start, stop, db, importFile, getTask: () => ({ task, prog }) };
