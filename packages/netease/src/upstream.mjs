// SPDX-License-Identifier: AGPL-3.0-only
// The only module that touches the NetEase API package. Everything else gets
// an `api` object, so tests replace the API modules at the require seam.
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OPERATIONS = [
  "user_account",
  "likelist",
  "user_playlist",
  "playlist_detail",
  "cloudsearch",
  "song_detail",
  "song_url",
];

const PACKAGE = "@neteasecloudmusicapienhanced/api";

export function loadUpstream() {
  // The API package reads this file at load time and logs through console.
  const anonymousToken = join(tmpdir(), "anonymous_token");
  if (!existsSync(anonymousToken)) writeFileSync(anonymousToken, "");
  const require = createRequire(import.meta.url);
  const request = require(`${PACKAGE}/util/request.js`);
  const { generateRandomChineseIP } = require(`${PACKAGE}/util/index.js`);
  const modules = Object.fromEntries(
    OPERATIONS.map((name) => [name, require(`${PACKAGE}/module/${name}.js`)]),
  );
  return {
    // One China Client Address per process (ADR 0033), sent as `realIP` on
    // every call because the API module only honours randomCNIP in its server.
    chinaClientAddress: generateRandomChineseIP(),
    call: (operation, query) => modules[operation]({ ...query }, request),
  };
}
