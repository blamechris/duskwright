# ADR 0002 — Corrections to ARCHITECTURE.md after reading upstream

- **Status:** Accepted
- **Date:** 2026-07-25
- **Upstream audited:** `darkreader/darkreader` @ `9e71d744`
- **Relates to:** all epics; `ARCHITECTURE.md` §1, §2, §6, §7

## Context

`ARCHITECTURE.md` was written without access to the upstream source. The kickoff asks for
contradictions to be written down rather than silently resolved. This ADR is that list.

Most of the document survived contact with the source. Its analysis of *why* Dark Reader misses
sites (§1) is accurate, including the detail that upstream falls back to re-fetching CORS-restricted
CSS over the network — confirmed at `style-manager.ts:119-203` (`corsCopies`). The tiered engine
ladder (§3), the rule schema (§5), and the storage decisions (§5) need no correction. The items
below do.

## Corrections

### C1 — `inline-style.ts` does not use override classes (§2, high impact)

**Doc says:** it "handles `style="color: …"` elements by attaching override classes."

**Source says:** it writes into the element's inline style attribute directly —
`element.style.setProperty(customProp, value)` at `inline-style.ts:412`, plus marker attributes, plus
an outright deletion of page-authored declarations at line 612.

**Why it matters:** the doc's version implies the fix is "stop adding classes." The real fix is
replacing an inline-style write path with selector emission, which is a much larger job with a real
performance question attached. Fully inventoried in [ADR 0001](0001-upstream-purity-audit.md).

### C2 — upstream ships a `world: "MAIN"` content script (§6, high impact)

**Doc says:** "Isolated world only. Never use `world: "MAIN"`. Page-world execution is the fastest
route to violating the purity invariant."

**Source says:** `src/manifest-chrome-mv3.json:32` declares a content script with `"world": "MAIN"`.
It injects `stylesheet-proxy.ts`, which monkey-patches `CSSStyleSheet.prototype.insertRule`,
`deleteRule`, and the `adoptedStyleSheets` accessor so the extension can observe stylesheet
mutations made by page JavaScript. `mv3-proxy.ts` coordinates it and marks completion by writing
`document.documentElement.dataset.darkreaderProxyInjected`.

**Why it matters:** this is a real conflict, not a wording nit. The doc's rule is sound in intent —
page-world code is the easiest place to violate purity, and the proxy does in fact write a page
attribute. But the proxy is not decoration: without it, CSS-in-JS sites that insert rules through
the CSSOM (§1 cause 7) become invisible to the engine, which is one of the failure modes we exist to
fix.

**Decision:** keep the doc's rule as the default and treat the proxy as a **narrow, explicitly
justified exception**, not a general licence for page-world code. Concretely:

- The MAIN-world script's only job is observation — patch, report through `CustomEvent`, never write.
- Its `documentElement.dataset` write is removed (ADR 0001 item 9); handshake state moves into the
  event protocol.
- The purity harness runs with the proxy enabled, so any regression here fails CI rather than
  relying on the rule being remembered.
- If the harness cannot be made green with the proxy in place, the proxy loses and CSS-in-JS
  coverage degrades to the coverage-detection path (§3). Purity is the differentiator; CSS-in-JS
  coverage is table stakes we share with upstream.

This exception must be revisited in E2, not assumed settled.

### C3 — `src/generators/modify-colors.ts` does not exist (§7, low impact)

**Doc says:** keep `src/generators/modify-colors.ts`.

**Source says:** `src/generators/` exists (`css-filter.ts`, `dynamic-theme.ts`, `static-theme.ts`,
`svg-filter.ts`, `text-style.ts`, `theme-engines.ts`), and `modify-colors.ts` exists — but at
`src/inject/dynamic-theme/modify-colors.ts`. The doc conflates two real paths.

**Why it matters:** only that a future agent told to read `src/generators/modify-colors.ts` will not
find it. Both directories are in the "keep" set regardless.

### C4 — the purity harness as specified cannot catch transient mutations (§2, high impact)

**Doc says:** snapshot `outerHTML` + stylesheet text, enable the extension, wait for settle,
re-snapshot, subtract our own nodes, assert byte-identical.

**Problem:** three of the violations in ADR 0001 (the `<meta name="darkreader-lock">` insert/remove,
the MV2 proxy script insert/remove, and the `disableConflictingPlugins` attribute war) are reverted
or re-applied before any final snapshot. A before/after diff passes while the page's own
MutationObserver has already fired. A gate that passes on a real violation is worse than no gate,
because it manufactures confidence.

**Decision:** the harness installs a `MutationObserver` on `document` with
`{subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true}`
**before** the extension is enabled, and asserts on the recorded mutation log in addition to the
snapshot diff. Records are filtered by proven ownership (our shadow host, our style element), same
as the snapshot subtraction. Byte-identical snapshots plus an empty filtered mutation log is the
gate.

### C5 — `adoptedStyleSheets` is observable, though still permitted (§2, low impact)

**Doc says:** appending our sheet to `document.adoptedStyleSheets` is "additive; not serializable
into the page's document model."

**Correction:** the serialization half is right — `outerHTML` does not include adopted sheets. The
implication that the page cannot see it is wrong: page JS can read `document.adoptedStyleSheets` and
enumerate ours. Upstream also *reassigns* the array wholesale
(`adopted-style-manger.ts:57, 70`) rather than appending, which detaches any array reference the
page held.

**Decision:** the operation stays allowed — the invariant forbids mutations the page can observe as
changes to *its own content*, and our sheet is not its content. But the rationale in §2 is
overstated and should not be relied on as "unobservable," and reassignment becomes append-only.

### C6 — three build targets to strip, not two (§7 / kickoff, low impact)

**Doc and kickoff say:** strip Firefox and Safari build targets.

**Source says:** upstream's targets are Chrome MV2, Chrome MV3, Firefox MV2, Firefox MV3, and
**Thunderbird** (`tasks/build.js:107-110`, `src/manifest-thunderbird.json`). There is no Safari
manifest to strip — upstream does not ship one. Safari support, where it exists, rides on the
generic MV2 path.

**Why it matters:** E1's "strip non-Chromium targets" acceptance criterion should name Firefox MV2,
Firefox MV3, and Thunderbird, and should not block on finding a Safari target that was never there.

## Consequences

- C1 and C4 change E2's scope and are the two corrections that would have cost real rework if found
  later.
- C2 leaves a genuinely open question — whether the MAIN-world proxy can coexist with a green purity
  harness — deliberately unresolved until E2 has the harness to answer it with.
- C3 and C6 are factual fixes to file paths and target lists.
- `ARCHITECTURE.md` is left **unedited** as the design of record. These ADRs are the diff against it,
  per the kickoff's instruction that contradictions be written down rather than resolved in place.
