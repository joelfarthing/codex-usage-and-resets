import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateUsage,
  WEEKLY_WINDOW_SECONDS,
} from "../scripts/lib/calculate.mjs";

const FETCHED_AT = 1785213000;
const RESET_AT = 1785591000;

function usage(usedPercent, overrides = {}) {
  return calculateUsage(
    {
      usedPercent,
      windowDurationMins: 10080,
      resetsAt: RESET_AT,
      ...overrides,
    },
    {
      bucketSource: "rate_limits",
      fetchedAt: FETCHED_AT,
      timeZone: "America/Chicago",
    },
  );
}

test("calculates the frozen worked example", () => {
  const result = usage(42);
  assert.equal(result.window.elapsed_seconds, 226800);
  assert.equal(result.window.elapsed_percent, 37.5);
  assert.equal(result.window.remaining_percent, 58);
  assert.deepEqual(result.window.percentage_precision, {
    source_granularity_percentage_points: 1,
    remaining_percent_interpretation: "upper_bound",
    remaining_capacity_state: "reported_upper_bound",
  });
  assert.equal(result.pace.delta_percentage_points, 4.5);
  assert.equal(result.pace.relation, "approximately_linear");
  assert.equal(result.projection.end_percent, 112);
  assert.equal(result.projection.exhaustion_state, "before_reset");
  assert.equal(result.projection.exhaustion_at, "2026-07-31T19:30:00Z");
  assert.equal(
    result.projection.exhaustion_at_local,
    "2026-07-31T14:30:00-05:00",
  );
});

test("uses inclusive five-point neutral boundaries", () => {
  const thirtyFivePercentReset =
    FETCHED_AT + WEEKLY_WINDOW_SECONDS - WEEKLY_WINDOW_SECONDS * 0.35;
  assert.equal(
    usage(40, { resetsAt: thirtyFivePercentReset }).pace.relation,
    "approximately_linear",
  );
  assert.equal(
    usage(30, { resetsAt: thirtyFivePercentReset }).pace.relation,
    "approximately_linear",
  );
  assert.equal(
    usage(41, { resetsAt: thirtyFivePercentReset }).pace.relation,
    "above",
  );
  assert.equal(
    usage(29, { resetsAt: thirtyFivePercentReset }).pace.relation,
    "below",
  );
});

test("requires five percent elapsed for burn-rate projections", () => {
  const beforeThresholdReset =
    FETCHED_AT + WEEKLY_WINDOW_SECONDS - Math.floor(WEEKLY_WINDOW_SECONDS * 0.04999);
  const before = usage(10, { resetsAt: beforeThresholdReset });
  assert.equal(before.projection.end_state, "insufficient_elapsed");
  assert.equal(before.projection.exhaustion_state, "insufficient_elapsed");

  const thresholdReset =
    FETCHED_AT + WEEKLY_WINDOW_SECONDS - WEEKLY_WINDOW_SECONDS * 0.05;
  const atThreshold = usage(10, { resetsAt: thresholdReset });
  assert.equal(atThreshold.projection.end_state, "projected");
});

test("handles zero and exhausted usage explicitly", () => {
  const zero = usage(0);
  assert.equal(zero.projection.exhaustion_state, "zero_usage");
  assert.equal(zero.projection.exhaustion_at, null);
  assert.equal(
    zero.window.percentage_precision.remaining_capacity_state,
    "reported_upper_bound",
  );

  const exhausted = usage(100);
  assert.equal(exhausted.projection.exhaustion_state, "already_exhausted");
  assert.equal(exhausted.projection.exhaustion_at, "2026-07-28T04:30:00Z");
  assert.equal(
    exhausted.window.percentage_precision.remaining_capacity_state,
    "exhausted",
  );
});

test("marks a reported one percent as less than one percent actual usage", () => {
  const result = usage(99);
  assert.equal(result.window.remaining_percent, 1);
  assert.equal(
    result.window.percentage_precision.remaining_percent_interpretation,
    "upper_bound",
  );
  assert.equal(
    result.window.percentage_precision.remaining_capacity_state,
    "less_than_one_percent",
  );
  assert.equal(result.projection.exhaustion_state, "before_reset");
});

test("does not emit exhaustion at or after reset", () => {
  const fortyPercentReset =
    FETCHED_AT + WEEKLY_WINDOW_SECONDS - WEEKLY_WINDOW_SECONDS * 0.4;
  const result = usage(40, { resetsAt: fortyPercentReset });
  assert.equal(result.projection.end_percent, 100);
  assert.equal(result.projection.exhaustion_state, "not_before_reset");
  assert.equal(result.projection.exhaustion_at, null);
});

test("clamps only five seconds of boundary skew", () => {
  const startSkew = usage(1, {
    resetsAt: FETCHED_AT + WEEKLY_WINDOW_SECONDS + 5,
  });
  assert.equal(startSkew.window.elapsed_seconds, 0);
  assert.throws(
    () =>
      usage(1, {
        resetsAt: FETCHED_AT + WEEKLY_WINDOW_SECONDS + 6,
      }),
    (error) => error.code === "reset_timestamp_invalid",
  );
});

test("rejects invalid used percentages without clamping", () => {
  for (const value of [-1, 41.5, 99.5, 100.1, 101, Number.NaN]) {
    assert.throws(
      () => usage(value),
      (error) => error.code === "used_percent_invalid",
    );
  }
});

test("distinguishes a missing used percentage from an invalid value", () => {
  assert.throws(
    () => usage(undefined),
    (error) => error.code === "response_shape_invalid",
  );
});
