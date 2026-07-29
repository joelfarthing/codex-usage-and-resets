import { calculateUsage, WEEKLY_WINDOW_MINUTES } from "./calculate.mjs";
import { CuarError, limitationFromError } from "./errors.mjs";
import { isoInTimeZone, isoUtc } from "./time.mjs";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function weeklyCandidates(bucket) {
  if (!isObject(bucket)) return [];
  return ["primary", "secondary"]
    .map((slot) => bucket[slot])
    .filter(
      (window) =>
        isObject(window) &&
        window.windowDurationMins === WEEKLY_WINDOW_MINUTES,
    );
}

function weeklySemantic(window) {
  if (!isObject(window)) return null;
  return {
    usedPercent: window.usedPercent ?? null,
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  };
}

function sameWeeklySemantic(left, right) {
  return JSON.stringify(weeklySemantic(left)) === JSON.stringify(weeklySemantic(right));
}

function selectWeeklyWindow(bucket) {
  const candidates = weeklyCandidates(bucket);
  if (candidates.length === 0) {
    throw new CuarError(
      "weekly_window_missing",
      "normalization",
      "Codex did not return a 10,080-minute weekly window.",
      { exitCode: 6 },
    );
  }
  if (
    candidates.length > 1 &&
    !sameWeeklySemantic(candidates[0], candidates[1])
  ) {
    throw new CuarError(
      "weekly_window_ambiguous",
      "normalization",
      "Codex returned conflicting weekly windows.",
      { exitCode: 6 },
    );
  }
  return candidates[0];
}

function selectCodexBucket(result) {
  const legacy =
    isObject(result.rateLimits) && result.rateLimits.limitId === "codex"
      ? result.rateLimits
      : null;
  const keyed =
    isObject(result.rateLimitsByLimitId) &&
    isObject(result.rateLimitsByLimitId.codex)
      ? result.rateLimitsByLimitId.codex
      : null;

  if (!legacy && !keyed) {
    throw new CuarError(
      "codex_bucket_missing",
      "normalization",
      "Codex did not return the general Codex usage-limit bucket.",
      { exitCode: 6 },
    );
  }

  if (legacy && keyed) {
    let legacyWeekly;
    let keyedWeekly;
    try {
      legacyWeekly = selectWeeklyWindow(legacy);
      keyedWeekly = selectWeeklyWindow(keyed);
    } catch (error) {
      throw new CuarError(
        "codex_bucket_conflict",
        "normalization",
        "Codex returned inconsistent general usage-limit bucket views.",
        { cause: error, exitCode: 6 },
      );
    }
    if (!sameWeeklySemantic(legacyWeekly, keyedWeekly)) {
      throw new CuarError(
        "codex_bucket_conflict",
        "normalization",
        "Codex returned conflicting general usage-limit bucket views.",
        { exitCode: 6 },
      );
    }
  }

  return legacy
    ? { bucket: legacy, bucketSource: "rate_limits" }
    : { bucket: keyed, bucketSource: "rate_limits_by_limit_id" };
}

export function normalizeUsage(result, { fetchedAt, timeZone }) {
  if (!isObject(result)) {
    throw new CuarError(
      "response_shape_invalid",
      "normalization",
      "Codex returned an invalid usage-limit response.",
      { exitCode: 6 },
    );
  }
  const { bucket, bucketSource } = selectCodexBucket(result);
  return calculateUsage(selectWeeklyWindow(bucket), {
    bucketSource,
    fetchedAt,
    timeZone,
  });
}

function normalizedResetType(value) {
  return value === "codexRateLimits" ? "codex_rate_limits" : "unknown";
}

function compareCredits(left, right) {
  const leftExpiry = left._expiresAt ?? Number.POSITIVE_INFINITY;
  const rightExpiry = right._expiresAt ?? Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  if (left._grantedAt !== right._grantedAt) {
    return left._grantedAt - right._grantedAt;
  }
  if (left._id < right._id) return -1;
  if (left._id > right._id) return 1;
  return 0;
}

