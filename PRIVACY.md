# Privacy Policy

Last updated: July 28, 2026

## Local processing

CUAR runs on the user's machine. It starts the user's local Codex App Server
and performs one read-only `account/rateLimits/read` request when invoked.
Normalization, pace calculations, projections, and time-zone conversion happen
locally.

CUAR does not operate a hosted usage service, send telemetry to Filament Labs,
read Codex authentication files, inspect session logs, or persist reset-credit
identifiers, account identifiers, or raw App Server responses.

## Local reset ledger

To observe an unexpected reset across invocations, CUAR keeps one sanitized
local snapshot containing the observation time, scheduled reset time, whole
used percentage, and banked-reset count. It may also retain one derived reset
observation containing only its observation window, prior scheduled reset, and
source classification. On each successful report, CUAR discards records older
than eight days. Records are replaced rather than accumulated. A report that
cannot form a trustworthy comparison clears the comparison chain.

Writes use one fixed-name same-directory temporary file. An interrupted
temporary write is removed before the next ledger transaction rather than
accumulating as history.

The ledger remains on the user's machine. Its default location is:

- macOS: `~/Library/Caches/CUAR/reset-ledger.json`
- Linux: `$XDG_CACHE_HOME/cuar/reset-ledger.json`, or
  `~/.cache/cuar/reset-ledger.json`
- Windows: `%LOCALAPPDATA%\CUAR\Cache\reset-ledger.json`

Deleting that file clears the ledger and causes the next successful report to
create a new baseline. CUAR never uploads the ledger to Filament Labs.

## Codex and OpenAI

When the CUAR skill reports results in a conversation, the normalized facts the
agent uses may be processed by OpenAI under the user's account and applicable
OpenAI terms. Codex authentication and the App Server response remain subject
to OpenAI's services and privacy practices.

## Diagnostics

CUAR exposes sanitized error messages. `doctor --json` reports compatibility
and version information without usage percentages, reset timestamps,
reset-credit details, account identifiers, email addresses, authentication
paths, or tokens.

## Contact

Privacy questions may be sent to <info@filamentlabs.io>.
