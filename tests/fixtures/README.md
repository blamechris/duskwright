# Fixture corpus

31 pages plus two cross-origin assets. Every later epic is measured against this corpus, which is
why it lands in E1 rather than E7 — there is nothing to measure before it exists.

```bash
node tests/fixtures/server.mjs           # serve on :8788 (+ :8789 for the second origin)
node tests/fixtures/server.mjs --check   # verify every fixture responds, then exit
npm test                                 # includes the corpus coverage assertions
```

## Two rules

**Nothing here touches the network.** Every asset is local or a data URI, and
`corpus.tests.ts` fails on any external URL. A fixture that reaches the internet turns "our code
changed" into "a website changed", which makes every regression ambiguous and every metric
untrustworthy.

**The coverage map is asserted, not assumed.** `index.json` records which purity class
(`ARCHITECTURE.md` §2) and which failure cause (§1) each fixture covers, and
`tests/unit/fixtures/corpus.tests.ts` fails if a class or reproducible cause loses its last fixture,
or if a file on disk isn't listed. Without that, the corpus could silently shrink while every
derived metric kept reporting green — the same shape of problem the purity harness itself guards
against.

## Why two origins

`server.mjs` serves `pages/` on **8788** and `cross-origin/` on **8789**, and the second origin
deliberately sends **no** `Access-Control-Allow-Origin` header. A CORS-restricted stylesheet and a
cross-origin iframe cannot be reproduced from a single host, and those are two of the nine reasons
theming fails.

## What's covered

**Purity classes (§2)** — the six the harness requires: `static-plain`, `spa-inline-styles`,
`adopted-stylesheets`, `shadow-dom-open`, `canvas-rendered`, `contenteditable-editor`.

**Failure causes (§1)** — 1 cross-origin sheets, 2 shadow roots (open and closed), 3 iframes
(same-origin, sandboxed, cross-origin), 4 canvas and WebGL, 5 strict CSP, 6 runtime inline styles
and late injection, 7 CSS-in-JS, 8 site-provided dark mode and already-dark pages.

**Per epic** — E2: the throughput case (`virtualized-table.html`, 4000 rows × 6 inline-styled cells
re-rendered on scroll) and the mutation-sensitive pages. E4: selector generation, including ids that
must be *rejected* and a page that forces both zero-match and over-match drift. E5: the
exclude case (`color-picker.html` — inverting it makes it wrong, not dark) and the media
counter-filter. E6: a page that must be flagged, one that must **not** be, and a transparent
ancestor chain.

## The corpus could not answer the question it exists to answer

A measurement pass over all 31 original fixtures found: **median 0** inline-styled elements,
**p90 5**, **max 141**. `ARCHITECTURE.md` §9's "< 100ms on the corpus median" was therefore a budget
against a page with *zero* of the elements the E2 rewrite is about, and no two candidate designs
could be told apart by running them against this corpus.

Two fixtures now cover the two distinct failure modes, which had been conflated:

| Fixture | Pressure | Shape |
|---|---|---|
| `virtualized-table.html` | **rate** | ~141 inline-styled elements at any moment, ~8,400 created over a 60-frame scroll (~17k/sec) |
| `dense-inline-styles.html` | **count** | 2,000 simultaneous, static, no timers |

`dense-inline-styles.html` sits at the measured crossover. Blink indexes CSS rules by the
**rightmost compound selector**, and a purity-legal selector must end in a tag or a page-authored
class — adding an id or class is the mutation the invariant forbids. So every rule we emit lands in
one bucket and every candidate element tests every rule: **O(M²)**, ~22ns per element × rule, on
*every* full style pass. At M=2,000 that is ~89ms of the 100ms budget.

That number is why the fixture exists. A design decision this expensive should not rest on a corpus
whose median is zero.

## Deliberate gaps

Recorded in `index.json` under `knownGaps`, and asserted by the tests so they read as decisions
rather than oversights:

- **Cause 9** (`chrome://`, the Web Store) cannot be a fixture — the extension is not permitted to
  run there. E7's restricted-page detection covers it instead.
- **No real Google Sheets or Figma document.** The canvas fixtures approximate the rendering model.
  The Sheets enable→disable round-trip in `ARCHITECTURE.md` §9 needs the real application and is
  tracked on its own E2 issue.

## Adding a fixture

Add the HTML to `pages/`, add an entry to `index.json` with its `purityClass` and/or `cause` and the
epics that assert against it, then run `npm test`. The manifest/disk agreement check will fail until
both sides match, which is intentional — an unlisted fixture is invisible to the coverage map.
