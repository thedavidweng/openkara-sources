// Offline checks of id parsing, pasted links, audio selection, refusals and the
// QR sign-in state machine against canned responses shaped like the real
// Bilibili answers. The mocked host refuses origins the manifest does not
// declare, like the real one. Live behaviour is not covered here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const declared = [...manifest.resource_origins, ...manifest.media_origins];

const UPOS = "https://upos-sz-mirrorcosov.bilivideo.com";
const AKAM = "https://upos-hz-mirrorakam.akamaized.net";
const owner = { name: "uploader" };
const single = { bvid: "BV1aaaaaaaaa", title: "Song", pic: "http://i1.hdslb.com/bfs/archive/a.jpg", owner, pages: [{ page: 1, cid: 11, part: "Song", duration: 200 }] };
const multi = {
  bvid: "BV1bbbbbbbbb",
  title: "Album",
  pic: "http://i0.hdslb.com/bfs/archive/b.jpg",
  owner,
  pages: [1, 2, 3].map((page) => ({ page, cid: 20 + page, part: page === 3 ? "" : `Track ${page}`, duration: 100 * page })),
};
const videos = { [single.bvid]: single, [multi.bvid]: multi, BV1ccccccccc: { ...single, bvid: "BV1ccccccccc", is_upower_exclusive: true, is_upower_play: false } };

const audio = (id, bandwidth, baseUrl, backupUrl = []) => ({ id, bandwidth, baseUrl, backupUrl });
let playurl; // what the next playurl call answers
let mediaStatus; // url prefix -> [head status, tail status]
let credentials; // cookies a confirmed scan hands out
let scan; // inner code the QR poll answers
let loggedIn = true;
const requested = [];
const cookies = { SESSDATA: "sess%2Cdata*c2", bili_jct: "jct", DedeUserID: "42", DedeUserID__ckMd5: "md5" };

const json = (body) => ({ status: 200, headers: {}, setCookies: [], body: JSON.stringify(body) });
globalThis.openkara = {
  async request({ url, method = "GET", headers = {} }) {
    const origin = /^https:\/\/[^/]+/.exec(url)?.[0];
    assert.ok(declared.includes(origin), `undeclared origin ${origin}`);
    requested.push({ url, headers });
    if (origin === "https://www.bilibili.com") return { status: 200, headers: {}, setCookies: [], body: null };
    if (origin === "https://b23.tv") return { status: 200, url: "https://www.bilibili.com/video/BV1bbbbbbbbb/?p=2&share=1", headers: {} };
    if (manifest.media_origins.includes(origin)) {
      const [head, tail] = Object.entries(mediaStatus).find(([prefix]) => url.startsWith(prefix))[1];
      const last = headers.range === "bytes=0-0" ? head : tail;
      return { status: last, headers: { "content-range": "bytes 0-0/5000" } };
    }
    const path = url.slice(origin.length);
    if (path.startsWith("/x/web-interface/search/type"))
      return json({ code: 0, data: { numPages: 3, result: [{ type: "ketang", id: 1 }, { type: "video", bvid: "BV1ddddddddd", title: '<em class="keyword">A</em> &amp; B', author: "a", duration: "1:02:03", pic: "//i2.hdslb.com/bfs/archive/d.jpg" }] } });
    if (path.startsWith("/x/web-interface/view")) {
      const video = videos[/bvid=([^&]+)/.exec(path)?.[1]] ?? (path.includes("aid=170001") ? single : null);
      return json(video ? { code: 0, data: video } : { code: -404, message: "gone" });
    }
    if (path.startsWith("/x/web-interface/nav")) {
      const ok = loggedIn && headers.cookie?.includes("SESSDATA=");
      return json({ code: ok ? 0 : -101, data: { isLogin: Boolean(ok), mid: 42, uname: "me" } });
    }
    if (path.startsWith("/x/player/playurl")) return json(playurl(path));
    if (path.startsWith("/x/v3/fav/folder/created/list-all")) return json({ code: 0, data: { list: [{ id: 7, title: "Default", media_count: 3 }] } });
    if (path.startsWith("/x/v3/fav/resource/list")) {
      if (path.includes("media_id=404")) return json({ code: 0, data: null });
      const more = path.includes("pn=1&");
      return json({
        code: 0,
        data: {
          info: { title: "Default", intro: "", cover: "http://i0.hdslb.com/bfs/archive/c.jpg", media_count: 3 },
          has_more: more,
          medias: [
            { type: 2, bvid: single.bvid, title: "Song", duration: 200, upper: owner, cover: "http://i0.hdslb.com/bfs/archive/a.jpg", attr: 0 },
            { type: 12, bvid: "", title: "audio", duration: 1, upper: owner },
            { type: 2, bvid: "BV1eeeeeeeee", title: "已失效视频", duration: 0, upper: owner, cover: "", attr: 9 },
          ],
        },
      });
    }
    if (path.startsWith("/x/passport-login/web/qrcode/generate")) return json({ code: 0, data: { url: "https://account.bilibili.com/scan?key=k", qrcode_key: `key${requested.length}` } });
    if (path.startsWith("/x/passport-login/web/qrcode/poll")) {
      const done = scan === 0;
      const query = Object.entries(credentials).map(([k, v]) => `${k}=${v}`).join("&");
      return {
        status: 200,
        headers: {},
        setCookies: done ? ["SESSDATA=" + credentials.SESSDATA + "; Path=/; HttpOnly"] : [],
        body: JSON.stringify({ code: 0, data: { code: scan, url: done ? `https://passport.biligame.com/crossDomain?${query}&gourl=x` : "" } }),
      };
    }
    throw new Error(`unmocked ${url}`);
  },
  crypto: {},
  encoding: {},
};

