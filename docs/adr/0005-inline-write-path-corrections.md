# ADR 0005 — Corrections to the inline-style replacement, found before writing it

- **Status:** Accepted
- **Date:** 2026-07-28
- **Supersedes:** ADR 0004's tier table for SVG `fill`, and its claim that tiers 1+2 cover 8 of 9 violating fixtures
- **Relates to:** epic E2, issues #17, #19, #68, #69

## Context

ADR 0004 chose to key theming off the inline *declaration* rather than the element. The key
deriver (`src/purity/inline/keys.ts`) and the rule table (`src/purity/inline/emitter.ts`) were
built, reviewed, and merged against that design.

Before wiring them into the engine, the behaviour of `overrideInlineStyle()` was mapped in full
and the failure modes predicted adversarially. That pass found a defect that would have shipped,
plus four places where ADR 0004 is wrong and one honest capability loss.

Writing it down first is the point: four of these contradict the ADR the code was built from,
and code that silently disagrees with its own design record is how the next person gets misled.

## D1 — Key the authored fragment, theme the expanded longhands

**The defect.** `getModifiableCSSDeclaration` (`modify-css.ts:68`) themes a property only when
its name contains `color`, or it is `fill` / `stroke` / `background-image`. Upstream never
notices because `inline-style.ts:592` iterates `element.style` through the **CSSOM**, which
expands shorthands — so it sees `background-color` and themes it.

Our deriver reads the raw attribute and sees the *authored* shorthand. Measured:

```
upstream sees:   background-image, background-position, background-size, background-repeat,
                 background-attachment, background-origin, background-clip,
                 background-color, color        → themable: 3
our keys see:    background, color              → themable: 1

consequence:     BACKGROUND NEVER THEMED
```

**All 32 corpus fixtures use `background:`.** Shipped, that is text darkened with backgrounds
left white — dark-on-white, or white-on-white. No crash, no failing test.

**Why the tests passed.** The emitter's unit tests inject a fake themer that *accepts*
`background` (`emitter.tests.ts:7`). It was more permissive than the real one, so every test
passed on a design the real engine rejects. This is the third test-fidelity miss in this module,
after the hand-simulated CSS matcher that disagreed with the browser and the key-count assertion
that hid rule churn. **The pattern is that stubs have been written optimistically**; the standing
correction is that a stub must be at least as strict as the thing it replaces.

**Decision.** Key on the authored fragment — the selector must match the attribute as written —
but theme the **expanded longhands**. Expansion goes through a detached element we create and
never insert:

```css
[style^="background:#fff;"] { background-color: <themed> !important }
```

A detached element is purity-legal: never inserted, never observed, invisible to the page.
Expansion is memoised, capped, and an empty expansion means the declaration was invalid and is
skipped.

## D2 — The cascade invariant, and why duplicate detection must move

`keys.ts` currently marks an attribute un-keyable when the same **authored property name**
appears twice. That is not the real hazard. This is:

```
style="border-top-color:#0f0;border:1px solid #333"
```

Judged tier-1 safe today, because the authored names differ. But `border` expands to include
`border-top-color`, so the second declaration overrides the first — and we would emit a rule
themed from the *dead* one.

**Decision.** The invariant is: **no two live rules may declare the same longhand for one
element.** Duplicate detection compares expanded longhand sets, not authored names. Any overlap
marks both declarations un-keyable. `all: unset` falls out of this for free.

This matters because rule order in our table is global first-creation order, which cannot be
made to reproduce a particular element's own declaration order. We avoid the problem rather than
try to order around it.

## D3 — Tier 2 must separate "theme as" from "emit as", and carry a qualifier

The emitter's `updateAttribute` takes one `cssProperty` used both to pick the modifier and to
write the declaration. The engine deliberately passes *different* values for those two roles
(`inline-style.ts:569,583,589`): `stroke` is themed as `border-color` on `SVGLineElement` and
`SVGTextElement`, and as `color` otherwise, but must always be **emitted** as `stroke`.

Emitting `background-color` on an SVG `<rect>` paints nothing at all.

**Decision.** Tier 2 carries `themeAs` and `emitAs` separately, plus an optional selector
qualifier, because the element-type discrimination *is* expressible as a selector:

