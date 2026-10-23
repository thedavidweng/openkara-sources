// SPDX-License-Identifier: AGPL-3.0-only
// Trust anchors and Ed25519 signing for the source index envelope.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const TRUSTED_KEYS = Object.freeze({
  current: Object.freeze({ key_id: "0374d430d3cf1aa6", public_key: "SGkXN6xbau63VKXOSU8kGVJtMN0DhxFDmxlFvelqUXU=" }),
  next: Object.freeze({ key_id: "71a135edb0fedcf0", public_key: "VfvOxNOgYgIbKkzMDr8cLgqKIUbH2H9QcsSlc8qc28w=" }),
});
export const KEY_ENV = Object.freeze({
  current: "OPENKARA_SOURCE_SIGNING_CURRENT_PRIVATE_KEY",
  next: "OPENKARA_SOURCE_SIGNING_NEXT_PRIVATE_KEY",
});

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const keyIdFor = (rawPublic) => createHash("sha256").update(rawPublic).digest("hex").slice(0, 16);

export function publicKeyObject(base64) {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function parsePrivateKey(text) {
  const value = text.trim();
  if (value.includes("BEGIN")) return createPrivateKey(value);
  return createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
}

/** The raw 32-byte public key that belongs to a private key object. */
export function rawPublicOf(privateKey) {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
}

/** Verifies an envelope against the trust set; returns the decoded payload. */
export function verifyEnvelope(envelope, trusted = TRUSTED_KEYS) {
  const entry = Object.values(trusted).find((key) => key.key_id === envelope?.key_id);
  if (!entry) throw new Error(`index is signed by an untrusted key ${envelope?.key_id}`);
  const bytes = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  if (!verify(null, bytes, publicKeyObject(entry.public_key), signature))
    throw new Error("index signature does not verify");
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * Signs `payload` with `privateKey`, which must belong to `trusted[slot]`, and
 * self-verifies the envelope before returning it. Never logs key material.
 */
export function signEnvelope(payload, privateKey, slot, trusted = TRUSTED_KEYS) {
  const expected = trusted[slot];
  if (!expected) throw new Error(`unknown key slot ${slot}`);
  const raw = rawPublicOf(privateKey);
  if (raw.toString("base64") !== expected.public_key)
    throw new Error(`the ${slot} private key does not match the trusted public key`);
  if (keyIdFor(raw) !== expected.key_id) throw new Error("trusted key_id does not match its public key");
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const envelope = {
    key_id: expected.key_id,
    payload: bytes.toString("base64"),
    signature: sign(null, bytes, privateKey).toString("base64"),
  };
  verifyEnvelope(envelope, trusted);
  return envelope;
}

export function privateKeyFromEnv(slot, env = process.env) {
  const name = KEY_ENV[slot];
  if (!name) throw new Error(`unknown key slot ${slot}`);
  if (!env[name]) throw new Error(`${name} is not set`);
  try {
    return parsePrivateKey(env[name]);
  } catch {
    throw new Error(`${name} is not a valid PKCS8 Ed25519 private key`);
  }
}
