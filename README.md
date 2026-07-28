# Codex Usage and Resets

[![CI](https://github.com/joelfarthing/codex-usage-and-resets/actions/workflows/ci.yml/badge.svg)](https://github.com/joelfarthing/codex-usage-and-resets/actions/workflows/ci.yml)
[![HOL Plugin Scanner](https://github.com/joelfarthing/codex-usage-and-resets/actions/workflows/hol-plugin-scanner.yml/badge.svg)](https://github.com/joelfarthing/codex-usage-and-resets/actions/workflows/hol-plugin-scanner.yml)

Codex Usage and Resets (CUAR) is a read-only Codex plugin from Filament Labs.
It turns the current Codex weekly usage window and banked reset inventory into
deterministic capacity-planning facts:

- banked reset count and returned expiration details;
- used and remaining weekly capacity;
- the whole-percentage precision limit, including an imminent-exhaustion
  warning when the reported remainder reaches 1%;
- pace above, below, or approximately at linear usage; and
- projected exhaustion when the current average burn would exhaust capacity
  before the active reset.

CUAR uses the documented local Codex App Server
`account/rateLimits/read` method. It does not read Codex authentication files,
inspect session logs, call private ChatGPT endpoints, start a thread or model
turn, consume a reset, or write persistent usage state.

## Requirements

- Node.js 18 or newer
- a compatible local `codex` executable
- ChatGPT-backed Codex authentication
- a Codex client able to run local plugin skills

The same packaged skill and CLI are intended for Codex in the ChatGPT desktop
app, the Codex VS Code extension, and Codex CLI.

## Use

Invoke `$cuar` or ask Codex about current Codex usage, linear pace, projected
exhaustion, or banked reset expirations. CUAR's machine report is
deterministic; the model explains the planning consequence without
recalculating its fields. OpenAI reports usage in whole percentage points, so
CUAR treats displayed remaining capacity as an upper bound rather than an exact
measurement.

CUAR is independently developed and is not developed, supported, or endorsed
by OpenAI. Current observations and projections do not promise future
unscheduled resets.

## Validation and trust

The public repository runs its portable test suite on macOS and Linux across
supported Node.js versions. A separate
[HOL Guard](https://github.com/hashgraph-online/hol-guard) workflow scans the
plugin on pull requests and `main`, requires a score of at least 80, and fails
on any high-or-critical finding. Both workflows use read-only repository
permissions. They do not receive Marketplace credentials, upload SARIF, or
submit or publish the plugin.

Passing automated checks is reproducible project evidence, not certification,
endorsement, or Marketplace acceptance by OpenAI, HOL, Cisco, or any other
party.

The July 28, 2026 publication-hardening run used HOL Guard
`plugin-scanner` 2.0.1116 and produced:

- `public-marketplace` policy: **PASS**;
- score: **97/100 — A, Excellent**;
- critical, high, medium, and low findings: **zero**;
- HOL runtime verification: **PASS**; and
- Cisco skill scanning: completed with the balanced policy and no elevated
  findings.

The five remaining notices are informational schema differences. HOL currently
scores four absent optional interface URL/screenshot fields as invalid even
though its runtime verifier and the Codex validator accept the manifest; CUAR
does not invent URLs or screenshots. Cisco recommends a per-skill license
field, while Codex skill authoring permits only `name` and `description`
frontmatter. The repository and plugin manifest declare Apache-2.0.

## Privacy, security, and support

See [PRIVACY.md](./PRIVACY.md), [SECURITY.md](./SECURITY.md), and
[SUPPORT.md](./SUPPORT.md).
