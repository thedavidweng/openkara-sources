#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Validates registry.json (format_version 1) and optionally verifies a package archive.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { readTar } from "./lib/tar.mjs";

const FORMAT_VERSION = 1;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGES = 1000;
const MAX_VERSIONS = 200;
const MAX_URLS = 8;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function isValidSemver(v) {
  return typeof v === "string" && SEMVER_RE.test(v);
}

function isValidId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return false;
  return /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

function isValidSourceId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
  return /^[a-z][a-z0-9_-]*$/.test(id);
}

function isValidLicense(license) {
  if (typeof license !== "string" || license.trim().length === 0 || license.length > 256) return false;
  return /^[A-Za-z0-9 .\-+:()]+$/.test(license);
}

function isValidCapability(capability) {
  if (typeof capability !== "string" || capability.length === 0 || capability.length > 64) return false;
  return /^[a-z0-9_]+$/.test(capability);
}

function parseHttpsUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function isExactOrigin(originString) {
  if (typeof originString !== "string") return false;
  const url = parseHttpsUrl(originString);
  if (!url) return false;
  return url.origin === originString;
}

function hasDuplicates(array) {
  return new Set(array).size !== array.length;
}

function sameSet(a = [], b = []) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

function parseSha512Sri(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    return null;
  }
  const b64 = integrity.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(b64)) {
    return null;
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 64 || buf.toString("base64") !== b64) {
    return null;
  }
  return buf;
}

/**
 * Validates a Source Registry object against format_version 1 rules.
 * Returns an array of problem strings (empty if valid).
 */
export function validateRegistry(registry, documentByteLength = 0) {
  const problems = [];

  if (documentByteLength > MAX_DOCUMENT_BYTES) {
    problems.push(`document size ${documentByteLength} exceeds max ${MAX_DOCUMENT_BYTES} bytes`);
  }

  if (!registry || typeof registry !== "object") {
    return ["registry document must be an object"];
  }

  if (registry.format_version !== FORMAT_VERSION) {
    problems.push(`expected format_version ${FORMAT_VERSION}, got ${registry.format_version}`);
  }

  if (!isValidId(registry.registry_id)) {
    problems.push(`invalid registry_id "${registry.registry_id}"`);
  }

  if (typeof registry.display_name !== "string" || registry.display_name.trim().length === 0) {
    problems.push(`invalid display_name: must be a non-empty string`);
  }

  if (!parseHttpsUrl(registry.homepage)) {
    problems.push(`invalid homepage "${registry.homepage}": must be a valid HTTPS URL`);
  }

  if (!Array.isArray(registry.packages)) {
    problems.push("registry.packages must be an array");
    return problems;
  }

  if (registry.packages.length > MAX_PACKAGES) {
    problems.push(`packages count ${registry.packages.length} exceeds max ${MAX_PACKAGES}`);
  }

  const packageIds = registry.packages.map((p) => p.package_id);
  if (hasDuplicates(packageIds)) {
    problems.push("duplicate package_id found in packages");
  }

  for (let pIdx = 0; pIdx < registry.packages.length; pIdx += 1) {
    const pkg = registry.packages[pIdx];
    const prefix = `packages[${pIdx}] (${pkg?.package_id || pIdx})`;

    if (!isValidId(pkg.package_id)) {
      problems.push(`${prefix}: invalid package_id "${pkg.package_id}"`);
    }

    if (!isValidSourceId(pkg.source_id)) {
      problems.push(`${prefix}: invalid source_id "${pkg.source_id}"`);
    }

    if (typeof pkg.name !== "string" || pkg.name.trim().length === 0) {
      problems.push(`${prefix}: name must be a non-empty string`);
    }

    if (!isValidLicense(pkg.license)) {
      problems.push(`${prefix}: invalid license "${pkg.license}"`);
    }

    if (!Array.isArray(pkg.versions) || pkg.versions.length === 0) {
      problems.push(`${prefix}: versions must be a non-empty array`);
      continue;
    }

    if (pkg.versions.length > MAX_VERSIONS) {
      problems.push(`${prefix}: versions count ${pkg.versions.length} exceeds max ${MAX_VERSIONS}`);
    }

    const versionStrings = pkg.versions.map((v) => v.version);
    if (hasDuplicates(versionStrings)) {
      problems.push(`${prefix}: duplicate version found in package versions`);
    }

    for (let vIdx = 0; vIdx < pkg.versions.length; vIdx += 1) {
      const ver = pkg.versions[vIdx];
      const verPrefix = `${prefix}.versions[${vIdx}] (${ver?.version || vIdx})`;

      if (!isValidSemver(ver.version)) {
        problems.push(`${verPrefix}: invalid SemVer version "${ver.version}"`);
      }

      if (!isValidSemver(ver.minimum_host_version)) {
        problems.push(`${verPrefix}: invalid SemVer minimum_host_version "${ver.minimum_host_version}"`);
      }

      if (
        !Array.isArray(ver.protocol_majors) ||
        ver.protocol_majors.length === 0 ||
        ver.protocol_majors.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff) ||
        hasDuplicates(ver.protocol_majors)
      ) {
        problems.push(`${verPrefix}: protocol_majors must be non-empty unique unsigned integers`);
      }

      if (!Number.isSafeInteger(ver.size) || ver.size <= 0 || ver.size > MAX_PACKAGE_BYTES) {
        problems.push(`${verPrefix}: size ${ver.size} must be between 1 and ${MAX_PACKAGE_BYTES} bytes`);
      }

      if (!parseSha512Sri(ver.integrity)) {
        problems.push(`${verPrefix}: invalid sha512 integrity SRI "${ver.integrity}"`);
      }

      if (!Array.isArray(ver.urls) || ver.urls.length === 0 || ver.urls.length > MAX_URLS) {
        problems.push(`${verPrefix}: urls must contain 1 to ${MAX_URLS} URLs`);
      } else {
        for (const url of ver.urls) {
          if (!parseHttpsUrl(url)) {
            problems.push(`${verPrefix}: urls entry "${url}" must be a valid HTTPS URL`);
          }
        }
      }

      if (!Array.isArray(ver.resource_origins) || hasDuplicates(ver.resource_origins)) {
        problems.push(`${verPrefix}: resource_origins must be unique`);
      } else {
        for (const origin of ver.resource_origins) {
          if (!isExactOrigin(origin)) {
            problems.push(`${verPrefix}: resource_origins entry "${origin}" must be an exact HTTPS origin`);
          }
        }
      }

      if (!Array.isArray(ver.media_origins) || hasDuplicates(ver.media_origins)) {
        problems.push(`${verPrefix}: media_origins must be unique`);
      } else {
        for (const origin of ver.media_origins) {
          if (!isExactOrigin(origin)) {
            problems.push(`${verPrefix}: media_origins entry "${origin}" must be an exact HTTPS origin`);
          }
        }
      }

      if (!Array.isArray(ver.capabilities) || hasDuplicates(ver.capabilities)) {
        problems.push(`${verPrefix}: capabilities must be unique`);
      } else {
        for (const cap of ver.capabilities) {
          if (!isValidCapability(cap)) {
            problems.push(`${verPrefix}: invalid capability "${cap}"`);
          }
        }
      }
    }
  }

  return problems;
}

