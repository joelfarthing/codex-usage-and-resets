import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cuar.mjs");
const FAKE_CODEX = path.join(ROOT, "test-support", "fake-codex.mjs");

function run(args, overrides = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: overrides.cwd ?? ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CUAR_TEST_MODE: "1",
      CUAR_TEST_FETCHED_AT: "1785213000",
      CUAR_CODEX_BIN: FAKE_CODEX,
      CUAR_FAKE_MODE: "normal",
      CUAR_FAKE_REQUEST_LOG: "",
      ...overrides.env,
    },
    timeout: 5_000,
  });
}

test("emits a deterministic compact report", () => {
  const first = run(["report", "--json", "--timezone", "America/Chicago"]);
  const second = run(["report", "--json", "--timezone", "America/Chicago"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.endsWith("\n"), true);
  assert.equal(first.stdout.trim().includes("\n"), false);

  const report = JSON.parse(first.stdout);
  assert.equal(report.schema_version, 1);
  assert.equal(report.status, "partial");
  assert.equal(report.fetched_at, "2026-07-28T04:30:00Z");
  assert.equal(report.usage.pace.relation, "approximately_linear");
  assert.equal(report.banked_resets.available_count, 2);
  assert.equal(report.banked_resets.credits[0].expires_at_local, "2026-07-30T18:40:00-05:00");
  assert.equal(first.stdout.includes("opaque-fixture-id"), false);
  assert.equal(first.stdout.includes("Fixture title"), false);
});

test("generic NODE_ENV does not activate the CUAR fixture clock", () => {
  const result = run(
    ["report", "--json", "--timezone", "America/Chicago"],
    {
      env: {
        NODE_ENV: "test",
        CUAR_TEST_MODE: "0",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(
    JSON.parse(result.stdout).fetched_at,
    "2026-07-28T04:30:00Z",
  );
});

test("works from a different current directory", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar cwd "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = run(
    ["report", "--json", "--timezone", "America/Chicago"],
    { cwd: directory },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("supports focused pace and credit reports", () => {
  const pace = JSON.parse(
    run(["pace", "--json", "--timezone", "UTC"]).stdout,
  );
  assert.ok(pace.usage);
  assert.equal(pace.banked_resets, null);

  const credits = JSON.parse(
    run(["credits", "--json", "--timezone", "UTC"]).stdout,
  );
  assert.equal(credits.usage, null);
  assert.ok(credits.banked_resets);
});

test("renders text from the same normalized facts", () => {
  const result = run(["report", "--text", "--timezone", "America/Chicago"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /42% used, 58% remaining/);
  assert.match(result.stdout, /whole percentage points/);
  assert.match(result.stdout, /upper bound, not an exact measurement/);
  assert.match(result.stdout, /approximately_linear, 4.5 percentage points/);
  assert.match(result.stdout, /2026-07-30T18:40:00-05:00/);
});

test("warns that reported one percent means imminent exhaustion", () => {
  const result = run(["report", "--text", "--timezone", "America/Chicago"], {
    env: { CUAR_FAKE_MODE: "one_percent_remaining" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /99% used, 1% remaining/);
  assert.match(result.stdout, /actual remaining capacity is below 1%/);
  assert.match(result.stdout, /exhaustion is imminent/);
  assert.match(result.stdout, /may occur sooner than projected/);
});

test("provides bounded help, version, and invalid-argument behavior", () => {
  assert.match(run(["--help"]).stdout, /cuar report/);
  assert.equal(
    run(["--version"]).stdout,
    "CUAR 0.1.0\n",
  );

  const invalid = run(["nope", "--json"]);
  assert.equal(invalid.status, 2);
  const payload = JSON.parse(invalid.stdout);
  assert.equal(payload.error.code, "invalid_arguments");
  assert.equal(payload.fetched_at, null);
});

test("rejects an invalid timezone without starting App Server", () => {
  const unsafeInput = "secret@example.com";
  const result = run(["report", "--json", "--timezone", unsafeInput]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "invalid_timezone");
  assert.equal(result.stdout.includes(unsafeInput), false);

  const empty = run(["report", "--json", "--timezone", ""]);
  assert.equal(empty.status, 2);
  assert.equal(JSON.parse(empty.stdout).error.code, "invalid_timezone");
});

test("doctor reports capabilities without account values", () => {
  const result = run(["doctor", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.app_server.rate_limits_read, true);
  assert.equal(doctor.app_server.codex_weekly_window, true);
  assert.equal(doctor.app_server.reset_credit_summary, true);
  assert.equal(result.stdout.includes("used_percent"), false);
  assert.equal(result.stdout.includes("opaque-fixture-id"), false);
  assert.equal(result.stdout.includes("expires_at"), false);
});
