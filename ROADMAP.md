# Roadmap

Duskwright is built epic by epic. There is no project board: each epic is a GitHub issue whose
sub-issues carry the work, and this file is the summary. **Status reflects code merged to `main`**,
not design — the design for every epic already exists in [`ARCHITECTURE.md`](ARCHITECTURE.md), and
the live state is always the [issue tracker](https://github.com/blamechris/duskwright/issues).

| Epic | Scope | Status |
|---|---|---|
| [E0 — Repo bootstrap](https://github.com/blamechris/duskwright/issues/1) | Repo creation, CI skeleton, working agreement, issue templates | Done |
| [E1 — Fork ingest](https://github.com/blamechris/duskwright/issues/2) | Import upstream, verify a clean MV3 build, rebrand, strip Firefox/Thunderbird targets, build the fixture corpus | Done |
| [E2 — Purity invariant](https://github.com/blamechris/duskwright/issues/3) | Audit and rewrite the engine's mutation surface; purity harness as a blocking CI gate | **In progress** |
| [E3 — Rule engine](https://github.com/blamechris/duskwright/issues/4) | Rule schema, scope precedence, storage, migrations, export/import | Not started |
| [E4 — Element picker](https://github.com/blamechris/duskwright/issues/5) | Overlay, keyboard traversal, selector generation, iframe coordination | Not started |
| [E5 — Treatment primitives](https://github.com/blamechris/duskwright/issues/6) | Scoped filter, scoped recolor, media counter-filter, exclude | Not started |
| [E6 — Coverage detection](https://github.com/blamechris/duskwright/issues/7) | Luminance sampling, badge states, escalation into the picker | Not started |
| [E7 — Hard-case sites](https://github.com/blamechris/duskwright/issues/8) | Cross-origin sheets, shadow DOM, CSP, canvas apps; per-site fix catalog | Not started |
| [E8 — UI](https://github.com/blamechris/duskwright/issues/9) | Popup, options page, keyboard shortcuts, onboarding | Not started |
| [E9 — Upstream sync](https://github.com/blamechris/duskwright/issues/10) | Scheduled fixes-config pull from upstream with an automated PR | Not started |
| [E10 — Distribution](https://github.com/blamechris/duskwright/issues/11) | Store listing, privacy policy, screenshots, release automation | Not started |

**Non-negotiable ordering: E2 lands before E4 and E5.** Building the picker on an engine that still
mutates page DOM means retrofitting the guarantee later — which is how it would quietly get dropped.

## Where E2 stands

Landed on `main`:

- The inline-style write path emits selectors into extension-owned sheets instead of writing
  `style` attributes ([#17](https://github.com/blamechris/duskwright/issues/17), ADRs 0004–0006)
- Page-authored inline declarations are no longer deleted
  ([#18](https://github.com/blamechris/duskwright/issues/18))
- Marker and state attributes are gone from page-owned elements
  ([#19](https://github.com/blamechris/duskwright/issues/19))
- `adoptedStyleSheets` handling is append-only
  ([#22](https://github.com/blamechris/duskwright/issues/22))
- The purity harness runs as a blocking CI gate with an **empty** known-violations baseline
  ([#23](https://github.com/blamechris/duskwright/issues/23), `tests/purity/`)

Remaining before E2 closes:

- Eliminate node insertion into page DOM ([#20](https://github.com/blamechris/duskwright/issues/20))
- Replace the conflicting-plugin mutation war ([#21](https://github.com/blamechris/duskwright/issues/21))
- The Google Sheets round-trip test ([#24](https://github.com/blamechris/duskwright/issues/24))
- Decide the MAIN-world proxy's fate against the harness ([#25](https://github.com/blamechris/duskwright/issues/25))
