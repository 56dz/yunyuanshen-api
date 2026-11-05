# 踩坑清单

按"踩到的频率 × 排查成本"排序。每条都是实测踩过的。

---

## 1. 签名对象不是最终 body

**症状**：自己算的 `sign` 跟线上对不上，差一个完全不同的 64 位 hex。

**原因**：前端先构建中间对象 `y` 签名，再把 `hint/net_state/queue_type/...` 和
**数组形态的 `regions`** 覆盖上去。

```js
// 签名的是这个（regions 是字符串）
const y = { bit_rate, biz_key, cmd_line:'', user_data, codec_type:1, env:'2',
            ext_data:'', fps, node_id, resolution,
            regions: JSON.stringify(region_ids) };
const sign = HMAC_SHA256(sortedKV(y), appKey);

// 发出去的是这个（regions 是数组，且多了 6 个字段）
const body = { ...y, hint, net_state, queue_type, sign,
               using_new_cmd_line:true, queue_switch:false, regions: region_ids };
```

**错误值**（供对照）：
- 直接签最终 body → `e71d4289947dd0167a39e06182888fe14d45a054054e4440605a1782a309dc0b`
- 去掉 `regions` 再签 → `314374b9...`

正确值（PC 实测）→ `198f2d8d452dfce709cb4c5f63f61fbb487061d286ca0970eef888a2ab2cedfe`

验证：`node src/sign.js` → `MATCH: true`。

---

## 2. 两个不同的 HMAC app_key

**症状**：`paasDispatch` 签名对了，但 `x-rpc-combo_token` 的 `si` 一直不对。

| 用途 | key |
|---|---|
| `x-rpc-combo_token` 的 `si` | **`d0d3a7342df2026a70f650b907800111`** |
| `paasDispatch` 的 `sign` | **`7511caf05a67bb7ca33b1970ce6222a8`** |

前者来自 `combo-web` bundle 的静态配置表（`getStaticConfig("app_key")`，
按 `area/env/game_key` 匹配），**不是** web bundle 的 `appEnv.appKey`。

用错的 key 得到 `ca8d397313906b4b777e2cfafe7967feaf794c563c961ea23dc9f130ac00e182`。

---

## 3. 两套 client_type 枚举

**症状**：照着一个请求抄 header，另一个请求就失败。

- cloudgame 域（`api-cloudgame.mihoyo.com`）：`WebPC=16` / `WebTouch=18` / `WebIos=15` / `WebAndroid=14`
- combo & passport 域（`hk4e-sdk` / `passport-api`）：`CloudWebPC=22` / `CloudWebTouch=24` / `CloudWebIOS=21` / `CloudWebAndroid=20`

**同一页面里数值不同**。详见 [clients.md](./clients.md)。

---

## 4. `cmd_line` 在新版流程里是空字符串

**症状**：花时间实现 AES-CFB 加密 `cmd_line`，结果服务端不认。

**原因**：`using_new_cmd_line: true` 时前端发 `cmd_line: ""`，
真正的内容由**服务端回填进 `sdk_param` 字段 7**（明文形态）。

AES-CFB 加密路径只在 `using_new_cmd_line: false` 或 direct 模式才用。
实测 4 次真实调度全是空字符串。

解密后的 `cmd_line` 里含服务端判定的 `-user_ip` 和 `-aid`，**你算不出来**。

---

## 5. 触摸坐标是归一化 [0,1]，不是像素

**症状**：发 `x: 480, y: 320` 结果点在屏幕外。

**原因**：`point_x` / `point_y` 是 **float**，取值 `[0,1]`，
相对**游戏画面 rect**（不是 window，不是 video 元素）。

```js
x = (clientX - gameRect.x) / gameRect.width;
y = (clientY - gameRect.y) / gameRect.height;
```

竖屏还有旋转分支：

```js
x = clientY;
y = layoutHeight - clientX;
// 再减 rect 偏移、除宽高
```

---

## 6. `finger_id=0` / `action=Down` 不序列化

**症状**：解析自己发的包，发现字段"丢了"。

**原因**：proto3 默认值不写入字节流。`finger_id=0`、`action_type=0`(Down)、
`is_primary=false` 都不会出现在 bytes 里。解析时按默认值补 0 即可。

对照（finger=0, Down, (0.5,0.5), primary=true）：

```
08156a0e0a0c1d0000003f250000003f3801
          ↑ 没有 fingerId / actionType 的字节
```

---

## 7. RTT 测速不是 HTTP

**症状**：找 `ping` 接口找不到。

**原因**：测速在浏览器里做 —— 对 `listPingServer` 返回的每个 `wss_url`
建 WebSocket，连发 **20 个 `"X"` 文本帧**，收到就 `Date.now() - sendTime`，
取算术平均。1000ms 超时则 rtt = -1。

`HttpsBandwidthTester` 虽然存在但**实测恒返回 0**（未启用）。

---

## 8. WebRTC 角色反转

**症状**：按常规发 offer，服务端不回 answer。

**原因**：这里**服务端发 offer，客户端发 answer**。

```
客户端: send {"client_type":"web","type":"client hello"}   (type=3)
服务端: send {"type":"offer","sdp":...}
客户端: setRemoteDescription → createAnswer → setLocalDescription → send answer
```

