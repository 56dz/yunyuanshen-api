# 云·原神 Web 接口逆向（yunyuanshen-api）

> 对 `https://ys.mihoyo.com/cloud/`（PC 端）与 `https://ys.mihoyo.com/cloud/m/`（触摸端）的
> **登录链路**与**云游戏游玩窗口链路**做的一次完整逆向。
>
> 全部结论来自**真实抓包 + 前端 bundle 静态分析双重复核**。关键算法（签名、protobuf
> 封帧、触摸事件、fingerId 池）都附了可运行的验证脚本，脚本内嵌线上抓到的期望值做自检，
> 跑一遍就能证明实现与线上一致。

基线：`hk4e_cn`（国服），前端 `7.2.0`，`cg-sdk 6.1.0.65`。

---

## 这个仓库解决什么问题

想自己封装一个云原神客户端，要打通四段**完全不同**的协议：

| 阶段 | 协议 | 关键产物 |
|---|---|---|
| ① 账号登录 | passport HTTP（请求体 RSA 加密） | 一组 token cookie |
| ② 登录取票 | 米哈游 combo / passport HTTP | `combo_token` + `open_id` → `x-rpc-combo_token` |
| ③ 申请实例 | cloudgame HTTP 调度（含 HMAC 签名） | `sdk_param`（protobuf） |
| ④ 进入游玩窗口 | WebSocket 信令 + WebRTC + 自定义二进制帧 | 视频流 + 触摸输入通道 |

第 ① 段（账号密码 / 手机验证码 / 扫码登录）单列在 [`docs/account.md`](docs/account.md)：
它走 `passport-api.mihoyo.com`，请求体里的账号、密码、手机号要先
**RSA-1024 / PKCS#1 v1.5** 加密成 base64 再发。如果你手上已有一份登录好的 cookie，
可以跳过第 ① 段直接从 ② 开始。

第 ④ 段是绝大多数人卡住的地方 —— **它不是 HTTP 接口**，没有 URL 可抓。
本仓库把四段的字段、时序、算法、坑全部写清楚，并给出可运行的参考实现。

---

## 快速开始

```bash
git clone https://github.com/56dz/yunyuanshen-api
cd yunyuanshen-api

npm test                 # 等价于下面三条
node src/sign.js         # 验证 paasDispatch sign + combo_token 组装 → 两行 MATCH: true
node src/test-touch.js   # 验证触摸编码 + 手指池 → ALL CHECKS PASSED
node src/test-crypto.js  # 验证 passport 登录用的 RSA 加密 → ALL CHECKS PASSED
node src/pbdecode.js '<base64 sdk_param>'   # 解码任意 sdk_param
```

全部零依赖，只用 Node 内置 `crypto` 与 Web API（Node ≥ 18）。

真实输出：

```
[verify_sign] computed: 198f2d8d452dfce709cb4c5f63f61fbb487061d286ca0970eef888a2ab2cedfe
[verify_sign] expected: 198f2d8d452dfce709cb4c5f63f61fbb487061d286ca0970eef888a2ab2cedfe
[verify_sign] MATCH   : true
[verify_sign] combo si : c3cfb041cd387fde2a35c075b8689d6cb8c0f33ef01cf11d95767ae7afc585c0
[verify_sign] combo MATCH: true
```

第一条用的是**真实抓包**的 `paasDispatch` 请求体（不含账号凭据）。
第二条改用占位 fixture（`open_id=100000001`），期望值由 `openssl dgst -sha256 -hmac`
独立算出 —— 真实 `combo_token` 属于账号凭据，未纳入仓库。

```
packets = 5
 #1 cmdId=20010 fingerId=0 action=0 x=0.0521 y=0.1852 primary=true
 #2 cmdId=20010 fingerId=1 action=0 x=0.2604 y=0.5556 primary=false
 #3 cmdId=20010 fingerId=0 action=2 x=0.0781 y=0.2315 primary=true
 #4 cmdId=20010 fingerId=0 action=1 x=0.0781 y=0.2315 primary=true
 #5 cmdId=20010 fingerId=1 action=1 x=0.2604 y=0.5556 primary=false

ALL CHECKS PASSED
```

