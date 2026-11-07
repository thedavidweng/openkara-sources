// SPDX-License-Identifier: AGPL-3.0-only
// Bilibili Streaming Source, protocol major 2, openkara-js runtime 1.
// Endpoints and field names are ported from
// GentleM4dman/mygo-music-bilibili (MIT, see NOTICE and SOURCES.md). Audio is
// served as Bilibili's own DASH track, so nothing is transcoded. Only
// `openkara` is used; the manifest is inlined by the bundler so describe
// cannot drift from it.
//
// Track ids: `BV1xxxxxxxxx` is the first part of a video, `BV1xxxxxxxxx_p3`
// its third part. Each part of a multi-part video is one track.

import manifest from "../manifest.json" with { type: "json" };

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const REFERER = "https://www.bilibili.com/";
const API = "https://api.bilibili.com";
const PASSPORT = "https://passport.bilibili.com";
const SEARCH_PAGE = 20;
const FAVORITES_PAGE = 20;
const DETAIL_BATCH = 5;
const QR_TTL_MS = 180 * 1000;
const POLL_AFTER_MS = 2000;
const ARTWORK_SIZE = "@480w_480h_1c.jpg"; // covers are 16:9; the image server crops them square
const TRACK_ID = /^(BV[0-9A-Za-z]{10})(?:_p([2-9]|[1-9][0-9]{1,3}))?$/;
const PLAYLIST_ID = /^[1-9][0-9]{0,15}$/;
const PAGE = /^[1-9][0-9]{0,3}$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;
const SESSION_COOKIES = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"];
// Video does not exist, is not visible, is under review or is private.
const MISSING_CODES = [-404, 62002, 62004, 62012];

function fail(code, message) {
  const error = new Error(message || code.replaceAll("_", " "));
  error.code = code;
  throw error;
}

const secure = (url) => (url.startsWith("//") ? `https:${url}` : url.replace(/^http:/, "https:"));
const originOf = (url) => /^https:\/\/[^/?#]+/.exec(url)?.[0];
function resource(url) {
  if (!url) return null;
  const https = secure(url);
  if (!manifest.resource_origins.includes(originOf(https))) return null;
  return { url: https.includes("/bfs/") && !https.includes("@") ? https + ARTWORK_SIZE : https, headers: {}, expires_at: null };
}
function pageOf(cursor) {
  if (cursor === null || cursor === undefined) return 1;
  if (!PAGE.test(cursor)) fail("invalid_cursor");
  return Number(cursor);
}
// Search titles carry <em> keyword highlights. Strip tags until none are left, then decode entities;
// the host renders the result as plain text.
function plain(html) {
  let text = html;
  for (let before; before !== text; ) {
    before = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name]);
}
// "3:05" or "1:02:03" to milliseconds.
const clock = (text) => text.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
const ranged = (url, range) =>
  openkara.request({ url, headers: { referer: REFERER, "user-agent": UA, range: `bytes=${range}` }, responseType: "bytes" });
const refusal = (reason, message) => ({ kind: "refusal", refusal: { reason, message } });

let cookie = "";
let mid = "";
let session = { state: "signed_out", account: null };
let challenge = null;
let visiting;

function reset(state) {
  cookie = "";
  mid = "";
  session = { state, account: null };
  challenge = null;
  visiting = undefined;
}
function requireSession() {
  if (session.state === "signed_in") return;
  fail(session.state === "expired" ? "session_expired" : "authentication_required");
}

// Bilibili turns away anonymous API calls that carry no buvid3; the host's
// cookie jar keeps the one the front page sets.
const visit = () =>
  (visiting ??= openkara.request({ url: REFERER, method: "HEAD", headers: { "user-agent": UA } }).catch((error) => {
    visiting = undefined;
    throw error;
  }));

