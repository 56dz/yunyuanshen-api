# HTTP 接口参考

基线：`hk4e_cn` / 前端 `7.2.0` / `cg-sdk 6.1.0.65`（2026-10）。
所有 `retcode == 0` 表示成功，`message` 通常为 `"OK"`。

> 本文覆盖**登录取票之后**的接口（从 `passport-api` 的 `webVerifyForGame` 起）。
> **账号登录**（账号密码 / 手机验证码 / 扫码）走另一套 `passport-api` 端点，
> 请求体需要 RSA 加密，见 [account.md](account.md)。

通用约定：

- `api-cloudgame.mihoyo.com/hk4e_cg_cn` 下的接口**全部需要** `x-rpc-combo_token`（见下）。
- `axios` 配了 `withCredentials: true`，因此 cookie 也会带上。
- 响应头含 `x-powered-by: takumi`、`access-control-expose-headers: X-Rpc-Aigis, X-Trace-Id`、
  `vary: Origin`，`access-control-allow-origin` 回显 `https://ys.mihoyo.com`
  （按 Origin 白名单，非通配）。

---

## 0. 公共请求头

### 0.1 cloudgame 域（`api-cloudgame.mihoyo.com/hk4e_cg_cn/*`）

```
x-rpc-client_type   16(WebPC) | 18(WebTouch) | 17(WebMac) | 19(WebKeyboard) | 14(WebAndroid) | 15(WebIos)
x-rpc-app_version   7.2.0
x-rpc-sys_version   Windows 10 / iOS 17.0 / BlackBerry undefined
x-rpc-channel       mihoyo
x-rpc-device_id     <uuid v4>
x-rpc-device_name   <设备名，UA 推导>
x-rpc-device_model  <机型，UA 推导>
x-rpc-vendor_id     2
x-rpc-cg_game_biz   hk4e_cn
x-rpc-op_biz        clgm_cn
x-rpc-language      zh-cn
x-rpc-cps           pc_mihoyo | ios_mihoyo | android_mihoyo | touch_mihoyo
x-rpc-app_id        4
x-rpc-combo_token   ai=4;ci=1;oi=..;ct=..;si=..;bi=hk4e_cn
```

> 灰度开关 `ugcDeeplinkHeaderFlag` 为真时，`WalletGet` 与 `PaasDispatch` 还会多一个
> `x-rpc-cg_ugc_hoyolink: 1`。

源码：`web.*.js` 模块 60681（PC）/ `m/js/web.*.js` 同名模块（触摸），两者逐字一致。

### 0.2 combo / passport 域

```
x-rpc-app_id        c76ync6mutq8        (webVerifyForGame)
x-rpc-sdk_version   2.50.1              (webVerifyForGame)
x-rpc-lifecycle_id  <随机 10 位 hex>     (webVerifyForGame)
x-rpc-mi_referrer   https://ys.mihoyo.com/cloud/#/  或  .../cloud/m/#/
x-rpc-client_type   22(PC) | 24(WebTouch) | 20(CloudWebAndroid) | 21(CloudWebIOS)
x-rpc-game_biz      hk4e_cn
x-rpc-mdk_version   2.57.0              (webLogin)
x-rpc-channel_id    1                   (webLogin)
x-rpc-device_fp     <指纹>
x-rpc-device_os     Windows 10 | Android 13 | Device Software 7.1.0.346
```

> **注意两套枚举**：combo/passport 用 `n.CloudWeb*`（22/23/24/25/20/21），
> cloudgame 用 `k.Web*`（16/17/18/19/14/15）。同一页面里数值不同。

---

## 1. `POST /account/ma-cn-session/web/webVerifyForGame`

`https://passport-api.mihoyo.com/account/ma-cn-session/web/webVerifyForGame`

建立/校验米哈游通行证会话。**空 body**。

响应（触摸端实测，**下面所有值已替换为占位符**）：

```json
{"retcode":0,"message":"OK","data":{
  "user_info":{"aid":"<aid>","mid":"<mid>_mhy","account_name":"",
    "email":"<masked>@example.com","is_email_verify":1,"area_code":"+86",
    "mobile":"<masked>","realname":"<masked>","identity_code":"<masked>",
    "is_adult":1,"country":"",...},
  "token":"<redacted>",
  "realname_info":{"required":false,"action_type":"","action_ticket":""},
  "need_realperson":false}}
```

- `aid` 就是后面 `cmd_line` 里的 `-aid`、以及 combo token 的 `oi`（open_id）。
- 响应同时 `set-cookie`（`ltoken`/`ltuid`/`cookie_token` 等），**这是后续所有 cloudgame 接口的凭据**。
- `token` 字段在导出抓包里被工具自动脱敏为 `[redacted]`，实际值用于 cookie。

