# Privacy Policy

Last updated: July 28, 2026

## Local processing

CUAR runs on the user's machine. It starts the user's local Codex App Server
and performs one read-only `account/rateLimits/read` request when invoked.
Normalization, pace calculations, projections, and time-zone conversion happen
locally.

CUAR does not operate a hosted usage service, send telemetry to Filament Labs,
read Codex authentication files, inspect session logs, or persist usage
snapshots, reset-credit details, account identifiers, or raw App Server
responses.

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
