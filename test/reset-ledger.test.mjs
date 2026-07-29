import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReport } from "../scripts/lib/normalize.mjs";
import {
  RESET_LEDGER_BOUNDARY_SECONDS,
  RESET_LEDGER_MAX_AGE_SECONDS,
  detectUnexpectedReset,
  observeResetLedger,
  resolveResetLedgerPath,
} from "../scripts/lib/reset-ledger.mjs";

const BASELINE_FETCHED_AT = 1_785_213_000;
const BASELINE_RESET_AT = 1_785_591_000;

function reportFixture({
  fetchedAt,
  usedPercent,
  resetsAt,
  bankedResetCount = 2,
}) {
  const credits = Array.from({ length: bankedResetCount }, (_, index) => ({
    id: `opaque-${index}`,
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: fetchedAt - 86_400,
    expiresAt: fetchedAt + 172_800 + index,
  }));
  return buildReport(
    {
      rateLimits: {
        limitId: "codex",
        primary: null,
        secondary: {
          usedPercent,
          windowDurationMins: 10_080,
          resetsAt,
        },
      },
      rateLimitResetCredits: {
        availableCount: bankedResetCount,
        credits,
      },
    },
    { fetchedAt, timeZone: "America/Chicago" },
  );
}

function snapshot({
  fetchedAt = BASELINE_FETCHED_AT,
  resetsAt = BASELINE_RESET_AT,
  usedPercent = 42,
  bankedResetCount = 2,
} = {}) {
  return {
    fetched_at: fetchedAt,
    scheduled_reset_at: resetsAt,
    used_percent: usedPercent,
    banked_reset_available_count: bankedResetCount,
  };
}

test("detects only a meaningful early return to zero used", () => {
  const previous = snapshot();
  const current = snapshot({
    fetchedAt: BASELINE_FETCHED_AT + 3_600,
    resetsAt: BASELINE_FETCHED_AT + 3_600 + 604_800,
    usedPercent: 0,
  });
  const detected = detectUnexpectedReset(previous, current);
  assert.equal(detected.classification, "likely_unscheduled");
  assert.equal(detected.previous_observed_at, BASELINE_FETCHED_AT);

  assert.equal(
    detectUnexpectedReset(
      previous,
      snapshot({
        fetchedAt:
          BASELINE_RESET_AT - RESET_LEDGER_BOUNDARY_SECONDS,
        resetsAt: BASELINE_RESET_AT + 604_800,
        usedPercent: 0,
      }),
    ),
    null,
  );
  assert.equal(
    detectUnexpectedReset(
      snapshot({ usedPercent: 9 }),
      current,
    ),
    null,
  );
  assert.equal(
    detectUnexpectedReset(
      previous,
      snapshot({
        fetchedAt: BASELINE_FETCHED_AT + 3_600,
        resetsAt: BASELINE_FETCHED_AT + 3_600 + 604_800,
        usedPercent: 1,
      }),
    ),
    null,
  );
});

test("classifies a falling banked-reset count conservatively", () => {
  const detected = detectUnexpectedReset(
    snapshot({ bankedResetCount: 2 }),
    snapshot({
      fetchedAt: BASELINE_FETCHED_AT + 3_600,
      resetsAt: BASELINE_FETCHED_AT + 3_600 + 604_800,
      usedPercent: 0,
      bankedResetCount: 1,
    }),
  );
  assert.equal(detected.classification, "banked_reset_possible");
});

