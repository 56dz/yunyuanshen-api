/**
 * 云·原神 触摸输入实现（逆向自 cg-sdk.891daeae.js + mjs/home.mobile.js）
 *
 * 依赖：只需要 WebSocket(信令) + RTCPeerConnection/DataChannel，无需 Node 特性
 * 坐标系：归一化 [0,1] 相对 gameRect（视频显示区域），不是像素、不是绝对坐标
 */

'use strict';

// ────────────────────────────────────────────────────────────────
// 1. 常量
// ────────────────────────────────────────────────────────────────

const CMD_ID_RTC_DATA_CHANNEL = 20010;   // proto.msg.RtcDataChannel.CmdId.CMD_ID
const MAGIC_HEAD = 0x4567;               // bytes 0x45 0x67
const MAGIC_TAIL = 0x89ab;               // bytes 0x89 0xab

const DataType = {
  INVALID: 0,
  KEYBOARD_DOWN: 1,
  KEYBOARD_UP: 2,
  MOUSE_MOVE: 3,
  MOUSE_LBUTTON_DOWN: 4,
  MOUSE_LBUTTON_UP: 5,
  MOUSE_RBUTTON_DOWN: 6,
  MOUSE_RBUTTON_UP: 7,
  MOUSE_MBUTTON_DOWN: 8,
  MOUSE_MBUTTON_UP: 9,
  MOUSE_ZDELTA: 10,
  MOUSE_FEEDBACK: 11,
  IME_INPUT: 12,
  IME_INPUT_FEEDBACK: 13,
  IME_CLIPBOARD: 14,
  IME_CLIPBOARD_FEEDBACK: 15,
  VIDEO_STATE: 16,
  GAMEPAD_KEY: 17,
  GAMEPAD_LIST: 18,
  GAMEPAD_FEEDBACK: 19,
  GAME_STATS_REPORT: 20,
  TOUCH_EVENT_LIST: 21,
  IMU_EVENT: 22,
  IMU_FEEDBACK: 23,
  RTC_TEST_DATA: 25,
  RTC_TEST_DATA_RMQ: 26,
  GAME_DATA: 30,
  RESET_GAME_INPUT_CONTROL: 31,
  MOUSE_BUTTON_DOWN: 32,
  MOUSE_BUTTON_UP: 33,
};

const TouchActionType = { Down: 0, Up: 1, Move: 2 };

// RtcDataChannel 字段号
const F = {
  type: 1,
  touchList: 13,
};

// RtcTouchEventList 字段号
const F_LIST = { eventList: 1 };

// RtcTouchEvent 字段号
const F_EV = {
  fingerId: 1,      // uint32
  actionType: 2,    // uint32
  pointX: 3,        // float
  pointY: 4,        // float
  pressSizeX: 5,    // float
  pressSizeY: 6,    // float
  isPrimary: 7,     // bool
  rttTraceSendTime: 8, // int64
};

// ────────────────────────────────────────────────────────────────
// 2. 极简 protobuf 编码（只覆盖用到的类型）
// ────────────────────────────────────────────────────────────────

class Writer {
  constructor() { this.buf = []; }

  varint(v) {
    v = v >>> 0;
    while (v > 0x7f) { this.buf.push((v & 0x7f) | 0x80); v >>>= 7; }
    this.buf.push(v);
  }

  tag(field, wire) { this.varint((field << 3) | wire); }

  uint32(field, v) {
    if (v === 0) return;           // proto3 默认值不序列化
    this.tag(field, 0);
    this.varint(v);
  }

  bool(field, v) {
    if (!v) return;
    this.tag(field, 0);
    this.varint(1);
  }

  float(field, v) {
    if (v === 0) return;
    this.tag(field, 5);
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v, true);      // little-endian
    for (let i = 0; i < 4; i++) this.buf.push(b.getUint8(i));
  }

  bytes(field, arr) {
    if (arr.length === 0) return;
    this.tag(field, 2);
    this.varint(arr.length);
    for (const b of arr) this.buf.push(b);
  }

  finish() { return Uint8Array.from(this.buf); }
}