async function get(url, header = cookie) {
  await visit();
  const headers = { referer: REFERER, "user-agent": UA };
  if (header) headers.cookie = header;
  const res = await openkara.request({ url, headers });
  if (res.status === 412 || res.status === 429) fail("rate_limited");
  if (res.status !== 200) fail("network");
  return { body: JSON.parse(res.body), setCookies: res.setCookies };
}
function check(body) {
  if (body.code === 0) return body.data;
  if (body.code === -101) fail(session.state === "signed_in" ? "session_expired" : "authentication_required");
  if ([-352, -412, -799].includes(body.code)) fail("rate_limited");
  fail("internal", `Bilibili rejected the request (code ${body.code})`);
}

// A video, or null when Bilibili has no visible video under that id.
async function view(id) {
  const param = id.startsWith("BV") ? `bvid=${id}` : `aid=${id.slice(2)}`;
  const { body } = await get(`${API}/x/web-interface/view?${param}`);
  if (MISSING_CODES.includes(body.code)) return null;
  return check(body);
}

function exclusive(v) {
  return v.is_upower_exclusive && !v.is_upower_play
    ? { reason: "no_play_rights", message: "This video is exclusive to the uploader's paying supporters." }
    : null;
}
function tracksOf(v) {
  const multi = v.pages.length > 1;
  return v.pages.map((part) => ({
    id: part.page === 1 ? v.bvid : `${v.bvid}_p${part.page}`,
    title: multi ? part.part || `P${part.page} ${v.title}` : v.title,
    artists: [v.owner.name],
    album: multi ? v.title : null,
    duration_ms: part.duration * 1000,
    artwork: resource(v.pic),
    refusal: exclusive(v),
  }));
}
function resultTrack(r) {
  return {
    id: r.bvid,
    title: plain(r.title),
    artists: [r.author],
    album: null,
    duration_ms: clock(r.duration),
    artwork: resource(r.pic),
    refusal: null,
  };
}
function favoriteTrack(m) {
  return {
    id: m.bvid,
    title: m.title,
    artists: [m.upper.name],
    album: null,
    duration_ms: m.duration * 1000,
    artwork: resource(m.cover),
    refusal: m.attr === 9 ? { reason: "unavailable", message: "Bilibili removed this video." } : null,
  };
}

// A pasted BV or av number, a bilibili.com/video link or a b23.tv short link
// (resolved by following its redirect to the video page). Null for anything else.
async function pasted(text) {
  const short = /https:\/\/b23\.tv\/[0-9A-Za-z]+/.exec(text);
  const target = short ? (await openkara.request({ url: short[0], method: "HEAD", headers: { "user-agent": UA } })).url : text;
  const found = /^(BV[0-9A-Za-z]{10}|av[0-9]+)$|bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)/.exec(target);
  if (!found) return null;
  return { id: found[1] ?? found[2], part: Number(/[?&]p=([0-9]+)/.exec(target)?.[1] ?? 0) };
}

