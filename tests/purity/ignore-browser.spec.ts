import {test, expect, chromium} from '@playwright/test';
import type {Browser, Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildIgnoreQualifier} from '../../src/purity/inline/ignore';
import {parseInlineDeclarations, declarationSelector} from '../../src/purity/inline/keys';
import {createTableExpander} from '../../src/purity/inline/expand';
import type {Expander} from '../../src/purity/inline/expand';

// `fixes.ignoreInlineStyle` opts a region out of inline theming, and 229 catalog sites use it.
// Upstream implements it as a per-element early return. Under declaration keying there is no
// early return available — an ignored element and a non-ignored element with the same `style`
// text share one rule — so the exclusion has to move into the selector.
//
// ADR 0005 names this "the single most likely thing to be missed", and dropping it silently
// re-themes opted-out regions on those 229 sites. So this asserts the thing that would actually
// break: that the rule we emit for a declaration matches the element outside the ignored region
// and does NOT match the byte-identical one inside it.
//
// The selectors and the element pairs are read from the fixture rather than copied here. A copy
// drifts, and a drifted copy is a test that passes while proving nothing.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(HERE, '../fixtures/pages/ignore-inline-style.html');

let browser: Browser;
let page: Page;
let ignoreSelectors: string[];
let pairs: Array<[string, string]>;
let expand: Expander;

test.beforeAll(async () => {
    browser = await chromium.launch({headless: true, channel: 'chromium'});
    page = await browser.newPage();
    await page.setContent(readFileSync(FIXTURE, 'utf8'));
    ignoreSelectors = await page.evaluate(() => (window as any).__ignoreInlineStyle);
    pairs = await page.evaluate(() => (window as any).__ignorePairs);

    // `Expander` is synchronous and `parseInlineDeclarations` runs in this Node process, so the
    // expansion has to be a table. It is RECORDED from the real browser rather than written by
    // hand: a hand-written table is a stub, and a stub friendlier than the real expander is
    // precisely how the shorthand defect reached merge (ADR 0005 D1). Crude `;`/`:` splitting
    // is fine here — the fixture has no values containing either.
    const table = await page.evaluate((ids) => {
        const probe = document.createElement('div');
        const out: Record<string, Array<{property: string; value: string}>> = {};
        for (const id of ids as string[]) {
            const attr = document.getElementById(id)?.getAttribute('style') ?? '';
            for (const part of attr.split(';')) {
                const colon = part.indexOf(':');
                if (colon === -1) {
                    continue;
                }
                const property = part.slice(0, colon).trim();
                const value = part.slice(colon + 1).trim();
                probe.style.cssText = '';
                probe.style.cssText = `${property}: ${value}`;
                const longhands: Array<{property: string; value: string}> = [];
                for (let i = 0; i < probe.style.length; i++) {
                    const name = probe.style[i];
                    const expanded = probe.style.getPropertyValue(name);
                    if (expanded !== 'initial') {
                        longhands.push({property: name, value: expanded});
                    }
                }
                out[`${property}|${value}`] = longhands;
            }
        }
        return out;
    }, pairs.flat());
    expand = createTableExpander(table);
});

test.afterAll(async () => {
    await browser?.close();
});

/** The real check: the browser's own parser, exactly as the engine uses it. */
async function isValid(selector: string): Promise<boolean> {
    return page.evaluate((sel) => {
        try {
            document.createDocumentFragment().querySelector(sel as string);
            return true;
        } catch {
            return false;
        }
    }, selector);
}

test('the fixture actually declares the selectors and pairs this suite needs', () => {
    // Guards against the whole file passing vacuously if the fixture stops exporting them.
    expect(ignoreSelectors.length).toBeGreaterThan(0);
    expect(pairs.length).toBeGreaterThan(0);
});

test('each pair really does carry a byte-identical style attribute', async () => {
    // If they differ, the two elements get different rules and the exclusion is never exercised
    // — the fixture would look right and test nothing.
    for (const [ignored, themed] of pairs) {
        const [a, b] = await page.evaluate(([x, y]) => [
            document.getElementById(x as string)!.getAttribute('style'),
            document.getElementById(y as string)!.getAttribute('style'),
        ], [ignored, themed] as const);
        expect(a, `${ignored} vs ${themed}`).toBe(b);
        expect(a).toBeTruthy();
    }
});

test('every catalog-shaped selector in the fixture survives validation inside :not()', async () => {
    // A selector dropped here is an exclusion that silently stops applying. These are the real
    // shapes: descendant, child combinator, attribute selector in the chain, escaped identifier.
    const validity = await Promise.all(ignoreSelectors.map((s) => isValid(`:not(${s})`)));
    expect(Object.fromEntries(ignoreSelectors.map((s, i) => [s, validity[i]])))
        .toEqual(Object.fromEntries(ignoreSelectors.map((s) => [s, true])));
});

test('the emitted rule themes the outside element and excludes the ignored one', async () => {
    const validities = await Promise.all(
        ignoreSelectors.map((s) => isValid(`:not(${s})`)),
    );
    const qualifier = buildIgnoreQualifier(
        ignoreSelectors,
        (sel) => validities[ignoreSelectors.findIndex((s) => `:not(${s})` === sel)] ?? false,
    );
    expect(qualifier).not.toBe('');

    for (const [ignored, themed] of pairs) {
        const attr = await page.evaluate(
            (id) => document.getElementById(id as string)!.getAttribute('style'),
            themed,
        );
        const declarations = parseInlineDeclarations(attr!, expand);
        expect(declarations.length, `no keyable declaration in ${attr}`).toBeGreaterThan(0);

        for (const decl of declarations) {
            const selector = `${declarationSelector(decl)}${qualifier}`;
            const [hitsThemed, hitsIgnored] = await page.evaluate(([sel, t, i]) => [
                document.getElementById(t as string)!.matches(sel as string),
                document.getElementById(i as string)!.matches(sel as string),
            ], [selector, themed, ignored] as const);

            expect(hitsThemed, `${selector} should theme #${themed}`).toBe(true);
            expect(hitsIgnored, `${selector} must NOT reach #${ignored}`).toBe(false);
        }
    }
});

test('without the qualifier the same rule reaches both — the exclusion is what does the work', async () => {
    // The control. If this ever fails, the test above is passing for some reason other than the
    // exclusion, and the suite has stopped measuring what it claims to.
    for (const [ignored, themed] of pairs) {
        const attr = await page.evaluate(
            (id) => document.getElementById(id as string)!.getAttribute('style'),
            themed,
        );
        for (const decl of parseInlineDeclarations(attr!, expand)) {
            const selector = declarationSelector(decl);
            const [hitsThemed, hitsIgnored] = await page.evaluate(([sel, t, i]) => [
                document.getElementById(t as string)!.matches(sel as string),
                document.getElementById(i as string)!.matches(sel as string),
            ], [selector, themed, ignored] as const);
            expect(hitsThemed && hitsIgnored, `${selector} should reach both without :not()`).toBe(true);
        }
    }
});