---

## 9. 没有 STUN/TURN，candidate 地址被服务端改写

**症状**：SDP 协商成功但媒体不通。

**原因**：`sdk_param` 里的 `game_svr_addr` / `rtc_udp_port` 是唯一入口。
收到服务端 candidate 时，若 `isUdp()||isTcp()`，直接**把 candidate 的
ip:port 换成** `game_svr_addr` / `rtcUdpPort`。

```js
cs[4] = gameSvrAddr.ip;
cs[5] = String(sdkParam.getRtcUdpPort());
```

---

## 10. WSS 的 keepalive 是裸空帧

**症状**：按 8 字节头发的 keepalive 被服务端忽略，10~60s 后断线。

**原因**：`type=4` 时不走 `sendMessage`，而是直接
`websocket.send("")` —— **完全没有 8 字节头**。

其它类型帧（1/2/3）才有 8 字节大端头。

---

## 11. WSS 地址要补 `/rtc-sdk`

**症状**：连 `wss://.../tygz1-c1-1044-1/50202` 返回 404/握手失败。

**原因**：

```js
url.endsWith('/rtc-sdk') || (url += '/rtc-sdk');
```

最终：`wss://cg-tygz1-wss-unicom-....mhystatic.com/tygz1-c1-1044-1/50202/rtc-sdk`

---

## 12. DataChannel 不是客户端创建的

**症状**：找 `createDataChannel` 找不到。

**原因**：SDK 里 **0 处** `createDataChannel` —— DataChannel 由服务端建立，
客户端通过 `pc.ondatachannel` 接收。输入报文只能走已存在的 channel 或
GameControlChannel。

---

## 13. `preDispatchVerify` / `ackDispatchTicket` 不是必经步骤

**症状**：照文档顺序实现，这两步报错，以为流程断了。

**原因**：实测 4 次真实 paasDispatch（PC 2 次 / 触摸 2 次）**都没有发这两个请求**，
全部直接 `FINISHED`。它们只在排队、切换集群、失败重试的路径上才用。

---

## 14. `regions` 顺序不能自己排

**症状**：手动按延迟排序 `regions`，服务端调度到不理想的节点或报错。

**原因**：`regions` 必须**原样使用 `getNodesInfo` 响应里的 `region_ids` 顺序**，
那是服务端已经排好的。

---

## 15. `sdk_param` 里的 URL 可能有服务端拼写错误

实测触摸版 `game_control_channel_url`：

```
wss://cg-tyg{1-wss-unicom-cg_cn_mix1.mhystatic.com:5443/tygz1-c1-1044-1/50202
         ↑ 花括号
```

这不是你解析错了，是服务端给的**原样字符串**。
健壮的做法是解析失败就回退到 `additional_game_control_channel_urls`。

---

## 16. `x-rpc-combo_token` 不是裸 token

**症状**：直接把 `combo_token` 塞进 header，全部返回 `TOKEN_INVALID(-100)`。

**原因**：要拼成 6 段分号串：

```
ai=<app_id>;ci=<channel_id>;oi=<open_id>;ct=<combo_token>;si=<hmac>;bi=<game_biz>
```

见 [api.md §2.1](./api.md#21-组装-x-rpc-combo_token)。

---

## 17. 自动化抓包：beforeunload 会拖死 CDP

**症状**（用 bsk/DevTools 自动化时）：所有操作返回
`cdp_failed: Previous operation is still settling`，连 `tab create` 都失败。

**原因**：云原神页面挂了 `beforeunload`。关 tab / reload 时弹
"系统可能不会保存您所做的更改"，renderer 阻塞，CDP 会话卡死。

**解法**：
- 必须 `dialog accept`（= 确认离开），**不是** `dialog dismiss`（dismiss 语义是"取消离开"，
  会让 beforeunload 永久挂着）
- bsk 里的正确顺序：`tab close` 返回 `dialog_pending` → `dialog status` 拿 dialog id →
  `dialog accept <id>` → tab 真正关闭
- 遇到 `cdp_failed` 卡死**不要重试同一 session**，直接开新 session

---

## 18. `emulate` 必须在 `reload` 之前

**症状**：模拟了手机 UA，但 `x-rpc-client_type` 还是 16。

**原因**：emulation 在页面 load 之后才生效，页面已经按旧 UA 初始化完 bundle 了。

**解法**：`emulate → reload`。而且每个 tab 独立，新建 tab 不继承。

---

## 19. `device-fp` 的 platform 也跟着 client_type 变

| 端 | `getExtList?platform=` |
|---|---|
| PC | 22 |
| iOS | 21 |
| Android | 20 |
| WebTouch | 24 |

不是固定值。

---

## 20. `listPingServer` 的 `ext_data` / `getNodesInfo` 的 `node` 都是 JSON 字符串

**症状**：传对象被服务端拒。

```json
{"biz_key":"hk4e_cn","ext_data":"{\"platform\":18}"}       ← 字符串
{"biz_key":"hk4e_cn","node":"{\"bandwidth\":0,...}","speed_client_type":8}
```

注意双重转义。`node` 里的 `ping_results[].rtt` 就是你测出来的值。
