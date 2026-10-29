// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { writeTar } from "../scripts/lib/tar.mjs";
import {
  validateRegistry,
  verifyRegistryArchive,
  verifyRegistryFile,
} from "../scripts/verify-registry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(root, "scripts", "verify-registry.mjs");
const committedRegistryPath = join(root, "registry.json");
const committedRegistryText = readFileSync(committedRegistryPath, "utf8");
const committedRegistry = JSON.parse(committedRegistryText);

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeSyntheticArchive(manifest, entryFile = "dist/entry.mjs") {
  const entries = [
    {
      path: "package/manifest.json",
      data: Buffer.from(JSON.stringify(manifest), "utf8"),
      mode: 0o644,
    },
    {
      path: `package/${entryFile}`,
      data: Buffer.from("export default {};\n", "utf8"),
      mode: 0o644,
    },
  ];
  const tarBuf = writeTar(entries);
  return gzipSync(tarBuf);
}

function ensureRealArchive() {
  const quickjsDir = join(root, "packages", "netease-quickjs");
  const archivePath = join(quickjsDir, "dist", "openkara-source-netease-2.0.0.tar.gz");
  if (!existsSync(archivePath)) {
    const ci = spawnSync("npm", ["ci"], { cwd: quickjsDir, stdio: "inherit" });
    if (ci.status !== 0) throw new Error("npm ci in packages/netease-quickjs failed");
    const pack = spawnSync("npm", ["run", "pack"], { cwd: quickjsDir, stdio: "inherit" });
    if (pack.status !== 0) throw new Error("npm run pack in packages/netease-quickjs failed");
  }
  return archivePath;
}

test("committed registry.json passes the format check", () => {
  const problems = validateRegistry(committedRegistry, Buffer.byteLength(committedRegistryText, "utf8"));
  assert.deepEqual(problems, []);

  // Also verify via CLI invocation
  const cli = spawnSync(process.execPath, [scriptPath, committedRegistryPath], { encoding: "utf8" });
  assert.equal(cli.status, 0, `CLI failed: ${cli.stderr}`);
});

test("a valid registry passes format validation", () => {
  const doc = clone(committedRegistry);
  assert.deepEqual(validateRegistry(doc), []);
});

test("bad SRI fails validation", () => {
  // sha256 instead of sha512
  const docSha256 = clone(committedRegistry);
  docSha256.packages[0].versions[0].integrity = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
  assert.ok(validateRegistry(docSha256).some((p) => p.includes("integrity")));

  // invalid base64 / length
  const docShort = clone(committedRegistry);
  docShort.packages[0].versions[0].integrity = "sha512-AAAA";
  assert.ok(validateRegistry(docShort).some((p) => p.includes("integrity")));

  // multiple SRI digests separated by space
  const docDouble = clone(committedRegistry);
  const goodSri = docDouble.packages[0].versions[0].integrity;
  docDouble.packages[0].versions[0].integrity = `${goodSri} ${goodSri}`;
  assert.ok(validateRegistry(docDouble).some((p) => p.includes("integrity")));
});

test("duplicate package id fails validation", () => {
  const doc = clone(committedRegistry);
  const duplicate = clone(doc.packages[0]);
  doc.packages.push(duplicate);
  assert.ok(validateRegistry(doc).some((p) => p.includes("duplicate package_id")));
});

test("non-https URL fails validation", () => {
  // Non-https homepage
  const docHttpHome = clone(committedRegistry);
  docHttpHome.homepage = "http://github.com/thedavidweng/openkara-sources";
  assert.ok(validateRegistry(docHttpHome).some((p) => p.includes("homepage")));

  // Non-https version download URL
  const docHttpUrl = clone(committedRegistry);
  docHttpUrl.packages[0].versions[0].urls = ["http://example.com/package.tar.gz"];
  assert.ok(validateRegistry(docHttpUrl).some((p) => p.includes("urls")));

  // Non-https resource origin
  const docHttpOrigin = clone(committedRegistry);
  docHttpOrigin.packages[0].versions[0].resource_origins = ["http://music.163.com"];
  assert.ok(validateRegistry(docHttpOrigin).some((p) => p.includes("resource_origins")));

  // Non-exact origin (path included)
  const docPathOrigin = clone(committedRegistry);
  docPathOrigin.packages[0].versions[0].media_origins = ["https://m7.music.126.net/path"];
  assert.ok(validateRegistry(docPathOrigin).some((p) => p.includes("media_origins")));
});

