// SPDX-License-Identifier: AGPL-3.0-only
import { isDeepStrictEqual } from "node:util";
import { validateIndexPayload } from "./host-rules.mjs";
import { TRUSTED_KEYS, signEnvelope, verifyEnvelope } from "./trust.mjs";

export const TRIPLE_TO_TARGET = Object.freeze({
  "aarch64-apple-darwin": "macos-aarch64",
  "x86_64-apple-darwin": "macos-x86_64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "aarch64-unknown-linux-gnu": "linux-aarch64",
  "x86_64-pc-windows-msvc": "windows-x86_64",
});

/** Builds the per-platform Node runtime pin from data/source-runtime.json. */
export function runtimeFromPin(pin) {
  const targets = {};
  for (const [triple, entry] of Object.entries(pin.targets)) {
    const key = TRIPLE_TO_TARGET[triple];
    if (!key) throw new Error(`unknown runtime target ${triple}`);
    const windows = entry.archive_suffix.endsWith(".zip");
    const stem = `node-v${pin.version}-${entry.archive_suffix.replace(/\.(tar\.gz|zip)$/, "")}`;
    targets[key] = {
      url: `https://nodejs.org/dist/v${pin.version}/node-v${pin.version}-${entry.archive_suffix}`,
      size: entry.archive_size,
      sha256: entry.archive_sha256,
      format: windows ? "zip" : "tar.gz",
      executable: windows ? `${stem}/node.exe` : `${stem}/bin/node`,
    };
  }
  return { version: pin.version, targets };
}

export const TAG_PATTERNS = Object.freeze([
  { prefix: "netease-quickjs-v", package: "netease-quickjs" },
  { prefix: "netease-v", package: "netease" },
]);

export function parseReleaseTag(tag) {
  if (typeof tag !== "string") return null;
  for (const { prefix, package: pkg } of TAG_PATTERNS) {
    if (tag.startsWith(prefix)) {
      return { package: pkg, version: tag.slice(prefix.length) };
    }
  }
  return null;
}

export const releaseTag = (manifest) => {
  if (manifest?.package_id?.endsWith("-quickjs")) {
    return `${manifest.source_id}-quickjs-v${manifest.version}`;
  }
  return `${manifest.source_id}-v${manifest.version}`;
};

/**
 * Merges one new release into the previous payload (if any). Existing releases are
 * kept verbatim; republishing a version with different bytes is an error.
 */
export function mergePayload({ previous, manifest, archive, runtime, repo, revocations = {} }) {
  const sources = structuredClone(previous?.sources ?? []);
  let source = sources.find((s) => s.package_id === manifest.package_id);
  if (!source) {
    source = {
      source_id: manifest.source_id,
      publisher: manifest.publisher,
      package_id: manifest.package_id,
      revoked_versions: [],
      releases: [],
    };
    sources.push(source);
  }
  if (source.source_id !== manifest.source_id || source.publisher !== manifest.publisher || source.package_id !== manifest.package_id)
    throw new Error("source_id, publisher, or package_id changed for an existing source");

  const release = {
    manifest,
    archive: {
      url: `https://github.com/${repo}/releases/download/${releaseTag(manifest)}/${archive.file}`,
      size: archive.size,
      sha256: archive.sha256,
      format: archive.format,
    },
    ...(manifest.runtime?.kind === "node" ? { runtime } : {}),
  };
  const existing = source.releases.find((r) => r.manifest.version === manifest.version);
  if (existing) {
    if (existing.archive.sha256 !== release.archive.sha256)
      throw new Error(`version ${manifest.version} is already published with different contents`);
    if (!isDeepStrictEqual(existing.manifest, manifest)) throw new Error(`version ${manifest.version} manifest differs from the published one`);
    if (manifest.runtime?.kind === "node") existing.runtime = runtime;
  } else {
    source.releases.push(release);
  }
  source.releases.sort((a, b) => a.manifest.version.localeCompare(b.manifest.version, "en", { numeric: true }));
  source.revoked_versions = [...new Set([...(source.revoked_versions ?? []), ...(revocations[source.source_id] ?? [])])].sort();
  sources.sort((a, b) => {
    if (a.source_id !== b.source_id) return a.source_id < b.source_id ? -1 : 1;
    return a.package_id < b.package_id ? -1 : 1;
  });

  const generation = previous
    ? isDeepStrictEqual(previous.sources, sources)
      ? previous.generation
      : previous.generation + 1
    : 1;
  return { schema_version: 1, generation, sources };
}

export function decodePreviousIndex(envelope, trusted = TRUSTED_KEYS) {
  const payload = verifyEnvelope(envelope, trusted);
  const problems = validateIndexPayload(payload);
  if (problems.length) throw new Error(`previous index is invalid:\n${problems.join("\n")}`);
  return payload;
}

/** Full pipeline: merge, validate, sign, self-verify. Returns {envelope, payload}. */
export function buildSignedIndex({ previousEnvelope, manifest, archive, pin, repo, revocations, privateKey, slot, trusted = TRUSTED_KEYS }) {
  const previous = previousEnvelope ? decodePreviousIndex(previousEnvelope, trusted) : null;
  const payload = mergePayload({ previous, manifest, archive, runtime: runtimeFromPin(pin), repo, revocations });
  const problems = validateIndexPayload(payload);
  if (problems.length) throw new Error(`index is invalid:\n${problems.join("\n")}`);
  const envelope = signEnvelope(payload, privateKey, slot, trusted);
  return { envelope, payload };
}
