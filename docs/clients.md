# 客户端类型矩阵

云原神用**两套并行的 client_type 枚举**，同一个页面里数值不同。搞混是重封装时最常见的坑。

---

## 1. 两套枚举

### 1.1 cloudgame 域用的（`x-rpc-client_type` on `api-cloudgame.mihoyo.com`）

来自 `cg-sdk` 导出别名 `T()` / `jl()`，即 `n.Web*`：

| 名称 | 值 | 页面 |
|---|---|---|
| `WebPC` | **16** | 桌面 Windows |
| `WebMac` | **17** | 桌面 macOS |
| `WebKeyboard` | **19** | 其它桌面（Linux 等） |
| `WebTouch` | **18** | 非 android/ios 的移动端 |
| `WebAndroid` | **14** | Android 浏览器 |
| `WebIos` | **15** | iOS 浏览器 |

### 1.2 combo / passport 域用的（`x-rpc-client_type` on `hk4e-sdk` / `passport-api`）

来自导出别名 `E()`，即 `n.CloudWeb*`：

| 名称 | 值 |
|---|---|
| `CloudWebAndroid` | **20** |
| `CloudWebIOS` | **21** |
| `CloudWebPC` | **22** |
| `CloudWebMac` | **23** |
| `CloudWebTouch` | **24** |
| `CloudWebKeyboard` | **25** |

> **实测对照**：PC 端 `webLogin` 发 `x-rpc-client_type: 22`（`CloudWebPC`），
> 而同一会话的 `paasDispatch` 发 `16`（`WebPC`）。
> 触摸端 `webLogin` 发 `24`（`CloudWebTouch`），`paasDispatch` 发 `18`（`WebTouch`）。

---

## 2. 判定链（源码原文）

`m/js/web.d164e86d.js` 模块 26975 @112949（PC 版 `js/web.103b867a.js` 同模块 @120611）：

```js
function v() {
  if (i.A.desktop()) {                    // mobile-detect 的 desktop()
    if (d()) return r.WebPC;              // isWindows
    if (u()) return r.WebMac;             // isMac
    if (p()) return r.WebKeyboard;
  }
  return g() ? r.WebAndroid               // android()
       : m() ? r.WebIos                   // ios() || ipad()
       : f() ? r.WebTouch                 // getDeviceType()==='mobile' && !android && !ios
       : l.value ? l.value                // localStorage 里的平台选择
       : s.ye ? r.WebTouch : r.WebKeyboard;  // ye 是编译期常量，线上 false
}
```

配套映射：

```js
const k = { [WebPC]:16, [WebMac]:17, [WebKeyboard]:19, [WebAndroid]:14, [WebIos]:15, [WebTouch]:18 };
const S = { [WebPC]:7, [WebMac]:7, [WebKeyboard]:7, [WebAndroid]:8, [WebIos]:8, [WebTouch]:8 };
//        ↑ N()/KV() = speed_client_type

const B = { [WebPC]:'pc', [WebMac]:'mac', [WebKeyboard]:'keyboard',
            [WebAndroid]:'android', [WebIos]:'ios', [WebTouch]:'touch' };   // P()/Df()

const D = { [WebPC]:'pc', [WebMac]:'mac', [WebKeyboard]:'pc',
            [WebAndroid]:'android', [WebIos]:'ios', [WebTouch]:'android' }; // pj()
```

---

## 3. 实测矩阵

| 环境 | cloudgame `x-rpc-client_type` | combo `x-rpc-client_type` | `speed_client_type` | `x-rpc-cps` | `getExtList` platform | 公告 `bundle_id` / `platform` | 分辨率档位 |
|---|---|---|---|---|---|---|---|
| **Windows PC** | **16** | **22** | **7** | `pc_mihoyo` | **22** | `hk4e_cn_webpc` / `pc` | `pc` |
| **iPhone UA** | **15** | **21** | 8 | `ios_mihoyo` | **21** | `hk4e_cn_webpc` / `pc` | `ios` |
| **Android UA** | **14** | **20** | 8 | `android_mihoyo` | **20** | `hk4e_cn_webpc` / `pc` | `android` |
| **WebTouch** | **18** | **24** | **8** | `touch_mihoyo` | **24** | `hk4e_cn_webtouch` / `android` | `touch` |

前两列、`speed_client_type`、`x-rpc-cps`、`getExtList platform`、公告 `bundle_id`
均为**实测值**（抓包验证）。

---

