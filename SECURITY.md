# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

Security fixes land on the latest `main` release line. Older major lines are
not maintained.

## Reporting a Vulnerability

Please do **not** open a public issue for security reports.

Report vulnerabilities privately through [GitHub Security
Advisories](https://github.com/Sqhao-O/dsh-intercom/security/advisories/new)
("Report a vulnerability" on the repository's Security tab). This keeps the
details private until a fix is available.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- Affected versions/commit, if known.

You can expect an acknowledgement within a few days. If the report is
accepted, a fix is developed privately and released with credit to the
reporter (unless you prefer to stay anonymous).

## Scope Notes

The intercom broker binds to a unix socket / Windows named pipe (or opt-in
loopback TCP on Windows) under `$DSH_HOME/intercom` with owner-only
permissions (`0700` directory, `0600` runtime files). Findings about
cross-user privilege escalation, spoofed sessions, or broker protocol abuse
(rate limits, framing, mailbox rules) are in scope.
