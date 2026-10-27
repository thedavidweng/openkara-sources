# NetEase QuickJS source (candidate)

Protocol-2 port of the NetEase source for the embedded QuickJS (`openkara-js`)
runtime. Single self-contained ES module, no Node or browser globals.

- Entry: `src/main.mjs` (default export: protocol methods).
- `src/crypto.mjs`: weapi double-AES-CBC + raw-RSA and eapi MD5 + AES-ECB wire,
  ported from `@neteasecloudmusicapienhanced/api` 4.41.1 `util/crypto.js`.
- `src/upstream.mjs`: request construction ported from 4.41.1 `module/*.js`
  (seven operations), `util/createOption.js`, and the weapi/eapi branches of
  `util/request.js`, using only `openkara.request` / `openkara.crypto` /
  `openkara.encoding`.
- Provider logic (search, liked tracks, playlists, details, rights mapping,
  cursors, session) ported from `packages/netease/src/netease.mjs`.

Not published. Local candidate under the lane authorization only.