/**
 * Validates a registry JSON file on disk.
 */
export function verifyRegistryFile(path) {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  const doc = JSON.parse(text);
  const problems = validateRegistry(doc, bytes.length);
  if (problems.length > 0) {
    throw new Error(`registry validation failed for ${path}:\n${problems.join("\n")}`);
  }
  return doc;
}

/**
 * Checks an archive (.tar.gz) against the registry entry for the given version.
 */
export function verifyRegistryArchive({ archivePath, version, registry }) {
  if (!archivePath) throw new Error("archivePath is required");
  if (!version) throw new Error("version is required");
  if (!registry) throw new Error("registry is required");

  const archiveBytes = readFileSync(archivePath);
  const tarBytes = gunzipSync(archiveBytes);
  const members = readTar(tarBytes);

  const manifestEntry = members.find((m) => m.path === "package/manifest.json");
  if (!manifestEntry) {
    throw new Error("archive does not contain package/manifest.json");
  }
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));

  // Find corresponding package and version in registry
  let targetPkg = (registry.packages || []).find((pkg) => pkg.package_id === manifest.package_id) ?? null;
  let targetVer = targetPkg?.versions?.find((v) => v.version === version) ?? null;

  if (!targetPkg || !targetVer) {
    throw new Error(`registry entry for package "${manifest.package_id}" version "${version}" not found`);
  }

  // 1. Check archive size and SHA-512 SRI
  if (archiveBytes.length !== targetVer.size) {
    throw new Error(
      `archive size mismatch: actual ${archiveBytes.length} bytes vs registry ${targetVer.size} bytes`
    );
  }

  const actualSri = "sha512-" + createHash("sha512").update(archiveBytes).digest("base64");
  if (actualSri !== targetVer.integrity) {
    throw new Error(
      `archive integrity mismatch: actual ${actualSri} vs registry ${targetVer.integrity}`
    );
  }

  // 2. Check manifest fields match registry entry
  if (manifest.source_id !== targetPkg.source_id) {
    throw new Error(`manifest source_id mismatch: "${manifest.source_id}" vs "${targetPkg.source_id}"`);
  }
  if (manifest.package_id !== targetPkg.package_id) {
    throw new Error(`manifest package_id mismatch: "${manifest.package_id}" vs "${targetPkg.package_id}"`);
  }
  if (manifest.version !== targetVer.version) {
    throw new Error(`manifest version mismatch: "${manifest.version}" vs "${targetVer.version}"`);
  }
  if (manifest.version !== version) {
    throw new Error(`manifest version "${manifest.version}" does not match requested version "${version}"`);
  }
  if (manifest.minimum_host_version !== targetVer.minimum_host_version) {
    throw new Error(
      `manifest minimum_host_version mismatch: "${manifest.minimum_host_version}" vs "${targetVer.minimum_host_version}"`
    );
  }
  if (manifest.license !== targetPkg.license) {
    throw new Error(`manifest license mismatch: "${manifest.license}" vs "${targetPkg.license}"`);
  }

  const manifestMajors = manifest.protocol?.majors || [];
  if (!sameSet(manifestMajors, targetVer.protocol_majors)) {
    throw new Error(
      `manifest protocol majors mismatch: [${manifestMajors}] vs [${targetVer.protocol_majors}]`
    );
  }

  if (!sameSet(manifest.capabilities, targetVer.capabilities)) {
    throw new Error("manifest capabilities do not match registry capabilities");
  }
  if (!sameSet(manifest.resource_origins, targetVer.resource_origins)) {
    throw new Error("manifest resource_origins do not match registry resource_origins");
  }
  if (!sameSet(manifest.media_origins, targetVer.media_origins)) {
    throw new Error("manifest media_origins do not match registry media_origins");
  }

  // 3. Basic manifest validation
  if (manifest.manifest_version !== 1) {
    throw new Error(`manifest_version must be 1, got ${manifest.manifest_version}`);
  }
  if (!manifest.entry || !manifest.entry.endsWith(".mjs")) {
    throw new Error(`manifest entry must end with .mjs: ${manifest.entry}`);
  }
  const entryPath = `package/${manifest.entry}`;
  const entryFile = members.find((m) => m.path === entryPath && m.type === "file");
  if (!entryFile) {
    throw new Error(`manifest entry file "${entryPath}" not found in archive`);
  }
  if (manifest.runtime?.kind !== "openkara-js" || manifest.runtime?.major !== 1) {
    throw new Error("manifest runtime must be openkara-js major 1");
  }

  return {
    package_id: targetPkg.package_id,
    source_id: targetPkg.source_id,
    version: targetVer.version,
    size: archiveBytes.length,
    integrity: actualSri,
  };
}

