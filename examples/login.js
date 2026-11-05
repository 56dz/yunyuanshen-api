#!/usr/bin/env node
// 登录示例：从 cookie 走到 x-rpc-combo_token。
//
// 前置条件：你需要一份米哈游通行证的浏览器 Cookie（登录 ys.mihoyo.com 后从 DevTools
// 复制 document.cookie，或从 Application → Cookies 导出）。本项目不实现账号密码登录
// —— 那走的是 passport 域的另一套流程，不在本次逆向范围内。
//
// 用法：
//   MHY_COOKIE='ltuid_v2=...; ltoken_v2=...; cookie_token_v2=...' node examples/login.js
//
// 输出：JSON，含 open_id / combo_token / x-rpc-combo_token，可直接喂给 dispatch.js

'use strict';
const { buildComboToken } = require('../src/sign');

const GAME_BIZ = 'hk4e_cn';
const CLOUD_BASE = 'https://api-cloudgame.mihoyo.com/hk4e_cg_cn';
const APP_ID = 4;          // createOrderDefaultAppId
const CHANNEL_ID = 1;
const PASSPORT_APP_ID = 'c76ync6mutq8';

// 目标端：改成 'touch' 就能走 WebTouch(24/18) 分支
const PROFILE = process.env.MHY_PROFILE || 'pc';

const PROFILES = {
  pc: {
    comboClientType: 22, cloudClientType: 16, cps: 'pc_mihoyo',
    sysVersion: 'Windows 10', deviceName: 'Unknown', deviceModel: 'Unknown',
    bundleId: 'hk4e_cn_webpc', platform: 'pc', speedClientType: 7,
    dpi: 96, width: 1920, height: 1080, resolution: '1920x1080',
    referrer: 'https://ys.mihoyo.com/cloud/#/',
  },
  touch: {
    comboClientType: 24, cloudClientType: 18, cps: 'touch_mihoyo',
    sysVersion: 'Android 13', deviceName: 'BlackBerry', deviceModel: 'Unknown',
    bundleId: 'hk4e_cn_webtouch', platform: 'android', speedClientType: 8,
    dpi: 480, width: 2532, height: 1170, resolution: '2532x1170',
    referrer: 'https://ys.mihoyo.com/cloud/m/#/',
  },
};

const P = PROFILES[PROFILE];
if (!P) {
  console.error(`unknown MHY_PROFILE=${PROFILE} (pc | touch)`);
  process.exit(1);
}

const COOKIE = process.env.MHY_COOKIE;
if (!COOKIE) {
  console.error('MHY_COOKIE is required.\n' +
    "Example: MHY_COOKIE='ltuid_v2=1; ltoken_v2=v2_...' node examples/login.js");
  process.exit(1);
}

// 设备 id 建议持久化，否则每次登录服务端都当新设备
const DEVICE_ID = process.env.MHY_DEVICE_ID || randomUuid();
const DEVICE_FP = process.env.MHY_DEVICE_FP; // 留空则不带该 header，由服务端自行分配

function randomUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function randomHex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '0123456789abcdef'[(Math.random() * 16) | 0];
  return s;
}

// ---- 1. webVerifyForGame：校验通行证会话，拿 set-cookie ----
async function verifyForGame() {
  const res = await fetch(
    'https://passport-api.mihoyo.com/account/ma-cn-session/web/webVerifyForGame',
    {
      method: 'POST',
      headers: {
        cookie: COOKIE,
        origin: 'https://ys.mihoyo.com',
        referer: 'https://ys.mihoyo.com/',
        'x-rpc-app_id': PASSPORT_APP_ID,
        'x-rpc-sdk_version': '2.50.1',
        'x-rpc-client_type': String(P.comboClientType),
        'x-rpc-lifecycle_id': randomHex(10),
        'x-rpc-mi_referrer': P.referrer,
        'x-rpc-device_id': DEVICE_ID,
        'x-rpc-device_fp': DEVICE_FP,
        'x-rpc-device_name': encodeURIComponent(P.deviceName),
        'x-rpc-device_model': encodeURIComponent(P.deviceModel),
        'x-rpc-device_os': encodeURIComponent(P.sysVersion),
        'x-rpc-game_biz': GAME_BIZ,
        'x-rpc-channel': 'mihoyo',
        'x-rpc-language': 'zh-cn',
      },
    },
  );
  const json = await res.json();
  // 服务端会下发新的 cookie，后续请求合并使用
  const setCookie = res.headers.getSetCookie
    ? res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    : '';
  return { json, cookie: [COOKIE, setCookie].filter(Boolean).join('; ') };
}

