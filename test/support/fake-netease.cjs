// SPDX-License-Identifier: AGPL-3.0-only
// A small deterministic stand-in for the NetEase API modules. Track ids carry
// scenarios: 1 plays; 2 is VIP-only (fee 1); 3 has no rights (st < 0);
// 4 resolves to an empty URL; 5 to a trial clip; 6 to an unpermitted host;
// 7 to an unknown audio type; 8 fails the network; 301 expires the session;
// 405 is rate limited; 999 does not exist; 1000+ are plain playable tracks.
const CHINA_ADDRESS = "116.30.1.2";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reject = (code) => Promise.reject({ status: code, body: { code } });
const ok = (body) => ({ status: 200, body: { code: 200, ...body } });

function signedIn(query) {
  const cookie = query.cookie ?? {};
  if (cookie.MUSIC_U === "network-down") return reject(502);
  if (cookie.MUSIC_U === "stale") return reject(301);
  if (cookie.MUSIC_U === "anonymous") return null;
  return cookie.MUSIC_U === "good-music-u" && cookie.__csrf === "good-csrf" ? "ok" : null;
}

function song(id) {
  const privilege = { id, fee: 0, pl: 320000, st: 0 };
  const entry = {
    id,
    name: `Song ${id}`,
    ar: [{ name: "Artist A" }, { name: `Artist ${id}` }],
    al: { name: `Album ${id}`, picUrl: `http://p1.music.126.net/pic-${id}.jpg?old=1` },
    dt: 180000 + id,
  };
  if (id === 2) Object.assign(privilege, { fee: 1, pl: 0 });
  if (id === 3) Object.assign(privilege, { pl: 0, st: -1 });
  return { entry, privilege };
}

const playlists = Array.from({ length: 250 }, (_, index) => ({
  id: 5000 + index,
  name: `Playlist ${index}`,
  description: index === 0 ? "  First  " : null,
  trackCount: 230,
  coverImgUrl: `http://p2.music.126.net/list-${index}.jpg`,
}));

const operations = {
  async user_account(query) {
    const state = signedIn(query);
    if (state instanceof Promise) return state;
    if (!state) return ok({ account: null, profile: null });
    return ok({ account: { id: 1001 }, profile: { nickname: "Tester" } });
  },
  async likelist() {
    return ok({ ids: Array.from({ length: 250 }, (_, index) => index + 1000) });
  },
  async user_playlist(query) {
    const page = playlists.slice(query.offset, query.offset + query.limit);
    return ok({ playlist: page, more: query.offset + query.limit < playlists.length });
  },
  async playlist_detail(query) {
    if (String(query.id) === "404") return reject(404);
    const ids = Array.from({ length: 230 }, (_, index) => 2000 + index);
    const head = ids.slice(0, 3).map((id) => song(id));
    return ok({
      playlist: {
        id: Number(query.id),
        name: "Road Trip",
        description: "Songs",
        trackCount: ids.length,
        coverImgUrl: "http://p3.music.126.net/cover.jpg",
        trackIds: ids.map((id) => ({ id })),
        tracks: head.map((entry) => entry.entry),
      },
      privileges: head.map((entry) => entry.privilege),
    });
  },
  async cloudsearch(query) {
    if (query.keywords === "slow") await sleep(30000);
    const total = 70;
    const count = Math.max(0, Math.min(query.limit, total - query.offset));
    const songs = Array.from({ length: count }, (_, index) => {
      const entry = song(3000 + query.offset + index);
      return { ...entry.entry, privilege: entry.privilege };
    });
    return ok({ result: { songs, songCount: total } });
  },
  async song_detail(query) {
    const ids = String(query.ids).split(",").map(Number);
    if (ids.includes(301)) return reject(301);
    if (ids.includes(405)) return reject(405);
    if (ids.includes(8)) throw new Error("socket hang up");
    if (ids.includes(777)) await sleep(30000);
    const found = ids.filter((id) => id !== 999).map(song);
    return ok({
      songs: found.map((entry) => entry.entry),
      privileges: found.map((entry) => entry.privilege),
    });
  },
  async song_url(query) {
    const id = Number(query.id);
    const base = {
      id,
      br: 320000,
      size: 7340032,
      type: "mp3",
      time: 181000,
      expi: 1200,
      url: `http://m801.music.126.net/20260101/abc/${id}.mp3`,
    };
    if (id === 4) return ok({ data: [{ ...base, url: null }] });
    if (id === 5) return ok({ data: [{ ...base, freeTrialInfo: { start: 0, end: 30 } }] });
    if (id === 6) return ok({ data: [{ ...base, url: "https://evil.example.com/a.mp3" }] });
    if (id === 7) return ok({ data: [{ ...base, type: "xyz" }] });
    return ok({ data: [base] });
  },
};

module.exports = { operations, CHINA_ADDRESS };
