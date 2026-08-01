import {test, expect, chromium} from '@playwright/test';
import type {Browser, Page} from '@playwright/test';

import {rewriteCatalogMarkers} from '../../src/purity/catalog-markers';

// The catalog marker rewrite decides which elements ~26 site fixes reach. Every claim it makes
// is a claim about CSS matching, and this module has twice shipped a selector that was valid,
// parsed fine, and matched the wrong set of elements:
//
//   - a bare comma list that dropped the `g` prefix off half a compound
//   - `[style*="color:"]`, which also matches `background-color:` and `border-color:`
//
// Neither is detectable by reading the string. Both are one `element.matches()` away from
// obvious. So the load-bearing claims are asserted against a real parser, not a description
// of one.

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
    browser = await chromium.launch({headless: true, channel: 'chromium'});
    page = await browser.newPage();
    await page.setContent('<div id="host"></div>');
});

test.afterAll(async () => {
    await browser?.close();
});

/** Build each element from an HTML string, return whether it matches `selector`. */
async function matchesEach(selector: string, html: string[]): Promise<boolean[]> {
    return page.evaluate(([sel, items]) => {
        const host = document.getElementById('host')!;
        host.innerHTML = (items as string[]).join('');
        return Array.from(host.children).map((el) => el.matches(sel as string));
    }, [selector, html] as const);
}

/** The selector a rewritten rule ends up with, extracted from its CSS text. */
function selectorOf(css: string): string {
    return css.slice(0, css.indexOf('{')).trim();
}

test.describe('the style-declaration presence test is anchored', () => {
    test('does not match the *-color family it is not about', async () => {
        // The finding: `[style*="color:"]` matches every `*-color` property. On the one catalog
        // rule using this marker that means the fix lands on elements that merely have a border
        // or a background colour set inline.
        const selector = selectorOf(rewriteCatalogMarkers('[data-darkreader-inline-color] { x: y }'));
        const results = await matchesEach(selector, [
            '<div style="color:#333"></div>',
            '<div style="a:1;color:#333"></div>',
            '<div style="a:1; color:#333"></div>',
            '<div style="background-color:#333"></div>',
            '<div style="border-color:#333"></div>',
            '<div style="caret-color:#333"></div>',
            '<div style="a:1;outline-color:#333"></div>',
        ]);
        expect(results).toEqual([true, true, true, false, false, false, false]);
    });

    test('matches the CSSOM re-serialized form, which is the common one', async () => {
        // Anything the page touched through the CSSOM comes back as `prop: value; prop: value`.
        // Matching only the tight `;prop:` form would miss most real pages.
        const selector = selectorOf(rewriteCatalogMarkers('[data-darkreader-inline-fill] { x: y }'));
        const [reserialized] = await page.evaluate(([sel]) => {
            const d = document.createElement('div');
            d.style.setProperty('opacity', '1');
            d.style.setProperty('fill', 'rgb(1, 2, 3)');
            document.getElementById('host')!.appendChild(d);
            return [d.matches(sel as string)];
        }, [selector] as const);
        expect(reserialized).toBe(true);
    });
});

test.describe('the presentational-attribute presence test excludes what was never themed', () => {
    test('skips none, currentColor and url() fills', async () => {
        // Upstream wrote its marker only when the colour maths produced a value. `none` and
        // `currentColor` are skipped outright and `url(#g)` fails to parse as a colour, so none
        // of those elements ever carried the marker. photopea.com is an all-SVG UI carrying one
        // of these rules; over-matching repaints its whole interface.
        const selector = selectorOf(rewriteCatalogMarkers('[data-darkreader-inline-fill] { x: y }'));
        const results = await matchesEach(selector, [
            '<svg fill="#fff"></svg>',
            '<svg fill="none"></svg>',
            '<svg fill="currentColor"></svg>',
            '<svg fill="currentcolor"></svg>',
            '<svg fill="url(#g)"></svg>',
        ]);
        expect(results).toEqual([true, false, false, false, false]);
    });
});

test.describe('scope is preserved wherever the marker sat', () => {
    test('a prefixed compound stays scoped to its element type', async () => {
        // `a title + g[data-darkreader-inline-fill]` is a real catalog rule.
        const selector = selectorOf(rewriteCatalogMarkers('g[data-darkreader-inline-fill] { x: y }'));
        const results = await matchesEach(selector, [
            '<svg><g fill="#fff"></g></svg>', // wrapper is the <svg>; see below
        ]);
        expect(results[0]).toBe(false); // the <svg> itself must not match a `g`-scoped rule

        const inner = await page.evaluate(([sel]) => {
            const host = document.getElementById('host')!;
            host.innerHTML = '<svg><g fill="#fff"></g><rect fill="#fff"></rect></svg>';
            const svg = host.firstElementChild!;
            return [svg.children[0].matches(sel as string), svg.children[1].matches(sel as string)];
        }, [selector] as const);
        expect(inner).toEqual([true, false]);
    });

    test('the negated form excludes every alternative, not just one', async () => {
        // `:not(a, b)` matches elements matching NEITHER — verified here rather than asserted,
        // because an earlier comment in this module claimed the opposite and shipped a
        // deliberately narrower negation as a result.
        const selector = selectorOf(
            rewriteCatalogMarkers('div.map:not([data-darkreader-inline-bgimage]) { x: y }'),
        );
        const results = await matchesEach(selector, [
            '<div class="map"></div>',
            '<div class="map" style="background-image:url(a)"></div>',
            '<div class="map" style="a:1; background-image:url(a)"></div>',
            '<div class="map" style="color:#333"></div>',
        ]);
        expect(results).toEqual([true, false, false, true]);
    });
});

