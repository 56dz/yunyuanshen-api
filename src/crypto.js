'use strict';
/**
 * 米哈游账号体系（login-platform）请求体加密。
 *
 * 逆向自 https://user.mihoyo.com/login-platform/ 的 webpack 模块 38625（JSEncrypt）
 * 与模块 87257（RSAKey）。算法是教科书式 RSAES-PKCS1-v1_5 + base64 输出。
 *
 * 之所以不用 node:crypto / WebCrypto：
 *   - node:crypto 的 publicEncrypt 只支持 Node，浏览器没有；
 *   - WebCrypto 的 RSA-OAEP 不是 PKCS#1 v1.5，padding 对不上，服务端会解密失败。
 * 所以这里用 BigInt 手写一遍，Node 与浏览器通用，零依赖。
 */

// login-platform 里写死的公钥（X.509 SubjectPublicKeyInfo, base64）
const PUBLIC_KEY_B64 = [
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDvekdPMHN3AYhm/vktJT+YJr7',
  'cI5DcsNKqdsx5DZX0gDuWFuIjzdwButrIYPNmRJ1G8ybDIF7oDW2eEpm5sMbL9zs',
  '9ExXCdvqrn51qELbqj0XxtMTIpaCHFSI50PfPpTFV9Xt/hmyVwokoOXFlAEgCn+Q',
  'CgGs52bFoYMtyi+xEQIDAQAB',
].join('');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64ToBytes(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function bytesToB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

function bytesToBigInt(bytes) {
  let hex = '0x0';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return BigInt(hex);
}

function bigIntToBytes(n, len) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  if (len === undefined) return out;
  if (out.length === len) return out;
  const fixed = new Uint8Array(len);
  // 左侧补零 / 截断高位（正常情况只会补零）
  fixed.set(out.slice(Math.max(0, out.length - len)), Math.max(0, len - out.length));
  return fixed;
}

/** 极简 DER 解析：从 SPKI 里取出 (n, e) */
function parsePublicKeyDer(der) {
  let p = 0;
  const readTag = () => {
    const tag = der[p++];
    let len = der[p++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[p++];
    }
    return { tag, len, start: p };
  };
  // SEQUENCE { AlgorithmIdentifier, BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
  const outer = readTag();
  if (outer.tag !== 0x30) throw new Error('not a DER SEQUENCE');
  const alg = readTag();
  p = alg.start + alg.len;
  const bits = readTag();
  if (bits.tag !== 0x03) throw new Error('expected BIT STRING');
  p = bits.start + 1; // 跳过 unused-bits 字节
  const seq = readTag();
  const nInt = readTag();
  const modulus = bytesToBigInt(der.subarray(nInt.start, nInt.start + nInt.len));
  p = nInt.start + nInt.len;
  const eInt = readTag();
  const exponent = bytesToBigInt(der.subarray(eInt.start, eInt.start + eInt.len));
  return { modulus, exponent };
}

let _key = null;
function getKey() {
  if (!_key) _key = parsePublicKeyDer(b64ToBytes(PUBLIC_KEY_B64));
  return _key;
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    e >>= 1n;
  }
  return result;
}

function randomBytes(len) {
  // 非加密安全也无所谓：这里只用作 PKCS#1 v1.5 的随机填充，服务端会丢弃。
  const out = new Uint8Array(len);
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * RSAES-PKCS1-v1_5 加密，返回 base64。
 * @param {string} plaintext
 * @param {{modulus: bigint, exponent: bigint}} [key] 仅供测试注入
 * @returns {string}
 */
function encrypt(plaintext, key) {
  const { modulus, exponent } = key || getKey();
  const k = Math.ceil(modulus.toString(16).length / 2); // 128
  const msg = new TextEncoder().encode(String(plaintext));
  if (msg.length > k - 11) throw new Error('plaintext too long for RSA-1024');

  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  const psLen = k - msg.length - 3;
  for (let i = 0; i < psLen; i++) {
    let b = 0;
    while (b === 0) b = randomBytes(1)[0]; // PS 必须全部非零
    em[2 + i] = b;
  }
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);

  const m = bytesToBigInt(em);
  const c = modPow(m, exponent, modulus);
  return bytesToB64(bigIntToBytes(c, k));
}

module.exports = { encrypt, PUBLIC_KEY_B64, parsePublicKeyDer, b64ToBytes, bytesToB64 };
