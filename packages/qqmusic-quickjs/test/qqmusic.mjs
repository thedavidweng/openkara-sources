// Offline checks of the track mapping, pagination and media resolution rules
// against canned responses shaped like the real QQ Music answers. The mocked
// host refuses origins the manifest does not declare, like the real one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const declared = [...manifest.resource_origins, ...manifest.media_origins];

const song = { songmid: "0039MnYb0qxYhV", songname: "晴天", albummid: "000MkMni19ClKG", albumname: "叶惠美", interval: 269, singer: [{ name: "周杰伦" }] };
const info = { mid: song.songmid, name: "晴天", interval: 269, singer: song.singer, album: { mid: song.albummid, name: "叶惠美" }, file: { media_mid: "003Qui1q2u1Zho", size_320mp3: 10792943, size_128mp3: 4317292 } };

let vkey; // what the next vkey call answers
let totalSize; // size the CDN reports for the next ranged media GET
let profileCookie; // cookie header of the last sign-in check
let nick = "Listener";
const requested = [];
globalThis.openkara = {
  crypto: { randomBytes: (n) => new Uint8Array(n).fill(7) },
  encoding: { base64Encode: () => "challenge" },
  async request({ url, body, headers }) {
    const origin = /^https:\/\/[^/]+/.exec(url)?.[0];
    assert.ok(declared.includes(origin), `undeclared origin ${origin}`);
    requested.push(url);
    if (url.includes("RS02003Qui1q2u1Zho")) return { status: 206, headers: { "content-range": `bytes 0-0/${totalSize}` } };
    if (url.includes("fcg_get_profile_homepage")) {
      profileCookie = headers.cookie;
      return { status: 200, body: { code: 0, data: { creator: { nick } } } };
    }
    if (url.includes("client_search_cp"))
      return { status: 200, body: { data: { song: { list: [song, { songmid: "", songname: "x", singer: [] }], totalnum: 90 } } } };
    const req = JSON.parse(body);
    if (req.req_0) return { status: 200, body: { code: 0, req_0: { data: vkey } } };
    const t0 = req.t0.param.song_mid === info.mid ? { code: 0, data: { track_info: info } } : { code: 404, data: { track_info: { mid: "" } } };
    return { status: 200, body: { code: 0, t0 } };
  },
};

const { default: source } = await import("../src/main.mjs");
const run = async (method, params) => source[method](params);
const denied = async (method, params, code) =>
  assert.rejects(run(method, params), (error) => error.code === code);

const described = await run("describe", { protocol_majors: [2] });
assert.equal(described.source_id, "qqmusic");
assert.deepEqual(described.capabilities, manifest.capabilities);
await denied("describe", { protocol_majors: [3] }, "incompatible_plugin");

const page = await run("search", { query: "晴天", cursor: null });
assert.equal(page.items.length, 1, "items without an id are dropped");
assert.equal(page.items[0].artwork.url, "https://y.gtimg.cn/music/photo_new/T002R300x300M000000MkMni19ClKG.jpg");
assert.equal(page.next_cursor, "30");
assert.equal((await run("search", { query: "晴天", cursor: "60" })).next_cursor, null);
assert.ok(requested.at(-1).includes("&p=3&"));
await denied("search", { query: "晴天", cursor: "x" }, "invalid_cursor");

const got = await run("tracks.get", { track_ids: [info.mid, info.mid] });
assert.deepEqual(got.items.map((track) => track.id), [info.mid]);
assert.deepEqual((await run("tracks.get", { track_ids: ["missing"] })).missing_ids, ["missing"]);
await denied("playlists", { cursor: null }, "authentication_required");

const resolve = (purpose = "import") => run("media.resolve", { track_id: info.mid, purpose });
const granted = { sip: ["http://aqqmusic.tc.qq.com/"], expiration: 80400, midurlinfo: [{ purl: "" }, { purl: "RS02003Qui1q2u1Zho.mp3?vkey=1" }] };

vkey = { sip: [], midurlinfo: [{ purl: "" }, { purl: "" }] };
assert.equal((await resolve()).refusal.reason, "no_play_rights");

vkey = { ...granted, sip: ["http://unlisted.stream.qqmusic.qq.com/"] };
assert.equal((await resolve()).refusal.reason, "unavailable");

vkey = granted;
totalSize = 960887;
assert.equal((await resolve("preview")).refusal.reason, "trial_clip");

totalSize = info.file.size_128mp3;
const media = (await resolve()).media;
assert.equal(media.url, "https://aqqmusic.tc.qq.com/RS02003Qui1q2u1Zho.mp3?vkey=1");
assert.deepEqual([media.file_extension, media.bit_rate, media.size_bytes], ["mp3", 128000, info.file.size_128mp3]);
const challenge = (await run("auth.start", {})).challenge;
const wechat = await run("auth.complete", {
  challenge,
  credentials: { wxuin: "1152921504000000001", qm_keyst: "W_X_key" },
});
assert.deepEqual(wechat.credentials, { uin: "1152921504000000001", qm_keyst: "W_X_key" }, "a WeChat account is stored as uin");
assert.equal(wechat.session.account.id, "1152921504000000001");
nick = "\u200b\u3000";
const blank = await run("session.restore", { credentials: { uin: "1152921504000000001", qm_keyst: "W_X_key" } });
assert.equal(blank.account.display_name, "QQ 1152921504000000001", "an invisible nickname falls back to the id");
nick = "Listener";
assert.match(profileCookie, /^uin=1152921504000000001; .*tmeLoginType=1$/);
await run("session.restore", { credentials: { uin: "o0123456", qm_keyst: "Q_H_L_key" } });
assert.match(profileCookie, /^uin=o0123456; .*tmeLoginType=2$/);

console.log("qqmusic offline checks passed; network and vkey are not covered");
