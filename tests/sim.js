// テスト用の模擬飛行: 直線滑空とサーマル旋回を風の中で繰り返す
import { fromXY } from '../docs/calc.js';

export function createSim({
  lat0 = 36.3, lon0 = 140.15, alt0 = 600, // 離陸地点（初期値は適当な山）
  windSpeed = 4, windFrom = 270, airspeed = 11, hdg0 = 90,
  start = Date.now(),
} = {}) {
  const wx = windSpeed * Math.sin(((windFrom + 180) * Math.PI) / 180);
  const wy = windSpeed * Math.cos(((windFrom + 180) * Math.PI) / 180);
  let x = 0, y = 0, alt = alt0, hdg = hdg0, t = start, phase = 0, phaseT = 0;
  // phase: 0 = 地上待機, 1 = 滑空, 2 = サーマル旋回
  return {
    step(dt = 1) {
      t += dt * 1000;
      phaseT += dt;
      let climb = 0;
      if (phase === 0) {
        if (phaseT > 5) { phase = 1; phaseT = 0; }
        return this.fix(0, null);
      }
      if (phase === 1) {
        climb = -1.1;
        if (phaseT > 40) { phase = 2; phaseT = 0; }
      } else {
        hdg += 360 / 25 * dt; // 1 周 25 秒
        climb = 2.0;
        if (phaseT > 75) { phase = 1; phaseT = 0; hdg = hdg0 - 30; }
      }
      const vx = airspeed * Math.sin((hdg * Math.PI) / 180) + wx;
      const vy = airspeed * Math.cos((hdg * Math.PI) / 180) + wy;
      x += vx * dt; y += vy * dt; alt += climb * dt;
      const spd = Math.hypot(vx, vy);
      const trk = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
      return this.fix(spd, trk);
    },
    fix(spd, trk) {
      const p = fromXY(lat0, lon0, x, y);
      return { t, lat: p.lat, lon: p.lon, alt, acc: 5, spd, hdg: trk };
    },
  };
}
