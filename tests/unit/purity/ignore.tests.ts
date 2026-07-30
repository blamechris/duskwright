import {buildIgnoreQualifier, ignoresEverything} from '../../../src/purity/inline/ignore';
import type {SelectorValidator} from '../../../src/purity/inline/ignore';

// A stub that accepts everything except a marker string. Deliberately narrow: the real
// validator is the browser's parser, asserted separately in the purity spec, and a stub that
// tried to approximate CSS validity would be a worse lie than an obvious one.
const acceptAll: SelectorValidator = () => true;
const reject = (bad: string): SelectorValidator => (sel) => !sel.includes(bad);

describe('buildIgnoreQualifier', () => {
    it('returns empty for no selectors, so callers can append unconditionally', () => {
        expect(buildIgnoreQualifier([], acceptAll)).toBe('');
        expect(buildIgnoreQualifier(['', '   '], acceptAll)).toBe('');
    });

    it('builds a selector list rather than a chain', () => {
        // One :not() with a list is shorter than N chained :not()s and parses the same.
        expect(buildIgnoreQualifier(['.a *', '.b *'], acceptAll)).toBe(':not(.a *, .b *)');
    });

    it('keeps complex selectors intact', () => {
        // The catalog's real shapes: descendant combinators, child combinators, nth-child,
        // attribute selectors, escaped identifiers.
        const real = [
            '.entry-content *',
            '#radix-\\:r2\\: > svg:nth-child(1) *',
            'a[href^="https://play.google.com/store/apps/"] svg *',
        ];
        const out = buildIgnoreQualifier(real, acceptAll);
        for (const sel of real) {
            expect(out).toContain(sel);
        }
    });

    it('trims whitespace around each selector', () => {
        expect(buildIgnoreQualifier(['  .a *  ', '.b'], acceptAll)).toBe(':not(.a *, .b)');
    });

    describe('invalid selectors', () => {
        // The important behaviour. A :not() list is all-or-nothing to the parser, so one bad
        // selector from the synced catalog would invalidate the whole rule — and the rule is
        // our THEMING, not the exclusion. A typo upstream would silently un-theme a
        // declaration across the page.
        it('drops a bad selector instead of poisoning the rule', () => {
            const out = buildIgnoreQualifier(['.good *', '((broken', '.also-good'], reject('((broken'));
            expect(out).toBe(':not(.good *, .also-good)');
        });

        it('returns empty when every selector is invalid', () => {
            expect(buildIgnoreQualifier(['((broken'], reject('((broken'))).toBe('');
        });

        it('validates the selector as it will be used, inside :not()', () => {
            // A selector can parse standalone and still be rejected inside :not(). Validating
            // the standalone form would be testing something we never emit.
            const seen: string[] = [];
            buildIgnoreQualifier(['.a *'], (sel) => {
                seen.push(sel);
                return true;
            });
            expect(seen).toEqual([':not(.a *)']);
        });
    });
});

describe('ignoresEverything', () => {
    it('detects a bare universal ignore', () => {
        expect(ignoresEverything(['*'])).toBe(true);
        expect(ignoresEverything(['.a *', ' * '])).toBe(true);
    });

    it('does not confuse a descendant universal with a bare one', () => {
        // `.a *` ignores a subtree; `*` ignores the page. Treating the first as the second
        // would silently disable inline theming site-wide.
        expect(ignoresEverything(['.a *'])).toBe(false);
        expect(ignoresEverything([])).toBe(false);
    });
});