const { default: source } = await import("../src/main.mjs");
const run = async (method, params) => source[method](params);
const denied = async (method, params, code) => assert.rejects(run(method, params), (error) => error.code === code);

// describe
const described = await run("describe", { protocol_majors: [2] });
assert.equal(described.source_id, "bilibili");
assert.deepEqual(described.capabilities, manifest.capabilities);
assert.deepEqual(described.authentication, { flow: "plugin", presentations: ["qr"] });
await denied("describe", { protocol_majors: [3] }, "incompatible_plugin");

// tracks.get and track ids: bare id is part 1, _pN is part N, _p1 is not an id
const got = await run("tracks.get", { track_ids: [single.bvid, multi.bvid, `${multi.bvid}_p3`, `${multi.bvid}_p4`, "BV1zzzzzzzzz", single.bvid] });
assert.deepEqual(got.items.map((t) => t.id), [single.bvid, multi.bvid, `${multi.bvid}_p3`]);
assert.deepEqual(got.missing_ids, [`${multi.bvid}_p4`, "BV1zzzzzzzzz"]);
assert.deepEqual(got.items.map((t) => t.title), ["Song", "Track 1", "P3 Album"]);
assert.deepEqual([got.items[0].album, got.items[1].album], [null, "Album"]);
assert.equal(got.items[0].duration_ms, 200000);
assert.equal(got.items[0].artwork.url, "https://i1.hdslb.com/bfs/archive/a.jpg@480w_480h_1c.jpg");
assert.equal((await run("tracks.get", { track_ids: ["BV1ccccccccc"] })).items[0].refusal.reason, "no_play_rights");
for (const bad of [`${single.bvid}_p1`, `${single.bvid}_p0`, `${single.bvid}_p`, "BV1short", "av170001", `${single.bvid}x`, 7])
  await denied("tracks.get", { track_ids: [bad] }, "invalid_request");
await denied("tracks.get", { track_ids: [] }, "invalid_request");

// search: keywords, pagination, and pasted ids and links
const page = await run("search", { query: " 翻唱 ", cursor: null });
assert.ok(requested.at(-1).url.includes("keyword=%E7%BF%BB%E5%94%B1&page=1"));
assert.equal(page.items.length, 1, "non-video results are dropped");
assert.deepEqual([page.items[0].title, page.items[0].duration_ms, page.next_cursor], ["A & B", 3723000, "2"]);
assert.equal((await run("search", { query: "翻唱", cursor: "3" })).next_cursor, null);
assert.ok(requested.at(-1).url.includes("page=3"));
await denied("search", { query: "翻唱", cursor: "x" }, "invalid_cursor");
await denied("search", { query: "  ", cursor: null }, "invalid_request");
const ids = async (query) => (await run("search", { query, cursor: null })).items.map((t) => t.id);
assert.deepEqual(await ids(single.bvid), [single.bvid]);
assert.deepEqual(await ids("av170001"), [single.bvid]);
assert.deepEqual(await ids(`https://www.bilibili.com/video/${multi.bvid}/`), [multi.bvid, `${multi.bvid}_p2`, `${multi.bvid}_p3`]);
assert.deepEqual(await ids(`https://www.bilibili.com/video/${multi.bvid}/?spm=1&p=3`), [`${multi.bvid}_p3`]);
assert.deepEqual(await ids("【Album】 https://b23.tv/AbCd12"), [`${multi.bvid}_p2`]);
assert.deepEqual(await ids("BV1zzzzzzzzz"), []);
assert.ok(!requested.at(-1).url.includes("search/type"), "a pasted id is not a keyword search");
assert.ok(requested.some((r) => r.url.includes("search/type") && r.url.includes("avatar") === false));

