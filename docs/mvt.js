// ベクトルタイル（Mapbox Vector Tile = protobuf）の最小限の読み取り。
// 国土地理院の道路・川などを、文字なしで自分で描くために使う。

function reader(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0, shift = 0, b;
    do {
      b = buf[pos++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  return {
    get pos() { return pos; },
    set pos(p) { pos = p; },
    end: buf.length,
    varint,
    svarint() { const v = varint(); return v % 2 ? -(v + 1) / 2 : v / 2; },
    bytes() { const n = varint(); const s = buf.subarray(pos, pos + n); pos += n; return s; },
    skip(type) {
      if (type === 0) varint();
      else if (type === 1) pos += 8;
      else if (type === 2) pos += varint();
      else if (type === 5) pos += 4;
    },
  };
}

const utf8 = new TextDecoder();

function readValue(buf) {
  const r = reader(buf);
  let v = null;
  while (r.pos < r.end) {
    const tag = r.varint(), f = tag >> 3, t = tag & 7;
    if (f === 1) v = utf8.decode(r.bytes());
    else if (f === 2) { v = new DataView(buf.buffer, buf.byteOffset + r.pos, 4).getFloat32(0, true); r.pos += 4; }
    else if (f === 3) { v = new DataView(buf.buffer, buf.byteOffset + r.pos, 8).getFloat64(0, true); r.pos += 8; }
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = r.svarint();
    else if (f === 7) v = !!r.varint();
    else r.skip(t);
  }
  return v;
}

// 座標の命令列を、線・面ごとの点の配列にする（タイル内座標 0..extent）
function decodeGeometry(cmds) {
  const parts = [];
  let x = 0, y = 0, cur = null, i = 0;
  while (i < cmds.length) {
    const c = cmds[i++], id = c & 7, n = c >> 3;
    for (let k = 0; k < n; k++) {
      if (id === 7) { if (cur && cur.length) cur.push([cur[0][0], cur[0][1]]); continue; }
      const dx = cmds[i++], dy = cmds[i++];
      x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
      y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
      if (id === 1) { cur = [[x, y]]; parts.push(cur); } else cur.push([x, y]);
    }
  }
  return parts;
}

// { レイヤー名: { extent, features: [{ type, props, parts }] } }
export function decodeTile(arrayBuffer, wanted) {
  const buf = new Uint8Array(arrayBuffer);
  const r = reader(buf);
  const layers = {};
  while (r.pos < r.end) {
    const tag = r.varint();
    if (tag >> 3 !== 3) { r.skip(tag & 7); continue; }
    const lb = r.bytes();
    const lr = reader(lb);
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (lr.pos < lr.end) {
      const t = lr.varint(), f = t >> 3;
      if (f === 1) name = utf8.decode(lr.bytes());
      else if (f === 2) feats.push(lr.bytes());
      else if (f === 3) keys.push(utf8.decode(lr.bytes()));
      else if (f === 4) values.push(readValue(lr.bytes()));
      else if (f === 5) extent = lr.varint();
      else lr.skip(t & 7);
    }
    if (wanted && !wanted.includes(name)) continue;
    const features = feats.map((fb) => {
      const fr = reader(fb);
      let type = 0, tags = [], geom = [];
      while (fr.pos < fr.end) {
        const t = fr.varint(), f = t >> 3;
        if (f === 2 || f === 4) {
          const pb = reader(fr.bytes());
          const arr = [];
          while (pb.pos < pb.end) arr.push(pb.varint());
          if (f === 2) tags = arr; else geom = arr;
        } else if (f === 3) type = fr.varint();
        else fr.skip(t & 7);
      }
      const props = {};
      for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      return { type, props, parts: decodeGeometry(geom) };
    });
    layers[name] = { extent, features };
  }
  return layers;
}