## 4. 如何复现 WebTouch（实测方案）

在 Windows Chrome 里用 DevTools 模拟手机时，`navigator.platform` 恒为 `"Win32"`，
`navigator.userAgentData.mobile` 恒为 `false`，所以 `desktop()` 一直为真。
但只要 UA 里带 `Android` 或 `iPhone`，就会先命中 `g()` 或 `m()`。

**唯一能落到 `f()`（WebTouch）的路径**：UA 是 mobile 但既不含 android 也不含 ios。
实测可行的是 **BlackBerry 9900**：

```
Mozilla/5.0 (BlackBerry; U; BlackBerry 9900; en) AppleWebKit/534.11+ (KHTML, like Gecko) Version/7.1.0.346 Mobile Safari/534.11+
```

`mobile-detect` 的 `mobile()` 命中 `blackberryPhone` / `othersMobile`，
`android()` 与 `ios()` 都为假 → `f()` 为真 → **`WebTouch`**。

> ⚠️ 用 `bsk emulate` 时，emulation 必须在**页面 reload 之前**生效。
> 先开页再 emulate 的话，页面已经按旧 UA 初始化完毕，请求头不会变。
> 正确顺序：`emulate → reload`。

HarmonyOS UA（`Mozilla/5.0 (Mobile; Linux; HarmonyOS 4.0; FRT-AL00) ...`）实测**不行** ——
reload 后页面停在旧状态，没有重新走登录链。

---

## 5. 平台选择弹窗

触摸版有"键盘 / 触摸"二选一弹窗：

```js
Ce = { KeyBoard: 1, Touch: 2 };
Ie = ref(ke.ye ? WebTouch : WebKeyboard);   // ye 线上 = false → 默认 KeyBoard

// 确认时
V.O2();
Z.D.playerWebPlatChoose(Ie.value === WebTouch ? Ce.Touch : Ce.KeyBoard);
```

DOM：`.plat-choose-dialog`，两个 radio `#clg-client-choose-keyboard` / `#clg-client-choose-touch`。

因为 `ye = false`，这个弹窗**永远只能选到 WebKeyboard**，无法通过 UI 得到 WebTouch。
所以重封装时若要 WebTouch，只能自己设 header，不要指望 UI。

---

## 6. 不同 client_type 带来的服务端差异

| 差异点 | 表现 |
|---|---|
| `bit_rate` | 由 `getSpeedLimitConfig` 的 `top` 决定，而 `speed_client_type` 影响返回哪一套档位 |
| `resolution` | 触摸版 2532x1170（横向），PC 1920x1080 |
| `user_data.dpi` | 触摸版 480，PC 96 |
| `getFunctionShieldNew` | 按 `client_type` 返回不同功能屏蔽位 |
| 公告 | `bundle_id` / `platform` 不同 |
| `cmd_line` 回填 | 含 `-user_screen_dpi/-user_screen_width/-user_screen_height/-user_system_language` |

**结论**：`client_type` 只影响 HTTP 层的策略选择，**不影响 RTC/输入协议** ——
`cg-sdk` 在两端的 MD5 完全相同（`67ec38a4123455bc9d0e68508299a1bd`）。

---

## 7. 其它值（仅静态推导，未实测）

| 名称 | cloudgame | combo |
|---|---|---|
| `WebMac` | 17 | 23 |
| `WebKeyboard` | 19 | 25 |

这些值在代码里定义清晰，但没抓过真实流量。若你要做 macOS 版，按表填即可，
风险是服务端可能有额外的 UA 校验。

---

## 8. 相关 header 一览

| header | 取值来源 |
|---|---|
| `x-rpc-client_type` | 见上（两套） |
| `x-rpc-cps` | `pc_mihoyo` / `ios_mihoyo` / `android_mihoyo` / `touch_mihoyo` |
| `x-rpc-sys_version` | `Windows 10` / `iOS 17.0` / `Android 13` / `BlackBerry undefined` |
| `x-rpc-device_model` | `Unknown` / `iPhone` / `Chrome Mobile 120.0.0.0` |
| `x-rpc-device_name` | `Unknown` / `Apple iPhone` / `BlackBerry` |
| `x-rpc-device_os` | 仅 combo 域：`Windows 10` / `Android 13` / `Device Software 7.1.0.346` |
| `x-rpc-vendor_id` | 恒 `2` |
| `x-rpc-language` | `zh-cn` |
| `x-rpc-channel` | 恒 `mihoyo` |