test("manifest mismatch fails archive verification", () => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-registry-test-"));
  try {
    const archivePath = join(tmp, "test-archive.tar.gz");
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", "netease-quickjs", "manifest.json"), "utf8")
    );

    // 1. License mismatch
    const badLicenseManifest = { ...manifest, license: "MIT" };
    writeFileSync(archivePath, makeSyntheticArchive(badLicenseManifest));
    assert.throws(
      () => verifyRegistryArchive({ archivePath, version: "2.0.0", registry: committedRegistry }),
      /mismatch|license/i
    );

    // 2. Capabilities mismatch
    const badCapsManifest = { ...manifest, capabilities: ["search"] };
    writeFileSync(archivePath, makeSyntheticArchive(badCapsManifest));
    assert.throws(
      () => verifyRegistryArchive({ archivePath, version: "2.0.0", registry: committedRegistry }),
      /mismatch|capabilities/i
    );

    // 3. Source ID mismatch
    const badSourceManifest = { ...manifest, source_id: "other" };
    writeFileSync(archivePath, makeSyntheticArchive(badSourceManifest));
    assert.throws(
      () => verifyRegistryArchive({ archivePath, version: "2.0.0", registry: committedRegistry }),
      /mismatch|not found|source_id/i
    );

    // 4. Missing version in registry
    writeFileSync(archivePath, makeSyntheticArchive(manifest));
    assert.throws(
      () => verifyRegistryArchive({ archivePath, version: "1.9.9", registry: committedRegistry }),
      /not found|version/i
    );

    // 5. Size mismatch: make synthetic archive and construct matching registry except size
    const syntheticGz = makeSyntheticArchive(manifest);
    writeFileSync(archivePath, syntheticGz);
    const docSizeMismatch = clone(committedRegistry);
    docSizeMismatch.packages[0].versions[0].size = syntheticGz.length + 10;
    docSizeMismatch.packages[0].versions[0].integrity =
      "sha512-" + createHash("sha512").update(syntheticGz).digest("base64");
    assert.throws(
      () => verifyRegistryArchive({ archivePath, version: "2.0.0", registry: docSizeMismatch }),
      /size/i
    );

    // 6. Integrity mismatch
    const docSriMismatch = clone(committedRegistry);
    docSriMismatch.packages[0].versions[0].size = syntheticGz.length;
    docSriMismatch.packages[0].versions[0].integrity = "sha512-" + "A".repeat(86) + "==";
    assert.throws(
      () => verifyRegistryArchive({ archivePath, version: "2.0.0", registry: docSriMismatch }),
      /integrity/i
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("real built archive matches committed registry entry", () => {
  const archivePath = ensureRealArchive();
  const result = verifyRegistryArchive({ archivePath, version: "2.0.0", registry: committedRegistry });
  assert.equal(result.package_id, "org.openkara.netease-quickjs");
  assert.equal(result.version, "2.0.0");
  assert.equal(result.size, committedRegistry.packages[0].versions[0].size);
  assert.equal(result.integrity, committedRegistry.packages[0].versions[0].integrity);

  // CLI invocation
  const cli = spawnSync(
    process.execPath,
    [scriptPath, committedRegistryPath, "--archive", archivePath, "--version", "2.0.0"],
    { encoding: "utf8" }
  );
  assert.equal(cli.status, 0, `CLI failed: ${cli.stderr}`);
});
