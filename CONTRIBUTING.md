# Contributing

CUAR is a small, read-only Codex plugin. Contributions should preserve its
deterministic report contract and avoid adding authentication handling,
private-endpoint fallbacks, session-log inspection, reset consumption, or
persistent monitoring.

## Development

Requirements:

- Node.js 18 or newer
- Python 3 for deterministic ZIP packaging

Run the complete portable test suite:

```text
npm test
```

Build a deterministic, allowlisted package:

```text
npm run package:release-candidate
```

Never include live account values, credentials, local paths, raw App Server
responses, or private test evidence in a contribution.
