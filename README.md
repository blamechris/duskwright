# Duskwright

Dark mode for Chrome that **never writes to the page**. A fork of
[Dark Reader](https://github.com/darkreader/darkreader) adding an element picker, per-scope rules,
and a CI-enforced non-destructiveness guarantee.

[![CI](https://github.com/blamechris/duskwright/actions/workflows/ci.yml/badge.svg)](https://github.com/blamechris/duskwright/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status: early development.** Nothing is shipping yet. The non-destructiveness guarantee and its
> CI gate are the work happening now (E2); the element picker and per-scope rules come after it.
> [`ROADMAP.md`](ROADMAP.md) tracks all eleven epics.

![Side-by-side comparison of a contenteditable editor fixture: extension off on the left showing a light page, extension on on the right showing the same page themed dark. Below each, the editor's serialized document model is printed, and the two serializations are identical.](docs/assets/purity-before-after.png)

*The guarantee in one picture: a `contenteditable` editor fixture — the Google Docs failure shape —
with Duskwright off (left) and on (right). The page renders dark, but the editor's serialized
document model is byte-identical in both runs (same SHA-256), because theming never touches anything
the page could capture into your document. Fixture, build, and hashes are recorded in
[the provenance note](docs/assets/purity-proof.txt) (raw captures:
[extension off](docs/assets/purity-extension-off.png),
[extension on](docs/assets/purity-extension-on.png)).*

## What makes it different

Duskwright is a fork of [Dark Reader](https://github.com/darkreader/darkreader) (MIT). Dark Reader's
engine is excellent and represents years of accumulated edge cases — rewriting it would be
reconstructing a solved problem badly. Duskwright adds three things upstream lacks.

### 1. It cannot damage your documents

Most dark-mode extensions recolor text by writing into each element's `style` attribute. On an app
that serializes inline styles into its own document model — Google Sheets, Google Docs, any rich
text editor — that theming becomes **part of your document**. Turn the extension off and the sheet
has white text on white. Share it with a colleague and it is broken for them too.

Duskwright's theming lives entirely in a user-side layer the page cannot observe or serialize. We
call this the **purity invariant**, and it is enforced by a Playwright suite that blocks CI: for
every fixture page, the page's serialized HTML, its stylesheet text, and a MutationObserver log
recorded from before the extension ran must all come back clean. The suite's known-violations
baseline is **empty** — every fixture in the corpus runs with zero observable mutations of
page-owned DOM, and any regression fails the build.

It is a guarantee, not a promise. The invariant is stated in [`ARCHITECTURE.md`](ARCHITECTURE.md) §2;
what the forked engine actually does today, and what has to change to get there, is inventoried in
[ADR 0001](docs/adr/0001-upstream-purity-audit.md). Where auditing the real source contradicted the
design doc, [ADR 0002](docs/adr/0002-architecture-doc-corrections.md) records the correction rather
than quietly resolving it. The remaining E2 work is listed in [`ROADMAP.md`](ROADMAP.md).

See the [purity demo](#duskwright) at the top of this README — the editor's document model is
byte-identical with the extension on and off.

### 2. It tells you when it didn't work

**Not built yet — this is epic E6.** Every dark-mode extension fails on some sites. Duskwright will
measure whether theming actually landed — sampling the rendered result for how much of the viewport
is still light — and flag pages it only partially themed instead of failing silently.

### 3. You can fix it yourself

**Not built yet — this is epics E3 and E4.** A devtools-style element picker will let you point at a
region and darken it by hand, with a live preview. Rules will persist per origin, path prefix, exact
URL, or pattern. This is the only mechanism that can ever work on canvas-rendered apps like Google
Docs and Figma, where there is no DOM text to recolor and no DOM-based engine can help.

## What works today

- A clean Chromium MV3 build from a fresh clone.
- A ~30-page fixture corpus (`tests/fixtures/`) covering the shapes that break dark-mode
  extensions: contenteditable editors, adopted stylesheets, canvas-rendered apps, and more.
- The purity harness (`tests/purity/`) as a blocking CI gate, asserting zero observable mutations
  of page-owned DOM against an empty violations baseline.
- The engine's inline-style write path rewritten to emit selectors into extension-owned sheets
  instead of writing `style` attributes (ADRs 0004–0006).

Everything else on the tin — picker, rules, coverage detection, UI — is designed but not built.

## Building

```bash
npm ci
npm run build
```

Then load `build/release/chrome-mv3` as an unpacked extension at `chrome://extensions` with
Developer Mode enabled.

```bash
npm test              # unit tests (Jest)
npm run test:purity   # the purity harness — the blocking gate
npm run test:e2e      # end-to-end tests
npm run lint          # ESLint
```

Chrome/Chromium (Manifest V3) only. Firefox and Safari are out of scope.

## Privacy

Zero telemetry. No analytics, no accounts, no network calls beyond the stylesheet fetching the
engine already needs to theme a page. The extension requires broad host permissions because a
dark-mode extension that works everywhere realistically needs them — the counterweight is that it
phones nowhere, and you can verify that in this repository.

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the design of record.
- [`docs/adr/`](docs/adr/) — architecture decisions. Where an ADR and the design doc disagree,
  the ADR wins.
- [`ROADMAP.md`](ROADMAP.md) — epics E0–E10, what is done, and what is next.
- [`CHANGELOG.md`](CHANGELOG.md) — the upstream engine's release history, retained for clean
  syncs. Duskwright itself has not made a release yet.

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md); the working agreement — including the purity
invariant in full and the minimal-edit rule for upstream-derived files — is in
[`CLAUDE.md`](CLAUDE.md). Security reports go through
[private vulnerability reporting](SECURITY.md), never public issues.

## License and attribution

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

This project is a fork of [Dark Reader](https://github.com/darkreader/darkreader), copyright
Dark Reader Ltd., used under the MIT License. It is not affiliated with or endorsed by Dark Reader
Ltd. The code is MIT; the trademark is not, so the Dark Reader name and logo appear nowhere in this
project's branding.

Generic engine improvements are proposed back upstream where they apply.
