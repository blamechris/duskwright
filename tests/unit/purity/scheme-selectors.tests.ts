import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {ColorScheme} from '../../../src/purity/scheme-selectors';
import {resolveSchemeSelectors} from '../../../src/purity/scheme-selectors';

// ADR 0001 item 7 removed the `data-darkreader-scheme` attribute from <html>, because <html>
// is page-owned. Roughly 60 entries in the per-site fixes catalog select on that attribute,
// so they now depend entirely on this transform resolving them statically at emit time.
//
// If this regresses, ~60 site fixes silently stop applying — the exact invisible failure the
// model-delegation policy says to guard hardest. E9 also syncs that catalog on a schedule, so
// a new upstream selector shape can break it without anyone touching this repo.

const CATALOG = join(__dirname, '../../../src/config/dynamic-theme-fixes.config');

describe('resolveSchemeSelectors', () => {
    it('drops the attribute when the scheme matches', () => {
        expect(resolveSchemeSelectors('html[data-darkreader-scheme="dark"] .a {color:red}', 'dark'))
            .toBe('html .a {color:red}');
        expect(resolveSchemeSelectors('html[data-darkreader-scheme="dimmed"] .a {color:red}', 'dimmed'))
            .toBe('html .a {color:red}');
    });

    it('neutralizes the rule when the scheme does not match', () => {
        // `:not(*)` is valid and matches nothing, so the rule survives parsing but never
        // applies. Deleting the rule text instead would require parsing rule boundaries.
        expect(resolveSchemeSelectors('html[data-darkreader-scheme="dimmed"] .a {color:red}', 'dark'))
            .toBe('html:not(*) .a {color:red}');
        expect(resolveSchemeSelectors('html[data-darkreader-scheme="dark"] .a {color:red}', 'dimmed'))
            .toBe('html:not(*) .a {color:red}');
    });

    it('handles unquoted and single-quoted attribute values', () => {
        expect(resolveSchemeSelectors('html[data-darkreader-scheme=dark] .a{}', 'dark')).toBe('html .a{}');
        expect(resolveSchemeSelectors("html[data-darkreader-scheme='dark'] .a{}", 'dark')).toBe('html .a{}');
    });

    it('rewrites every occurrence, not just the first', () => {
        const css = 'html[data-darkreader-scheme="dark"] .a{} html[data-darkreader-scheme="dark"] .b{}';
        expect(resolveSchemeSelectors(css, 'dark')).toBe('html .a{} html .b{}');
    });

    it('leaves unrelated CSS untouched', () => {
        const css = 'html .a{color:red} [data-other="dark"] .b{color:blue}';
        expect(resolveSchemeSelectors(css, 'dark')).toBe(css);
    });

    it('handles every shape the catalog actually uses', () => {
        // These six are the real forms, counted from the catalog. The bare and
        // multi-attribute ones are why this cannot anchor on `html[...]`.
        const cases: Array<[string, ColorScheme, string]> = [
            ['html[data-darkreader-scheme="dark"] .a{}', 'dark', 'html .a{}'],
            ['html[data-darkreader-scheme="dimmed"] .a{}', 'dimmed', 'html .a{}'],
            ['[data-darkreader-scheme="dark"] .a{}', 'dark', ':root .a{}'],
            ['[data-darkreader-scheme="dimmed"] .a{}', 'dimmed', ':root .a{}'],
            ['html[data-theme="dark"][data-darkreader-scheme="dark"] .a{}', 'dark', 'html[data-theme="dark"] .a{}'],
            ['html[data-darkreader-scheme="dark"].light .a{}', 'dark', 'html.light .a{}'],
            // ...and each neutralized when the scheme does not match.
            ['html[data-darkreader-scheme="dimmed"] .a{}', 'dark', 'html:not(*) .a{}'],
            ['[data-darkreader-scheme="dimmed"] .a{}', 'dark', ':not(*) .a{}'],
            ['html[data-theme="dark"][data-darkreader-scheme="dimmed"] .a{}', 'dark', 'html[data-theme="dark"]:not(*) .a{}'],
        ];
        for (const [input, scheme, expected] of cases) {
            expect(resolveSchemeSelectors(input, scheme)).toBe(expected);
        }
    });

    it('leaves no catalog selector depending on an attribute we no longer write', () => {
        const catalog = readFileSync(CATALOG, 'utf8');
        const occurrences = catalog.match(/\[data-darkreader-scheme=/g) ?? [];
        // Guard against the catalog losing them entirely and this test passing vacuously.
        expect(occurrences.length).toBeGreaterThan(50);

        for (const scheme of ['dark', 'dimmed'] as const) {
            const resolved = resolveSchemeSelectors(catalog, scheme);
            // If ANY survives, that many site fixes are silently dead.
            expect(resolved).not.toContain('data-darkreader-scheme');
        }
    });

    it('the catalog contains both dark and dimmed variants, so both branches are exercised', () => {
        const catalog = readFileSync(CATALOG, 'utf8');
        expect(catalog).toContain('html[data-darkreader-scheme="dark"]');
        expect(catalog).toContain('html[data-darkreader-scheme="dimmed"]');
    });
});