---

## 四段链路总览

```
┌─ ① 账号登录（passport 域，详见 docs/account.md）─────────────────────┐
│ POST passport-api.mihoyo.com/account/ma-cn-passport/web/loginByPassword
│      body {"account": RSA(账号), "password": RSA(密码)}
│ POST .../web/loginByMobileCaptcha   加密 {mobile, area_code} + captcha
│ POST .../web/createQRLogin → {url, ticket}，再轮询 queryQRLoginStatus
│      └ status: Created → Scanned → Confirmed
│ 密码/手机号/区号/身份证号/姓名 都要 RSA-1024 PKCS#1 v1.5 → base64
│ 成功 → 服务端 Set-Cookie 下发 token cookie（前端不写 cookie）
└───────────────────────────────────────────────────────────────────────┘

┌─ ② 登录取票 ─────────────────────────────────────────────────────────┐
│ POST passport-api.mihoyo.com/account/ma-cn-session/web/webVerifyForGame
│      └ 校验通行证 cookie，返回 user_info（明文 aid/email/mobile）+ set-cookie
│ POST hk4e-sdk.mihoyo.com/hk4e_cn/combo/granter/login/webLogin
│      body {"app_id":4,"channel_id":1}
│      └ open_id, combo_token (v2_xxx)
│ si = HMAC_SHA256(sorted "k=v&", COMBO_APP_KEY)
│ x-rpc-combo_token = ai=4;ci=1;oi=..;ct=..;si=..;bi=hk4e_cn
│ POST api-cloudgame.mihoyo.com/hk4e_cg_cn/gamer/api/login   ← 建云游戏 session
└───────────────────────────────────────────────────────────────────────┘

┌─ ③ 调度 ─────────────────────────────────────────────────────────────┐
│ GET  /wallet/wallet/get                          剩余时长 / 原点
│ GET  /gamer/api/getSpeedLimitConfig?speed_client_type=8
│        └ bit_rate = 1024 * gears[default_gear].top
│ POST /dispatcher/api/statusCheck                 {"biz_key":"hk4e_cn"}
│ POST /dispatcher/api/listPingServer              → ping_svr[] 含 wss_url
│      └ 浏览器开 WebSocket × 20 次 "X"，算平均 RTT（不是 HTTP 测速）
│ POST /dispatcher/api/getNodesInfo                → node_id + region_ids
│ POST /dispatcher/api/paasDispatch                → result_code: FINISHED
│      └ data.finish_result.sdk_param  (protobuf, base64)
│ 解 sdk_param → game_token / game_svr_addr / rtc_udp_port / game_server_wss_url
└───────────────────────────────────────────────────────────────────────┘

┌─ ④ 游玩窗口 ─────────────────────────────────────────────────────────┐
│ WSS  wss://<game_server_wss_url>/rtc-sdk        ← 注意要补 /rtc-sdk
│      首帧 type=3 → {"client_type":"web","type":"client hello"}
│      服务端发 offer → setRemoteDescription → createAnswer → 回 type=1
│      服务端 candidate 的 ip:port 换成 sdk_param 的 game_svr_addr/rtcUdpPort
│      每 10s 发**裸空帧**保活（无 8 字节头）
│ WebRTC  recvonly audio + video；DataChannel 由服务端建立（ondatachannel）
│ 触摸     RtcTouchEvent → RtcTouchEventList → RtcDataChannel(type=21)
│          → Packet(magic 0x4567 | cmd_id 20010 | magic 0x89AB)
│          → GameControlChannel（优先）或 DataChannel
└───────────────────────────────────────────────────────────────────────┘
```

---

## 目录

