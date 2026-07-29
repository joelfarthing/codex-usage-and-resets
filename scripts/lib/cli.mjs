import { readCodexVersion, readRateLimits } from "./app-server.mjs";
import { CuarError, asCuarError } from "./errors.mjs";
import {
  buildReport,
  normalizeBankedResets,
  normalizeUsage,
} from "./normalize.mjs";
import {
  CUAR_VERSION,
  errorEnvelope,
  jsonLine,
  validateEnvelope,
} from "./schema.mjs";
import { observeResetLedger } from "./reset-ledger.mjs";
import { isoUtc, resolveTimeZone } from "./time.mjs";

const HELP = `CUAR ${CUAR_VERSION}

Usage:
  cuar report [--json|--text] [--timezone <IANA zone>]
  cuar credits [--json|--text] [--timezone <IANA zone>]
  cuar pace [--json|--text] [--timezone <IANA zone>]
  cuar doctor --json
  cuar --help
  cuar --version
`;

function parseArgs(argv) {
  if (argv.length === 0) return { command: "report", format: "text" };
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    return { special: "help" };
  }
  if (argv.length === 1 && argv[0] === "--version") {
    return { special: "version" };
  }

  const command = argv[0];
  if (!["report", "credits", "pace", "doctor"].includes(command)) {
    throw new CuarError(
      "invalid_arguments",
      "configuration",
      "CUAR did not recognize that command. Run with --help.",
      { exitCode: 2 },
    );
  }

  let format = command === "doctor" ? "json" : "text";
  let timeZone;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      format = "json";
    } else if (argument === "--text") {
      if (command === "doctor") {
        throw new CuarError(
          "invalid_arguments",
          "configuration",
          "CUAR doctor supports JSON output only.",
          { exitCode: 2 },
        );
      }
      format = "text";
    } else if (argument === "--timezone") {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new CuarError(
          "invalid_arguments",
          "configuration",
          "--timezone requires an IANA time-zone name.",
          { exitCode: 2 },
        );
      }
      timeZone = argv[index];
    } else {
      throw new CuarError(
        "invalid_arguments",
        "configuration",
        "CUAR did not recognize those arguments. Run with --help.",
        { exitCode: 2 },
      );
    }
  }
  return { command, format, timeZone };
}

function clockFromEnvironment(env) {
  if (env.CUAR_TEST_MODE === "1" && env.CUAR_TEST_FETCHED_AT) {
    const value = Number(env.CUAR_TEST_FETCHED_AT);
    if (Number.isSafeInteger(value)) return () => value;
  }
  return () => Math.floor(Date.now() / 1000);
}

function addAdapterLimitations(report, diagnostics) {
  if (diagnostics?.stderrTruncated) {
    report.limitations.push({
      code: "app_server_stderr_truncated",
      message: "Codex App Server emitted unusually large diagnostic output.",
    });
  }
  if (diagnostics?.cleanupWarning) {
    report.limitations.push(diagnostics.cleanupWarning);
  }
  if (report.limitations.length > 0 && report.status === "ok") {
    report.status = "partial";
  }
}

