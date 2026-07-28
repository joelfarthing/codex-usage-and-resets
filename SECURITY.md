# Security

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email
<info@filamentlabs.io> with the affected CUAR version, operating system,
reproduction steps, and potential impact. Do not include credentials, tokens,
raw App Server responses, or account-specific usage data.

## Trust boundaries

CUAR runs as local code with the same operating-system account and execution
constraints as Codex. It is not a privilege boundary.

The normal runtime resolves `codex` through the inherited `PATH`, starts
`codex app-server --stdio` without a shell, initializes the stable protocol,
and sends only `account/rateLimits/read`. It does not send thread, turn, login,
logout, write, nudge, or reset-consumption methods.

`CUAR_CODEX_BIN` is an explicit support-and-test override. Setting it delegates
the same trust to that absolute executable path, so users should not point it
to untrusted code.

`CUAR_TEST_MODE=1` enables the fixture-only `CUAR_TEST_FETCHED_AT` clock
override. These variables can deliberately make a report non-current and must
not be enabled for ordinary use. CUAR's bundled skill never sets them.

App Server stdout is treated as untrusted structured input. JSONL lines,
stderr, timeouts, response envelopes, and child cleanup are bounded. Raw
responses and operating-system errors are not copied into public CUAR output.

## Operational limitations

- A malicious process already running as the same user can alter executables,
  environment variables, or local Codex state.
- CUAR projections assume the current average burn continues; they are
  planning estimates, not guarantees.
- OpenAI may change supported App Server behavior independently of CUAR.
- The initial release targets local Codex surfaces with Node.js and shell
  execution available; it does not claim ChatGPT web-only support.
