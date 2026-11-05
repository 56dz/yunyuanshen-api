#!/usr/bin/env node
// 调度示例：从 login.js 的输出走到 sdk_param 解码。
//
// 用法：
//   node examples/login.js > /tmp/login.json
//   node examples/dispatch.js /tmp/login.json
//
// 注意：paasDispatch 成功后服务端会分配一台机器，**这会开始计费/扣时长**。
// 本示例在拿到 sdk_param 后立即调用 leaveDispatchQueue 并退出，不建 WebRTC。
// 想真正进游戏请看 examples/play-skeleton.html。

'use strict';
const fs = require('fs');
const { buildPaasDispatch } = require('../src/sign');
const { decode: pbDecode } = require('../src/pbdecode');

const CLOUD_BASE = 'https://api-cloudgame.mihoyo.com/hk4e_cg_cn';
const GAME_BIZ = 'hk4e_cn';
const STATIC_BASE = 'https://api-cloudgame-static.mihoyo.com/hk4e_cn/cg';

const sessionPath = process.argv[2];
if (!sessionPath) {
  console.error('usage: node examples/dispatch.js <session.json>');
  console.error('  session.json 由 examples/login.js 生成，例如：');
  console.error("    MHY_COOKIE='...' MHY_PROFILE=touch node examples/login.js > /tmp/session.json");
  console.error('    node examples/dispatch.js /tmp/session.json');
  process.exit(1);
}

const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

const H = {
  'x-rpc-app_id': '4',
  'x-rpc-app_version': '7.2.0',
  'x-rpc-client_type': String(session.cloud_client_type),
  'x-rpc-cg_game_biz': GAME_BIZ,
  'x-rpc-op_biz': 'clgm_cn',
  'x-rpc-channel': 'mihoyo',
  'x-rpc-cps': session.cps,
  'x-rpc-language': 'zh-cn',
  'x-rpc-sys_version': session.sys_version,
  'x-rpc-device_id': session.device_id,
  'x-rpc-device_name': encodeURIComponent('Unknown'),
  'x-rpc-device_model': encodeURIComponent('Unknown'),
  'x-rpc-vendor_id': '2',
  'x-rpc-combo_token': session.x_rpc_combo_token,
  cookie: session.cookie,
};

async function get(url) {
  const res = await fetch(url, { headers: H });
  return res.json();
}
async function post(path, body) {
  const res = await fetch(CLOUD_BASE + path, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---- RTT 测速（对应 cg-sdk WebSocketRttTester）----
// 连发 20 个 "X" 文本帧，收到就算 Date.now() - sendTime，取算术平均。
function testRtt(wssUrl, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(wssUrl);
    } catch {
      return resolve(-1);
    }
    const sent = [];
    let received = 0;
    let total = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(-1);
    }, timeoutMs);

    ws.addEventListener('open', () => {
      for (let i = 0; i < 20; i++) {
        sent.push(Date.now());
        ws.send('X');
      }
    });
    ws.addEventListener('message', () => {
      const t = sent.shift();
      if (t === undefined) return;
      total += Date.now() - t;
      received++;
      if (received >= 20) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(Math.round(total / received));
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });
}

