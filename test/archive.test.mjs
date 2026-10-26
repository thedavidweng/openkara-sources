// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { buildPackage, verifyArchiveFile } from "../scripts/lib/package-build.mjs";
import { readTar, writeTar } from "../scripts/lib/tar.mjs";
import { relativePathError, validateArchiveEntries } from "../scripts/lib/host-rules.mjs";
import { MANIFEST, PACKAGE_DIR } from "./support/client.mjs";
import { checkDependencySecurity } from "./support/dependency-security.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "sources-archive-"));

function seedModules(staging) {
  const dir = join(staging, "node_modules", "left-pad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0", license: "MIT" }));
  writeFileSync(join(dir, "LICENSE"), "MIT License\n");
}

test("tar writer and reader round-trip long and non-ASCII paths", () => {
  const long = `${"d".repeat(90)}/${"e".repeat(90)}/file.js`;
  const entries = [
    { path: "a.txt", data: Buffer.from("a"), mode: 0o644 },
    { path: long, data: Buffer.from("long"), mode: 0o755 },
    { path: "node_modules/ünï/ファイル.js", data: Buffer.from("u"), mode: 0o644 },
  ];
  const read = readTar(writeTar(entries));
  assert.deepEqual(read.map((e) => e.path).sort(), entries.map((e) => e.path).sort());
  const byPath = Object.fromEntries(read.map((e) => [e.path, e]));
  assert.equal(byPath[long].data.toString(), "long");
  assert.equal(byPath[long].mode, 0o755);
  assert.equal(byPath["a.txt"].mode, 0o644);
});

test("host rules reject unsafe archives", () => {
  const file = (path, body = "x") => ({ path, type: "file", size: body.length, data: Buffer.from(body) });
  const manifest = { entry: "src/worker.mjs" };
  const base = ["manifest.json", "LICENSE", "NOTICE", "package-lock.json", "src/worker.mjs"].map((p) =>
    file(p, p === "manifest.json" ? JSON.stringify(manifest) : "x"),
  );
  assert.deepEqual(validateArchiveEntries(base, manifest), []);
  const has = (extra, text) =>
    assert.ok(validateArchiveEntries([...base, ...extra], manifest).some((p) => p.includes(text)), text);
  has([{ path: "link", type: "symlink", size: 0, data: Buffer.alloc(0) }], "symlink");
  has([file("a\\b")], "forbidden character");
  has([file("../x")], "non-normal");
  has([file("/abs")], "absolute");
  has([file("src/worker.mjs")], "duplicate");
  has([file("node_modules/x/package.json", '{"scripts":{"postinstall":"x"}}')], "postinstall");
  assert.ok(validateArchiveEntries(base.slice(1), manifest).some((p) => p.includes("missing required file manifest.json")));
  assert.ok(relativePathError("") && relativePathError("./") && !relativePathError("a/b"));
});

test("a seeded build is reproducible, symlink-free and passes the host rules", () => {
  const out = scratch();
  try {
    const first = buildPackage({ packageDir: PACKAGE_DIR, outDir: join(out, "a"), seed: seedModules });
    const second = buildPackage({ packageDir: PACKAGE_DIR, outDir: join(out, "b"), seed: seedModules });
    assert.equal(first.sha256, second.sha256);
    const archive = join(out, "a", first.file);
    assert.deepEqual(verifyArchiveFile(archive, MANIFEST), []);
    const bytes = readFileSync(archive);
    assert.equal(first.size, bytes.length);
    assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
    const entries = readTar(gunzipSync(bytes));
    assert.ok(entries.every((e) => e.type === "file"));
    const paths = entries.map((e) => e.path);
    for (const required of ["manifest.json", "LICENSE", "NOTICE", "package-lock.json", "THIRD-PARTY-LICENSES.md", "src/worker.mjs"])
      assert.ok(paths.includes(required), required);
    const inventory = entries.find((e) => e.path === "THIRD-PARTY-LICENSES.md").data.toString();
    assert.match(inventory, /\| left-pad \| 1\.0\.0 \| MIT \|/);
    assert.ok(!paths.some((p) => p.includes(".bin/")));
    assert.ok(!paths.some((p) => p.startsWith("test/")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a build fails on packages without license information", () => {
  const out = scratch();
  try {
    assert.throws(
      () =>
        buildPackage({
          packageDir: PACKAGE_DIR,
          outDir: out,
          seed(staging) {
            const dir = join(staging, "node_modules", "mystery");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mystery", version: "1.0.0" }));
          },
        }),
      /without license information: mystery@1\.0\.0/,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a build fails on symlinks and install scripts", () => {
  const out = scratch();
  try {
    assert.throws(
      () =>
        buildPackage({
          packageDir: PACKAGE_DIR,
          outDir: out,
          seed(staging) {
            seedModules(staging);
            symlinkSync("/etc/hosts", join(staging, "node_modules", "left-pad", "hosts"));
          },
        }),
      /symlink in package/,
    );
    assert.throws(
      () =>
        buildPackage({
          packageDir: PACKAGE_DIR,
          outDir: out,
          seed(staging) {
            seedModules(staging);
            writeFileSync(
              join(staging, "node_modules", "left-pad", "package.json"),
              JSON.stringify({ name: "left-pad", version: "1.0.0", license: "MIT", scripts: { install: "x" } }),
            );
          },
        }),
      /declares install script/,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test(
  "the real archive installs, passes the host rules and completes a handshake unmocked",
  { skip: process.env.OPENKARA_SKIP_NETWORK_TESTS === "1" && "network tests disabled", timeout: 240000 },
  async () => {
    const out = scratch();
    try {
      const meta = buildPackage({ packageDir: PACKAGE_DIR, outDir: out });
      const archive = join(out, meta.file);
      assert.deepEqual(verifyArchiveFile(archive, MANIFEST), []);
      assert.ok(meta.third_party_packages > 100);
      const target = join(out, "extracted");
      mkdirSync(target);
      const untar = spawnSync("tar", ["xzf", archive, "-C", target]);
      assert.equal(untar.status, 0, untar.stderr?.toString());
      checkDependencySecurity(target);
      // Run exactly as the host does: cwd = package dir, argv = <package>/<entry>, cleared env.
      const child = spawn(process.execPath, [join(target, MANIFEST.entry)], {
        cwd: target,
        env: { TMPDIR: out },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stdin.write(`${JSON.stringify({ id: "h", method: "handshake", params: { protocol_majors: [1], host_version: "0.17.0" } })}\n`);
      child.stdin.write(`${JSON.stringify({ id: "d", method: "describe", params: {} })}\n`);
      await new Promise((resolve) => {
        const timer = setInterval(() => stdout.split("\n").filter(Boolean).length >= 2 && (clearInterval(timer), resolve()), 25);
      });
      child.stdin.end();
      const [handshake, describe] = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(handshake.result.package_id, MANIFEST.package_id);
      assert.equal(describe.result.session.state, "signed_out");
      assert.deepEqual(describe.result.capabilities, MANIFEST.capabilities);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
);
