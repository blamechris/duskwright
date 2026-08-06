# Security Policy

Duskwright is a browser extension that runs on every page you visit and holds broad host
permissions. A vulnerability here is worth taking seriously, and reports are welcome.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting.** It is the only channel this project supports:

- <https://github.com/blamechris/duskwright/security/advisories/new>
- or: the repository's **Security** tab → **Report a vulnerability**

That keeps the report private between you and the maintainer until a fix is available. Please do
**not** open a public issue, pull request, or discussion for a suspected vulnerability.

This is a single-maintainer project in early development, so there is no formal response SLA.
Expect an acknowledgement within about a week, and a plan — fix, mitigation, or "not a
vulnerability, here is why" — once the report has been reproduced. If a fix ships, the advisory is
published with credit to the reporter unless you ask otherwise.

### Do not report Duskwright issues to Dark Reader

Duskwright is a fork of [Dark Reader](https://github.com/darkreader/darkreader) and shares much of
its engine, but it is a separate project and is not affiliated with, endorsed by, or sponsored by
Dark Reader Ltd. Their maintainers cannot fix anything here, and routing reports to them wastes
everyone's time.

If you have found a vulnerability in **unmodified upstream engine code** that affects Dark Reader
as well, report it to [upstream](https://github.com/darkreader/darkreader/security) too — and
please say so in your report here, so the fix can be coordinated rather than disclosed twice.

## Supported versions

Pre-1.0 and pre-release: nothing is published to the Chrome Web Store yet. Only the current `main`
branch is supported. There are no maintained release branches and no backports.

## What is in scope

Anything that lets a page, another extension, or a network attacker do something Duskwright is
supposed to make impossible. In particular:

- **Any outbound network traffic carrying browsing data.** Duskwright has zero telemetry: no
  analytics, no accounts, no beacons. The only network calls it makes are upstream's existing
  fallback fetches of a page's own stylesheets when CSSOM access is blocked by CORS. A code path
  that sends URLs, page content, user rules, or settings anywhere is a security bug by definition —
  report it, even if it looks like leftover upstream code rather than a live exploit.
- **Escaping the extension's isolation** — a page reading or tampering with extension state, user
  rules, or settings, or anything that lets page-controlled content run with extension privileges.
- **Injection through data we consume** — user rules, imported rule files, the synced upstream
  fixes catalog, or a page-supplied value reaching a sink that executes it.
- **Attacker-controlled breaches of the purity invariant** — forcing a write into page-owned DOM
  that a page can observe or serialize into its own document model.

## What is not a vulnerability

- **A site that themes badly, partially, or not at all.** Expected on hard sites, and handled in
  the open — file it with the *Site not themed well* issue template.
- **A purity violation the extension causes on its own.** It is the most serious class of *bug*
  this project has, but it is not a secret: file it with the *Purity violation* issue template so
  it is visible and gets a regression fixture.
- **The breadth of the host permissions themselves.** A dark-mode extension that works everywhere
  realistically needs them; the counterweight is that it phones nowhere, and you can verify that in
  this repository.

## Handling a report responsibly

Please allow a reasonable window to ship a fix before publishing details, and do not test against
other people's data, accounts, or sites — a local build and a page you control are enough to
demonstrate anything in scope here.
