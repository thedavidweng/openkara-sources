// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = join(here, "..", "..", "packages", "netease");
export const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_DIR, "manifest.json"), "utf8"));
const MOCK = join(here, "mock-upstream.cjs");

export const GOOD = { MUSIC_U: "good-music-u", __csrf: "good-csrf" };

/** Spawns the real worker over stdio with the upstream API mocked. */
export class Worker {
  constructor({ mocked = true } = {}) {
    this.directory = mkdtempSync(join(tmpdir(), "netease-test-"));
    this.logPath = join(this.directory, "calls.jsonl");
    const args = [...(mocked ? ["--require", MOCK] : []), join(PACKAGE_DIR, "src", "worker.mjs")];
    this.child = spawn(process.execPath, args, {
      cwd: PACKAGE_DIR,
      env: { PATH: process.env.PATH, TMPDIR: this.directory, MOCK_LOG: this.logPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = [];
    this.stdout = "";
    this.stderr = "";
    this.waiters = [];
    this.counter = 0;
    this.exit = new Promise((resolve) => this.child.once("close", (code, signal) => resolve({ code, signal })));
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text) => (this.stderr += text));
    this.child.stdout.on("data", (text) => {
      this.stdout += text;
      let newline;
      while ((newline = this.stdout.indexOf("\n")) !== -1) {
        const line = this.stdout.slice(0, newline);
        this.stdout = this.stdout.slice(newline + 1);
        this.lines.push(line);
        this.#settle(JSON.parse(line));
      }
    });
    this.frames = [];
  }

  #settle(frame) {
    this.frames.push(frame);
    for (const waiter of [...this.waiters]) waiter(frame);
  }

  /** Resolves with the first frame (already received or future) matching `predicate`. */
  waitFor(predicate, timeoutMs = 10000) {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("timed out waiting for a frame"));
      }, timeoutMs);
      const waiter = (frame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        resolve(frame);
      };
      this.waiters.push(waiter);
    });
  }

  write(line) {
    this.child.stdin.write(line);
  }

  /** Sends a request and returns its id without waiting. */
  start(method, params = {}, id = `t${++this.counter}`) {
    this.write(`${JSON.stringify({ id, method, params })}\n`);
    return id;
  }

  response(id, timeoutMs) {
    return this.waitFor((frame) => frame.id === id, timeoutMs);
  }

  async request(method, params = {}) {
    return this.response(this.start(method, params));
  }

  /** Request that must succeed; returns its result. */
  async call(method, params = {}) {
    const frame = await this.request(method, params);
    if (frame.error) throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`);
    return frame.result;
  }

  async handshake() {
    return this.call("handshake", { protocol_majors: [1], host_version: "0.17.0" });
  }

  async signIn() {
    await this.handshake();
    return this.call("session.restore", { credentials: GOOD });
  }

  calls() {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  async close() {
    this.child.stdin.end();
    const outcome = await Promise.race([
      this.exit,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (outcome === null) {
      this.child.kill("SIGKILL");
      await this.exit;
    }
    rmSync(this.directory, { recursive: true, force: true });
    return outcome;
  }
}

export async function withWorker(options, body) {
  const worker = new Worker(typeof options === "function" ? {} : options);
  try {
    return await (typeof options === "function" ? options : body)(worker);
  } finally {
    await worker.close();
  }
}