// ────────────────────────────────────────────────────────────────
// 3. Packet 封装
//    [0..1]=0x45,0x67 [2..3]=cmdId(BE) [4..5]=headLen(BE)
//    [6..9]=msgLen(BE) [10..]=head [..]=msg [-2..-1]=0x89,0xab
// ────────────────────────────────────────────────────────────────

function createPacket(cmdId, msgBytes) {
  const headLen = 0;               // PacketHead 实测为空
  const total = 12 + headLen + msgBytes.length;
  const out = new Uint8Array(total);

  out[0] = 0x45;
  out[1] = 0x67;
  out[2] = (cmdId >> 8) & 0xff;
  out[3] = cmdId & 0xff;
  out[4] = (headLen >> 8) & 0xff;
  out[5] = headLen & 0xff;
  out[6] = (msgBytes.length >>> 24) & 0xff;
  out[7] = (msgBytes.length >>> 16) & 0xff;
  out[8] = (msgBytes.length >>> 8) & 0xff;
  out[9] = msgBytes.length & 0xff;
  // head 为空，跳过 10..10+headLen
  out.set(msgBytes, 10 + headLen);
  out[total - 2] = 0x89;
  out[total - 1] = 0xab;
  return out;
}

function parsePacket(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 12) throw new Error('invalid packet size ' + b.length);
  const magic = (b[0] << 8) | b[1];
  if (magic !== MAGIC_HEAD) throw new Error('invalid magic head ' + magic);
  const cmdId = (b[2] << 8) | b[3];
  const headLen = (b[4] << 8) | b[5];
  const msgLen = (b[6] << 24) | (b[7] << 16) | (b[8] << 8) | b[9];
  const msgStart = 10 + headLen;
  const msg = b.slice(msgStart, msgStart + msgLen);
  const tail = (b[b.length - 2] << 8) | b[b.length - 1];
  if (tail !== MAGIC_TAIL) throw new Error('invalid magic tail ' + tail);
  return { cmdId, headLen, msgLen, msg };
}

// ────────────────────────────────────────────────────────────────
// 4. 触摸事件 → protobuf
// ────────────────────────────────────────────────────────────────

/**
 * @param {Array<{fingerId:number, action:number, position:{x:number,y:number}, isPrimary:boolean}>} events
 *        最多 10 个；action ∈ TouchActionType；position 必须是 [0,1] 归一化坐标
 * @returns {Uint8Array} 完整 Packet（已带 0x4567 / 0x89ab 帧头帧尾）
 */
function buildTouchPacket(events) {
  if (!events || events.length === 0 || events.length > 10) {
    throw new Error('touch event count must be 1..10, got ' + (events ? events.length : 0));
  }

  // RtcTouchEventList { repeated RtcTouchEvent event_list = 1; }
  const listWriter = new Writer();

  for (const ev of events) {
    const w = new Writer();
    w.uint32(F_EV.fingerId, ev.fingerId);
    w.uint32(F_EV.actionType, ev.action);
    w.float(F_EV.pointX, ev.position.x);
    w.float(F_EV.pointY, ev.position.y);
    // pressSizeX / pressSizeY 官方 SDK 固定传 0，proto3 下不序列化
    w.bool(F_EV.isPrimary, !!ev.isPrimary);
    listWriter.bytes(F_LIST.eventList, w.finish());  // 嵌套 message，wire type 2
  }

  // RtcDataChannel { type = 1; touch_list = 13; }
  const chanWriter = new Writer();
  chanWriter.uint32(F.type, DataType.TOUCH_EVENT_LIST);
  chanWriter.bytes(F.touchList, listWriter.finish());

  return createPacket(CMD_ID_RTC_DATA_CHANNEL, chanWriter.finish());
}

// ────────────────────────────────────────────────────────────────
// 5. 手指池 + 坐标归一化（照抄 home.mobile.js 逻辑）
// ────────────────────────────────────────────────────────────────

