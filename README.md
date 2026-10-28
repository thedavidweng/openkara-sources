# openkara-sources

Signed Streaming Source plugin packages for [OpenKara](https://github.com/thedavidweng/OpenKara),
plus the release pipeline that publishes them.

## Layout

- `packages/netease/` - the NetEase Cloud Music source (manifest, worker, LICENSE, NOTICE).
- `scripts/build-package.mjs` - stages a package, runs `npm ci --omit=dev --ignore-scripts`, writes a
  reproducible `.tar.gz` plus a `.meta.json` (size, sha256) and a third-party license inventory.
- `scripts/build-index.mjs` - merges the new release into the previously published index and signs it.
- `scripts/verify-index.mjs` - verifies a signed index (file or URL) against the embedded public keys.
- `scripts/lib/` - tar writer/reader, a re-implementation of the host's structural rules, signing.
- `data/source-runtime.json` - the pinned Node runtime per platform (copied from OpenKara's
  `packaging/source-runtime.json`; update both together).
- `data/revocations.json` - versions to list as revoked in the next index, per source id.
- `test/` - `node --test` suites (worker over real stdio with the upstream API mocked, archive, index).

## Trust model

OpenKara downloads `source-index.json` from
`https://github.com/thedavidweng/openkara-sources/releases/latest/download/source-index.json`.
The file is an envelope `{key_id, payload, signature}`: `payload` is the base64 index JSON and
`signature` an Ed25519 signature over its decoded bytes. The host trusts only the public keys compiled
into it (current `0374d430d3cf1aa6`, next `71a135edb0fedcf0`; `key_id` is the first 8 bytes of the
SHA-256 of the raw public key), so GitHub, the CDN and this repository are not trusted: a package or
runtime is only installed if its size and sha256 match a signed index entry.

- The private keys exist only as the repository secrets
  `OPENKARA_SOURCE_SIGNING_CURRENT_PRIVATE_KEY` and `OPENKARA_SOURCE_SIGNING_NEXT_PRIVATE_KEY`
  (PKCS8, PEM or base64 DER). Scripts never print them.
- Every release carries the complete index (all releases of all sources, the revocation list and the
  Node runtime pin) and the newest release is marked "latest", so the stable URL always serves the
  newest index. The host refuses an index whose generation is older than one it has seen.
- Published versions are immutable: republishing a version with different bytes fails.
- Key rotation: sign with `--key-slot next` once a host release trusting it is out.

## Releasing

1. Bump the version in `packages/netease/manifest.json` and `package.json`.
2. Merge to `main` with CI green.
3. `git tag netease-v<version> && git push origin netease-v<version>`.

The release workflow runs the tests, builds the archive, builds and signs the index, creates the
GitHub Release with `openkara-source-netease-<version>.tar.gz` and `source-index.json`, and verifies
the published index.

## Development

The NetEase dependency lock overrides `basic-ftp` to 6.2.3 for its directory parser
security fix. Until node-forge publishes a fixed stable release, its override uses
the immutable commit `ceba34402e329f0365134f23fe19898756527d65` from
[upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152), with the
archive integrity recorded in the lockfile. This patch rejects extra nested
DigestAlgorithm elements (CVE-2026-85393). The real archive test checks a valid
signature and the malformed nested structure in the installed package. Replace the override
with the fixed stable version when upstream publishes it.

CI and local tests run on Node 26.12.1 (`node --test` suites run offline except the real-archive test, which runs
`npm ci`; set `OPENKARA_SKIP_NETWORK_TESTS=1` to skip it). The packaged worker still runs on the Node 24 pin in `data/source-runtime.json` (`engines` `>=24 <25`, manifest `runtime.major` 24).

```
npm test
node scripts/build-package.mjs
```

## License

AGPL-3.0-only; see `LICENSE` and `packages/netease/NOTICE`.
