# 调度链与签名

"进入游戏"不是一次调用，而是六步 HTTP 链 + 一次 protobuf 解码。全部在
`api-cloudgame.mihoyo.com/hk4e_cg_cn` 下。

```
                    ┌──────────────────────────────────────────┐
  点击"进入游戏"  →  │ 1 statusCheck     集群是否可用            │
                    │ 2 listPingServer  拿测速服务器列表         │
                    │ 3 (浏览器) RTT 测速 20 包取平均            │
                    │ 4 getNodesInfo    上报测速结果，返回节点   │
                    │ 5 paasDispatch    申请机器，返回 sdk_param │
                    │ 6 protobuf 解码   → WSS + game_token      │
                    └──────────────────────────────────────────┘
                                    ↓
                    WSS 信令 → WebRTC 协商 → 视频流 + DataChannel
```

实测调用顺序（PC 与触摸完全一致）：

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 0 | POST | `/gamer/api/login` | 先建 session |
| 1 | GET | `/gamer/api/getSpeedLimitConfig?speed_client_type=7\|8` | 拿画质/码率档位 |
| 2 | POST | `/dispatcher/api/statusCheck` | body 21 字节 |
| 3 | POST | `/dispatcher/api/listPingServer` | 返回 `ping_svr[]` |
| 4 | — | 浏览器侧 RTT 测速 | 非 HTTP |
| 5 | POST | `/dispatcher/api/getNodesInfo` | body 1.3KB |
| 6 | POST | `/dispatcher/api/paasDispatch` | body ~930B，**带 sign** |
| 7 | — | 解 `sdk_param` | protobuf |

> **实测修正**：`preDispatchVerify` 与 `ackDispatchTicket` 在 4 次真实 paasDispatch
> （PC 2 次 / 触摸 2 次）中**都没有发出**。它们只在排队、切换集群、失败重试的路径上才用。
> 不要把它们当成必要步骤。

---

## 1. `statusCheck`

```http
POST /hk4e_cg_cn/dispatcher/api/statusCheck
{"biz_key":"hk4e_cn"}
```

响应只有几十字节，`retcode != 0` 表示集群维护。

## 2. `listPingServer`

```http
POST /hk4e_cg_cn/dispatcher/api/listPingServer
{"biz_key":"hk4e_cn","ext_data":"{\"platform\":18}"}
```

`ext_data` 是 **JSON 字符串**（不是对象），里面装 cloudgame 的 `client_type`。

响应：

```json
{"retcode":0,"message":"OK","data":{"ping_svr":[
  {"ping_server_id":69,"addr":"157.255.56.102:12307","display_name":"佛山1",
   "region_id":"99607000117","province_id":"350000","isp_type":2,
   "node_id":"9960","wss_url":"wss://cg-u-tygz1-wssping.mhystatic.com/wsspingsvr/echo",
   "is_ipv6":false}]}}
```

## 3. RTT 测速（浏览器侧，非 HTTP）

`class WebSocketRttTester`（`js/cg-sdk.*.js` @1106195）：

1. `new WebSocket(wssUrl)`
2. open 后连续发 **20 个** `"X"` 文本帧，每次把 `Date.now()` 压入 `inFlightPingSendTimeList`
3. 每收到一帧，`rtt = Date.now() - list.shift()`
4. 收满 20 个取**算术平均**并 `Math.round`
5. 任一步超时（1000ms）→ 该节点 `rtt = -1`

配套的 `HttpsBandwidthTester` 会 `fetch` 一个文件算
`bandwidthBps = Math.round(8*byteLength/(elapsed/1000))`，但实测 `bandwidth` 恒为 `0`（未启用）。

`startPing`（@1173912）用 `Promise.race([超时, doSpeedTest(...)])` 包一层，
超时就把所有 rtt 置 `-1`。

## 4. `getNodesInfo`

```http
POST /hk4e_cg_cn/dispatcher/api/getNodesInfo
```

请求体（`node` 是 **JSON 字符串**，不是对象）：

```json
{"biz_key":"hk4e_cn",
 "node":"{\"bandwidth\":0,\"ping_results\":[{\"ping_server_id\":69,\"node_id\":\"9960\",
   \"display_name\":\"佛山1\",\"region_id\":\"99607000117\",\"province_id\":\"350000\",
   \"isp_type\":2,\"rtt\":102,\"loss_rate\":0,\"jitter\":0,\"out_of_order\":0}, ...]}",
 "speed_client_type":8}
```

