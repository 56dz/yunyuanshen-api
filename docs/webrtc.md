# WebRTC 建流

云原神的"游玩窗口"是 **WSS 信令 + WebRTC**，不是 HTTP 接口。理解这一点后，
重封装只需要三件事：连 WSS、按服务端的节奏走 SDP 协商、把 DataChannel 里的输入发出去。

---

## 1. 角色：客户端**不发** offer

这是最容易搞反的地方。常见 WebRTC 是 caller 发 offer，这里是**服务端发 offer**：

```
客户端                                    服务端
  │  WSS connect                             │
  │─────────────────────────────────────────▶│
  │  {"client_type":"web","type":"client hello"}  (type=3 帧)
  │─────────────────────────────────────────▶│
  │  {"type":"offer","sdp":"v=0..."}          │  (type=1 帧)
  │◀─────────────────────────────────────────│
  │  setRemoteDescription(offer)              │
  │  createAnswer() → setLocalDescription()   │
  │  {"sdp":"v=0...","type":"answer"}         │
  │─────────────────────────────────────────▶│
  │  {"candidate":"candidate:..","sdp-mid":..,"sdp-mline-index":..,"type":"candidates"}
  │◀────────────────────────────────────────▶│
```

- 本地 `onicecandidate` → 发 `{"candidate":..,"sdp-mid":..,"sdp-mline-index":..,"type":"candidates"}`
- 收服务端 candidate → `addIceCandidate`

源码：`class Ct`（AnswerSdpGenerator）@995642、`class Yt`（PeerConnection）@1039764。

---

## 2. ICE：地址被服务端改写

**没有 STUN，也没有 TURN。** 打洞靠的是把服务端给的 candidate 地址替换成
`sdk_param` 里的 `game_svr_addr`：

```js
// 收到 candidate 时
const lines = cand.split('\n').map((line) => {
  const cs = line.split(' ');
  if (cs.length < 6) return line;
  // UDP / TCP 且 sdpCandidateList 非空 → 替换 ip:port
  if ((isUdp(line) || isTcp(line)) && params.sdpCandidateList.length) {
    const { ip, port } = params.sdpCandidateList[0];
    cs[4] = ip;
    cs[5] = port;
  }
  return cs.join(' ');
});

// 注入来源：sdk_param 的 game_svr_addr / rtc_udp_port
rtcConnectionParams.sdpCandidateList = [
  { ip: gameSvrAddr.ip, port: sdkParam.getRtcUdpPort() },
];
```

例：

```
game_svr_addr = "157.255.56.100:44402"
rtc_udp_port  = 44403
```

即 **TCP 走 44402，UDP 打洞走 44403**。

---

## 3. SDP 后处理

`createAnswer()` 之后要按顺序做一串改写，任一失败都回退到原始 answer：

```js
try {
  setCodecPreferences();           // 选 H.264 / HEVC
  modifySdpToSatisfyCodecPayload();
  modifySdpForStereoAudio();
  modifySdpForRrtr();
  if (enableHevc && wrapped) modifySdpForWarppedHEVCPacketizationModeRaw();
} catch (e) {
  setFallbackOriginalAnswerSdp();  // 回到未改写的 answer
}
```

### 3.1 编码偏好

| 模式 | codec 列表 |
|---|---|
| `compatibleMode` | 只留 **H.264 Baseline** |
| 默认 | H.264 High / Main / Baseline |
| `enableHevc` | 上面再加 **H.265 (HEVC)** |

`ConnectionConfigurations` 里 `enableHevc` / `compatibleMode` / `enableWrappedHevc`
**互斥校验**：开了 wrapped HEVC 必须同时开 HEVC。

### 3.2 `encodedInsertableStreams`

只有启用 **wrapped HEVC** 时才这样建：

```js
new RTCPeerConnection({ encodedInsertableStreams: true });
```

此时 video track 不进 `<video>`，而是走 `HevcPipeline`：
`createEncodedStreams` → **WebCodecs** 解码 → 画到 `<canvas>`。

普通模式（触摸版实测走这条）就是：

