// SPDX-License-Identifier: AGPL-3.0-only
// QQ Music Streaming Source, protocol major 2, openkara-js runtime 1.
// Endpoints and field names are ported from dddaniel1/mygo-plugin-qqmusic
// (MIT, see NOTICE and SOURCES.md). Only `openkara` is used; the manifest is
// inlined by the bundler so describe cannot drift from it.

import manifest from "../manifest.json" with { type: "json" };

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const REFERER = "https://y.qq.com/";
const MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json";
const SEARCH_PAGE = 30;
const TRACK_PAGE = 100;
const PLAYLIST_PAGE = 40;
const DETAIL_BATCH = 30; // musicu answers code 500000 above roughly 40 requests
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
// Best first. A file size of 0 means QQ Music has no such file for the track.
const QUALITIES = [
  ["RS03", "size_320mp3", 320000],
  ["RS02", "size_128mp3", 128000],
];
const TRACK_ID = /^[0-9A-Za-z]{1,32}$/;
const PLAYLIST_ID = /^[1-9][0-9]{0,15}$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;
const UIN = /^o?[0-9]{1,20}$/;

function fail(code, message) {
  const error = new Error(message || code.replaceAll("_", " "));
  error.code = code;
  throw error;
}

const secure = (url) => url.replace(/^http:/, "https:");
const originOf = (url) => /^https:\/\/[^/?#]+/.exec(url)?.[0];
function resource(url) {
  const https = secure(url);
  return manifest.resource_origins.includes(originOf(https))
    ? { url: https, headers: {}, expires_at: null }
    : null;
}
function offsetOf(cursor) {
  if (cursor === null || cursor === undefined) return 0;
  if (!/^[0-9]{1,9}$/.test(cursor)) fail("invalid_cursor");
  return Number(cursor);
}
// QQ Music's login-key hash, sent as g_tk; 5381 when anonymous.
function hash33(text) {
  let n = 5381;
  for (let i = 0; i < text.length; i++) n += (n << 5) + text.charCodeAt(i);
  return n & 0x7fffffff;
}

const guid = String(1e9 + (openkara.crypto.randomBytes(4).reduce((n, b) => n * 256 + b, 0) % 9e9));
let cookie = "";
let gtk = 5381;
let uin = "";
let session = { state: "signed_out", account: null };
let challenge = null;

function reset(state) {
  cookie = "";
  gtk = 5381;
  uin = "";
  session = { state, account: null };
  challenge = null;
}
function requireSession() {
  if (session.state === "signed_in") return;
  fail(session.state === "expired" ? "session_expired" : "authentication_required");
}

async function call(url, { method = "GET", body, cookie: header = cookie } = {}) {
  const headers = { referer: REFERER, "user-agent": UA };
  if (header) headers.cookie = header;
  if (body) headers["content-type"] = "application/json";
  const res = await openkara.request({
    url,
    method,
    headers,
    body: body && JSON.stringify(body),
    responseType: "json",
  });
  if (res.status === 429) fail("rate_limited");
  if (res.status !== 200) fail("network");
  return res.body;
}
async function musicu(data) {
  const body = await call(`${MUSICU}&g_tk=${gtk}`, { method: "POST", body: data });
  if (body.code !== 0) fail("internal", `QQ Music rejected the request (code ${body.code})`);
  return body;
}

// Search results use flat songmid/songname keys; detail and playlist items
// use mid/name with a nested album.
function toTrack(s) {
  const albumMid = s.albummid || s.album?.mid;
  return {
    id: s.songmid || s.mid,
    title: s.songname || s.name,
    artists: s.singer.map((artist) => artist.name),
    album: s.albumname || s.album?.name || null,
    duration_ms: s.interval ? s.interval * 1000 : null,
    artwork: albumMid
      ? resource(`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`)
      : null,
    refusal: null,
  };
}
const toTracks = (list) => list.map(toTrack).filter((track) => track.id && track.title);

async function details(ids) {
  const found = new Map();
  for (let start = 0; start < ids.length; start += DETAIL_BATCH) {
    const batch = ids.slice(start, start + DETAIL_BATCH);
    const request = { comm: { ct: 24, cv: 0 } };
    batch.forEach((mid, n) => {
      request[`t${n}`] = {
        module: "music.pf_song_detail_svr",
        method: "get_song_detail_yqq",
        param: { song_mid: mid },
      };
    });
    const body = await musicu(request);
    batch.forEach((mid, n) => {
      const info = body[`t${n}`]?.data?.track_info; // code 404 carries an empty mid
      if (info?.mid === mid) found.set(mid, info);
    });
  }
  return found;
}

// A QQ sign-in names the account cookie `uin`; a WeChat sign-in names it `wxuin`.
function account({ uin, wxuin, qm_keyst: key }) {
  return { uin: uin ?? wxuin, qm_keyst: key };
}

// WeChat accounts can carry a nickname made only of invisible characters.
const visible = (text) => typeof text === "string" && /[^\p{Cc}\p{Cf}\p{Z}]/u.test(text);

async function verify(credentials) {
  const { uin: rawUin, qm_keyst: key } = account(credentials);
  if (!UIN.test(rawUin) || !COOKIE_VALUE.test(key)) fail("session_expired");
  const id = rawUin.replace(/^o?0*/, "");
  const loginType = key.startsWith("W_X") ? 1 : 2;
  const header = `uin=${rawUin}; qm_keyst=${key}; qqmusic_key=${key}; tmeLoginType=${loginType}`;
  const tk = hash33(key);
  const body = await call(
    "https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?cv=4747474&ct=24&format=json" +
      `&inCharset=utf-8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&uin=${id}` +
      `&g_tk_new_20200303=${tk}&g_tk=725250446&cid=205360838&userid=${id}&reqfrom=1&reqtype=0` +
      `&hostUin=0&loginUin=${id}`,
    { cookie: header },
  );
  const creator = body.data?.creator; // a rejected key answers code 1000 with empty data
  if (!creator) fail("session_expired", "QQ Music did not confirm the sign-in. Sign in again.");
  cookie = header;
  gtk = tk;
  uin = id;
  session = {
    state: "signed_in",
    account: { id, display_name: visible(creator.nick) ? creator.nick.trim() : `QQ ${id}` },
  };
  return session;
}

function refusal(reason, message) {
  return { kind: "refusal", refusal: { reason, message } };
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
    const id = openkara.encoding.base64Encode(openkara.crypto.randomBytes(18), {
      urlSafe: true,
      padding: false,
    });
    const expires = Date.now() + CHALLENGE_TTL_MS;
    challenge = { id, expires };
    return { challenge: id, expires_at: new Date(expires).toISOString(), presentation: { kind: "web" } };
  },

  "auth.complete": async (params) => {
    if (challenge?.id !== params.challenge || Date.now() >= challenge.expires) fail("challenge_expired");
    const signedIn = await verify(params.credentials);
    challenge = null;
    return { session: signedIn, credentials: account(params.credentials) };
  },

  "auth.cancel": async (params) => {
    if (challenge?.id !== params.challenge) fail("challenge_expired");
    challenge = null;
    return { state: "cancelled" };
  },

  "auth.sign_out": async () => {
    reset("signed_out");
    return session;
  },

  search: async ({ query, cursor }) => {
    if (typeof query !== "string" || !query.trim()) fail("invalid_request");
    const offset = offsetOf(cursor);
    const body = await call(
      "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&remoteplace=txt.yqq.top" +
        "&t=0&aggr=0&cr=1&catZhida=0&lossless=0&flag_qc=0" +
        `&p=${offset / SEARCH_PAGE + 1}&n=${SEARCH_PAGE}&w=${encodeURIComponent(query)}&format=json&g_tk=${gtk}`,
    );
    const song = body.data.song;
    const next = offset + SEARCH_PAGE;
    return {
      items: toTracks(song.list),
      next_cursor: song.list.length > 0 && next < song.totalnum ? String(next) : null,
    };
  },

  playlists: async ({ cursor }) => {
    requireSession();
    const offset = offsetOf(cursor);
    const body = await call(
      "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?cv=4747474&ct=24&format=json" +
        "&inCharset=utf-8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=1" +
        `&uin=${uin}&hostuin=${uin}&sin=${offset}&size=${PLAYLIST_PAGE}&g_tk=${gtk}`,
    );
    const list = body.data.disslist;
    const next = offset + list.length;
    return {
      items: list
        .filter((diss) => diss.tid > 0)
        .map((diss) => ({
          id: String(diss.tid),
          name: diss.diss_name,
          description: null,
          artwork: diss.diss_cover ? resource(diss.diss_cover) : null,
          track_count: diss.song_cnt,
        })),
      next_cursor: list.length === PLAYLIST_PAGE ? String(next) : null,
    };
  },

  "playlist.tracks": async ({ playlist_id: id, cursor }) => {
    if (!PLAYLIST_ID.test(id)) fail("invalid_request");
    const begin = offsetOf(cursor);
    const { pl } = await musicu({
      comm: { ct: 24, cv: 1859 },
      pl: {
        module: "music.srfDissInfo.aiDissInfo",
        method: "uniform_get_Dissinfo",
        param: { song_begin: begin, song_num: TRACK_PAGE, disstid: Number(id), ctx: 1 },
      },
    });
    if (pl.code === 10006) fail("authentication_required");
    const data = pl.data;
    if (data?.code !== 0) fail("not_found", "QQ Music could not find that playlist.");
    const info = data.dirinfo;
    const next = begin + data.songlist.length;
    return {
      playlist: {
        id,
        name: info.title,
        description: info.desc || null,
        artwork: info.picurl ? resource(info.picurl) : null,
        track_count: data.total_song_num,
      },
      items: toTracks(data.songlist.map((item) => item.songinfo || item)),
      next_cursor: data.songlist.length > 0 && next < data.total_song_num ? String(next) : null,
    };
  },

  "tracks.get": async ({ track_ids: requested }) => {
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 100) fail("invalid_request");
    if (!requested.every((id) => typeof id === "string" && TRACK_ID.test(id))) fail("invalid_request");
    const ids = [...new Set(requested)];
    const found = await details(ids);
    return {
      items: toTracks(ids.filter((id) => found.has(id)).map((id) => found.get(id))),
      missing_ids: ids.filter((id) => !found.has(id)),
    };
  },

  "media.resolve": async ({ track_id: id, purpose }) => {
    if (typeof id !== "string" || !TRACK_ID.test(id)) fail("invalid_request");
    if (purpose !== "preview" && purpose !== "import") fail("unsupported_operation");
    const info = (await details([id])).get(id);
    if (!info) fail("not_found", "QQ Music could not find that track.");
    const offered = QUALITIES.filter(([, sizeKey]) => info.file[sizeKey] > 0);
    if (!offered.length) return refusal("no_media", "QQ Music has no audio file for this track.");

    const { req_0: vkey } = await musicu({
      comm: { uin, format: "json", ct: 24, cv: 0 },
      req_0: {
        module: "vkey.GetVkeyServer",
        method: "CgiGetVkey",
        param: {
          guid,
          songmid: offered.map(() => id),
          filename: offered.map(([prefix]) => `${prefix}${info.file.media_mid}.mp3`),
          songtype: offered.map(() => 0),
          uin,
          loginflag: 1,
          platform: "20",
        },
      },
    });
    const granted = vkey.data.midurlinfo.findIndex((entry) => entry.purl);
    if (granted < 0)
      return refusal(
        "no_play_rights",
        "QQ Music gave no play URL for this track. It may need VIP or a signed-in account, or be unavailable in your region.",
      );
    const sip = vkey.data.sip.map(secure).find((origin) => manifest.media_origins.includes(originOf(origin)));
    if (!sip)
      return refusal(
        "unavailable",
        "QQ Music served this audio from a host this source package does not permit. Update the source.",
      );

    const [, sizeKey, bitRate] = offered[granted];
    const url = sip + vkey.data.midurlinfo[granted].purl;
    // Past the account's rights QQ Music serves a short clip under the same file
    // name. A ranged GET reports the real size; the CDN answers HEAD with 401 at times.
    const probe = await openkara.request({
      url,
      headers: { referer: REFERER, range: "bytes=0-0" },
      responseType: "bytes",
    });
    if (probe.status !== 206) return refusal("unavailable", "QQ Music did not serve the audio file for this track.");
    const size = Number(probe.headers["content-range"].split("/")[1]);
    if (size < info.file[sizeKey] / 2)
      return refusal("trial_clip", "QQ Music only provides a short preview clip of this track.");
    const lifetime = vkey.data.expiration;
    return {
      kind: "media",
      media: {
        url,
        headers: { Referer: REFERER },
        expires_at: lifetime > 0 ? new Date(Date.now() + lifetime * 1000).toISOString() : null,
        content_type: "audio/mpeg",
        file_extension: "mp3",
        size_bytes: size,
        duration_ms: info.interval ? info.interval * 1000 : null,
        bit_rate: bitRate,
      },
    };
  },
};

export default methods;