test('every rewritten catalog selector is one the parser accepts', async () => {
    // A rewrite that produces an invalid selector drops the whole rule silently — the sheet
    // still parses, that one fix just stops existing. Asserted over the real catalog.
    const {readFileSync} = await import('node:fs');
    const {join} = await import('node:path');
    const {fileURLToPath} = await import('node:url');
    const here = fileURLToPath(new URL('.', import.meta.url));
    const catalog = readFileSync(join(here, '../../src/config/dynamic-theme-fixes.config'), 'utf8');

    const rewritten = rewriteCatalogMarkers(catalog);
    const selectors = [...new Set(
        [...rewritten.matchAll(/^(.*?(?::is\(|:not\()[^\n{]*)\{/gm)].map((m) => m[1].trim()),
    )].filter((s) => s.includes('[style') || s.includes('[fill]') || s.includes('[stroke]'));

    expect(selectors.length).toBeGreaterThan(0);
    const invalid = await page.evaluate((list) => {
        return (list as string[]).filter((sel) => {
            try {
                document.createDocumentFragment().querySelector(sel);
                return false;
            } catch {
                return true;
            }
        });
    }, selectors);
    expect(invalid).toEqual([]);
});

test.describe('specificity, which matching assertions cannot see', () => {
    // The marker this replaces was `[data-darkreader-inline-fill]` — a single attribute
    // selector, (0,1,0). Anything heavier lets these rules win author `!important` fights
    // upstream lost, silently and only on pages that have such a fight.
    //
    // Measured rather than reasoned about, because reasoning got it wrong twice: chained
    // `:not()`s SUM, so `[fill]:not(a):not(b):not(c)` is (0,4,0) and beats `.c1.c2.c3`.

    /** Does `selector` beat `rival` when both carry !important and `rival` is declared later? */
    async function beats(selector: string, rival: string): Promise<boolean> {
        return page.evaluate(([sel, riv]) => {
            const host = document.getElementById('host')!;
            // The marker attribute is present so the control selector actually MATCHES. Without
            // it, `beats('[data-darkreader-inline-fill]', '.c1')` returned false because the
            // selector matched nothing at all — the right answer, measured from nothing.
            host.innerHTML =
                '<svg class="c1 c2 c3 c4" fill="#fff" style="color:#333" data-darkreader-inline-fill></svg>';
            const style = document.createElement('style');
            style.textContent = `${sel} { opacity: 0.25 !important } ${riv} { opacity: 0.75 !important }`;
            document.head.appendChild(style);
            const won = getComputedStyle(host.firstElementChild!).opacity === '0.25';
            style.remove();
            return won;
        }, [selector, rival] as const);
    }

    test('the fill presence test is no heavier than the marker it replaces', async () => {
        const selector = selectorOf(rewriteCatalogMarkers('[data-darkreader-inline-fill] { x: y }'));
        // A single class outranks a single attribute selector, so this must lose to `.c1` —
        // exactly as `[data-darkreader-inline-fill]` did.
        expect(await beats(selector, '.c1'), `${selector} outranks a single class`).toBe(false);
        // The control, on an element that really carries the marker: same answer, so the two
        // are being compared rather than one of them silently measuring nothing.
        expect(await beats('[data-darkreader-inline-fill]', '.c1')).toBe(false);
        expect(await beats('[data-darkreader-inline-fill]', 'svg'), 'the control matches nothing').toBe(true);
    });

    test('the color presence test is no heavier either', async () => {
        const selector = selectorOf(rewriteCatalogMarkers('[data-darkreader-inline-color] { x: y }'));
        expect(await beats(selector, '.c1')).toBe(false);
    });
});

test.describe('the negated form is deliberately broad', () => {
    // Under `:not()` the failure modes invert: an element the presence test MISSES is one the
    // fix wrongly applies to, overriding the page's own inline style. So the negated form is
    // unanchored and value-blind, the opposite of the positive one.
    test('still excludes declaration shapes the anchored form would miss', async () => {
        const selector = selectorOf(
            rewriteCatalogMarkers('div.map:not([data-darkreader-inline-bgimage]) { x: y; }'),
        );
        const results = await matchesEach(selector, [
            '<div class="map"></div>',
            '<div class="map" style="a:1;\tbackground-image:url(a)"></div>',
            '<div class="map" style="a:1;\nbackground-image:url(a)"></div>',
            '<div class="map" style="a:1;  background-image:url(a)"></div>',
            '<div class="map" style=" background-image:url(a)"></div>',
        ]);
        // Only the element with no inline background-image at all may match.
        expect(results).toEqual([true, false, false, false, false]);
    });
});