test("persists one snapshot and one self-pruning event", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar ledger "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "state", "reset-ledger.json");
  const env = { CUAR_TEST_MODE: "1", CUAR_LEDGER_PATH: ledgerPath };

  const baseline = reportFixture({
    fetchedAt: BASELINE_FETCHED_AT,
    usedPercent: 42,
    resetsAt: BASELINE_RESET_AT,
  });
  const first = observeResetLedger(baseline, { env });
  assert.equal(first.state, "no_prior_observation");
  assert.equal(first.latest_event, null);

  const resetFetchedAt = BASELINE_FETCHED_AT + 3_600;
  const reset = reportFixture({
    fetchedAt: resetFetchedAt,
    usedPercent: 0,
    resetsAt: resetFetchedAt + 604_800,
  });
  const second = observeResetLedger(reset, { env });
  assert.equal(second.state, "unexpected_usage_reset_observed");
  assert.equal(second.detected_now, true);
  assert.equal(second.latest_event.classification, "likely_unscheduled");
  assert.equal(
    second.latest_event.minutes_before_prior_scheduled_reset,
    Math.floor((BASELINE_RESET_AT - resetFetchedAt) / 60),
  );

  const repeated = reportFixture({
    fetchedAt: resetFetchedAt + 3_600,
    usedPercent: 0,
    resetsAt: resetFetchedAt + 604_800,
  });
  const third = observeResetLedger(repeated, { env });
  assert.equal(third.state, "no_evidence");
  assert.equal(third.detected_now, false);
  assert.deepEqual(third.latest_event, second.latest_event);

  const stored = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(Object.keys(stored), ["version", "snapshot", "last_event"]);
  assert.equal(stored.snapshot.used_percent, 0);
  assert.equal(stored.snapshot.banked_reset_available_count, 2);
  assert.equal(JSON.stringify(stored).includes("opaque-"), false);
  assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600);

  const afterRetention =
    resetFetchedAt + 3_600 + RESET_LEDGER_MAX_AGE_SECONDS + 1;
  const pruned = observeResetLedger(
    reportFixture({
      fetchedAt: afterRetention,
      usedPercent: 12,
      resetsAt: afterRetention + 604_800,
    }),
    { env },
  );
  assert.equal(pruned.state, "no_prior_observation");
  assert.equal(pruned.latest_event, null);
});

test("prunes an interrupted temporary write before the next transaction", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar ledger temp "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "reset-ledger.json");
  const temporaryPath = path.join(directory, ".reset-ledger.json.tmp");
  const env = { CUAR_TEST_MODE: "1", CUAR_LEDGER_PATH: ledgerPath };

  fs.writeFileSync(temporaryPath, '{"interrupted":true}\n', { mode: 0o600 });
  const observation = observeResetLedger(
    reportFixture({
      fetchedAt: BASELINE_FETCHED_AT,
      usedPercent: 42,
      resetsAt: BASELINE_RESET_AT,
    }),
    { env },
  );

  assert.equal(observation.state, "no_prior_observation");
  assert.equal(fs.existsSync(temporaryPath), false);
  assert.equal(fs.existsSync(ledgerPath), true);
});

test("test mode is non-persistent without an explicit absolute override", () => {
  const report = reportFixture({
    fetchedAt: BASELINE_FETCHED_AT,
    usedPercent: 42,
    resetsAt: BASELINE_RESET_AT,
  });
  const observation = observeResetLedger(report, {
    env: { CUAR_TEST_MODE: "1" },
  });
  assert.deepEqual(observation, {
    ledger_status: "disabled_test_mode",
    state: "unavailable",
    detected_now: false,
    latest_event: null,
  });
});

test("skips reports that cannot form a trustworthy comparison", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar ledger skip "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "reset-ledger.json");
  const report = reportFixture({
    fetchedAt: BASELINE_FETCHED_AT,
    usedPercent: 42,
    resetsAt: BASELINE_RESET_AT,
  });
  report.limitations.push({
    code: "available_credit_expired",
    message: "An available credit has an elapsed expiration.",
  });
  assert.equal(
    observeResetLedger(report, {
      env: { CUAR_TEST_MODE: "1", CUAR_LEDGER_PATH: ledgerPath },
    }),
    null,
  );
  assert.equal(fs.existsSync(ledgerPath), false);

  const incomplete = reportFixture({
    fetchedAt: BASELINE_FETCHED_AT,
    usedPercent: 42,
    resetsAt: BASELINE_RESET_AT,
  });
  incomplete.banked_resets = null;
  assert.equal(
    observeResetLedger(incomplete, {
      env: { CUAR_TEST_MODE: "1", CUAR_LEDGER_PATH: ledgerPath },
    }),
    null,
  );
  assert.equal(fs.existsSync(ledgerPath), false);
});