// ---- 2. webLogin：拿 combo_token / open_id ----
async function webLogin() {
  const res = await fetch(
    `https://hk4e-sdk.mihoyo.com/${GAME_BIZ}/combo/granter/login/webLogin`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: COOKIE,
        origin: 'https://ys.mihoyo.com',
        referer: 'https://ys.mihoyo.com/',
        'x-rpc-client_type': String(P.comboClientType),
        'x-rpc-game_biz': GAME_BIZ,
        'x-rpc-channel_id': String(CHANNEL_ID),
        'x-rpc-mdk_version': '2.57.0',
        'x-rpc-device_id': DEVICE_ID,
        'x-rpc-device_fp': DEVICE_FP,
        'x-rpc-device_name': encodeURIComponent(P.deviceName),
        'x-rpc-device_model': encodeURIComponent(P.deviceModel),
        'x-rpc-device_os': encodeURIComponent(P.sysVersion),
        'x-rpc-channel': 'mihoyo',
        'x-rpc-language': 'zh-cn',
      },
      body: JSON.stringify({ app_id: APP_ID, channel_id: CHANNEL_ID }),
    },
  );
  return res.json();
}

// ---- 3. gamer/api/login：建立云游戏 session ----
async function gamerLogin(comboHeader) {
  const res = await fetch(
    `${CLOUD_BASE}/gamer/api/login`,
    {
      method: 'POST',
      headers: { ...cloudHeaders(comboHeader), 'content-type': 'application/json' },
      body: '{}',
    },
  );
  return res.json();
}

function cloudHeaders(comboHeader) {
  return {
    'x-rpc-app_id': String(APP_ID),
    'x-rpc-app_version': '7.2.0',
    'x-rpc-client_type': String(P.cloudClientType),
    'x-rpc-cg_game_biz': GAME_BIZ,
    'x-rpc-op_biz': 'clgm_cn',
    'x-rpc-channel': 'mihoyo',
    'x-rpc-cps': P.cps,
    'x-rpc-language': 'zh-cn',
    'x-rpc-sys_version': P.sysVersion,
    'x-rpc-device_id': DEVICE_ID,
    'x-rpc-device_name': encodeURIComponent(P.deviceName),
    'x-rpc-device_model': encodeURIComponent(P.deviceModel),
    'x-rpc-vendor_id': '2',
    'x-rpc-combo_token': comboHeader,
  };
}

(async () => {
  const verify = await verifyForGame();
  if (verify.json.retcode !== 0) {
    console.error('webVerifyForGame failed:', JSON.stringify(verify.json));
    process.exit(1);
  }

  const login = await webLogin();
  if (login.retcode !== 0) {
    console.error('webLogin failed:', JSON.stringify(login));
    process.exit(1);
  }

  const d = login.data;
  const comboToken = buildComboToken({
    app_id: APP_ID, channel_id: CHANNEL_ID,
    open_id: d.open_id, combo_token: d.combo_token, game_biz: GAME_BIZ,
  });

  const gamer = await gamerLogin(comboToken);

  console.log(JSON.stringify({
    profile: PROFILE,
    aid: d.open_id,
    open_id: d.open_id,
    combo_token: d.combo_token,
    x_rpc_combo_token: comboToken,
    account_type: d.account_type,
    fatigue_remind: d.fatigue_remind,
    gamer_login: gamer,
    // 供 dispatch.js 使用
    cookie: verify.cookie,
    device_id: DEVICE_ID,
    device_fp: DEVICE_FP,
    cloud_client_type: P.cloudClientType,
    combo_client_type: P.comboClientType,
    cps: P.cps,
    sys_version: P.sysVersion,
    speed_client_type: P.speedClientType,
    dpi: P.dpi, width: P.width, height: P.height, resolution: P.resolution,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
