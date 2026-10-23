// SPDX-License-Identifier: AGPL-3.0-only
// Pure conversion from NetEase API bodies to protocol 1.0 domain data.
// Rights logic is ported from OpenKara's former built-in NetEase adapter
// (application revision a933794f), which followed YesPlayMusic's isTrackPlayable.

export const REFUSAL_MESSAGES = {
  no_play_rights: "NetEase does not grant play rights for this track on this account.",
  trial_clip: "NetEase only provides a 30-second trial clip for this track.",
  no_media: "NetEase returned no audio for this track.",
  unavailable: "This track cannot be played from this source.",
};

export function refusal(reason, message = REFUSAL_MESSAGES[reason]) {
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
export function contentTypeFor(extension) {
  return AUDIO_TYPES[extension] ?? null;
}

export function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function number(value, key) {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
function plainText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** HTTPS-only normalization of a provider URL; null for anything unusable. */
export function httpsUrl(value) {
  const text = plainText(value);
  if (!text) return null;
  let url;
  try {
    url = new URL(text.startsWith("http://") ? `https://${text.slice(7)}` : text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url;
}

/**
 * A directly usable, CDN-resized artwork Resource, or null when the URL is
 * missing or outside the manifest's resource origins. Resizing is NetEase's
 * `?param=<w>y<h>` query, which belongs to this plugin, not the host.
 */
export function artworkResource(value, size, allowedOrigins) {
  const url = httpsUrl(value);
  if (!url || !allowedOrigins.includes(url.origin)) return null;
  url.search = `?param=${size}y${size}`;
  url.hash = "";
  return { url: url.href, headers: {}, expires_at: null };
}

function truthy(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}

/** Listing-time refusal reason, or null when the track looks playable. */
export function refusalReason(song, privilege) {
  if ((number(privilege, "pl") ?? 0) > 0) return null;
  // Cloud-storage tracks play for the signed-in owner.
  if (truthy(privilege?.cs)) return null;
  const fee = (value) => number(song, "fee") === value || number(privilege, "fee") === value;
  // fee 1 is VIP-only, which NetEase serves as a 30-second clip.
  if (fee(1)) return "trial_clip";
  // fee 4 is a paid album: nothing to import without buying it.
  if (fee(4)) return "no_play_rights";
  if (song?.noCopyrightRcmd !== undefined && song.noCopyrightRcmd !== null)
    return "no_play_rights";
  if ((number(privilege, "st") ?? 0) < 0) return "no_play_rights";
  return null;
}

export function trackId(song) {
  const id = song?.id;
  if (Number.isSafeInteger(id) && id > 0) return String(id);
  return null;
}

export function toTrack(song, privilege, allowedResourceOrigins) {
  const id = trackId(song);
  if (!id) return null;
  const reason = refusalReason(song, privilege ?? song.privilege);
  const artists = (Array.isArray(song.ar) ? song.ar : [])
    .map((artist) => plainText(artist?.name))
    .filter(Boolean);
  return {
    id,
    title: plainText(song.name) ?? "Untitled",
    artists,
    album: plainText(song.al?.name),
    duration_ms: safeCount(song.dt),
    artwork: artworkResource(song.al?.picUrl, 200, allowedResourceOrigins),
    refusal: reason ? refusal(reason) : null,
  };
}

/** Builds tracks from `songs`, matching privileges by id (or position). */
export function toTracks(songs, privileges, allowedResourceOrigins) {
  const byId = new Map();
  for (const privilege of privileges) {
    if (Number.isSafeInteger(privilege?.id)) byId.set(privilege.id, privilege);
  }
  const matchById = byId.size > 0;
  return songs.flatMap((song, index) => {
    const privilege = matchById ? byId.get(song?.id) : privileges[index];
    const track = toTrack(song, privilege, allowedResourceOrigins);
    return track ? [track] : [];
  });
}

export function toPlaylist(playlist, allowedResourceOrigins) {
  if (!Number.isSafeInteger(playlist?.id) || playlist.id <= 0) return null;
  return {
    id: String(playlist.id),
    name: plainText(playlist.name) ?? "Playlist",
    description: plainText(playlist.description),
    artwork: artworkResource(playlist.coverImgUrl, 300, allowedResourceOrigins),
    track_count: safeCount(playlist.trackCount),
  };
}

export function array(value) {
  return Array.isArray(value) ? value : [];
}
