# 账号认证登录（login-platform）

这是**账号本身**的登录（账号密码 / 手机验证码 / 扫码），和游戏侧的 combo 登录是两件事：

| | 账号认证登录 | 游戏侧 combo 登录 |
|---|---|---|
| 目的 | 证明"你是这个米哈游账号" | 换取"这个账号可以玩的云游戏票据" |
| 域名 | `passport-api.mihoyo.com` | `hk4e-sdk.mihoyo.com` |
| 产物 | 一组 cookie（ltoken / cookie_token / account_id …） | `open_id` + `combo_token` |
| 本文档 | ← | 见 [`api.md`](./api.md) §1–§2 |

云·原神页面（`ys.mihoyo.com/cloud/`）本身**没有**登录表单，它是把一个 iframe 挂到
`https://user.mihoyo.com/login-platform/index.html`，登录成功后由 iframe `postMessage`
把 `{userInfo, loginType, newUser, ticket}` 回传给父页，父页再去跑 combo 登录。

---

## 1. 入口与跳转

```
GET https://passport-api.mihoyo.com/account/ma-cn-session/web/crossLoginStart?dest=<urlencoded>
→ 302 Location: <dest>
```

实测 `dest=https://user.mihoyo.com/login-platform/index.html` 时直接 302 回该地址（未登录态）。
这就是"点登录"时页面跳去登录页的真实入口。

登录页 HTML 里加载的 bundle：

```
js/chunk-vendors.b0b1cdc8.js   579948B
js/web.2c4e013c.js              72560B   ← webpack runtime + 请求封装
js/5823.9f588959.js             62353B   ← 错误码枚举 / RSA 模块 38625 / 请求封装 16280
js/9861.795a3278.js             33786B   ← h5log
js/login.35d0ab6d.js           202779B   ← PC 登录路由（端点全集在这里）
js/m-login.7967d4b7.js         109720B   ← 移动版登录
js/m-login-qr.287f0dfe.js       12581B
js/security-verification.6811555b.js 727280B
```

另有外部脚本：
`webstatic.mihoyo.com/dora/biz/{mihoyo-analysis/v2,mihoyo-h5log/v1.0,mihoyo-account-sdk-bridge}/main.js`、
`webstatic.mihoyo.com/dora/lib/geetest/v4/gt4.js`（极验 v4）、`dora/lib/sentry-lazy/1.3.0`。

## 2. 路由（hash 路由）

| 路由 | 常量 | 说明 |
|---|---|---|
| `#/login` | `LOGIN` | 登录首页（选登录方式） |
| `#/login/password` | `PASSWORD_LOGIN` | 账号密码 |
| `#/login/captcha` | `CAPTCHA_LOGIN` | 手机验证码 |
| `#/social` | `BIND_SOCIAL` | 第三方绑定 |
| `#/password/change` | | 改密 |
| `#/account/find` | `FORGET_PASSWORD` | 找回密码 |
| `#/bind/mobile` / `#/email/bind` | | 绑定手机 / 邮箱 |
| `#/realname/info` / `#/bind/realname` / `#/rebind/realname` | | 实名 |
| `#/security-verification` | | 安全验证（极验 / 人脸） |
| `#/game-user-center` / `#/user-center` | | 用户中心 |
| `#/account/activity` / `#/account/help` | | 活动 / 帮助 |

## 3. 基址常量

`js/login.35d0ab6d.js` 里写死：

```js
const c = {
  passport: "/account/ma-cn-passport/passport",
  web:      "/account/ma-cn-passport/web",
  session:  "/account/ma-cn-session/web",
};
```

axios 实例（`js/5823.9f588959.js` 模块 16280）：

```js
const O = {
  PASSPORT:      "https://passport-api.mihoyo.com",
  PASSPORT_AUTH: "https://passport-api.mihoyo.com",
  STATIC:        "https://passport-api-static.mihoyo.com",
  COMBO:         "https://api-sdk.mihoyo.com",
  BOX:           "https://sdk-static.mihoyo.com",
};
const P = axios.create({ baseURL: O.PASSPORT, timeout: 10000, withCredentials: true });
```

（`O.PASSPORT` 在非国服环境会被 `.replace("mihoyo.com", 域名后缀)` 改写。）

## 4. 公共请求头

请求拦截器逐字：

