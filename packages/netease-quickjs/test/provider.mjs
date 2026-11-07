// Offline provider checks with a stubbed host: China Client Address, device id,
// eapi routing, song URL levels, trial detection, and QR sign-in.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const bytes = (value) => Buffer.from(value);
const storage = new Map();
const requests = [];
let responder = () => ({ code: 200 });

globalThis.openkara = {
  encoding: {
    utf8Encode: (value) => bytes(value),
    utf8Decode: (value) => bytes(value).toString(),
    base64Encode: (value, options = {}) => {
      const text = bytes(value).toString("base64");
      return options.urlSafe ? text.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : text;
    },
    hexEncode: (value) => bytes(value).toString("hex"),
  },
  crypto: {
    digest: (algorithm, data) => createHash(algorithm).update(bytes(data)).digest(),
    aesEncrypt({ mode, key, iv }, data) {
      const cipher = createCipheriv(`aes-128-${mode}`, bytes(key), iv ? bytes(iv) : null);
      return Buffer.concat([cipher.update(bytes(data)), cipher.final()]);
    },
    randomBytes: (length) => randomBytes(length),
  },
  storage: {
    get: (key) => storage.get(key),
    set: (key, value) => storage.set(key, value),
  },
  async request(options) {
    const decipher = createDecipheriv("aes-128-ecb", "e82ckenh8dichen8", null);
    const params = new URLSearchParams(options.body).get("params");
    const plain = Buffer.concat([decipher.update(Buffer.from(params, "hex")), decipher.final()]).toString();
    const [uri, json] = plain.split("-36cd479b6b5-");
    const entry = { url: options.url, headers: options.headers, uri, data: JSON.parse(json) };
    requests.push(entry);
    const reply = responder(entry);
    return { status: 200, setCookies: reply.setCookies ?? [], body: JSON.stringify(reply.body ?? reply) };
  },
};

const { default: methods } = await import("../src/main.mjs");
const credentials = { MUSIC_U: "synthetic-token", __csrf: "synthetic-csrf" };
const account = { code: 200, account: { id: 42 }, profile: { nickname: "Tester" } };
const song = (extra = {}) => ({ id: 7, name: "Song", dt: 200000, ar: [], al: {}, fee: 0, ...extra });
const privilege = { id: 7, pl: 320000 };

responder = ({ uri }) => (uri === "/api/nuser/account/get" ? account : { code: 200 });
await methods["session.restore"]({ credentials });

// Device id: 52 uppercase hex, persisted, sent as header field and cookie.
const deviceId = storage.get("device-id");
assert.match(deviceId, /^[0-9A-F]{52}$/);
assert.equal(requests[0].data.header.deviceId, deviceId);
assert.match(requests[0].headers.Cookie, new RegExp(`deviceId=${deviceId}`));
assert.equal(requests[0].data.e_r, false);
assert.equal(requests[0].data.header.MUSIC_U, credentials.MUSIC_U);
assert.equal(requests[0].headers["X-Real-IP"].split(".").length, 4);

function mediaReply(path, data) {
  return ({ uri }) => {
    if (uri === "/api/v3/song/detail") return { code: 200, songs: [song()], privileges: [privilege] };
    if (uri === path) return { code: 200, data };
    return { code: 200 };
  };
}
const goodUrl = { id: 7, url: "https://m801.music.126.net/a.flac", type: "flac", time: 200000 };

// Preview: player v1 at exhigh.
requests.length = 0;
responder = mediaReply("/api/song/enhance/player/url/v1", [goodUrl]);
let resolved = await methods["media.resolve"]({ track_id: "7", purpose: "preview" });
assert.equal(resolved.media.file_extension, "flac");
const playerCall = requests.find((r) => r.uri === "/api/song/enhance/player/url/v1");
assert.deepEqual([playerCall.data.ids, playerCall.data.level, playerCall.data.encodeType], ["[7]", "exhigh", "flac"]);

