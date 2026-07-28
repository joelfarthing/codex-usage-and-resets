import { CuarError } from "./errors.mjs";
import { isoInTimeZone, isoUtc } from "./time.mjs";

export const WEEKLY_WINDOW_MINUTES = 10_080;
export const WEEKLY_WINDOW_SECONDS = WEEKLY_WINDOW_MINUTES * 60;
export const NEUTRAL_THRESHOLD_POINTS = 5;
export const PROJECTION_MINIMUM_ELAPSED_PERCENT = 5;
export const BOUNDARY_TOLERANCE_SECONDS = 5;

export function roundOne(value) {
  const rounded = Number(Number(value).toFixed(1));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function validateUsedPercent(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new CuarError(
      "used_percent_invalid",
      "normalization",
      "Codex returned an invalid weekly used percentage.",
      { exitCode: 6 },
    );
  }
}

function validateResetTimestamp(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CuarError(
      "reset_timestamp_invalid",
      "normalization",
      "Codex did not return a usable weekly reset timestamp.",
      { exitCode: 6 },
    );
  }
}

function elapsedSecondsFor(resetAt, fetchedAt) {
  let elapsed = WEEKLY_WINDOW_SECONDS - (resetAt - fetchedAt);
  if (elapsed < 0 && elapsed >= -BOUNDARY_TOLERANCE_SECONDS) elapsed = 0;
  if (
    elapsed > WEEKLY_WINDOW_SECONDS &&
    elapsed <= WEEKLY_WINDOW_SECONDS + BOUNDARY_TOLERANCE_SECONDS
  ) {
    elapsed = WEEKLY_WINDOW_SECONDS;
  }
  if (elapsed < 0 || elapsed > WEEKLY_WINDOW_SECONDS) {
    throw new CuarError(
      "reset_timestamp_invalid",
      "normalization",
      "Codex returned weekly window timing that is not currently usable.",
      { exitCode: 6 },
    );
  }
  return elapsed;
}

function remainingCapacityState(remainingPercent) {
  if (remainingPercent === 0) return "exhausted";
  if (remainingPercent === 1) return "less_than_one_percent";
  return "reported_upper_bound";
}

export function calculateUsage(
  sourceWindow,
  { bucketSource, fetchedAt, timeZone },
) {
  if (
    !sourceWindow ||
    typeof sourceWindow !== "object" ||
    !Object.hasOwn(sourceWindow, "usedPercent") ||
    sourceWindow.usedPercent === null ||
    sourceWindow.usedPercent === undefined
  ) {
    throw new CuarError(
      "response_shape_invalid",
      "normalization",
      "Codex returned an incomplete weekly usage window.",
      { exitCode: 6 },
    );
  }
  const usedPercent = sourceWindow?.usedPercent;
  const durationMinutes = sourceWindow?.windowDurationMins;
  const resetsAt = sourceWindow?.resetsAt;

  validateUsedPercent(usedPercent);
  if (durationMinutes !== WEEKLY_WINDOW_MINUTES) {
    throw new CuarError(
      "weekly_window_missing",
      "normalization",
      "Codex did not return the expected 10,080-minute weekly window.",
      { exitCode: 6 },
    );
  }
  validateResetTimestamp(resetsAt);

  const elapsedSeconds = elapsedSecondsFor(resetsAt, fetchedAt);
  const elapsedFraction = elapsedSeconds / WEEKLY_WINDOW_SECONDS;
  const elapsedPercent = elapsedFraction * 100;
  const delta = usedPercent - elapsedPercent;
  const remainingPercent = 100 - usedPercent;

  let relation = "approximately_linear";
  if (delta > NEUTRAL_THRESHOLD_POINTS) relation = "above";
  if (delta < -NEUTRAL_THRESHOLD_POINTS) relation = "below";

  let endState = "insufficient_elapsed";
  let endPercent = null;
  let exhaustionState = "insufficient_elapsed";
  let exhaustionAt = null;

  if (usedPercent >= 100) {
    endState = "projected";
    endPercent = 100;
    exhaustionState = "already_exhausted";
    exhaustionAt = fetchedAt;
  } else if (usedPercent === 0) {
    endState =
      elapsedPercent >= PROJECTION_MINIMUM_ELAPSED_PERCENT
        ? "projected"
        : "insufficient_elapsed";
    endPercent =
      elapsedPercent >= PROJECTION_MINIMUM_ELAPSED_PERCENT ? 0 : null;
    exhaustionState = "zero_usage";
  } else if (elapsedPercent >= PROJECTION_MINIMUM_ELAPSED_PERCENT) {
    endState = "projected";
    endPercent = usedPercent / elapsedFraction;
    const secondsToExhaustion =
      ((100 - usedPercent) / usedPercent) * elapsedSeconds;
    const projected = fetchedAt + Math.round(secondsToExhaustion);
    if (projected < resetsAt) {
      exhaustionState = "before_reset";
      exhaustionAt = projected;
    } else {
      exhaustionState = "not_before_reset";
    }
  }

  return {
    limit_id: "codex",
    bucket_source: bucketSource,
    window: {
      duration_seconds: WEEKLY_WINDOW_SECONDS,
      used_percent: roundOne(usedPercent),
      remaining_percent: roundOne(remainingPercent),
      percentage_precision: {
        source_granularity_percentage_points: 1,
        remaining_percent_interpretation: "upper_bound",
        remaining_capacity_state: remainingCapacityState(remainingPercent),
      },
      resets_at: isoUtc(resetsAt),
      resets_at_local: isoInTimeZone(resetsAt, timeZone),
      seconds_until_reset: Math.max(0, resetsAt - fetchedAt),
      elapsed_seconds: elapsedSeconds,
      elapsed_percent: roundOne(elapsedPercent),
    },
    pace: {
      delta_percentage_points: roundOne(delta),
      relation,
      neutral_threshold_percentage_points: NEUTRAL_THRESHOLD_POINTS,
    },
    projection: {
      end_state: endState,
      end_percent: endPercent === null ? null : roundOne(endPercent),
      exhaustion_state: exhaustionState,
      exhaustion_at: exhaustionAt === null ? null : isoUtc(exhaustionAt),
      exhaustion_at_local:
        exhaustionAt === null
          ? null
          : isoInTimeZone(exhaustionAt, timeZone),
    },
  };
}