```js
e.headers = {
  "x-rpc-app_id":       app_id,        // 云·原神场景 = c76ync6mutq8
  "x-rpc-sdk_version":  sdk_version,   // "2.57.0"
  "x-rpc-game_biz":     game_biz,      // "hk4e_cn"
  "x-rpc-device_id":    device_id,     // uuid v4
  "x-rpc-device_fp":    device_fp,     // 13 位 hex，来自 device-fp/api/getFp
  "x-rpc-device_model": device_model,
  "x-rpc-device_name":  device_name,
  "x-rpc-device_os":    device_os,
  "x-rpc-client_type":  client_type,   // 云·原神场景 = 24 (CloudWebTouch) / 22 (CloudWebPC)
  "x-rpc-mi_referrer":  window.location.href,
  "x-rpc-lifecycle_id": lifecycle_id,
};
// app_version 非空时另加 x-rpc-app_version
// 内部 auto-test 开关打开时另加 x-rpc-auto_test: "true"
```

> 注意这里的 `client_type` 用的是**云客户端枚举**（`CloudWebTouch=24` / `CloudWebPC=22`），
> 不是 cloudgame 域那套 `WebTouch=18` / `WebPC=16`。同一个页面同时存在两套枚举，
> 详见 [`clients.md`](./clients.md)。

### 4.1 哪些 header 真的必填（实测消融）

对 `loginByPassword` 逐个删 header，看服务端反应：

| 删除的 header | 返回 | 结论 |
|---|---|---|
| （全带） | `-3208 账号或密码错误` | 正常 |
| `x-rpc-sdk_version` | `-3208` | 可省 |
| `x-rpc-game_biz` | `-3208` | 可省 |
| **`x-rpc-app_id`** | **`-3005 参数不合法`** | **必填，参与解密密钥选择** |
| `x-rpc-client_type` | `-3006 请求过于频繁` | 必填（风控维度） |
| `x-rpc-device_id` | `-3006` | 必填（风控维度） |
| `x-rpc-mi_referrer` | `-3006` | 必填（风控维度） |
| `x-rpc-lifecycle_id` | `-3006` | 必填（风控维度） |
| 只留 `content-type` | `-3005` | — |

## 5. 请求体加密（RSA-1024 / PKCS#1 v1.5）

**账号、密码、手机号、区号、身份证号、姓名** 在发给服务端之前都要先 RSA 加密成 base64。

模块 38625（`js/5823.9f588959.js` @14494）逐字：

```js
38625: function (e, t, n) {
  "use strict";
  var o = n(87257);
  const i = new o.Z({});
  i.setPublicKey("MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDvekdPMHN3AYhm/vktJT+YJr7\n"
    + "cI5DcsNKqdsx5DZX0gDuWFuIjzdwButrIYPNmRJ1G8ybDIF7oDW2eEpm5sMbL9zs\n"
    + "9ExXCdvqrn51qELbqj0XxtMTIpaCHFSI50PfPpTFV9Xt/hmyVwokoOXFlAEgCn+Q\n"
    + "CgGs52bFoYMtyi+xEQIDAQAB");
  t["Z"] = i;
}
```

- 模块 `87257`（在 `chunk-vendors.b0b1cdc8.js` @31622）是标准 **JSEncrypt + RSAKey**。
- 公钥是 X.509 SubjectPublicKeyInfo，模长 **1024 bit**，指数 65537。
- `encrypt()` → base64（172 字符，解出 128 字节）。
- 明文上限 `k - 11 = 117` 字节。

### 5.1 自己实现

`src/crypto.js` 是零依赖复刻（BigInt 模幂 + 手写 PKCS#1 v1.5 填充），Node 与浏览器通用。
之所以不用 `node:crypto` / WebCrypto：前者浏览器没有，后者只有 OAEP，padding 对不上。

```js
const { encrypt } = require("../src/crypto.js");
encrypt("someone@example.com"); // -> base64 (172 chars)
```

自检：`node src/test-crypto.js`
（与 `node:crypto` 的 `privateDecrypt(RSA_PKCS1_PADDING)` 互相验证 + 真实公钥参数与 `node:crypto` 的 JWK 比对）。

### 5.2 加密正确性的实测证据

用加密过的**不存在账号**打 `loginByPassword`：

```
account=encrypt("probe_not_exist_0001@example.com"), password=encrypt("WrongPassword123")
→ {"data":null,"message":"账号或密码错误","retcode":-3208}      ← 解密成功，走到了业务校验
```

同一份账号**不加密**：

```
→ {"data":null,"message":"参数不合法","retcode":-3001}          ← 服务端解不了
```

即 `-3208` 出现就说明 RSA 那一段是对的。

## 6. 端点总表

### 6.1 登录