export function normalizeBankedResets(result, { fetchedAt, timeZone }) {
  if (!isObject(result)) {
    throw new CuarError(
      "response_shape_invalid",
      "normalization",
      "Codex returned an invalid usage-limit response.",
      { exitCode: 6 },
    );
  }

  const summary = result.rateLimitResetCredits;
  if (!isObject(summary)) {
    throw new CuarError(
      "reset_inventory_unavailable",
      "normalization",
      "Codex did not return banked-reset inventory.",
      { exitCode: 6 },
    );
  }

  const availableCount = summary.availableCount;
  if (!Number.isSafeInteger(availableCount) || availableCount < 0) {
    throw new CuarError(
      "reset_inventory_invalid",
      "normalization",
      "Codex returned an invalid banked-reset count.",
      { exitCode: 6 },
    );
  }

  if (!Object.hasOwn(summary, "credits")) {
    throw new CuarError(
      "reset_inventory_invalid",
      "normalization",
      "Codex returned invalid banked-reset details.",
      { exitCode: 6 },
    );
  }

  if (summary.credits === null) {
    const limitations =
      availableCount > 0
        ? [
            {
              code: "reset_credit_details_unavailable",
              message:
                "Codex returned the reset count without expiration details.",
            },
          ]
        : [];
    return {
      value: {
        available_count: availableCount,
        detail_state: "count_only",
        listed_available_count: 0,
        unlisted_available_count: availableCount,
        credits: [],
      },
      limitations,
    };
  }

  if (!Array.isArray(summary.credits)) {
    throw new CuarError(
      "reset_inventory_invalid",
      "normalization",
      "Codex returned invalid banked-reset details.",
      { exitCode: 6 },
    );
  }

  const seenIds = new Set();
  const normalized = [];
  let inconsistentRows = false;
  let expiredAvailable = false;

  for (const row of summary.credits) {
    if (!isObject(row)) {
      inconsistentRows = true;
      continue;
    }
    if (row.status !== "available") continue;
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      !Number.isSafeInteger(row.grantedAt)
    ) {
      inconsistentRows = true;
      continue;
    }
    if (seenIds.has(row.id)) {
      inconsistentRows = true;
      continue;
    }
    seenIds.add(row.id);

    const expiresAt = row.expiresAt;
    if (
      expiresAt !== null &&
      (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    ) {
      inconsistentRows = true;
      continue;
    }

    const expiryState =
      expiresAt === null
        ? "no_expiration_reported"
        : expiresAt <= fetchedAt
          ? "expired"
          : "future";
    if (expiryState === "expired") expiredAvailable = true;

    normalized.push({
      _id: row.id,
      _grantedAt: row.grantedAt,
      _expiresAt: expiresAt,
      reset_type: normalizedResetType(row.resetType),
      expires_at: expiresAt === null ? null : isoUtc(expiresAt),
      expires_at_local:
        expiresAt === null ? null : isoInTimeZone(expiresAt, timeZone),
      expiry_state: expiryState,
      seconds_until_expiry:
        expiresAt === null ? null : Math.max(0, expiresAt - fetchedAt),
    });
  }

  normalized.sort(compareCredits);
  const publicCredits = normalized.map(
    ({ _id, _grantedAt, _expiresAt, ...credit }) => credit,
  );
  const listedCount = publicCredits.length;
  const unlistedCount = Math.max(0, availableCount - listedCount);
  const complete =
    !inconsistentRows && listedCount === availableCount;
  const limitations = [];

  if (!complete) {
    limitations.push({
      code:
        availableCount > listedCount
          ? "reset_credit_details_capped"
          : "reset_credit_details_inconsistent",
      message:
        availableCount > listedCount
          ? `${unlistedCount} available reset${unlistedCount === 1 ? " has" : "s have"} no returned detail row.`
          : "Codex returned inconsistent banked-reset detail rows.",
    });
  }
  if (expiredAvailable) {
    limitations.push({
      code: "available_credit_expired",
      message:
        "Codex marked a returned reset as available even though its expiration is not in the future.",
    });
  }

  return {
    value: {
      available_count: availableCount,
      detail_state: complete ? "complete" : "partial",
      listed_available_count: listedCount,
      unlisted_available_count: unlistedCount,
      credits: publicCredits,
    },
    limitations,
  };
}

function attempt(factory) {
  try {
    return { value: factory(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

export function buildReport(
  result,
  { fetchedAt, timeZone, domain = "report" },
) {
  const usageAttempt =
    domain === "credits"
      ? { value: null, error: null }
      : attempt(() => normalizeUsage(result, { fetchedAt, timeZone }));
  const resetsAttempt =
    domain === "pace"
      ? { value: null, error: null }
      : attempt(() => normalizeBankedResets(result, { fetchedAt, timeZone }));

  if (domain === "pace" && usageAttempt.error) throw usageAttempt.error;
  if (domain === "credits" && resetsAttempt.error) throw resetsAttempt.error;

  if (
    domain === "report" &&
    usageAttempt.error &&
    resetsAttempt.error
  ) {
    throw usageAttempt.error;
  }

  const limitations = [];
  if (usageAttempt.error) {
    limitations.push(limitationFromError(usageAttempt.error));
  }
  if (resetsAttempt.error) {
    limitations.push(limitationFromError(resetsAttempt.error));
  }
  if (resetsAttempt.value) {
    limitations.push(...resetsAttempt.value.limitations);
  }

  return {
    schema_version: 2,
    status: limitations.length > 0 ? "partial" : "ok",
    fetched_at: isoUtc(fetchedAt),
    timezone: timeZone,
    source: {
      kind: "codex_app_server",
      method: "account/rateLimits/read",
    },
    usage: usageAttempt.value,
    banked_resets: resetsAttempt.value?.value ?? null,
    reset_observation: null,
    limitations,
    error: null,
  };
}
