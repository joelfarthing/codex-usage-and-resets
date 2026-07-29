import { asCuarError } from "./errors.mjs";
import { isoUtc } from "./time.mjs";

export const SCHEMA_VERSION = 2;
export const CUAR_VERSION = "0.1.1";

export function errorEnvelope(error, { timeZone, fetchedAt = null }) {
  const normalized = asCuarError(error);
  return {
    schema_version: SCHEMA_VERSION,
    status: "error",
    fetched_at: fetchedAt === null ? null : isoUtc(fetchedAt),
    timezone: timeZone,
    source: {
      kind: "codex_app_server",
      method: "account/rateLimits/read",
    },
    usage: null,
    banked_resets: null,
    reset_observation: null,
    limitations: [],
    error: {
      code: normalized.code,
      stage: normalized.stage,
      retryable: normalized.retryable,
      message: normalized.message,
    },
  };
}

export function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isObject(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys)
  );
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

function validateMessage(value) {
  return (
    hasExactKeys(value, ["code", "message"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function validateError(value) {
  return (
    hasExactKeys(value, ["code", "stage", "retryable", "message"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.stage === "string" &&
    value.stage.length > 0 &&
    typeof value.retryable === "boolean" &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function validateWindow(value) {
  return (
    hasExactKeys(value, [
      "duration_seconds",
      "used_percent",
      "remaining_percent",
      "percentage_precision",
      "resets_at",
      "resets_at_local",
      "seconds_until_reset",
      "elapsed_seconds",
      "elapsed_percent",
    ]) &&
    value.duration_seconds === 604_800 &&
    isFiniteNumber(value.used_percent) &&
    value.used_percent >= 0 &&
    value.used_percent <= 100 &&
    isFiniteNumber(value.remaining_percent) &&
    value.remaining_percent >= 0 &&
    value.remaining_percent <= 100 &&
    hasExactKeys(value.percentage_precision, [
      "source_granularity_percentage_points",
      "remaining_percent_interpretation",
      "remaining_capacity_state",
    ]) &&
    value.percentage_precision.source_granularity_percentage_points === 1 &&
    value.percentage_precision.remaining_percent_interpretation ===
      "upper_bound" &&
    ["reported_upper_bound", "less_than_one_percent", "exhausted"].includes(
      value.percentage_precision.remaining_capacity_state,
    ) &&
    isTimestamp(value.resets_at) &&
    typeof value.resets_at_local === "string" &&
    Number.isSafeInteger(value.seconds_until_reset) &&
    value.seconds_until_reset >= 0 &&
    Number.isSafeInteger(value.elapsed_seconds) &&
    value.elapsed_seconds >= 0 &&
    value.elapsed_seconds <= 604_800 &&
    isFiniteNumber(value.elapsed_percent) &&
    value.elapsed_percent >= 0 &&
    value.elapsed_percent <= 100
  );
}

function validatePace(value) {
  return (
    hasExactKeys(value, [
      "delta_percentage_points",
      "relation",
      "neutral_threshold_percentage_points",
    ]) &&
    isFiniteNumber(value.delta_percentage_points) &&
    ["above", "approximately_linear", "below"].includes(value.relation) &&
    value.neutral_threshold_percentage_points === 5
  );
}

function validateProjection(value) {
  return (
    hasExactKeys(value, [
      "end_state",
      "end_percent",
      "exhaustion_state",
      "exhaustion_at",
      "exhaustion_at_local",
    ]) &&
    ["projected", "insufficient_elapsed"].includes(value.end_state) &&
    (value.end_percent === null || isFiniteNumber(value.end_percent)) &&
    [
      "before_reset",
      "not_before_reset",
      "already_exhausted",
      "zero_usage",
      "insufficient_elapsed",
    ].includes(value.exhaustion_state) &&
    isNullableTimestamp(value.exhaustion_at) &&
    (value.exhaustion_at_local === null ||
      typeof value.exhaustion_at_local === "string")
  );
}

function validateUsage(value) {
  return (
    hasExactKeys(value, [
      "limit_id",
      "bucket_source",
      "window",
      "pace",
      "projection",
    ]) &&
    value.limit_id === "codex" &&
    ["rate_limits", "rate_limits_by_limit_id"].includes(value.bucket_source) &&
    validateWindow(value.window) &&
    validatePace(value.pace) &&
    validateProjection(value.projection)
  );
}

function validateCredit(value) {
  return (
    hasExactKeys(value, [
      "reset_type",
      "expires_at",
      "expires_at_local",
      "expiry_state",
      "seconds_until_expiry",
    ]) &&
    ["codex_rate_limits", "unknown"].includes(value.reset_type) &&
    isNullableTimestamp(value.expires_at) &&
    (value.expires_at_local === null ||
      typeof value.expires_at_local === "string") &&
    ["future", "expired", "no_expiration_reported"].includes(
      value.expiry_state,
    ) &&
    (value.seconds_until_expiry === null ||
      (Number.isSafeInteger(value.seconds_until_expiry) &&
        value.seconds_until_expiry >= 0))
  );
}

function validateBankedResets(value) {
  return (
    hasExactKeys(value, [
      "available_count",
      "detail_state",
      "listed_available_count",
      "unlisted_available_count",
      "credits",
    ]) &&
    Number.isSafeInteger(value.available_count) &&
    value.available_count >= 0 &&
    ["complete", "partial", "count_only"].includes(value.detail_state) &&
    Number.isSafeInteger(value.listed_available_count) &&
    value.listed_available_count >= 0 &&
    Number.isSafeInteger(value.unlisted_available_count) &&
    value.unlisted_available_count >= 0 &&
    Array.isArray(value.credits) &&
    value.credits.every(validateCredit)
  );
}

function validateResetEvent(value) {
  return (
    hasExactKeys(value, [
      "observed_at",
      "observed_at_local",
      "previous_observed_at",
      "previous_observed_at_local",
      "prior_scheduled_reset_at",
      "prior_scheduled_reset_at_local",
      "minutes_before_prior_scheduled_reset",
      "classification",
    ]) &&
    isTimestamp(value.observed_at) &&
    typeof value.observed_at_local === "string" &&
    isTimestamp(value.previous_observed_at) &&
    typeof value.previous_observed_at_local === "string" &&
    isTimestamp(value.prior_scheduled_reset_at) &&
    typeof value.prior_scheduled_reset_at_local === "string" &&
    Number.isSafeInteger(value.minutes_before_prior_scheduled_reset) &&
    value.minutes_before_prior_scheduled_reset >= 0 &&
    ["likely_unscheduled", "banked_reset_possible"].includes(
      value.classification,
    )
  );
}

function validateResetObservation(value) {
  return (
    hasExactKeys(value, [
      "ledger_status",
      "state",
      "detected_now",
      "latest_event",
    ]) &&
    ["active", "disabled_test_mode", "unavailable"].includes(
      value.ledger_status,
    ) &&
    [
      "no_prior_observation",
      "no_evidence",
      "unexpected_usage_reset_observed",
      "unavailable",
    ].includes(value.state) &&
    typeof value.detected_now === "boolean" &&
    (value.latest_event === null || validateResetEvent(value.latest_event)) &&
    (value.detected_now === false || value.latest_event !== null) &&
    (value.detected_now ===
      (value.state === "unexpected_usage_reset_observed")) &&
    (value.ledger_status === "active"
      ? value.state !== "unavailable"
      : value.state === "unavailable" &&
        value.detected_now === false &&
        value.latest_event === null)
  );
}

export function validateEnvelope(value) {
  const expectedKeys = [
    "schema_version",
    "status",
    "fetched_at",
    "timezone",
    "source",
    "usage",
    "banked_resets",
    "reset_observation",
    "limitations",
    "error",
  ];
  if (!hasExactKeys(value, expectedKeys)) return false;
  if (value.schema_version !== SCHEMA_VERSION) return false;
  if (!["ok", "partial", "error"].includes(value.status)) return false;
  if (typeof value.timezone !== "string") return false;
  if (
    !Array.isArray(value.limitations) ||
    !value.limitations.every(validateMessage)
  ) {
    return false;
  }
  if (
    !hasExactKeys(value.source, ["kind", "method"]) ||
    value.source.kind !== "codex_app_server" ||
    value.source.method !== "account/rateLimits/read"
  ) {
    return false;
  }
  if (value.status === "error") {
    return (
      isNullableTimestamp(value.fetched_at) &&
      value.usage === null &&
      value.banked_resets === null &&
      value.reset_observation === null &&
      validateError(value.error)
    );
  }
  return (
    isTimestamp(value.fetched_at) &&
    (value.usage === null || validateUsage(value.usage)) &&
    (value.banked_resets === null ||
      validateBankedResets(value.banked_resets)) &&
    (value.reset_observation === null ||
      validateResetObservation(value.reset_observation)) &&
    (value.usage !== null || value.banked_resets !== null) &&
    value.error === null
  );
}
