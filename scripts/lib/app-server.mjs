import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { CuarError } from "./errors.mjs";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_GRACE_MS = 1_000;
const MAX_JSONL_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

function spawnError(error) {
  if (error?.code === "ENOENT") {
    return new CuarError(
      "codex_not_found",
      "runtime_discovery",
      "CUAR could not start the local Codex executable.",
      { cause: error, exitCode: 3 },
    );
  }
  if (error?.code === "EACCES") {
    return new CuarError(
      "codex_not_executable",
      "runtime_discovery",
      "The configured Codex executable is not executable.",
      { cause: error, exitCode: 3 },
    );
  }
  return new CuarError(
    "app_server_spawn_failed",
    "app_server",
    "CUAR could not start Codex App Server.",
    { cause: error, exitCode: 4, retryable: true },
  );
}

export function resolveCodexBinary(env = process.env) {
  const override = env.CUAR_CODEX_BIN;
  if (!override) return "codex";
  if (!path.isAbsolute(override)) {
    throw new CuarError(
      "codex_not_executable",
      "runtime_discovery",
      "CUAR_CODEX_BIN must be an absolute executable path.",
      { exitCode: 3 },
    );
  }
  try {
    if (!fs.statSync(override).isFile()) throw new Error("not a file");
    fs.accessSync(override, fs.constants.X_OK);
  } catch (error) {
    throw new CuarError(
      "codex_not_executable",
      "runtime_discovery",
      "The configured Codex executable is not executable.",
      { cause: error, exitCode: 3 },
    );
  }
  return override;
}

function rpcError(message, stage) {
  const code = message?.error?.code;
  const raw = String(message?.error?.message ?? "").toLowerCase();
  if (code === -32601 || raw.includes("method not found")) {
    return new CuarError(
      "method_unavailable",
      stage,
      "This Codex installation does not provide the required usage-limit method.",
      { exitCode: 4 },
    );
  }
  if (
    raw.includes("not logged in") ||
    raw.includes("login required") ||
    raw.includes("unauthorized") ||
    raw.includes("not authenticated") ||
    code === 401
  ) {
    return new CuarError(
      "login_required",
      "authentication",
      "CUAR requires a ChatGPT-backed Codex sign-in.",
      { exitCode: 5 },
    );
  }
  if (raw.includes("auth mode") || raw.includes("authentication mode")) {
    return new CuarError(
      "auth_mode_unsupported",
      "authentication",
      "The active Codex authentication mode does not provide ChatGPT usage-limit data.",
      { exitCode: 5 },
    );
  }
  if (raw.includes("forbidden") || raw.includes("access denied") || code === 403) {
    return new CuarError(
      "access_denied",
      "authentication",
      "Codex denied access to the current account's usage-limit data.",
      { exitCode: 5 },
    );
  }
  return new CuarError(
    stage === "initialize" ? "initialize_rejected" : "app_server_request_rejected",
    stage,
    stage === "initialize"
      ? "Codex App Server rejected CUAR initialization."
      : "Codex App Server rejected the usage-limit request.",
    { exitCode: 4, retryable: true },
  );
}

function cancellationError() {
  return new CuarError(
    "operation_cancelled",
    "app_server",
    "The CUAR usage-limit read was cancelled.",
    { exitCode: 4, retryable: true },
  );
}

function streamError(streamName, error) {
  return new CuarError(
    "app_server_stream_failed",
    "app_server",
    `The Codex App Server ${streamName} stream failed.`,
    { cause: error, exitCode: 4, retryable: true },
  );
}

function waitForClose(child, isClosed, milliseconds) {
  if (isClosed()) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, milliseconds);
    child.once("close", onClose);
  });
}

async function cleanupChild(child, graceMs, isClosed) {
  try {
    if (!child.stdin.destroyed) child.stdin.end();
  } catch {
    // Continue with bounded termination.
  }
  if (await waitForClose(child, isClosed, graceMs)) return null;

  try {
    child.kill("SIGTERM");
  } catch {
    // Continue to the forced attempt.
  }
  if (await waitForClose(child, isClosed, graceMs)) return null;

  try {
    child.kill("SIGKILL");
  } catch {
    // Report the cleanup limitation below.
  }
  if (await waitForClose(child, isClosed, graceMs)) return null;
  return {
    code: "app_server_cleanup_incomplete",
    message: "CUAR could not confirm that its App Server process exited.",
  };
}

