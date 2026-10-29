// SPDX-License-Identifier: AGPL-3.0-only
// Re-implementation of the OpenKara host's structural rules for source packages
// and signed indexes. Keep in step with the host (source_host/install.rs, mod.rs).
import { isDeepStrictEqual } from "node:util";

export const MAX_MEMBERS = 100_000;
export const MAX_EXPANDED_BYTES = 4 * 1024 ** 3;
export const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3;
export const REQUIRED_ROOT_FILES = ["manifest.json", "LICENSE", "NOTICE", "package-lock.json"];
export const TARGET_KEYS = ["macos-aarch64", "macos-x86_64", "windows-x86_64", "linux-x86_64", "linux-aarch64"];
export const FORMATS = ["tar", "tar.gz", "zip"];
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

export const isSemver = (value) => typeof value === "string" && SEMVER.test(value);

/** Mirrors the host's `relative()`: returns an error string or null. */
export function relativePathError(path) {
  if (typeof path !== "string" || path === "") return "empty path";
  if (/[\\:\0]/.test(path)) return "forbidden character";
  if (path.startsWith("/")) return "absolute path";
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return "non-normal component";
  }
  return null;
}

export function validateArchiveEntries(entries, manifest) {
  const problems = [];
  if (entries.length > MAX_MEMBERS) problems.push(`more than ${MAX_MEMBERS} members`);
  const files = new Map();
  const seen = new Set();
  let expanded = 0;
  for (const entry of entries) {
    const error = relativePathError(entry.path);
    if (error) {
      problems.push(`${JSON.stringify(entry.path)}: ${error}`);
      continue;
    }
    if (seen.has(entry.path)) problems.push(`${entry.path}: duplicate entry`);
    seen.add(entry.path);
    if (entry.type !== "file" && entry.type !== "directory") {
      problems.push(`${entry.path}: ${entry.type} entries are not allowed`);
      continue;
    }
    if (entry.type === "file") {
      expanded += entry.size;
      files.set(entry.path, entry);
      if (entry.path === "package.json" || entry.path.endsWith("/package.json")) {
        let scripts;
        try {
          scripts = JSON.parse(entry.data.toString("utf8")).scripts;
        } catch {
          problems.push(`${entry.path}: not valid JSON`);
        }
        if (scripts && typeof scripts === "object") {
          for (const name of INSTALL_SCRIPTS) {
            if (Object.hasOwn(scripts, name)) problems.push(`${entry.path}: declares ${name} script`);
          }
        }
      }
    }
  }
  if (expanded > MAX_EXPANDED_BYTES) problems.push("expanded size exceeds 4 GiB");
  for (const name of [...REQUIRED_ROOT_FILES, manifest.entry]) {
    if (!files.has(name)) problems.push(`missing required file ${name}`);
  }
  const embedded = files.get("manifest.json");
  if (embedded) {
    try {
      if (!isDeepStrictEqual(JSON.parse(embedded.data.toString("utf8")), manifest))
        problems.push("manifest.json differs from the release manifest");
    } catch {
      problems.push("manifest.json is not valid JSON");
    }
  }
  return problems;
}

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function originProblem(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && !url.username ? null : "not a canonical https origin";
  } catch {
    return "not a URL";
  }
}

function artifactProblems(label, artifact, executable) {
  const problems = [];
  if (typeof artifact?.url !== "string" || !artifact.url.startsWith("https://")) problems.push(`${label}: url must be https`);
  if (!Number.isInteger(artifact?.size) || artifact.size < 1 || artifact.size > MAX_ARTIFACT_BYTES)
    problems.push(`${label}: size out of range`);
  if (!SHA256.test(artifact?.sha256 ?? "")) problems.push(`${label}: sha256 must be lowercase hex`);
  if (!FORMATS.includes(artifact?.format)) problems.push(`${label}: unsupported format`);
  if (executable) {
    const error = relativePathError(artifact?.executable);
    if (error) problems.push(`${label}: executable ${error}`);
  } else if (artifact?.executable) {
    problems.push(`${label}: package archives must not declare an executable`);
  }
  return problems;
}

