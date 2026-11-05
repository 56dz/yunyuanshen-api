#!/usr/bin/env node
// 账号认证登录示例（passport 域）：账号密码 / 手机验证码 / 扫码。
//
// 与 examples/login.js 的区别：
//   examples/login.js        → 游戏侧 combo 登录（拿 open_id + combo_token），需要已有 cookie
//   examples/login-account.js→ 账号本身的登录（拿 cookie），本文档对应的这一步
//
// 三种模式：
//   ① 扫码（最安全，默认）：生成 ticket → 打印二维码 URL → 手机扫码 → 拿到 cookie
//   ② 账号密码：需要把账号密码写进环境变量
//   ③ 手机验证码：会真的发短信，谨慎
//
// 用法：
//   node examples/login-account.js qr
//   MHY_ACCOUNT='you@example.com' MHY_PASSWORD='...' node examples/login-account.js password
//   MHY_MOBILE='13800000000' node examples/login-account.js captcha        # 只发码
//   MHY_MOBILE='13800000000' MHY_CAPTCHA='123456' node examples/login-account.js captcha
//
// 输出：JSON，含 set-cookie 里的 token（如果服务端下发了）与响应体。

'use strict';
const { encrypt } = require('../src/crypto');

const PASSPORT = 'https://passport-api.mihoyo.com';
const APP_ID = 'c76ync6mutq8';     // 云·原神在 passport 域的 app_id
const SDK_VERSION = '2.57.0';
const GAME_BIZ = 'hk4e_cn';

// 云客户端枚举（不是 cloudgame 域那套 WebPC=16/WebTouch=18）
const CLIENT_TYPE = process.env.MHY_CLIENT_TYPE || '24'; // 24 = CloudWebTouch, 22 = CloudWebPC
const REFERRER = process.env.MHY_REFERRER || 'https://user.mihoyo.com/login-platform/index.html';

const DEVICE_ID = process.env.MHY_DEVICE_ID || uuiv4();
const DEVICE_FP = process.env.MHY_DEVICE_FP; // 可选，留空则不发该 header

function uuiv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function headers(extra = {}) {
  return {
    'x-rpc-app_id': APP_ID,
    'x-rpc-sdk_version': SDK_VERSION,
    'x-rpc-game_biz': GAME_BIZ,
    'x-rpc-device_id': DEVICE_ID,
    ...(DEVICE_FP ? { 'x-rpc-device_fp': DEVICE_FP } : {}),
    'x-rpc-device_model': 'Unknown',
    'x-rpc-device_name': 'Chrome',
    'x-rpc-device_os': 'Windows 10',
    'x-rpc-client_type': CLIENT_TYPE,
    'x-rpc-lifecycle_id': '0123456789',
    'x-rpc-mi_referrer': REFERRER,
    'content-type': 'application/json',
    ...extra,
  };
}

async function post(path, body, extraHeaders) {
  const res = await fetch(PASSPORT + path, {
    method: 'POST',
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() || [] };
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------------- ① 扫码 ----------------

async function runQR() {
  const created = await post('/account/ma-cn-passport/web/createQRLogin', {});
  if (created.json.retcode !== 0) fail('createQRLogin failed: ' + JSON.stringify(created.json));

  const { url, ticket } = created.json.data;
  console.log('用米游社 / 原神 / 云游戏 App 扫描下面这个地址的二维码：\n');
  console.log('  ' + url);
  console.log('\n（把上面的 URL 转成二维码即可；也可以直接在手机浏览器打开）');
  console.log('ticket =', ticket);
  console.log('\n开始轮询（2s 一次，最多 180s）…');

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await post('/account/ma-cn-passport/web/queryQRLoginStatus', { ticket });
    const d = r.json.data || {};
    process.stdout.write(`  status=${d.status}\r`);
    if (d.status === 'Confirmed') {
      console.log('\n扫码确认成功。');
      // 真实登录的 token cookie 主要在 queryQRLoginStatus 的响应头里
      const cookies = [...created.setCookie, ...r.setCookie];
      return { ticket, status: d.status, data: d, setCookie: cookies };
    }
    if (r.json.retcode !== 0 && r.json.retcode !== -3505) {
      console.log('\n轮询中断：' + JSON.stringify(r.json));
      return { ticket, error: r.json };
    }
  }
  fail('扫码超时');
}

// ---------------- ② 账号密码 ----------------

async function runPassword() {
  const account = process.env.MHY_ACCOUNT;
  const password = process.env.MHY_PASSWORD;
  if (!account || !password) fail('需要 MHY_ACCOUNT 与 MHY_PASSWORD');

  const r = await post(
    '/account/ma-cn-passport/web/loginByPassword',
    { account: encrypt(account), password: encrypt(password) },
    { 'x-rpc-source': 'v2.webLogin' },
  );
  return { mode: 'password', retcode: r.json.retcode, message: r.json.message, data: r.json.data, setCookie: r.setCookie };
}

// ---------------- ③ 手机验证码 ----------------

async function runCaptcha() {
  const mobile = process.env.MHY_MOBILE;
  if (!mobile) fail('需要 MHY_MOBILE');
  const areaCode = process.env.MHY_AREA_CODE || '+86';

  const sent = await post('/account/ma-cn-verifier/verifier/createLoginCaptcha', {
    mobile: encrypt(mobile),
    area_code: encrypt(areaCode),
  });
  console.log('发码结果:', JSON.stringify(sent.json));

  const captcha = process.env.MHY_CAPTCHA;
  if (!captcha) {
    console.log('\n短信已发送。拿到验证码后重新运行：');
    console.log(`  MHY_MOBILE='${mobile}' MHY_CAPTCHA='<6位>' node examples/login-account.js captcha`);
    return { mode: 'captcha', step: 'sent', data: sent.json };
  }

  const r = await post(
    '/account/ma-cn-passport/web/loginByMobileCaptcha',
    { mobile: encrypt(mobile), area_code: encrypt(areaCode), captcha },
    { 'x-rpc-source': 'v2.webLogin' },
  );
  return { mode: 'captcha', retcode: r.json.retcode, message: r.json.message, data: r.json.data, setCookie: r.setCookie };
}

// ---------------- 入口 ----------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const mode = process.argv[2] || 'qr';
  let out;
  if (mode === 'qr') out = await runQR();
  else if (mode === 'password') out = await runPassword();
  else if (mode === 'captcha') out = await runCaptcha();
  else fail(`unknown mode: ${mode} (qr | password | captcha)`);

  console.log('\n---- result ----');
  console.log(JSON.stringify(out, null, 2));
  console.log('\n提示：登录成功后，把 setCookie 里的 token 拼成 Cookie 头，');
  console.log('      再交给 examples/login.js 走 combo 登录（MHY_COOKIE=...）。');
})();
