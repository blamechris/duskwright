# ADR 0007 — Where the override sheet lives

- **Status:** Proposed
- **Date:** 2026-08-03
- **Removes:** ADR 0001 item 12 (node insertion into page DOM)
- **Relates to:** epic E2, issues #20, #21
- **Corrects:** `CLAUDE.md`'s "append only, never reassign" rationale — see D1

## Context

`src/inject/dynamic-theme/style-manager.ts` builds one override sheet per page-owned
stylesheet. Upstream gives that sheet a home by putting a `<style>` node into the page:

```js
// style-manager.ts:230
function insertStyle() {
    if (inMode === 'next') {
        if (element.nextSibling !== syncStyle) {
            element.parentNode!.insertBefore(syncStyle!, element.nextSibling);   // <- item 12
        }
    } else if (inMode === 'away') {
        injectStyleAway(syncStyle!);
    }
}
```

`insertBefore` on a page-owned parent is a `childList` mutation. A page `MutationObserver`
watching its own `<head>` sees it. Callers are `:405` and `:527`.

### The `away` mode is not an escape hatch

The audit trail treats `inMode === 'away'` as the alternative path, so it is worth stating
plainly that it is **the same violation somewhere else**. `injectStyleAway` builds a container
and appends it to `<body>`:

```js
// injection.ts:38-44
let container = document.body.querySelector('.darkreader-style-container');
if (!container) {
    container = document.createElement('div');
    container.classList.add('darkreader');
    container.style.display = 'none';
    document.body.append(container);        // childList mutation on page-owned <body>
}
```

Both modes insert nodes into page DOM. `away` also runs a `MutationObserver` on `<body>` that
re-appends the container whenever the page moves it (`:46-61`) — a mutation war of the same
family as issue #21, and it fires on the page's own observers every time it retaliates. There
is no existing mode to fall back to; both have to go.

### Why the node is there at all

The sync style is not merely *somewhere*. It sits immediately after the page sheet it shadows,
so that the cascade order of the overrides mirrors the cascade order of the sheets they came
from. With page sheets `A`, `B` and overrides `A'`, `B'`, upstream produces `A A' B B'`.
`watchForNodePosition` (`:423`) exists to restore that position when the page moves the node.

Any replacement has to answer: **where does the override sheet sit in the cascade, and how is
the relative order among overrides preserved?**

## What was measured

