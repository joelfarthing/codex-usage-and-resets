import assert from "node:assert/strict";
import test from "node:test";

import {
  isoInTimeZone,
  isoUtc,
  resolveTimeZone,
} from "../scripts/lib/time.mjs";

test("formats canonical UTC and Chicago daylight time", () => {
  assert.equal(isoUtc(1785454800), "2026-07-30T23:40:00Z");
  assert.equal(
    isoInTimeZone(1785454800, "America/Chicago"),
    "2026-07-30T18:40:00-05:00",
  );
});

test("formats Chicago standard time with the correct offset", () => {
  const winter = Date.parse("2026-01-15T18:00:00Z") / 1000;
  assert.equal(
    isoInTimeZone(winter, "America/Chicago"),
    "2026-01-15T12:00:00-06:00",
  );
});

test("preserves distinct offsets across the fall-back hour", () => {
  const before = Date.parse("2026-11-01T06:30:00Z") / 1000;
  const after = Date.parse("2026-11-01T07:30:00Z") / 1000;
  assert.equal(
    isoInTimeZone(before, "America/Chicago"),
    "2026-11-01T01:30:00-05:00",
  );
  assert.equal(
    isoInTimeZone(after, "America/Chicago"),
    "2026-11-01T01:30:00-06:00",
  );
});

test("rejects an invalid explicit zone", () => {
  assert.throws(
    () => resolveTimeZone("Not/A_Real_Zone"),
    (error) => error.code === "invalid_timezone",
  );
});
