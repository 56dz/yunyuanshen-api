'use strict';
/**
 * src/crypto.js 的正确性自检。
 *
 * 两条独立的验证：
 *  1) 用 node:crypto 现生成一对 1024-bit 密钥，把公钥的 SPKI DER 交给我们的 DER 解析器，
 *     再用我们的 encrypt() 加密，最后用 node:crypto 的私钥解密 —— padding/编码全都对上才算过。
 *  2) 拿线上真实公钥加密，再把它自己解回来（c^e mod n 应还原成 00 02 PS 00 msg），
 *     确认真实公钥的解析与模幂都没问题。
 */
const crypto = require('crypto');
const { encrypt, parsePublicKeyDer, b64ToBytes, bytesToB64, PUBLIC_KEY_B64 } = require('./crypto.js');

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

// ---- 1) 与 node:crypto 互通 ----
console.log('[test-crypto] 1) round-trip with node:crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const spki = publicKey.export({ type: 'spki', format: 'der' });
const parsed = parsePublicKeyDer(new Uint8Array(spki));

check('parsed modulus is 1024-bit', parsed.modulus.toString(2).length === 1024, parsed.modulus.toString(2).length);
check('parsed exponent is 65537', parsed.exponent === 65537n, String(parsed.exponent));

for (const plain of ['+86', 'someone@example.com', 'p@ssw0rd-测试', 'a'.repeat(117)]) {
  const cipher = encrypt(plain, parsed);
  const back = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cipher, 'base64'),
  );
  check(`round-trip ${JSON.stringify(plain.slice(0, 16))}`, back.toString('utf8') === plain, back.toString('utf8'));
}

// 超过 k-11 = 117 字节必须报错
let threw = false;
try {
  encrypt('a'.repeat(118), parsed);
} catch {
  threw = true;
}
check('rejects plaintext > k-11', threw);

// ---- 2) 真实公钥解析与 node:crypto 对齐 ----
// RSA 是单向的，手上没有私钥就无法把密文解回来；所以这里换一种独立验证：
// 把同一份 SPKI DER 交给 node:crypto 解析成 JWK，比较 n / e 是否与我们的解析器一致。
console.log('[test-crypto] 2) real public key parsed the same way as node:crypto');
const realDer = b64ToBytes(PUBLIC_KEY_B64);
const realKey = parsePublicKeyDer(realDer);
const jwk = crypto.createPublicKey({ key: Buffer.from(realDer), format: 'der', type: 'spki' }).export({ format: 'jwk' });

const jwkN = BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'));
const jwkE = BigInt('0x' + Buffer.from(jwk.e, 'base64url').toString('hex'));

check('real modulus is 1024-bit', realKey.modulus.toString(2).length === 1024, realKey.modulus.toString(2).length);
check('real exponent is 65537', realKey.exponent === 65537n, String(realKey.exponent));
check('modulus matches node:crypto', realKey.modulus === jwkN);
check('exponent matches node:crypto', realKey.exponent === jwkE);

const realCipher = encrypt('+86');
check('real ciphertext is 128 bytes', Buffer.from(realCipher, 'base64').length === 128,
  Buffer.from(realCipher, 'base64').length);

// 同一段明文两次加密必须不同（PS 随机）
check('padding is randomized', encrypt('+86') !== realCipher);

// base64 编解码互逆
check('b64 round-trip', bytesToB64(b64ToBytes(PUBLIC_KEY_B64)) === PUBLIC_KEY_B64, bytesToB64(b64ToBytes(PUBLIC_KEY_B64)));

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