// signed out: favorites need a session
await denied("playlists", { cursor: null }, "authentication_required");
await denied("playlist.tracks", { playlist_id: "7", cursor: null }, "authentication_required");

// media.resolve: audio selection, mirrors, expiry, refusals
const resolve = (id = single.bvid, purpose = "import") => run("media.resolve", { track_id: id, purpose });
const dash = (audios, flac) => ({ code: 0, data: { dash: { audio: audios, flac: flac && { audio: flac } } } });
const good = [206, 206];
mediaStatus = { [UPOS]: good, [AKAM]: good };
playurl = () =>
  dash([
    audio(30216, 64000, `${UPOS}/low.m4s?deadline=1794039118`),
    audio(30280, 192000, `http://mcdn.example.com:8082/high.m4s`, [`${UPOS}/dead.m4s?deadline=1794039118&x=1`, `${AKAM}/high.m4s`]),
  ]);
let media = (await resolve()).media;
assert.equal(media.url, `${UPOS}/dead.m4s?deadline=1794039118&x=1`, "the first mirror in a declared origin");
assert.deepEqual([media.content_type, media.file_extension, media.bit_rate, media.size_bytes, media.duration_ms], ["audio/mp4", "m4a", 192000, 5000, 200000]);
assert.equal(media.expires_at, new Date(1794039118 * 1000).toISOString());
assert.deepEqual(Object.keys(media.headers).sort(), ["Referer", "User-Agent"]);
assert.ok(requested.findLast((r) => r.url.includes("/x/player/playurl")).url.endsWith("&cid=11&fnval=16"));
assert.ok((await resolve(`${multi.bvid}_p2`, "preview")).media);
assert.ok(requested.findLast((r) => r.url.includes("/x/player/playurl")).url.includes("cid=22"));
await denied("media.resolve", { track_id: single.bvid, purpose: "lyrics" }, "unsupported_operation");
await denied("media.resolve", { track_id: `${multi.bvid}_p9`, purpose: "import" }, "not_found");

mediaStatus = { [UPOS]: [206, 504], [AKAM]: good };
assert.equal((await resolve()).media.url, `${AKAM}/high.m4s`, "a mirror failing the last byte is skipped");
mediaStatus = { [UPOS]: [504, 504], [AKAM]: [504, 504] };
assert.equal((await resolve()).refusal.reason, "unavailable");
mediaStatus = { [UPOS]: good, [AKAM]: good };

playurl = () => dash([audio(1, 1, "http://mcdn.example.com:8082/a.m4s", ["https://other.example.com/a.m4s"])]);
assert.equal((await resolve()).refusal.reason, "unavailable");
playurl = () => dash([]);
assert.equal((await resolve()).refusal.reason, "no_media");
playurl = () => ({ code: 0, data: { is_preview: 1, dash: { audio: [audio(1, 1, `${UPOS}/a.m4s`)] } } });
assert.equal((await resolve()).refusal.reason, "trial_clip");
playurl = () => ({ code: -10403, message: "抱歉您所在地区不可观看！" });
assert.equal((await resolve()).refusal.reason, "unavailable");
playurl = () => ({ code: -10403, message: "大会员专享" });
assert.equal((await resolve()).refusal.reason, "no_play_rights");
playurl = () => ({ code: -101 });
assert.equal((await resolve()).refusal.reason, "no_play_rights");
playurl = () => ({ code: -412 });
await denied("media.resolve", { track_id: single.bvid, purpose: "import" }, "rate_limited");
assert.equal((await resolve("BV1ccccccccc")).refusal.reason, "no_play_rights");