class TouchController {
  /**
   * @param {(packet:Uint8Array)=>void} sendFn  实际发送函数
   * @param {()=>{x:number,y:number,width:number,height:number}|null} getGameRect
   */
  constructor(sendFn, getGameRect) {
    this.sendFn = sendFn;
    this.getGameRect = getGameRect;
    this.fingerMap = new Map();                                  // identifier -> {clientX, clientY, identifier, fingerId}
    this.occupiedFingerIdPool = new Map();
    this.availableFingerIdPool = Array.from({ length: 10 }, (_, i) => i);
    this.primaryId = -1;
  }

  // ---- 坐标：clientX/clientY → 归一化 [0,1] ----
  calcPosition(touch) {
    const rect = this.getGameRect();
    if (!rect) return null;
    // 官方在竖屏下做了旋转映射；这里按横屏（isLandscape）为主
    const nx = (touch.clientX - rect.x) / rect.width;
    const ny = (touch.clientY - rect.y) / rect.height;
    return { x: nx, y: ny };
  }

  // 竖屏旋转版本（游戏画面横置、手机竖拿时用）
  calcPositionPortrait(touch, layoutHeight) {
    const rect = this.getGameRect();
    if (!rect) return null;
    const x = touch.clientY;
    const y = layoutHeight - touch.clientX;
    return { x: (x - rect.x) / rect.width, y: (y - rect.y) / rect.height };
  }

  _requiredFingerId() {
    let id = -1;
    if (this.fingerMap.size >= 10) {
      const oldest = this.fingerMap.keys().next().value;
      if (oldest !== undefined) this.releaseTouch({ identifier: oldest });
    }
    if (this.availableFingerIdPool.length > 0) {
      id = this.availableFingerIdPool.shift();
      this.occupiedFingerIdPool.set(id, true);
    }
    return id;
  }

  _releaseFingerId(id) {
    this.occupiedFingerIdPool.delete(id);
    if (!this.availableFingerIdPool.includes(id)) this.availableFingerIdPool.push(id);
  }

  _getFingerId(touch, action) {
    const identifier = touch.identifier;

    if (action === TouchActionType.Down) {
      const id = this._requiredFingerId();
      if (id < 0) { this.releaseAllTouch(); return null; }
      this.fingerMap.set(identifier, {
        clientX: touch.clientX, clientY: touch.clientY,
        identifier, fingerId: id,
      });
      if (this.occupiedFingerIdPool.size === 1) this.primaryId = id;
      return { fingerId: id, action, isPrimary: this.primaryId === id };
    }

    if (action === TouchActionType.Up) {
      const cached = this.fingerMap.get(identifier);
      if (!cached) return null;
      this.fingerMap.delete(identifier);
      this._releaseFingerId(cached.fingerId);
      return { fingerId: cached.fingerId, action, isPrimary: this.primaryId === cached.fingerId };
    }

    // Move
    const cached = this.fingerMap.get(identifier);
    if (cached === undefined) return null;
    this.fingerMap.set(identifier, {
      clientX: touch.clientX, clientY: touch.clientY,
      identifier, fingerId: cached.fingerId,
    });
    return { fingerId: cached.fingerId, action, isPrimary: this.primaryId === cached.fingerId };
  }

  releaseTouch(touch) {
    const cached = this.fingerMap.get(touch.identifier);
    if (!cached) return;
    const pos = this.calcPosition(cached);
    if (pos) {
      this.sendFn(buildTouchPacket([{
        fingerId: cached.fingerId, action: TouchActionType.Up,
        position: pos, isPrimary: this.primaryId === cached.fingerId,
      }]));
    }
    this.fingerMap.delete(touch.identifier);
    this._releaseFingerId(cached.fingerId);
  }

  releaseAllTouch() {
    const events = Array.from({ length: 10 }, (_, i) => ({
      fingerId: i, action: TouchActionType.Up,
      position: { x: 0.5, y: 0.5 }, isPrimary: this.primaryId === i,
    }));
    this.primaryId = -1;
    this.fingerMap.clear();
    this.occupiedFingerIdPool.clear();
    this.availableFingerIdPool = Array.from({ length: 10 }, (_, i) => i);
    this.sendFn(buildTouchPacket(events));
  }

