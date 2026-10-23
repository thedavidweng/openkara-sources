// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { SourceError } from "./errors.mjs";
import { isObject, isText } from "./protocol.mjs";
import {
  array,
  contentTypeFor,
  httpsUrl,
  refusal,
  safeCount,
  toPlaylist,
  toTrack,
  toTracks,
} from "./convert.mjs";

const PAGE_SIZE = { search: 30, liked_tracks: 100, playlists: 200, playlist_tracks: 100 };
const DETAIL_BATCH = 500;
const UPSTREAM_CONCURRENCY = 4;
const UPSTREAM_TIMEOUT_MS = 25000;
const TRACK_CACHE_LIMIT = 20000;
const CURSOR_LIMIT = 256;
const CURSOR_TTL_MS = 30 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const AUDIO_EXTENSIONS = new Set(["mp3", "flac", "wav", "ogg", "aac", "m4a"]);
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,8192}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,18}$/;

const cancelled = () => new SourceError("cancelled");

/** Resolves with `promise`, or rejects `cancelled` as soon as `signal` aborts. */
function raceAbort(promise, signal) {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(cancelled());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Bounds concurrent upstream calls; waiting callers can be cancelled. */
class Gate {
  #free;
  #waiting = [];
  constructor(limit) {
    this.#free = limit;
  }
  async run(signal, task) {
    if (signal.aborted) throw cancelled();
    if (this.#free > 0) this.#free -= 1;
    else {
      await new Promise((resolve, reject) => {
        const waiter = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
          reject(cancelled());
        };
        this.#waiting.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

/** Maps an upstream body code to a protocol error. */
function upstreamError(code) {
  if (code === 301) return new SourceError("session_expired", "NetEase rejected the saved sign-in. Sign in again.");
  if (code === 404) return new SourceError("not_found", "NetEase could not find that item.");
  if (code === 502) return new SourceError("network", "NetEase request failed");
  if (code === 405 || code === 429)
    return new SourceError("rate_limited", "NetEase is limiting requests. Try again shortly.");
  return new SourceError("internal", `NetEase rejected the request (code ${code})`);
}

/**
 * The NetEase Streaming Source. `upstream.call(operation, query)` is the API
 * module seam; `manifest` supplies the permitted resource and media origins.
 */
export function createNetease({ upstream, manifest, now = () => Date.now() }) {
  const resourceOrigins = manifest.resource_origins;
  const mediaOrigins = manifest.media_origins;
  const gate = new Gate(UPSTREAM_CONCURRENCY);
  const challenges = new Map();
  const cursors = new Map();
  const trackCache = new Map();
  let cookie = null; // { MUSIC_U, __csrf } while signed in
  let session = { state: "signed_out", account: null };
  let uid = null;
  let epoch = 0;

  function resetSession(state = "signed_out") {
    epoch += 1;
    cookie = null;
    uid = null;
    session = { state, account: null };
    cursors.clear();
    challenges.clear();
    trackCache.clear();
  }

  async function upstreamCall(operation, query, signal, credentials = cookie) {
    let response;
    try {
      response = await gate.run(signal, () =>
        raceAbort(
          Promise.resolve().then(() =>
            upstream.call(operation, {
              ...query,
              cookie: credentials,
              timeout: UPSTREAM_TIMEOUT_MS,
              unblock: "false",
              realIP: upstream.chinaClientAddress,
            }),
          ),
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (Number.isInteger(error?.body?.code)) throw upstreamError(error.body.code);
      throw new SourceError("network", "NetEase request failed");
    }
    const code = response?.body?.code;
    if (code === undefined) throw new SourceError("internal", "NetEase returned an unreadable response");
    if (code !== 200) throw upstreamError(code);
    return response.body;
  }

  /** Runs an authenticated upstream call and expires the session on rejection. */
  async function authed(operation, query, signal) {
    requireSession();
    const started = epoch;
    try {
      return await upstreamCall(operation, query, signal);
    } catch (error) {
      if (error.code === "session_expired" && started === epoch) resetSession("expired");
      throw error;
    }
  }

  function requireSession() {
    if (session.state === "signed_in" && cookie) return;
    throw new SourceError(session.state === "expired" ? "session_expired" : "authentication_required");
  }

  function accountFrom(body) {
    const id = body?.account?.id;
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new SourceError("session_expired", "NetEase did not confirm the sign-in. Sign in again.");
    const nickname = body?.profile?.nickname;
    return {
      id: String(id),
      display_name: isText(nickname) && nickname.trim() ? nickname.trim() : "NetEase account",
    };
  }

  /** Verifies cookies with a user_account call and makes them the session. */
  async function establish(credentials, signal) {
    const body = await upstreamCall("user_account", {}, signal, credentials);
    const account = accountFrom(body);
    resetSession();
    cookie = credentials;
    uid = Number(account.id);
    session = { state: "signed_in", account };
    return session;
  }

  function parseCredentials(value) {
    if (!isObject(value) || !Object.values(value).every((entry) => typeof entry === "string"))
      throw new SourceError("invalid_request");
    const MUSIC_U = value.MUSIC_U;
    const csrf = value.__csrf;
    if (!COOKIE_VALUE.test(MUSIC_U ?? "") || !COOKIE_VALUE.test(csrf ?? ""))
      return null;
    return { MUSIC_U, __csrf: csrf };
  }

  // Cursors bind to operation, query/playlist, and session; they expire.
  function issueCursor(method, key, state) {
    const token = randomBytes(18).toString("base64url");
    cursors.set(token, { method, key, epoch, state, expires: now() + CURSOR_TTL_MS });
    while (cursors.size > CURSOR_LIMIT) cursors.delete(cursors.keys().next().value);
    return token;
  }
  function redeemCursor(token, method, key) {
    const entry = cursors.get(token);
    if (
      !entry ||
      entry.method !== method ||
      entry.key !== key ||
      entry.epoch !== epoch ||
      entry.expires < now()
    ) {
      cursors.delete(token);
      throw new SourceError("invalid_cursor");
    }
    return entry.state;
  }
  function cursorParam(params) {
    if (params.cursor === undefined || params.cursor === null) return null;
    if (!isText(params.cursor)) throw new SourceError("invalid_request");
    return params.cursor;
  }

  function remember(tracks) {
    if (trackCache.size + tracks.length > TRACK_CACHE_LIMIT) trackCache.clear();
    for (const track of tracks) trackCache.set(track.id, track);
  }

  /** Tracks by id: cached ids locally, the rest in song_detail batches. */
  async function tracksByIds(ids, signal) {
    const found = new Map();
    const missing = [];
    for (const id of ids) {
      const cached = trackCache.get(id);
      if (cached) found.set(id, cached);
      else if (!missing.includes(id)) missing.push(id);
    }
    for (let start = 0; start < missing.length; start += DETAIL_BATCH) {
      const batch = missing.slice(start, start + DETAIL_BATCH);
      const body = await authed("song_detail", { ids: batch.join(",") }, signal);
      const tracks = toTracks(array(body.songs), array(body.privileges), resourceOrigins);
      const requested = new Set(batch);
      const wanted = tracks.filter((track) => requested.has(track.id));
      remember(wanted);
      for (const track of wanted) found.set(track.id, track);
    }
    return found;
  }

  function orderedTracks(ids, found) {
    return ids.flatMap((id) => (found.has(id) ? [found.get(id)] : []));
  }

  function requireIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every(isText))
      throw new SourceError("invalid_request");
    if (!ids.every((id) => NUMERIC_ID.test(id))) throw new SourceError("invalid_request");
  }

  const operations = {
    async search(params, { signal }) {
      requireSession();
      if (!isText(params.query)) throw new SourceError("invalid_request");
      const cursor = cursorParam(params);
      const query = params.query;
      const offset = cursor ? redeemCursor(cursor, "search", query).offset : 0;
      const body = await authed(
        "cloudsearch",
        { keywords: query, type: 1, limit: PAGE_SIZE.search, offset },
        signal,
      );
      const songs = array(body.result?.songs);
      const items = songs.flatMap((song) => {
        const track = toTrack(song, undefined, resourceOrigins);
        return track ? [track] : [];
      });
      const total = safeCount(body.result?.songCount) ?? 0;
      const next = offset + songs.length;
      return {
        items,
        next_cursor:
          songs.length > 0 && next < total ? issueCursor("search", query, { offset: next }) : null,
      };
    },

    async liked_tracks(params, { signal }) {
      requireSession();
      const cursor = cursorParam(params);
      let state;
      if (cursor) state = redeemCursor(cursor, "liked_tracks", "");
      else {
        const body = await authed("likelist", { uid }, signal);
        const ids = [
          ...new Set(
            array(body.ids)
              .map((id) => (Number.isSafeInteger(id) ? String(id) : id))
              .filter((id) => typeof id === "string" && NUMERIC_ID.test(id)),
          ),
        ];
        state = { ids, position: 0 };
      }
      const page = state.ids.slice(state.position, state.position + PAGE_SIZE.liked_tracks);
      const items = orderedTracks(page, await tracksByIds(page, signal));
      const position = state.position + page.length;
      return {
        items,
        next_cursor:
          position < state.ids.length
            ? issueCursor("liked_tracks", "", { ids: state.ids, position })
            : null,
      };
    },

    async playlists(params, { signal }) {
      requireSession();
      const cursor = cursorParam(params);
      const offset = cursor ? redeemCursor(cursor, "playlists", "").offset : 0;
      const body = await authed(
        "user_playlist",
        { uid, limit: PAGE_SIZE.playlists, offset },
        signal,
      );
      const raw = array(body.playlist);
      const items = raw.flatMap((entry) => {
        const playlist = toPlaylist(entry, resourceOrigins);
        return playlist ? [playlist] : [];
      });
      const next = offset + raw.length;
      return {
        items,
        next_cursor:
          body.more === true && raw.length > 0
            ? issueCursor("playlists", "", { offset: next })
            : null,
      };
    },

    async "playlist.tracks"(params, { signal }) {
      requireSession();
      if (!isText(params.playlist_id) || !NUMERIC_ID.test(params.playlist_id))
        throw new SourceError("invalid_request");
      const playlistId = params.playlist_id;
      const cursor = cursorParam(params);
      let state;
      if (cursor) state = redeemCursor(cursor, "playlist.tracks", playlistId);
      else {
        const body = await authed("playlist_detail", { id: playlistId, s: 0 }, signal);
        const summary = toPlaylist(body.playlist, resourceOrigins);
        if (!summary) throw new SourceError("not_found", "NetEase could not find that playlist.");
        // playlist_detail already carries the first tracks and their privileges.
        remember(toTracks(array(body.playlist.tracks), array(body.privileges), resourceOrigins));
        const ids = array(body.playlist.trackIds)
          .map((entry) => (Number.isSafeInteger(entry?.id) ? String(entry.id) : null))
          .filter(Boolean);
        state = { summary, ids, position: 0 };
      }
      const page = state.ids.slice(state.position, state.position + PAGE_SIZE.playlist_tracks);
      const items = orderedTracks(page, await tracksByIds(page, signal));
      const position = state.position + page.length;
      return {
        playlist: state.summary,
        items,
        next_cursor:
          position < state.ids.length
            ? issueCursor("playlist.tracks", playlistId, { ...state, position })
            : null,
      };
    },

    async "tracks.get"(params, { signal }) {
      requireSession();
      requireIds(params.track_ids);
      const found = await tracksByIds(params.track_ids, signal);
      const unique = [...new Set(params.track_ids)];
      return {
        items: orderedTracks(unique, found),
        missing_ids: unique.filter((id) => !found.has(id)),
      };
    },

    async "media.resolve"(params, { signal, progress }) {
      requireSession();
      if (!isText(params.track_id) || !NUMERIC_ID.test(params.track_id))
        throw new SourceError("invalid_request");
      if (params.purpose !== "preview" && params.purpose !== "import")
        throw new SourceError("unsupported_operation");
      const id = params.track_id;
      await progress({ phase: "resolve", completed: 0, total: 2 });
      const track = (await tracksByIds([id], signal)).get(id);
      if (!track) throw new SourceError("not_found", "NetEase could not find that track.");
      // Listing-time rights first; a refusal never falls back to another source.
      if (track.refusal) return { kind: "refusal", refusal: track.refusal };
      await progress({ phase: "resolve", completed: 1, total: 2 });
      const body = await authed("song_url", { id, br: 320000 }, signal);
      const data = array(body.data)[0] ?? {};
      if (data.freeTrialInfo !== undefined && data.freeTrialInfo !== null)
        return { kind: "refusal", refusal: refusal("trial_clip") };
      const url = httpsUrl(data.url);
      if (!url) return { kind: "refusal", refusal: refusal("no_media") };
      const extension = typeof data.type === "string" ? data.type.toLowerCase() : "";
      if (!AUDIO_EXTENSIONS.has(extension))
        throw new SourceError("internal", "NetEase returned an unsupported audio format");
      if (!mediaOrigins.includes(url.origin))
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
          expires_at: lifetime ? new Date(now() + lifetime * 1000).toISOString() : null,
          content_type: contentTypeFor(extension),
          file_extension: extension,
          size_bytes: safeCount(data.size),
          duration_ms: track.duration_ms ?? safeCount(data.time),
          bit_rate: safeCount(data.br),
        },
      };
    },
  };

  const authenticated = new Set([
    "search",
    "liked_tracks",
    "playlists",
    "playlist.tracks",
    "tracks.get",
    "media.resolve",
  ]);

  function describe() {
    return {
      name: manifest.name,
      description: manifest.description,
      capabilities: manifest.capabilities,
      authentication: manifest.authentication,
      requires_authentication: manifest.requires_authentication,
      session,
    };
  }

  function known(token) {
    const entry = challenges.get(token);
    if (!entry) throw new SourceError("challenge_expired");
    if (entry.state === "pending" && now() >= entry.expires) entry.state = "expired";
    return entry;
  }

  return async function handle(method, params, context) {
    const { signal } = context;
    if (Object.hasOwn(operations, method)) return operations[method](params, context);
    switch (method) {
      case "describe":
        return describe();
      case "session.restore": {
        const credentials = isObject(params.credentials) ? parseCredentials(params.credentials) : undefined;
        if (credentials === undefined) throw new SourceError("invalid_request");
        if (!credentials) {
          resetSession("expired");
          throw new SourceError("session_expired", "Saved NetEase sign-in is incomplete. Sign in again.");
        }
        try {
          return await establish(credentials, signal);
        } catch (error) {
          if (error.code === "session_expired") resetSession("expired");
          throw error;
        }
      }
      case "auth.start": {
        challenges.clear();
        const challenge = randomBytes(18).toString("base64url");
        const expires = now() + CHALLENGE_TTL_MS;
        challenges.set(challenge, { state: "pending", expires });
        return {
          challenge,
          expires_at: new Date(expires).toISOString(),
          presentation: { kind: "web" },
        };
      }
      case "auth.complete": {
        if (!isText(params.challenge)) throw new SourceError("invalid_request");
        const entry = known(params.challenge);
        if (entry.state !== "pending") throw new SourceError("challenge_expired");
        const credentials = parseCredentials(params.credentials);
        if (!credentials)
          throw new SourceError(
            "authentication_required",
            "NetEase sign-in did not provide a complete session. Try signing in again.",
          );
        // A failed verification keeps the challenge so the window can retry.
        await establish(credentials, signal);
        return {
          session,
          credentials: { MUSIC_U: credentials.MUSIC_U, __csrf: credentials.__csrf },
        };
      }
      case "auth.cancel": {
        if (!isText(params.challenge)) throw new SourceError("invalid_request");
        const entry = known(params.challenge);
        if (entry.state === "pending") entry.state = "cancelled";
        return { state: "cancelled" };
      }
      case "auth.sign_out":
        context.abortOthers((other) => authenticated.has(other));
        resetSession();
        return session;
      default:
        // auth.poll (web flow), unknown methods, and undeclared capabilities.
        throw new SourceError("unsupported_operation");
    }
  };
}
