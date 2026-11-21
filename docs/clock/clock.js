// 置き時計の画面。古い iPad の Safari（iOS 9〜）でも動くよう ES5 + XMLHttpRequest で書いています。
(function () {
  'use strict';

  var L = window.ClockLogic;
  var REFRESH_MS = 15 * 60 * 1000; // 天気は 15 分ごとに取り直す
  var STALE_MS = 60 * 60 * 1000; // 1 時間以上更新できなければ赤で知らせる
  var KEY = 'okidokei-settings';
  var CACHE_KEY = 'okidokei-weather';

  function $(id) { return document.getElementById(id); }

  function load(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ }
  }

  var settings = load(KEY, {});
  var defaults = { h12: false, sec: true, night: true, nightStart: 22, nightEnd: 6, loc: null };
  for (var k in defaults) if (!(k in settings)) settings[k] = defaults[k];

  var weather = load(CACHE_KEY, null); // { data, at, place }
  var wakeUntil = 0;

  // ---------------- 時計 ----------------
  // 省電力のため、表示が変わった所だけ書き換える（毎秒すべてを書き直すと古い iPad では負担が大きい）
  var shown = {};
  function show(id, text) {
    if (shown[id] === text) return;
    shown[id] = text;
    $(id).textContent = text;
  }

  function updateNight(now) {
    var night = settings.night && L.isNight(now.getHours(), settings.nightStart, settings.nightEnd) &&
      now.getTime() > wakeUntil;
    var cls = night ? 'night' : '';
    if (document.body.className !== cls) document.body.className = cls;
  }

  var tickTimer = null;
  function tick() {
    var now = new Date();
    var t = L.formatTime(now, settings.h12);
    show('hm', t.main);
    show('sec', settings.sec ? t.sec : '');
    show('ampm', t.ampm);
    show('date', L.formatDate(now));
    updateNight(now);

    var minute = now.getHours() * 60 + now.getMinutes();
    if (minute !== lastMinute) { lastMinute = minute; everyMinute(now); }
    // 秒を出さない時は 1 分に 1 回だけ動く
    var wait = settings.sec ? 1000 - now.getMilliseconds() : 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
    tickTimer = setTimeout(tick, wait + 5);
  }
  function restartTick() {
    clearTimeout(tickTimer);
    tick();
  }

  var lastMinute = -1;
  var lastReloadDay = new Date().getDate();
  function everyMinute(now) {
    renderStatus();
    // 毎朝 4 時に読み込み直す（アプリの更新を反映し、長時間動かしても重くならないように）
    if (now.getHours() === 4 && now.getMinutes() === 0 && now.getDate() !== lastReloadDay && navigator.onLine !== false) {
      lastReloadDay = now.getDate();
      location.reload();
    }
  }

  // ---------------- 天気 ----------------
  function getJSON(url, ok, ng) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 20000;
    xhr.onload = function () {
      if (xhr.status !== 200) return ng('HTTP ' + xhr.status);
      try { ok(JSON.parse(xhr.responseText)); } catch (e) { ng('読み取りエラー'); }
    };
    xhr.onerror = function () { ng('通信エラー'); };
    xhr.ontimeout = function () { ng('時間切れ'); };
    xhr.send();
  }

  var lastError = '';
  function fetchWeather() {
    var loc = settings.loc;
    if (!loc) return;
    getJSON(L.buildUrl(loc.lat, loc.lon), function (data) {
      weather = { data: data, at: Date.now(), place: loc.name };
      lastError = '';
      save(CACHE_KEY, weather);
      render();
    }, function (msg) {
      lastError = msg;
      renderStatus();
    });
  }

  function fmtTemp(v) {
    return v == null ? '--' : Math.round(v) + '°';
  }

  function render() {
    renderStatus();
    if (!weather || !weather.data) return;
    var data = weather.data;
    var c = data.current || {};
    var w = L.describe(c.weather_code, c.is_day);
    $('now-icon').textContent = w.icon;
    $('now-temp').innerHTML = (c.temperature_2m == null ? '--' : c.temperature_2m.toFixed(1)) + '<span class="unit">°</span>';
    $('now-label').textContent = ''; // 天気の文字（晴れ時々くもり など）は出さない。読み込み中などのお知らせだけに使う

    var days = L.dailyFrom(data, 1);
    var today = days[0] || {};
    $('t-max').textContent = fmtTemp(today.max);
    $('t-min').textContent = fmtTemp(today.min);
    $('t-pop').textContent = today.pop == null ? '--' : today.pop + '%';
    $('t-hum').textContent = c.relative_humidity_2m == null ? '--' : c.relative_humidity_2m + '%';
    $('t-feel').textContent = fmtTemp(c.apparent_temperature);
    $('t-wind').textContent = c.wind_speed_10m == null ? '--' : Math.round(c.wind_speed_10m) + 'm/s';

    // 1 時間ごと（横向きは 12 時間、縦向きは 8 時間）
    var count = window.innerWidth > window.innerHeight ? 12 : 8;
    var hours = L.hourlyFrom(data, count);
    var html = '';
    var temps = [];
    var feels = [];
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      var hw = L.describe(h.code, h.isDay);
      temps.push(h.temp);
      feels.push(h.feel);
      html += '<div class="h' + (h.now ? ' now' : '') + '">' +
        '<div class="temp">' + Math.round(h.temp) + '°</div>' +
        '<div class="feel">' + (h.feel == null ? '' : Math.round(h.feel) + '°') + '</div>' +
        '<div class="gap"></div>' +
        '<div class="icon">' + hw.icon + '</div>' +
        '<div class="pop' + (h.pop ? '' : ' zero') + '">' + (h.pop == null ? '' : h.pop + '%') + '</div>' +
        '<div class="hour">' + (h.now ? '今' : h.hour + '時') + '</div></div>';
    }
    $('hours').innerHTML = html;
    drawGraph(temps, feels);
  }

  // 気温の折れ線（SVG）
  function drawGraph(temps, feels) {
    var svg = $('graph');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!temps.length) return;
    var W = 1000;
    var H = 100;
    var hasFeel = feels && feels.length && feels[0] != null;
    var pts = L.tempPoints(temps, W, H, 12, hasFeel ? feels : null);
    var fpts = hasFeel ? L.tempPoints(feels, W, H, 12, temps) : [];
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var line = '';
    var fline = '';
    var dots = '';
    for (var i = 0; i < pts.length; i++) {
      line += (i ? ' ' : '') + pts[i][0] + ',' + pts[i][1];
    }
    for (var f = 0; f < fpts.length; f++) {
      fline += (f ? ' ' : '') + fpts[f][0] + ',' + fpts[f][1];
    }
    // 点は横に伸びないよう小さな線分で描く
    for (var j = 0; j < pts.length; j++) {
      dots += '<line x1="' + pts[j][0] + '" y1="' + pts[j][1] + '" x2="' + pts[j][0] + '" y2="' + pts[j][1] +
        '" stroke="#ffb74d" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    }
    var ns = 'http://www.w3.org/2000/svg';
    // 古い Safari は SVG の innerHTML に対応しないので DOMParser で作る
    var doc = new DOMParser().parseFromString('<svg xmlns="' + ns + '">' +
      (fline ? '<polyline points="' + fline + '" fill="none" stroke="#888" stroke-opacity="0.6" stroke-width="1.5" stroke-dasharray="5,5" vector-effect="non-scaling-stroke"/>' : '') +
      '<polyline points="' + line + '" fill="none" stroke="#ffb74d" stroke-opacity="0.9" stroke-width="2.5" vector-effect="non-scaling-stroke"/>' +
      dots + '</svg>', 'image/svg+xml');
    var kids = doc.documentElement.childNodes;
    for (var k = 0; k < kids.length; k++) svg.appendChild(document.importNode(kids[k], true));
  }

  function renderStatus() {
    var place = settings.loc ? settings.loc.name : '';
    show('place', place ? '📍 ' + place : '⚙︎ を押して場所を設定してください');
    if (!settings.loc) {
      $('now-label').textContent = '場所が未設定です';
    }
    var txt = '';
    var stale = false;
    if (weather && weather.at) {
      var d = new Date(weather.at);
      txt = '天気の更新 ' + d.getHours() + ':' + L.pad2(d.getMinutes());
      stale = Date.now() - weather.at > STALE_MS;
    }
    if (lastError) txt += (txt ? '　' : '') + '（' + lastError + '）';
    show('updated', txt + ' · Open-Meteo');
    var cls = stale ? 'stale' : '';
    if ($('status').className !== cls) $('status').className = cls;
  }

  // ---------------- 場所 ----------------
  function useGeolocation(done) {
    if (!navigator.geolocation) { if (done) done('この端末では現在地が使えません'); return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      setLocation({ lat: p.coords.latitude, lon: p.coords.longitude, name: '現在地' });
      if (done) done();
    }, function () {
      if (done) done('現在地を取得できませんでした。市区町村名で探してください');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 24 * 3600 * 1000 });
  }

  function setLocation(loc) {
    settings.loc = loc;
    save(KEY, settings);
    weather = null;
    $('s-place').textContent = loc.name;
    renderStatus();
    fetchWeather();
  }

  function search() {
    var q = $('s-q').value.replace(/^\s+|\s+$/g, '');
    var box = $('s-results');
    if (!q) return;
    box.innerHTML = '<div class="msg">検索中…</div>';
    getJSON('https://geocoding-api.open-meteo.com/v1/search?count=8&language=ja&format=json&name=' + encodeURIComponent(q),
      function (res) {
        var list = res.results || [];
        if (!list.length) { box.innerHTML = '<div class="msg">見つかりませんでした。別の書き方で試してください</div>'; return; }
        box.innerHTML = '';
        for (var i = 0; i < list.length; i++) {
          (function (r) {
            var b = document.createElement('button');
            var sub = [r.admin1, r.country].filter(function (x) { return x; }).join('・');
            b.textContent = r.name + (sub ? '（' + sub + '）' : '');
            b.onclick = function () {
              setLocation({ lat: r.latitude, lon: r.longitude, name: r.name });
              box.innerHTML = '';
              $('s-q').value = '';
            };
            box.appendChild(b);
          })(list[i]);
        }
      }, function (msg) {
        box.innerHTML = '<div class="msg">検索できませんでした（' + msg + '）</div>';
      });
  }

  // ---------------- 設定画面 ----------------
  function openSettings() {
    $('s-place').textContent = settings.loc ? settings.loc.name : '未設定';
    $('s-h12').checked = settings.h12;
    $('s-sec').checked = settings.sec;
    $('s-night').checked = settings.night;
    $('s-ns').value = settings.nightStart;
    $('s-ne').value = settings.nightEnd;
    $('settings').className = '';
  }

  function closeSettings() {
    settings.h12 = $('s-h12').checked;
    settings.sec = $('s-sec').checked;
    settings.night = $('s-night').checked;
    settings.nightStart = +$('s-ns').value;
    settings.nightEnd = +$('s-ne').value;
    save(KEY, settings);
    restartTick();
    $('settings').className = 'hidden';
    $('s-results').innerHTML = '';
  }

  function setup() {
    var opts = '';
    for (var h = 0; h < 24; h++) opts += '<option value="' + h + '">' + h + '</option>';
    $('s-ns').innerHTML = opts;
    $('s-ne').innerHTML = opts;

    $('gear').onclick = function (e) { e.stopPropagation(); openSettings(); };
    $('s-close').onclick = closeSettings;
    $('s-search').onclick = search;
    $('s-q').onkeydown = function (e) { if (e.keyCode === 13) { e.preventDefault(); search(); } };
    $('s-geo').onclick = function () {
      var box = $('s-results');
      box.innerHTML = '<div class="msg">現在地を取得中…</div>';
      useGeolocation(function (err) { box.innerHTML = err ? '<div class="msg">' + err + '</div>' : ''; if (!err) $('s-place').textContent = '現在地'; });
    };
    $('settings').onclick = function (e) { if (e.target === $('settings')) closeSettings(); };

    // 夜に画面をタップすると 1 分だけ明るく
    $('stage').onclick = function () {
      wakeUntil = Date.now() + 60 * 1000;
      updateNight(new Date());
      setTimeout(function () { updateNight(new Date()); }, 60 * 1000 + 50);
    };

    var lastW = window.innerWidth > window.innerHeight;
    window.addEventListener('resize', function () {
      var w = window.innerWidth > window.innerHeight;
      if (w !== lastW) { lastW = w; render(); }
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && (!weather || Date.now() - weather.at > REFRESH_MS)) fetchWeather();
    });
    window.addEventListener('online', fetchWeather);

    render();
    tick();
    if (settings.loc) {
      fetchWeather();
    } else {
      useGeolocation(function (err) { if (err) openSettings(); });
    }
    setInterval(fetchWeather, REFRESH_MS);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* なくても動く */ });
    }
  }

  setup();
})();
