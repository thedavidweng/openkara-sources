# Input provenance (locked)

## Upstream API reference (read-only, not vendored)

- Package: `@neteasecloudmusicapienhanced/api@4.41.1`
- npm tarball: `https://registry.npmjs.org/@neteasecloudmusicapienhanced/api/-/api-4.41.1.tgz`
- `dist.integrity`: `sha512-0QDKtLrSLfz4iP2M57nQTqRQuJkzJV2AUOjHSCSBgqOFQEoGkw4zSue8bbfkzz/lFRLvnIr9SjsrPj95BThxUQ==`
- `dist.shasum`: `3be814604cb4619837213363683b5f2af0c12210`
- Local tarball bytes: `13389698` B
- Tarball SHA-256 (actual bytes): `bf596b65657b73c671b8149a876ad76a2fd006faaf0f97bd73c34576e48176f0`
- `util/crypto.js` in tarball: `12563` B, SHA-256 `45bdb719176d66d864f876da3d7436eab5d99a37f031d1f6fd5025b4191c577c`
- Upstream tag `v4.41.1` commit `2db6684453297ee86dec0492842f2320b08182d9` serves byte-identical `util/crypto.js` (GitHub raw + contents API blob `cc882e25`); the registry metadata carries no `gitHead`, so the tarball bytes above are the verified input.
- The fixed upstream archive declares MIT; its LICENSE (SHA-256 `e463bb821c363e6182f16ec1bf24405af3315b4adc72fc1402232fa98b9a0b12`) is included as `LICENSES/netease-api-MIT.txt`. The wire adapter derives from the referenced upstream implementation.

## In-repo sources

- Provider logic: `../netease/src/*.mjs` (AGPL-3.0-only, same worktree).
- Frozen host contracts used for the port: app commit `a50d0e573f06477a65aead577ba13dfb9ed86da7` (`docs/references/contracts/`).
- The fixed cloudsearch vector (`cf0e8f7d…`) is pinned to the published 4.41.1 input.

## Build tooling

- `esbuild@0.28.1` (devDependency, pinned in `package-lock.json`):
  - `esbuild`: `sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D…`
  - `@esbuild/darwin-arm64`: `sha512-TZbWkQY7kvTAXbXUT7uVACR5cMHsDiSz9z7ZKAX/RTq/WJEk3QyRr0wZpNhBDX+/0CtdqUIJlOiodQcta6t…`
- Rebuild: `npm ci` (dev deps) then `npm run bundle` — output `dist/entry.mjs`.