function textReport(report) {
  const lines = [
    `CUAR — fetched ${report.fetched_at} (${report.timezone})`,
  ];
  if (report.banked_resets) {
    const resets = report.banked_resets;
    lines.push(`Banked resets: ${resets.available_count}`);
    for (const [index, credit] of resets.credits.entries()) {
      lines.push(
        `  ${index + 1}. ${credit.expires_at_local ?? "no expiration reported"} (${credit.expiry_state})`,
      );
    }
  }
  if (report.usage) {
    const usage = report.usage;
    lines.push(
      `Weekly usage: ${usage.window.used_percent}% used, ${usage.window.remaining_percent}% remaining`,
    );
    if (
      usage.window.percentage_precision.remaining_capacity_state ===
      "less_than_one_percent"
    ) {
      lines.push(
        "Precision: OpenAI reports usage in whole percentage points, so the reported 1% remaining means actual remaining usage is below 1%; exhaustion is imminent and may occur sooner than the projection.",
      );
    } else {
      lines.push(
        "Precision: Percentages are rounded, so actual remaining usage may be slightly lower.",
      );
    }
    lines.push(
      `Pace: ${usage.pace.relation}, ${usage.pace.delta_percentage_points} percentage points`,
    );
    lines.push(
      "Linear pace means being on track to use exactly 100% at the next scheduled reset.",
    );
    lines.push(`Next scheduled reset: ${usage.window.resets_at_local}`);
    const projection = usage.projection;
    if (projection.exhaustion_state === "before_reset") {
      lines.push(`Projected exhaustion: ${projection.exhaustion_at_local}`);
    } else {
      lines.push(`Projected exhaustion: ${projection.exhaustion_state}`);
    }
  }
  const resetObservation = report.reset_observation;
  if (resetObservation?.latest_event) {
    const event = resetObservation.latest_event;
    const label = resetObservation.detected_now
      ? "Unexpected usage reset observed"
      : "Latest unexpected usage reset observation";
    const interpretation =
      event.classification === "banked_reset_possible"
        ? "banked-reset use is possible; an account switch cannot be ruled out"
        : "consistent with a likely unscheduled reset; an account switch cannot be ruled out";
    lines.push(
      `${label}: by ${event.observed_at_local}, ${event.minutes_before_prior_scheduled_reset} minutes before the prior scheduled reset (${interpretation})`,
    );
  }
  for (const limitation of report.limitations) {
    lines.push(`Limitation: ${limitation.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function doctorReport({ checkedAt, codexVersion, result, timeZone }) {
  let usageSupported = false;
  let resetsSupported = false;
  const warnings = [];
  try {
    normalizeUsage(result, { fetchedAt: checkedAt, timeZone });
    usageSupported = true;
  } catch (error) {
    warnings.push({
      code: asCuarError(error).code,
      message: asCuarError(error).message,
    });
  }
  try {
    normalizeBankedResets(result, { fetchedAt: checkedAt, timeZone });
    resetsSupported = true;
  } catch (error) {
    warnings.push({
      code: asCuarError(error).code,
      message: asCuarError(error).message,
    });
  }

  return {
    schema_version: 1,
    status: warnings.length > 0 ? "partial" : "ok",
    checked_at: isoUtc(checkedAt),
    cuar_version: CUAR_VERSION,
    node_version: process.versions.node,
    codex_version: codexVersion,
    app_server: {
      initialized: true,
      rate_limits_read: true,
      codex_weekly_window: usageSupported,
      reset_credit_summary: resetsSupported,
    },
    warnings,
    error: null,
  };
}

export async function runCli(argv, options = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    adapter = readRateLimits,
    versionReader = readCodexVersion,
    signal,
  } = options;
  let parsed;
  let timeZone = "UTC";

  try {
    parsed = parseArgs(argv);
    if (parsed.special === "help") {
      stdout.write(HELP);
      return 0;
    }
    if (parsed.special === "version") {
      stdout.write(`CUAR ${CUAR_VERSION}\n`);
      return 0;
    }

    timeZone = resolveTimeZone(parsed.timeZone);
    const clock = clockFromEnvironment(env);

    if (parsed.command === "doctor") {
      const codexVersion = versionReader(env);
      const acquisition = await adapter({ env, clock, signal });
      const report = doctorReport({
        checkedAt: acquisition.fetchedAt,
        codexVersion,
        result: acquisition.result,
        timeZone,
      });
      stdout.write(jsonLine(report));
      return 0;
    }

    const acquisition = await adapter({ env, clock, signal });
    const domain =
      parsed.command === "pace"
        ? "pace"
        : parsed.command === "credits"
          ? "credits"
          : "report";
    const report = buildReport(acquisition.result, {
      fetchedAt: acquisition.fetchedAt,
      timeZone,
      domain,
    });
    addAdapterLimitations(report, acquisition.diagnostics);
    if (parsed.command === "report") {
      report.reset_observation = observeResetLedger(report, { env });
    }
    if (!validateEnvelope(report)) {
      throw new CuarError(
        "internal_error",
        "serialization",
        "CUAR produced an invalid report envelope.",
        { exitCode: 7 },
      );
    }
    stdout.write(parsed.format === "json" ? jsonLine(report) : textReport(report));
    return 0;
  } catch (error) {
    const normalized = asCuarError(error);
    stdout.write(jsonLine(errorEnvelope(normalized, { timeZone })));
    return normalized.exitCode;
  }
}

export { HELP };
