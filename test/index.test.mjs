// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSignedIndex, mergePayload, parseReleaseTag, releaseTag, runtimeFromPin } from "../scripts/lib/index-build.mjs";
import { validateIndexPayload } from "../scripts/lib/host-rules.mjs";
import { TRUSTED_KEYS, keyIdFor, publicKeyObject, rawPublicOf, signEnvelope, verifyEnvelope } from "../scripts/lib/trust.mjs";
import { MANIFEST } from "./support/client.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "data", "source-runtime.json"), "utf8"));
const repo = "thedavidweng/openkara-sources";
const indexManifest = { ...MANIFEST, version: "1.0.0" };

// A throwaway key pair standing in for a trust slot.
const { privateKey } = generateKeyPairSync("ed25519");
const raw = rawPublicOf(privateKey);
const trusted = { current: { key_id: keyIdFor(raw), public_key: raw.toString("base64") }, next: TRUSTED_KEYS.next };

const archive = (version = "1.0.0", sha = "a".repeat(64)) => ({
  file: `openkara-source-netease-${version}.tar.gz`,
  format: "tar.gz",
  size: 1234,
  sha256: sha,
});
const manifestFor = (version) => ({ ...indexManifest, version });
const build = (extra = {}) =>
  buildSignedIndex({ manifest: indexManifest, archive: archive(), pin, repo, revocations: {}, privateKey, slot: "current", trusted, ...extra });

test("embedded trust anchors are internally consistent", () => {
  for (const key of Object.values(TRUSTED_KEYS)) {
    const bytes = Buffer.from(key.public_key, "base64");
    assert.equal(bytes.length, 32);
    assert.equal(keyIdFor(bytes), key.key_id);
    publicKeyObject(key.public_key);
  }
});

test("runtime pin maps platform archives to host targets", () => {
  const entry = (archive_suffix) => ({ archive_suffix, archive_size: 123, archive_sha256: "a".repeat(64) });
  const runtime = runtimeFromPin({
    version: "24.1.2",
    targets: {
      "aarch64-apple-darwin": entry("darwin-arm64.tar.gz"),
      "x86_64-apple-darwin": entry("darwin-x64.tar.gz"),
      "x86_64-unknown-linux-gnu": entry("linux-x64.tar.gz"),
      "aarch64-unknown-linux-gnu": entry("linux-arm64.tar.gz"),
      "x86_64-pc-windows-msvc": entry("win-x64.zip"),
    },
  });
  assert.equal(runtime.version, "24.1.2");
  assert.deepEqual(Object.keys(runtime.targets).sort(), ["linux-aarch64", "linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"]);
  assert.deepEqual(runtime.targets["macos-aarch64"], {
    url: "https://nodejs.org/dist/v24.1.2/node-v24.1.2-darwin-arm64.tar.gz",
    size: 123,
    sha256: "a".repeat(64),
    format: "tar.gz",
    executable: "node-v24.1.2-darwin-arm64/bin/node",
  });
  assert.equal(runtime.targets["windows-x86_64"].executable, "node-v24.1.2-win-x64/node.exe");
  assert.equal(runtime.targets["windows-x86_64"].format, "zip");
});

test("a first index is signed, valid and verifiable", () => {
  const { envelope, payload } = build();
  assert.equal(envelope.key_id, trusted.current.key_id);
  assert.deepEqual(verifyEnvelope(envelope, trusted), payload);
  assert.equal(payload.generation, 1);
  assert.deepEqual(validateIndexPayload(payload), []);
  const release = payload.sources[0].releases[0];
  assert.equal(release.archive.url, `https://github.com/${repo}/releases/download/${releaseTag(indexManifest)}/openkara-source-netease-1.0.0.tar.gz`);
  assert.equal(release.archive.executable, undefined);
  assert.equal(release.runtime.targets["macos-aarch64"].format, "tar.gz");
});

test("tampering with a signed envelope fails verification", () => {
  const { envelope } = build();
  const bytes = Buffer.from(envelope.payload, "base64");
  bytes[bytes.length - 3] ^= 1;
  assert.throws(() => verifyEnvelope({ ...envelope, payload: bytes.toString("base64") }, trusted), /does not verify|JSON/);
  assert.throws(() => verifyEnvelope({ ...envelope, key_id: "0000000000000000" }, trusted), /untrusted key/);
});

