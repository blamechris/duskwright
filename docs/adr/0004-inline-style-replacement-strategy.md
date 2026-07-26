# ADR 0004 — Replacing the inline-style write path: declaration keys, not per-element selectors

- **Status:** Accepted (mechanism); five product questions open — see the end
- **Date:** 2026-07-26
- **Supersedes:** ADR 0001 decision 2; corrects `ARCHITECTURE.md` §2's framing of the container filter
- **Relates to:** epic E2, issues #17–#21, #24, #25

## Context

ADR 0001 catalogued fourteen page-DOM mutations and prescribed the replacement for the worst of
them (items 1–4, the P0 Google Sheets failure) in decision 2:

> The replacement for items 1–4 is **one** selector-emission engine shared with the picker.
> Generate a structural CSS selector per inline-styled element and emit a rule into our own sheet.

That was written from reading the source, not from measuring it. Measuring it disqualifies it.

## The measurement that decides this

### 1. Per-element structural selectors are O(M²) to match

Blink indexes CSS rules by the **rightmost compound selector**. A selector Duskwright may legally
emit must end in a tag or a page-authored class — adding an id or class to escape the bucket is
exactly the mutation the invariant forbids. So every rule we emit lands in **one bucket**, and every
candidate element tests **every rule**.

Measured, 140 fresh elements rendered with N rules adopted:

| N rules | `#grid > div:nth-child(k) > div:nth-child(j)` | `#dw-{i}` (unique id) |
|---|---|---|
| 1,000 | 3.3 ms | 0.3 ms |
| 5,000 | 15.0 ms | 0.3 ms |
| 20,000 | **57.6 ms** | 0.3 ms |

The unique-id arm is flat. That arm is unavailable to us by construction.

Cost per (element × colliding rule): **22.4 ns** unthrottled, **96.9 ns** at 4× CPU throttle.
Against `ARCHITECTURE.md` §9's 100 ms budget the crossover is **M ≈ 2,112** unthrottled,
**≈ 1,016** throttled — and it is paid on *every* full style pass, not once.

### 2. The finding that actually settles it: we would tax the page's own DOM operations

With 2,000 per-element structural rules adopted, a single `insertBefore` **by the page itself**:

| | median |
|---|---|
| baseline | 1.7 ms |
| with 2,000 per-element structural rules | **92.3 ms** |
| with one container filter | 1.7 ms |

**A 54× tax on the application we are supposed to be decorating.** Reproduced **three times
independently**, on separate benchmark harnesses written without reference to each other: 47×, 42×,
and 54.3×. The spread is machine noise; the order of magnitude is not. Reproduce it with
`tests/fixtures/pages/dense-inline-styles.html`: adopt N per-element structural rules, then time a
single `insertBefore` by the page.

**The purity harness cannot see this.** It is not a DOM mutation, so no `MutationRecord` fires; no
serialized state changes; no stylesheet the page owns is touched. `tests/purity/ownership.ts`
classifies it as nothing at all. Yet it is the same *kind* of harm the invariant exists to prevent:
the user opens their spreadsheet and it is unusable, and the cause is us.

This is the fourth time in E2 that a gate turned out not to check the thing that mattered. It is
recorded as a **known limitation of the harness**, not silently absorbed.

## Decision

**Key theming off the inline declaration, not off the element.**

Instead of one rule per element anchored to that element's position, emit one rule per *distinct
declaration string*, matched with an attribute selector anchored at a stable ancestor:

```css
#app [style*="color:#333"] { color: #e8e8ea !important }
```

Elements sharing a declaration share a rule. Rule count becomes the number of **distinct
declarations**, which on real pages is far smaller than the element count. Key derivation measured
at **0.31 µs/element** — an order of magnitude cheaper than the write path it replaces.

Where that does not hold, escalate rather than degrade silently:

| Tier | Mechanism | For |
|---|---|---|
| 1 | Anchored declaration keys | The default. Covers 8 of the 9 currently-violating fixtures at full dynamic-theme fidelity |
| 2 | Presentational attribute keys (`bgcolor`, `color`, `background`) | Legacy attributes |
| 3 | Per-element structural selectors, **hard-capped at 64 elements** | The four declaration shapes that provably cannot be keyed: `var()` values, SVG `fill` needing geometry, duplicate properties in one attribute, `background-image: url()` on `<html>`/`<body>` |
| 4 | Scoped container filter | Regions whose key table blows the budget. O(1), and measured to cost the page nothing |

ADR 0001's prescription survives only as **tier 3, capped** — because the `insertBefore` tax makes
it actively harmful at scale, not merely slow.

### Corrections this forces

- **ADR 0001 decision 2 is superseded.** Its *intent* — one selector engine shared with E4's
  picker — stands, and that engine **will live** at `src/rules/selector/` (it does not exist yet;
  step 3 creates it). Its *default mechanism* does not survive.
- **`ARCHITECTURE.md` §2 frames the container filter as what you fall back to "where per-element
  selector emission is too costly."** That has it backwards for dense regions: the filter is the
  only mechanism measured to cost the page nothing, and per-element emission is the one that
  degrades the page. The filter is an escalation tier, not a consolation prize.
