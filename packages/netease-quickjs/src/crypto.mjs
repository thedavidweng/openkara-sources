// SPDX-License-Identifier: AGPL-3.0-only
// QuickJS port of the exact weapi/eapi wire used by the seven NetEase
// operations at @neteasecloudmusicapienhanced/api 4.41.1 defaults.
// weapi: double AES-128-CBC/PKCS7, base64 params, reversed 16-char key raw
// RSA public with no padding (hex). eapi: MD5 of the joined message, then
// AES-128-ECB/PKCS7 of the joined text, uppercase hex params.

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PRESET_KEY = openkara.encoding.utf8Encode("0CoJUm6Qyw8W8jud");
const IV = openkara.encoding.utf8Encode("0102030405060708");
const EAPI_KEY = openkara.encoding.utf8Encode("e82ckv69qw9f8a6h");
// Real upstream values from the public NeteaseCloudMusicApiEnhanced/api-enhanced
// repository (util/crypto.js, main). The npm tarball redacts eapiKey at
// publish time, so vectors must be checked against the upstream values.
const LINUXAPI_KEY = openkara.encoding.utf8Encode("rFgB&h#%2?^eDg:Q");

function u8(value) {
  if (typeof value === "string") return openkara.encoding.utf8Encode(value);
  if (typeof value === "object" && value !== null && typeof value.length === "number")
    return value;
  if (value instanceof Uint8Array) return value;
  throw new TypeError("expected a string or bytes");
}

function byteAt(bytes, index) {
  if (typeof bytes === "string") {
    const code = bytes.charCodeAt(index);
    if (!Number.isInteger(code) || code > 255) throw new TypeError("bytes must be latin1");
    return code;
  }
  return bytes[index];
}

function byteLength(bytes) {
  if (typeof bytes === "string" || bytes instanceof Uint8Array) return bytes.length;
  throw new TypeError("expected bytes");
}

function text(bytes) {
  return openkara.encoding.utf8Decode(bytes);
}

function concat(first, second) {
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

function aesCbc(key, iv, data) {
  return openkara.crypto.aesEncrypt({ mode: "cbc", key, iv }, data);
}

function aesEcb(key, data) {
  return openkara.crypto.aesEncrypt({ mode: "ecb", key }, data);
}

function base64(bytes) {
  return openkara.encoding.base64Encode(bytes);
}

function hexUpper(bytes) {
  return openkara.encoding.hexEncode(bytes).toUpperCase();
}

function md5Hex(data) {
  return openkara.encoding.hexEncode(openkara.crypto.digest("md5", u8(data)));
}

export function randomKey16() {
  const bytes = openkara.crypto.randomBytes(16);
  if (byteLength(bytes) < 16) throw new TypeError("randomBytes returned too few bytes");
  let key = "";
  for (let i = 0; i < 16; i += 1) key += BASE62[byteAt(bytes, i) % 62];
  return key;
}

// Reverse ASCII string without relying on locale-sensitive helpers.
function reversed(value) {
  let out = "";
  for (let i = value.length - 1; i >= 0; i -= 1) out += value[i];
  return out;
}

export function weapi(object, secretKey) {
  const inner = aesCbc(PRESET_KEY, IV, u8(JSON.stringify(object)));
  const params = base64(aesCbc(u8(secretKey), IV, inner));
  const encSecKey = openkara.encoding.hexEncode(
    openkara.crypto.rsaPublic(
      { pem: WEAPI_PUBLIC_KEY },
      u8(reversed(secretKey)),
    ),
  );
  return { params, encSecKey };
}

export function eapi(uri, object) {
  const data = typeof object === "object" ? JSON.stringify(object) : object;
  const message = `nobody${uri}use${data}md5forencrypt`;
  const joined = `${uri}-36cd479b6b5-${data}-36cd479b6b5-${md5Hex(message)}`;
  return { params: hexUpper(aesEcb(EAPI_KEY, u8(joined))) };
}

export function linuxapi(object) {
  return {
    eparams: hexUpper(aesEcb(LINUXAPI_KEY, u8(JSON.stringify(object)))),
  };
}

export const WEAPI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