---

## 2. `POST /hk4e_cn/combo/granter/login/webLogin`

`https://hk4e-sdk.mihoyo.com/hk4e_cn/combo/granter/login/webLogin`

**这是"登录接口"的核心。**

请求：

```http
Content-Type: application/json
{"app_id":4,"channel_id":1}
```

响应：

```json
{"retcode":0,"message":"OK","data":{
  "combo_id":"0",
  "open_id":"<open_id>",
  "combo_token":"v2_<hex>",
  "data":"{\"guest\":false,\"age_status\":2}",
  "heartbeat":false,
  "account_type":1,
  "fatigue_remind":{"nickname":"旅行者","reset_point":14400,"durations":[180,240,300]}}}
```

- `combo_token` 以 `v2_` 开头，长度约 47。
- `fatigue_remind.durations` = `[180,240,300]` 秒，是防沉迷提醒节点。
- 依赖 passport 域的 cookie，裸调返回非 0。

### 2.1 组装 `x-rpc-combo_token`

```js
const c = { app_id, channel_id, open_id, combo_token };
const si = HMAC_SHA256(sortedKV(c), 'd0d3a7342df2026a70f650b907800111');
const header = `ai=${app_id};ci=${channel_id};oi=${open_id};ct=${combo_token};si=${si};bi=hk4e_cn`;
```

签名原文（字典序 `app_id < channel_id < combo_token < open_id`）：

```
app_id=4&channel_id=1&combo_token=v2_<hex>&open_id=<open_id>
```

线上形态：

```
ai=4;ci=1;oi=<open_id>;ct=v2_<hex>;si=<hmac>;bi=hk4e_cn
```

六段顺序固定，`si` 只签前 4 个字段（不含 `bi`）。

可复现的占位值示例（`open_id=100000001`、`combo_token=v2_0123456789abcdef0123456789abcdef01234567`）：

```
si = c3cfb041cd387fde2a35c075b8689d6cb8c0f33ef01cf11d95767ae7afc585c0
```