| 方法 | 路径 | body | 备注 |
|---|---|---|---|
| POST | `/account/ma-cn-passport/web/loginByPassword` | `{account*, password*}` | `*` 需 RSA |
| POST | `/account/ma-cn-passport/web/loginByMobileCaptcha` | `{mobile*, area_code*, captcha}` | `*` 需 RSA；先发码 |
| POST | `/account/ma-cn-verifier/verifier/createLoginCaptcha` | `{mobile*, area_code*}` | 发短信，返回 `{sent_new, countdown, action_type}` |
| POST | `/account/ma-cn-passport/web/createQRLogin` | `{}` | 返回 `{url, ticket}`，**不加密** |
| POST | `/account/ma-cn-passport/web/queryQRLoginStatus` | `{ticket}` | 轮询，**不加密** |
| POST | `/account/ma-cn-passport/web/reactivateAccount` | `{action_ticket}` | 账号注销确认期内重新激活 |
| POST | `/account/ma-cn-passport/web/checkRiskVerified` | `{...}` | 风控二次校验 |

> `x-rpc-source: "v2.webLogin"`（模块 8612 常量 `F`）会随登录请求一起发，可用于打点区分。

### 6.2 会话 / 令牌

| 方法 | 路径 | body | 说明 |
|---|---|---|---|
| POST | `/account/ma-cn-session/web/verifyCookieToken` | 空 | 校验 cookie 里的 cookie_token |
| POST | `/account/ma-cn-session/web/verifyLtoken` | 空 | 校验 ltoken |
| POST | `/account/ma-cn-session/web/webVerifyForGame` | 空 | 云·原神真正用到的那个（返回 `user_info` + `token`） |
| POST | `/account/ma-cn-session/web/getWebTokensByAuthKey` | `{game_biz, authkey, authkey_ver}` | authkey → 一堆 web token |
| POST | `/account/ma-cn-session/web/logout` | 空 | 退出 |
| GET | `/account/ma-cn-session/web/crossLoginStart?dest=<url>` | — | 302 到登录页 |
| POST | `/account/binding/api/genAuthKeyByCookieToken` | `{game_biz, region, auth_appid, game_uid}` | cookie_token → authkey |

### 6.3 账号管理（都需要已登录的 cookie）

```
/account/ma-cn-passport/passport/addRealname        {realname*, identity_card*}   *需 RSA
/account/ma-cn-passport/passport/updateRealname     {realname*, identity_card*}   *需 RSA
/account/ma-cn-passport/passport/webGetUserRealnameInfo
/account/ma-cn-passport/passport/bindMobile         {mobile*, area_code*}         *需 RSA
/account/ma-cn-passport/passport/rebindMobile       {mobile*, area_code*}         *需 RSA
/account/ma-cn-passport/passport/bindEmail          {email}
/account/ma-cn-passport/passport/changePassword     {password*}                   *需 RSA
/account/ma-cn-passport/passport/forgetPassword     {password*}                   *需 RSA
/account/ma-cn-passport/passport/lockAccount
/account/ma-cn-passport/passport/unlockAccount
/account/ma-cn-passport/passport/deleteAccount
/account/ma-cn-passport/passport/deleteBizAccount
/account/ma-cn-passport/passport/checkCanDeleteAccountByActionTicket
/account/ma-cn-passport/passport/checkCanDeleteBizAccount
/account/ma-cn-passport/passport/clearGameCtrl
/account/ma-cn-passport/passport/getActionLogs
/account/ma-cn-passport/passport/getBindingProductInfo
/account/ma-cn-passport/passport/getSwitchStatus     （走 STATIC 域，GET，免鉴权）
/account/ma-cn-passport/passport/markRiskAction
/account/ma-cn-passport/passport/reactivateBizAccount
/account/ma-cn-passport/passport/unbindThirdparty
```

### 6.4 ActionTicket / 验证码

```
POST /account/ma-cn-verifier/verifier/createActionTicketByAccount
POST /account/ma-cn-verifier/verifier/createActionTicketByCookieToken
POST /account/ma-cn-verifier/verifier/createActionTicketByLtoken
GET  /account/ma-cn-verifier/verifier/getActionTicketInfo
POST /account/ma-cn-verifier/verifier/createMobileCaptcha
POST /account/ma-cn-verifier/verifier/createEmailCaptchaByActionTicket
POST /account/ma-cn-verifier/verifier/createMobileCaptchaByActionTicket
POST /account/ma-cn-verifier/verifier/modifyActionTicketVerifyMethod
POST /account/ma-cn-verifier/verifier/verifyActionTicketPartly
POST /common/aigis/api/checkSmartCaptcha
POST /common/aigis/api/createBySmartCaptchaTicket
```