响应：

```json
{"retcode":0,"message":"OK","data":{
  "wait_seconds":9,
  "nodes":[{"node_name":"","net_state":"NetStateUnknown","net_value":72,
    "queue_state":"QueueStateUnknown","queue_value":0,"recommend":false,"isp_type":2,
    "region_ids":["99607000167","99607000104","99607000250","99607000143","99607000247","99607000117"],
    "node_id":"440000","node_alias":"","vendor_id":2}],
  "network_info":null,"result_code":"NONE","maintenance_info":null}}
```

**`region_ids` 就是 paasDispatch 里的 `regions`**，顺序由服务端给定，不要自己排。

## 5. `paasDispatch`

```http
POST /hk4e_cg_cn/dispatcher/api/paasDispatch
```

真实请求体（触摸版，958 字符）：

```json
{"hint":null,"net_state":4,"queue_type":"",
 "sign":"468789c6ff649775d29d0b73976b83346c36cbccdb0596697e8b4781da75473a",
 "using_new_cmd_line":true,"queue_switch":false,
 "bit_rate":9216000,"biz_key":"hk4e_cn","cmd_line":"",
 "user_data":"{\"dpi\":480,\"w\":2532,\"h\":1170,\"lang\":\"zh-CN\",\"di\":\"<base64>\"}",
 "codec_type":1,"env":"2","ext_data":"","fps":60,"node_id":"440000",
 "resolution":"2532x1170",
 "regions":["99607000167","99607000104","99607000250","99607000143","99607000247","99607000117"]}
```

### 5.1 字段来源

| 字段 | 取值 |
|---|---|
| `bit_rate` | `1024 * speedLimitGear.top`（超高清 top=9000 → 9216000） |
| `fps` | `player.fps \|\| loadConfig().fps \|\| boxConfig.fps_list.default`，实测 60 |
| `net_state` | `pf()` 结果；`4` = `NetStateUnknown` |
| `hint` | `dispatchHint`，缺省 `null` |
| `queue_type` | 排队类型字符串，直连时 `""` |
| `queue_switch` | 是否切换队列，直连 `false` |
| `using_new_cmd_line` | `true` → `cmd_line` 留空，内容由服务端回填进 `sdk_param` |
| `cmd_line` | 新版流程恒为 `""` |
| `codec_type` | `1`（H.264） |
| `env` | 字符串 `"2"`（`String(appEnv.env)`） |
| `node_id` | `getNodesInfo` 返回的 `node_id`（省份码，如 `"440000"`） |
| `resolution` | `"WxH"`，横向 |
| `regions` | `getNodesInfo` 的 `region_ids` 原样 |
| `user_data` | `JSON.stringify({dpi,w,h,lang,di})`，`di = base64(JSON.stringify(deviceInfo))` |

### 5.2 签名（这是最容易踩的坑）

**被签名的对象不是最终 body。** 前端先构建中间对象 `y`，签名后才把 `hint/net_state/...`
和**数组形态的 `regions`** 覆盖上去：

```js
// 被签名的中间对象：regions 是 JSON 字符串
const y = {
  bit_rate, biz_key, cmd_line: '', user_data, codec_type: 1, env: '2',
  ext_data: '', fps, node_id, resolution,
  regions: JSON.stringify(region_ids),   // ← 字符串！
};

const sign = HMAC_SHA256(
  Object.keys(y).sort().map(k => `${k}=${y[k]}&`).join('').slice(0, -1),
  '7511caf05a67bb7ca33b1970ce6222a8'
);

// 最终 body：regions 被真正的数组覆盖
const body = { ...y, hint, net_state, queue_type, sign,
               using_new_cmd_line: true, queue_switch: false,
               regions: region_ids };        // ← 数组
```

对应源码 `web.103b867a.js` @222892：

```js
b = (0, r.R)(y, _.U.appEnv.appKey);
A = { hint: l(), net_state: (0, L.pf)(), queue_type: o, sign: b,
      using_new_cmd_line: !0, queue_switch: n, ...y, ...{ regions: e.region_ids } };
```

`...y` 已经把 `regions`（字符串）带进来了，最后 `...{regions: e.region_ids}`
再覆盖成数组 —— **所以签名对象与线上 body 永远不一致**。

若你直接对最终 body 签名，会得到
`e71d4289947dd0167a39e06182888fe14d45a054054e4440605a1782a309dc0b`（错误值）；
去掉 `regions` 再签得到 `314374b9...`（也是错的）。

