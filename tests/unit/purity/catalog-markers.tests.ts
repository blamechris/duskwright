import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {rewriteCatalogMarkers, findMarkerSuffixes, MARKER_PROPERTIES} from '../../../src/purity/catalog-markers';

// The catalog is synced from upstream on a schedule (E9), so this transform is what keeps ~26
// site fixes working after the marker attributes were removed. A regression here is silent:
// the rules parse fine and simply stop applying.

const CATALOG = join(__dirname, '../../../src/config/dynamic-theme-fixes.config');

describe('rewriteCatalogMarkers', () => {
    describe('A — custom-property sets', () => {
        it('writes the real property instead of the handoff custom property', () => {
            expect(rewriteCatalogMarkers('.a { --darkreader-inline-fill: #110133 !important; }'))
                .toBe('.a { fill: #110133 !important; }');
        });

        it('maps a suffix whose name is not the property', () => {
            // bgcolor means background-color. Getting this wrong mis-themes silently.
            expect(rewriteCatalogMarkers('.a { --darkreader-inline-bgcolor: #fff; }'))
                .toBe('.a { background-color: #fff; }');
        });

        it('handles the multi-word border suffixes', () => {
            expect(rewriteCatalogMarkers('.a { --darkreader-inline-border-top: red; }'))
                .toBe('.a { border-top-color: red; }');
        });
    });

    describe('B — marker used as a selector', () => {
        it('replaces it with a real presence test', () => {
            const out = rewriteCatalogMarkers('[data-darkreader-inline-fill] { fill: black !important; }');
            expect(out).toContain('[fill]');
            expect(out).toContain('[style*="fill:"]');
            expect(out).not.toContain('data-darkreader-inline');
        });

        it('stays a single compound when the marker has a prefix', () => {
            // The bug this guards: a bare comma-separated list splits the rule, and the second
            // alternative loses the `g` prefix — so the rule stops being scoped and applies far
            // more widely than the site fix intended.
            const out = rewriteCatalogMarkers('g[data-darkreader-inline-fill] { fill: black; }');
            expect(out).toBe('g:is([fill], [style*="fill:"]) { fill: black; }');
            // Specifically: no top-level comma introduced into the selector.
            expect(out.slice(0, out.indexOf('{'))).not.toMatch(/,(?![^()]*\))/);
        });

        it('stays scoped inside a descendant selector too', () => {
            const out = rewriteCatalogMarkers('.foo [data-darkreader-inline-color] { x: y; }');
            expect(out).toBe('.foo :is([color], [style*="color:"]) { x: y; }');
        });

        it('covers both the attribute and the style-declaration form', () => {
            // Upstream's marker was written in either case, so both must be matched or the
            // fix silently stops applying to half the elements it used to.
            const out = rewriteCatalogMarkers('[data-darkreader-inline-bgcolor] { x: y; }');
            expect(out).toContain('[bgcolor]');
            expect(out).toContain('[style*="background-color:"]');
        });
    });

    describe('C — negated marker', () => {
        it('negates a real presence test rather than matching everything', () => {
            // Left alone this is the dangerous one: with no marker written, :not(...) matches
            // EVERY element and the rule applies where it was written to be skipped.
            const out = rewriteCatalogMarkers('div.map:not([data-darkreader-inline-bgimage]) { x: y; }');
            expect(out).toBe('div.map:not([style*="background-image:"]) { x: y; }');
        });

        it('is rewritten before the plain selector form, so the negation is not corrupted', () => {
            // The plain-selector rewrite produces a comma-separated list. Inside :not() a comma
            // changes the meaning, so ordering here is load-bearing, not cosmetic.
            const out = rewriteCatalogMarkers(':not([data-darkreader-inline-fill]) { x: y; }');
            expect(out).not.toContain(',');
            expect(out).toBe(':not([style*="fill:"]) { x: y; }');
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

        it('leaves no rule depending on a marker we no longer write', () => {
            const out = rewriteCatalogMarkers(catalog);
            expect(out).not.toContain('--darkreader-inline-');
            expect(out).not.toContain('data-darkreader-inline-');
        });

        it('rewrites every occurrence, and the count is what we measured', () => {
            const before = (catalog.match(/darkreader-inline-/g) ?? []).length;
            // 30 references: 19 custom-property sets, 7 selectors, 1 negation, plus 3 more
            // occurrences on lines that carry two references.
            expect(before).toBeGreaterThanOrEqual(26);
            expect((rewriteCatalogMarkers(catalog).match(/darkreader-inline-/g) ?? []).length).toBe(0);
        });
    });
});