```css
[stroke="#333"]:not(line):not(text) { stroke: <themed-as-color> !important }
line[stroke="#333"], text[stroke="#333"] { stroke: <themed-as-border-color> !important }
```

## D4 — SVG `fill` is tier 3, not tier 2

ADR 0004's tier table lists presentational attributes including `fill` under tier 2. That is
wrong, and it contradicts the same ADR's own tier-3 list two lines later.

The `fill` modifier depends on **geometry**: `handleSVGElement` (`inline-style.ts:549-568`)
measures `getBoundingClientRect()` of both the element and its owning `<svg>`, treating a fill
as foreground inside a small SVG (≤ 32×32) and as background for a shape larger than 32px inside
a bigger one.

So `<rect fill="#ffffff">` and `<text fill="#ffffff">` yield **one selector needing two
different answers**, and the last rule written would win for both. Guessing is silent
mis-theming, which is worse than not theming.

**Decision.** Only `SVGTextElement` `fill` is keyed at tier 2 (its modifier is unconditionally
`color`). Everything else defers to tier 3. Cost: the `<rect>`/`<circle>` fills in
`svg-heavy.html` and `media-heavy.html` stay un-themed until step 3 — **counted, not silent**.

## D5 — The fixes catalog is rewritten at load, not served by marker attributes

23 catalog rules set `--darkreader-inline-*` custom properties directly and rely on the
`[data-darkreader-inline-*]` marker attributes plus the `var()` indirection that
`getInlineOverrideStyle()` provides. We are removing both.

**Decision.** Rewrite those declarations at load: `--darkreader-inline-color: X !important`
becomes `color: X !important` in the same rule. This is exactly equivalent — the catalog rule
already targets the element directly, so the custom property was only ever a handoff to the
marker rule. It lands in the `--override` sheet, which sits later in the cascade than
`--inline`, so per-site fixes keep beating generic theming.

Same technique as step 0's scheme-selector resolution, and for the same reason: the catalog is
synced from upstream by E9 and must stay editable-free.

## D6 — Un-keyable reasons split into colliding and non-colliding

The emitter currently takes the **whole attribute** out of tier 1 if any declaration is
un-keyable. That is right for `duplicate`, where a dead declaration's selector genuinely
collides with a live one on another element — dropping just the dead declaration leaves the
collision.

It is over-broad for `variable`. A `var()` value simply *cannot* be keyed; skipping that one
declaration collides with nothing.

**Decision.** Reasons are classified. `duplicate` and `embedded-separator` remove the whole
attribute; `variable`, `variable-def`, `important` and `mask` skip one declaration.

## The capability loss, stated plainly

A page declaration marked `!important` inline — `style="color:#333 !important"` — beats any
author-origin rule we are able to write. Upstream won that fight by writing into the attribute
itself. **Nothing in tiers 1–4 can.**

Such declarations are marked `unkeyable: 'important'`, counted in the emitter's stats, and left
un-themed. This is a real regression against upstream on pages that use inline `!important`,
accepted because the alternative is the mutation the whole project exists to avoid.

Otherwise the cascade is **equivalent** to upstream: the same sheet, the same specificity class
(`[style^=…]` is (0,1,0), exactly as `[data-darkreader-inline-color]` was), and the same
`!important`.

## The other structural problem: `ignoreInlineStyle`

`fixes.ignoreInlineStyle` is a per-site opt-out used by **229 catalog sites**, implemented today
as an early return that also strips the marker attributes.

Under shared declaration keys there is no early return available: an ignored element and a
non-ignored element carrying the same declaration text get the **same rule**. Exclusion must
therefore move into the selector — appending a `:not()` chain to every emitted rule — or become
a region-level exclusion.

Forgetting this would silently re-theme opted-out regions on 229 sites. It is called out here
because it is the single most likely thing to be missed, and it is invisible without a fixture.

## Consequences

- The tier-1 core needs a shorthand expander before wiring; it is not a wiring detail.
- Duplicate detection is stricter than merged, so some attributes currently keyed will stop
  being keyed. That is a fidelity *gain*: they were being themed from dead declarations.
- SVG coverage regresses until step 3, deliberately and countably.
- `ARCHITECTURE.md` and ADR 0004 both remain unedited; this is the diff against them.
