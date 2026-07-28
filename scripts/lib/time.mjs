import { CuarError } from "./errors.mjs";

export function wholeEpochSeconds(now = Date.now()) {
  const milliseconds = typeof now === "function" ? now() : now;
  if (!Number.isFinite(milliseconds)) {
    throw new CuarError(
      "internal_error",
      "time",
      "CUAR could not capture a valid local clock value.",
      { exitCode: 7 },
    );
  }
  return Math.floor(milliseconds / 1000);
}

export function isoUtc(epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds)) {
    throw new CuarError(
      "response_shape_invalid",
      "normalization",
      "Codex returned an invalid timestamp.",
      { exitCode: 6 },
    );
  }
  const value = new Date(epochSeconds * 1000);
  if (Number.isNaN(value.getTime())) {
    throw new CuarError(
      "response_shape_invalid",
      "normalization",
      "Codex returned an invalid timestamp.",
      { exitCode: 6 },
    );
  }
  return value.toISOString().replace(".000Z", "Z");
}

function formatterFor(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch (error) {
    throw new CuarError(
      "invalid_timezone",
      "configuration",
      "CUAR could not use the requested IANA time zone.",
      { cause: error, exitCode: 2 },
    );
  }
}

export function resolveTimeZone(explicitTimeZone) {
  if (explicitTimeZone !== undefined) {
    if (
      typeof explicitTimeZone !== "string" ||
      explicitTimeZone.trim().length === 0
    ) {
      throw new CuarError(
        "invalid_timezone",
        "configuration",
        "CUAR could not use the requested IANA time zone.",
        { exitCode: 2 },
      );
    }
    formatterFor(explicitTimeZone);
    return explicitTimeZone;
  }

  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) {
      formatterFor(detected);
      return detected;
    }
  } catch {
    // Fall through to UTC.
  }
  return "UTC";
}

export function isoInTimeZone(epochSeconds, timeZone) {
  const utc = isoUtc(epochSeconds);
  const date = new Date(utc);
  const parts = Object.create(null);
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  const required = ["year", "month", "day", "hour", "minute", "second"];
  if (required.some((key) => !parts[key])) {
    throw new CuarError(
      "internal_error",
      "time",
      "CUAR could not format a local timestamp.",
      { exitCode: 7 },
    );
  }

  const localAsUtcSeconds = Math.floor(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ) / 1000,
  );
  const offsetSeconds = localAsUtcSeconds - epochSeconds;
  const sign = offsetSeconds < 0 ? "-" : "+";
  const absoluteMinutes = Math.floor(Math.abs(offsetSeconds) / 60);
  const offsetHours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const offsetMinutes = String(absoluteMinutes % 60).padStart(2, "0");

  return (
    `${parts.year}-${parts.month}-${parts.day}` +
    `T${parts.hour}:${parts.minute}:${parts.second}` +
    `${sign}${offsetHours}:${offsetMinutes}`
  );
}
