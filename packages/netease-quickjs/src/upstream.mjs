// SPDX-License-Identifier: AGPL-3.0-only
// QuickJS upstream adapter: implements the exact request construction of the
// seven NetEase API modules at @neteasecloudmusicapienhanced/api 4.41.1
// (module/*.js + util/createOption.js + util/request.js crypto branches),
// using only the frozen protocol-2 host API: openkara.request for transport,
// openkara.crypto for weapi/eapi wire, no Node globals. Transport details
// below mirror request.js for the weapi/eapi paths the seven operations use.

import { weapi, eapi, randomKey16 } from "./crypto.mjs";

const DOMAIN = "https://music.163.com";
const EAPI_DOMAIN = "https://interfacepc.music.163.com";

// UA strings from util/request.js userAgentMap for the paths we use.
const UA_WEAPI_PC =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_API_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1";

function encodeCookie(cookie) {
  const parts = [];
  for (const key of Object.keys(cookie)) {
    const value = cookie[key];
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("; ");
}

function toCookieObject(cookie) {
  if (!cookie) return {};
  if (typeof cookie === "object") return { ...cookie };
  const out = {};
  for (const part of String(cookie).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

// request.js processCookieObject, trimmed to the eapi/weapi paths: keeps the
// remember-me defaults and the MUSIC_A anonymous fallback; os/device/channel
// defaults only matter to xeapi/neapi signatures, never to the weapi/eapi
// query bodies the seven operations send, so they stay unset here.
function processCookie(cookie) {
  const out = {
    ...cookie,
    __remember_me: "true",
    _ntes_nuid: cookie._ntes_nuid || randomHex(32),
    _ntes_nnid: cookie._ntes_nnid || `${randomHex(32)},${Date.now()}`,
  };
  if (!out.MUSIC_U) out.MUSIC_A = out.MUSIC_A || "";
  return out;
}

function randomHex(length) {
  const bytes = openkara.crypto.randomBytes(Math.ceil(length / 2));
  let hex = openkara.encoding.hexEncode(bytes);
  while (hex.length < length) hex += openkara.encoding.hexEncode(openkara.crypto.randomBytes(1));
  return hex.slice(0, length);
}

function toBoolean(value) {
  if (value === "true" || value === "false") return value === "true";
  return !!value;
}

// Builds { url, headers, body } exactly as request.js does for the given
// crypto branch, with csrf_token / e_r / header fields included.
function buildRequest(crypto, uri, data, options) {
  const cookie = processCookie(toCookieObject(options.cookie));
  const csrfToken = cookie.__csrf || "";
  const headers = options.headers ? { ...options.headers } : {};
  const realIP = options.realIP || "";
  if (realIP) {
    headers["X-Real-IP"] = realIP;
    headers["X-Forwarded-For"] = realIP;
  }
  data.e_r = toBoolean(options.e_r !== undefined ? options.e_r : data.e_r !== undefined ? data.e_r : false);

  if (crypto === "weapi") {
    headers.Referer = DOMAIN;
    headers["User-Agent"] = options.ua || UA_WEAPI_PC;
    data.csrf_token = csrfToken;
    const encrypted = weapi(data, randomKey16());
    return {
      url: `${DOMAIN}/weapi/${uri.slice(5)}`,
      headers: { ...headers, Cookie: encodeCookie(cookie) },
      body: new URLSearchParams(encrypted).toString(),
    };
  }

  // eapi (default when APP_CONF.encrypt is true, as in the frozen 4.41.1 config).
  const header = {
    osver: cookie.osver,
    deviceId: cookie.deviceId,
    os: cookie.os,
    appver: cookie.appver,
    versioncode: cookie.versioncode || "140",
    mobilename: cookie.mobilename || "",
    buildver: cookie.buildver || String(Date.now()).slice(0, 10),
    resolution: cookie.resolution || "1920x1080",
    __csrf: csrfToken,
    channel: cookie.channel,
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
  };
  if (cookie.MUSIC_U) header.MUSIC_U = cookie.MUSIC_U;
  if (cookie.MUSIC_A) header.MUSIC_A = cookie.MUSIC_A;
  if (cookie.NMTID) header.NMTID = cookie.NMTID;
  data.header = header;
  headers.Cookie = encodeCookie(header);
  headers["User-Agent"] = options.ua || UA_API_IPHONE;
  const encrypted = eapi(uri, data);
  return {
    url: `${EAPI_DOMAIN}/eapi/${uri.slice(5)}`,
    headers,
    body: new URLSearchParams(encrypted).toString(),
  };
}

const OPERATIONS = {
  // query/crypto/url triplets copied from module/*.js + createOption(query).
  user_account: { uri: "/api/nuser/account/get", crypto: "weapi", data: () => ({}) },
  user_playlist: {
    uri: "/api/user/playlist",
    crypto: "weapi",
    data: (query) => ({
      uid: query.uid,
      limit: query.limit || 30,
      offset: query.offset || 0,
      includeVideo: true,
    }),
  },
  song_detail: {
    uri: "/api/v3/song/detail",
    crypto: "weapi",
    data: (query) => ({
      c: `[${String(query.ids).split(/\s*,\s*/).map((id) => `{"id":${id}}`).join(",")}]`,
    }),
  },
  likelist: { uri: "/api/song/like/get", crypto: "eapi", data: (query) => ({ uid: query.uid }) },
  playlist_detail: {
    uri: "/api/v6/playlist/detail",
    crypto: "eapi",
    data: (query) => ({ id: query.id, n: 100000, s: query.s || 8 }),
  },
  cloudsearch: {
    uri: "/api/cloudsearch/pc",
    crypto: "eapi",
    data: (query) => ({
      s: query.keywords,
      type: query.type || 1,
      limit: query.limit || 30,
      offset: query.offset || 0,
      total: true,
    }),
  },
  song_url: { uri: "/api/song/enhance/player/url", crypto: "eapi", data: (query) => ({}) },
};

export async function call(operation, query) {
  const spec = OPERATIONS[operation];
  if (!spec) throw Object.assign(new Error(`unknown operation ${operation}`), { code: "internal" });
  // song_url sorts the response by requested ids (module/song_url.js).
  const isSongUrl = operation === "song_url";
  const ids = isSongUrl ? String(query.id).split(",") : null;
  const data = isSongUrl
    ? { ids: JSON.stringify(ids), br: parseInt(query.br || 999000, 10) }
    : spec.data(query);
  const built = buildRequest(spec.crypto, spec.uri, data, query);
  // request.js: ENCRYPT_RESPONSE is false in the frozen 4.41.1 config, so
  // use_e_r is false and responses arrive (and parse) as plain JSON.
  const response = await openkara.request({
    url: built.url,
    method: "POST",
    headers: { ...built.headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: built.body,
    timeoutMs: query.timeout && query.timeout > 0 ? query.timeout : 25000,
  });
  let body;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    throw Object.assign(new Error("NetEase returned an unreadable response"), { code: "internal" });
  }
  if (body && body.code !== undefined) body.code = Number(body.code);
  if (isSongUrl && body?.code === 200 && Array.isArray(body?.data)) {
    body.data.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
  }
  const status = body?.code;
  if (status !== undefined && status !== 200) {
    throw Object.assign(new Error(`NetEase rejected the request (code ${status})`), {
      code: "upstream",
      body: { code: status },
    });
  }
  return { status: response.status ?? 200, body, cookie: [] };
}

export const OPERATION_NAMES = Object.keys(OPERATIONS);