可执行验证：`node src/sign.js` → `MATCH: true`。

### 5.3 响应

```json
{"retcode":0,"message":"OK","data":{
  "result_code":"FINISHED",
  "finish_result":{"sdk_param":"<base64 protobuf>","sid":"g3cqxw6dnri8",
    "cloud_provider":"庭宇边缘IDC","region_id":"99607000117","node_id":"",
    "queue_type":"normal","cost_method":0,"game_id":"9000055",
    "name_i18n":"","is_weak_network":false,"non_domestic":false,
    "ip_location":{"zip_code":"","asn":""}},
  "maintenance_info":null,"queue_info":null}}
```

`result_code` 三态：

| 值 | 后续动作 |
|---|---|
| `FINISHED` | 取 `finish_result.sdk_param`，解 protobuf 后连 WSS |
| `QUEUED` | 取 `queue_info.{ticket, query_interval}`，轮询 `getDispatchTicketInfo` |
| 其它 | 按 retcode 处理（见 api.md §15） |

排队相关：

```
POST /dispatcher/api/getDispatchTicketInfo   {"biz_key":"hk4e_cn","ticket":"..","sign":".."}
POST /dispatcher/api/leaveDispatchQueue      {"biz_key":"hk4e_cn","ticket":"..","sign":".."}
POST /dispatcher/api/ackDispatchTicket
POST /dispatcher/api/preDispatchVerify       {"biz_key":"hk4e_cn","node_id":"..","sign":"..","regions":[..]}
```

---

## 6. `sdk_param` 解码

`base64` → `proto.paas.SdkStartGameParams`（实测 1169~1253 字节）。

字段表（从 `cg-sdk` 的 `serializeBinaryToWriter` @478607~479154 逐条读出）：

| # | 字段 | 类型 | 实测样例 |
|---|---|---|---|
| 1 | `sid` | string | `g3cqxw6dnri8` |
| 2 | `ca_id` | string | `tygz1-c1-1044-1_1793823174` |
| 3 | `pod_id` | string | `tygz1-c1-1044-1` |
| 4 | `game_token` | string | `1Ox8JXHVNqEiQjPztHuS` |
| 5 | `resolution` | string | `2532x1170` |
| 6 | `target_fps` | uint32 | `60` |
| 7 | `cmd_line` | string | 服务端回填的明文 |
| 8 | `game_svr_addr` | string | `157.255.56.100:44402` |
| 9 | `rtc_udp_port` | uint32 | `44403` |
| 10 | `additional_game_svr_addrs` | repeated string | `["59.37.144.195:44402", ...]` |
| 11 | `game_server_wss_url` | string | `wss://cg-tygz1-wss-unicom-...:mhystatic.com/tygz1-c1-1044-1/50202` |
| 12 | `additional_game_server_wss_urls` | repeated string | telecom / mobile 两组 |
| 13 | `big_isp` | uint32 | `1` |
| 14 | `game_control_channel_url` | string | `wss://...:5443/tygz1-c1-1044-1/50202` |
| 15 | `additional_game_control_channel_urls` | repeated string | telecom / mobile |
| 16 | `is_ipv6` | bool | — |
| 17 | `game_svr_addr_ipv6` | string | — |
| 18 | `rtc_udp_port_ipv6` | uint32 | — |
| 19 | `additional_game_svr_addrs_ipv6` | repeated | — |
| 20 | `game_server_wss_url_ipv6` | string | — |
| 21 | `additional_game_server_wss_urls_ipv6` | repeated | — |
| 22 | `game_control_channel_url_ipv6` | string | — |

`cmd_line` 实测值（已解密形态，字段 7）：

```
-user_screen_dpi 480 -user_screen_width 2532 -user_screen_height 1170
-user_system_language zh-CN -device_info eyJkZXZpY2VOYW1l... -user_ip 163.125.229.253 -aid 291400719
```

解码工具：

```bash
node src/pbdecode.js '<base64 sdk_param>'
```

---

## 7. 服务端列出的信令地址

拿到 `game_server_wss_url` 后**必须补 `/rtc-sdk`**：

```js
// cg-sdk WebSessionInfo.getServerWssUrl() @1074400
url.endsWith('/rtc-sdk') || (url += '/rtc-sdk');
```

最终：

