#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Usage: node scripts/verify-index.mjs <file|https-url>  -- verifies signature and host rules.
import { readFileSync } from "node:fs";
import { validateIndexPayload } from "./lib/host-rules.mjs";
import { verifyEnvelope } from "./lib/trust.mjs";

const target = process.argv[2];
if (!target) {
  console.error("usage: verify-index.mjs <file|url>");
  process.exit(2);
}
try {
  const text = target.startsWith("https://") ? await (await fetch(target)).text() : readFileSync(target, "utf8");
  const payload = verifyEnvelope(JSON.parse(text));
  const problems = validateIndexPayload(payload);
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`index ok: generation ${payload.generation}, ${payload.sources.map((s) => `${s.source_id}[${s.releases.map((r) => r.manifest.version).join(",")}]`).join(" ")}`);
} catch (error) {
  console.error(`verify-index failed: ${error.message}`);
  process.exit(1);
}
