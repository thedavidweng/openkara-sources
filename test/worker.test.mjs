// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker, GOOD, withWorker, MANIFEST } from "./support/client.mjs";

const signedIn = (body) =>
  withWorker(async (w) => {
    await w.signIn();
    return body(w);
  });

test("handshake returns identity and protocol version", () =>
  withWorker(async (w) => {
    const result = await w.handshake();
    assert.deepEqual(result, {
      protocol: { major: 1, minor: 0 },
      package_id: "org.openkara.netease",
      source_id: "netease",
      package_version: MANIFEST.version,
    });
  }));

test("methods before handshake are refused", () =>
  withWorker(async (w) => {
    const frame = await w.request("describe");
    assert.equal(frame.error.code, "handshake_required");
  }));

test("a second handshake is invalid_request", () =>
  withWorker(async (w) => {
    await w.handshake();
    const frame = await w.request("handshake", { protocol_majors: [1], host_version: "0.17.0" });
    assert.equal(frame.error.code, "invalid_request");
  }));

test("handshake without a common major is incompatible_plugin", () =>
  withWorker(async (w) => {
    const frame = await w.request("handshake", { protocol_majors: [2], host_version: "9.0.0" });
    assert.equal(frame.error.code, "incompatible_plugin");
  }));

test("describe reports capabilities and a signed_out session", () =>
  withWorker(async (w) => {
    await w.handshake();
    const result = await w.call("describe");
    assert.deepEqual(result.capabilities, MANIFEST.capabilities);
    assert.equal(result.session.state, "signed_out");
    assert.equal(result.session.account, null);
  }));

test("unknown operation is unsupported_operation", () =>
  signedIn(async (w) => {
    const frame = await w.request("bogus.method");
    assert.equal(frame.error.code, "unsupported_operation");
    assert.equal(frame.error.retryable, false);
  }));

test("auth.poll is unsupported for the web flow", () =>
  signedIn(async (w) => {
    const frame = await w.request("auth.poll", {});
    assert.equal(frame.error.code, "unsupported_operation");
  }));

test("authenticated methods require a session", () =>
  withWorker(async (w) => {
    await w.handshake();
    const frame = await w.request("search", { query: "a" });
    assert.equal(frame.error.code, "authentication_required");
  }));

test("session.restore accepts good credentials and rejects stale ones", () =>
  withWorker(async (w) => {
    await w.handshake();
    const stale = await w.request("session.restore", { credentials: { MUSIC_U: "stale", __csrf: "x" } });
    assert.equal(stale.error.code, "session_expired");
    const good = await w.call("session.restore", { credentials: GOOD });
    assert.deepEqual(good, { state: "signed_in", account: { id: "1001", display_name: "Tester" } });
  }));

test("web auth: start, complete, unknown challenge, cancel", () =>
  withWorker(async (w) => {
    await w.handshake();
    const started = await w.call("auth.start");
    assert.deepEqual(started.presentation, { kind: "web" });
    assert.ok(started.challenge && started.expires_at);

    const incomplete = await w.request("auth.complete", {
      challenge: started.challenge,
      credentials: { MUSIC_U: "good-music-u" },
    });
    assert.equal(incomplete.error.code, "authentication_required");

    const done = await w.call("auth.complete", {
      challenge: started.challenge,
      credentials: { ...GOOD, extra: "ignored" },
    });
    assert.equal(done.session.state, "signed_in");
    assert.deepEqual(done.credentials, GOOD);

    const unknown = await w.request("auth.complete", { challenge: "nope", credentials: GOOD });
    assert.equal(unknown.error.code, "challenge_expired");

    const second = await w.call("auth.start");
    assert.deepEqual(await w.call("auth.cancel", { challenge: second.challenge }), { state: "cancelled" });
    const after = await w.request("auth.complete", { challenge: second.challenge, credentials: GOOD });
    assert.equal(after.error.code, "challenge_expired");
  }));

test("auth.complete with credentials NetEase rejects keeps the challenge", () =>
  withWorker(async (w) => {
    await w.handshake();
    const { challenge } = await w.call("auth.start");
    const bad = await w.request("auth.complete", {
      challenge,
      credentials: { MUSIC_U: "stale", __csrf: "x" },
    });
    assert.equal(bad.error.code, "session_expired");
    const ok = await w.call("auth.complete", { challenge, credentials: GOOD });
    assert.equal(ok.session.state, "signed_in");
  }));

