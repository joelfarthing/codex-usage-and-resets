import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReport,
  normalizeBankedResets,
  normalizeUsage,
} from "../scripts/lib/normalize.mjs";

const FETCHED_AT = 1785213000;
const OPTIONS = { fetchedAt: FETCHED_AT, timeZone: "America/Chicago" };

function resultFixture() {
  const weekly = {
    usedPercent: 42,
    windowDurationMins: 10080,
    resetsAt: 1785591000,
  };
  const bucket = {
    limitId: "codex",
    primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1785220000 },
    secondary: weekly,
  };
  return {
    rateLimits: bucket,
    rateLimitsByLimitId: { codex: structuredClone(bucket) },
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [
        {
          id: "secret-credit-id",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1784505600,
          expiresAt: 1785454800,
          title: "must not leak",
          description: "must not leak",
        },
      ],
    },
  };
}

test("selects Codex before the weekly duration", () => {
  const fixture = resultFixture();
  fixture.rateLimitsByLimitId.codex_other = {
    limitId: "codex_other",
    primary: {
      usedPercent: 99,
      windowDurationMins: 10080,
      resetsAt: 1785591000,
    },
  };
  const usage = normalizeUsage(fixture, OPTIONS);
  assert.equal(usage.limit_id, "codex");
  assert.equal(usage.window.used_percent, 42);
});

test("uses the keyed Codex bucket when legacy is not Codex", () => {
  const fixture = resultFixture();
  fixture.rateLimits.limitId = "other";
  const usage = normalizeUsage(fixture, OPTIONS);
  assert.equal(usage.bucket_source, "rate_limits_by_limit_id");
});

test("rejects conflicting legacy and keyed Codex views", () => {
  const fixture = resultFixture();
  fixture.rateLimitsByLimitId.codex.secondary.usedPercent = 43;
  assert.throws(
    () => normalizeUsage(fixture, OPTIONS),
    (error) => error.code === "codex_bucket_conflict",
  );
});

test("rejects differing weekly slots in the same bucket", () => {
  const fixture = resultFixture();
  fixture.rateLimits.primary = {
    usedPercent: 41,
    windowDurationMins: 10080,
    resetsAt: 1785591000,
  };
  delete fixture.rateLimitsByLimitId;
  assert.throws(
    () => normalizeUsage(fixture, OPTIONS),
    (error) => error.code === "weekly_window_ambiguous",
  );
});

test("keeps authoritative reset count when details are capped", () => {
  const fixture = resultFixture();
  fixture.rateLimitResetCredits.availableCount = 2;
  const normalized = normalizeBankedResets(fixture, OPTIONS);
  assert.equal(normalized.value.available_count, 2);
  assert.equal(normalized.value.detail_state, "partial");
  assert.equal(normalized.value.unlisted_available_count, 1);
  assert.equal(normalized.limitations[0].code, "reset_credit_details_capped");
});

test("represents count-only and null-expiration states", () => {
  const countOnly = resultFixture();
  countOnly.rateLimitResetCredits.credits = null;
  const countResult = normalizeBankedResets(countOnly, OPTIONS);
  assert.equal(countResult.value.detail_state, "count_only");

  const noExpiration = resultFixture();
  noExpiration.rateLimitResetCredits.credits[0].expiresAt = null;
  const expirationResult = normalizeBankedResets(noExpiration, OPTIONS);
  assert.equal(
    expirationResult.value.credits[0].expiry_state,
    "no_expiration_reported",
  );
  assert.equal(expirationResult.value.credits[0].expires_at, null);
});

test("rejects a missing credits field instead of inventing count-only state", () => {
  const fixture = resultFixture();
  delete fixture.rateLimitResetCredits.credits;
  assert.throws(
    () => normalizeBankedResets(fixture, OPTIONS),
    (error) => error.code === "reset_inventory_invalid",
  );
});

test("deduplicates opaque IDs without emitting them", () => {
  const fixture = resultFixture();
  fixture.rateLimitResetCredits.credits.push(
    structuredClone(fixture.rateLimitResetCredits.credits[0]),
  );
  const normalized = normalizeBankedResets(fixture, OPTIONS);
  const serialized = JSON.stringify(normalized);
  assert.equal(normalized.value.credits.length, 1);
  assert.equal(serialized.includes("secret-credit-id"), false);
  assert.equal(serialized.includes("must not leak"), false);
});

test("ignores valid non-available reset rows", () => {
  const fixture = resultFixture();
  fixture.rateLimitResetCredits.credits.push({
    id: "consumed-credit-id",
    resetType: "codexRateLimits",
    status: "consumed",
    grantedAt: 1784505600,
    expiresAt: 1785454800,
  });
  const normalized = normalizeBankedResets(fixture, OPTIONS);
  assert.equal(normalized.value.detail_state, "complete");
  assert.equal(normalized.value.credits.length, 1);
  assert.deepEqual(normalized.limitations, []);
  assert.equal(JSON.stringify(normalized).includes("consumed-credit-id"), false);
});

test("uses deterministic opaque-ID ordering as a private tie-breaker", () => {
  const fixture = resultFixture();
  fixture.rateLimitResetCredits.availableCount = 2;
  fixture.rateLimitResetCredits.credits = [
    {
      id: "z",
      resetType: "unknown",
      status: "available",
      grantedAt: 1784505600,
      expiresAt: 1785454800,
    },
    {
      id: "ä",
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: 1784505600,
      expiresAt: 1785454800,
    },
  ];
  const normalized = normalizeBankedResets(fixture, OPTIONS);
  assert.deepEqual(
    normalized.value.credits.map((credit) => credit.reset_type),
    ["unknown", "codex_rate_limits"],
  );
});

test("builds a partial report when reset inventory is unavailable", () => {
  const fixture = resultFixture();
  fixture.rateLimitResetCredits = null;
  const report = buildReport(fixture, OPTIONS);
  assert.equal(report.status, "partial");
  assert.ok(report.usage);
  assert.equal(report.banked_resets, null);
  assert.equal(report.limitations[0].code, "reset_inventory_unavailable");
});
