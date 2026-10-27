// SPDX-License-Identifier: AGPL-3.0-only
// NetEase Streaming Source, protocol major 2, openkara-js runtime 1.
// Pure provider logic ported from packages/netease/src/netease.mjs plus the
// protocol-2/host-API seams: describe carries the offer check and manifest
// identity, storage is never used (credentials live in the host keychain and
// the host cookie jar), timers/signals come from the call context the host
// provides. No Node or browser globals: only `openkara`, setTimeout and
// clearTimeout exist beside this module.

import { call as upstreamCall } from "./upstream.mjs";

// Manifest identity, mirrored here so describe answers without I/O. Keep in
// sync with ../manifest.json.
const MANIFEST = {
  package_id: "org.openkara.netease-quickjs",
  source_id: "netease",
  version: "2.0.0",
  name: "NetEase Cloud Music",
  description: "Browse your NetEase Cloud Music library and preview or import full-length tracks you are permitted to play.",
  capabilities: [
    "search",
    "liked_tracks",
    "playlists",
    "playlist_tracks",
    "track_details",
    "preview",
    "import",
  ],
  authentication: {
    flow: "web",
    sign_in_url: "https://music.163.com/#/login",
    navigation_origins: ["https://music.163.com"],
    cookie_names: ["MUSIC_U", "__csrf"],
  },
  requires_authentication: [
    "search",
    "liked_tracks",
    "playlists",
    "playlist.tracks",
    "tracks.get",
    "media.resolve",
  ],
};

const PAGE_SIZE = { search: 30, liked_tracks: 100, playlists: 200, playlist_tracks: 100 };
const DETAIL_BATCH = 500;
const TRACK_CACHE_LIMIT = 20000;
const CURSOR_LIMIT = 256;
const CURSOR_TTL_MS = 30 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "ogg", "aac", "m4a"];
const REFUSAL_MESSAGES = {
  no_play_rights: "NetEase does not grant play rights for this track on this account.",
  trial_clip: "NetEase only provides a 30-second trial clip for this track.",
  no_media: "NetEase returned no audio for this track.",
  unavailable: "This track cannot be played from this source.",
};
const NUMERIC_ID = /^[1-9][0-9]{0,18}$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,8192}$/;
const RETRYABLE = ["network", "rate_limited", "busy", "source_unavailable"];
const RESOURCE_ORIGINS = [
  "https://p1.music.126.net",
  "https://p2.music.126.net",
  "https://p3.music.126.net",
  "https://p4.music.126.net",
];
const MEDIA_ORIGINS = [
  "https://m7.music.126.net",
  "https://m701.music.126.net",
  "https://m702.music.126.net",
  "https://m703.music.126.net",
  "https://m704.music.126.net",
  "https://m8.music.126.net",
  "https://m801.music.126.net",
  "https://m802.music.126.net",
  "https://m803.music.126.net",
  "https://m804.music.126.net",
  "https://m10.music.126.net",
];
const REQUEST_ORIGINS = [
  "https://music.163.com",
  "https://interfacepc.music.163.com",
];

