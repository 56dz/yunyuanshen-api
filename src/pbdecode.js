// Generic protobuf wire-format decoder.
//
// 用途：`sdk_param` 是 base64 编码的 `proto.paas.SdkStartGameParams`，但没有 .proto 文件。
// 本模块直接按 wire format 解析，输出字段号 + 值。
//
// CLI:  node src/pbdecode.js '<base64>'
// API:  const { decode, format } = require('./pbdecode');

'use strict';

function readVarint(b, i) {
  let v = 0;
  let shift = 0;
  for (;;) {
    if (i >= b.length) throw new RangeError('truncated varint');
    const x = b[i++];
    v += (x & 0x7f) * Math.pow(2, shift);
    if (!(x & 0x80)) break;
    shift += 7;
    if (shift > 63) throw new RangeError('varint too long');
  }
  return [v, i];
}

// UTF-8 可打印启发式：允许 \t \n \r 和所有非控制字符；出现 U+FFFD 说明不是合法 UTF-8
function looksLikeText(s) {
  if (!s.length) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20) return false;
    if (c >= 0x7f && c < 0xa0) return false;
    if (c === 0xfffd) return false;
  }
  return true;
}

const NAMES = {
  1: 'sid',
  2: 'ca_id',
  3: 'pod_id',
  4: 'game_token',
  5: 'resolution',
  6: 'target_fps',
  7: 'cmd_line',
  8: 'game_svr_addr',
  9: 'rtc_udp_port',
  10: 'additional_game_svr_addrs',
  11: 'game_server_wss_url',
  12: 'additional_game_server_wss_urls',
  13: 'big_isp',
  14: 'game_control_channel_url',
  15: 'additional_game_control_channel_urls',
  16: 'is_ipv6',
  17: 'game_svr_addr_ipv6',
  18: 'rtc_udp_port_ipv6',
  19: 'additional_game_svr_addrs_ipv6',
  20: 'game_server_wss_url_ipv6',
  21: 'additional_game_server_wss_urls_ipv6',
  22: 'game_control_channel_url_ipv6',
};

function decode(buf, depth = 0) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = key >>> 3;
    const wire = key & 7;

    if (wire === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      out.push({ field, wire, value: v });
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.slice(i, i + 8).toString('hex'), hex: true });
      i += 8;
    } else if (wire === 5) {
      const sub = buf.slice(i, i + 4);
      out.push({ field, wire, value: sub.readFloatLE(0), raw: sub.toString('hex') });
      i += 4;
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      const sub = buf.slice(i, i + len);
      i += len;
      const s = sub.toString('utf8');
      if (looksLikeText(s)) {
        out.push({ field, wire, value: s, bytes: len });
      } else {
        let nested = null;
        if (depth < 6) {
          try {
            nested = decode(sub, depth + 1);
            if (nested.length === 0) nested = null;
          } catch {
            nested = null;
          }
        }
        out.push(nested
          ? { field, wire, value: nested, bytes: len }
          : { field, wire, value: sub.toString('hex'), bytes: len, hex: true });
      }
    } else {
      throw new RangeError(`unsupported wire type ${wire} for field ${field} at ${i}`);
    }
  }
  return out;
}

function label(f) {
  const name = NAMES[f.field];
  return name ? `#${f.field} ${name}` : `#${f.field}`;
}

function render(fields, indent = '') {
  const lines = [];
  for (const f of fields) {
    if (Array.isArray(f.value)) {
      if (f.value.length && typeof f.value[0] === 'object' && f.value[0] && 'field' in f.value[0]) {
        lines.push(`${indent}${label(f)} {`);
        lines.push(...render(f.value, indent + '  '));
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}${label(f)} = [empty]`);
      }
    } else {
      lines.push(`${indent}${label(f)} = ${JSON.stringify(f.value)}`);
    }
  }
  return lines;
}

function format(buf) {
  return render(decode(buf)).join('\n');
}

module.exports = { decode, format, readVarint, NAMES };

// ---- CLI ----
if (require.main === module) {
  const b64 = process.argv[2];
  if (!b64) {
    console.error('usage: node src/pbdecode.js <base64 sdk_param>');
    process.exit(1);
  }
  const buf = Buffer.from(b64, 'base64');
  console.log(`total bytes: ${buf.length}`);
  console.log(format(buf));
}