test("breaks the comparison chain across an untrustworthy report", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar ledger gap "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "reset-ledger.json");
  const env = { CUAR_TEST_MODE: "1", CUAR_LEDGER_PATH: ledgerPath };

  observeResetLedger(
    reportFixture({
      fetchedAt: BASELINE_FETCHED_AT,
      usedPercent: 42,
      resetsAt: BASELINE_RESET_AT,
    }),
    { env },
  );

  const incomplete = reportFixture({
    fetchedAt: BASELINE_FETCHED_AT + 1_800,
    usedPercent: 30,
    resetsAt: BASELINE_RESET_AT,
  });
  incomplete.banked_resets = null;
  assert.equal(observeResetLedger(incomplete, { env }), null);

  const cleared = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(cleared.snapshot, null);
  assert.equal(cleared.last_event, null);

  const afterGap = observeResetLedger(
    reportFixture({
      fetchedAt: BASELINE_FETCHED_AT + 3_600,
      usedPercent: 0,
      resetsAt: BASELINE_FETCHED_AT + 3_600 + 604_800,
    }),
    { env },
  );
  assert.equal(afterGap.state, "no_prior_observation");
  assert.equal(afterGap.detected_now, false);
  assert.equal(afterGap.latest_event, null);
});

test("rebaselines malformed temporal ledger state without emitting it", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cuar ledger temporal "),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "reset-ledger.json");
  const env = { CUAR_TEST_MODE: "1", CUAR_LEDGER_PATH: ledgerPath };
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify({
      version: 1,
      snapshot: {
        fetched_at: BASELINE_FETCHED_AT,
        scheduled_reset_at: BASELINE_FETCHED_AT + 604_900,
        used_percent: 42,
        banked_reset_available_count: 2,
      },
      last_event: {
        observed_at: BASELINE_FETCHED_AT,
        previous_observed_at: BASELINE_FETCHED_AT + 1,
        prior_scheduled_reset_at: BASELINE_FETCHED_AT - 1,
        classification: "likely_unscheduled",
      },
    })}\n`,
    { mode: 0o600 },
  );

  const observation = observeResetLedger(
    reportFixture({
      fetchedAt: BASELINE_FETCHED_AT + 3_600,
      usedPercent: 0,
      resetsAt: BASELINE_FETCHED_AT + 3_600 + 604_800,
    }),
    { env },
  );
  assert.equal(observation.state, "no_prior_observation");
  assert.equal(observation.detected_now, false);
  assert.equal(observation.latest_event, null);
});

test("rejects an active lock or symlinked ledger without exposing a path", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuar ledger guard "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "reset-ledger.json");
  const env = { CUAR_TEST_MODE: "1", CUAR_LEDGER_PATH: ledgerPath };
  const report = reportFixture({
    fetchedAt: BASELINE_FETCHED_AT,
    usedPercent: 42,
    resetsAt: BASELINE_RESET_AT,
  });

  fs.mkdirSync(`${ledgerPath}.lock`);
  assert.deepEqual(observeResetLedger(report, { env }), {
    ledger_status: "unavailable",
    state: "unavailable",
    detected_now: false,
    latest_event: null,
  });
  fs.rmdirSync(`${ledgerPath}.lock`);

  const target = path.join(directory, "target.json");
  fs.writeFileSync(target, "preserve me\n");
  fs.symlinkSync(target, ledgerPath);
  assert.deepEqual(observeResetLedger(report, { env }), {
    ledger_status: "unavailable",
    state: "unavailable",
    detected_now: false,
    latest_event: null,
  });
  assert.equal(fs.readFileSync(target, "utf8"), "preserve me\n");
});

test("uses native cache locations and requires an absolute override", () => {
  assert.equal(
    resolveResetLedgerPath({
      env: {},
      platform: "darwin",
      homeDirectory: "/Users/example",
    }),
    "/Users/example/Library/Caches/CUAR/reset-ledger.json",
  );
  assert.equal(
    resolveResetLedgerPath({
      env: { XDG_CACHE_HOME: "/var/tmp/cache" },
      platform: "linux",
      homeDirectory: "/home/example",
    }),
    "/var/tmp/cache/cuar/reset-ledger.json",
  );
  assert.equal(
    resolveResetLedgerPath({
      env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
      platform: "win32",
      homeDirectory: "C:\\Users\\example",
    }),
    path.win32.join(
      "C:\\Users\\example\\AppData\\Local",
      "CUAR",
      "Cache",
      "reset-ledger.json",
    ),
  );
  assert.throws(() =>
    resolveResetLedgerPath({
      env: { CUAR_LEDGER_PATH: "relative.json" },
      platform: "linux",
      homeDirectory: "/home/example",
    }),
  );
});
