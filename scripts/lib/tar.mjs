// SPDX-License-Identifier: AGPL-3.0-only
// Minimal deterministic tar writer and a strict reader (ustar + pax).

const BLOCK = 512;

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function putString(buffer, offset, width, text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > width) throw new Error(`tar field overflow: ${text}`);
  bytes.copy(buffer, offset);
}

function header({ name, prefix = "", size, mode, type }) {
  const block = Buffer.alloc(BLOCK);
  putString(block, 0, 100, name);
  putString(block, 100, 8, octal(mode, 8));
  putString(block, 108, 8, octal(0, 8));
  putString(block, 116, 8, octal(0, 8));
  putString(block, 124, 12, octal(size, 12));
  putString(block, 136, 12, octal(0, 12));
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  putString(block, 257, 6, "ustar\0");
  putString(block, 263, 2, "00");
  putString(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  putString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padded(data) {
  const remainder = data.length % BLOCK;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - remainder)]);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length += 1;
  return `${length}${body}`;
}

function splitName(path) {
  if (!/^[\x20-\x7e]+$/.test(path)) return null;
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { prefix, name };
  }
  return null;
}

/** entries: [{path, data: Buffer, mode}] with unique relative paths; output is sorted and reproducible. */
export function writeTar(entries) {
  const parts = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const mode = entry.mode & 0o111 ? 0o755 : 0o644;
    const split = splitName(entry.path);
    if (split) {
      parts.push(header({ ...split, size: entry.data.length, mode, type: "0" }));
    } else {
      const pax = Buffer.from(paxRecord("path", entry.path), "utf8");
      parts.push(header({ name: "pax-header", size: pax.length, mode: 0o644, type: "x" }), padded(pax));
      const fallback = `pax/${parts.length}`;
      parts.push(header({ name: fallback, size: entry.data.length, mode, type: "0" }));
    }
    parts.push(padded(entry.data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function readString(block, offset, width) {
  const end = block.indexOf(0, offset);
  const stop = end === -1 || end > offset + width ? offset + width : end;
  return block.toString("utf8", offset, stop);
}

function parsePax(data) {
  const fields = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number.parseInt(data.toString("utf8", offset, space), 10);
    if (!Number.isInteger(length) || length <= 0) throw new Error("malformed pax header");
    const record = data.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

const TYPES = { 0: "file", "\0": "file", 5: "directory", 1: "hardlink", 2: "symlink", 3: "char", 4: "block", 6: "fifo" };

/** Returns [{path, type, mode, size, data}] where `type` is file|directory|other kinds. */
export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  let pending = {};
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (block.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index];
    if (sum !== Number.parseInt(readString(block, 148, 8).trim() || "-1", 8)) throw new Error("tar checksum mismatch");
    const size = Number.parseInt(readString(block, 124, 12).trim() || "0", 8);
    const flag = String.fromCharCode(block[156]);
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    if (flag === "x") {
      pending = { ...pending, ...parsePax(data) };
      continue;
    }
    if (flag === "g") throw new Error("global pax headers are not allowed");
    if (flag === "L") {
      pending.path = readString(data, 0, data.length);
      continue;
    }
    const prefix = readString(block, 345, 155);
    const name = readString(block, 0, 100);
    const path = pending.path ?? (prefix ? `${prefix}/${name}` : name);
    pending = {};
    const type = TYPES[flag] ?? `unsupported(${flag})`;
    entries.push({
      path: type === "directory" ? path.replace(/\/+$/, "") : path,
      type,
      mode: Number.parseInt(readString(block, 100, 8).trim() || "0", 8),
      size,
      data: Buffer.from(data),
    });
  }
  return entries;
}
