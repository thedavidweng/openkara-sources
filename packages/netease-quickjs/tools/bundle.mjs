#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Bundles src/{main,upstream,crypto}.mjs into one self-contained ESM entry.
// The bundle keeps only the `openkara` host global. esbuild is a declared,
// pinned devDependency (see package.json/package-lock.json); this script
// resolves it from the package's own node_modules, never from an absolute
// path outside the worktree.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { out: { type: "string", default: "dist/entry.mjs" } } });
const out = resolve(root, values.out);
const require = createRequire(join(root, "package.json"));
const esbuildPkg = require.resolve("esbuild/package.json");
const esbuildBin = join(dirname(esbuildPkg), "bin", "esbuild");

const result = spawnSync(process.execPath, [esbuildBin,
  "src/main.mjs", "--bundle", "--format=esm", "--platform=neutral",
  "--target=es2020", "--external:openkara", `--outfile=${out}`],
  { cwd: root, encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stderr || `esbuild failed with status ${result.status}`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
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
if (!existsSync(join(root, "node_modules", "esbuild", "package.json"))) {
  console.error("esbuild is not installed; run: npm ci --omit=dev=false (devDependency esbuild@0.28.1)");
  process.exit(1);
}
console.log(JSON.stringify({ out: values.out, bytes: bytes.length, problems }));
