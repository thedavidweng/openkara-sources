# NetEase QuickJS source (candidate)

Protocol-2 port of the NetEase source for the embedded QuickJS (`openkara-js`)
runtime. Single self-contained ES module, no Node or browser globals.

- Entry: `dist/entry.mjs` — single self-contained ES module built from `src/` via `npm run bundle` (pinned esbuild 0.28.1). `src/` remains the AGPL corresponding source; the multi-file tree is never installed as the runtime entry.
- `src/crypto.mjs`: weapi double-AES-CBC + raw-RSA and eapi MD5 + AES-ECB wire,
  ported from `@neteasecloudmusicapienhanced/api` 4.41.1 `util/crypto.js`.
  Only eapi is used at runtime; weapi stays as a pinned test vector.
- `src/upstream.mjs`: every operation goes through eapi on the interface host,
  with the request shape of 4.41.1 `module/*.js` / `util/request.js` and the
  header fields Kumone sends (persistent device id, China Client Address as
  `X-Real-IP`). Uses only `openkara.request` / `openkara.crypto` /
  `openkara.encoding`.
- Sign-in opens the official NetEase web page (`auth.start` / `auth.complete`),
  which offers QR, SMS code, and password sign-in.
- `src/lyrics.mjs`: `lyrics.get` (protocol 2.2 `lyrics` capability) reads
  `/api/song/lyric/v1` without a sign-in. YRC becomes word-timed TTML; songs
  without YRC return their LRC. Credit lines and "no lyrics" placeholders are
  dropped.
- Song URLs are requested by quality level: `exhigh` for preview, `lossless`
  (download endpoint, then player endpoint) for import.
- Provider logic (search, liked tracks, playlists, details, rights mapping,
  cursors, session) ported from `packages/netease/src/netease.mjs`.

## Distribution

Distributed via the OpenKara Source Registry. Users add the stable registry URL in OpenKara:

```
https://raw.githubusercontent.com/thedavidweng/openkara-sources/main/registry.json
```

Rebuild: `npm ci` (dev-only esbuild) then `npm run bundle`. Pack: `npm run pack` (see `tools/pack.py`). Inputs and licenses: `SOURCES.md`, `LICENSE`, `NOTICE`.