// Import: download endpoint at lossless.
requests.length = 0;
responder = mediaReply("/api/song/enhance/download/url/v1", goodUrl);
resolved = await methods["media.resolve"]({ track_id: "7", purpose: "import" });
assert.equal(resolved.kind, "media");
const downloadCall = requests.find((r) => r.uri === "/api/song/enhance/download/url/v1");
assert.deepEqual([downloadCall.data.id, downloadCall.data.level], ["7", "lossless"]);
assert.equal(requests.some((r) => r.uri.endsWith("/player/url/v1")), false);

// Import falls back to player v1 at lossless without a download URL.
requests.length = 0;
responder = ({ uri }) =>
  uri === "/api/v3/song/detail"
    ? { code: 200, songs: [song()], privileges: [privilege] }
    : uri === "/api/song/enhance/player/url/v1"
      ? { code: 200, data: [goodUrl] }
      : { code: 200, data: { id: 7, url: null } };
resolved = await methods["media.resolve"]({ track_id: "7", purpose: "import" });
assert.equal(resolved.kind, "media");
assert.equal(requests.find((r) => r.uri === "/api/song/enhance/player/url/v1").data.level, "lossless");

// Undeclared media host keeps the unavailable refusal.
responder = mediaReply("/api/song/enhance/player/url/v1", [{ ...goodUrl, url: "https://m9.music.126.net/a.flac" }]);
resolved = await methods["media.resolve"]({ track_id: "7", purpose: "preview" });
assert.equal(resolved.refusal.reason, "unavailable");

// Trial: duration mismatch beyond max(2 s, 3%) refuses; within tolerance plays.
responder = mediaReply("/api/song/enhance/player/url/v1", [{ ...goodUrl, time: 30000 }]);
resolved = await methods["media.resolve"]({ track_id: "7", purpose: "preview" });
assert.equal(resolved.refusal.reason, "trial_clip");
responder = mediaReply("/api/song/enhance/player/url/v1", [{ ...goodUrl, time: 205000 }]);
resolved = await methods["media.resolve"]({ track_id: "7", purpose: "preview" });
assert.equal(resolved.kind, "media");

// One China Client Address, and every operation on eapi.
const addresses = new Set(requests.map((r) => r.headers["X-Real-IP"]));
assert.equal(addresses.size, 1);
assert.ok(requests.every((r) => r.url.startsWith("https://interfacepc.music.163.com/eapi/")));

// QR sign-in.
await methods["auth.sign_out"]();
requests.length = 0;
responder = ({ uri }) => (uri === "/api/login/qrcode/unikey" ? { code: 200, unikey: "KEY1" } : { code: 200 });
const start = await methods["auth.start"]();
assert.equal(start.presentation.kind, "qr");
assert.equal(start.presentation.content, "https://music.163.com/login?codekey=KEY1");
assert.equal(requests[0].data.type, 3);

for (const [code, state] of [[801, "pending"], [802, "pending"], [800, "expired"]]) {
  responder = () => ({ code: 200, unikey: "KEY1" });
  const second = code === 800 ? await methods["auth.start"]() : start;
  responder = () => ({ code });
  const polled = await methods["auth.poll"]({ challenge: second.challenge });
  assert.equal(polled.state, state);
}
responder = () => ({ code: 200, unikey: "KEY2" });
const fresh = await methods["auth.start"]();
responder = ({ uri }) =>
  uri === "/api/login/qrcode/client/login"
    ? { code: 803, setCookies: ["MUSIC_U=new-token; Path=/", "__csrf=new-csrf; Path=/", "NMTID=nm; Path=/"] }
    : account;
const done = await methods["auth.poll"]({ challenge: fresh.challenge });
assert.equal(done.state, "complete");
assert.deepEqual(done.credentials, { MUSIC_U: "new-token", __csrf: "new-csrf" });
assert.equal(done.session.account.id, "42");
const check = requests.findLast((r) => r.uri === "/api/login/qrcode/client/login");
assert.deepEqual([check.data.key, check.data.type], ["KEY2", 3]);
assert.match(requests.at(-1).headers.Cookie, /NMTID=nm/);
await assert.rejects(methods["auth.complete"]({}), { code: "unsupported_operation" });

console.log("provider checks ok");
