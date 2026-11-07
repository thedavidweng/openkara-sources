# Bilibili QuickJS source (candidate)

Protocol-2 Streaming Source for Bilibili on the embedded QuickJS (`openkara-js`) runtime. Single self-contained ES module, no Node or browser globals.

- Entry: `dist/entry.mjs`, built from `src/main.mjs` via `npm run bundle` (pinned esbuild 0.28.1). `src/` is the AGPL corresponding source.
- Search (videos, plus pasted BV or av numbers and bilibili.com or b23.tv links) and track details work without signing in. Playlists are your favorites folders and need a Bilibili sign-in (QR code scanned in the Bilibili app).
- A track id is a video, `BV...`, or one part of a multi-part video, `BV..._pN` (N >= 2).
- Audio is the DASH m4a stream, or FLAC when the signed-in account is offered it. Paid, member-only, charge-exclusive and region-limited videos are reported as refusals.
- Wire ported from `GentleM4dman/mygo-music-bilibili` (MIT), see `NOTICE` and `SOURCES.md`.

## Checks and packaging

`npm test` runs offline checks against canned responses (live search, media, favorites and QR sign-in are not covered). `npm run pack` builds the bundle and the release archive (see `tools/pack.py`).

## Distribution

Distributed via the OpenKara Source Registry:

```
https://raw.githubusercontent.com/thedavidweng/openkara-sources/main/registry.json
```
