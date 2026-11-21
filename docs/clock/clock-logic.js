// 置き時計の計算部分（画面に依存しない）。古い iPad の Safari でも動くよう ES5 で書いています。
(function (root) {
  'use strict';

  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  // WMO 天気コード → [日本語, 昼のアイコン, 夜のアイコン]
  var WEATHER = {
    0: ['快晴', '☀️', '🌙'],
    1: ['晴れ', '🌤️', '🌙'],
    2: ['晴れ時々くもり', '⛅', '☁️'],
    3: ['くもり', '☁️', '☁️'],
    45: ['霧', '🌫️', '🌫️'],
    48: ['霧', '🌫️', '🌫️'],
    51: ['霧雨', '🌦️', '🌧️'],
    53: ['霧雨', '🌦️', '🌧️'],
    55: ['強い霧雨', '🌧️', '🌧️'],
    56: ['着氷性の霧雨', '🌧️', '🌧️'],
    57: ['着氷性の霧雨', '🌧️', '🌧️'],
    61: ['小雨', '🌧️', '🌧️'],
    63: ['雨', '🌧️', '🌧️'],
    65: ['大雨', '🌧️', '🌧️'],
    66: ['着氷性の雨', '🌧️', '🌧️'],
    67: ['着氷性の雨', '🌧️', '🌧️'],
    71: ['小雪', '🌨️', '🌨️'],
    73: ['雪', '🌨️', '🌨️'],
    75: ['大雪', '❄️', '❄️'],
    77: ['霧雪', '🌨️', '🌨️'],
    80: ['にわか雨', '🌦️', '🌧️'],
    81: ['にわか雨', '🌧️', '🌧️'],
    82: ['激しいにわか雨', '🌧️', '🌧️'],
    85: ['にわか雪', '🌨️', '🌨️'],
    86: ['強いにわか雪', '❄️', '❄️'],
    95: ['雷雨', '⛈️', '⛈️'],
    96: ['雷雨（ひょう）', '⛈️', '⛈️'],
    99: ['雷雨（ひょう）', '⛈️', '⛈️'],
  };

  function describe(code, isDay) {
    var w = WEATHER[code] || ['—', '❔', '❔'];
    return { label: w[0], icon: isDay === 0 ? w[2] : w[1] };
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // 時計の表示。h12 = 12 時間表示
  function formatTime(date, h12) {
    var h = date.getHours();
    var ampm = '';
    if (h12) {
      ampm = h < 12 ? '午前' : '午後';
      h = h % 12;
      if (h === 0) h = 12;
    }
    return {
      main: (h12 ? String(h) : pad2(h)) + ':' + pad2(date.getMinutes()),
      sec: pad2(date.getSeconds()),
      ampm: ampm,
    };
  }

  function formatDate(date) {
    return (date.getMonth() + 1) + '月' + date.getDate() + '日（' + WEEK[date.getDay()] + '）';
  }

  // "2026-11-21T17:00" や "2026-11-21" を分解（古い Safari は Date で正しく読めないため手で読む）
  function parseLocal(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s || '');
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, min: m[5] ? +m[5] : 0 };
  }

  function weekday(p) {
    return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  }

  function round(v) {
    return v == null ? null : Math.round(v);
  }

  // 現在時刻（予報地点の現地時刻）から先の 1 時間ごとの予報
  function hourlyFrom(data, count) {
    var h = data && data.hourly;
    if (!h || !h.time) return [];
    var now = (data.current && data.current.time) || '';
    var nowHour = now.slice(0, 13); // "2026-11-21T17"
    var start = 0;
    while (start < h.time.length && h.time[start].slice(0, 13) < nowHour) start++;
    var out = [];
    for (var i = start; i < h.time.length && out.length < count; i++) {
      var p = parseLocal(h.time[i]);
      out.push({
        hour: p.h,
        now: i === start,
        temp: h.temperature_2m[i],
        code: h.weather_code[i],
        pop: h.precipitation_probability ? h.precipitation_probability[i] : null,
        isDay: h.is_day ? h.is_day[i] : 1,
      });
    }
    return out;
  }

  // 今日から先の日ごとの予報
  function dailyFrom(data, count) {
    var d = data && data.daily;
    if (!d || !d.time) return [];
    var out = [];
    for (var i = 0; i < d.time.length && out.length < count; i++) {
      var p = parseLocal(d.time[i]);
      out.push({
        label: i === 0 ? '今日' : i === 1 ? '明日' : WEEK[weekday(p)],
        sunday: weekday(p) === 0,
        saturday: weekday(p) === 6,
        month: p.m,
        day: p.d,
        code: d.weather_code[i],
        max: round(d.temperature_2m_max[i]),
        min: round(d.temperature_2m_min[i]),
        pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      });
    }
    return out;
  }

  // 夜間（start 時〜end 時）かどうか。日をまたぐ範囲（22〜6 時）にも対応
  function isNight(hour, start, end) {
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  // 気温グラフの点（幅 width・高さ height の枠に収める）
  function tempPoints(temps, width, height, pad) {
    var lo = Infinity;
    var hi = -Infinity;
    for (var i = 0; i < temps.length; i++) {
      if (temps[i] < lo) lo = temps[i];
      if (temps[i] > hi) hi = temps[i];
    }
    var span = Math.max(hi - lo, 3); // 変化が小さい日でも線が暴れないように
    var mid = (hi + lo) / 2;
    var pts = [];
    var step = width / temps.length;
    for (var j = 0; j < temps.length; j++) {
      var x = step * (j + 0.5);
      var y = pad + (height - 2 * pad) * (1 - ((temps[j] - mid) / span + 0.5));
      pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    }
    return pts;
  }

  function buildUrl(lat, lon) {
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) +
      '&longitude=' + lon.toFixed(4) +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m' +
      '&hourly=temperature_2m,weather_code,precipitation_probability,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=auto&forecast_days=7&wind_speed_unit=ms';
  }

  root.ClockLogic = {
    describe: describe,
    pad2: pad2,
    formatTime: formatTime,
    formatDate: formatDate,
    parseLocal: parseLocal,
    hourlyFrom: hourlyFrom,
    dailyFrom: dailyFrom,
    isNight: isNight,
    tempPoints: tempPoints,
    buildUrl: buildUrl,
  };
})(this);
