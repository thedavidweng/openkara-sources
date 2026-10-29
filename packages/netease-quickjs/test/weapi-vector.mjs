// Offline regressions against the pinned 4.41.1 published input.
// weapi: two CBC layers under the verified presetKey; RSA and host untested.
// eapi: full output pinned to the published 4.41.1 tarball bytes
// (util/crypto.js sha256 45bdb719176d66d864f876da3d7436eab5d99a37f031d1f6fd5025b4191c577c).
import assert from "node:assert/strict";
import { createCipheriv, createHash, createDecipheriv } from "node:crypto";

const bytes = (value) => Buffer.from(value);
globalThis.openkara = {
  encoding: {
    utf8Encode: (value) => bytes(value),
    utf8Decode: (value) => bytes(value).toString(),
    base64Encode: (value) => bytes(value).toString("base64"),
    hexEncode: (value) => bytes(value).toString("hex"),
  },
  crypto: {
    digest: (algorithm, data) => createHash(algorithm).update(bytes(data)).digest(),
    aesEncrypt({ mode, key, iv }, data) {
      const cipher = createCipheriv(`aes-128-${mode}`, bytes(key), iv ? bytes(iv) : null);
      return Buffer.concat([cipher.update(bytes(data)), cipher.final()]);
    },
    rsaPublic: () => new Uint8Array(128),
  },
};

const { weapi, eapi } = await import("../src/crypto.mjs");
const weapiResult = weapi({ s: "fixture", csrf_token: "", e_r: false }, "abcdefghijklmnop");
assert.equal(
  createHash("sha256").update(weapiResult.params).digest("hex"),
  "56b8933cf4cae133330c192c71edec94841effa3381d6aeade2292ed9c818968",
);
console.log("weapi CBC fixed vector passed; RSA and host are not covered");

const eapiResult = eapi(
  "/api/cloudsearch/pc",
  { s: "fixture", type: 1, limit: 30, offset: 0, total: true, e_r: false },
);
assert.equal(eapiResult.params.length, 320);
assert.equal(
  createHash("sha256").update(eapiResult.params).digest("hex"),
  "cf0e8f7dfd2b0bc931de574a72a40e908458f6d2f8758686718107605fd35de0",
);
console.log("eapi pinned-input vector passed; response decrypt and host are not covered");
