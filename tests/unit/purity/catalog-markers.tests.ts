import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {rewriteCatalogMarkers, findMarkerSuffixes, MARKER_PROPERTIES, markerCustomProperty} from '../../../src/purity/catalog-markers';

// The catalog is synced from upstream on a schedule (E9), so this transform is what keeps ~26
// site fixes working after the marker attributes were removed. A regression here is silent:
// the rules parse fine and simply stop applying.

const CATALOG = join(__dirname, '../../../src/config/dynamic-theme-fixes.config');

/** Commas at paren depth 0 — i.e. is this a selector LIST rather than one compound? */
function topLevelCommas(selector: string): number {
    let depth = 0;
    let count = 0;
    for (const c of selector) {
        if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
        } else if (c === ',' && depth === 0) {
            count++;
        }
    }
    return count;
}

describe('rewriteCatalogMarkers', () => {
    describe('A — custom-property sets are LEFT ALONE', () => {
        // ADR 0005 D5 said to rewrite these into the real property and called it "exactly
        // equivalent". It is not: the custom property was inert unless the element carried the
        // marker, because the generated marker rule was its only consumer — and that consumer
        // WAS the gate on "did the engine theme this element?". Rewriting deletes the gate.
        //
        // Our emitted rules consume the property instead (ADR 0006 D4), so there is nothing to
        // rewrite. These tests exist to stop the old behaviour coming back.
        it('leaves a custom-property set exactly as written', () => {
            const css = '.a { --darkreader-inline-fill: #110133 !important; }';
            expect(rewriteCatalogMarkers(css)).toBe(css);
        });

        it('leaves the multi-word border suffixes alone too', () => {
            const css = '.a { --darkreader-inline-border-top: red; }';
            expect(rewriteCatalogMarkers(css)).toBe(css);
        });

        it('does not turn the set into the real property', () => {
            // The specific regression: `--darkreader-inline-bgcolor: #fff` becoming
            // `background-color: #fff`, which applies to every element the selector matches.
            const out = rewriteCatalogMarkers('pre { --darkreader-inline-bgcolor: royalblue !important; }');
            expect(out).not.toContain('background-color:');
            expect(out).toContain('--darkreader-inline-bgcolor: royalblue !important');
        });
    });

    // The presence tests, written out once by hand. Recomputing them from the module's own
    // helpers would assert that the code equals itself.
    //
    // Two properties matter and neither is visible by reading the string:
    //   - the style form is anchored at the LEFT declaration boundary, or `[style*="color:"]`
    //     also matches `background-color:`, `border-color:` and `caret-color:`
    //   - the attribute form excludes the values upstream never themed, or `[fill]` reaches
    //     `fill="none"` and `fill="url(#g)"` and repaints elements the marker never touched
    // Both are verified against a real parser in tests/purity/catalog-markers-browser.spec.ts.
    const FILL_PRESENCE = ':is([fill]:not(:where([fill="none" i], [fill="currentColor" i], [fill^="url(" i])), '
        + '[style^="fill:"], [style*=";fill:"], [style*="; fill:"])';
    const COLOR_PRESENCE = ':is([color], [style^="color:"], [style*=";color:"], [style*="; color:"])';
    // The NEGATED form is deliberately BROAD — unanchored and value-blind. Under `:not()`,
    // every element the presence test misses is one the fix wrongly applies to, so the two
    // directions want opposite errors. See the note above `styleDeclarationAlternates`.
    const BGIMAGE_BROAD = '[style*="background-image:"]';
    const FILL_BROAD = '[fill], [style*="fill:"]';

    describe('B — marker used as a selector, collapsed into a property set', () => {
        // The rule is rewritten to SET the marker custom property, which the rules we emit
        // already consume (ADR 0006 D4). That is exact where a presence selector could only
        // approximate: the property is read on exactly the elements we themed.
        //
        // It is automatically right for properties we no longer theme at all, too — nothing
        // reads the property there, so the fix is inert, which is what upstream's unwritten
        // marker would have produced. The presence-test version over-applied instead: measured,
        // `[data-darkreader-inline-bgimage] { background-image: none }` wiped the background of
        // every element with an inline `background-image:`, where upstream marked only
        // <html>/<body>.
        it('sets the custom property instead of the real one', () => {
            expect(rewriteCatalogMarkers('[data-darkreader-inline-fill] { fill: black !important; }'))
                .toBe('* { --darkreader-inline-fill: black !important; }');
        });

        it('keeps the rest of the compound and the rest of the selector', () => {
            expect(rewriteCatalogMarkers('g[data-darkreader-inline-fill] { fill: black; }'))
                .toBe('g { --darkreader-inline-fill: black; }');
            expect(rewriteCatalogMarkers('a title + g[data-darkreader-inline-fill] { fill: red; }'))
                .toBe('a title + g { --darkreader-inline-fill: red; }');
            expect(rewriteCatalogMarkers('.foo [data-darkreader-inline-color] { color: red; }'))
                .toBe('.foo * { --darkreader-inline-color: red; }');
        });

        it('maps a suffix whose name is not the property', () => {
            expect(rewriteCatalogMarkers('[data-darkreader-inline-bgimage] { background-image: none !important; }'))
                .toBe('* { --darkreader-inline-bgimage: none !important; }');
        });

        it('survives the ${} colour templates, which contain braces', () => {
            // A body pattern of `[^{}]*` stops at the first `${` and silently matches nothing,
            // leaving the rule on the presence-test fallback with no test failing.
            expect(rewriteCatalogMarkers('[data-darkreader-inline-fill] { fill: ${white} !important; }'))
                .toBe('* { --darkreader-inline-fill: ${white} !important; }');
        });

        it('leaves the body\'s own whitespace exactly as the catalog wrote it', () => {
            // The catalog is synced. Reformatting it is churn in every future diff.
            const css = '[data-darkreader-inline-fill] {\n    fill: #dcdad7 !important;\n}';
            expect(rewriteCatalogMarkers(css)).toBe('* {\n    --darkreader-inline-fill: #dcdad7 !important;\n}');
        });

        it('renames case-insensitively, matching the guard that let the rule through', () => {
            // CSS property names are case-insensitive, so `COLOR: red` passes the guard. A
            // case-sensitive rename then left the body untouched while the marker was still
            // stripped from the selector — `* { COLOR: red }`, ungated onto every element.
            // Not reachable from today's catalog; the catalog is synced.
            expect(rewriteCatalogMarkers('[data-darkreader-inline-color] { COLOR: red; }'))
                .toBe('* { --darkreader-inline-color: red; }');
            expect(rewriteCatalogMarkers('[data-darkreader-inline-fill] { Fill: black; }'))
                .toBe('* { --darkreader-inline-fill: black; }');
        });

        it('REFUSES a rule that declares anything else, rather than ungating it', () => {
            // Upstream gated the WHOLE rule on the marker. Moving only the matching declaration
            // would leave the others applying unconditionally — a silent widening.
            //
            // The fallback is the presence test, which can over- or under-apply but cannot
            // ungate anything. No catalog rule needs it today; a synced one might, so its shape
            // is still asserted here — it is the only place it now ships.
            const css = '[data-darkreader-inline-fill] { fill: black; opacity: 0.5; }';
            const out = rewriteCatalogMarkers(css);
            expect(out).toContain('opacity: 0.5');
            expect(out).not.toContain('--darkreader-inline-fill:');
            expect(out).toBe(`${FILL_PRESENCE} { fill: black; opacity: 0.5; }`);
            // And it stays ONE compound, so a prefix cannot be lost from a later alternative.
            expect(topLevelCommas(out.slice(0, out.indexOf('{')))).toBe(0);
            expect(rewriteCatalogMarkers('.a [data-darkreader-inline-color] { color: red; z-index: 1; }'))
                .toBe(`.a ${COLOR_PRESENCE} { color: red; z-index: 1; }`);
        });
    });

    describe('C — negated marker', () => {
        it('negates a real presence test rather than matching everything', () => {
            // Left alone this is the dangerous one: with no marker written, :not(...) matches
            // EVERY element and the rule applies where it was written to be skipped.
            const out = rewriteCatalogMarkers('div.map:not([data-darkreader-inline-bgimage]) { x: y; }');
            expect(out).toBe(`div.map:not(${BGIMAGE_BROAD}) { x: y; }`);
        });

        it('negates every alternative, not just one of them', () => {
            // `:not(a, b)` matches elements matching NEITHER — Selectors 4, verified in Chromium.
            // An earlier version of this module believed a comma inside `:not()` changed the
            // meaning and shipped a single-alternative negation as a result.
            const out = rewriteCatalogMarkers(':not([data-darkreader-inline-fill]) { x: y; }');
            expect(out).toBe(`:not(${FILL_BROAD}) { x: y; }`);
        });

        it('uses the BROAD presence test, not the narrow positive one', () => {
            // Anchoring the negated form inverts its failure mode: every declaration shape the
            // anchor misses becomes an element the fix applies to, overriding the page's own
            // inline style. Measured on 4 of 5 real shapes (#80).
            const out = rewriteCatalogMarkers(':not([data-darkreader-inline-color]) { x: y; }');
            expect(out).toContain('[style*="color:"]');
            expect(out).not.toContain('[style^="color:"]');
        });

        it('is rewritten before the plain selector form, so the negation is not nested', () => {
            // Handling the plain form first would leave `:not(:is(...))` — valid, but a
            // different specificity and a needless layer.
            const out = rewriteCatalogMarkers(':not([data-darkreader-inline-fill]) { x: y; }');
            expect(out).not.toContain(':not(:is(');
        });
    });

    describe('D — declarations that READ a marker property', () => {
        it('deletes them rather than leaving an undefined var()', () => {
            // `var()` on an undefined property makes the declaration invalid at computed-value
            // time, so the property falls back to inherited/initial — which can actively unset
            // something the page had. Deleting degrades to "the fix does not apply", which is
            // honest; leaving it in is an active regression.
            const css = '.a { stroke: var(--darkreader-inline-fill) !important;\n  color: red; }';
            const out = rewriteCatalogMarkers(css);
            expect(out).not.toContain('darkreader-inline');
            expect(out).toContain('color: red');
        });

        it('deletes the malformed marker-as-property line', () => {
            // A custom property needs a `--` prefix, so this is already inert upstream.
            const css = '.a {\n  data-darkreader-inline-fill: var(--x) !important;\n  color: red;\n}';
            const out = rewriteCatalogMarkers(css);
            expect(out).not.toContain('darkreader-inline');
            expect(out).toContain('color: red');
        });
    });

    it('leaves unrelated CSS untouched', () => {
        const css = '.a { color: red; } [data-other] { x: y; }';
        expect(rewriteCatalogMarkers(css)).toBe(css);
    });

    it('leaves an unknown marker suffix alone rather than guessing', () => {
        const css = '[data-darkreader-inline-notathing] { x: y; }';
        expect(rewriteCatalogMarkers(css)).toBe(css);
    });

    describe('against the real catalog', () => {
        const catalog = readFileSync(CATALOG, 'utf8');

        it('every suffix the catalog uses has a known property mapping', () => {
            const suffixes = findMarkerSuffixes(catalog);
            // Guards against the catalog losing them and this suite passing vacuously.
            expect(suffixes.length).toBeGreaterThan(0);
            const unmapped = suffixes.filter((s) => !(s in MARKER_PROPERTIES));
            expect({unmapped, suffixes}).toEqual({unmapped: [], suffixes});
        });

        it('every suffix the catalog SETS has a consumer in the rules we emit', () => {
            // This is the gate. A `--darkreader-inline-X` the emitter never reads is a site fix
            // that parses, applies to nothing, and fails silently — which is exactly what the
            // whole branch-A rewrite was trying to avoid, the wrong way.
            const set = [...new Set(
                [...catalog.matchAll(/--darkreader-inline-([a-z-]+)\s*:/g)].map((m) => m[1]),
            )].sort();
            expect(set.length).toBeGreaterThan(0);
            const orphaned = set.filter(
                (suffix) => markerCustomProperty(MARKER_PROPERTIES[suffix]) !== `--darkreader-inline-${suffix}`,
            );
            expect({orphaned, set}).toEqual({orphaned: [], set});
        });

        it('leaves no rule depending on a marker ATTRIBUTE, which nothing writes any more', () => {
            const out = rewriteCatalogMarkers(catalog);
            expect(out).not.toContain('data-darkreader-inline-');
        });

        it('keeps the custom-property sets, which are how the gate still works', () => {
            // The inverse of the assertion above, and the one that would have caught ADR 0005
            // D5's mistake: these must SURVIVE the rewrite.
            const before = (catalog.match(/--darkreader-inline-[a-z-]+\s*:/g) ?? []).length;
            const after = (rewriteCatalogMarkers(catalog).match(/--darkreader-inline-[a-z-]+\s*:/g) ?? []).length;
            expect(before).toBeGreaterThanOrEqual(19);
            // 19 already there, plus the 6 marker-selecting rules collapsed into the same form.
            expect(after).toBe(before + 6);
        });
    });
});
