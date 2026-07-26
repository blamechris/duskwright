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
3. **The page's `adoptedStyleSheets` reference stays live** — the property ADR 0001 item 14
   warned about. (The item itself turned out not to be a real violation; see the correction in that
   ADR. The assertion is kept because nothing else in the suite would notice if a future rewrite did
   strand the page's reference.)

None is redundant. The observer catches mutations **reverted before any snapshot** (ADR 0002 C4 —
three of the fourteen sites are exactly that). The stylesheet comparison catches `adoptedStyleSheets`
content changes, which fire **no** `MutationRecord` at all. And the third catches a page's handle
going stale, which is invisible to *both* of the others: no DOM node moves and no serialized state
changes.

> **Two things this suite got wrong about itself, recorded because a gate that doesn't check what it
> advertises is the exact failure it exists to prevent.**
>
> 1. It read only `document.styleSheets` while this README claimed the adopted surface was covered.
>    It wasn't — those are disjoint collections. Fixed.
> 2. Assertion 3 originally compared object *identity* and reported a violation on
>    `adopted-stylesheets.html`. That was a **false positive**. Identity differs because the
>    MAIN-world proxy wraps the getter, not because anything was reassigned — and measurement showed
>    `adoptedStyleSheets` is an `ObservableArray` whose setter writes *through*, so ADR 0001 item
>    14's stated harm never occurs in Chromium. The assertion now measures liveness, the baseline
>    entry was removed, and **ADR 0001 was corrected**.
>
> The second one is worth dwelling on: a harness can manufacture a violation as easily as it can miss
> one, and a confidently-wrong gate costs real engineering time chasing a bug that isn't there.

## Determinism is not optional

Every capture launches its **own** browser context and closes it.

Sharing one persistent context made the suite nondeterministic: two consecutive full runs failed on
different fixtures — `late-injected-styles` + `css-variables`, then `shadow-dom-closed` — with no
code change between them. State accumulates across 90+ page loads (per-site settings, caches,
service-worker restarts) and leaks into whichever fixture runs next.

Intermittent red is disqualifying for a blocking gate. It trains everyone to re-run until green,
which is precisely how a real violation gets waved through. Isolation costs about 0.6 minutes and
buys the only property that matters here: the same input always gives the same answer. Two
consecutive runs now produce byte-identical results.

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

34 passing, 61 skipped, in ~4.3 minutes. Most skips are the byte-identical assertions on fixtures that still have
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

## What this harness structurally cannot see

Recorded because a gate's blind spots matter as much as its assertions.

**Performance harm we inflict on the page.** With 2,000 per-element structural rules adopted, a
single `insertBefore` *by the page itself* goes from 1.7ms to 92.3ms — a 54x tax on the application
we are decorating. No `MutationRecord` fires, no serialized state changes, no page-owned stylesheet
is touched, so `ownership.ts` classifies it as nothing at all. It is nonetheless the same kind of
harm the invariant exists to prevent: the user's spreadsheet is unusable and the cause is us.

This shaped ADR 0004's whole design and the harness would never have flagged it. If a cheap runtime
assertion for it exists, it belongs here.

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
