// Verify the ys.mihoyo.com cloud-game request signature scheme.
//
// CONFIRMED against real captured traffic:
//   sign = HMAC-SHA256( sorted "k=v&" pairs of the SIGNED BASE object, appKey ) hex
// Key detail: the signed object is NOT the final body. The frontend builds a base
// object `y` where `regions` is the **JSON.stringify'd string**, signs that, then
// spreads it into the outer body and replaces `regions` with the real array.
// hint / net_state / queue_type / using_new_cmd_line / queue_switch / sign
// are added AFTER signing.
'use strict';
const crypto = require('crypto');

// paasDispatch 的 sign 用这个 key（web bundle appEnv.appKey）
const APP_KEY = '7511caf05a67bb7ca33b1970ce6222a8';
// x-rpc-combo_token 里的 si 用这个 key（combo-web 模块 68828 的 app_key）
const COMBO_APP_KEY = 'd0d3a7342df2026a70f650b907800111';

function sign(obj, key) {
  const str = Object.keys(obj)
    .sort()
    .reduce((acc, k) => `${acc}${k}=${obj[k]}&`, '')
    .slice(0, -1);
  return crypto.createHmac('sha256', key || APP_KEY).update(str).digest('hex');
}

// ---- real captured values (bsk debug run de80b2cc6bb71, request n165) ----
const TARGET_SIGN = '198f2d8d452dfce709cb4c5f63f61fbb487061d286ca0970eef888a2ab2cedfe';
const USER_DATA = '{"dpi":96,"w":1920,"h":1080,"lang":"zh-CN","di":"eyJkZXZpY2VOYW1lIjoiVW5rbm93biIsInN5c3RlbVZlcnNpb24iOiJXaW5kb3dzIDEwIiwiZGV2aWNlSW5mbyI6Im9wZXJhdGluZ1N5c3RlbTpXaW5kb3dzIDEwJmRldmljZU1vZGVsOlVua25vd24mcHJvY2Vzc29yQ291bnQ6MjAmcHJvY2Vzc29yVHlwZTpVbmtub3duJnN5c3RlbU1lbW9yeVNpemU6MzImZ3JhcGhpY3NEZXZpY2VOYW1lOmFtZCwgYW1kIHJhZGVvbih0bSkgODgwbSBncmFwaGljcyAoMHgwMDAwMTUwZSkgKEFOR0xFIChBTUQsIEFNRCBSYWRlb24oVE0pIDg4ME0gR3JhcGhpY3MgKDB4MDAwMDE1MEUpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpKSJ9"}';
const REGIONS = ['99607000117', '99607000143', '99607000167', '99607000104', '99607000250', '99607000247'];

// the object that actually gets signed
const signedBase = {
  bit_rate: 13312000,
  biz_key: 'hk4e_cn',
  cmd_line: '',
  user_data: USER_DATA,
  codec_type: 1,
  env: '2',
  ext_data: '',
  fps: 60,
  node_id: '440000',
  resolution: '1920x1080',
  regions: JSON.stringify(REGIONS), // <-- string, not array
};

// the body that goes on the wire
const body = Object.assign({}, signedBase, {
  hint: null,
  net_state: 4,
  queue_type: '',
  sign: sign(signedBase),
  using_new_cmd_line: true,
  queue_switch: false,
  regions: REGIONS, // <-- array on the wire
});

// ---- x-rpc-combo_token ----
// 线上抓包已确认算法正确（si 与 header 内的值逐字一致），但真实的
// open_id / combo_token / si 属于账号凭据，已从仓库移除。
// 这里改用一组占位值做断言，期望值由 openssl 独立算出，用于保证"排序 + 拼接 + HMAC"没写错：
//   $ printf 'app_id=4&channel_id=1&combo_token=v2_0123...&open_id=100000001' \
//       | openssl dgst -sha256 -hmac 'd0d3a7342df2026a70f650b907800111'
//   => c3cfb041cd387fde2a35c075b8689d6cb8c0f33ef01cf11d95767ae7afc585c0
const FIXTURE = {
  app_id: 4,
  channel_id: 1,
  open_id: '100000001',
  combo_token: 'v2_0123456789abcdef0123456789abcdef01234567',
};
const TARGET_SI = 'c3cfb041cd387fde2a35c075b8689d6cb8c0f33ef01cf11d95767ae7afc585c0';

function buildComboToken({ app_id = 4, channel_id = 1, open_id, combo_token, game_biz = 'hk4e_cn' }) {
  const c = { app_id, channel_id, open_id, combo_token };
  const si = sign(c, COMBO_APP_KEY); // combo app_key，不是 APP_KEY
  return ['ai=' + app_id, 'ci=' + channel_id, 'oi=' + open_id,
    'ct=' + combo_token, 'si=' + si, 'bi=' + game_biz].join(';');
}

// --- self-check ---
// 只在直接运行（node src/sign.js）时打印，被 require 时保持安静
function selfCheck() {
  const okSign = body.sign === TARGET_SIGN;

  const si = sign(FIXTURE, COMBO_APP_KEY);
  const okCombo = si === TARGET_SI;

  console.log('[verify_sign] computed:', body.sign);
  console.log('[verify_sign] expected:', TARGET_SIGN);
  console.log('[verify_sign] MATCH   :', okSign);
  console.log('[verify_sign] combo si :', si);
  console.log('[verify_sign] combo MATCH:', okCombo);
  if (!okCombo) console.log('  expect :', TARGET_SI);
  if (!okSign) console.log('! sign mismatch — 检查 APP_KEY 与 signedBase 字段集');
  return okSign && okCombo;
}

if (require.main === module) {
  selfCheck();
  console.log('\nfinal wire body:\n' + JSON.stringify(body));
  console.log('\ncombo_token (placeholder fixture):\n' + buildComboToken(FIXTURE));
}

module.exports = {
  sign, APP_KEY, COMBO_APP_KEY, buildComboToken, selfCheck,
  buildPaasDispatch: (o) => {
    const base = {
      bit_rate: o.bit_rate, biz_key: o.biz_key, cmd_line: o.cmd_line || '',
      user_data: o.user_data, codec_type: o.codec_type || 1, env: o.env,
      ext_data: o.ext_data || '', fps: o.fps, node_id: o.node_id,
      resolution: o.resolution, regions: JSON.stringify(o.regions),
    };
    return Object.assign({}, base, {
      hint: o.hint === undefined ? null : o.hint, net_state: o.net_state,
      queue_type: o.queue_type || '', sign: sign(base),
      using_new_cmd_line: true, queue_switch: false, regions: o.regions,
    });
  },
};