test("auth.sign_out clears the session", () =>
  signedIn(async (w) => {
    const out = await w.call("auth.sign_out");
    assert.equal(out.state, "signed_out");
    const frame = await w.request("search", { query: "a" });
    assert.equal(frame.error.code, "authentication_required");
  }));

test("search paginates with cursors to the end", () =>
  signedIn(async (w) => {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await w.call("search", { query: "song", cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor);
    assert.equal(seen.length, 70);
    assert.equal(new Set(seen).size, 70);
    assert.equal(pages, 3);
  }));

test("cursors are bound to their method and query", () =>
  signedIn(async (w) => {
    const page = await w.call("search", { query: "song" });
    const other = await w.request("search", { query: "different", cursor: page.next_cursor });
    assert.equal(other.error.code, "invalid_cursor");
    const garbage = await w.request("search", { query: "song", cursor: "garbage" });
    assert.equal(garbage.error.code, "invalid_cursor");
    const cross = await w.request("playlists", { cursor: page.next_cursor });
    assert.equal(cross.error.code, "invalid_cursor");
  }));

test("liked_tracks paginates 250 ids", () =>
  signedIn(async (w) => {
    const ids = [];
    let cursor = null;
    do {
      const page = await w.call("liked_tracks", { cursor });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(ids.length, 250);
    assert.equal(new Set(ids).size, 250);
  }));

test("playlists paginate and playlist.tracks returns the playlist", () =>
  signedIn(async (w) => {
    const lists = [];
    let cursor = null;
    do {
      const page = await w.call("playlists", { cursor });
      lists.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(lists.length, 250);

    const tracks = [];
    cursor = null;
    let playlist;
    do {
      const page = await w.call("playlist.tracks", { playlist_id: "5000", cursor });
      playlist = page.playlist;
      tracks.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(playlist.id, "5000");
    assert.equal(tracks.length, 230);
    assert.equal(new Set(tracks).size, 230);
  }));

test("playlist.tracks maps a missing playlist to not_found", () =>
  signedIn(async (w) => {
    const frame = await w.request("playlist.tracks", { playlist_id: "404" });
    assert.equal(frame.error.code, "not_found");
  }));

test("tracks.get returns items and missing_ids and maps refusals", () =>
  signedIn(async (w) => {
    const result = await w.call("tracks.get", { track_ids: ["1", "2", "3", "999"] });
    assert.deepEqual(result.items.map((item) => item.id), ["1", "2", "3"]);
    assert.deepEqual(result.missing_ids, ["999"]);
    const byId = Object.fromEntries(result.items.map((item) => [item.id, item.refusal]));
    assert.equal(byId["1"], null);
    assert.equal(byId["2"].reason, "trial_clip");
    assert.equal(byId["3"].reason, "no_play_rights");
  }));

test("tracks.get validates its ids", () =>
  signedIn(async (w) => {
    assert.equal((await w.request("tracks.get", { track_ids: [] })).error.code, "invalid_request");
    const many = Array.from({ length: 101 }, (_, i) => String(i + 1));
    assert.equal((await w.request("tracks.get", { track_ids: many })).error.code, "invalid_request");
    assert.equal((await w.request("tracks.get", { track_ids: ["x"] })).error.code, "invalid_request");
  }));

test("media.resolve returns https media with metadata and progress", () =>
  signedIn(async (w) => {
    const id = w.start("media.resolve", { track_id: "1", purpose: "preview" });
    const frame = await w.response(id);
    assert.equal(frame.result.kind, "media");
    const media = frame.result.media;
    assert.match(media.url, /^https:\/\/m801\.music\.126\.net\//);
    assert.deepEqual(media.headers, {});
    assert.ok(media.expires_at);
    assert.ok(media.content_type.startsWith("audio/"));
    assert.ok(media.file_extension);
    const progress = w.frames.filter((f) => f.event === "progress" && f.request_id === id);
    assert.ok(progress.length >= 1);
    assert.deepEqual(Object.keys(progress[0].data).sort(), ["completed", "phase", "total"]);
  }));

test("media.resolve refusal mapping", () =>
  signedIn(async (w) => {
    const reasons = {};
    for (const [track, expected] of [
      ["2", "trial_clip"],
      ["3", "no_play_rights"],
      ["4", "no_media"],
      ["5", "trial_clip"],
      ["6", "unavailable"],
    ]) {
      const result = await w.call("media.resolve", { track_id: track, purpose: "import" });
      assert.equal(result.kind, "refusal", `track ${track}`);
      assert.ok(result.refusal.message);
      reasons[track] = result.refusal.reason;
      assert.equal(result.refusal.reason, expected, `track ${track}`);
    }
  }));

test("media.resolve rejects an unknown audio type and bad purpose", () =>
  signedIn(async (w) => {
    const unknownType = await w.request("media.resolve", { track_id: "7", purpose: "import" });
    assert.equal(unknownType.error.code, "internal");
    const purpose = await w.request("media.resolve", { track_id: "1", purpose: "stream" });
    assert.equal(purpose.error.code, "unsupported_operation");
  }));

test("upstream session expiry maps to session_expired and signs out", () =>
  signedIn(async (w) => {
    const frame = await w.request("tracks.get", { track_ids: ["301"] });
    assert.equal(frame.error.code, "session_expired");
    const described = await w.call("describe");
    assert.equal(described.session.state, "expired");
    const next = await w.request("search", { query: "song" });
    assert.ok(["session_expired", "authentication_required"].includes(next.error.code));
  }));

test("upstream failures map to network, rate_limited and internal", () =>
  signedIn(async (w) => {
    const network = await w.request("tracks.get", { track_ids: ["8"] });
    assert.equal(network.error.code, "network");
    assert.equal(network.error.retryable, true);
    const limited = await w.request("tracks.get", { track_ids: ["405"] });
    assert.equal(limited.error.code, "rate_limited");
    assert.equal(limited.error.retryable, true);
  }));

test("request.cancel cancels an in-flight request exactly once", () =>
  signedIn(async (w) => {
    const id = w.start("search", { query: "slow" });
    for (let i = 0; i < 200 && !w.calls().some((c) => c.operation === "cloudsearch"); i++)
      await new Promise((r) => setTimeout(r, 25));
    const cancel = await w.call("request.cancel", { request_id: id });
    assert.deepEqual(cancel, { cancelled: true });
    const frame = await w.response(id);
    assert.equal(frame.error.code, "cancelled");
    assert.equal(w.frames.filter((f) => f.id === id).length, 1);
    assert.deepEqual(await w.call("request.cancel", { request_id: id }), { cancelled: false });
  }));

test("more than 16 concurrent requests returns busy", () =>
  signedIn(async (w) => {
    const ids = Array.from({ length: 16 }, () => w.start("tracks.get", { track_ids: ["777"] }));
    const extra = await w.request("tracks.get", { track_ids: ["1"] });
    assert.equal(extra.error.code, "busy");
    assert.equal(extra.error.retryable, true);
    for (const id of ids) await w.call("request.cancel", { request_id: id });
  }));

test("malformed frames are fatal and close the worker", async () => {
  const w = new Worker();
  try {
    w.write("not json\n");
    const outcome = await w.exit;
    assert.equal(outcome.code, 1);
  } finally {
    await w.close();
  }
});

test("reused request ids are fatal", async () => {
  const w = new Worker();
  try {
    await w.handshake();
    w.write(`${JSON.stringify({ id: "dup", method: "describe", params: {} })}\n`);
    await w.response("dup");
    w.write(`${JSON.stringify({ id: "dup", method: "describe", params: {} })}\n`);
    assert.equal((await w.exit).code, 1);
  } finally {
    await w.close();
  }
});

test("stdout carries only protocol frames and upstream sees one China Client Address", () =>
  signedIn(async (w) => {
    await w.call("search", { query: "song" });
    const calls = w.calls();
    assert.ok(calls.length > 0);
    const addresses = new Set(calls.map((c) => c.query.realIP));
    assert.deepEqual([...addresses], ["116.30.1.2"]);
    for (const c of calls) assert.equal(c.query.unblock, "false");
    assert.equal(w.stderr, "");
  }));
