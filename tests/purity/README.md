# The purity harness

The blocking gate. `ARCHITECTURE.md` §2 states the invariant; this suite is what makes it true
rather than aspirational.

```bash
npm run build          # the harness loads build/release/chrome-mv3
npm run test:purity
```

## What it asserts, per fixture

1. **No observable mutation of page-owned DOM** — a `MutationObserver` installed at
   `document_start`, before any page script and before the extension's content script runs.
2. **Page-owned HTML and stylesheet text byte-identical** — against a control run in a clean
   browser. Covers both `document.styleSheets` and `document.adoptedStyleSheets`, which are
   **disjoint collections**: adopted constructed sheets do not appear in `document.styleSheets`.
3. **The page's `adoptedStyleSheets` array is not detached** — ADR 0001 item 14.

None is redundant. The observer catches mutations **reverted before any snapshot** (ADR 0002 C4 —
three of the fourteen sites are exactly that). The stylesheet comparison catches `adoptedStyleSheets`
content changes, which fire **no** `MutationRecord` at all. And the third catches wholesale array
reassignment, which is invisible to *both* of the others: the sheets' contents are unchanged and no
DOM node moved, but any reference the page was holding is now detached.

> An earlier version of this harness read only `document.styleSheets` while this README claimed the
> adopted surface was covered. It wasn't — and adding assertion 3 immediately found a real violation
> the harness had been structurally unable to see. Recorded here because a gate that doesn't check
> what it advertises is the exact thing this suite exists to prevent, and it happened *in the suite
> itself*.

## Ownership is decided by node, never by name

The tempting filter is "ignore anything called `darkreader`". That is precisely backwards:
`data-darkreader-inline-color` on a page's `<td>` is not our property on our element, it is **our
name on their element** — the most common violation in the audit. A name-based filter would hide
all of it.

So: a node is ours only if the extension created it. Everything else — including `<html>`, `<head>`,
and `<body>` — is the page's. See `ownership.ts`.

## Why there's a control run

An observer at `document_start` sees the browser *parsing the document*: every element the page is
made of arrives as a `childList` record. On a trivial fixture that is 30 lines of noise hiding 4
lines that matter.

Rather than guess which records look like parsing, every fixture runs twice — once clean, once with
the extension — and the harness takes the multiset difference. What the page does to itself cancels;
the residue is the extension's doing, by construction. There is no hand-maintained allowlist to
drift, and no way to quietly exclude a violation by adding a pattern.

## `known-violations.json` is a ratchet, not a mute button

E1 imported an engine that violates the invariant in fourteen catalogued places. Fixing them is E2's
job, and until that lands the suite would be red on every PR — which trains everyone to ignore it.

So the suite asserts the violation set **equals** the recorded baseline:

- a **new** violation fails the build (a regression)
- a violation that **disappears** also fails, telling you to tighten the baseline

That second half is the important one. Entries may only ever be removed, and removing one means the
corresponding ADR 0001 site is fixed. **Adding an entry to make CI green is the thing `CLAUDE.md`
forbids.**

Both directions are verified — dropping a real entry and adding a phantom one each fail with the
right message.

## Current state

34 passing, 61 skipped. Most skips are the byte-identical assertions on fixtures that still have
known violations: their serialized HTML cannot match until E2 lands, and pretending otherwise would
be dishonest. They un-skip automatically as baseline entries are removed.

Two tests exist purely to stop the harness being vacuous:

- **`the corpus is non-empty`** — a suite that runs zero fixtures reports green.
- **`the extension is actually loaded and theming`** — if the extension fails to load, every other
  assertion passes trivially and the harness reports a perfect score while testing nothing. This is
  the single most important test in the file.

  It asserts a **computed-colour change**, not a mutation count. Counting mutations was the first
  version and it was self-defeating: it would have started failing the moment E2 succeeded and the
  mutations stopped — the harness's most important test, guaranteed to break precisely when the
  project works, and then "fixed" by weakening it. Rendered colour survives the rewrite, because
  theming still has to change what the user sees however it is delivered.

## Known gaps

Recorded rather than hidden:

- **Multiple owned `<style>` elements in `<head>` are currently permitted.** §2 allows *one*
  fallback `<style>`; upstream inserts a sync-style sibling per page stylesheet (ADR 0001 item 12).
  The harness allows all of them because they are provably ours. Tightening this to exactly one is
  an E2 rewrite-time decision — the rewrite moves to constructed stylesheets, which removes the
  question rather than answering it.
- **The `nondeterministic` escape hatch exists but nothing uses it.** `spa-inline-styles.html`
  originally ticked forever, which made *which* violations landed depend on where the timer was when
  the harness stopped watching — it passed locally and failed in CI with a different set. It now
  re-renders a fixed 8 times and settles, so it is compared strictly like everything else. The flag
  remains for a future fixture that genuinely cannot settle; reach for a deterministic fixture first.
- **No fixture reproduces ADR 0001 item 13** (the WordPress conflicting-plugin attribute war). It
  needs a fixture that installs a competing plugin's markup; tracked with the item-13 issue.