## 7. 实测响应样例（全部为不存在账号，脱敏）

### 7.1 密码登录成功解密、业务失败

```http
POST /account/ma-cn-passport/web/loginByPassword
{"account":"<rsa-b64>","password":"<rsa-b64>"}

{"data":null,"message":"账号或密码错误","retcode":-3208}
```

### 7.2 发短信

```http
POST /account/ma-cn-verifier/verifier/createLoginCaptcha
{"mobile":"<rsa-b64>","area_code":"<rsa-b64>"}

{"retcode":0,"message":"OK","data":{"sent_new":true,"countdown":60,"action_type":"regist_by_mobile_captcha"}}
```

- 号码格式非法（如 `10000000000`）→ `{"message":"手机号格式错误","retcode":-3008}`。
- 合法号段但未注册的账号 → `action_type: "regist_by_mobile_captcha"`（走注册流程，**会真的发短信**）。
- 已注册账号 → `action_type: "login_by_mobile_captcha"`（推导值，未实测）。

### 7.3 验证码登录（假验证码）

```http
{"data":null,"message":"验证码已失效，请重新获取","retcode":-3209}
```

### 7.4 扫码

```http
POST /account/ma-cn-passport/web/createQRLogin
{}

{"retcode":0,"message":"OK","data":{
  "url":"https://user.mihoyo.com/login-platform/mobile.html?expire=1793869811&tk=<uuid>&token_types=4#/login/qr",
  "ticket":"<uuid>"
}}
```

```http
POST /account/ma-cn-passport/web/queryQRLoginStatus
{"ticket":"<uuid>"}

{"retcode":0,"message":"OK","data":{
  "status":"Created",
  "app_id":"c76ync6mutq8",
  "client_type":24,
  "created_at":"1793869705",
  "scanned_at":"0",
  "tokens":[],
  "user_info":null,
  "realname_info":null,
  "need_realperson":false,
  "ext":"",
  "scan_game_biz":""
}}
```

- `status` 三态：`Created` → `Scanned` → `Confirmed`。
- 前端轮询间隔 **2000 ms**；`Confirmed` 时 `data.tokens` / `data.user_info` 才有值。
- `token_types=4` 出现在扫码 URL 里，含义未确定（推测是"要哪几种 token"的位掩码）。

### 7.5 未登录时打会话接口

```http
POST /account/ma-cn-session/web/verifyCookieToken
POST /account/ma-cn-session/web/verifyLtoken
POST /account/ma-cn-session/web/webVerifyForGame

{"data":null,"message":"登录状态失效，请重新登录","retcode":-100}
```

`POST /account/ma-cn-passport/web/webGetUserInfoForGame` → **404 page not found**
（这个路径在 SDK 字符串里有，但线上 passport-api 不提供；云·原神用的是
`ma-cn-session/web/webVerifyForGame`）。

## 8. 极验（geetest v4）风控

响应拦截器里，当 `retcode === -3101 (NeedAigis)`：

1. 读响应头 `x-rpc-aigis`，值是 JSON：`{"session_id": "...", "data": "<json string>"}`；
2. 用 `webstatic.mihoyo.com/dora/lib/geetest/v4/gt4.js` 的 `initGeetest4({captchaId: gt, riskType, userInfo: JSON.stringify({session_id})})` 弹验证；
3. 验证通过后，把 `x-rpc-aigis: "<session_id>;<base64(gt_result_json)>"` 加回请求头重放**同一个**请求。

另有 `case 0` 直接信任 ticket（`POST /common/aigis/api/checkSmartCaptcha {ticket}`），
`case 1` 走二次校验 `checkSmartCaptcha {ticket, check_data: btoa(json)}`。

## 9. 错误码

客户端本地（`iX`）：

| 常量 | 值 |
|---|---|
| `SystemError` | -100000 |
| `Timeout` | -100001 |
| `UserCancel` | -100002 |
| `CommunityInitFail` | -100004 |
| `InvalidParameter` | -100006 |
| `NetWorkError` | -100007 |
| `BrowserUnSupport` | -100008 |

服务端（`yR`）：