// CLI entry point
function runCli() {
  const args = process.argv.slice(2);
  let registryPath = null;
  let archivePath = null;
  let version = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--archive") {
      archivePath = args[++i];
    } else if (arg === "--version") {
      version = args[++i];
    } else if (arg === "--registry") {
      registryPath = args[++i];
    } else if (!arg.startsWith("--") && !registryPath) {
      registryPath = arg;
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if ((archivePath && !version) || (version && !archivePath)) {
    console.error("both --archive and --version must be provided together");
    process.exit(2);
  }

  if (!registryPath) {
    const defaultPath = join(process.cwd(), "registry.json");
    if (existsSync(defaultPath)) {
      registryPath = defaultPath;
    } else {
      const rootDefault = join(dirname(fileURLToPath(import.meta.url)), "..", "registry.json");
      if (existsSync(rootDefault)) {
        registryPath = rootDefault;
      } else {
        console.error("registry.json not found; specify path or run from repository root");
        process.exit(2);
      }
    }
  }

  try {
    const doc = verifyRegistryFile(registryPath);
    console.log(`registry format ok: ${doc.registry_id} (${doc.packages.length} package(s))`);

    if (archivePath && version) {
      const res = verifyRegistryArchive({ archivePath, version, registry: doc });
      console.log(`archive verified: ${res.package_id} v${res.version} (${res.size} bytes, ${res.integrity})`);
    }
  } catch (error) {
    console.error(`verify-registry failed: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
