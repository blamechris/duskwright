# ADR 0006 — Removing the inline write path

- **Status:** Accepted
- **Date:** 2026-08-01
- **Implements:** ADR 0004 (declaration keying) as corrected by ADR 0005
- **Removes:** ADR 0001 items 1-5 and item 6
- **Supersedes:** ADR 0005 D5 (the catalog rewrite), see D4 below
- **Relates to:** epic E2, issues #17, #78, #79, #80, #81, #82

## Context

ADR 0004 chose to key inline theming off the *declaration* rather than the element. ADR 0005
corrected six things about that design before any of it was wired in. The key deriver, the
shorthand expander, the rule table and the exclusion builder were all built and merged against
those two documents.

This ADR records what happened when they were finally connected to the engine — the decisions
that could only be made with the whole path in front of us, and the ones where implementing
ADR 0005 revealed it had promised something it had not specified.

## What changed

`overrideInlineStyle()` used to read an element's inline styling, compute a themed value, and
write it back into that element's own `style` attribute as a `--darkreader-inline-*` custom
property, tagging the element with a matching `data-darkreader-inline-*` attribute. A generated
rule tied the two together. Both writes are serializable page state — ADR 0001 items 1-5, and
the Google Sheets failure verbatim.

It now reads the element and writes nothing. Declarations are registered with the rule table,
which emits selectors matching the attribute text into a stylesheet we own.

The observers, the element-discovery walk and the shadow-root plumbing in `inline-style.ts` are
upstream's and are untouched. The decision logic moved to `src/purity/inline/engine.ts`, which
is ours.

## D1 — Rewriting an upstream file, and why this is the exception

`CLAUDE.md` says upstream files get minimal edits, because every diff line can conflict on
E9's scheduled sync. It also names the exception: the purity rewrite.

`overrideInlineStyle` **is** the violation the project exists to remove. There is no version of
this change that leaves its body intact. What is minimised instead is the *surface*: everything
that decides anything lives in `src/purity/inline/engine.ts`, and what remains in the upstream
file is a signature-compatible delegation plus the observers, which are unchanged. `index.ts`
gains four lines.

## D2 — The modifier gets a detached probe, never the element's style

`getModifiableCSSDeclaration` reads sibling declarations off the rule it is handed: border
widths for the `initial`/`currentcolor` border cases, `mask-image` for backgrounds. Upstream
passed `{style: element.style}`.

We cannot. The premise of declaration keying is that one rule serves every element carrying that
declaration, so an answer that varies by element is unsound no matter how convenient it is to
obtain. The modifier is given a detached element carrying only the declaration being themed —
never inserted, never observed, invisible to the page, the same argument as the shorthand probe
in `expand.ts`.

**Cost, stated:** the border-side special case (`border-top-color: initial` where
`border-top: 0px`) no longer sees the sibling declaration and degrades to leaving the value
alone. That is the safe direction — it themes nothing rather than theming from a value the
element does not render.

## D3 — `mask` is a real un-keyable reason, and ADR 0005 D6 only promised it

ADR 0005 D6 lists `mask` and `embedded-separator` among the un-keyable reasons as though they
existed. They did not; `keys.ts` implemented `duplicate`, `variable`, `variable-def`,
`important` and `invalid`. This ADR closes half that gap.

`getColorModifier` treats a background colour as **foreground** when the element carries a real
`mask-image` — a masked element's "background" is the shape the user actually sees. So
`background-color:#fff` inside a masked attribute and the same text inside an unmasked one need
two different answers from one selector.

The masked declaration is now marked `unkeyable: 'mask'`, which is non-colliding: skipping it
leaves nothing behind that another element's rule would wrongly match, because the collision
runs the other way — it is *our* answer that would be wrong, not the other element's.

The `none` and `linear-gradient` exclusions mirror upstream's condition exactly rather than
being reasoned about independently. Diverging there would mis-theme in the other direction.

`embedded-separator` remains unimplemented; the value-aware splitter handles separators inside
strings, parens and comments, which is what that reason was reaching for.

## D4 — The fixes catalog keeps its marker custom properties; our rules read them

ADR 0005 D5 said the catalog's `--darkreader-inline-*` declarations should be rewritten into the
real property, calling that "exactly equivalent". It is not, and this is the correction.

Upstream's mechanism had two halves:

```css
/* catalog */  .wrap svg *                    { --darkreader-inline-fill: #FFF !important }
/* engine  */  [data-darkreader-inline-fill]  { fill: var(--darkreader-inline-fill) !important }
```

The custom property does nothing on its own. The engine's rule is its only consumer, and that
consumer **is the gate**: the declaration reaches an element if and only if the engine themed
that element's fill. Rewriting `--darkreader-inline-fill: #FFF` to `fill: #FFF` deletes the gate,
so the fix lands on every element the catalog selector matches. Measured in Chromium on the real
rules: `<path fill="none">` painted white, `<path>` with no fill attribute painted white,
`<rect>` inside a `<clipPath>` painted white — the same over-application that made a bare
`[fill]` selector a critical finding, arriving through the other branch.