function fail(code, message) {
  const error = new Error(message || code.replaceAll("_", " "));
  error.code = code;
  if (RETRYABLE.includes(code)) error.retryable = true;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isText(value) {
  return typeof value === "string" && value.length > 0;
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function plainText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
// Minimal HTTPS URL check without the URL global (not in the host sandbox).
// Returns { origin, href } or null. Only exact https://host[:port][/path...]
// shapes the provider actually emits; anything else is rejected.
function httpsUrl(value) {
  const text = plainText(value);
  if (!text) return null;
  const upgraded = text.startsWith("http://") ? `https://${text.slice(7)}` : text;
  const match = /^https:\/\/([A-Za-z0-9.-]+(?::\d+)?)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(upgraded);
  if (!match) return null;
  const [, authority, path = "/", query = "", fragment = ""] = match;
  if (authority.includes("@")) return null;
  const host = authority.split(":")[0];
  if (!host || !host.includes(".")) return null;
  if (/[\s<>\"\\^`{|}]/.test(upgraded)) return null;
  void fragment;
  return { origin: `https://${authority}`, href: `https://${authority}${path}${query}` };
}
function artworkResource(value, size, allowedOrigins) {
  const url = httpsUrl(value);
  if (!url || !allowedOrigins.includes(url.origin)) return null;
  return { url: `${url.href.split("?")[0]}?param=${size}y${size}`, headers: {}, expires_at: null };
}

function refusal(reason, message = REFUSAL_MESSAGES[reason]) {
  return { reason, message };
}

const AUDIO_TYPES = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
};

function trackId(song) {
  const id = song?.id;
  if (Number.isSafeInteger(id) && id > 0) return String(id);
  return null;
}
function privilegePl(privilege) {
  const value = privilege?.pl;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function songFee(song, privilege) {
  const fromSong = typeof song?.fee === "number" ? song.fee : undefined;
  const fromPrivilege = typeof privilege?.fee === "number" ? privilege.fee : undefined;
  return [fromSong, fromPrivilege];
}
function refusalReason(song, privilege) {
  if (privilegePl(privilege) > 0) return null;
  if (privilege?.cs === true || privilege?.cs === 1) return null;
  const [songFeeValue, privilegeFee] = songFee(song, privilege);
  if (songFeeValue === 1 || privilegeFee === 1) return "trial_clip";
  if (songFeeValue === 4 || privilegeFee === 4) return "no_play_rights";
  if (song?.noCopyrightRcmd !== undefined && song.noCopyrightRcmd !== null)
    return "no_play_rights";
  const st = typeof privilege?.st === "number" ? privilege.st : 0;
  if (st < 0) return "no_play_rights";
  return null;
}
function toTrack(song, privilege) {
  const id = trackId(song);
  if (!id) return null;
  const reason = refusalReason(song, privilege ?? song?.privilege);
  const artists = array(song.ar)
    .map((artist) => plainText(artist?.name))
    .filter(Boolean);
  return {
    id,
    title: plainText(song.name) ?? "Untitled",
    artists,
    album: plainText(song.al?.name),
    duration_ms: safeCount(song.dt),
    artwork: artworkResource(song.al?.picUrl, 200, RESOURCE_ORIGINS),
    refusal: reason ? refusal(reason) : null,
  };
}
function toTracks(songs, privileges) {
  const byId = new Map();
  for (const privilege of privileges) {
    if (Number.isSafeInteger(privilege?.id)) byId.set(privilege.id, privilege);
  }
  const matchById = byId.size > 0;
  return songs.flatMap((song, index) => {
    const privilege = matchById ? byId.get(song?.id) : privileges[index];
    const track = toTrack(song, privilege);
    return track ? [track] : [];
  });
}
function toPlaylist(playlist) {
  if (!Number.isSafeInteger(playlist?.id) || playlist.id <= 0) return null;
  return {
    id: String(playlist.id),
    name: plainText(playlist.name) ?? "Playlist",
    description: plainText(playlist.description),
    artwork: artworkResource(playlist.coverImgUrl, 300, RESOURCE_ORIGINS),
    track_count: safeCount(playlist.trackCount),
  };
}

function upstreamError(code) {
  if (code === 301)
    fail("session_expired", "NetEase rejected the saved sign-in. Sign in again.");
  if (code === 404) fail("not_found", "NetEase could not find that item.");
  if (code === 502) fail("network", "NetEase request failed");
  if (code === 405 || code === 429)
    fail("rate_limited", "NetEase is limiting requests. Try again shortly.");
  fail("internal", `NetEase rejected the request (code ${code})`);
}

function createState() {
  return {
    cookie: null,
    session: { state: "signed_out", account: null },
    uid: null,
    epoch: 0,
    cancelled: false,
    cursors: new Map(),
    challenges: new Map(),
    trackCache: new Map(),
  };
}
let state = createState();

function resetSession(status = "signed_out") {
  state.epoch += 1;
  state.cancelled = false;
  state.cookie = null;
  state.uid = null;
  state.session = { state: status, account: null };
  state.cursors.clear();
  state.challenges.clear();
  state.trackCache.clear();
}

function isCancelled() {
  return state.cancelled === true;
}

async function upstream(operation, query, credentials = state.cookie) {
  let response;
  try {
    response = await upstreamCall(operation, { ...query, cookie: credentials, timeout: 25000 });
  } catch (error) {
    if (typeof error?.code === "string" && error.code !== "upstream" && error.code !== "internal")
      throw error;
    if (Number.isInteger(error?.body?.code)) upstreamError(error.body.code);
    fail("network", "NetEase request failed");
  }
  const code = response?.body?.code;
  if (code === undefined) fail("internal", "NetEase returned an unreadable response");
  if (code !== 200) upstreamError(code);
  return response.body;
}

function requireSession() {
  if (state.session.state === "signed_in" && state.cookie) return;
  fail(state.session.state === "expired" ? "session_expired" : "authentication_required");
}

async function authed(operation, query) {
  requireSession();
  const started = state.epoch;
  try {
    return await upstream(operation, query);
  } catch (error) {
    if (error?.code === "session_expired" && started === state.epoch) resetSession("expired");
    throw error;
  }
}

function parseCredentials(value) {
  if (!isObject(value) || !Object.values(value).every((entry) => typeof entry === "string"))
    fail("invalid_request");
  const MUSIC_U = value.MUSIC_U;
  const csrf = value.__csrf;
  if (!COOKIE_VALUE.test(MUSIC_U ?? "") || !COOKIE_VALUE.test(csrf ?? "")) return null;
  return { MUSIC_U, __csrf: csrf };
}

// Never throws: cancel is advisory only. The host rejects the timed-out call
// with "cancelled", keeps the isolate alive, and takes the source down on
// auth.sign_out, so resetSession always runs with an epoch bump. A stale
// upstream success therefore sees a moved epoch or the cancelled flag and
// returns without committing state; the next fresh attempt starts clean.
function useCancellation() {
  state.cancelled = false;
  return isCancelled;
}

function issueCursor(method, key, cursorState) {
  const tokenBytes = openkara.crypto.randomBytes(18);
  const token = openkara.encoding.base64Encode(tokenBytes, { urlSafe: true, padding: false });
  state.cursors.set(token, {
    method,
    key,
    epoch: state.epoch,
    state: cursorState,
    expires: Date.now() + CURSOR_TTL_MS,
  });
  while (state.cursors.size > CURSOR_LIMIT) {
    const oldest = state.cursors.keys().next().value;
    state.cursors.delete(oldest);
  }
  return token;
}
function redeemCursor(token, method, key) {
  const entry = state.cursors.get(token);
  if (
    !entry ||
    entry.method !== method ||
    entry.key !== key ||
    entry.epoch !== state.epoch ||
    entry.expires < Date.now()
  ) {
    state.cursors.delete(token);
    fail("invalid_cursor");
  }
  return entry.state;
}
function remember(tracks) {
  if (state.trackCache.size + tracks.length > TRACK_CACHE_LIMIT) state.trackCache.clear();
  for (const track of tracks) state.trackCache.set(track.id, track);
}

async function tracksByIds(ids) {
  const found = new Map();
  const missing = [];
  for (const id of ids) {
    const cached = state.trackCache.get(id);
    if (cached) found.set(id, cached);
    else if (!missing.includes(id)) missing.push(id);
  }
  for (let start = 0; start < missing.length; start += DETAIL_BATCH) {
    const batch = missing.slice(start, start + DETAIL_BATCH);
    const body = await authed("song_detail", { ids: batch.join(",") });
    const tracks = toTracks(array(body.songs), array(body.privileges));
    const wanted = new Set(batch);
    const kept = tracks.filter((track) => wanted.has(track.id));
    remember(kept);
    for (const track of kept) found.set(track.id, track);
  }
  return found;
}

function describe(params) {
  const offer = params && isObject(params) ? params : {};
  if (Array.isArray(offer.protocol_majors) && !offer.protocol_majors.includes(2))
    fail("incompatible_plugin");
  return {
    protocol: { major: 2, minor: 0 },
    package_id: MANIFEST.package_id,
    source_id: MANIFEST.source_id,
    package_version: MANIFEST.version,
    name: MANIFEST.name,
    description: MANIFEST.description,
    capabilities: MANIFEST.capabilities,
    authentication: MANIFEST.authentication,
    requires_authentication: MANIFEST.requires_authentication,
    session: state.session,
  };
}

const methods = {
  describe,

  "session.restore": async (params) => {
    const credentials = isObject(params?.credentials) ? parseCredentials(params.credentials) : undefined;
    if (credentials === undefined) fail("invalid_request");
    if (!credentials) {
      resetSession("expired");
      fail("session_expired", "Saved NetEase sign-in is incomplete. Sign in again.");
    }
    try {
      const started = state.epoch;
      const wasCancelled = useCancellation();
      const body = await upstream("user_account", {}, credentials);
      if (wasCancelled() || started !== state.epoch) return state.session;
      const id = body?.account?.id;
      if (!Number.isSafeInteger(id) || id <= 0)
        fail("session_expired", "NetEase did not confirm the sign-in. Sign in again.");
      const nickname = body?.profile?.nickname;
      resetSession();
      state.cookie = credentials;
      state.uid = Number(id);
      state.session = {
        state: "signed_in",
        account: {
          id: String(id),
          display_name: isText(nickname) && nickname.trim() ? nickname.trim() : "NetEase account",
        },
      };
      return state.session;
    } catch (error) {
      if (error?.code === "session_expired") resetSession("expired");
      throw error;
    }
  },

  "auth.start": async () => {
    state.challenges.clear();
    const challenge = openkara.encoding.base64Encode(openkara.crypto.randomBytes(18), {
      urlSafe: true,
      padding: false,
    });
    const expires = Date.now() + CHALLENGE_TTL_MS;
    state.challenges.set(challenge, { state: "pending", expires });
    return {
      challenge,
      expires_at: new Date(expires).toISOString(),
      presentation: { kind: "web" },
    };
  },

  "auth.complete": async (params) => {
    if (!isText(params?.challenge)) fail("invalid_request");
    const entry = state.challenges.get(params.challenge);
    if (!entry) fail("challenge_expired");
    if (entry.state === "pending" && Date.now() >= entry.expires) entry.state = "expired";
    if (entry.state !== "pending") fail("challenge_expired");
    const credentials = parseCredentials(params?.credentials);
    if (!credentials)
      fail(
        "authentication_required",
        "NetEase sign-in did not provide a complete session. Try signing in again.",
      );
    const started = state.epoch;
    const wasCancelled = useCancellation();
    const body = await upstream("user_account", {}, credentials);
    if (wasCancelled() || started !== state.epoch) return state.session;
    const id = body?.account?.id;
    if (!Number.isSafeInteger(id) || id <= 0)
      fail("session_expired", "NetEase did not confirm the sign-in. Sign in again.");
    const nickname = body?.profile?.nickname;
    resetSession();
    state.cookie = credentials;
    state.uid = Number(id);
    state.session = {
      state: "signed_in",
      account: {
        id: String(id),
        display_name: isText(nickname) && nickname.trim() ? nickname.trim() : "NetEase account",
      },
    };
    return {
      session: state.session,
      credentials: { MUSIC_U: credentials.MUSIC_U, __csrf: credentials.__csrf },
    };
  },

  "auth.cancel": async (params) => {
    if (!isText(params?.challenge)) fail("invalid_request");
    const entry = state.challenges.get(params.challenge);
    if (!entry) fail("challenge_expired");
    if (entry.state === "pending") entry.state = "cancelled";
    return { state: "cancelled" };
  },

  "auth.sign_out": async () => {
    resetSession();
    return state.session;
  },

  search: async (params) => {
    requireSession();
    if (!isText(params?.query)) fail("invalid_request");
    const offset =
      params.cursor === undefined || params.cursor === null
        ? 0
        : redeemCursor(String(params.cursor), "search", params.query).offset;
    if (params.cursor !== undefined && params.cursor !== null && !isText(params.cursor))
      fail("invalid_request");
    const body = await authed("cloudsearch", {
      keywords: params.query,
      type: 1,
      limit: PAGE_SIZE.search,
      offset,
    });
    const songs = array(body.result?.songs);
    const items = songs.flatMap((song) => {
      const track = toTrack(song, undefined);
      return track ? [track] : [];
    });
    const total = safeCount(body.result?.songCount) ?? 0;
    const next = offset + songs.length;
    return {
      items,
      next_cursor: songs.length > 0 && next < total ? issueCursor("search", params.query, { offset: next }) : null,
    };
  },

  liked_tracks: async (params) => {
    requireSession();
    let cursorState;
    if (params?.cursor === undefined || params?.cursor === null) {
      const body = await authed("likelist", { uid: state.uid });
      const ids = [
        ...new Set(
          array(body.ids)
            .map((id) => (Number.isSafeInteger(id) ? String(id) : id))
            .filter((id) => typeof id === "string" && NUMERIC_ID.test(id)),
        ),
      ];
      cursorState = { ids, position: 0 };
    } else {
      if (!isText(params.cursor)) fail("invalid_request");
      cursorState = redeemCursor(params.cursor, "liked_tracks", "");
    }
    const page = cursorState.ids.slice(cursorState.position, cursorState.position + PAGE_SIZE.liked_tracks);
    const found = await tracksByIds(page);
    const items = page.flatMap((id) => (found.has(id) ? [found.get(id)] : []));
    const position = cursorState.position + page.length;
    return {
      items,
      next_cursor:
        position < cursorState.ids.length
          ? issueCursor("liked_tracks", "", { ids: cursorState.ids, position })
          : null,
    };
  },

  playlists: async (params) => {
    requireSession();
    const offset =
      params?.cursor === undefined || params?.cursor === null
        ? 0
        : redeemCursor(String(params.cursor), "playlists", "").offset;
    if (params?.cursor !== undefined && params?.cursor !== null && !isText(params.cursor))
      fail("invalid_request");
    const body = await authed("user_playlist", {
      uid: state.uid,
      limit: PAGE_SIZE.playlists,
      offset,
    });
    const raw = array(body.playlist);
    const items = raw.flatMap((entry) => {
      const playlist = toPlaylist(entry);
      return playlist ? [playlist] : [];
    });
    const next = offset + raw.length;
    return {
      items,
      next_cursor:
        body.more === true && raw.length > 0 ? issueCursor("playlists", "", { offset: next }) : null,
    };
  },

  "playlist.tracks": async (params) => {
    requireSession();
    if (!isText(params?.playlist_id) || !NUMERIC_ID.test(params.playlist_id)) fail("invalid_request");
    const playlistId = params.playlist_id;
    let cursorState;
    if (params?.cursor === undefined || params?.cursor === null) {
      const body = await authed("playlist_detail", { id: playlistId, s: 0 });
      const summary = toPlaylist(body.playlist);
      if (!summary) fail("not_found", "NetEase could not find that playlist.");
      remember(toTracks(array(body.playlist.tracks), array(body.privileges)));
      const ids = array(body.playlist.trackIds)
        .map((entry) => (Number.isSafeInteger(entry?.id) ? String(entry.id) : null))
        .filter(Boolean);
      cursorState = { summary, ids, position: 0 };
    } else {
      if (!isText(params.cursor)) fail("invalid_request");
      cursorState = redeemCursor(params.cursor, "playlist.tracks", playlistId);
    }
    const page = cursorState.ids.slice(cursorState.position, cursorState.position + PAGE_SIZE.playlist_tracks);
    const found = await tracksByIds(page);
    const items = page.flatMap((id) => (found.has(id) ? [found.get(id)] : []));
    const position = cursorState.position + page.length;
    return {
      playlist: cursorState.summary,
      items,
      next_cursor:
        position < cursorState.ids.length
          ? issueCursor("playlist.tracks", playlistId, { ...cursorState, position })
          : null,
    };
  },

  "tracks.get": async (params) => {
    requireSession();
    const ids = params?.track_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every(isText))
      fail("invalid_request");
    if (!ids.every((id) => NUMERIC_ID.test(id))) fail("invalid_request");
    const found = await tracksByIds(ids);
    const unique = [...new Set(ids)];
    return {
      items: unique.flatMap((id) => (found.has(id) ? [found.get(id)] : [])),
      missing_ids: unique.filter((id) => !found.has(id)),
    };
  },

  "media.resolve": async (params) => {
    requireSession();
    if (!isText(params?.track_id) || !NUMERIC_ID.test(params.track_id)) fail("invalid_request");
    if (params.purpose !== "preview" && params.purpose !== "import") fail("unsupported_operation");
    const found = await tracksByIds([params.track_id]);
    const track = found.get(params.track_id);
    if (!track) fail("not_found", "NetEase could not find that track.");
    if (track.refusal) return { kind: "refusal", refusal: track.refusal };
    const body = await authed("song_url", { id: params.track_id, br: 320000 });
    const data = array(body.data)[0] ?? {};
    if (data.freeTrialInfo !== undefined && data.freeTrialInfo !== null)
      return { kind: "refusal", refusal: refusal("trial_clip") };
    const url = httpsUrl(data.url);
    if (!url) return { kind: "refusal", refusal: refusal("no_media") };
    const extension = typeof data.type === "string" ? data.type.toLowerCase() : "";
    if (!AUDIO_EXTENSIONS.includes(extension))
      fail("internal", "NetEase returned an unsupported audio format");
    if (!MEDIA_ORIGINS.includes(url.origin))
      return {
        kind: "refusal",
        refusal: refusal(
          "unavailable",
          "NetEase served this audio from a host this source package does not permit. Update the source.",
        ),
      };
    const lifetime = safeCount(data.expi);
    return {
      kind: "media",
      media: {
        url: url.href,
        headers: {},
        expires_at: lifetime ? new Date(Date.now() + lifetime * 1000).toISOString() : null,
        content_type: AUDIO_TYPES[extension] ?? null,
        file_extension: extension,
        size_bytes: safeCount(data.size),
        duration_ms: track.duration_ms ?? safeCount(data.time),
        bit_rate: safeCount(data.br),
      },
    };
  },
};

// Unknown methods never reach this module: the host rejects them as
// unsupported_operation before dispatch.
export default methods;

// Test seam: reset in-memory session state between unit runs.
function __resetStateForTests() {
  state = createState();
}
const __manifestForTests = MANIFEST;
const __requestOriginsForTests = REQUEST_ORIGINS;
