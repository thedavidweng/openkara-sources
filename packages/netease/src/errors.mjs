// SPDX-License-Identifier: AGPL-3.0-only

const RETRYABLE = new Set(["network", "rate_limited", "busy", "source_unavailable"]);

/** A protocol error with a stable code and a message safe to show users. */
export class SourceError extends Error {
  constructor(code, message = code.replaceAll("_", " "), options = {}) {
    super(message);
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function errorFrame(id, error) {
  const known = error instanceof SourceError;
  const code = known ? error.code : "internal";
  const body = {
    code,
    message: known ? error.message : "Source request failed",
    retryable: known ? error.retryable : false,
  };
  if (known && body.retryable && Number.isInteger(error.retryAfterMs) && error.retryAfterMs > 0)
    body.retry_after_ms = error.retryAfterMs;
  return { id, error: body };
}