| 常量 | 值 | 文案 |
|---|---|---|
| `TokenInvalid` | -100 | 登录状态失效，请重新登录 |
| `RealnameActionTicketInvalid` | -276 | |
| `ActionTicketInvalid` | -3003 | |
| `RequestFrequencyLimit` | -3006 | 请求过于频繁，请稍后再试 |
| `NeedAigis` | -3101 | （触发极验） |
| `AccountPwdLoginTryTooMuch` | -3208 | 账号或密码错误 |
| `AccountRisky` | -3235 | |
| `AccountSafelyForbidden` | -3254 | 请修改密码后再登录 |
| `AccountSelfLoginRestriction` | -3257 | |
| `QRLoginExpired` | -3501 | |
| `QRLoginDeviceInconsistent` | -3503 | |
| `QRLoginUserInconsistent` | -3504 | |
| `QRLoginUserCanceled` | -3505 | |
| `QRLoginRisky` | -3506 | |
| `AccountLocked` | -4400 | |
| `AccountNotInGameCtrl` | -3294 | |
| `AccountForbidden` | -3201 | |
| `ThirdPartyAccessTokenInvalid` | -3302 | |
| `ThirdPartyNotRegister` | -3304 | |

实测补充（枚举里没有、但服务端会返回）：

| 值 | message | 场景 |
|---|---|---|
| -3001 | 参数不合法 | body 没加密 / 字段缺失 |
| -3002 | 账号格式错误 | 明文账号被当成密文解析失败 |
| -3005 | 参数不合法 | 缺 `x-rpc-app_id` |
| -3008 | 手机号格式错误 | |
| -3209 | 验证码已失效，请重新获取 | |
| -502 | Something went wrong...please retry later | `getWebTokensByAuthKey` 传假 authkey |

> `-3208` 的枚举名是 `AccountPwdLoginTryTooMuch`（"密码错误次数过多"），
> 但实测**首次**输错密码就返回 `-3208` + "账号或密码错误"。
> 前端计数逻辑是：连续 3 次 `-3208` 就弹"忘记密码"。

## 10. token 落盘方式

**重要：前端代码里没有一行"把 token 写进 cookie"。**

- 搜遍 `login.35d0ab6d.js` / `web.2c4e013c.js` / `9861.795a3278.js` / `account-sdk.js`，
  只有读取：`account_id` / `account_id_v2` / `ltuid` / `ltuid_v2`（h5log 打点用）。
- 全仓库搜不到 `ltoken_v2` / `cookie_token_v2` / `stoken_v2` / `token_types` 这些字面量。
- 登录成功回调只是把 `{userInfo, loginType, newUser, ticket}` postMessage 回父窗口。

→ **结论：token cookie 全部由服务端通过 `Set-Cookie` 下发**
（在 `loginByPassword` / `loginByMobileCaptcha` / `queryQRLoginStatus` 返回 `Confirmed` 时）。
`createLoginCaptcha` 这类未登录态接口只下发 `aliyungf_tc`（阿里云 WAF 的 cookie）。

因此在重封装时，只要保持 cookie jar（`withCredentials` / 自己维护 cookie 容器），
后续 `webVerifyForGame`、`webLogin`、`paasDispatch` 都能直接复用同一份 cookie，
不需要手工拼 `ltoken` 之类的值。

## 11. 完整调用顺序

```
① 账号认证（本文档）
   crossLoginStart（可选，只为拿跳转）
   → loginByPassword / (createLoginCaptcha → loginByMobileCaptcha) / (createQRLogin → 轮询 queryQRLoginStatus)
   → 服务端 Set-Cookie 下发 token cookie
   → 可选：verifyCookieToken / verifyLtoken 自检

② 游戏侧 combo 登录（api.md §1–§2）
   webVerifyForGame  → user_info + token
   webLogin          → open_id + combo_token
   组装 x-rpc-combo_token: ai=4;ci=1;oi=..;ct=..;si=<HMAC>;bi=hk4e_cn

③ 调度 → 游玩窗口（protocol.md / webrtc.md）
```

## 12. 未验证 / 待补

1. **登录成功后 `Set-Cookie` 的确切 cookie 名与有效期**——需要一次真实成功登录才能抓
   （本文所有实测都用了不存在账号，故只能确认"未登录态"的响应）。
2. `loginByPassword` 的响应体在成功时除了 cookie 是否还带 `user_info` / `ticket`（推测有，与扫码一致）。
3. `createLoginCaptcha` 已注册账号的 `action_type` 取值（推测 `login_by_mobile_captcha`）。
4. 极验 `-3101` 的完整重放流程（需要真的触发风控，未刻意构造）。
5. `checkRiskVerified` 的 body 结构只在 `security-verification` chunk 里出现，未逐字段解析。