Three rounds of review produced three wrong approximations of "did the engine theme this
element?" as a static selector. The reason is that it is not a static property of the element;
it is a property of what we did.

**Decision.** Do not approximate it — reconstruct it. The catalog's declarations stay exactly as
upstream wrote them, and the rules we emit read the custom property with the themed value as
fallback:

```css
[style^="fill:#123456;"] { fill: var(--darkreader-inline-fill, rgb(200,200,200)) !important }
```

The property is read only where our rule matches, which is exactly where we themed. Gate
restored, by construction rather than by approximation. Where the catalog sets nothing, the
fallback is the themed value and nothing changes.

All six catalog rules that *select* on a marker declare exactly the property their marker stands
for, so they collapse into the same shape:

```css
[data-darkreader-inline-fill] { fill: X }   ->   * { --darkreader-inline-fill: X }
g[data-darkreader-inline-fill] { fill: X }  ->   g { --darkreader-inline-fill: X }
```

The collapse is refused when the body declares anything else. Upstream gated the **whole rule**
on the marker, so moving only the matching declarations would leave the rest applying
unconditionally — a silent widening. Such a rule keeps the presence-test fallback, which can
over- or under-apply but cannot ungate a declaration.

This is also automatically right for the properties we no longer theme at all. Nothing reads
`--darkreader-inline-bgimage` now, so a fix keyed on it is inert — which is exactly what
upstream's unwritten marker would have produced. The presence-test version over-applied instead:
measured, `[data-darkreader-inline-bgimage] { background-image: none }` wiped the background of
every element carrying an inline `background-image:`, where upstream marked only `<html>` and
`<body>`.

**One presence test survives**, on the single catalog rule that *negates* a marker: there is no
custom property to read for "we did not theme this". It is deliberately **broad**, because the
two directions want opposite errors — under `:not()`, every shape the test misses is an element
the fix wrongly applies to, overriding the page's own inline style. Broad here and narrow in the
positive direction both err toward "the fix does not apply".

That one rule now applies slightly *less* often than upstream: it restores a map background that
inline theming used to break, and inline background images are no longer themed at all, so
skipping it is arguably the more correct behaviour now. The residual half of #80 covers it.

**Sequencing.** The rewrite is inert until this change lands (`ENGINE_WRITES_INLINE_MARKERS`).
While the engine still writes markers they work exactly as upstream intended, and rewriting the
catalog can only break them.

## D5 — Tier 2 is emitted before tier 1, and that is a correctness requirement

Both rule families are `(0,1,0)` and both carry `!important`, so the later rule wins. The page's
own cascade is unambiguous about which that must be: `bgcolor` is a presentational hint, which
ranks below every author rule, and `style` is inline, which outranks them all. An element
carrying both must be themed from its `style`.

Emitting in table order would let whichever rule happened to be created first *on the whole
page* decide, which is not a rule at all. `buildCSS()` therefore emits tier 2 first.

## D6 — What was dropped, and why none of it needed replacing

Two upstream guards existed **only** to survive our own writes, and neither can be provoked by a
reader:

- **The loop detector.** A page that rewrote its `style` attribute in response to ours, up to
  ten cycles before giving up.
- **The ProseMirror early return.** An editor that rebuilt its entire HTML after we wrote.

Dropping the second is a coverage *gain*: ProseMirror content is now themed, and safely.

## D7 — Deferred capability, counted rather than dropped

Three things are not expressible as a shared declaration key. Each is counted in
`InlineStyleEngine.stats().deferred` and tracked in #78, so the gap shows up as a number rather
than surfacing months later as "SVG logos stopped inverting":

| | Why |
|---|---|
| SVG `fill` on non-`<text>` | Modifier depends on measured geometry (ADR 0005 D4) |
| Whole-`<svg>` inversion | Per-element image analysis, and a P1 write (ADR 0001 item 6) |
| `background-image: url()`, `background=` | Async, and the `none` substitution is identity-dependent |

The last is the one worth stating plainly: theming it *without* the root-only `none`
substitution would leave a bright image in place while reporting the declaration as handled.
Not theming it is the honest failure; a half-applied fix is not.

`var()`-valued and inline-`!important` declarations remain counted and un-themed, per ADR 0005.
Tracked in #79.

## Consequences

- ADR 0001 items 1-5 and item 6 are removed. `known-violations.json` loses every
  `data-darkreader-inline-*` and inline `style` entry, and the fixtures that had nothing else
  begin asserting byte-identity for the first time.
- `contenteditable-editor.html` — the Google Docs failure shape — goes to zero **by
  construction**, not by exclusion.
- The `darkreader--inline` sheet is no longer static. It is refilled as elements are discovered,
  synchronously at the end of each discovery pass and coalesced to one write per frame
  otherwise.
- Every shadow root needs its own copy of the rule text, because an attribute selector in the
  document sheet does not reach into one. This is what upstream already did with the static
  sheet, so the shape is unchanged, but the text is now proportional to the page's distinct
  inline declarations rather than constant. Worth watching on pages with many shadow roots.
