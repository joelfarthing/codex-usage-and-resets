import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BOUNDARY_TOLERANCE_SECONDS,
  WEEKLY_WINDOW_SECONDS,
} from "./calculate.mjs";
import { isoInTimeZone, isoUtc } from "./time.mjs";

export const RESET_LEDGER_VERSION = 1;
export const RESET_LEDGER_MAX_AGE_SECONDS = 8 * 24 * 60 * 60;
export const RESET_LEDGER_MINIMUM_PRIOR_USED_PERCENT = 10;
export const RESET_LEDGER_BOUNDARY_SECONDS = 5 * 60;

const MAX_LEDGER_BYTES = 16 * 1024;
const STALE_LOCK_MILLISECONDS = 60 * 1000;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isObject(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys)
  );
}

function validSnapshot(value) {
  return (
    hasExactKeys(value, [
      "fetched_at",
      "scheduled_reset_at",
      "used_percent",
      "banked_reset_available_count",
    ]) &&
    Number.isSafeInteger(value.fetched_at) &&
    value.fetched_at > 0 &&
    Number.isSafeInteger(value.scheduled_reset_at) &&
    value.scheduled_reset_at > 0 &&
    value.scheduled_reset_at >=
      value.fetched_at - BOUNDARY_TOLERANCE_SECONDS &&
    value.scheduled_reset_at <=
      value.fetched_at +
        WEEKLY_WINDOW_SECONDS +
        BOUNDARY_TOLERANCE_SECONDS &&
    Number.isInteger(value.used_percent) &&
    value.used_percent >= 0 &&
    value.used_percent <= 100 &&
    Number.isSafeInteger(value.banked_reset_available_count) &&
    value.banked_reset_available_count >= 0
  );
}

function validEvent(value) {
  return (
    hasExactKeys(value, [
      "observed_at",
      "previous_observed_at",
      "prior_scheduled_reset_at",
      "classification",
    ]) &&
    Number.isSafeInteger(value.observed_at) &&
    value.observed_at > 0 &&
    Number.isSafeInteger(value.previous_observed_at) &&
    value.previous_observed_at > 0 &&
    Number.isSafeInteger(value.prior_scheduled_reset_at) &&
    value.prior_scheduled_reset_at > 0 &&
    value.previous_observed_at < value.observed_at &&
    value.prior_scheduled_reset_at >=
      value.previous_observed_at - BOUNDARY_TOLERANCE_SECONDS &&
    value.prior_scheduled_reset_at <=
      value.previous_observed_at +
        WEEKLY_WINDOW_SECONDS +
        BOUNDARY_TOLERANCE_SECONDS &&
    value.observed_at <
      value.prior_scheduled_reset_at - RESET_LEDGER_BOUNDARY_SECONDS &&
    ["likely_unscheduled", "banked_reset_possible"].includes(
      value.classification,
    )
  );
}

function emptyLedger() {
  return {
    version: RESET_LEDGER_VERSION,
    snapshot: null,
    last_event: null,
  };
}

