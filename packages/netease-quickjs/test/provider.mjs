// Offline provider checks with a stubbed host: China Client Address, device id,
// eapi routing, song URL levels, trial detection, and web sign-in.
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

// An APE download is not decodable, so import falls back to the player API.
requests.length = 0;
responder = ({ uri }) =>
  uri === "/api/v3/song/detail"
    ? { code: 200, songs: [song()], privileges: [privilege] }
    : uri === "/api/song/enhance/download/url/v1"
      ? { code: 200, data: { ...goodUrl, url: "https://m801.music.126.net/a.ape", type: "APE", encodeType: "mp3" } }
      : uri === "/api/song/enhance/player/url/v1"
        ? { code: 200, data: [goodUrl] }
        : { code: 200 };
resolved = await methods["media.resolve"]({ track_id: "7", purpose: "import" });
assert.equal(resolved.kind, "media");
assert.equal(resolved.media.file_extension, "flac");
assert.equal(requests.find((r) => r.uri === "/api/song/enhance/player/url/v1").data.level, "lossless");

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

// Web sign-in: the official page supplies the cookies, NetEase confirms them.
await methods["auth.sign_out"]();
requests.length = 0;
const start = await methods["auth.start"]();
assert.deepEqual(start.presentation, { kind: "web" });
assert.equal(requests.length, 0);
await assert.rejects(methods["auth.poll"]({ challenge: start.challenge }), { code: "unsupported_operation" });
await assert.rejects(methods["auth.complete"]({ challenge: start.challenge, credentials: { MUSIC_U: "x" } }), {
  code: "authentication_required",
});
await assert.rejects(methods["auth.complete"]({ challenge: "unknown", credentials }), { code: "challenge_expired" });
responder = ({ uri }) =>
  uri === "/api/nuser/account/get" ? { setCookies: ["NMTID=nm; Path=/"], body: account } : { code: 200 };
const done = await methods["auth.complete"]({ challenge: start.challenge, credentials });
assert.deepEqual(done.credentials, credentials);
assert.equal(done.session.account.id, "42");
assert.equal(requests.at(-1).data.header.MUSIC_U, credentials.MUSIC_U);
await methods["search"]({ query: "a", cursor: null }).catch(() => {});
assert.match(requests.at(-1).headers.Cookie, /NMTID=nm/);

console.log("provider checks ok");
