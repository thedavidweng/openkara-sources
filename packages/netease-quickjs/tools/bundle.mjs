#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Bundles src/{main,upstream,crypto}.mjs into one self-contained ESM entry.
// The bundle keeps only the `openkara` host global. esbuild is a declared,
// pinned devDependency (see package.json/package-lock.json); this script
// resolves it from the package's own node_modules, never from an absolute
// path outside the worktree.
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { out: { type: "string", default: "dist/entry.mjs" } } });
const out = resolve(root, values.out);
mkdirSync(dirname(out), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/main.mjs"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2020",
  external: ["openkara"],
  outfile: out,
});
const bytes = readFileSync(out);
const text = bytes.toString("utf8");
const problems = [];
for (const token of ["from \"./", "from './", "import(", "require(", "eval(", "Function(", "URLSearchParams", "new URL(", "AbortController", "process.", "globalThis.process", "WebAssembly"]) {
  if (text.includes(token)) problems.push(token);
}
if (problems.length) {
  console.error(`forbidden tokens in bundle: ${problems.join(", ")}`);
  process.exit(1);
}
console.log(JSON.stringify({ out: values.out, bytes: bytes.length, problems }));