```
wss://cg-tygz1-wss-unicom-cg_cn_mix1.mhystatic.com/tygz1-c1-1044-1/50202/rtc-sdk
```

备用地址在 `additional_game_server_wss_urls` 里（联通/电信/移动三线）。
`switchToNextServer()` 会在失败时轮换。

---

## 8. 握手与心跳

WSS 建连后立刻发 **type=3 握手帧**：

```json
{"client_type":"web","type":"client hello"}
```

帧格式（8 字节大端头）：

```
[0..3] type  (1=signaling, 2=proxy, 3=handshake, 4=keepalive)
[4..7] length
[8..]  payload (utf-8 或二进制)
```

**心跳特殊**：`sendKeepAlive()` 直接 `websocket.send("")` 发一个**裸空帧**
（没有 8 字节头），每 **10 秒**一次。

收帧分发：

| type | 回调 |
|---|---|
| 1 | `onSignaling(str)` — SDP / ICE |
| 2 | `onProxy(bytes)` — 二进制信令 |
| 3 | `onHandshake(str)` |

---

## 9. DataChannel 报文封装

所有输入/控制报文都是 `proto.msg.RtcDataChannel` 序列化后塞进 `Packet`。

### 9.1 `Packet` 帧格式（`minPacketSize = 12`）

```
[0..1]   0x45 0x67          magic = 17767
[2..3]   cmd_id             big-endian
[4..5]   head_len           big-endian
[6..9]   msg_len            big-endian
[10..]   PacketHead         protobuf (head_len 字节)
[..]     msg                protobuf (msg_len 字节)
[-2..-1] 0x89 0xAB          magic = 35243
```

`RtcDataChannel.CmdId.CMD_ID = 20010`。

### 9.2 发送路径

```js
const pkt = Packet.createPacket(20010, msg);
if (gameControlChannel.valid()) gameControlChannel.send(pkt.toUint8Array());
else                            rtcConnection.sendRtcData(pkt.toArrayBuffer());
```

**优先走 GameControlChannel，否则走 WebRTC DataChannel —— 两者报文完全相同。**
发送前必须检查 `stateMachine.is(State.Connected)`。

> 注意：SDK 里**没有** `createDataChannel` 调用 —— DataChannel 由服务端建立，
> 客户端通过 `pc.ondatachannel` 接收。

---

## 10. 最小可跑骨架

```js
const { sign, buildComboToken } = require('./src/sign');

// 1. 登录
const login = await post('https://hk4e-sdk.mihoyo.com/hk4e_cn/combo/granter/login/webLogin',
  { app_id: 4, channel_id: 1 }, comboHeaders);
const comboToken = buildComboToken({
  app_id: 4, channel_id: 1, open_id: login.open_id,
  combo_token: login.combo_token, game_biz: 'hk4e_cn',
});

// 2. 建立云游戏 session
const H = { ...cloudgameHeaders, 'x-rpc-combo_token': comboToken };
await post(base + '/gamer/api/login', {}, H);

// 3~5. 调度
await post(base + '/dispatcher/api/statusCheck', { biz_key: 'hk4e_cn' }, H);
const ping = await post(base + '/dispatcher/api/listPingServer',
  { biz_key: 'hk4e_cn', ext_data: JSON.stringify({ platform: 18 }) }, H);
// ...浏览器侧测速...
const nodes = await post(base + '/dispatcher/api/getNodesInfo', {
  biz_key: 'hk4e_cn',
  node: JSON.stringify({ bandwidth: 0, ping_results }),
  speed_client_type: 8,
}, H);

// 6. paasDispatch（注意签名对象）
const y = { bit_rate: 9216000, biz_key: 'hk4e_cn', cmd_line: '', user_data,
            codec_type: 1, env: '2', ext_data: '', fps: 60,
            node_id: nodes.nodes[0].node_id, resolution: '2532x1170',
            regions: JSON.stringify(nodes.nodes[0].region_ids) };
const body = { ...y, hint: null, net_state: 4, queue_type: '',
               sign: sign(y, '7511caf05a67bb7ca33b1970ce6222a8'),
               using_new_cmd_line: true, queue_switch: false,
               regions: nodes.nodes[0].region_ids };
const dispatch = await post(base + '/dispatcher/api/paasDispatch', body, H);

// 7. 解 sdk_param → 连 wss
const params = decodeSdkStartGameParams(dispatch.finish_result.sdk_param);
new WebSocket(params.game_server_wss_url + '/rtc-sdk');
```
