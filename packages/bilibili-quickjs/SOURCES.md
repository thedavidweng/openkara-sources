# Input provenance (locked)

## Upstream reference (read-only, not vendored)

- Repository: `GentleM4dman/mygo-music-bilibili`
- Commit: `3b0aa100d425b59504570ca84bdace80877ac26d`
- File used: `index.js`
- License: MIT, `Copyright (c) 2026 GentleM4dman`; included as `LICENSES/mygo-music-bilibili-MIT.txt`. The wire adapter in `src/main.mjs` derives from this implementation.

## Contracts

- Streaming Source protocol 2.1, Streaming Source host API and Source host contracts (`docs/references/contracts/` in the OpenKara app repository).

## Build tooling

- `esbuild@0.28.1` (devDependency, pinned with integrity in `package-lock.json`).
- Rebuild: `npm ci` (dev deps) then `npm run bundle`; output `dist/entry.mjs`.