(async () => {
  // 1. 画质/码率档位
  const speed = await get(`${CLOUD_BASE}/gamer/api/getSpeedLimitConfig?speed_client_type=${session.speed_client_type}`);
  if (speed.retcode !== 0) {
    throw new Error('getSpeedLimitConfig: ' + JSON.stringify(speed) +
      '\n（多为 x-rpc-combo_token 失效，请用 examples/login.js 重新生成 session.json）');
  }
  const gears = speed.data.list;
  const top = gears[speed.data.default_gear].top;
  const bitRate = 1024 * top;              // ← 唯一的码率来源
  console.log(`bit_rate = 1024 * ${top} = ${bitRate}`);

  // 2. 集群状态
  const status = await post('/dispatcher/api/statusCheck', { biz_key: GAME_BIZ });
  if (status.retcode !== 0) throw new Error('statusCheck: ' + JSON.stringify(status));

  // 3. 测速服务器列表
  const ping = await post('/dispatcher/api/listPingServer', {
    biz_key: GAME_BIZ,
    ext_data: JSON.stringify({ platform: session.cloud_client_type }),  // 注意：JSON 字符串
  });
  const svrs = ping.data.ping_svr;

  // 4. 逐个测速
  const results = [];
  for (const s of svrs) {
    const rtt = await testRtt(s.wss_url);
    results.push({
      ping_server_id: s.ping_server_id,
      node_id: s.node_id,
      display_name: s.display_name,
      region_id: s.region_id,
      province_id: String(s.province_id),
      isp_type: s.isp_type,
      rtt: rtt < 0 ? 0 : rtt,
      loss_rate: 0, jitter: 0, out_of_order: 0,
    });
    console.log(`  ${s.display_name.padEnd(12)} rtt=${rtt}ms`);
  }

  // 5. 上报测速结果，拿节点
  const nodes = await post('/dispatcher/api/getNodesInfo', {
    biz_key: GAME_BIZ,
    node: JSON.stringify({ bandwidth: 0, ping_results: results }),  // 注意：JSON 字符串
    speed_client_type: session.speed_client_type,
  });
  const node = nodes.data.nodes[0];
  console.log(`node_id=${node.node_id} regions=${JSON.stringify(node.region_ids)}`);

  // 6. 组装 user_data
  const deviceInfo = {
    deviceName: 'Unknown',
    systemVersion: session.sys_version,
    deviceInfo: [
      `operatingSystem:${session.sys_version}`,
      'deviceModel:Unknown',
      'processorCount:8',
      'processorType:Unknown',
      'systemMemorySize:16',
      'graphicsDeviceName:Unknown',
    ].join('&'),
  };
  const userData = JSON.stringify({
    dpi: session.dpi,
    w: session.width,
    h: session.height,
    lang: 'zh-CN',
    di: Buffer.from(JSON.stringify(deviceInfo)).toString('base64'),
  });

  // 7. paasDispatch（buildPaasDispatch 内部处理"签名对象≠body"这个坑）
  const body = buildPaasDispatch({
    bit_rate: bitRate,
    biz_key: GAME_BIZ,
    cmd_line: '',                     // using_new_cmd_line=true 时恒为空
    user_data: userData,
    codec_type: 1,
    env: '2',
    ext_data: '',
    fps: 60,
    node_id: node.node_id,
    resolution: session.resolution,
    regions: node.region_ids,         // 顺序必须原样
    hint: null,
    net_state: 4,
    queue_type: '',
  });

  const dispatch = await post('/dispatcher/api/paasDispatch', body);
  if (dispatch.retcode !== 0) throw new Error('paasDispatch: ' + JSON.stringify(dispatch));

  const resultCode = dispatch.data.result_code;
  console.log(`result_code = ${resultCode}`);

  if (resultCode === 'QUEUED') {
    const q = dispatch.data.queue_info;
    console.log(`queued: ticket=${q.ticket} interval=${q.query_interval}`);
    await post('/dispatcher/api/leaveDispatchQueue', {
      biz_key: GAME_BIZ, ticket: q.ticket,
    });
    console.log('left queue, exiting.');
    return;
  }

  if (resultCode !== 'FINISHED') {
    console.log('unexpected:', JSON.stringify(dispatch.data));
    return;
  }

  const fr = dispatch.data.finish_result;
  console.log(`sid=${fr.sid} provider=${fr.cloud_provider}`);

  // 8. 解 sdk_param
  const buf = Buffer.from(fr.sdk_param, 'base64');
  console.log(`\nsdk_param = ${buf.length} bytes`);
  const fields = pbDecode(buf);
  for (const f of fields) console.log(`  #${f.field} ${f.wire} = ${f.value}`);

  // 找一个字符串字段里的 wss 地址
  const wss = fields.find((f) => typeof f.value === 'string' && f.value.startsWith('wss://'));
  if (wss) {
    const url = wss.value + (wss.value.endsWith('/rtc-sdk') ? '' : '/rtc-sdk');
    console.log(`\nsignaling: ${url}`);
  }

  console.log('\ndone. 本示例不建 WebRTC，session 会自然超时回收。');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