  /** 兜底：某些浏览器会丢 touchend，Down 时先清理未跟踪的触点 */
  releaseUntrackableTouch(evt) {
    const ids = Array.from(evt.touches || []).map(t => t.identifier);
    for (const cached of Array.from(this.fingerMap.values())) {
      if (!ids.includes(cached.identifier)) this.releaseTouch(cached);
    }
  }

  /**
   * 官方在 touchstart 里还会对「已经存在于 fingerMap」的 identifier 先补一个 Up。
   * 场景：浏览器偶发重复派发 touchstart（同 identifier），若不复位会占满 finger 池。
   */
  releaseDuplicatesTouch(evt) {
    for (const touch of Array.from(evt.changedTouches || [])) {
      if (this.fingerMap.has(touch.identifier)) this.releaseTouch(touch);
    }
  }

  /** 处理原生 TouchEvent，返回发送的包数 */
  onTouchEvent(evt) {
    if (!evt.changedTouches || evt.changedTouches.length === 0) return 0;

    let action;
    switch (evt.type) {
      case 'touchstart':
        action = TouchActionType.Down;
        this.releaseDuplicatesTouch(evt);
        this.releaseUntrackableTouch(evt);
        break;
      case 'touchmove':  action = TouchActionType.Move; break;
      case 'touchend':   action = TouchActionType.Up; break;
      case 'touchcancel':action = TouchActionType.Up; break;
      default: return 0;
    }

    const events = [];
    for (const touch of evt.changedTouches) {
      const f = this._getFingerId(touch, action);
      if (!f) continue;
      const pos = this.calcPosition(touch);
      if (!pos) continue;
      events.push({ ...f, position: pos });
    }

    if (events.length === 0) return 0;
    this.sendFn(buildTouchPacket(events));
    return events.length;
  }

  /** 绑定到某个 DOM 元素（通常是承载 <video> 的容器） */
  attach(element) {
    const handler = e => { e.preventDefault(); this.onTouchEvent(e); };
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      element.addEventListener(type, handler, { passive: false });
    }
    // 页面切后台时释放所有触点，避免"卡住的按下状态"
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAllTouch();
    });
    return () => {
      for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        element.removeEventListener(type, handler);
      }
    };
  }
}

// ────────────────────────────────────────────────────────────────
// 6. 信令通道（8 字节帧头）
// ────────────────────────────────────────────────────────────────

const SignalType = { SIGNALING: 1, PROXY: 2, HANDSHAKE: 3, KEEPALIVE: 4 };

