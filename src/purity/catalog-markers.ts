// ADR 0005 D5 — rewriting the fixes catalog's use of the inline marker attributes.
//
// Upstream's inline path wrote two things onto a page element: a `--darkreader-inline-*`
// custom property, and a `data-darkreader-inline-*` marker attribute. A generated rule then
// tied them together:
//
//     [data-darkreader-inline-fill] { fill: var(--darkreader-inline-fill) !important }
//
// The per-site fixes catalog piggybacks on that indirection in three distinct ways, and all
// three break once we stop writing the markers. Counted from the real catalog:
//
//   A. 19 rules SET a custom property:  `--darkreader-inline-fill: ${#110133} !important`
//      Without the marker rule to consume it, the property is set and never read. Dead.
//
//   B. 7 rules SELECT on the marker:    `[data-darkreader-inline-fill] { fill: ... }`
//      Without the marker, matches nothing. Dead.
//
//   C. 1 rule NEGATES the marker:       `...:not([data-darkreader-inline-bgimage])`
//      This one is worse than dead. Without the marker the `:not()` matches EVERYTHING, so
//      the rule starts applying to elements it was written to skip. A silent behaviour
//      change rather than a silent no-op, which is why C is handled separately below.
//
// All three are rewritten at load, the same technique step 0 used for the scheme selectors,
// and for the same reason: the catalog is synced from upstream by E9 and must stay unedited.

/**
 * Marker suffix to the CSS property it stood for.
 *
 * Derived from the engine's own `overrides` table in `inline-style.ts` rather than hand-copied
 * — the mapping is not the identity (`bgcolor` means `background-color`), and a wrong entry
 * here silently mis-themes whichever sites use it.
 */
export const MARKER_PROPERTIES: Readonly<Record<string, string>> = {
    'bgcolor': 'background-color',
    'bgimage': 'background-image',
    'border': 'border-color',
    'border-bottom': 'border-bottom-color',
    'border-left': 'border-left-color',
    'border-right': 'border-right-color',
    'border-top': 'border-top-color',
    'boxshadow': 'box-shadow',
    'color': 'color',
    'fill': 'fill',
    'stroke': 'stroke',
    'outline': 'outline-color',
    'stopcolor': 'stop-color',
};

// A presence test is an approximation of a runtime predicate — "did the engine theme this
// element's X?" — and the two directions want OPPOSITE errors:
//
//   used positively   `SELECTOR:is(<presence>)`   too broad  -> the fix applies where upstream
//                                                              skipped it
//   used negatively   `SELECTOR:not(<presence>)`  too narrow -> same thing
//
// So the positive form is built NARROW and the negative form BROAD. Both err toward "the fix
// does not apply", which is the direction that leaves the page as the site intended.

/**
 * The style-attribute forms of "this element declares P inline", anchored at the left
 * declaration boundary. The NARROW form — for positive use only.
 *
 * A bare `[style*="color:"]` is WRONG, and wrong in the direction that silently over-applies:
 * it also matches `background-color:`, `border-color:`, `caret-color:` and every other
 * `*-color` property, because they all contain the substring. That is the same cross-match
 * `keys.ts` was written to avoid (ADR 0004 note 2), confirmed in Chromium both times.
 *
 * There is no right boundary to anchor against here — unlike a declaration key, we know the
 * property but not the value — so the anchor is the left one: either the attribute starts with
 * it, or a `;` precedes it. Both spacings are listed because the CSSOM re-serializes with
 * `"; "` while authored markup usually has no space, and `*=` is a literal substring match.
 */
function styleDeclarationAlternates(property: string): string[] {
    return [
        `[style^="${property}:"]`,
        `[style*=";${property}:"]`,
        `[style*="; ${property}:"]`,
    ];
}

/**
 * The presentational-attribute form, minus the values that were never themed.
 *
 * `[fill]` alone is too broad: it matches `fill="none"`, `fill="currentColor"` and
 * `fill="url(#gradient)"`, and upstream wrote its marker only when the colour maths actually
 * produced a value — `none` and `currentColor` are skipped outright, and `url(...)` fails to
 * parse as a colour. Those elements never carried the marker, so a rule keyed on it never
 * reached them. photopea.com is an all-SVG UI with one of these rules; getting this wrong
 * repaints its entire interface.
 *
 * The `i` flag matters: CSS keywords are case-insensitive, so `fill="currentcolor"` is the
 * same value and an exact-match exclusion would miss it.
 */