```
docs/
  account.md      账号登录（密码 / 短信 / 扫码）、RSA 加密、passport 端点与错误码
  api.md          逐接口参考：请求/响应/请求头/字段含义/错误码
  protocol.md     调度链时序、签名算法（含"签名对象≠body"）、sdk_param 字段表
  webrtc.md       信令帧格式、SDP 协商（服务端发 offer）、ICE 地址改写、DataChannel
  touch.md        触摸 protobuf、坐标归一化、fingerId 池、primary 语义
  clients.md      PC / WebTouch / iOS / Android 的 client_type 矩阵与判定链
  pitfalls.md     20 个踩过的坑（每个都有症状 + 原因 + 解法）

src/
  sign.js         sign() / buildComboToken() / buildPaasDispatch()  ← npm test 自检
  crypto.js       RSA-1024 PKCS#1 v1.5 加密（passport 登录用，Node/浏览器通用）
  touch.js        protobuf Writer、Packet 封帧、TouchController、SignalingChannel
  pbdecode.js     通用 protobuf wire 解码器（可 CLI 或 require）
  test-touch.js   多指模拟测试：fingerId 分配 / primary / 坐标 / 池归还
  test-crypto.js  RSA 加密自检：与 node:crypto 互通 + 真实公钥参数比对

examples/
  login-account.js     ① 账号登录：密码 / 短信 / 扫码三模式（Node）
  login.js             ② 登录 → combo_token（Node，需环境变量 MHY_COOKIE）
  dispatch.js          ③ 调度 → sdk_param → 解出连接参数（Node）
  play-skeleton.html   ④ 完整骨架：登录 + 调度 + WebRTC + 触摸（浏览器，零构建）
```

---

## 五个最容易踩的坑

### 1. `paasDispatch` 的签名对象 **不是** 最终 body

前端先构造中间对象 `y`（其中 `regions` 是 `JSON.stringify` 后的**字符串**），对它签名，
再把 `y` 展开进外层 body，**用真实数组覆盖** `regions`，最后追加
`hint/net_state/queue_type/sign/using_new_cmd_line/queue_switch`。

```js
// 被签名的（11 个字段，regions 是字符串）
const y = { bit_rate, biz_key, cmd_line:'', user_data, codec_type:1, env:'2',
            ext_data:'', fps, node_id, resolution,
            regions: JSON.stringify(regionIds) };
const sign = HMAC_SHA256(sortedKV(y), CLOUD_APP_KEY);

// 发出去的（多 6 个字段，regions 是数组）
const body = { ...y, hint, net_state, queue_type, sign,
               using_new_cmd_line:true, queue_switch:false, regions: regionIds };
```

直接对 body 签名永远对不上。`src/sign.js` 内嵌真实抓包值做断言。

### 2. 两套 `client_type` 枚举，同一页面里数值不同

| 域 | 枚举 | PC | WebTouch |
|---|---|---|---|
| combo / passport（`webLogin`、`webVerifyForGame`） | `n.CloudWeb*` | **22** | **24** |
| cloudgame（`gamer/*`、`dispatcher/*`） | `k.Web*` | **16** | **18** |

混用会被判定为错误平台。详见 [docs/clients.md](docs/clients.md)。

### 3. 两个 HMAC key，藏在两个不同文件里

| 用途 | key | 出处 |
|---|---|---|
| `x-rpc-combo_token` 的 `si` | `d0d3a7342df2026a70f650b907800111` | `combo-web.*.js` 模块 68828 静态配置表 |
| `paasDispatch` 的 `sign` | `7511caf05a67bb7ca33b1970ce6222a8` | `web.*.js` 模块 21820 `appEnv.appKey` |

签名原文（前者）：`app_id=4&channel_id=1&combo_token=..&open_id=..`
用错 key 会得到 `e8ce9d35499de2478737b10953cd8ad8527d0517d1eb3b105dd3701e90a3a7f3`。

### 4. `cmd_line` 在新流程里是空字符串

`using_new_cmd_line: true` 时前端发 `cmd_line: ""`，真正内容由**服务端回填进
`sdk_param` 字段 7**（明文，含服务端判定的 `-user_ip` 和 `-aid`）。
AES-CFB 加密 `cmd_line` 的路径只在旧流程 / direct 模式才走 —— 不用实现。

### 5. 触摸坐标是归一化 `[0,1]`，不是像素

相对**游戏画面 rect**（不是 window、不是 video 元素）的比例值，是 protobuf float。
竖屏还要做旋转映射。详见 [docs/touch.md](docs/touch.md)。

