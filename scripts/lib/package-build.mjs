// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { validateArchiveEntries, validateManifest } from "./host-rules.mjs";
import { readTar, writeTar } from "./tar.mjs";

const COPY = ["manifest.json", "package.json", "package-lock.json", "LICENSE", "NOTICE", "README.md", "LICENSES", "src"];
const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.|-|$)/i;

function walk(directory, visit) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(path, visit);
    else visit(path, stat);
  }
}

function licenseName(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (typeof pkg.license?.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return null;
}

/** Builds THIRD-PARTY-LICENSES.md from every installed package; fails on missing licenses. */
export function licenseInventory(modulesDir) {
  const packages = [];
  const missing = [];
  walk(modulesDir, (path) => {
    const rel = relative(modulesDir, path).split(sep);
    if (rel.at(-1) !== "package.json") return;
    const dir = rel.slice(0, -1);
    // A package root is <...>/node_modules/<name> or <...>/node_modules/@scope/<name>.
    const parent = dir.at(-2);
    const grand = dir.at(-3);
    const isRoot = dir.length === 1 || parent === "node_modules" || (parent?.startsWith("@") && (dir.length === 2 || grand === "node_modules"));
    if (!isRoot) return;
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    const root = join(modulesDir, ...dir);
    const texts = readdirSync(root)
      .filter((file) => LICENSE_FILE.test(file) && lstatSync(join(root, file)).isFile())
      .sort()
      .map((file) => ({ file, text: readFileSync(join(root, file), "utf8").trim() }));
    const license = licenseName(pkg);
    const label = `${pkg.name}@${pkg.version}`;
    if (!license && texts.length === 0) missing.push(label);
    packages.push({ name: pkg.name, version: pkg.version, license: license ?? "see license text", texts, label });
  });
  if (missing.length) throw new Error(`packages without license information: ${missing.join(", ")}`);
  packages.sort((a, b) => (a.label < b.label ? -1 : 1));
  const lines = [
    "# Third-party licenses",
    "",
    "Generated at build time from the packages bundled in this archive.",
    "",
    "| Package | Version | License |",
    "| --- | --- | --- |",
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
    "",
  ];
  for (const p of packages) {
    lines.push(`## ${p.label}`, "", `License: ${p.license}`, "");
    for (const { file, text } of p.texts) lines.push(`### ${file}`, "", "```text", text, "```", "");
  }
  return { markdown: lines.join("\n"), count: packages.length };
}

function npm(args, cwd) {
  const result = spawnSync("npm", args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NODE_ENV: "production" } });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
}

function collect(staging) {
  const entries = [];
  walk(staging, (path, stat) => {
    const rel = relative(staging, path).split(sep).join("/");
    if (stat.isSymbolicLink()) throw new Error(`symlink in package: ${rel} -> ${readlinkSync(path)}`);
    if (!stat.isFile()) throw new Error(`unsupported file type: ${rel}`);
    entries.push({ path: rel, data: readFileSync(path), mode: stat.mode });
  });
  return entries;
}

/**
 * Stages a package, installs production dependencies, and writes a reproducible
 * tar.gz plus its metadata. `seed(stagingDir)` replaces `npm ci` (used by tests).
 */
export function buildPackage({ packageDir, outDir, seed }) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "manifest.json"), "utf8"));
  const source = { source_id: manifest.source_id, publisher: manifest.publisher, package_id: manifest.package_id };
  const manifestProblems = validateManifest(manifest, source);
  if (manifestProblems.length) throw new Error(`manifest is invalid:\n${manifestProblems.join("\n")}`);

  const staging = mkdtempSync(join(tmpdir(), "openkara-source-stage-"));
  try {
    for (const name of COPY) {
      if (existsSync(join(packageDir, name))) cpSync(join(packageDir, name), join(staging, name), { recursive: true });
    }
    if (seed) seed(staging);
    else npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], staging);
    // npm links executables under .bin; the host rejects symlinks and the worker never uses them.
    rmSync(join(staging, "node_modules", ".bin"), { recursive: true, force: true });
    const modules = join(staging, "node_modules");
    if (!existsSync(modules)) throw new Error("node_modules was not installed");
    const inventory = licenseInventory(modules);
    writeFileSync(join(staging, "THIRD-PARTY-LICENSES.md"), inventory.markdown);

    const entries = collect(staging);
    const problems = validateArchiveEntries(
      entries.map((e) => ({ path: e.path, type: "file", size: e.data.length, data: e.data })),
      manifest,
    );
    if (problems.length) throw new Error(`archive violates host rules:\n${problems.slice(0, 20).join("\n")}`);

    const archive = gzipSync(writeTar(entries), { level: 9 });
    const fileName = `openkara-source-${manifest.source_id}-${manifest.version}.tar.gz`;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, fileName), archive);
    const meta = {
      source_id: manifest.source_id,
      version: manifest.version,
      file: fileName,
      format: "tar.gz",
      size: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      files: entries.length,
      third_party_packages: inventory.count,
    };
    writeFileSync(join(outDir, `${fileName}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Reads a built archive back and checks it against a manifest with the host rules. */
export function verifyArchiveFile(archivePath, manifest) {
  const entries = readTar(gunzipSync(readFileSync(archivePath)));
  return validateArchiveEntries(entries, manifest);
}