function presentationalAlternate(attr: string): string {
    // `:where()` rather than three chained `:not()`s. Chained `:not()`s SUM: measured in
    // Chromium, the chained form is (0,4,0) and beats `.c1.c2.c3`, which would let these rules
    // win author `!important` fights upstream lost. `:where()` contributes zero specificity, so
    // the whole thing stays (0,1,0) — the same as the `[data-darkreader-inline-*]` marker it
    // replaces — while excluding exactly the same values.
    return `[${attr}]:not(:where([${attr}="none" i], [${attr}="currentColor" i], [${attr}^="url(" i]))`;
}

/**
 * The BROAD form, for negated use.
 *
 * Deliberately unanchored and value-blind. Inside `:not()`, every element this fails to match is
 * one the fix wrongly applies to, so the failure mode of being too broad here is "the fix does
 * not apply", and of being too narrow is "the fix overrides the page's own inline style". The
 * anchored form misses at least five real declaration shapes (`;` followed by a tab, a newline
 * or two spaces; an uppercase property; leading whitespace) — all of which the CSS parser
 * accepts, so upstream wrote the marker for all of them. See #80.
 */
function broadPresenceAlternates(suffix: string): string[] | null {
    const styleProp = MARKER_PROPERTIES[suffix];
    if (!styleProp) {
        return null;
    }
    const parts: string[] = [];
    if (suffix === 'fill' || suffix === 'stroke' || suffix === 'color' || suffix === 'bgcolor') {
        parts.push(`[${suffix}]`);
    }
    parts.push(`[style*="${styleProp}:"]`);
    return parts;
}

/**
 * Every selector that means "this element has an inline X", now that no marker exists.
 *
 * A presentational attribute where one exists, plus the style-attribute forms. Both are needed:
 * `<svg fill="#fff">` carries the attribute, `<svg style="fill:#fff">` carries the declaration,
 * and upstream's marker covered both because it was written in either case.
 */
function inlinePresenceAlternates(suffix: string): string[] | null {
    const styleProp = MARKER_PROPERTIES[suffix];
    if (!styleProp) {
        return null;
    }
    const parts: string[] = [];
    // The legacy presentational attributes that upstream also reads. `color` and `bgcolor` are
    // HTML attributes parsed with the legacy colour rules, which yield a colour for nearly any
    // input, so they carry no value exclusions.
    if (suffix === 'fill' || suffix === 'stroke') {
        parts.push(presentationalAlternate(suffix));
    } else if (suffix === 'color' || suffix === 'bgcolor') {
        parts.push(`[${suffix}]`);
    }
    parts.push(...styleDeclarationAlternates(styleProp));
    return parts;
}

/**
 * The above as a single compound selector.
 *
 * Wrapped in `:is()` because a bare comma-separated list breaks any rule where the marker sits
 * inside a compound: `g[data-darkreader-inline-fill]` would become `g[fill], [style*="fill:"]`,
 * and the second alternative silently loses the `g` prefix — the rule stops being scoped and
 * applies far more widely than the site fix intended.
 *
 * `:is()` also keeps specificity predictable: it takes that of its most specific argument, and
 * every argument here is (0,1,0) — see `presentationalAlternate` for why that needed care.
 */
function inlinePresenceSelector(suffix: string): string | null {
    const parts = inlinePresenceAlternates(suffix);
    if (!parts) {
        return null;
    }
    return parts.length === 1 ? parts[0] : `:is(${parts.join(', ')})`;
}

/**
 * A whole declaration whose VALUE reads a marker custom property, e.g.
 * `stroke: var(--darkreader-inline-fill) !important;`.
 *
 * These cannot be rewritten. They mean "set property P to this element's themed X", and the
 * themed X is per-element — exactly the context a shared declaration key cannot carry. There
 * are four in the catalog, across three sites.
 *
 * They are DELETED rather than left in place. Left alone, `var()` on an undefined property
 * makes the declaration invalid at computed-value time, so the property falls back to
 * inherited or initial — which can actively unset something the page had set. Deleting
 * restores "this site fix does not apply", which is the honest degradation; leaving it in
 * would be an active regression.
 */
const READS_CUSTOM_PROP = /[^;{}]*var\(\s*--darkreader-inline-[a-z-]+\s*\)[^;{}]*(;|(?=\s*\}))/g;

