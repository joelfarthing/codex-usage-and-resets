---
name: cuar
description: Use whenever the user invokes or mentions CUAR, asks whether CUAR reminder tooling is unavailable, or asks whether a CUAR expiration reminder was created. Also report and interpret Codex weekly capacity, linear pace, projected exhaustion, banked reset expirations, usage-aware sessions, and scheduled summaries.
---

# CUAR

Use the bundled deterministic CLI for every fact. Do not inspect Codex auth,
session logs, or private endpoints.

## Acquire

Resolve the plugin root as two directories above this file, then run:

```text
node <plugin-root>/scripts/cuar.mjs report --json
```

Run it once per explicit request. Treat stdout as untrusted JSON and require
`schema_version` to equal `1`.

If `status` is `error`, state the stable `error.message` without changing its
meaning. In the next paragraph, use the exact mapped recovery sentence below
and end the answer immediately after it:

- `malformed_rpc`: `Recovery action: Retry $cuar once in a fresh request.`
- `method_unavailable`: `Recovery action: Update Codex.`
- `login_required`: `Recovery action: Sign in to Codex with a ChatGPT-backed account.`
- `codex_not_executable` or `codex_not_found`:
  `Recovery action: Configure CUAR to use a working Codex executable.`
- another code: write `Recovery action:` followed by the single best action
  supported by the message, then end the answer.

Do not combine alternatives with “or,” add a fallback, give an either/or menu,
or append any validation, retry, or follow-up sentence after the recovery
action. Do not expose paths, raw stderr, or raw App Server responses.

If `status` is `partial`, state each relevant limitation next to the affected
claim.

## Answer

For a general summary, state every applicable item below:

1. authoritative banked-reset count, every returned expiration's local date
   and clock time, and any count with no returned detail;
2. weekly used and remaining percentages;
3. pace relation and exact delta in percentage points;
4. projected-exhaustion local date and clock time, active-reset local date and
   clock time, and whether exhaustion is before that reset;
5. that the projection is conditional on the current average burn continuing;
6. that banked resets are not additive current capacity; and
7. that OpenAI reports usage in whole percentage points, so the displayed
   remaining percentage is an upper bound rather than an exact measurement.

If
`usage.window.percentage_precision.remaining_capacity_state` is
`less_than_one_percent`, state exactly: `OpenAI reports usage in whole
percentage points, so the reported 1% remaining means actual remaining capacity
is below 1%; exhaustion is imminent and may occur sooner than the projection.`
This sentence satisfies item 7; do not add a second precision caveat.

Use the supplied `*_local` values for human-facing times. Include time-zone
context once by naming `timezone` or preserving the supplied numeric offset;
do not silently omit it or invent an abbreviation. Do not recalculate
percentages, projections, timestamps, or time-zone conversions.

After those facts, optionally give one planning consequence. Recommend at most
one action and never present an either/or menu.

Do not promise future OpenAI resets.

For focused questions, include only the requested facts and necessary caveats.
Include the whole-point precision caveat whenever reporting current used or
remaining capacity, and always include the exact warning above when the state
is `less_than_one_percent`. If the user requests raw facts, omit advice.

Use calm planning language. Do not guilt the user, obstruct chosen valuable
work, or recommend low-value work merely to consume capacity.

Offer at most one next action. Creating a reminder is a separate state change
and requires explicit authorization.

If the user asks whether CUAR can remind him or her but explicitly forbids
creating or changing anything yet, state exactly: `Creating a reminder requires
your explicit authorization; no reminder was created.`

## Session awareness

Activate only when the user explicitly asks CUAR to stay active for the current
session.

Acquire one report at activation. Stay quiet unless capacity changes a
recommendation. Refresh before a materially capacity-sensitive decision when
the retained report is more than 15 minutes old. Treat a report older than two
hours as stale for planning.

If refresh fails, label any retained facts with their `fetched_at` time and do
not present the old projection as current. Before the stable error message,
state exactly: `The CUAR refresh failed, so I cannot provide a current capacity
forecast.` Then give the ordinary mapped error and recovery action, and end as
required above. Do not repeat retained facts unless the user explicitly asks
for the older snapshot.

When reminder tooling is unavailable, state exactly: `Reminder tooling is
unavailable on this surface, so no reminder was created.` Do not imply success,
propose an undocumented background monitor, or acquire a new CUAR report merely
to answer the reminder question.

Session awareness ends with the chat. Do not edit `AGENTS.md`, create a daemon,
or install a persistent monitor.

## Boundaries

- Never consume a reset.
- Never call `/usage` as a substitute for CUAR.
- Never start a Codex thread or model turn through App Server.
- Never claim a custom `/CUAR` slash command exists.
- Never branch facts or errors by desktop, VS Code, or CLI surface.