Load-bearing CSS behaviour is asserted against real Chromium, never a model of it (the lesson
from ADR 0006's review). Everything below was measured in the repo's own Playwright Chromium.

### M1 — adopted sheets sort after every document sheet

An adopted sheet at equal specificity beat a `<style>` appended to `<head>` *after* it:

| competitors | winner |
|---|---|
| adopted `p{color:blue}` vs later document `<style> p{color:green}` | **blue** (adopted) |

So moving overrides into `document.adoptedStyleSheets` changes `A A' B B'` into `A B A' B'`.
This is the ordering question issue #20 flagged, and M2 is what resolves it.

### M2 — ordering inside `adoptedStyleSheets` is positional, and `splice` respects it

| operation | computed colour | expected |
|---|---|---|
| push `rgb(1,1,1)`, push `rgb(2,2,2)` | `rgb(2,2,2)` | last wins |
| `splice(1, 0, rgb(3,3,3))` | `rgb(2,2,2)` | unchanged — 3 landed before 2 |
| `splice(2, 0, rgb(4,4,4))` | `rgb(2,2,2)` | unchanged |
| push `rgb(5,5,5)` | `rgb(5,5,5)` | last wins |

Mid-array `splice` does not throw, does not disturb the precedence of later entries, and does
not detach a reference the page is holding. **Full ordering control is available without ever
reassigning the array.**

### M3 — reassignment is dangerous, but not for the reason the fixture states

`tests/fixtures/pages/adopted-stylesheets.html` says:

> The page keeps a live reference. If anything reassigns the array, this detaches.

It does not detach. Measured:

| after `document.adoptedStyleSheets = [otherSheet]` | result |
|---|---|
| `heldRef === document.adoptedStyleSheets` | **`true`** — identity is stable |
| page's own sheet still present | **`false`** — dropped |
| held reference also lost it | **`true`** |

`document.adoptedStyleSheets` reports `constructor.name === 'Array'`; Chromium updates the
existing backing store in place rather than swapping it. So the identity check the fixture
documents would pass while the page's stylesheets were being thrown away. The *conclusion*
"never reassign" is right; the stated mechanism is not, and the fixture's `__pageSheetCount`
is the half that actually detects anything. Filed as #97 — see D5.

## Decisions

### D1 — Overrides move to `document.adoptedStyleSheets`; no node enters page DOM

`insertStyle()` and `injectStyleAway()` both go. No `<style>` node, no container `<div>`, no
`<body>` append.

`CLAUDE.md` already sanctions this ("Appending **our own** `CSSStyleSheet` to
`document.adoptedStyleSheets` — append only, never reassign the array"). Per M3, the reason
behind "never reassign" is that reassignment **drops the page's own sheets**, not that it
detaches a held reference. The rule stands unchanged; only its rationale is corrected.

Consequences that fall out for free:

- `watchForNodePosition` on the sync style disappears. There is no node for the page to move,
  so the watcher that fought over its position — and mutated page DOM to win — is unnecessary.
- The `hostsBreakingOnStylePosition` list in `injection.ts` becomes empty of purpose. Those
  eight hosts break *on style position*; with no style node in their DOM there is no position
  to break on. Do not delete the list in the same PR — see D4.

### D2 — One override sheet per document/shadow root, ordered internally

The alternative was one constructed sheet per page sheet, appended in discovery order. Rejected:
append-only ordering is only correct while page sheets are discovered in document order, and a
page may insert a `<style>` *before* an existing one at any time. Recovering from that needs a
mid-array `splice`, which M2 shows is available but which `CLAUDE.md`'s append-only rule does
not sanction — and widening that rule to buy ordering we can get another way is a bad trade.

Instead: **one `CSSStyleSheet` we construct, appended exactly once** per `DocumentOrShadowRoot`.
Each page sheet's overrides occupy a contiguous rule range inside it, and ordering among ranges
is maintained with `insertRule(text, index)` on a sheet we own. `adoptedStyleSheets` is touched
once, with a push, for the life of the root.

This keeps the cascade contract precise: `A B [A' B']`. Relative order among overrides is
preserved, and every override sits after every page sheet — which is what a theming engine
wants anyway, since it means an override never loses a same-specificity fight to the page.

The cost is honest: rule-index bookkeeping as ranges grow and shrink. That complexity lives in
our module under normal standards, not in an upstream file.

### D3 — The one behaviour change, stated rather than discovered later

`A A' B B'` becoming `A B [A' B']` changes exactly one case: a declaration in page sheet `B`
that the engine **did not** produce an override for, competing at equal specificity with a
declaration in `A` that it **did**. Upstream paints `B`'s value; this design paints `A'`'s.

The engine emits an override for every colour-ish declaration it can modify, so this needs a
declaration it *refused* — the deferred set in ADR 0006 (`var()` values, inline `!important`,
geometry-dependent SVG fills). Narrow, but real, and a fixture must pin it rather than leave it
to be found on a site.

### D4 — `hostsBreakingOnStylePosition` is emptied in a separate PR

The eight-host list is upstream's, and E9 syncs upstream. Deleting it in the same PR as the
engine change mixes a behavioural rewrite with a catalog-shaped deletion and makes both harder
to review and to merge. Land the placement change first, with the list inert; remove it after
the purity corpus is green on those hosts' shapes.

### D5 — The fixture's detector gets fixed, tracked separately

`adopted-stylesheets.html` documents a reference-identity check that M3 shows does not detect
reassignment. It should assert on sheet *membership and count* instead. Not folded into this
work: it is a test-harness correctness bug that predates it and stands on its own.

## Acceptance criteria

- [ ] No `insertBefore`, `append`, or `appendChild` targeting a page-owned parent remains in
      `style-manager.ts` or `injection.ts`
- [ ] `tests/purity/` stays green with an **empty** `known-violations.json` — no new baseline
      entries, no exclusions
- [ ] `adopted-stylesheets.html` passes: our sheet is appended, the page's held reference still
      contains the page's own sheet, and the array is never reassigned
- [ ] A fixture pins D3's ordering change: two page sheets, the later one carrying a declaration
      the engine refuses, asserting the painted result deliberately
- [ ] Theming fidelity holds — `inline-theming.spec.ts`'s counterpart for sheet-level overrides.
      Zero mutations is trivially achievable by theming nothing; both suites must be green
- [ ] `watchForNodePosition` is no longer called for the sync style, and nothing replaces it

## Risks

| # | Risk | Detector |
|---|---|---|
| 1 | D3's reordering changes a real site's paint in a way no fixture models | The deliberate fixture in the acceptance criteria; then the E7 site pass |
| 2 | Rule-index bookkeeping drifts as ranges are inserted and removed, silently reordering overrides | Unit tests over the range table, asserting index arithmetic directly rather than through the browser |
| 3 | A shadow root's adopted array is reassigned by the page, dropping our sheet with it | Re-append on detection; a fixture that reassigns a shadow root's array and asserts theming recovers |
| 4 | `@import`-resolved and CORS-fallback sheets arrive after discovery and land in the wrong range | Fixture with an `@import` chain, asserting range order after resolution |
