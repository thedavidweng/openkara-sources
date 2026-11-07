# QQ Music QuickJS source (candidate)

Protocol-2 Streaming Source for QQ Music on the embedded QuickJS (`openkara-js`) runtime. Single self-contained ES module, no Node or browser globals.

- Entry: `dist/entry.mjs`, built from `src/main.mjs` via `npm run bundle` (pinned esbuild 0.28.1). `src/` is the AGPL corresponding source.
- Search and track details work without signing in. Playlists need a QQ Music sign-in (web flow on y.qq.com; cookies `uin` and `qm_keyst`).
- Without play rights QQ Music serves a 60 second clip; the source reports it as a `trial_clip` refusal instead of importing it.
- Wire ported from `dddaniel1/mygo-plugin-qqmusic` (MIT), see `NOTICE` and `SOURCES.md`.

## Checks and packaging

`npm test` runs offline checks against canned responses (network, vkey and sign-in are not covered). `npm run pack` builds the bundle and the release archive (see `tools/pack.py`).

## Distribution

Distributed via the OpenKara Source Registry:

```
https://raw.githubusercontent.com/thedavidweng/openkara-sources/main/registry.json
```
