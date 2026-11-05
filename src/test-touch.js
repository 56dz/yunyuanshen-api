// 多指触摸模拟测试：验证 TouchController 的 fingerId 分配、primary 标记、
// 坐标归一化与 protobuf 编解码，与官方 mjs/home.mobile.js 的 Gp 类行为一致。
//
// 运行：node src/test-touch.js
'use strict';
const T = require('./touch.js');

// ---- 最小 protobuf 读取器（只够解 RtcDataChannel + RtcTouchEvent）----
function readVarint(b, i) {
  let r = 0, s = 0;
  for (;;) { const x = b[i++]; r |= (x & 0x7f) << s; s += 7; if (!(x & 0x80)) break; }
  return [r >>> 0, i];
}

function decodeTouchChannel(msg) {
  let i = 0, list = null;
  while (i < msg.length) {
    const [tag, j] = readVarint(msg, i); i = j;
    const f = tag >> 3, w = tag & 7;
    if (w === 2) {
      const [len, k] = readVarint(msg, i); i = k;
      if (f === 13) list = msg.slice(i, i + len);
      i += len;
    } else if (w === 0) { const [, k] = readVarint(msg, i); i = k; }
    else if (w === 5) i += 4;
    else if (w === 1) i += 8;
    else break;
  }
  if (!list) return [];
  const out = [];
  let p = 0;
  while (p < list.length) {
    const [tag, q] = readVarint(list, p); p = q;
    const f = tag >> 3, w = tag & 7;
    if (w !== 2) break;
    const [len, r] = readVarint(list, p); p = r;
    const ev = list.slice(p, p + len); p += len;
    const e = { fingerId: 0, action: 0, x: 0, y: 0, isPrimary: false };
    let s = 0;
    while (s < ev.length) {
      const [t2, u] = readVarint(ev, s); s = u;
      const ff = t2 >> 3, ww = t2 & 7;
      if (ww === 0) {
        const [v, z] = readVarint(ev, s); s = z;
        if (ff === 1) e.fingerId = v;
        else if (ff === 2) e.action = v;
        else if (ff === 7) e.isPrimary = !!v;
      } else if (ww === 5) {
        const dv = new DataView(ev.buffer, ev.byteOffset + s, 4);
        if (ff === 3) e.x = dv.getFloat32(0, true);
        if (ff === 4) e.y = dv.getFloat32(0, true);
        s += 4;
      } else if (ww === 1) s += 8;
      else break;
    }
    out.push(e);
  }
  return out;
}

// ---- 场景 ----
const packets = [];
const rect = { x: 0, y: 0, width: 1920, height: 1080 };
const tc = new T.TouchController(p => packets.push(p), () => rect);

let active = [];
function fire(type, changed) {
  if (type === 'touchstart') active = active.concat(changed);
  else if (type === 'touchend') active = active.filter(a => a.identifier !== changed[0].identifier);
  tc.onTouchEvent({ type, changedTouches: changed, touches: active });
}

fire('touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }]); // A 按下 → fingerId 0, primary
fire('touchstart', [{ identifier: 2, clientX: 500, clientY: 600 }]); // B 按下 → fingerId 1
fire('touchmove',  [{ identifier: 1, clientX: 150, clientY: 250 }]); // A 移动
fire('touchend',   [{ identifier: 1, clientX: 150, clientY: 250 }]); // A 抬起
fire('touchend',   [{ identifier: 2, clientX: 500, clientY: 600 }]); // B 抬起

let pass = true;
const expected = [
  { fingerId: 0, action: 0, isPrimary: true },   // A down
  { fingerId: 1, action: 0, isPrimary: false },  // B down
  { fingerId: 0, action: 2, isPrimary: true },   // A move
  { fingerId: 0, action: 1, isPrimary: true },   // A up
  { fingerId: 1, action: 1, isPrimary: false },  // B up
];

console.log('packets =', packets.length);
if (packets.length !== expected.length) { pass = false; console.log('  !! packet count mismatch'); }

packets.forEach((p, i) => {
  const r = T.parsePacket(p);
  const evs = decodeTouchChannel(r.msg);
  const got = evs[0];
  console.log(` #${i + 1} cmdId=${r.cmdId} fingerId=${got.fingerId} action=${got.action} ` +
    `x=${got.x.toFixed(4)} y=${got.y.toFixed(4)} primary=${got.isPrimary}`);
  const e = expected[i];
  if (!e) { pass = false; return; }
  if (got.fingerId !== e.fingerId || got.action !== e.action || got.isPrimary !== e.isPrimary) {
    pass = false; console.log('  !! mismatch, expected', JSON.stringify(e));
  }
});

// 坐标校验：100/1920 = 0.0520833, 200/1080 = 0.1851852
{
  const first = decodeTouchChannel(T.parsePacket(packets[0]).msg)[0];
  if (Math.abs(first.x - 100 / 1920) > 1e-6 || Math.abs(first.y - 200 / 1080) > 1e-6) {
    pass = false; console.log('  !! coordinate normalization wrong');
  }
}

// fingerId 池必须完全归还
if (tc.availableFingerIdPool.length !== 10 || tc.fingerMap.size !== 0 || tc.occupiedFingerIdPool.size !== 0) {
  pass = false; console.log('  !! finger pool not fully released');
}

// releaseAllTouch 应广播 10 个 Up 且把 primaryId 重置为 -1
{
  const before = packets.length;
  tc.releaseAllTouch();
  const evs = decodeTouchChannel(T.parsePacket(packets[packets.length - 1]).msg);
  if (packets.length !== before + 1 || evs.length !== 10) {
    pass = false; console.log('  !! releaseAllTouch should emit exactly 1 packet with 10 events, got', evs.length);
  }
  if (tc.primaryId !== -1) { pass = false; console.log('  !! primaryId should reset to -1'); }
}

console.log(pass ? '\nALL CHECKS PASSED' : '\nFAILED');
process.exit(pass ? 0 : 1);
