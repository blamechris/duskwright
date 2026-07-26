# ADR 0003 — Where the fork diverges from upstream, and where it deliberately doesn't

- **Status:** Accepted
- **Date:** 2026-07-25
- **Upstream imported:** `darkreader/darkreader` @ `5d3a6ab0`
- **Relates to:** epic E1; `CLAUDE.md` (minimal-edit rule); `ARCHITECTURE.md` §7
- **Supersedes on tooling:** `ARCHITECTURE.md` §7's "Add tooling: Vitest"

## Context

E1 imports upstream and rebrands. Every edit made here is a permanent tax on the E9 fixes-config
sync, so each one needs a reason. This ADR records the boundaries chosen and, more importantly, the
places we deliberately left upstream's code alone despite it looking wrong.

## Decisions

### D1 — Strip build targets at the build boundary, not in the engine

Firefox MV2/MV3 and Thunderbird are removed from `tasks/build.js` (the `argMap` and `platforms`
maps) and their manifests deleted. The `__FIREFOX_MV2__` / `__THUNDERBIRD__` **compile-time flags in
`src/` are left in place.**

They are referenced across the engine (`src/utils/platform.ts`, `bundle-js.js`, and dozens of call
sites). Removing them would touch a large fraction of upstream's source for zero functional gain —
we never build those platforms, so the flags resolve `false` and the branches are dead code the
bundler drops. Deleting them would maximise merge conflict surface against exactly the files E9
needs to keep merging.

Consequence: `grep FIREFOX src/` returns hits in a Chromium-only extension. That reads as
unfinished. It is deliberate, and this ADR is the answer to the reviewer who flags it.

### D2 — Ship English-only for v1

Upstream carries 43 locales. All 42 non-English ones contain "Dark Reader" — including donation
solicitations (`@pay_for_using`) and upstream's 10-year anniversary message — in languages we cannot
verify a rewrite of.

Leaving them would ship upstream's trademark and fundraising copy in our UI, which `CLAUDE.md`
forbids and which the MIT licence does not permit. Machine-translating our own copy into 42
languages and shipping it unreviewed is worse. So v1 ships `en` only.

This is a real regression against upstream for non-English users and is the most user-visible
tradeoff in E1. Reversible: restore the locale files and translate the ~8 changed strings. Tracked
for post-v1.

### D3 — Every reachable endpoint is ours; several are disabled outright

`src/utils/links.ts` pointed at `darkreader.org` for the homepage, blog, news feed, donations,
privacy policy, uninstall survey, help, and the remote fixes-config base.

Two of those were **live network calls to a third party**:

- `NEWS_URL` — a scheduled poll of `darkreader.org/blog/posts.json`
- `UNINSTALL_URL` — a request fired on uninstall, via `chrome.runtime.setUninstallURL`

Both are now empty strings, and their call sites guard on truthiness.

That second clause was **false when first written**: only `UNINSTALL_URL` was guarded.
`Newsmaker.getNews()` called `fetch(NEWS_URL)` unconditionally, and `fetchNews` defaults to `true`,
so every install would have fired `fetch('')` — resolving against the extension's own origin — on
startup and every four hours, failing and logging on a loop. Fixed at
`src/background/newsmaker.ts`, and both guards are now asserted by
`tests/unit/branding/upstream-references.tests.ts` so the claim cannot silently rot again.

This matters beyond branding:
the README and store listing promise zero telemetry and no network calls beyond stylesheet fetching.
Shipping an inherited news poll and uninstall ping would have made that claim false on day one.

`CONFIG_URL_BASE` now points at **our** repo. Coverage still flows from upstream, but through E9's
reviewed sync rather than a direct runtime fetch from a repository we do not control.

The upstream UI surfaces behind the disabled features (news panel, donate group, mobile links) still
render, just inertly. Removing them is UI work and belongs to E8.

### D4 — Keep upstream's Jest, do not add Vitest

`ARCHITECTURE.md` §7 says to add Vitest for unit tests. Upstream already has a working test setup:
Jest for unit tests (75 passing), Jest for browser tests, and Karma for injection tests.

