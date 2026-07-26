# ADR 0001 — Upstream purity audit: every page-DOM mutation in the forked engine

- **Status:** Accepted
- **Date:** 2026-07-25
- **Upstream audited:** `darkreader/darkreader` @ `9e71d744`
- **Relates to:** `ARCHITECTURE.md` §2 (Purity Invariant), epic E2
- **Supersedes on this topic:** `ARCHITECTURE.md` §2's characterisation of `inline-style.ts`

## Context

`ARCHITECTURE.md` §2 states the Purity Invariant:

> The extension must never produce a mutation of the page DOM that the page's own JavaScript can
> observe as a change to its own content or serialize into its document model.

It also predicts that upstream violates this "notably in `inline-style.ts`, which handles
`style="color: …"` elements by attaching override classes," and flags rewriting that surface as the
largest epic.

The prediction is directionally right and specifically wrong. `inline-style.ts` is indeed the worst
offender, but it does **not** attach override classes. It writes directly into each element's
`style` attribute. That is a strictly harder problem, because the `style` attribute is the single
most commonly serialized piece of per-element state in the DOM — it is exactly what Google Sheets,
Google Docs, and every `contenteditable` editor round-trip into their document model. The design
doc's mental model would have led us to a fix (stop adding classes) that does not address the actual
failure.

This ADR is the honest inventory the invariant needs before E2 can be scoped.

## Method

Static sweep of `src/inject/` for the operations §2 forbids — inline-style writes, class and
attribute writes, page-owned `CSSStyleSheet` mutation, and node insertion outside a shadow root we
own — followed by reading each hit in context to classify it. Sites that operate on elements the
extension itself created (`document.createElement('style')` and friends) are **not** violations and
are called out as such, so the epic is not padded with false positives.

## Inventory

Severity: **P0** = serializable into the page's document model (the Google Sheets failure).
**P1** = observable by page JS (MutationObserver / attribute read) but not normally serialized.
**P2** = destructive to page-owned state.

### P0 — writes into page-owned `style` attributes

| # | Site | What it does |
|---|---|---|
| 1 | `src/inject/dynamic-theme/inline-style.ts:412` | `element.style.setProperty(customProp, value)` — writes a `--darkreader-inline-*` custom property into a page element's inline style |
| 2 | `src/inject/dynamic-theme/inline-style.ts:428` | `element.style.setProperty(property, value)` — writes resolved CSS variable declarations into the page element's inline style |
| 3 | `src/inject/dynamic-theme/inline-style.ts:424` | `element.style.removeProperty(property)` — removes previously written declarations (same attribute, still a write) |

These are the invariant's core failure. After theming, `element.getAttribute('style')` on a page
element returns page-authored declarations **plus** ours. Any application that serializes inline
style — `outerHTML`, a `contenteditable` editor's model sync, a spreadsheet's cell-format
round-trip — captures our theme values as if the user had authored them.

**Replacement:** emit a structural CSS selector for the element into *our own* constructed
`CSSStyleSheet` instead of writing to the element. This is the mechanism §2 already mandates for the
picker, generalised: the selector generator (E4) and the inline-style engine share one
implementation. Where per-element selector emission is too costly — long lists, virtualized
tables — fall back to a scoped filter on the nearest stable container, per §2's stated tradeoff.
Never fall back to mutation.

**Cost:** this is the expensive path §2 anticipated. Selector emission per inline-styled element is
strictly more work than upstream's attribute write, and the sites that use inline styles most
heavily are the ones with the most elements. Budget E2 accordingly; treat throughput on the
virtualized-table fixture as an acceptance criterion, not an afterthought.

### P0 — deletes page-authored inline declarations

| # | Site | What it does |
|---|---|---|
| 4 | `src/inject/dynamic-theme/inline-style.ts:612` | `element.style.setProperty(property, '')` — blanks a **page-authored** inline declaration so the override can win |

Worse than the writes above: this is not additive. Disabling the extension does not restore the
declaration, because it is gone from the attribute. This is a plain data-loss bug against the page's
own state and is the clearest single justification for the whole invariant.

**Replacement:** none needed — the rule is deleted, not rewritten. Winning a specificity fight is
done with `!important` in our own sheet, or with a higher-specificity selector. Never by removing
the page's declaration.

### P1 — attribute writes on page-owned elements

