// SPDX-License-Identifier: AGPL-3.0-only
// Preloaded with `node --require`: replaces the NetEase API package at the
// CommonJS module seam, so the worker runs unmodified over real stdio and no
// test ever reaches NetEase. Calls are appended to $MOCK_LOG as JSON lines.
const Module = require("node:module");
const fs = require("node:fs");

const PREFIX = "@neteasecloudmusicapienhanced/api/";
const log = process.env.MOCK_LOG;
const fake = require("./fake-netease.cjs");

function record(operation, query) {
  if (log) fs.appendFileSync(log, `${JSON.stringify({ operation, query })}\n`);
}

const mocks = new Map();
for (const operation of Object.keys(fake.operations)) {
  mocks.set(`${PREFIX}module/${operation}.js`, (query) => {
    record(operation, query);
    return fake.operations[operation](query);
  });
}
mocks.set(`${PREFIX}util/request.js`, () => {
  throw new Error("the real request function must not be reached");
});
mocks.set(`${PREFIX}util/index.js`, { generateRandomChineseIP: () => fake.CHINA_ADDRESS });

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (mocks.has(request)) return mocks.get(request);
  if (request.startsWith(PREFIX)) throw new Error(`unmocked upstream module ${request}`);
  return originalLoad.call(this, request, parent, isMain);
};