function parseEpoch(timestamp) {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = milliseconds / 1000;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function snapshotFromReport(report) {
  if (
    !report?.usage ||
    !report?.banked_resets ||
    report.limitations?.some(
      (limitation) => limitation.code === "available_credit_expired",
    )
  ) {
    return null;
  }
  const fetchedAt = parseEpoch(report.fetched_at);
  const scheduledResetAt = parseEpoch(report.usage.window.resets_at);
  const usedPercent = report.usage.window.used_percent;
  const bankedResetAvailableCount = report.banked_resets.available_count;
  const snapshot = {
    fetched_at: fetchedAt,
    scheduled_reset_at: scheduledResetAt,
    used_percent: usedPercent,
    banked_reset_available_count: bankedResetAvailableCount,
  };
  return validSnapshot(snapshot) ? snapshot : null;
}

export function detectUnexpectedReset(previous, current) {
  if (!validSnapshot(previous) || !validSnapshot(current)) return null;
  if (current.fetched_at <= previous.fetched_at) return null;
  if (
    current.fetched_at >=
    previous.scheduled_reset_at - RESET_LEDGER_BOUNDARY_SECONDS
  ) {
    return null;
  }
  if (
    previous.used_percent < RESET_LEDGER_MINIMUM_PRIOR_USED_PERCENT ||
    current.used_percent !== 0 ||
    previous.used_percent - current.used_percent <
      RESET_LEDGER_MINIMUM_PRIOR_USED_PERCENT
  ) {
    return null;
  }
  return {
    observed_at: current.fetched_at,
    previous_observed_at: previous.fetched_at,
    prior_scheduled_reset_at: previous.scheduled_reset_at,
    classification:
      current.banked_reset_available_count <
      previous.banked_reset_available_count
        ? "banked_reset_possible"
        : "likely_unscheduled",
  };
}

function readLedger(ledgerPath) {
  let metadata;
  try {
    metadata = fs.lstatSync(ledgerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { ledger: emptyLedger(), invalid: false };
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("unsafe ledger path");
  }
  if (metadata.size > MAX_LEDGER_BYTES) {
    return { ledger: emptyLedger(), invalid: true };
  }
  try {
    const value = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    if (
      !hasExactKeys(value, ["version", "snapshot", "last_event"]) ||
      value.version !== RESET_LEDGER_VERSION ||
      (value.snapshot !== null && !validSnapshot(value.snapshot)) ||
      (value.last_event !== null && !validEvent(value.last_event))
    ) {
      return { ledger: emptyLedger(), invalid: true };
    }
    return { ledger: value, invalid: false };
  } catch {
    return { ledger: emptyLedger(), invalid: true };
  }
}

function ensureLedgerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("unsafe ledger directory");
  }
}

function acquireLock(lockPath) {
  const attempt = () => {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    return true;
  };
  try {
    return attempt();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const metadata = fs.lstatSync(lockPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("unsafe ledger lock");
  }
  if (Date.now() - metadata.mtimeMs <= STALE_LOCK_MILLISECONDS) {
    throw new Error("ledger busy");
  }
  fs.rmdirSync(lockPath);
  return attempt();
}

function releaseLock(lockPath) {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // A missing lock after the transaction does not affect the report.
  }
}

function temporaryPathForLedger(ledgerPath) {
  return path.join(
    path.dirname(ledgerPath),
    `.${path.basename(ledgerPath)}.tmp`,
  );
}

