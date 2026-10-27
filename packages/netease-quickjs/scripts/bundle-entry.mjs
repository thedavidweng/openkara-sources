#!/usr/bin/env node
// Bundle check for the NetEase QuickJS source: three ESM modules -> one
// self-contained entry. Uses the repo's own esbuild binary (0.28.1, already
// in the main checkout's pnpm store); the bundle itself keeps only the
// `openkara` host global.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const esbuild =
  "/Users/david/Development/OpenKara/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild";
const root = "/Users/david/Development/.worktrees/openkara-sources-quickjs-bb73/packages/netease-quickjs";
const out = process.argv[2] ?? "/tmp/netease-bundle-entry.mjs";

const result = spawnSync(
  esbuild,
  ["src/main.mjs", "--bundle", "--format=esm", "--platform=neutral", "--target=es2020", "--external:openkara", `--outfile=${out}`],
  { cwd: root, encoding: "utf8" },
);
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}
const bytes = readFileSync(out);
const text = bytes.toString("utf8");
const problems = [];
for (const token of ["from \"./", "from './", "import(", "require(", "eval(", "Function(", "URLSearchParams", "new URL(", "AbortController", "process.", "globalThis.process", "WebAssembly"]) {
  if (text.includes(token)) problems.push(token);
}
if (!/^\/\/ bundled netease entry/.test(text)) problems.push("missing-bundle-banner");
console.log(JSON.stringify({ bytes: bytes.length, problems }));
if (problems.length) {
  // Banner lands after the check by design, so drop it from the verdict
  // unless a real forbidden token is present.
  const real = problems.filter((p) => p !== "missing-bundle-banner");
  if (real.length) process.exit(1);
}
// Prepend the pin banner so the artifact names its input without re-bundling.
writeFileSync(out, `// bundled netease entry: src/{main,upstream,crypto}.mjs @ f7387fd tree\n${text}`);
console.log("bundle-ok", out, bytes.length);