// QR sign-in state machine
credentials = cookies;
const started = await run("auth.start", {});
assert.deepEqual(started.presentation, { kind: "qr", content: "https://account.bilibili.com/scan?key=k", text: started.presentation.text });
assert.equal(started.poll_after_ms, 2000);
for (const code of [86101, 86090]) {
  scan = code;
  assert.deepEqual(await run("auth.poll", { challenge: started.challenge }), { state: "pending", poll_after_ms: 2000 });
}
await denied("auth.poll", { challenge: "other" }, "challenge_expired");

scan = 86038;
assert.deepEqual(await run("auth.poll", { challenge: started.challenge }), { state: "expired" });
scan = 86101;
assert.deepEqual(await run("auth.poll", { challenge: started.challenge }), { state: "expired" }, "expired stays expired");

const cancelled = await run("auth.start", {});
await denied("auth.poll", { challenge: started.challenge }, "challenge_expired"); // a new sign-in replaces the old challenge
assert.deepEqual(await run("auth.cancel", { challenge: cancelled.challenge }), { state: "cancelled" });
assert.deepEqual(await run("auth.cancel", { challenge: cancelled.challenge }), { state: "cancelled" });
assert.deepEqual(await run("auth.poll", { challenge: cancelled.challenge }), { state: "cancelled" });
await denied("auth.cancel", { challenge: "other" }, "challenge_expired");

const lapsing = await run("auth.start", {});
const realNow = Date.now;
Date.now = () => realNow() + 181 * 1000;
assert.deepEqual(await run("auth.poll", { challenge: lapsing.challenge }), { state: "expired" });
Date.now = realNow;

const confirming = await run("auth.start", {});
scan = 0;
const done = await run("auth.poll", { challenge: confirming.challenge });
assert.equal(done.state, "complete");
assert.deepEqual(done.credentials, cookies, "values stay percent-encoded");
assert.deepEqual(done.session, { state: "signed_in", account: { id: "42", display_name: "me" } });
assert.ok(requested.findLast((r) => r.url.includes("web-interface/nav")).headers.cookie.startsWith("SESSDATA=sess%2Cdata*c2; bili_jct=jct;"));
await denied("auth.poll", { challenge: confirming.challenge }, "challenge_expired");

// signed in: favorites and the lossless track
assert.deepEqual((await run("playlists", { cursor: null })).items, [{ id: "7", name: "Default", description: null, artwork: null, track_count: 3 }]);
assert.ok(requested.findLast((r) => r.url.includes("created/list-all")).url.endsWith("up_mid=42"));
await denied("playlists", { cursor: "1" }, "invalid_cursor");
const favorites = await run("playlist.tracks", { playlist_id: "7", cursor: null });
assert.deepEqual([favorites.playlist.name, favorites.playlist.description, favorites.playlist.track_count, favorites.next_cursor], ["Default", null, 3, "2"]);
assert.deepEqual(favorites.items.map((t) => [t.id, t.refusal?.reason ?? null]), [[single.bvid, null], ["BV1eeeeeeeee", "unavailable"]]);
assert.equal((await run("playlist.tracks", { playlist_id: "7", cursor: "2" })).next_cursor, null);
assert.ok(requested.findLast((r) => r.url.includes("fav/resource/list")).url.includes("pn=2&"));
await denied("playlist.tracks", { playlist_id: "404", cursor: null }, "not_found");
await denied("playlist.tracks", { playlist_id: "0", cursor: null }, "invalid_request");

playurl = () => dash([audio(1, 99, `${UPOS}/aac.m4s`)], audio(30251, 900000, `${AKAM}/lossless.m4s`));
media = (await resolve()).media;
assert.deepEqual([media.url, media.content_type, media.file_extension, media.bit_rate], [`${AKAM}/lossless.m4s`, "audio/mp4", "m4a", 900000]);
assert.ok(requested.findLast((r) => r.url.includes("/x/player/playurl")).url.endsWith("fnval=4048"));

// restore and sign-out
assert.equal((await run("session.restore", { credentials: cookies })).account.id, "42");
loggedIn = false;
await denied("session.restore", { credentials: cookies }, "session_expired");
assert.equal((await run("describe", {})).session.state, "expired");
await denied("playlists", { cursor: null }, "session_expired");
await denied("session.restore", { credentials: { SESSDATA: "bad value" } }, "session_expired");
assert.deepEqual(await run("auth.sign_out", {}), { state: "signed_out", account: null });
await denied("playlists", { cursor: null }, "authentication_required");
console.log("bilibili offline checks passed; live search, media, favorites and QR sign-in are not covered");
