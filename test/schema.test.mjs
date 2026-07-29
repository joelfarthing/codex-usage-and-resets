import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { errorEnvelope, validateEnvelope } from "../scripts/lib/schema.mjs";
import { CuarError } from "../scripts/lib/errors.mjs";
import { buildReport } from "../scripts/lib/normalize.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function schemaAccepts(value, schema, root = schema) {
  if (schema.$ref) {
    const segments = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
    const resolved = segments.reduce((current, segment) => current?.[segment], root);
    return Boolean(resolved) && schemaAccepts(value, resolved, root);
  }
  if (schema.anyOf) {
    return schema.anyOf.some((candidate) =>
      schemaAccepts(value, candidate, root),
    );
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;

  const types = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : [];
  if (
    types.length > 0 &&
    !types.some((type) => {
      if (type === "null") return value === null;
      if (type === "object") {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
      }
      if (type === "array") return Array.isArray(value);
      if (type === "integer") return Number.isInteger(value);
      if (type === "number") return typeof value === "number" && Number.isFinite(value);
      return typeof value === type;
    })
  ) {
    return false;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (
    typeof value === "string" &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  ) {
    return false;
  }
  if (
    typeof value === "string" &&
    schema.format === "date-time" &&
    Number.isNaN(Date.parse(value))
  ) {
    return false;
  }
  if (Array.isArray(value) && schema.items) {
    return value.every((item) => schemaAccepts(item, schema.items, root));
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (schema.properties || schema.required || schema.additionalProperties === false)
  ) {
    const properties = schema.properties ?? {};
    if (
      schema.required?.some((property) => !Object.hasOwn(value, property))
    ) {
      return false;
    }
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((property) => !Object.hasOwn(properties, property))
    ) {
      return false;
    }
    return Object.entries(properties).every(
      ([property, definition]) =>
        !Object.hasOwn(value, property) ||
        schemaAccepts(value[property], definition, root),
    );
  }
  return true;
}

function completeReport() {
  return buildReport(
    {
      rateLimits: {
        limitId: "codex",
        primary: null,
        secondary: {
          usedPercent: 42,
          windowDurationMins: 10080,
          resetsAt: 1785591000,
        },
      },
      rateLimitResetCredits: {
        availableCount: 0,
        credits: [],
      },
    },
    { fetchedAt: 1785213000, timeZone: "America/Chicago" },
  );
}

test("ships a strict JSON Schema 2020-12 report definition", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "schema", "report.schema.json"), "utf8"),
  );
  assert.equal(
    schema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema_version.const, 2);
  assert.equal(schema.$defs.usage.additionalProperties, false);
  assert.equal(schema.$defs.percentage_precision.additionalProperties, false);
  assert.equal(schema.$defs.credit.additionalProperties, false);
  assert.equal(schema.$defs.reset_observation.additionalProperties, false);
  assert.equal(schema.$defs.reset_event.additionalProperties, false);
});

test("error envelopes are strict, sanitized, and unfetched", () => {
  const report = errorEnvelope(
    new CuarError(
      "codex_not_found",
      "runtime_discovery",
      "CUAR could not start the local Codex executable.",
      { exitCode: 3 },
    ),
    { timeZone: "UTC" },
  );
  assert.equal(validateEnvelope(report), true);
  assert.equal(report.fetched_at, null);
  assert.equal(report.usage, null);
  assert.equal(report.banked_resets, null);
  assert.equal(report.reset_observation, null);
});

test("runtime validation checks complete, partial, and nested report shapes", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "schema", "report.schema.json"), "utf8"),
  );
  const complete = completeReport();
  assert.equal(validateEnvelope(complete), true);
  assert.equal(schemaAccepts(complete, schema), true);

  const partial = completeReport();
  partial.status = "partial";
  partial.banked_resets = null;
  partial.limitations.push({
    code: "reset_inventory_unavailable",
    message: "Codex did not return banked-reset inventory.",
  });
  assert.equal(validateEnvelope(partial), true);
  assert.equal(schemaAccepts(partial, schema), true);

  const error = errorEnvelope(
    new CuarError(
      "codex_not_found",
      "runtime_discovery",
      "CUAR could not start the local Codex executable.",
      { exitCode: 3 },
    ),
    { timeZone: "UTC" },
  );
  assert.equal(validateEnvelope(error), true);
  assert.equal(schemaAccepts(error, schema), true);

  const unknownNestedKey = structuredClone(complete);
  unknownNestedKey.usage.window.unknown = true;
  assert.equal(validateEnvelope(unknownNestedKey), false);
  assert.equal(schemaAccepts(unknownNestedKey, schema), false);

  const invalidPrecision = structuredClone(complete);
  invalidPrecision.usage.window.percentage_precision.remaining_capacity_state =
    "exact";
  assert.equal(validateEnvelope(invalidPrecision), false);
  assert.equal(schemaAccepts(invalidPrecision, schema), false);

  const malformedResetObservation = structuredClone(complete);
  malformedResetObservation.reset_observation = {
    ledger_status: "active",
    state: "unexpected_usage_reset_observed",
    detected_now: true,
    latest_event: null,
  };
  assert.equal(validateEnvelope(malformedResetObservation), false);
  assert.equal(schemaAccepts(malformedResetObservation, schema), true);

  const malformedCredit = structuredClone(complete);
  malformedCredit.banked_resets.available_count = 1;
  malformedCredit.banked_resets.listed_available_count = 1;
  malformedCredit.banked_resets.credits = [{ expires_at: "not enough" }];
  assert.equal(validateEnvelope(malformedCredit), false);
  assert.equal(schemaAccepts(malformedCredit, schema), false);

  const missingRequired = structuredClone(complete);
  delete missingRequired.source;
  assert.equal(validateEnvelope(missingRequired), false);
  assert.equal(schemaAccepts(missingRequired, schema), false);
});
