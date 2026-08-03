# Handoff — E2 inline write path removed

- **Date:** 2026-08-01
- **Boundary reason:** work-class switch. E2's inline path is finished; the next item is a different
  violation in a different file, and needs none of this session's context.
- **Picks up at:** issue #20 — node insertion into page DOM (ADR 0001 item 12)

---

## STATE

| | |
|---|---|
| Branch / HEAD | `main` @ `2aa7ce06` (merge of #85) |
| Working tree | clean |
| CI on `main` | 6/6 green — `hygiene` `lint` `build` `test` `e2e` `purity` |
| Purity baseline | **empty** — `tests/purity/known-violations.json` has `"fixtures": {}` |
| Tests | 268 unit (Jest) · 101 purity + 33 skipped (Playwright) · 0 failed |
| Open PRs | none |
| Open issues | 67 — E2 24, E7 8, E3/E4 6, E5/E6/E8/E10 5, E9 3 |

**Verify before building on any of this** (the Resume protocol says re-derive, don't trust):

```bash
git log --oneline -3 && git status --porcelain
gh pr view 85 --json state --jq .state   # must say MERGED
python3 -c "import json;print(len(json.load(open('tests/purity/known-violations.json'))['fixtures']))"  # must be 0
```

---

## TL;DR — what shipped

The inline write path is gone. Upstream themed an inline-styled element by writing the themed value
into that element's own `style` attribute as a `--darkreader-inline-*` custom property, tagging it
with a `data-darkreader-inline-*` attribute. Both are serializable page state — the Google Sheets
failure. That path is deleted: the element is read and never written, and its declarations are keyed
and matched by selectors in a stylesheet we own.

```
E1 imported the engine                      169 violations
E2 step 0 (ADR 0001 items 7-10)            -128  ->  41
E2 step 2 (ADR 0001 items 1-6)              -41  ->   0
```

With the baseline empty, all 34 fixtures now run the byte-identity assertion (serialized HTML and
page-owned stylesheet text) — ten of them for the first time. `contenteditable-editor.html`, an
editor that copied our writes into its own document model on every mutation, reads zero because
there is nothing to serialize.

PRs: **#73** (ADR 0005 corrections, 3 review rounds) and **#85** (the flip, 2 rounds).

---

## What you need to know to work here next

### The mechanism

```css
[style^="background:#fff;"] {
    --darkreader-inline-bgcolor: initial;
    background-color: var(--darkreader-inline-bgcolor, #1a1c20) !important;
}
```

Three properties have to hold at once:

1. **Anchored** — the matched fragment includes the adjacent `;`, so `color:` cannot match
   `border-color:`. The operator (`=` `^=` `$=` `*=`) is chosen by where the fragment sits in the
   attribute.
2. **Shared** — the rule count is the number of distinct declarations, not elements.
3. **Gated** — the `var()` read is how a per-site catalog fix still reaches exactly the elements we
   themed. The `initial` reset is there because **custom properties inherit and the marker
   attribute did not**; without it a themed `<path>` inside a catalog-targeted `<svg>` takes the
   ancestor's fix colour instead of its own.

### Where things live

| Path | What |
|---|---|
| `src/purity/inline/engine.ts` | The decision layer — element facts, attribute specs, tiering, sheet lifecycle. Ours. |
| `src/purity/inline/emitter.ts` | The reference-counted rule table. `buildCSS()` emits tier 2 before tier 1, and that ordering is a correctness requirement. |
| `src/purity/inline/keys.ts` | Declaration parsing and anchored selector derivation. |
| `src/purity/catalog-markers.ts` | Rewrites the synced fixes catalog so it stops depending on marker attributes. |
| `src/inject/dynamic-theme/inline-style.ts` | Upstream. Now a signature-compatible delegation plus the observers. |
| `tests/purity/inline-theming.spec.ts` | Proves theming still *happens*. |

### The trap this file exists to flag

**Zero mutations is trivially achievable by theming nothing.** An `overrideInlineStyle` that returned
immediately would pass the entire purity corpus with a perfect score. If you change anything in the
inline path, `tests/purity/inline-theming.spec.ts` is the suite that catches "it stopped working",
and `purity.spec.ts` is the one that catches "it started mutating". You need both green; neither
implies the other.

---

## Next: issue #20 — node insertion into page DOM

ADR 0001 item 12. `src/inject/dynamic-theme/style-manager.ts:230` — `insertStyle()`:

```js
element.parentNode!.insertBefore(syncStyle!, element.nextSibling);
```

Inserting our own `<style>` next to a page-owned `<style>` is a `childList` mutation on a
page-owned parent. A page `MutationObserver` watching its own `<head>` sees it. Callers are
`style-manager.ts:405` and `:527`.

Not yet designed. The obvious direction is `document.adoptedStyleSheets` (append only, never
reassign — ADR 0002 C5), but the sync style exists to sit at a specific cascade position relative
to the page's own sheet, and adopted sheets sit after all document sheets. That ordering question
is the actual work; write an ADR before coding.

`adopted-stylesheets.html` is the fixture that holds a live reference to
`document.adoptedStyleSheets` and detects array reassignment.

### Other E2 work, in rough order

| Issue | What | Note |
|---|---|---|
| #20 | Node insertion (item 12) | The last engine-side violation |
| #21 | Conflicting-plugin mutation war (item 13) | Upstream removes other extensions' classes |
| #25 | MAIN-world proxy's fate | Decide against the harness |
| #24 | Google Sheets round-trip | Needs the real app; can't be a fixture |
| #78 | Tier 3 — per-element structural selectors | Unblocks the deferred SVG/image cases |

---

## Accepted losses, counted not hidden

Surfaced through `stats().deferred` so the gap is a number rather than a surprise:

| Case | Why | Issue |
|---|---|---|
| SVG `fill` on non-`<text>` | Modifier depends on measured geometry — one selector would need two answers | #78 |
| Whole-`<svg>` inversion | Per-element async image analysis, and a P1 write | #78 |
| `background-image: url()` | Async; refused before the themer runs, so no image load starts | #78 |
| `var()` values, inline `!important` | Not implied by the text we key on | #79 |

`stats()` has no caller yet — #87.

---

## Left undone, deliberately

**Issue reconciliation.** These are resolved by #85 but still open, because the request in flight was
"run full-review", not "reconcile the backlog":

- Close as done: **#17** (this epic's main issue), **#18**, **#77**, **#82**, **#83**
- Comment only, now latent rather than live: **#80**, **#81** — the presence-test approximation is
  unreachable on the real catalog since all six marker-selecting rules collapse into property sets

**skill-templates#181** — the scheduled-task wave relauncher — is still open upstream. Attended
restarts are unaffected; an unattended one has no relauncher.

---

## Lessons that cost real time

Recorded because each one was found by review after passing every test:

1. **A stub must be at least as strict as the thing it replaces.** Five separate times a test
   exercised a friendlier path than the one that breaks. `createTableExpander` now throws on
   untaught shorthands for exactly this reason.
2. **Load-bearing CSS behaviour is asserted against real Chromium**, never a TypeScript model of it.
   A hand-simulated matcher disagreed with the browser and the test passed while proving nothing.
3. **Fix both halves.** A stale-key bug was closed for tier 2 and left open for tier 1 — in a commit
   whose own message named the consequence.
4. **Substituting a selector *list* into an unknown context is the hazard.** It has produced three
   separate over-application bugs in `catalog-markers.ts`. `:is()` keeps a substitution one
   compound; `:where()` keeps it zero-specificity.
5. **When a doc and the code disagree, the doc is a liability.** ADR 0006 D4 described a collapse
   that was never implemented, and removing a sequencing constant shipped the approximation it was
   supposed to have retired.
