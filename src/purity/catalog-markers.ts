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

/**
 * The selector that means "this element has an inline X", now that no marker exists.
 *
 * A presentational attribute where one exists, plus the style-attribute form. Both are needed:
 * `<svg fill="#fff">` carries the attribute, `<svg style="fill:#fff">` carries the declaration,
 * and upstream's marker covered both because it was written in either case.
 */
function inlinePresenceSelector(suffix: string): string | null {
    const styleProp = MARKER_PROPERTIES[suffix];
    if (!styleProp) {
        return null;
    }
    const parts = [`[style*="${styleProp}:"]`];
    // The legacy presentational attributes that upstream also reads.
    if (suffix === 'fill' || suffix === 'stroke' || suffix === 'color') {
        parts.unshift(`[${suffix}]`);
    } else if (suffix === 'bgcolor') {
        parts.unshift('[bgcolor]');
    }
    return parts.join(', ');
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
 * Order matters: the negated form must be handled BEFORE the plain selector form, or the
 * `[data-…]` inside `:not(…)` gets rewritten first and the negation is left wrapping a
 * selector list, which is both wrong and, for `:not()`, a specificity change.
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
    out = out.replace(NEGATED_MARKER, (match, suffix: string) => {
        const styleProp = MARKER_PROPERTIES[suffix];
        // `:not()` takes a selector list, but a comma inside `:not()` changes meaning, so the
        // presence test here is the style-attribute form only. That is the conservative
        // direction: it can leave the rule applying slightly more often than upstream, never
        // less, and the alternative is dropping a site fix entirely.
        return styleProp ? `:not([style*="${styleProp}:"])` : match;
    });

    // B — marker used as a selector.
    out = out.replace(MARKER_SELECTOR, (match, suffix: string) => {
        return inlinePresenceSelector(suffix) ?? match;
    });

    // A — marker used as a custom-property set. The custom property was only ever a handoff to
    // the marker rule, so writing the real property directly is exactly equivalent, and the
    // catalog rule already targets the element itself.
    out = out.replace(SET_CUSTOM_PROP, (match, suffix: string) => {
        const styleProp = MARKER_PROPERTIES[suffix];
        return styleProp ? `${styleProp}:` : match;
    });

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
