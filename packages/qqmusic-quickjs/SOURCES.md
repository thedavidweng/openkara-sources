# Input provenance (locked)

## Upstream reference (read-only, not vendored)

- Repository: `dddaniel1/mygo-plugin-qqmusic`
- Commit: `4bb04cc4d5f8ff2ea528a237c4fe9737b79eda87`
- File used: `index.js`
- License: MIT, `Copyright (c) 2026 dddaniel1`; included as `LICENSES/mygo-plugin-qqmusic-MIT.txt`. The wire adapter in `src/main.mjs` derives from this implementation.

## Contracts

- Streaming Source protocol 2.1, Streaming Source host API and Source host contracts (`docs/references/contracts/` in the OpenKara app repository).

## Build tooling

- `esbuild@0.28.1` (devDependency, pinned with integrity in `package-lock.json`).
- Rebuild: `npm ci` (dev deps) then `npm run bundle`; output `dist/entry.mjs`.
