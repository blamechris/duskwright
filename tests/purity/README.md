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
   browser.

Neither is redundant. The observer catches mutations that are **reverted before any snapshot** —
ADR 0002 C4, and three of ADR 0001's fourteen sites are exactly that. The stylesheet comparison
catches `adoptedStyleSheets` changes, which fire **no** `MutationRecord` at all. Each sees what the
other structurally cannot.

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

33 passing, 31 skipped. The skips are the byte-identical assertions on fixtures that still have
known violations: their serialized HTML cannot match until E2 lands, and pretending otherwise would
be dishonest. They un-skip automatically as baseline entries are removed.

Two tests exist purely to stop the harness being vacuous:

- **`the corpus is non-empty`** — a suite that runs zero fixtures reports green.
- **`the extension is actually loaded and theming`** — if the extension fails to load, every other
  assertion passes trivially and the harness reports a perfect score while testing nothing. This is
  the single most important test in the file.

## Known gaps

Recorded rather than hidden:

- **Multiple owned `<style>` elements in `<head>` are currently permitted.** §2 allows *one*
  fallback `<style>`; upstream inserts a sync-style sibling per page stylesheet (ADR 0001 item 12).
  The harness allows all of them because they are provably ours. Tightening this to exactly one is
  an E2 rewrite-time decision — the rewrite moves to constructed stylesheets, which removes the
  question rather than answering it.
- **`spa-inline-styles.html` rewrites itself every 250ms**, so its `childList` counts cannot cancel
  exactly. Attribute and `characterData` records are still compared strictly, which is where that
  fixture's violations live. Marked `nondeterministic` in the corpus manifest.
- **No fixture reproduces ADR 0001 item 13** (the WordPress conflicting-plugin attribute war). It
  needs a fixture that installs a competing plugin's markup; tracked with the item-13 issue.