class SignalingChannel {
  constructor(url) {
    this.url = url.endsWith('/rtc-sdk') ? url : url + '/rtc-sdk';
    this.ws = null;
    this.keepAliveTimer = null;
    this.handlers = {};
    this.readyPromise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      // 首帧必须是 client hello，type=3，带 8 字节头
      this.sendMessage(JSON.stringify({ client_type: 'web', type: 'client hello' }), SignalType.HANDSHAKE);
      this._startKeepAlive();
      this._resolve();
    });

    this.ws.addEventListener('message', e => this._onMessage(e.data));
    this.ws.addEventListener('close', () => {
      this._stopKeepAlive();
      this.handlers.onClose && this.handlers.onClose();
    });
    this.ws.addEventListener('error', err => {
      this._stopKeepAlive();
      this._reject(err);
      this.handlers.onError && this.handlers.onError(err);
    });

    return this.readyPromise;
  }

  sendMessage(payload, type) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    // type=4 (keepalive) 发裸空帧，不带 8 字节头
    if (type === SignalType.KEEPALIVE) {
      this.ws.send('');
      return true;
    }

    const body = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : new Uint8Array(payload);

    const frame = new Uint8Array(8 + body.length);
    const dv = new DataView(frame.buffer);
    dv.setUint32(0, type, false);       // big-endian
    dv.setUint32(4, body.length, false);
    frame.set(body, 8);
    this.ws.send(frame);
    return true;
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      this.sendMessage('', SignalType.KEEPALIVE);
    }, 10000);                          // 每 10s
  }

  _stopKeepAlive() {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
  }

  _onMessage(data) {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!(buf instanceof Uint8Array) || buf.length < 8) return;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const type = dv.getUint32(0, false);
    const len = dv.getUint32(4, false);
    const payload = buf.slice(8, 8 + len);

    switch (type) {
      case SignalType.SIGNALING:
        this.handlers.onSignaling && this.handlers.onSignaling(new TextDecoder().decode(payload));
        break;
      case SignalType.PROXY:
        this.handlers.onProxy && this.handlers.onProxy(payload);
        break;
      case SignalType.HANDSHAKE:
        this.handlers.onHandshake && this.handlers.onHandshake(new TextDecoder().decode(payload));
        break;
      default:
        console.warn('[signaling] unknown type', type);
    }
  }

  close() {
    this._stopKeepAlive();
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

// ────────────────────────────────────────────────────────────────
// 7. 完整接线示例
// ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.wssUrl         sdk_param 字段 11 + '/rtc-sdk'
 * @param {string} opts.sid            字段 1
 * @param {RTCPeerConnection} opts.pc  由信令协商出的 PeerConnection
 * @param {HTMLElement} opts.container 视频容器（用于触摸事件绑定）
 * @param {HTMLElement} opts.videoEl   <video> 元素（用于算 gameRect）
 */
async function setupTouchInput(opts) {
  const { wssUrl, sid, pc, container, videoEl } = opts;

  const signaling = new SignalingChannel(wssUrl);
  await signaling.connect();

  // DataChannel 由服务端建立
  let dataChannel = null;
  pc.addEventListener('datachannel', e => {
    dataChannel = e.channel;
    dataChannel.binaryType = 'arraybuffer';
    console.log('[rtc] datachannel opened:', dataChannel.label);
  });

  // gameRect：视频元素在屏幕上的实际显示区域
  const getGameRect = () => {
    if (!videoEl) return null;
    const r = videoEl.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  // 发送：优先 GameControlChannel（未实现时回退 DataChannel）
  const sendFn = packet => {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(packet.buffer);
      return true;
    }
    console.warn('[input] no channel ready');
    return false;
  };

  const touch = new TouchController(sendFn, getGameRect);
  const detach = touch.attach(container);

  return { signaling, touch, detach, get dataChannel() { return dataChannel; } };
}

// ────────────────────────────────────────────────────────────────
// 自检
// ────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && require.main === module) {
  // 单点按下
  const pkt = buildTouchPacket([
    { fingerId: 0, action: TouchActionType.Down, position: { x: 0.5, y: 0.5 }, isPrimary: true },
  ]);
  console.log('packet len =', pkt.length);
  console.log('hex =', Buffer.from(pkt).toString('hex'));

  const parsed = parsePacket(pkt);
  console.log('parsed cmdId =', parsed.cmdId, 'msgLen =', parsed.msgLen);
  console.log('msg hex =', Buffer.from(parsed.msg).toString('hex'));

  // 期望 msg = 08 15 (type=21) 6a 0e (field13, len14) 0a 0c (field1, len12)
  //            08 00 10 00 1d 00 00 00 3f 25 00 00 00 3f 38 01
  // 注：fingerId=0/action=0 是 proto3 默认值，不序列化，所以不会出现 08 00 10 00
  const multi = buildTouchPacket([
    { fingerId: 0, action: TouchActionType.Down, position: { x: 0.25, y: 0.75 }, isPrimary: true },
    { fingerId: 1, action: TouchActionType.Down, position: { x: 0.5, y: 0.5 }, isPrimary: false },
  ]);
  console.log('\nmulti-finger packet len =', multi.length);
  console.log('hex =', Buffer.from(multi).toString('hex'));

  console.log('\nOK');
}

const __api = {
  DataType, TouchActionType, createPacket, parsePacket,
  buildTouchPacket, TouchController, SignalingChannel, setupTouchInput,
};
if (typeof module !== 'undefined' && module.exports) module.exports = __api;
// 浏览器里用 <script src="touch.js"> 加载后可通过 window.YYS_TOUCH 访问
if (typeof globalThis !== 'undefined') globalThis.YYS_TOUCH = __api;
