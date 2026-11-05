# 触摸输入

触摸走 **protobuf over DataChannel / GameControlChannel**。完整可跑实现在
[`src/touch.js`](../src/touch.js)，自检在 [`src/test-touch.js`](../src/test-touch.js)。

---

## 1. 报文结构（三层嵌套）

```
Packet(cmd_id=20010)
└── proto.msg.RtcDataChannel
    ├── type = 21  (DataType.TOUCH_EVENT_LIST)
    └── touch_list (field 13)
        └── proto.common.RtcTouchEventList
            └── event_list (field 1, repeated)
                └── proto.common.RtcTouchEvent
```

### 1.1 `RtcTouchEvent`

| # | 字段 | 类型 | 说明 |
|---|---|---|---|
| 1 | `finger_id` | uint32 | 0..9，池化管理 |
| 2 | `action_type` | uint32 | **0=Down, 1=Up, 2=Move** |
| 3 | `point_x` | **float** | 归一化 [0,1] |
| 4 | `point_y` | **float** | 归一化 [0,1] |
| 5 | `press_size_x` | float | SDK 恒填 `0` |
| 6 | `press_size_y` | float | SDK 恒填 `0` |
| 7 | `is_primary` | bool | 主触点 |
| 8 | `rtt_trace_send_time` | int64 | 可选 |

**单包最多 10 个事件**，超了 SDK 直接 `return false`：

```js
sendTouchEventList(events) {
  if (events.length === 0 || events.length > 10) return false;
  ...
}
```

### 1.2 十六进制样例

单指按下（finger=0, action=Down, (0.5, 0.5), primary）：

```
45674e2a 0000 0000 0012 08156a0e0a0c1d0000003f250000003f3801 89ab
│        │    │    │    └─ msg: 0815(t=21) 6a0e(field13,len14) 0a0c(field1,len12)
│        │    │    │              1d0000003f(pointX=0.5 LE) 250000003f(pointY=0.5) 3801(isPrimary)
│        │    │    └─ msg_len = 18
│        │    └─ head_len = 0
│        └─ cmd_id = 20010
└─ magic 17767
```

> `finger_id=0` / `action=Down(0)` 是 proto3 默认值，**不会出现在字节流里**。
> 这是正常的，解析时按默认值补 0。

双指样例（44 字节）：

```
45674e2a00000000002008156a1c0a0c1d0000803e250000403f3801 0a0c08011d0000003f250000003f 89ab
                                                             └─ 第二指 finger=1, action=Up
```

---

## 2. 坐标归一化

坐标是 **相对游戏画面 rect 的 [0,1] 比例**，不是像素。

### 2.1 横屏

```js
const x = (e.clientX - rect.x) / rect.width;
const y = (e.clientY - rect.y) / rect.height;
```

### 2.2 竖屏（有旋转）

```js
const x = e.clientY;
const y = layoutHeight - e.clientX;
// 之后再减 rect 偏移并除宽高
```

源码原文（`m/js/home.*.js` @249xxx）：

```js
const i = (e) => {
  if (!n.rect.gameRect) return null;
  const i = t.isLandscape ? e.clientX : e.clientY;
  const o = t.isLandscape ? e.clientY : pA().instance.env.layoutHeight - e.clientX;
  return { x: (i - n.rect.gameRect.x) / n.rect.gameRect.width,
           y: (o - n.rect.gameRect.y) / n.rect.gameRect.height };
};
```

> 鼠标也是同一套归一化（`js/home.e52bd9d9.js` @290827 的 `a(e)`），
> 差别只是 `mouseMove(abs, relDelta)` 还额外传一个相对增量。

---

## 3. fingerId 池管理

官方用 `class Gp`（TouchController）管理 10 个 id。**必须原样移植**，
否则多点触控会错乱。

```js
class Gp {
  constructor() {
    this.availableFingerIdPool = Array.from({ length: 10 }, (_, i) => i); // 0..9
    this.occupiedFingerIdPool = new Map();
    this.fingerMap = new Map();   // identifier -> {clientX, clientY, identifier, fingerId}
    this.primaryId = -1;
  }
}
```

### 3.1 分配 / 归还

```js
requiredFingerId() {
  if (this.fingerMap.size >= 10) this.releaseOldest();  // 满了先挤掉最老的
  const id = this.availableFingerIdPool.shift();
  this.occupiedFingerIdPool.set(id, true);
  return id;   // 可能 undefined → 上层 releaseAllTouch()
}

releaseFingerId(id) {
  this.occupiedFingerIdPool.delete(id);
  if (!this.availableFingerIdPool.includes(id)) this.availableFingerIdPool.push(id);
}
```

