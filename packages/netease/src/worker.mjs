// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { serve } from "./protocol.mjs";
import { createNetease } from "./netease.mjs";
import { loadUpstream } from "./upstream.mjs";

// Only protocol frames may reach stdout, and credentials must never reach
// stderr. Capture the real writers, then silence everything else, including
// the API package's console logging.
const writeStdout = process.stdout.write.bind(process.stdout);
const writeStderr = process.stderr.write.bind(process.stderr);
process.stdout.write = () => true;
process.stderr.write = () => true;
for (const method of ["log", "info", "warn", "error", "debug", "trace"])
  console[method] = () => {};

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

let upstream;
try {
  upstream = loadUpstream();
} catch {
  writeStderr("NetEase source dependencies failed to load\n");
  process.exit(1);
}

const handle = createNetease({ upstream, manifest });
const { fatal } = await serve({
  manifest,
  input: process.stdin,
  write: (line) =>
    new Promise((resolve, reject) => {
      writeStdout(line, (error) => (error ? reject(error) : resolve()));
    }),
  handle,
  onFatal: () => {
    writeStderr("Invalid protocol frame\n");
    process.stdin.destroy();
  },
});
process.exit(fatal ? 1 : 0);
