// SPDX-License-Identifier: AGPL-3.0-only
// QuickJS upstream adapter: request construction of the NetEase API modules at
// @neteasecloudmusicapienhanced/api 4.41.1 (module/*.js + util/createOption.js
// + the eapi branch of util/request.js), aligned with the eapi request shape
// Kumone uses (LGPL-3.0, behavioral reference only; see SOURCES.md). Every
// operation goes through eapi on the interface host. Uses only the frozen
// protocol-2 host API: openkara.request for transport, openkara.crypto for the
// eapi wire, no Node globals.

import { eapi } from "./crypto.mjs";

const DOMAIN = "https://music.163.com";
const EAPI_DOMAIN = "https://interfacepc.music.163.com";
const UA_API_IPHONE = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";

// 4.41.1 osMap pc row: the exact wire defaults of the eapi header.
const OS_DEFAULTS = {
  os: "pc",
  appver: "3.1.17.204416",
  osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
  channel: "netease",
};

// ADR 0035: one China Client Address per engine run, sent as X-Real-IP on every
// call. Same generator as the Node package's upstream (api util
// generateRandomChineseIP) when its CIDR table is unavailable: the QuickJS
// sandbox has no file access, so the 116.x prefix path applies.
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
export const chinaClientAddress = `116.${randomInt(25, 94)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;

function encodeCookie(cookie) {
  const parts = [];
  for (const key of Object.keys(cookie)) {
    const value = cookie[key];
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("; ");
}

function formEncode(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

// NMTID is issued by the server; like Kumone, remember it for the eapi header
// for the rest of the engine run. The host cookie jar carries it as a cookie.
let nmtid = "";

// Parses Set-Cookie values into name -> value, skipping empty or "" values.
export function parseSetCookies(setCookies) {
  const out = {};
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    const pair = String(raw).split(";")[0];
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name && value && value !== '""') out[name] = value;
  }
  return out;
}

// Kumone MusicClient.eapi header fields, with `e_r: false`.
function buildRequest(uri, data, options) {
  const cookie = options.cookie || {};
  const headers = {};
  if (options.realIP) {
    headers["X-Real-IP"] = options.realIP;
    headers["X-Forwarded-For"] = options.realIP;
  }
  const now = Date.now();
  const header = {
    osver: OS_DEFAULTS.osver,
    deviceId: options.deviceId || "",
    os: OS_DEFAULTS.os,
    appver: OS_DEFAULTS.appver,
    versioncode: "140",
    mobilename: "",
    buildver: String(now).slice(0, 10),
    resolution: "1920x1080",
    channel: OS_DEFAULTS.channel,
    requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
    __csrf: cookie.__csrf || "",
  };
  if (cookie.MUSIC_U) header.MUSIC_U = cookie.MUSIC_U;
  if (nmtid) header.NMTID = nmtid;
  data.header = header;
  data.e_r = false;
  headers.Cookie = encodeCookie(header);
  headers["User-Agent"] = UA_API_IPHONE;
  headers.Referer = DOMAIN;
  return {
    url: `${EAPI_DOMAIN}/eapi/${uri.slice(5)}`,
    headers,
    body: formEncode(eapi(uri, data)),
  };
}

const OPERATIONS = {
  user_account: { uri: "/api/nuser/account/get", data: () => ({}) },
  user_playlist: {
    uri: "/api/user/playlist",
    data: (query) => ({
      uid: query.uid,
      limit: query.limit || 30,
      offset: query.offset || 0,
      includeVideo: true,
    }),
  },
  song_detail: {
    uri: "/api/v3/song/detail",
    data: (query) => ({
      c: `[${String(query.ids).split(/\s*,\s*/).map((id) => `{"id":${id}}`).join(",")}]`,
    }),
  },
  likelist: { uri: "/api/song/like/get", data: (query) => ({ uid: query.uid }) },
  playlist_detail: {
    uri: "/api/v6/playlist/detail",
    data: (query) => ({ id: query.id, n: 100000, s: query.s || 8 }),
  },
  cloudsearch: {
    uri: "/api/cloudsearch/pc",
    data: (query) => ({
      s: query.keywords,
      type: query.type || 1,
      limit: query.limit || 30,
      offset: query.offset || 0,
      total: true,
    }),
  },
  // Kumone songURL: playback URL by quality level.
  song_url: {
    uri: "/api/song/enhance/player/url/v1",
    data: (query) => ({ ids: `[${query.id}]`, level: query.level, encodeType: "flac" }),
  },
  // Line (lrc) and word-timed (yrc) lyrics; anonymous access works.
  song_lyric: {
    uri: "/api/song/lyric/v1",
    data: (query) => ({ id: query.id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 }),
  },
  // Kumone songDownloadURL: download eligibility is resolved separately.
  song_download_url: {
    uri: "/api/song/enhance/download/url/v1",
    data: (query) => ({ id: query.id, level: query.level }),
  },
};

export async function call(operation, query) {
  const spec = OPERATIONS[operation];
  if (!spec) throw Object.assign(new Error(`unknown operation ${operation}`), { code: "internal" });
  const built = buildRequest(spec.uri, spec.data(query), query);
  // ENCRYPT_RESPONSE is false in the frozen 4.41.1 config (e_r false), so
  // responses arrive (and parse) as plain JSON.
  const response = await openkara.request({
    url: built.url,
    method: "POST",
    headers: { ...built.headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: built.body,
  });
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw Object.assign(new Error("NetEase returned an unreadable response"), { code: "internal" });
  }
  if (body && body.code !== undefined) body.code = Number(body.code);
  const cookies = parseSetCookies(response.setCookies);
  if (cookies.NMTID) nmtid = cookies.NMTID;
  const status = body?.code;
  if (status !== undefined && status !== 200) {
    throw Object.assign(new Error(`NetEase rejected the request (code ${status})`), {
      code: "upstream",
      body: { code: status },
    });
  }
  return { status: response.status ?? 200, body, cookies };
}

export const OPERATION_NAMES = Object.keys(OPERATIONS);