```js
videoEl.srcObject = event.streams[0];
```

---

## 4. `ontrack` 分支

```js
pc.ontrack = (event) => {
  const track = event.track;
  if (track.kind === 'audio') {
    onAudioStream(event.streams[0]);
  } else if (track.kind === 'video') {
    if (config.enableWrappedHevc) hevcPipeline.start(event.streams[0]);
    else                          onVideoStream(event.streams[0]);
  }
};
```

实测结果（触摸版，`<video class="game-player__video">`）：

```
videoWidth / videoHeight = 2118 x 978     ← 服务端按实际编码降了，不是 2532x1170
paused = false
srcObject.getTracks() = [
  { kind: "audio", label: "remote audio", readyState: "live" },
  { kind: "video", label: "remote video", readyState: "live" }
]
```

PC 端实测 `videoWidth/Height = 1920x1080`。

> **DOM 里没有 `<canvas>`** —— 普通模式解码直接走 `<video>` 元素。
> 只有 wrapped HEVC 才有 canvas。

---

## 5. DataChannel

客户端**不创建** DataChannel：

```js
pc.ondatachannel = (event) => {
  dataChannel = event.channel;
  dataChannel.onmessage = (e) => handlePacket(e.data);
};
```

发送：

```js
const pkt = Packet.createPacket(20010, rtcDataChannelMsg);
rtcConnection.sendRtcData(pkt.toArrayBuffer());
```

报文格式见 [protocol.md §9](./protocol.md#9-datachannel-报文封装)。

---

## 6. GameControlChannel（可靠备用通道）

当 WSS 的 `game_control_channel_url`（`sdk_param` 字段 14，端口 `:5443`）可用时，
输入报文**优先走它**，不走 DataChannel：

```
gameControlChannel.valid() ? gameControlChannel.send(pkt.toUint8Array())
                           : rtcConnection.sendRtcData(pkt.toArrayBuffer())
```

实现细节：

- 优先 **WebTransport（HTTP/3）**，协议名重写为 `wtr` / `wtu`
- 失败回退 **WebSocket**
- URL 带 `?sessionId=<sid>` query
- WS 模式 `binaryType = "arraybuffer"`
- 有 ping/pong 与 `RtcKeepPlaying`（带 `game_token`）保活

**两者报文完全一致**，切换不影响上层。

---

## 7. 保活

| 机制 | 周期 | 内容 |
|---|---|---|
| WSS keepalive | 10s | 裸空帧 `websocket.send("")`（**无 8 字节头**） |
| GameControlChannel ping/pong | SDK 内部 | WebTransport / WS ping |
| `RtcKeepPlaying` | 随 GCC | 携带 `game_token`，防服务端判定掉线 |

---

## 8. 服务切换

`WebSessionInfo` 里有三组地址（联通 / 电信 / 移动）：

```js
serverWssUrlList = [game_server_wss_url, ...additional_game_server_wss_urls];
switchToNextServer() { index = (index + 1) % serverWssUrlList.length; }
```

`onConnectFailed` / `onDisconnected` 且非用户主动退出时，SDK 会自动
`switchToNextServer()` + `reconnectGameServer()`。

---

## 9. 完整时序（实测）

```
HTTP: login → getSpeedLimitConfig → statusCheck → listPingServer
    → [RTT 测速] → getNodesInfo → paasDispatch
        ↓ sdk_param (protobuf)
WSS: connect(wss://<game_server_wss_url>/rtc-sdk)
        ├─ send type=3  {"client_type":"web","type":"client hello"}
        ├─ recv type=1  {"type":"offer","sdp":...}
        ├─ send type=1  {"type":"answer","sdp":...}
        ├─ ⇄    type=1  candidates
        ├─ recv HTTP-ish DataChannel (ondatachannel)
        └─ 每 10s send ""（keepalive）
        ↓
    ontrack(audio) → onAudioStream
    ontrack(video) → onVideoStream → video.srcObject
        ↓
    输入：touch / mouse / keyboard → protobuf → Packet(20010) → GCC 或 DataChannel
```