完整清单见 [docs/pitfalls.md](docs/pitfalls.md)（20 条）。

---

## 触摸版到底特殊在哪

**触摸输入协议只有一套，PC 与触摸端共用同一份 `cg-sdk`**（MD5 完全一致：
`67ec38a4123455bc9d0e68508299a1bd`）。触摸版不是"另一套 API"，只是选了 `WebTouch`
这个客户端类型，让服务端返回适合触摸的分辨率/码率策略：

| 项 | PC（实测） | 触摸版（实测） |
|---|---|---|
| 页面 | `/cloud/` | `/cloud/m/` |
| `x-rpc-client_type`（cloudgame） | 16 | **18** |
| `x-rpc-client_type`（combo） | 22 | **24** |
| `speed_client_type` | 7 | **8** |
| `x-rpc-cps` | `pc_mihoyo` | **`touch_mihoyo`** |
| `getExtList platform` | 22 | **24** |
| 公告 `bundle_id` / `platform` | `hk4e_cn_webpc` / `pc` | `hk4e_cn_webtouch` / `android` |
| `bit_rate` | 13312000 | **9216000** |
| `user_data` | `dpi:96, 1920x1080` | **`dpi:480, 2532x1170`** |
| 实测 `video` 分辨率 | 1920×1080 | 2118×978 |

**判定链**（`web.*.js` 模块 26975）：

```js
function classify() {
  if (desktop()) {                       // navigator.platform / mobile-detect
    if (isWindows()) return WebPC;       // 16
    if (isMacos())   return WebMac;      // 17
    return WebKeyboard;                  // 19
  }
  if (isAndroid())                  return WebAndroid;  // 14
  if (isIos() || isIpad())          return WebIos;      // 15
  if (getDeviceType() === 'mobile') return WebTouch;    // 18 ← 非 android 非 ios 的 mobile
  return localStorageChoice ?? WebKeyboard;
}
```

想在桌面 Chrome 里复现触摸端，UA 必须**被判成 mobile 但既不是 Android 也不是 iOS**。
实测 `BlackBerry 9900` 的 UA 可稳定命中（HarmonyOS UA 不行）。且 emulation 必须在
页面 `reload` **之前**生效，否则页面已按旧 UA 初始化完毕。

---

## 触摸输入：坐标与手指池

`point_x/point_y` 是**相对 `gameRect` 的归一化 float `[0,1]`**：

```js
// 横屏
x = (clientX - rect.x) / rect.width
y = (clientY - rect.y) / rect.height

// 竖屏（layoutHeight = 视口高）
x = (clientY - rect.x) / rect.width
y = ((layoutHeight - clientX) - rect.y) / rect.height
```

手指槽位 `0..9` 共 10 个，`primaryId` 只在**第一根手指按下时**设定
（`occupiedFingerIdPool.size === 1`），只有 `releaseAllTouch()` 才复位为 `-1`
—— 多点触控中第一根手指始终是 primary。单包最多 10 个事件。

`touchstart` 前必须按顺序做两步兜底（顺序不能反）：
`releaseDuplicatesTouch()` → `releaseUntrackableTouch()`。

详见 [docs/touch.md](docs/touch.md)。

---

## 参考实现怎么用

### Node：只验证算法

```bash
npm test                            # sign + touch + crypto，三条断言
node src/pbdecode.js '<base64>'     # 解 sdk_param
```

### Node：跑账号登录（第 ① 段）

```bash
# 扫码登录（默认，最安全：不在本地留密码）
node examples/login-account.js qr

# 账号密码登录（需要 RSA 加密，示例已内置）
MHY_ACCOUNT='you@example.com' MHY_PASSWORD='...' node examples/login-account.js password

# 手机验证码登录（会真的发短信，别对别人的号调）
MHY_MOBILE='138xxxxxxxx' node examples/login-account.js captcha
```

成功后会打印服务端下发的 `Set-Cookie` 列表 —— 这就是下一段要用的 cookie。

### Node：真实跑通 ②③

