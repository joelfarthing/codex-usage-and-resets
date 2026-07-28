import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readRateLimits } from "../scripts/lib/app-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CODEX = path.join(ROOT, "test-support", "fake-codex.mjs");

function testEnvironment(directory, mode = "normal") {
  return {
    ...process.env,
    CUAR_CODEX_BIN: FAKE_CODEX,
    CUAR_FAKE_MODE: mode,
    CUAR_FAKE_REQUEST_LOG: path.join(directory, "requests.jsonl"),
    CUAR_FAKE_PID_FILE: path.join(directory, "pid"),
  };
}

async function acquire(directory, mode = "normal", extra = {}) {
  return readRateLimits({
    env: testEnvironment(directory, mode),
    clock: () => 1785213000,
    initializeTimeoutMs: 500,
    totalTimeoutMs: 1_000,
    cleanupGraceMs: 25,
    ...extra,
  });
}

test("uses the exact read-only App Server request sequence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar-rpc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const response = await acquire(directory);
  assert.equal(response.result.rateLimits.limitId, "codex");
  assert.equal(response.fetchedAt, 1785213000);

  const requests = fs
    .readFileSync(path.join(directory, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "initialized", "account/rateLimits/read"],
  );
  assert.equal(Object.hasOwn(requests[0].params, "capabilities"), false);
  assert.equal(
    requests.some((request) =>
      /^(thread|turn|command|process)\//.test(request.method ?? ""),
    ),
    false,
  );
  assert.equal(
    requests.some(
      (request) =>
        request.method === "account/rateLimitResetCredit/consume",
    ),
    false,
  );

  const modeFile = path.join(directory, "dynamic-mode.txt");
  fs.writeFileSync(modeFile, "method_missing\n", "utf8");
  await assert.rejects(
    readRateLimits({
      env: {
        ...testEnvironment(directory, "normal"),
        CUAR_FAKE_MODE_FILE: modeFile,
        CUAR_FAKE_REQUEST_LOG: path.join(directory, "dynamic-requests.jsonl"),
      },
      clock: () => 1785177000,
      initializeTimeoutMs: 500,
      totalTimeoutMs: 1_000,
      cleanupGraceMs: 25,
    }),
    (error) => error.code === "method_unavailable",
  );
});

for (const mode of ["notification", "fragmented", "stderr_flood"]) {
  test(`handles ${mode} protocol behavior`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar-rpc-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const response = await acquire(directory, mode);
    assert.equal(response.result.rateLimits.limitId, "codex");
    if (mode === "stderr_flood") {
      assert.equal(response.diagnostics.stderrTruncated, true);
    }
  });
}

test("waits for diagnostic stream closure after the response", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar-rpc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const response = await acquire(directory, "stderr_after_response");
  assert.equal(response.result.rateLimits.limitId, "codex");
  assert.equal(response.diagnostics.stderrTruncated, true);
});

const failureModes = [
  ["malformed", "malformed_rpc"],
  ["invalid_envelope", "malformed_rpc"],
  ["ambiguous_response", "malformed_rpc"],
  ["response_then_malformed", "malformed_rpc"],
  ["initialize_error", "initialize_rejected"],
  ["method_missing", "method_unavailable"],
  ["auth_error", "login_required"],
  ["server_request", "unsupported_server_request"],
  ["oversized", "malformed_rpc"],
  ["early_exit", "unexpected_exit"],
  ["hang_initialize", "initialize_timeout"],
  ["wrong_id", "response_timeout"],
  ["hang_read", "response_timeout"],
  ["close_stdin", "app_server_stream_failed"],
];

for (const [mode, code] of failureModes) {
  test(`maps ${mode} to ${code}`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar-rpc-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await assert.rejects(
      acquire(directory, mode),
      (error) => error.code === code,
    );
  });
}

test("leaves no fake App Server process after a timeout", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar-rpc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(acquire(directory, "hang_read"));
  const pid = Number(
    fs.readFileSync(path.join(directory, "pid"), "utf8").trim(),
  );
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
  );
});

test("cancellation rejects stably and leaves no child process", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar-rpc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));

  await assert.rejects(
    acquire(directory, "hang_read", { signal: controller.signal }),
    (error) => error.code === "operation_cancelled",
  );
  const pid = Number(
    fs.readFileSync(path.join(directory, "pid"), "utf8").trim(),
  );
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
  );
});

test("replies method-not-found to an unexpected server request", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar-rpc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(acquire(directory, "server_request"));
  const messages = fs
    .readFileSync(path.join(directory, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    messages.some(
      (message) => message.id === 99 && message.error?.code === -32601,
    ),
  );
});
