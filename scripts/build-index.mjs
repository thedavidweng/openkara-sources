#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Usage: node scripts/build-index.mjs --archive dist/<file>.meta.json [--previous prev.json]
//          [--out dist/source-index.json] [--key-slot current|next] [--package netease]
// The private key is read from OPENKARA_SOURCE_SIGNING_{CURRENT,NEXT}_PRIVATE_KEY.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildSignedIndex } from "./lib/index-build.mjs";
import { privateKeyFromEnv } from "./lib/trust.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    previous: { type: "string" },
    out: { type: "string", default: "dist/source-index.json" },
    "key-slot": { type: "string", default: "current" },
    package: { type: "string", default: "netease" },
    repo: { type: "string", default: "thedavidweng/openkara-sources" },
  },
});
if (!values.archive) throw new Error("--archive <meta.json> is required");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

try {
  const manifest = readJson(join(root, "packages", values.package, "manifest.json"));
  const { envelope, payload } = buildSignedIndex({
    previousEnvelope: values.previous ? readJson(values.previous) : null,
    manifest,
    archive: readJson(resolve(values.archive)),
    pin: readJson(join(root, "data", "source-runtime.json")),
    revocations: readJson(join(root, "data", "revocations.json")),
    repo: values.repo,
    privateKey: privateKeyFromEnv(values["key-slot"]),
    slot: values["key-slot"],
  });
  writeFileSync(resolve(values.out), `${JSON.stringify(envelope)}\n`);
  const releases = payload.sources.flatMap((s) => s.releases.map((r) => `${s.source_id}@${r.manifest.version}`));
  console.log(`signed index generation ${payload.generation} with key ${envelope.key_id}: ${releases.join(", ")}`);
} catch (error) {
  console.error(`build-index failed: ${error.message}`);
  process.exit(1);
}