/**
 * A declaration whose PROPERTY is a marker attribute name, e.g.
 * `data-darkreader-inline-fill: var(--scrim-icon-color) !important;`.
 *
 * Malformed — a custom property needs a `--` prefix, so this is dropped by the CSS parser and
 * is already inert upstream. Removed so it cannot mask a real reference in the guard below.
 */
const MARKER_AS_PROPERTY = /[ \t]*data-darkreader-inline-[a-z-]+\s*:[^;{}]*(;|(?=\s*\}))/g;

const SET_CUSTOM_PROP = /--darkreader-inline-([a-z-]+)\s*:/g;
const NEGATED_MARKER = /:not\(\[data-darkreader-inline-([a-z-]+)\]\)/g;
const MARKER_SELECTOR = /\[data-darkreader-inline-([a-z-]+)\]/g;

/**
 * Rewrite catalog CSS so it stops depending on marker attributes we no longer write.
 *
 * Order matters — see the C branch below.
 */
export function rewriteCatalogMarkers(cssText: string): string {
    let out = cssText;

    // D — declarations that READ a marker custom property, and the malformed
    // marker-as-property line. Both are removed; see the patterns above for why deleting is
    // safer than leaving them.
    out = out.replace(MARKER_AS_PROPERTY, '');
    out = out.replace(READS_CUSTOM_PROP, '');

    // C — negated markers. `:not([data-darkreader-inline-bgimage])` becomes a negation of the
    // real presence test. Left unrewritten, this would match everything and over-apply.
    //
    // Handled BEFORE the plain selector form: otherwise the `[data-…]` inside `:not(…)` gets
    // rewritten first and the negation ends up wrapping an `:is()` that was built for a
    // different position.
    //
    // `:not()` takes a full selector list — `:not(a, b)` matches elements matching neither,
    // which is what is wanted here. (Verified in Chromium. An earlier comment claimed a comma
    // inside `:not()` changed the meaning, and used a single-alternative form as a result.)
    //
    // The BROAD presence test, per the note above `styleDeclarationAlternates`: under negation,
    // anything the presence test misses is an element the fix wrongly applies to.
    out = out.replace(NEGATED_MARKER, (match, suffix: string) => {
        const parts = broadPresenceAlternates(suffix);
        return parts ? `:not(${parts.join(', ')})` : match;
    });

    // B — marker used as a selector.
    out = out.replace(MARKER_SELECTOR, (match, suffix: string) => {
        return inlinePresenceSelector(suffix) ?? match;
    });

    // A — rules that SET a marker custom property are LEFT EXACTLY AS WRITTEN.
    //
    // ADR 0005 D5 said to rewrite them into the real property and called that "exactly
    // equivalent". It is not, and the mistake is instructive: the custom property was inert
    // unless the element carried the marker, because the generated marker rule was its only
    // consumer — and that consumer WAS the gate. Rewriting the declaration deletes it, so the
    // fix lands on every element the catalog selector matches. Measured: `<path fill="none">`
    // painted white, an unmarked `<pre>` given a background it never had.
    //
    // The rules we emit consume the property instead (ADR 0006 D4), so the gate is
    // reconstructed rather than approximated and there is nothing here to rewrite.

    return out;
}

/** Every marker suffix the catalog still references — for the test that guards this. */
export function findMarkerSuffixes(cssText: string): string[] {
    const found = new Set<string>();
    for (const re of [SET_CUSTOM_PROP, MARKER_SELECTOR]) {
        for (const m of cssText.matchAll(re)) {
            found.add(m[1]);
        }
    }
    return [...found].sort();
}

/**
 * The marker custom property a themed declaration must read through, or null.
 *
 * This is the inverse of `MARKER_PROPERTIES`, and it is what reconstructs the catalog's gate
 * (ADR 0006 D4). Upstream's `[data-darkreader-inline-fill] { fill: var(--darkreader-inline-fill) }`
 * was the *only* consumer of the catalog's `--darkreader-inline-fill` declarations, and that is
 * what made them apply only to elements the engine had themed. Our emitted rules take over that
 * role: reading the property with the themed value as fallback restores the gate exactly, rather
 * than approximating it with a presence selector — which this module got wrong three times.
 *
 * Derived from the same table the rewrite uses, so the two cannot drift apart.
 */
export function markerCustomProperty(cssProperty: string): string | null {
    for (const suffix of Object.keys(MARKER_PROPERTIES)) {
        if (MARKER_PROPERTIES[suffix] === cssProperty) {
            return `--darkreader-inline-${suffix}`;
        }
    }
    return null;
}