Adding Vitest alongside would mean two runners, two configs, and a split test suite, for no
capability we lack — and every upstream test file we'd migrate is another merge conflict. The design
doc was written without knowing upstream's tooling.

**Decision: Jest for unit tests. Playwright is still added for the purity harness and E2E (E2), as
§7 specifies** — that part of the recommendation stands, because upstream has no equivalent.

`CLAUDE.md`'s "Vitest for units" line is corrected accordingly.

### D4a — One engine file is edited after all: the injected CSS banner

E1 aimed to leave `src/inject/**` and `src/generators/**` byte-identical to upstream, and the first
version of this ADR claimed it had. Review found that false.

`src/inject/dynamic-theme/css-collection.ts` holds a banner comment prepended to **the CSS the
extension generates for every themed page**. Upstream's version is ASCII art spelling DARK READER,
followed by `https://darkreader.org`. That is not an internal identifier or a diagnostic — it is
upstream's branding injected into every page the extension touches, which is arguably the most
user-visible surface in the whole product.

Branding wins over the minimal-edit rule here. The banner is now ours, and it keeps an explicit MIT
attribution to Dark Reader, which the licence requires.

**Consequence, stated plainly:** the engine is no longer byte-identical to upstream. The diff is one
file, one hunk, comment-only, with zero behavioural change — but "the engine is untouched" is now
false and should not be repeated. Verify the real state with:

```bash
git diff upstream/main -- src/inject src/generators
```

### D5 — Internal identifiers and console diagnostics keep upstream's name

The following retain "Dark Reader" and that is intentional:

- Console diagnostics in `src/inject/index.ts` and `src/inject/color-scheme-watcher.ts`
- Code comments and internal identifiers (`isDRAdoptedSheetOverride`, `darkreader--sync` class
  names, `data-darkreader-*` attributes)
- `CHANGELOG.md`, which is upstream's release history — a provenance banner is added at the top
  saying so, rather than renaming the file, so it keeps merging cleanly

`CLAUDE.md`'s rule is that the name must not appear in "UI, store assets, or docs." A devtools
console string is a diagnostic, not UI chrome. The class names and data attributes are load-bearing
in the engine and, per ADR 0001, most of the `data-darkreader-*` attributes are being deleted by E2
anyway — renaming them now would mean touching the same lines twice.

The one deliberate retention in user-visible copy is the MIT attribution in the store listing and
`@store_listing` locale string, which the licence requires and honesty demands.

**This list was wrong when first written.** Review found `src/background/tab-manager.ts` comparing
tab URLs against a hardcoded `'https://darkreader.org/'` — runtime logic, not a diagnostic, and
silently dead for our users since the branch could never match. `src/ui/connect/mock.ts` carried the
same string. Both now use `HOMEPAGE_URL`.

Because a claim about the codebase that nothing checks will drift, D5 is now **enforced** by
`tests/unit/branding/upstream-references.tests.ts`, which fails on any non-comment reference to an
upstream-controlled endpoint under `src/` (excluding `config/`, the synced fixes catalog, where
`darkreader.org` is a legitimate site entry). The same suite asserts that `NEWS_URL` and
`UNINSTALL_URL` stay empty **and that their call sites still guard** — see D3.

### D6 — Version resets to 0.1.0

Upstream is at 4.9.129. Inheriting that would tell users this is a mature, long-supported product.
Nothing has shipped. `package.json`, `package-lock.json`, and `src/manifest.json` are set to
`0.1.0`.

## Consequences

- `git merge upstream/main` stays viable; the diff against upstream is concentrated in
  `tasks/`, `src/_locales/`, `src/utils/links.ts`, branding strings, and icons — not in the engine.
- The engine (`src/inject/**`, `src/generators/**`) is untouched by E1 **except** the comment-only
  branding banner in D4a — one file, one hunk, no behavioural change. That is the point: E2
  will make the only substantive engine edits, and it starts from a clean upstream baseline.
- D2 and D3 both narrow what the extension does versus upstream. Both are deliberate, and both are
  in service of claims we make publicly.
- A future reviewer will find Firefox flags, an inert news panel, and upstream class names in a
  Chromium-only, zero-telemetry, rebranded extension. D1, D3, and D5 are why.