用错 key 会得到完全不同的 64 位 hex，这是排查时最快的判据 —— 详见 [pitfalls.md §2](./pitfalls.md#2-两个不同的-hmac-app_key)。

可执行：`node src/sign.js` → `combo_token MATCH: true`。

---

## 3. `POST /hk4e_cg_cn/gamer/api/login`

`https://api-cloudgame.mihoyo.com/hk4e_cg_cn/gamer/api/login`

空 body，带完整 `x-rpc-*`（含 `x-rpc-combo_token`）。

```json
{"retcode":0,"message":"OK","data":{"new_user":false}}
```

作用只是让服务端建立 session 并 `set-cookie`。**必须在调度前调用。**

---

## 4. `GET /hk4e_cg_cn/wallet/wallet/get`

可选 query：`?cost_method=0`

```json
{"retcode":0,"message":"OK","data":{
  "coin":{"coin_num":"0","free_coin_num":"0","coin_limit":"150000","exchange":"10"},
  "free_time":{"send_freetime":"0","free_time":"31","free_time_limit":"600","over_freetime":"0"},
  "status":{"status":0,"msg":"","total_time_status":0,"status_new":0},
  "total_time":"31",
  "stat":{"vip_point":"500"},
  "play_card":{"expire":"0","msg":"未开通，开通可额外享受限时免费畅玩","short_msg":"未开通",
    "play_card_limit":"180","remaining_sec":"0","play_card_tag":"PLAYCARD_UNKNOWN"}}}
```

| 字段 | 含义 |
|---|---|
| `free_time` | 剩余免费时长（分钟） |
| `free_time_limit` | 免费时长上限（分钟，600 = 10 小时） |
| `total_time` | 总可用时长（分钟） |
| `coin.coin_num` | 原点数量 |
| `play_card.remaining_sec` | 畅玩卡剩余秒数 |

**余额不足时的调度错误码**：`INSUFF_GAME_TIME=-110003`、`INSUFF_COIN=-110008`。

---

## 5. `GET /hk4e_cn/cg/gamer/api/fetchCompatibilityConfig`

`https://api-cloudgame-static.mihoyo.com/hk4e_cn/cg/gamer/api/fetchCompatibilityConfig?cg_game_biz=hk4e_cn`

约 6.9KB，返回画质档位/编码/设备的兼容性矩阵。**静态站，不需要鉴权头**。

## 6. `GET /hk4e_cn/cg/gamer/api/getFunctionShieldNew`

`https://api-cloudgame-static.mihoyo.com/hk4e_cn/cg/gamer/api/getFunctionShieldNew?cg_game_biz=hk4e_cn&client_type=18`

按客户端版本返回功能屏蔽位（哪些功能对该 client_type 关闭）。`client_type` 用 cloudgame 枚举。

## 7. `GET /hk4e_cg_cn/gamer/api/getUIConfig`

`https://api-cloudgame.mihoyo.com/hk4e_cg_cn/gamer/api/getUIConfig?height=1029&width=1646`
（触摸端还会用 `?all=true`）

返回启动页背景图 URL（`images.super_large/large/middle/long`）、按钮文案、活动图等。

## 8. `GET /hk4e_cg_cn/gamer/api/getSpeedLimitConfig`

`?speed_client_type=7`（Web）或 `8`（Mobile / Touch）

```json
{"retcode":0,"message":"OK","data":{
  "list":[
    {"name":"超高清","id":"0","top":9000,"bottom":3500,"name_i18n":"floatingBall_pictureQuality_UHD"},
    {"name":"高清","id":"1","top":4800,"bottom":2000,...},
    {"name":"标清","id":"2","top":3200,"bottom":1500,...},
    {"name":"低清","id":"3","top":1800,"bottom":1200,...},
    {"name":"极低清","id":"4","top":1200,"bottom":1000,...}],
  "default_gear":0,"fluent_bottom":1000}}
```

**`bit_rate = 1024 * top`**。`top=9000` → `9216000`（触摸端实测就是这个值）。
PC 实测 `13312000` 对应 `top=13000`，来自用户画质设置覆盖（不在这个列表里）。

## 9. `GET /hk4e_cg_cn/gamer/api/getQueueNewsList`

`?news_type%5B%5D=5`

```json
{"retcode":0,"message":"OK","data":{"rows":[],"store_page":null,"cloud_web_news":null}}
```

排队页文案，与调度无关。

## 10. `GET /hk4e_cg_cn/gamer/api/listNotifications`

`?status=NotificationStatusUnread&type=NotificationTypePopup&is_sort=true`

弹窗通知。`POST /gamer/api/ackNotification` 确认。

## 11. 公告

`https://hk4e-ann-api.mihoyo.com/common/clgm_cn/announcement/api/getAlertAnn`

```
?bundle_id=hk4e_cn_webpc&platform=pc&region=cg_cn&game=clgm&game_biz=clgm_cn&lang=zh-cn&uid=<aid>&level=10
```

触摸端：`bundle_id=hk4e_cn_webtouch&platform=android`。

---

## 12. 配置下发（静态站，无鉴权）

| 用途 | URL |
|---|---|
| combo 全局配置 | `https://sdk-static.mihoyo.com/hk4e_cn/combo/granter/api/getConfig?app_id=4&channel_id=1&client_type=3` |
| 云原神盒子配置 | `https://sdk-static.mihoyo.com/combo/box/api/config/cloud_ys/cloud_config?cloud_config=config`（19KB） |
| SDK combo 配置 | `https://sdk-static.mihoyo.com/combo/box/api/config/sdk/combo?biz_key=hk4e_cn&client_type=3` |
| 前端版本 | `https://webstatic.mihoyo.com/common/clgm-web-app/ys/VERSION.txt` → `7.2.0` |

## 13. 设备指纹（`public-data-api.mihoyo.com`）

```
GET  /device-fp/api/getExtList?platform=24[&app_name=hk4e_cn]
POST /device-fp/api/getFp          body ~1.3KB → resp ~87B
```

`platform` 取值：`22`=PC、`21`=iOS、`20`=Android、`24`=WebTouch。

结果即 `x-rpc-device_fp`（实测是 13 位十六进制短串）。

---

## 14. 微信 JSSDK 签名（触摸端，可选）

`https://api.mihoyo.com/weixin_api/get/signature?appid=wx9ca7bd514654fc77`

触摸端为支持"分享到微信"而拉取，与登录/游玩无关。

---

## 15. 错误码

| 常量 | 值 | 含义 |
|---|---|---|
| `TOKEN_INVALID` | -100 | combo token 失效，需重新 `webLogin` |
| `FREQUENT_LOGIN` | -100003 | 登录过于频繁 |
| `BLACK_LIST` | -100004 | 黑名单 |
| `WHITE_LIST` | -100002 | 未在白名单 |
| `INSUFF_GAME_TIME` | -110003 | 游戏时长不足 |
| `INSUFF_COIN` | -110008 | 原点不足 |
| `APP_MAINTAIN` | -104999 | 应用维护中 |

`start_game_failed_retry_error_codes` 默认 `[-1019, -1011, -1020]`，命中后前端会自动重试一次调度。