test("signing refuses a key that is not the trusted one", () => {
  const other = generateKeyPairSync("ed25519").privateKey;
  assert.throws(() => signEnvelope({}, other, "current", trusted), /does not match the trusted public key/);
  assert.throws(() => signEnvelope({}, privateKey, "next", trusted), /does not match the trusted public key/);
});

test("the real current key slot rejects a throwaway key", () => {
  assert.throws(() => signEnvelope({}, privateKey, "current"), /does not match the trusted public key/);
});

test("a new release merges with the previous index and bumps the generation", () => {
  const first = build().envelope;
  const second = build({ previousEnvelope: first, manifest: manifestFor("1.1.0"), archive: archive("1.1.0", "b".repeat(64)) });
  assert.equal(second.payload.generation, 2);
  const releases = second.payload.sources[0].releases;
  assert.deepEqual(releases.map((r) => r.manifest.version), ["1.0.0", "1.1.0"]);
  assert.equal(releases[0].archive.sha256, "a".repeat(64));
  assert.equal(releases[1].archive.url.includes("/netease-v1.1.0/"), true);
});

test("re-running the same release keeps the generation; different bytes are refused", () => {
  const first = build().envelope;
  assert.equal(build({ previousEnvelope: first }).payload.generation, 1);
  assert.throws(() => build({ previousEnvelope: first, archive: archive("1.0.0", "c".repeat(64)) }), /already published with different contents/);
});

test("revocations accumulate and stay sorted", () => {
  const first = build({ revocations: { netease: ["0.9.0"] } }).envelope;
  const second = build({
    previousEnvelope: first,
    manifest: manifestFor("1.1.0"),
    archive: archive("1.1.0", "b".repeat(64)),
    revocations: { netease: ["1.0.0"] },
  });
  assert.deepEqual(second.payload.sources[0].revoked_versions, ["0.9.0", "1.0.0"]);
});

test("a previous index signed by an untrusted key is refused", () => {
  const rogue = generateKeyPairSync("ed25519").privateKey;
  const rogueRaw = rawPublicOf(rogue);
  const rogueTrust = { current: { key_id: keyIdFor(rogueRaw), public_key: rogueRaw.toString("base64") } };
  const forged = build({ privateKey: rogue, trusted: rogueTrust }).envelope;
  assert.throws(() => build({ previousEnvelope: forged }), /untrusted key/);
});

test("payload validation catches host-rule violations", () => {
  const payload = mergePayload({ previous: null, manifest: MANIFEST, archive: archive(), runtime: runtimeFromPin(pin), repo });
  const clone = () => structuredClone(payload);
  const bad = (mutate, text) => {
    const copy = clone();
    mutate(copy);
    assert.ok(validateIndexPayload(copy).some((p) => p.includes(text)), text);
  };
  bad((p) => (p.sources[0].releases[0].archive.sha256 = "ABC"), "sha256");
  bad((p) => (p.sources[0].releases[0].archive.executable = "bin/node"), "must not declare an executable");
  bad((p) => (p.sources[0].releases[0].runtime.version = "22.1.0"), "runtime major");
  bad((p) => (p.sources[0].releases[0].manifest.entry = "src/worker.js"), "entry");
  bad((p) => (p.sources[0].releases[0].manifest.media_origins = ["https://x.example.com/"]), "origin");
  bad((p) => (p.sources[0].releases[0].manifest.authentication.cookie_names = ["a b"]), "cookie name");
  bad((p) => (p.sources[0].releases[0].runtime.targets["macos-aarch64"].executable = "../node"), "executable");
});