const valid = (value) => typeof value === "string" && COOKIE_VALUE.test(value);
async function verify(credentials) {
  if (!SESSION_COOKIES.every((name) => valid(credentials[name]))) fail("session_expired");
  const header = SESSION_COOKIES.map((name) => `${name}=${credentials[name]}`).join("; ");
  const { body } = await get(`${API}/x/web-interface/nav`, header);
  if (!body.data.isLogin) fail("session_expired", "Bilibili did not confirm the sign-in. Sign in again.");
  cookie = header;
  mid = String(body.data.mid);
  session = { state: "signed_in", account: { id: mid, display_name: body.data.uname } };
  return session;
}
// The confirmed scan hands out the session cookies in the poll's Set-Cookie
// headers and in the query of the URL it answers; values stay percent-encoded.
function scanCredentials(data, setCookies) {
  const found = {};
  for (const [, name, value] of data.url.matchAll(/[?&]([^=&]+)=([^&]*)/g)) found[name] = value;
  for (const line of setCookies) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    found[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return Object.fromEntries(SESSION_COOKIES.map((name) => [name, found[name]]));
}
function known(id) {
  if (challenge?.id !== id) fail("challenge_expired");
  return challenge;
}

const methods = {
  describe(params) {
    const majors = params?.protocol_majors;
    if (Array.isArray(majors) && !majors.includes(2)) fail("incompatible_plugin");
    return {
      protocol: { major: 2, minor: manifest.protocol.minor },
      package_id: manifest.package_id,
      source_id: manifest.source_id,
      package_version: manifest.version,
      name: manifest.name,
      description: manifest.description,
      capabilities: manifest.capabilities,
      authentication: manifest.authentication,
      requires_authentication: manifest.requires_authentication,
      session,
    };
  },

  "session.restore": async ({ credentials }) => {
    try {
      return await verify(credentials);
    } catch (error) {
      if (error.code === "session_expired") reset("expired");
      throw error;
    }
  },

  "auth.start": async () => {
    const data = check((await get(`${PASSPORT}/x/passport-login/web/qrcode/generate`)).body);
    challenge = { id: data.qrcode_key, expires: Date.now() + QR_TTL_MS, state: "pending" };
    return {
      challenge: data.qrcode_key,
      expires_at: new Date(challenge.expires).toISOString(),
      poll_after_ms: POLL_AFTER_MS,
      presentation: {
        kind: "qr",
        content: data.url,
        text: "Scan the QR code with the Bilibili app, then confirm the sign-in on your phone.",
      },
    };
  },

  "auth.poll": async (params) => {
    const current = known(params.challenge);
    if (current.state === "pending" && Date.now() >= current.expires) current.state = "expired";
    if (current.state !== "pending") return { state: current.state };
    const res = await get(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(current.id)}`);
    const data = check(res.body);
    if (data.code === 86101 || data.code === 86090) return { state: "pending", poll_after_ms: POLL_AFTER_MS };
    if (data.code === 86038) {
      current.state = "expired";
      return { state: "expired" };
    }
    if (data.code !== 0) fail("internal", `Bilibili sign-in answered code ${data.code}`);
    const credentials = scanCredentials(data, res.setCookies);
    const signedIn = await verify(credentials);
    challenge = null;
    return { state: "complete", session: signedIn, credentials };
  },

  "auth.cancel": async (params) => {
    known(params.challenge).state = "cancelled";
    return { state: "cancelled" };
  },

  "auth.sign_out": async () => {
    reset("signed_out");
    return session;
  },

  search: async ({ query, cursor }) => {
    if (typeof query !== "string" || !query.trim()) fail("invalid_request");
    const link = await pasted(query.trim());
    if (link) {
      const v = await view(link.id);
      const tracks = v ? tracksOf(v) : [];
      return { items: link.part ? tracks.filter((_, n) => n + 1 === link.part) : tracks, next_cursor: null };
    }
    const page = pageOf(cursor);
    // The wbi-signed variant is often answered with a captcha voucher and no
    // results once the front page's buvid3 cookie is sent; this one is not.
    const data = check(
      (
        await get(
          `${API}/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query.trim())}&page=${page}&page_size=${SEARCH_PAGE}`,
        )
      ).body,
    );
    return {
      items: (data.result ?? []).filter((r) => r.type === "video").map(resultTrack),
      next_cursor: page < data.numPages ? String(page + 1) : null,
    };
  },

  playlists: async ({ cursor }) => {
    requireSession();
    if (cursor !== null && cursor !== undefined) fail("invalid_cursor");
    const data = check((await get(`${API}/x/v3/fav/folder/created/list-all?up_mid=${mid}`)).body);
    return {
      items: data.list.map((folder) => ({
        id: String(folder.id),
        name: folder.title,
        description: null,
        artwork: null,
        track_count: folder.media_count,
      })),
      next_cursor: null,
    };
  },

  "playlist.tracks": async ({ playlist_id: id, cursor }) => {
    if (typeof id !== "string" || !PLAYLIST_ID.test(id)) fail("invalid_request");
    requireSession();
    const page = pageOf(cursor);
    const data = check(
      (await get(`${API}/x/v3/fav/resource/list?media_id=${id}&pn=${page}&ps=${FAVORITES_PAGE}&platform=web`)).body,
    );
    if (!data) fail("not_found", "Bilibili could not find that favorites folder.");
    return {
      playlist: {
        id,
        name: data.info.title,
        description: data.info.intro || null,
        artwork: resource(data.info.cover),
        track_count: data.info.media_count,
      },
      items: (data.medias ?? []).filter((m) => m.type === 2).map(favoriteTrack),
      next_cursor: data.has_more ? String(page + 1) : null,
    };
  },

  "tracks.get": async ({ track_ids: requested }) => {
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 100) fail("invalid_request");
    if (!requested.every((id) => typeof id === "string" && TRACK_ID.test(id))) fail("invalid_request");
    const ids = [...new Set(requested)];
    const videos = [...new Set(ids.map((id) => TRACK_ID.exec(id)[1]))];
    const found = new Map();
    for (let start = 0; start < videos.length; start += DETAIL_BATCH) {
      const batch = await Promise.all(videos.slice(start, start + DETAIL_BATCH).map(view));
      for (const v of batch) for (const track of v ? tracksOf(v) : []) found.set(track.id, track);
    }
    return {
      items: ids.filter((id) => found.has(id)).map((id) => found.get(id)),
      missing_ids: ids.filter((id) => !found.has(id)),
    };
  },

  "media.resolve": async ({ track_id: id, purpose }) => {
    const parsed = typeof id === "string" ? TRACK_ID.exec(id) : null;
    if (!parsed) fail("invalid_request");
    if (purpose !== "preview" && purpose !== "import") fail("unsupported_operation");
    const v = await view(parsed[1]);
    const part = v?.pages[Number(parsed[2] ?? 1) - 1];
    if (!part) fail("not_found", "Bilibili could not find that video.");
    const barred = exclusive(v);
    if (barred) return { kind: "refusal", refusal: barred };

    // Signed in, fnval 4048 also asks for the lossless track.
    const fnval = session.state === "signed_in" ? 4048 : 16;
    const { body } = await get(`${API}/x/player/playurl?bvid=${v.bvid}&cid=${part.cid}&fnval=${fnval}`);
    if (body.code === -10403 && /地区/.test(body.message))
      return refusal("unavailable", "Bilibili does not offer this video in your region.");
    if ([-101, -403, -10403, 87008].includes(body.code))
      return refusal("no_play_rights", "This video needs a Bilibili sign-in, membership or payment.");
    if (body.code === -404) return refusal("no_media", "Bilibili has no audio for this video.");
    const { dash, is_preview: preview } = check(body);
    if (preview) return refusal("trial_clip", "Bilibili only provides a short preview of this video.");
    const flac = dash?.flac?.audio;
    const audio = flac ?? [...(dash?.audio ?? [])].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!audio) return refusal("no_media", "Bilibili has no audio for this video.");

    // baseUrl and backupUrl are mirrors of one file; some are peer-to-peer hosts the manifest leaves out.
    const mirrors = [audio.baseUrl, ...(audio.backupUrl ?? [])]
      .map(secure)
      .filter((candidate) => manifest.media_origins.includes(originOf(candidate)));
    if (!mirrors.length)
      return refusal("unavailable", "Bilibili served this audio from a host this source package does not permit. Update the source.");
    // A mirror can serve the start of a file and answer 504 for the rest, or for all of it, while another
    // mirror is fine. Ranged GETs of the first and last byte tell them apart and report the size.
    let served;
    for (const mirror of mirrors) {
      const head = await ranged(mirror, "0-0");
      if (head.status !== 206) continue;
      const size = Number(head.headers["content-range"].split("/")[1]);
      if ((await ranged(mirror, `${size - 1}-${size - 1}`)).status === 206) {
        served = { url: mirror, size };
        break;
      }
    }
    if (!served) return refusal("unavailable", "Bilibili did not serve the audio file for this video.");
    const deadline = /[?&]deadline=([0-9]+)/.exec(served.url)?.[1];
    return {
      kind: "media",
      media: {
        url: served.url,
        headers: { Referer: REFERER, "User-Agent": UA },
        expires_at: deadline ? new Date(Number(deadline) * 1000).toISOString() : null,
        // The lossless track is FLAC inside the same fragmented MP4 container.
        content_type: "audio/mp4",
        file_extension: "m4a",
        size_bytes: served.size,
        duration_ms: part.duration * 1000,
        bit_rate: audio.bandwidth,
      },
    };
  },
};

export default methods;
