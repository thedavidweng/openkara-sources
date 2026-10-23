// SPDX-License-Identifier: AGPL-3.0-only
// Streaming Source protocol 1.0 transport: LF-delimited JSON frames, handshake,
// correlated concurrent requests, cancellation and progress.
import { SourceError, errorFrame } from "./errors.mjs";

export const MAX_LINE_BYTES = 1048576;
export const MAX_CONCURRENT = 16;
const CONTROL_METHODS = new Set(["request.cancel", "auth.cancel", "auth.sign_out"]);

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isText(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Runs the protocol on `input` (an async iterable of Buffers) and writes frames
 * with `write(line)`, which returns a promise that settles when the chunk is
 * flushed. `handle(method, params, context)` implements the operations.
 * Resolves with `{ fatal }` when input ends and all work has settled.
 */
export async function serve({ manifest, input, write, handle, onFatal = () => {} }) {
  const seen = new Set();
  const active = new Map();
  let negotiated = false;
  let fatal = false;
  let output = Promise.resolve();

  function emit(frame) {
    output = output
      .then(() => write(`${JSON.stringify(frame)}\n`))
      .catch(() => {});
    return output;
  }

  function stopProtocol() {
    if (fatal) return;
    fatal = true;
    for (const request of active.values()) request.controller.abort();
    onFatal();
  }

  function handshake(params) {
    if (
      negotiated ||
      !Array.isArray(params.protocol_majors) ||
      !params.protocol_majors.every(Number.isInteger) ||
      !isText(params.host_version)
    )
      throw new SourceError("invalid_request");
    if (!params.protocol_majors.includes(1)) throw new SourceError("incompatible_plugin");
    negotiated = true;
    return {
      protocol: { major: 1, minor: 0 },
      package_id: manifest.package_id,
      source_id: manifest.source_id,
      package_version: manifest.version,
    };
  }

  function run(method, params, id, controller) {
    if (method === "handshake") return handshake(params);
    if (!negotiated) throw new SourceError("handshake_required");
    if (method === "request.cancel") {
      if (!isText(params.request_id)) throw new SourceError("invalid_request");
      const target = active.get(params.request_id);
      if (!target || CONTROL_METHODS.has(target.method) || target.method === "request.cancel")
        return { cancelled: false };
      target.controller.abort();
      return { cancelled: true };
    }
    return handle(method, params, {
      id,
      signal: controller.signal,
      progress(data) {
        if (controller.signal.aborted || !active.has(id) || fatal) return Promise.resolve();
        return emit({ event: "progress", request_id: id, data });
      },
      abortOthers(predicate) {
        for (const [otherId, other] of active)
          if (otherId !== id && predicate(other.method)) other.controller.abort();
      },
    });
  }

  function accept(line) {
    if (fatal) return;
    let frame;
    try {
      frame = JSON.parse(line);
      if (
        !isObject(frame) ||
        !isText(frame.id) ||
        frame.id.length > 128 ||
        seen.has(frame.id) ||
        !isText(frame.method) ||
        !isObject(frame.params)
      )
        throw new Error("invalid frame");
    } catch {
      stopProtocol();
      return;
    }
    seen.add(frame.id);
    if (active.size >= MAX_CONCURRENT && !CONTROL_METHODS.has(frame.method)) {
      void emit(errorFrame(frame.id, new SourceError("busy", "Source request limit reached")));
      return;
    }
    const controller = new AbortController();
    const request = { method: frame.method, controller };
    active.set(frame.id, request);
    request.promise = (async () => {
      try {
        const result = await run(frame.method, frame.params, frame.id, controller);
        if (controller.signal.aborted) throw new SourceError("cancelled");
        // Commit the terminal outcome before a racing cancellation can win.
        active.delete(frame.id);
        if (!fatal) await emit({ id: frame.id, result });
      } catch (error) {
        active.delete(frame.id);
        const outcome = controller.signal.aborted ? new SourceError("cancelled") : error;
        if (!fatal) await emit(errorFrame(frame.id, outcome));
      }
    })();
  }

  let buffered = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for await (const chunk of input) {
    buffered = Buffer.concat([buffered, chunk]);
    let newline;
    while ((newline = buffered.indexOf(10)) !== -1) {
      if (newline + 1 > MAX_LINE_BYTES) {
        stopProtocol();
        break;
      }
      let line = buffered.subarray(0, newline);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      buffered = buffered.subarray(newline + 1);
      try {
        accept(decoder.decode(line));
      } catch {
        stopProtocol();
      }
      if (fatal) break;
    }
    if (buffered.length >= MAX_LINE_BYTES) stopProtocol();
    if (fatal) break;
  }
  if (buffered.length && !fatal) stopProtocol();
  const remaining = [...active.values()];
  for (const request of remaining) request.controller.abort();
  await Promise.all(remaining.map((request) => request.promise));
  await output;
  return { fatal };
}