test("the CLI refuses a key that is not the trusted one and never prints it", () => {
  const out = mkdtempSync(join(tmpdir(), "sources-cli-"));
  try {
    const meta = join(out, "archive.meta.json");
    writeFileSync(meta, JSON.stringify(archive()));
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });
    const run = (env) =>
      spawnSync(process.execPath, [join(root, "scripts", "build-index.mjs"), "--archive", meta, "--out", join(out, "i.json")], {
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
      });
    const wrong = run({ OPENKARA_SOURCE_SIGNING_CURRENT_PRIVATE_KEY: pem });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /does not match the trusted public key/);
    assert.doesNotMatch(`${wrong.stdout}${wrong.stderr}`, /BEGIN|PRIVATE KEY/);
    const missing = run({});
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /OPENKARA_SOURCE_SIGNING_CURRENT_PRIVATE_KEY is not set/);
    const garbage = run({ OPENKARA_SOURCE_SIGNING_CURRENT_PRIVATE_KEY: "not-a-key" });
    assert.match(garbage.stderr, /not a valid PKCS8/);
    assert.doesNotMatch(garbage.stderr, /not-a-key/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("tag patterns map to packages and versions", () => {
  assert.deepEqual(parseReleaseTag("netease-v1.0.1"), { package: "netease", version: "1.0.1" });
  assert.deepEqual(parseReleaseTag("netease-quickjs-v2.0.0"), { package: "netease-quickjs", version: "2.0.0" });
  assert.equal(parseReleaseTag("other-v1.0.0"), null);
});

test("releaseTag distinguishes node and quickjs packages", () => {
  assert.equal(releaseTag({ source_id: "netease", package_id: "org.openkara.netease", version: "1.0.1" }), "netease-v1.0.1");
  assert.equal(releaseTag({ source_id: "netease", package_id: "org.openkara.netease-quickjs", version: "2.0.0" }), "netease-quickjs-v2.0.0");
});

test("an index can merge and hold both packages (protocol 1 netease and protocol 2 netease-quickjs)", () => {
  const first = build().envelope;
  const quickjsManifest = JSON.parse(readFileSync(join(root, "packages", "netease-quickjs", "manifest.json"), "utf8"));
  const quickjsArchive = {
    file: "openkara-source-netease-2.0.0.tar.gz",
    format: "tar.gz",
    size: 35971,
    sha256: "9e64d5540dcc209ef6d8fb9aea45be5b90b26c3f562fbe42ca4661c1ed251c76",
  };
  const second = buildSignedIndex({
    previousEnvelope: first,
    manifest: quickjsManifest,
    archive: quickjsArchive,
    pin,
    repo,
    revocations: {},
    privateKey,
    slot: "current",
    trusted,
  });
  assert.equal(second.payload.generation, 2);
  assert.equal(second.payload.sources.length, 2);
  const nodeSource = second.payload.sources.find((s) => s.package_id === "org.openkara.netease");
  const quickjsSource = second.payload.sources.find((s) => s.package_id === "org.openkara.netease-quickjs");
  assert.ok(nodeSource, "nodeSource must exist");
  assert.ok(quickjsSource, "quickjsSource must exist");
  assert.equal(nodeSource.source_id, "netease");
  assert.equal(quickjsSource.source_id, "netease");
  assert.deepEqual(nodeSource.releases.map((r) => r.manifest.version), ["1.0.0"]);
  assert.deepEqual(quickjsSource.releases.map((r) => r.manifest.version), ["2.0.0"]);
  const quickjsRelease = quickjsSource.releases[0];
  assert.equal(quickjsRelease.runtime, undefined);
  assert.equal(
    quickjsRelease.archive.url,
    `https://github.com/${repo}/releases/download/netease-quickjs-v2.0.0/openkara-source-netease-2.0.0.tar.gz`,
  );
  assert.deepEqual(validateIndexPayload(second.payload), []);
  assert.deepEqual(verifyEnvelope(second.envelope, trusted), second.payload);

  // Re-running the same QuickJS release keeps the generation; different bytes are refused
  assert.equal(
    buildSignedIndex({
      previousEnvelope: second.envelope,
      manifest: quickjsManifest,
      archive: quickjsArchive,
      pin,
      repo,
      revocations: {},
      privateKey,
      slot: "current",
      trusted,
    }).payload.generation,
    2,
  );
  assert.throws(
    () =>
      buildSignedIndex({
        previousEnvelope: second.envelope,
        manifest: quickjsManifest,
        archive: { ...quickjsArchive, sha256: "c".repeat(64) },
        pin,
        repo,
        revocations: {},
        privateKey,
        slot: "current",
        trusted,
      }),
    /already published with different contents/,
  );
});