```bash
# 需要一份已登录 ys.mihoyo.com 的浏览器 cookie
MHY_COOKIE='ltuid_v2=..; ltoken_v2=..; cookie_token_v2=..' \
MHY_PROFILE=touch node examples/login.js > /tmp/session.json

node examples/dispatch.js /tmp/session.json
```

`dispatch.js` 默认在拿到 `sdk_param` 后**不建 WebRTC**，只打印连接参数，
session 会自然超时回收（避免白白消耗时长）。

### 浏览器：完整骨架

打开 `examples/play-skeleton.html`（需 http 服务，`file://` 下 ES module 受限）。

四个按钮：`1 登录` → `2 调度` → `3 连接` → `4 退出`（依序点），日志在左上角。注意：

- 登录用 `credentials: 'include'`，**依赖 ys.mihoyo.com 同源 cookie**。
  跨域需要自己的后端代理，或临时用
  `chrome --disable-web-security --user-data-dir=<临时目录>` 并先登录一次米游社。
- 这个骨架从第 ② 段（`webVerifyForGame`）开始；账号登录请用
  `examples/login-account.js`，或干脆在浏览器里手动登录一次。
- 点"3 连接"会真实建立游戏会话并**开始扣时长**，用完立刻点"退出"。

---

## 验证过的事实 vs 未验证

**已用真实流量验证**：

- 两套 `client_type` 四个组合：PC(16/22)、iOS(15/21)、Android(14/20)、WebTouch(18/24)
- `paasDispatch` 签名 100% 复现（PC 与触摸两次独立抓包）
- `sdk_param` 全字段解码（1169B / 1253B 两个样本）
- WebRTC 实际建流成功（PC 1920×1080、触摸 2118×978），音视频 track 均 live
- 触摸版真实进入游戏画面并截图
- `bit_rate = 1024 * top`、`regions` 顺序取自服务端、`releaseAllTouch` 广播 10 个 Up
- passport 登录的 RSA 加密：**加密后的不存在账号返回 `-3208 账号或密码错误`，
  未加密的同账号返回 `-3001 参数不合法`** —— 证明服务端能正确解出我们的密文
- passport 必填请求头（消融实验）：`x-rpc-app_id` 缺失 → `-3005`；
  `x-rpc-client_type/device_id/mi_referrer/lifecycle_id` 缺失 → `-3006 风控`
- 扫码登录全流程：`createQRLogin` → `{"status":"Created"}` 轮询响应

**未验证 / 已知缺口**：

- `preDispatchVerify` / `ackDispatchTicket`：接口表里有，但 4 次真实调度**都没调用**，
  只在排队/换集群路径出现
- 排队 `QUEUED` 分支：账号秒进，未触发，形态按代码推导
- `cgReport` 上报 body：进入游戏后未触发
- wrapped HEVC（`HevcPipeline` 走 WebCodecs + canvas）：只在特定硬件启用，未实测
- Mac / Keyboard 两种 client_type（17/23、19/25）：仅静态确认
- 账号登录**成功**的响应体与最终 cookie 名：本仓库未用真实账号跑通（会触发短信/风控），
  token 由服务端 `Set-Cookie` 下发，前端 bundle 里没有任何写 cookie 的代码
- 极验 `-3101` 的完整重放：只从响应拦截器源码还原了流程，未触发实测

---

## 免责声明

本项目为**协议研究与互操作性研究**，仅用于学习网络协议设计。代码不含任何绕过鉴权、
破解付费或规避风控的功能，也不包含任何账号凭据。请仅在**你自己的账号**上使用，
并遵守米哈游用户协议与当地法律。由此产生的一切后果由使用者承担。

以 GPL-3.0 发布，见 [LICENSE](LICENSE)。

---

## 参考

- 抓包方式：Chrome DevTools Protocol（`bsk` CLI）+ 页面 device emulation 切换形态
- 逆向对象（PC）：`web.103b867a.js` / `cg-sdk.891daeae.js` / `combo-web.8c9c0fc1.js` / `home.e52bd9d9.js`
- 逆向对象（触摸）：`web.d164e86d.js` / `cg-sdk.4b31dbc9.js` / `home.34c77c0b.js`