| # | Site | What it does |
|---|---|---|
| 5 | `src/inject/dynamic-theme/inline-style.ts:414` | `element.setAttribute(dataAttr, '')` — marker attributes (`data-darkreader-inline-*`) on page elements |
| 6 | `src/inject/dynamic-theme/inline-style.ts:494` | `svg.setAttribute('data-darkreader-inline-invert', '')` on page-owned SVG roots |
| 7 | `src/inject/dynamic-theme/index.ts:753-754` | `documentElement.setAttribute('data-darkreader-mode' / '-scheme', …)` |
| 8 | `src/inject/style.ts:7` | `documentElement.setAttribute('data-darkreader-mode', type)` |
| 9 | `src/inject/dynamic-theme/mv3-proxy.ts` | `document.documentElement.dataset.darkreaderProxyInjected = 'true'` |

`<html>` is page-owned. A site that serializes `documentElement.outerHTML` — or merely observes
attribute mutations on it — sees us.

**Replacement:** the marker attributes (5, 6) disappear with the selector rewrite; they exist only
to give upstream's CSS something to hook. The state flags (7, 8, 9) exist for the extension's own
bookkeeping and for its CSS to key off; move them to module state in the isolated world, and where
CSS genuinely needs a signal, key off a class on **our own** shadow host instead of `<html>`. Item 9
disappears entirely if we drop the MAIN-world proxy (see ADR 0002).

### P1 — transient node insertion into page DOM

| # | Site | What it does |
|---|---|---|
| 10 | `src/inject/dynamic-theme/index.ts:600-606` | Appends `<meta name="darkreader-lock">` to `document.head`, removes it in a microtask |
| 11 | `src/inject/dynamic-theme/index.ts:252` | MV2 path: inserts a `<script class="darkreader--proxy">` into `document.head`, then removes it |
| 12 | `src/inject/dynamic-theme/style-manager.ts:230-238` (`insertStyle()`, the `insertBefore` at `:233`) + `injection.ts` | Inserts `<style class="darkreader--sync">` siblings next to each page-owned `<style>`/`<link>`, in page DOM — **not** inside a shadow root. The element itself is built in `createSyncStyle()` at `:240-250`, which is *not* the violation — construction and class-tagging of our own element is permitted; the page-DOM insertion is the problem |

"Removed in a microtask" is not invisible: a MutationObserver registered by the page fires on both
the insertion and the removal. Item 12 is not transient at all — those nodes live in the page's
`<head>` for the whole session, which contradicts §2's "always inside a shadow root we own."

**Replacement:** 10 and 11 are MV2-era and go away — the lock can be a module-level flag in the
isolated world, and MV3 uses the declared content script rather than script injection. Item 12 is
the structural one: move all generated CSS into constructed stylesheets appended to
`document.adoptedStyleSheets`, keeping the single `<style id="duskwright-theme">` fallback §2 allows
for the CSSOM-unavailable case. This also removes the node-position watchers upstream needs to keep
those siblings ordered.

### P2 — destroys page-owned state

| # | Site | What it does |
|---|---|---|
| 13 | `src/inject/dynamic-theme/index.ts:611-620` | `disableConflictingPlugins()`: removes the `wp-dark-mode-active` **class** and `data-wp-dark-mode-active` **attribute** from `<html>`, dispatches a `CustomEvent` into the page, and re-applies both via a `MutationObserver` whenever the site restores them |

This is the most aggressive site in the codebase. It fights the page for control of the page's own
attributes, in a loop. It is also a deliberate feature (defeating a conflicting WordPress plugin),
so removing it is a product tradeoff, not a pure cleanup.

**Replacement:** win by specificity in our own sheet rather than by deleting the site's state. Where
that genuinely cannot work, the honest answer is the one §3 already builds: report the conflict
through coverage detection and let the user escalate to the picker. A conflicting-plugin banner is
within the invariant; a mutation war is not.

### Not violations — recorded so E2 is not over-scoped

- `index.ts:58-59, 74-75, 845-846`, `style-manager.ts:244-245`, `injection.ts:41-42`,
  `fallback.ts:30-31`, `style.ts:10` — `classList.add('darkreader')` on elements the extension
  **created itself**. Ours to label. The *placement* of some of them is a violation (item 12); the
  class write is not.
- `stylesheet-modifier.ts:208, 331-343, 380-387` and `variables.ts:629-634` — `insertRule` /
  `deleteRule` against the extension's **own** sync sheets, not page-owned sheets.