export async function readRateLimits(options = {}) {
  const {
    env = process.env,
    clock = () => Math.floor(Date.now() / 1000),
    initializeTimeoutMs = DEFAULT_INITIALIZE_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    cleanupGraceMs = DEFAULT_CLEANUP_GRACE_MS,
    spawnImpl = spawn,
    signal,
  } = options;

  if (signal?.aborted) throw cancellationError();

  const binary = resolveCodexBinary(env);
  let child;
  try {
    child = spawnImpl(binary, ["app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
  } catch (error) {
    throw spawnError(error);
  }

  const startedAt = Date.now();
  const pending = new Map();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let stderrTruncated = false;
  let completed = false;
  let fatalError = null;
  let childClosed = false;
  child.once("close", () => {
    childClosed = true;
  });

  const failAll = (error) => {
    if (fatalError) return;
    fatalError = error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const onAbort = () => failAll(cancellationError());
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const send = (message) => {
    if (fatalError) throw fatalError;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error && !completed) {
          failAll(streamError("input", error));
        }
      });
    } catch (error) {
      const normalized = new CuarError(
        "unexpected_exit",
        "app_server",
        "Codex App Server exited before completing the request.",
        { cause: error, exitCode: 4, retryable: true },
      );
      failAll(normalized);
      throw normalized;
    }
  };

  const handleMessage = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      failAll(
        new CuarError(
          "malformed_rpc",
          "app_server",
          "Codex App Server returned an invalid protocol message.",
          { exitCode: 4, retryable: true },
        ),
      );
      return;
    }

    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    if (hasMethod && typeof message.method !== "string") {
      failAll(
        new CuarError(
          "malformed_rpc",
          "app_server",
          "Codex App Server returned an invalid protocol envelope.",
          { exitCode: 4, retryable: true },
        ),
      );
      return;
    }

    if (hasId && hasMethod) {
      try {
        send({
          id: message.id,
          error: { code: -32601, message: "Method not supported by CUAR" },
        });
      } catch {
        // The stable error below is sufficient.
      }
      failAll(
        new CuarError(
          "unsupported_server_request",
          "app_server",
          "Codex App Server requested an unsupported client operation.",
          { exitCode: 4 },
        ),
      );
      return;
    }

    if (hasMethod) return;
    if (!hasId) {
      failAll(
        new CuarError(
          "malformed_rpc",
          "app_server",
          "Codex App Server returned an invalid protocol envelope.",
          { exitCode: 4, retryable: true },
        ),
      );
      return;
    }

    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (
      hasResult === hasError ||
      (hasError &&
        (!message.error ||
          typeof message.error !== "object" ||
          Array.isArray(message.error)))
    ) {
      failAll(
        new CuarError(
          "malformed_rpc",
          "app_server",
          "Codex App Server returned an invalid response envelope.",
          { exitCode: 4, retryable: true },
        ),
      );
      return;
    }

    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  };

  const handleLine = (line) => {
    if (line.length === 0) return;
    if (line.length > MAX_JSONL_BYTES) {
      failAll(
        new CuarError(
          "malformed_rpc",
          "app_server",
          "Codex App Server returned an oversized protocol message.",
          { exitCode: 4, retryable: true },
        ),
      );
      return;
    }
    try {
      handleMessage(JSON.parse(line.toString("utf8")));
    } catch (error) {
      failAll(
        new CuarError(
          "malformed_rpc",
          "app_server",
          "Codex App Server returned malformed JSON.",
          { cause: error, exitCode: 4, retryable: true },
        ),
      );
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
    let newline;
    while ((newline = stdoutBuffer.indexOf(0x0a)) !== -1) {
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      handleLine(line);
      if (fatalError) return;
    }
    if (stdoutBuffer.length > MAX_JSONL_BYTES) {
      failAll(
        new CuarError(
          "malformed_rpc",
          "app_server",
          "Codex App Server returned an oversized protocol message.",
          { exitCode: 4, retryable: true },
        ),
      );
    }
  });

  child.stderr.on("data", (chunk) => {
    if (stderrBuffer.length >= MAX_STDERR_BYTES) {
      stderrTruncated = true;
      return;
    }
    const remaining = MAX_STDERR_BYTES - stderrBuffer.length;
    const incoming = Buffer.from(chunk);
    stderrBuffer = Buffer.concat([stderrBuffer, incoming.subarray(0, remaining)]);
    if (incoming.length > remaining) stderrTruncated = true;
  });

  child.stdin.on("error", (error) => {
    if (!completed) failAll(streamError("input", error));
  });
  child.stdout.on("error", (error) => {
    if (!completed) failAll(streamError("output", error));
  });
  child.stderr.on("error", (error) => {
    if (!completed) failAll(streamError("diagnostic", error));
  });
  child.once("error", (error) => {
    if (!completed) failAll(spawnError(error));
  });
  child.once("exit", () => {
    if (!completed) {
      failAll(
        new CuarError(
          "unexpected_exit",
          "app_server",
          "Codex App Server exited before completing the request.",
          { exitCode: 4, retryable: true },
        ),
      );
    }
  });

  const waitForResponse = (id, timeoutMs, timeoutCode, timeoutMessage) => {
    if (fatalError) return Promise.reject(fatalError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new CuarError(timeoutCode, "app_server", timeoutMessage, {
            exitCode: 4,
            retryable: true,
          }),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  };

  const sendAndWait = async (messages, responsePromise) => {
    try {
      for (const message of messages) send(message);
    } catch (error) {
      await responsePromise.catch(() => {});
      throw error;
    }
    return responsePromise;
  };

  let cleanupWarning = null;
  try {
    const initialize = waitForResponse(
      1,
      initializeTimeoutMs,
      "initialize_timeout",
      "Codex App Server did not initialize in time.",
    );
    const initializeMessage = await sendAndWait(
      [
        {
          method: "initialize",
          id: 1,
          params: {
            clientInfo: {
              name: "cuar",
              title: "Codex Usage and Resets",
              version: "0.1.1",
            },
          },
        },
      ],
      initialize,
    );
    if (fatalError) throw fatalError;
    if (initializeMessage.error) throw rpcError(initializeMessage, "initialize");
    if (!Object.hasOwn(initializeMessage, "result")) {
      throw new CuarError(
        "malformed_rpc",
        "initialize",
        "Codex App Server returned an invalid initialization response.",
        { exitCode: 4, retryable: true },
      );
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(1, totalTimeoutMs - elapsedMs);
    const response = waitForResponse(
      2,
      remainingMs,
      "response_timeout",
      "Codex App Server did not return usage-limit data in time.",
    );
    const responseMessage = await sendAndWait(
      [
        { method: "initialized", params: {} },
        { method: "account/rateLimits/read", id: 2 },
      ],
      response,
    );
    if (fatalError) throw fatalError;
    if (responseMessage.error) throw rpcError(responseMessage, "rate_limits");
    if (!Object.hasOwn(responseMessage, "result")) {
      throw new CuarError(
        "malformed_rpc",
        "rate_limits",
        "Codex App Server returned an invalid usage-limit response.",
        { exitCode: 4, retryable: true },
      );
    }

    const fetchedAt = clock();
    if (!Number.isSafeInteger(fetchedAt)) {
      throw new CuarError(
        "internal_error",
        "time",
        "CUAR could not capture a valid fetch timestamp.",
        { exitCode: 7 },
      );
    }
    completed = true;
    cleanupWarning = await cleanupChild(
      child,
      cleanupGraceMs,
      () => childClosed,
    );
    return {
      result: responseMessage.result,
      fetchedAt,
      diagnostics: {
        stderrTruncated,
        cleanupWarning,
      },
    };
  } catch (error) {
    completed = true;
    failAll(error);
    cleanupWarning = await cleanupChild(
      child,
      cleanupGraceMs,
      () => childClosed,
    );
    if (cleanupWarning && error instanceof CuarError) {
      error.cleanupWarning = cleanupWarning;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function readCodexVersion(env = process.env) {
  const binary = resolveCodexBinary(env);
  const result = spawnSync(binary, ["--version"], {
    env,
    encoding: "utf8",
    shell: false,
    timeout: 3_000,
    maxBuffer: 4_096,
  });
  if (result.error) throw spawnError(result.error);
  if (result.status !== 0) {
    throw new CuarError(
      "codex_version_unavailable",
      "runtime_discovery",
      "CUAR could not read the local Codex version.",
      { exitCode: 3 },
    );
  }
  const firstLine = String(result.stdout ?? "").split(/\r?\n/, 1)[0].trim();
  return firstLine.replace(/[^\x20-\x7e]/g, "").slice(0, 128) || "unknown";
}
