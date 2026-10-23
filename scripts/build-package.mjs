#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Usage: node scripts/build-package.mjs [--package netease] [--out dist]
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPackage, verifyArchiveFile } from "./lib/package-build.mjs";
import { readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { package: { type: "string", default: "netease" }, out: { type: "string", default: "dist" } } });
const packageDir = join(root, "packages", values.package);
const meta = buildPackage({ packageDir, outDir: resolve(root, values.out) });
const manifest = JSON.parse(readFileSync(join(packageDir, "manifest.json"), "utf8"));
const problems = verifyArchiveFile(join(resolve(root, values.out), meta.file), manifest);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify(meta, null, 2));