- `palette.ts:38, 77` — writes into the extension's own variables sheet.
- `adopted-style-manger.ts:133-135` — `insertRule`/`deleteRule` on the extension's own override
  sheet.

### Needs a decision, not a fix — `adoptedStyleSheets` reassignment

| # | Site | What it does |
|---|---|---|
| 14 | `src/inject/dynamic-theme/adopted-style-manger.ts:57, 70` | `node.adoptedStyleSheets = newSheets` — reassigns the array on page-owned document/shadow roots |
| 15 | `src/inject/dynamic-theme/index.ts:657-661` | `root.adoptedStyleSheets.push(sheet)` / `.splice(…)` |

§2 lists appending to `adoptedStyleSheets` as **allowed**, on the grounds that it is additive and
not serializable. That holds for serialization: `outerHTML` does not include adopted sheets. It does
**not** hold for observability — page JS can read `document.adoptedStyleSheets` and enumerate ours.

> ### Correction (2026-07-26): item 14's stated harm does not occur in Chromium
>
> This ADR originally continued: *"item 14 replaces the array wholesale rather than appending, so a
> page holding a reference to the old array sees it detached."* **That is false**, and it was
> reasoned rather than measured.
>
> `adoptedStyleSheets` is an `ObservableArray`. Its setter **writes through** to the same backing
> object rather than swapping it. Measured directly in Chromium with no extension involved:
>
> ```js
> const held = document.adoptedStyleSheets;   // length 1
> document.adoptedStyleSheets = [s1, s2];     // wholesale reassignment
> held.length            // => 2   (still live)
> held === document.adoptedStyleSheets // => true
> ```
>
> So a page holding a reference is **not** detached by reassignment, and item 14 is not the
> violation this audit claimed. It is downgraded from a violation to a **style preference**: append
> -only is still what `ADR 0002 C5` mandates and is still what the code now does, because it is
> obviously safe and costs nothing — but no user-visible harm was being caused, and no baseline
> entry should have existed for it.
>
> **How it was found:** the purity harness grew an assertion for item 14, which failed. Investigating
> the failure showed the assertion was measuring object *identity*, which differs for an unrelated
> reason — the MAIN-world proxy wraps the `adoptedStyleSheets` getter (`stylesheet-proxy.ts:320`),
> so the page's captured reference is the native array while later reads return a `Proxy`. The
> harness assertion now measures **liveness**, which is the property that would actually matter.
>
> That the proxy is detectable at all is real, but it is a *fingerprinting* concern rather than a
> purity violation — a wrapped accessor is neither a DOM mutation nor page content. It is recorded
> as evidence on the open question in ADR 0002 C2 (issue #25), not asserted as a gate.

The invariant's own wording resolves this: it forbids mutations the page can observe *as a change to
its own content or serialize into its document model*. Our sheet is not the page's content. So
appending stays allowed — but **appending only**, never reassigning. See ADR 0002 for the
corresponding correction to §2's rationale, which overstates the case by claiming the operation is
unobservable.

## Decision

1. E2's scope is the fourteen numbered sites above, in severity order: items 1–4 first (they are the
   invariant's reason for existing), then 5–9, then 10–12, then 13.
2. The replacement for items 1–4 is **one** selector-emission engine shared with the picker, not two
   implementations. E2 builds it; E4 consumes it.
3. Item 14's array reassignment becomes append-only. Item 15's pattern is the correct one.
4. The purity harness (§2) must assert on **three** surfaces, not the one §2 describes: serialized
   `outerHTML`, page-owned stylesheet text, **and** a MutationObserver record installed before the
   extension runs. Snapshot-diffing alone cannot catch items 10, 11, and 13, because those mutations
   are reverted before a final snapshot is taken. This is a correction to the harness design, and it
   is the difference between a gate that works and one that passes while the bug ships.

## Consequences

- E2 is larger than `ARCHITECTURE.md` implies, and its riskiest part is throughput, not correctness.
  The selector path is unambiguously the right mechanism; the open question is whether it is fast
  enough on inline-style-heavy pages. That question needs the E1 fixture corpus to answer, which is
  why the kickoff's "build the corpus in E1, not E7" instruction is load-bearing.
- Item 13's removal is a visible behaviour regression against upstream on WordPress sites using that
  plugin. Accepted deliberately, and it is the kind of generic fix worth discussing upstream.
- Dropping the MAIN-world proxy has consequences beyond purity; ADR 0002 covers it.