- **`known-violations.json` currently hides a harness weakness.** `purity.spec.ts` skips the
  byte-identity assertion whenever a fixture has any baseline entry — and all 32 fixtures carry the
  same four generic entries (items 7, 8, 9, 10). **128 of 169 baseline entries are those four.**
  Until they die, every fixture is validated by one assertion out of three. That makes items 7–10
  the *first* implementation step, not a mopping-up exercise.

## Implementation order

Each step is independently landable and shrinks `known-violations.json`.

| Step | Work | Baseline entries removed |
|---|---|---|
| 0 | Items 7, 8, 9, 10 — the four generic violations on `<html>` and the `<meta>` lock | **128 of 169** — and turns the byte-identity assertion *on* for 23 fixtures |
| 1 | `src/purity/sheet.ts`, sheet ownership. Ships with a harness extension so shadow roots are actually observed | 0, unblocks everything |
| 2 | Tiers 1 + 2 — items 1, 2, 3, 4, 5 | ~22 across 6 fixtures |
| 3 | Tier 3 + `src/rules/selector/` — item 6 | ~12 across 2 fixtures |
| 4 | Budget, regions, `@scope`, eviction, Tier 4 filter | the last ~4 |
| 5 | Residue: item 12 (needs a `style-in-body.html` fixture), item 13 | — |

Step 2's acceptance test is `contenteditable-editor.html`: its
`added <#text>; removed <#text> under page-owned <pre#serialized>` entry goes to zero *by
construction*, because keying off `getAttribute('style')` never touches the element, so the
editor's own `serialize()` never fires. That entry is the Google Docs failure shape, and its
disappearance is the single best evidence this design works.

## What this does not solve

- **Item 12** (`style-manager.ts:230-238`) survives steps 0–4, and the corpus is currently blind to
  it: `ownership.ts` permits `<head>`, and the harness strips our nodes before serializing. A page
  `<style>` in `<body>` makes it live. Needs a fixture.
- **Item 13** (`disableConflictingPlugins`) is untouched — a deliberate upstream feature; removing
  it is a product tradeoff.
- **Seven `<style class="darkreader">` elements** in `createStaticStyleOverrides` stay. They are
  harness-legal and encode cascade precedence as sibling order, but they contradict `CLAUDE.md`'s
  "**a single** injected `<style id="duskwright-theme">`". That contradiction needs its own ADR
  rather than a quiet exception.
- **Colour fidelity inside tier-4 regions is degraded** in a way the proposals understated: a
  container boundary is a visible seam between two different blacks, and Chromium drops subpixel
  antialiasing inside a filtered subtree.
- **Tier 4's raster cost is unmeasured.** Every filter number in evidence was taken with paint
  effectively disabled — headless Chromium was confirmed paint-blind (102.1 vs 100.3 fps with and
  without a full-page filter). **This must be measured headful with GPU raster before step 4 is
  designed**, not after.
- **The corpus still cannot discriminate on throughput.** Median 0 inline-styled elements, p90 5.
  `dense-inline-styles.html` is a synthetic proxy; real-site measurement is not optional.

## Risks

| # | Risk | Detector |
|---|---|---|
| 1 | Tier 4's raster cost unmeasured; if the filter is expensive, step 4's answer is wrong | Headful Chrome, GPU raster, real frame-timing trace — **before** step 4 |
| 2 | Key explosion on unseen real sites (syntax highlighters, heatmaps, chart libraries). `dense-inline-styles.html` dedups only 3.2% — 1,936 keys over 2,000 elements | Real-site smoke list through the key deriver, offline |
| 3 | The budget caps key *count*, not key *arrival rate* — a page adding one novel declaration per frame pays a style flush per key while under any count cap | New fixture `key-arrival-rate.html` with a frame-p95 assertion |
| 4 | Anchored-key correctness bugs are silent partial theming: a trailing `;` breaks `$=`, plus whitespace, case, `!important`, and quote escaping | `tests/unit/purity/keys.test.ts` — all cheap, no excuse for shipping without them |
| 5 | `@scope` + eviction un-theme elements *outside* a filtered region sharing a declaration with one inside | `scoped-region-shared-key.html` |

## Open questions — product-shaped, for the maintainer

1. **Chrome floor.** `@scope` needs Chrome 118; the manifest says 106. Bump, or let tier 4 degrade
   to eviction-only? Recommend bumping — 118 is Oct 2023 and this is Chromium-only.
2. **What does a user see when a region escalates to tier 4?** A visible tone seam and softer text
   everywhere in that region — or leave it un-themed, badge it, and let the user aim the picker.
   Degraded colour vs honest failure.
3. **Item 13** — drop the mutation war for a conflicting-plugin banner, accepting that Duskwright
   loses to the WordPress plugin on those sites?
4. **Editing surfaces.** Proposed: tiers 1–3 allowed on `contenteditable` (they write nothing, and
   that fixture is the best proof the design works), tier 4 never. The stricter reading of
   `CLAUDE.md` is that we should not theme editing surfaces at all.
5. **The MAIN-world proxy (#25).** Step 0 removes its DOM write, but it stays detectable through
   the wrapped `adoptedStyleSheets` getter. Keep or drop?