export function validateManifest(manifest, source) {
  const problems = [];
  const m = manifest ?? {};
  if (m.manifest_version !== 1) problems.push("manifest_version must be 1");
  for (const field of ["source_id", "publisher", "package_id"]) {
    if (m[field] !== source[field]) problems.push(`manifest ${field} differs from the source`);
  }
  if (!isSemver(m.version)) problems.push("manifest version is not SemVer");
  if (!isSemver(m.minimum_host_version)) problems.push("minimum_host_version is not SemVer");
  if (!Array.isArray(m.protocol?.majors) || m.protocol.majors.length === 0) problems.push("protocol.majors is empty");
  const runtimeKind = m.runtime?.kind;
  if ((runtimeKind !== "node" && runtimeKind !== "openkara-js") || !Number.isInteger(m.runtime?.major))
    problems.push("runtime must be node or openkara-js with a major");
  if (typeof m.entry !== "string" || !m.entry.endsWith(".mjs") || relativePathError(m.entry))
    problems.push("entry must be a safe relative .mjs path");
  if (!m.name || !m.license) problems.push("name and license are required");
  for (const list of ["resource_origins", "media_origins"]) {
    for (const origin of m[list] ?? []) {
      const error = originProblem(origin);
      if (error) problems.push(`${list} ${origin}: ${error}`);
    }
  }
  const auth = m.authentication;
  if (auth?.flow === "web") {
    if (!(auth.navigation_origins ?? []).length) problems.push("web auth needs navigation_origins");
    for (const origin of auth.navigation_origins ?? []) {
      const error = originProblem(origin);
      if (error) problems.push(`navigation_origins ${origin}: ${error}`);
    }
    try {
      if (!(auth.navigation_origins ?? []).includes(new URL(auth.sign_in_url).origin))
        problems.push("sign_in_url origin is not in navigation_origins");
    } catch {
      problems.push("sign_in_url is not a URL");
    }
    if (!(auth.cookie_names ?? []).length) problems.push("cookie_names is empty");
    for (const name of auth.cookie_names ?? []) {
      if (!name || /[\r\n; =]/.test(name)) problems.push(`invalid cookie name ${JSON.stringify(name)}`);
    }
  }
  return problems;
}

export function validateIndexPayload(payload) {
  const problems = [];
  if (payload?.schema_version !== 1) problems.push("schema_version must be 1");
  if (!Number.isInteger(payload?.generation) || payload.generation < 0) problems.push("generation must be a uint");
  if (!Array.isArray(payload?.sources)) return [...problems, "sources must be an array"];
  const ids = new Set();
  for (const source of payload.sources) {
    const where = `source ${source?.source_id}`;
    if (!SOURCE_ID.test(source?.source_id ?? "")) problems.push(`${where}: invalid source_id`);
    const key = source?.package_id ? `${source.source_id}:${source.package_id}` : source?.source_id;
    if (ids.has(key)) problems.push(`${where}: duplicate source`);
    ids.add(key);
    for (const version of source?.revoked_versions ?? []) {
      if (!isSemver(version)) problems.push(`${where}: revoked version ${version} is not SemVer`);
    }
    const versions = new Set();
    for (const release of source?.releases ?? []) {
      const label = `${where} ${release?.manifest?.version}`;
      problems.push(...validateManifest(release?.manifest, source).map((p) => `${label}: ${p}`));
      if (versions.has(release?.manifest?.version)) problems.push(`${label}: duplicate version`);
      versions.add(release?.manifest?.version);
      problems.push(...artifactProblems(`${label} archive`, release?.archive, false));
      const runtime = release?.runtime;
      if (release?.manifest?.runtime?.kind === "node") {
        if (!isSemver(runtime?.version)) problems.push(`${label}: runtime version is not SemVer`);
        else if (Number(runtime.version.split(".")[0]) !== release?.manifest?.runtime?.major)
          problems.push(`${label}: runtime major differs from the manifest`);
        const targets = Object.entries(runtime?.targets ?? {});
        if (targets.length === 0) problems.push(`${label}: runtime targets are empty`);
        for (const [key, target] of targets) {
          if (!TARGET_KEYS.includes(key)) problems.push(`${label}: unknown target ${key}`);
          problems.push(...artifactProblems(`${label} runtime ${key}`, target, true));
        }
      } else if (runtime != null) {
        problems.push(`${label}: openkara-js release must not declare a runtime pin`);
      }
    }
  }
  return problems;
}