function removeInterruptedTemporaryLedger(ledgerPath) {
  const temporaryPath = temporaryPathForLedger(ledgerPath);
  let metadata;
  try {
    metadata = fs.lstatSync(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("unsafe temporary ledger path");
  }
  fs.unlinkSync(temporaryPath);
}

function atomicWriteLedger(ledgerPath, ledger) {
  const temporaryPath = temporaryPathForLedger(ledgerPath);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(ledger)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, ledgerPath);
    fs.chmodSync(ledgerPath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Continue to remove the incomplete temporary file.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function invalidateLedgerChain(ledgerPath) {
  const directory = path.dirname(ledgerPath);
  let directoryMetadata;
  try {
    directoryMetadata = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error("unsafe ledger directory");
  }

  const lockPath = `${ledgerPath}.lock`;
  let locked = false;
  try {
    acquireLock(lockPath);
    locked = true;
    removeInterruptedTemporaryLedger(ledgerPath);
    const loaded = readLedger(ledgerPath);
    if (
      loaded.invalid ||
      loaded.ledger.snapshot !== null ||
      loaded.ledger.last_event !== null
    ) {
      atomicWriteLedger(ledgerPath, emptyLedger());
    }
  } finally {
    if (locked) releaseLock(lockPath);
  }
}

function formatEvent(event, timeZone) {
  if (!event) return null;
  return {
    observed_at: isoUtc(event.observed_at),
    observed_at_local: isoInTimeZone(event.observed_at, timeZone),
    previous_observed_at: isoUtc(event.previous_observed_at),
    previous_observed_at_local: isoInTimeZone(
      event.previous_observed_at,
      timeZone,
    ),
    prior_scheduled_reset_at: isoUtc(event.prior_scheduled_reset_at),
    prior_scheduled_reset_at_local: isoInTimeZone(
      event.prior_scheduled_reset_at,
      timeZone,
    ),
    minutes_before_prior_scheduled_reset: Math.floor(
      (event.prior_scheduled_reset_at - event.observed_at) / 60,
    ),
    classification: event.classification,
  };
}

function unavailableObservation(ledgerStatus = "unavailable") {
  return {
    ledger_status: ledgerStatus,
    state: "unavailable",
    detected_now: false,
    latest_event: null,
  };
}

export function resolveResetLedgerPath({
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (env.CUAR_LEDGER_PATH) {
    if (!platformPath.isAbsolute(env.CUAR_LEDGER_PATH)) {
      throw new Error("CUAR_LEDGER_PATH must be absolute");
    }
    return env.CUAR_LEDGER_PATH;
  }
  if (env.CUAR_TEST_MODE === "1") return null;

  if (platform === "win32") {
    const root = env.LOCALAPPDATA;
    if (!root || !platformPath.isAbsolute(root)) {
      throw new Error("LOCALAPPDATA is unavailable");
    }
    return platformPath.join(root, "CUAR", "Cache", "reset-ledger.json");
  }
  if (platform === "darwin") {
    if (!homeDirectory || !platformPath.isAbsolute(homeDirectory)) {
      throw new Error("home directory is unavailable");
    }
    return platformPath.join(
      homeDirectory,
      "Library",
      "Caches",
      "CUAR",
      "reset-ledger.json",
    );
  }
  const cacheRoot =
    env.XDG_CACHE_HOME && platformPath.isAbsolute(env.XDG_CACHE_HOME)
      ? env.XDG_CACHE_HOME
      : homeDirectory && platformPath.isAbsolute(homeDirectory)
        ? platformPath.join(homeDirectory, ".cache")
        : null;
  if (cacheRoot === null) throw new Error("cache directory is unavailable");
  return platformPath.join(cacheRoot, "cuar", "reset-ledger.json");
}

export function observeResetLedger(
  report,
  {
    env = process.env,
    platform = process.platform,
    homeDirectory = os.homedir(),
  } = {},
) {
  const current = snapshotFromReport(report);
  let ledgerPath;
  try {
    ledgerPath = resolveResetLedgerPath({ env, platform, homeDirectory });
  } catch {
    return current ? unavailableObservation() : null;
  }
  if (ledgerPath === null) {
    return current ? unavailableObservation("disabled_test_mode") : null;
  }
  if (!current) {
    try {
      invalidateLedgerChain(ledgerPath);
    } catch {
      // An untrustworthy report must not gain a ledger-derived interpretation.
    }
    return null;
  }

  const directory = path.dirname(ledgerPath);
  const lockPath = `${ledgerPath}.lock`;
  let locked = false;
  try {
    ensureLedgerDirectory(directory);
    acquireLock(lockPath);
    locked = true;
    removeInterruptedTemporaryLedger(ledgerPath);

    const loaded = readLedger(ledgerPath);
    const ledger = loaded.ledger;
    const cutoff = current.fetched_at - RESET_LEDGER_MAX_AGE_SECONDS;
    if (ledger.snapshot?.fetched_at < cutoff) ledger.snapshot = null;
    if (ledger.last_event?.observed_at < cutoff) ledger.last_event = null;

    const previous = ledger.snapshot;
    const detected = detectUnexpectedReset(previous, current);
    if (detected) ledger.last_event = detected;

    const shouldReplaceSnapshot =
      previous === null || current.fetched_at > previous.fetched_at;
    if (shouldReplaceSnapshot) ledger.snapshot = current;
    if (shouldReplaceSnapshot || detected || loaded.invalid) {
      atomicWriteLedger(ledgerPath, ledger);
    }

    return {
      ledger_status: "active",
      state:
        previous === null
          ? "no_prior_observation"
          : detected
            ? "unexpected_usage_reset_observed"
            : "no_evidence",
      detected_now: detected !== null,
      latest_event: formatEvent(ledger.last_event, report.timezone),
    };
  } catch {
    return unavailableObservation();
  } finally {
    if (locked) releaseLock(lockPath);
  }
}
