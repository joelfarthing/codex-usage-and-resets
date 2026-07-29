#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

const configuredMode = process.env.CUAR_FAKE_MODE || "normal";
const modeFile = process.env.CUAR_FAKE_MODE_FILE;
const mode = modeFile
  ? fs.readFileSync(modeFile, "utf8").trim() || configuredMode
  : configuredMode;
const requestLog = process.env.CUAR_FAKE_REQUEST_LOG;
const pidFile = process.env.CUAR_FAKE_PID_FILE;
let keepAlive;

if (pidFile) fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
if (mode === "close_stdin") {
  keepAlive = setInterval(() => {}, 60_000);
}

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.145.0-fake\n");
  process.exit(0);
}

if (process.argv[2] !== "app-server" || process.argv[3] !== "--stdio") {
  process.stderr.write("unexpected fake Codex argv\n");
  process.exit(2);
}

const weekly = {
  usedPercent:
    mode === "one_percent_remaining"
      ? 99
      : ["unexpected_reset", "banked_reset", "scheduled_reset"].includes(mode)
        ? 0
        : 42,
  windowDurationMins: 10080,
  resetsAt:
    mode === "scheduled_reset"
      ? 1786195800
      : ["unexpected_reset", "banked_reset"].includes(mode)
        ? 1785821400
        : 1785591000,
};
const codexBucket = {
  limitId: "codex",
  limitName: null,
  primary: {
    usedPercent: 10,
    windowDurationMins: 300,
    resetsAt: 1785231000,
  },
  secondary: weekly,
  rateLimitReachedType: null,
};
const result = {
  rateLimits: codexBucket,
  rateLimitsByLimitId: {
    codex: structuredClone(codexBucket),
    codex_other: {
      limitId: "codex_other",
      limitName: "codex_other",
      primary: {
        usedPercent: 70,
        windowDurationMins: 10080,
        resetsAt: 1785591000,
      },
      secondary: null,
      rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: {
    availableCount: mode === "banked_reset" ? 1 : 2,
    credits: [
      {
        id: "opaque-fixture-id",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1784505600,
        expiresAt: 1785454800,
        title: "Fixture title must not leak",
        description: "Fixture description must not leak",
      },
    ],
  },
};

const send = (message) => {
  const line = `${JSON.stringify(message)}\n`;
  if (mode === "fragmented") {
    const midpoint = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, midpoint));
    setTimeout(() => process.stdout.write(line.slice(midpoint)), 2);
  } else {
    process.stdout.write(line);
  }
};

const logRequest = (line) => {
  if (requestLog) fs.appendFileSync(requestLog, `${line}\n`, "utf8");
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  logRequest(line);
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === "initialize") {
    if (mode === "hang_initialize") return;
    if (mode === "early_exit") process.exit(0);
    if (mode === "initialize_error") {
      send({ id: message.id, error: { code: -32000, message: "rejected" } });
      return;
    }
    if (mode === "notification") {
      send({ method: "account/rateLimits/updated", params: {} });
    }
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    if (mode === "close_stdin") {
      fs.closeSync(0);
    }
    return;
  }

  if (message.method === "account/rateLimits/read") {
    if (mode === "hang_read") return;
    if (mode === "wrong_id") {
      send({ id: 999, result });
      return;
    }
    if (mode === "oversized") {
      process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
      return;
    }
    if (mode === "malformed") {
      process.stdout.write("{not-json}\n");
      return;
    }
    if (mode === "invalid_envelope") {
      send({});
      return;
    }
    if (mode === "ambiguous_response") {
      send({
        id: message.id,
        result,
        error: { code: -32000, message: "ambiguous" },
      });
      return;
    }
    if (mode === "response_then_malformed") {
      process.stdout.write(
        `${JSON.stringify({ id: message.id, result })}\n{}\n`,
      );
      return;
    }
    if (mode === "method_missing") {
      send({
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    if (mode === "auth_error") {
      send({
        id: message.id,
        error: { code: 401, message: "Not logged in" },
      });
      return;
    }
    if (mode === "server_request") {
      send({ id: 99, method: "attestation/generate", params: {} });
      return;
    }
    if (mode === "stderr_flood") {
      process.stderr.write("x".repeat(40 * 1024), () => {
        send({ id: message.id, result });
      });
      return;
    }
    if (mode === "stderr_after_response") {
      send({ id: message.id, result });
      setTimeout(() => {
        process.stderr.write("x".repeat(40 * 1024), () => process.exit(0));
      }, 10);
      return;
    }
    send({ id: message.id, result });
  }
});

rl.on("close", () => {
  if (mode !== "close_stdin" && mode !== "stderr_after_response") {
    process.exit(0);
  }
});

process.on("exit", () => {
  if (keepAlive) clearInterval(keepAlive);
});