### 3.2 primary 规则

```js
if (this.occupiedFingerIdPool.size === 1) this.primaryId = id;
```

**只有"池里第一个"才算 primary**，之后加入的手指都不是。
`primaryId` 只在 `releaseAllTouch()` 里才重置为 `-1`。

### 3.3 三个清理入口（顺序不能变）

| 时机 | 方法 | 作用 |
|---|---|---|
| `touchstart` 前 | `releaseDuplicatesTouch(evt)` | 对已存在于 `fingerMap` 的 identifier 先补一个 Up，防重复 Down |
| `touchstart` 前 | `releaseUntrackableTouch(evt)` | `evt.touches` 里没有的 → 补 Up（浏览器丢事件时兜底） |
| `visibilitychange` → `hidden` | `releaseAllTouch()` | 广播 10 个 Up，坐标 `(0.5, 0.5)`，重置池与 primaryId |

`releaseAllTouch()` 原文行为：遍历 0..9 全部**即使没占用也发 Up**，
固定坐标 `{x:0.5, y:0.5}`，`isPrimary = (primaryId === i)`，发完清空状态。

---

## 4. 事件 → 报文的完整映射

```js
onTouchEvent(evt) {
  if (!rect.gameRect) return;
  if (ui.showGameMenu) { ui.toggleGameMenu({ source: 'Mouse' }, false); return; }
  if (!evt.changedTouches || evt.changedTouches.length === 0) return;

  let action;
  switch (evt.type) {
    case 'touchstart': action = TouchActionType.Down;
        this.releaseDuplicatesTouch(evt);
        this.releaseUntrackableTouch(evt);
        break;
    case 'touchmove':  action = TouchActionType.Move; break;
    case 'touchend':
    case 'touchcancel': action = TouchActionType.Up; break;
    default: return;
  }

  const events = [];
  for (const t of evt.changedTouches) {
    const meta = this.getFingerId(t, action);
    if (!meta) continue;
    const pos = this.calcPosition(t);
    if (pos) events.push({ ...meta, position: pos });
  }
  if (events.length) sdk.sendTouchEventList(events);
}
```

绑定（`passive: false` 以便必要时 `preventDefault`）：

```js
el.addEventListener('touchstart',  h, { passive: false });
el.addEventListener('touchmove',   h, { passive: false });
el.addEventListener('touchend',    h, { passive: false });
el.addEventListener('touchcancel', h, { passive: false });
```

---

## 5. 与鼠标输入的关系

同一个 SDK 里还有一套鼠标 API，PC 端页面用的是它：

```js
mouseLeftButtonDown({x, y})   mouseLeftButtonUp({x, y})
mouseRightButtonDown({x, y})  mouseRightButtonUp({x, y})
mouseMiddleButtonDown({x, y}) mouseMiddleButtonUp({x, y})
mouseMove({x, y}, {x: dx, y: dy})   // 绝对 + 相对增量
mouseScroll(deltaY)
```

坐标同样是 `gameRect` 归一化。`mouseMove` 由 `Throttle(..., 4)` 节流到 4ms。

**触摸版页面完全不调用鼠标 API**，PC 版页面完全不调用 `sendTouchEventList`
（PC 的 home chunk 里 `sendTouchEventList` 出现 0 次，触摸端出现 3 次）。
但 SDK 是同一份，所以你想混用随时可以。

---

## 6. 其它输入类型（同一报文，不同 `type`）

`RtcDataChannel` 的 `type` 字段决定 payload：

| type | 常量 | 对应字段 |
|---|---|---|
| 1 / 2 | `KEYBOARD_DOWN` / `KEYBOARD_UP` | `keyboard` (2) |
| 3 | `MOUSE_MOVE` | `mouse` (3) |
| 4 / 5 | `MOUSE_LBUTTON_DOWN` / `UP` | `mouse` (3) |
| 6 / 7 | `MOUSE_RBUTTON_DOWN` / `UP` | `mouse` (3) |
| 10 | `MOUSE_ZDELTA` | `mouse` (3) |
| 12 | `IME_INPUT` | `ime_input` (5) |
| 17 | `GAMEPAD_KEY` | `gamepad` (10) |
| 18 | `GAMEPAD_LIST` | `gamepad_list` (11) |
| **21** | **`TOUCH_EVENT_LIST`** | **`touch_list` (13)** |
| 22 | `IMU_EVENT` | `imu_event` (14) |
| 30 | `GAME_DATA` | — |
| 31 | `RESET_GAME_INPUT_CONTROL` | `input_control_type` (17) |

完整枚举见 [protocol.md §9](./protocol.md#9-datachannel-报文封装)。
