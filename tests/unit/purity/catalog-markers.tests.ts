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

    describe('B — marker used as a selector', () => {
        it('replaces it with a real presence test', () => {
            const out = rewriteCatalogMarkers('[data-darkreader-inline-fill] { fill: black !important; }');
            expect(out).toBe(`${FILL_PRESENCE} { fill: black !important; }`);
            expect(out).not.toContain('data-darkreader-inline');
        });

        it('anchors the style form so it cannot match the *-color family', () => {
            // The regression this guards: a bare `[style*="color:"]`, which is the same
            // cross-match keys.ts exists to prevent (ADR 0004 note 2).
            const out = rewriteCatalogMarkers('[data-darkreader-inline-color] { x: y; }');
            expect(out).toContain('[style^="color:"]');
            expect(out).not.toContain('[style*="color:"]');
        });

        it('excludes the attribute values upstream never themed', () => {
            // `none` and `currentColor` are skipped by the colour maths outright, and `url(#g)`
            // fails to parse as a colour — so none of those elements ever carried the marker.
            const out = rewriteCatalogMarkers('[data-darkreader-inline-fill] { x: y; }');
            // In a single `:where()`, not chained `:not()`s — chained ones sum to (0,4,0),
            // measured in Chromium. `:where()` contributes zero, so the rule keeps the (0,1,0)
            // of the marker attribute it replaces.
            expect(out).toContain(':not(:where([fill="none" i], [fill="currentColor" i], [fill^="url(" i]))');
        });

        it('stays a single compound when the marker has a prefix', () => {
            // The bug this guards: a bare comma-separated list splits the rule, and the later
            // alternatives lose the `g` prefix — so the rule stops being scoped and applies far
            // more widely than the site fix intended.
            const out = rewriteCatalogMarkers('g[data-darkreader-inline-fill] { fill: black; }');
            expect(out).toBe(`g${FILL_PRESENCE} { fill: black; }`);
            // Specifically: no comma at paren depth 0. A regex cannot do this — the selector
            // nests `:not(:where(a, b, c))` two deep — and the naive version passed on a
            // selector that was fine and failed on one that was also fine.
            expect(topLevelCommas(out.slice(0, out.indexOf('{')))).toBe(0);
        });

        it('stays scoped inside a descendant selector too', () => {
            const out = rewriteCatalogMarkers('.foo [data-darkreader-inline-color] { x: y; }');
            expect(out).toBe(`.foo ${COLOR_PRESENCE} { x: y; }`);
        });

        it('covers both the attribute and the style-declaration form', () => {
            // Upstream's marker was written in either case, so both must be matched or the
            // fix silently stops applying to half the elements it used to.
            const out = rewriteCatalogMarkers('[data-darkreader-inline-bgcolor] { x: y; }');
            expect(out).toContain('[bgcolor]');
            expect(out).toContain('[style^="background-color:"]');
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
            expect(after).toBe(before);
        });
    });
});
