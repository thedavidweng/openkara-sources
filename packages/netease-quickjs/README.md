# NetEase QuickJS source (candidate)

Protocol-2 port of the NetEase source for the embedded QuickJS (`openkara-js`)
runtime. Single self-contained ES module, no Node or browser globals.

- Entry: `dist/entry.mjs` — single self-contained ES module built from `src/` via `npm run bundle` (pinned esbuild 0.28.1). `src/` remains the AGPL corresponding source; the multi-file tree is never installed as the runtime entry.
- `src/crypto.mjs`: weapi double-AES-CBC + raw-RSA and eapi MD5 + AES-ECB wire,
  ported from `@neteasecloudmusicapienhanced/api` 4.41.1 `util/crypto.js`.
- `src/upstream.mjs`: request construction ported from 4.41.1 `module/*.js`
  (seven operations), `util/createOption.js`, and the weapi/eapi branches of
  `util/request.js`, using only `openkara.request` / `openkara.crypto` /
  `openkara.encoding`.
- Provider logic (search, liked tracks, playlists, details, rights mapping,
  cursors, session) ported from `packages/netease/src/netease.mjs`.

Release: bump version in `manifest.json` and `package.json`, then tag `netease-quickjs-v<version>`. The release workflow builds `dist/entry.mjs`, packs via `tools/pack.py`, signs the release into `source-index.json`, and publishes the GitHub release.

Rebuild: `npm ci` (dev-only esbuild) then `npm run bundle`. Pack: `npm run pack` (see `tools/pack.py`). Inputs and licenses: `SOURCES.md`, `LICENSE`, `NOTICE`.
