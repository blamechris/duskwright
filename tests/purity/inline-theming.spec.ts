import {test, expect} from '@playwright/test';

import {launchContext} from './harness';
import {startFixtureServers} from '../fixtures/server.mjs';

// **Zero mutations is trivially achievable by theming nothing.**
//
// That is the hole this file closes. `purity.spec.ts` proves the extension does not touch the
// page; nothing there proves it still does its job. An `overrideInlineStyle` that returned
// immediately would pass the entire purity corpus with a perfect score.
//
// So these assert the other half: inline-styled elements are still recolored, they are recolored
// through a stylesheet we own rather than through the element, and the exclusions and per-site
// gates that ride on that mechanism still work. Every assertion is a rendered colour, because
// rendered colour is the only signal that survives a change in how theming is delivered.

const SETTLE_MS = 2200;

let servers: Awaited<ReturnType<typeof startFixtureServers>>;

test.beforeAll(async () => {
    servers = await startFixtureServers();
});

test.afterAll(async () => {
    await servers?.close();
});

interface Probe {
    selector: string;
    color: string;
    backgroundColor: string;
    fill: string;
    /** The element's own `style` attribute, exactly as it reads. */
    styleAttr: string | null;
}

/** Load a fixture with the extension and read back computed styles for the given selectors. */
async function probe(file: string, selectors: string[], extraCSS?: string): Promise<Record<string, Probe>> {
    const context = await launchContext(true);
    try {
        const page = await context.newPage();
        await page.goto(`${servers.pagesOrigin}/${file}`, {waitUntil: 'load'});
        if (extraCSS) {
            // Stands in for a per-site fix from the catalog. Appended as a page-owned sheet on
            // purpose: that is where `--override` sits relative to us in the cascade.
            await page.evaluate((css) => {
                const s = document.createElement('style');
                s.textContent = css as string;
                document.head.appendChild(s);
            }, extraCSS);
        }
        await page.waitForTimeout(SETTLE_MS);
        const out = await page.evaluate((list) => {
            const result: Record<string, unknown> = {};
            for (const selector of list as string[]) {
                const el = document.querySelector(selector);
                if (!el) {
                    continue;
                }
                const cs = getComputedStyle(el);
                result[selector] = {
                    selector,
                    color: cs.color,
                    backgroundColor: cs.backgroundColor,
                    fill: cs.fill,
                    styleAttr: el.getAttribute('style'),
                };
            }
            return result;
        }, selectors);
        await page.close();
        return out as Record<string, Probe>;
    } finally {
        await context.close();
    }
}

/** One computed property for several selectors, for cases the Probe shape does not cover. */
async function probeProperty(file: string, selectors: string[], property: string): Promise<Record<string, string>> {
    const context = await launchContext(true);
    try {
        const page = await context.newPage();
        await page.goto(`${servers.pagesOrigin}/${file}`, {waitUntil: 'load'});
        await page.waitForTimeout(SETTLE_MS);
        const out = await page.evaluate(([list, prop]) => {
            const result: Record<string, string> = {};
            for (const selector of list as string[]) {
                const el = document.querySelector(selector);
                // Recorded as a distinguishable value rather than skipped: a selector that
                // matches nothing must fail an assertion, not quietly drop it.
                result[selector] = el
                    ? getComputedStyle(el).getPropertyValue(prop as string)
                    : '<<no such element>>';
            }
            return result;
        }, [selectors, property] as const);
        await page.close();
        return out;
    } finally {
        await context.close();
    }
}

/** Roughly: is this colour dark? Parses `rgb(r, g, b)` / `rgba(...)`. */
function isDark(colour: string): boolean {
    const m = colour.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) {
        return false;
    }
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
}

test('inline-styled elements are still themed, and their style attribute is untouched', async () => {
    // dense-inline-styles.html is 2,000 elements carrying page-authored `style` attributes.
    const cells = ['#grid .cell:nth-child(1)', '#grid .cell:nth-child(2)', '#grid .cell:nth-child(1000)'];
    const found = await probe('dense-inline-styles.html', cells);
    expect(Object.keys(found)).toEqual(cells);

    for (const p of Object.values(found)) {
        expect(isDark(p.backgroundColor), `${p.selector} background ${p.backgroundColor} is not dark`).toBe(true);
        expect(isDark(p.color), `${p.selector} text ${p.color} should be light on dark`).toBe(false);
        // The point of the whole exercise: the page's own attribute is exactly as it wrote it.
        expect(p.styleAttr, `${p.selector} style attribute was rewritten`).not.toContain('darkreader');
    }
});

test('a shorthand background is themed, not just the longhand form', async () => {
    // The defect ADR 0005 D1 caught: our key sees the authored `background:#fff` while the
    // engine only themes `*-color`, so backgrounds went white on every fixture in the corpus
    // with no test failing. Asserted as a rendered colour so it cannot come back quietly.
    const rows = ['#root > div:nth-child(1)', '#root > div:nth-child(2)'];
    const found = await probe('spa-inline-styles.html', rows);
    expect(Object.keys(found)).toEqual(rows);
    for (const p of Object.values(found)) {
        expect(isDark(p.backgroundColor), `${p.selector} background ${p.backgroundColor} left light`).toBe(true);
    }
});

// NOT asserted here: that `ignoreInlineStyle` excludes an element end to end.
//
// A fixture served from localhost matches no catalog entry, so the engine is never handed any
// ignore selectors and both halves of a pair are themed — correctly. Writing the assertion
// anyway produced a test that failed for a reason unrelated to the exclusion, which is worse
// than not having it.
//
// The chain is covered in two halves instead: `ignore-browser.spec.ts` proves a `:not()` built
// from the catalog's real selector shapes excludes exactly the intended element in Chromium, and
// `engine.tests.ts` proves the engine puts that qualifier on every rule it emits.

test('a per-site fix can still override our theming, on exactly the elements we themed', async () => {
    // ADR 0006 D4. Upstream's catalog rules set `--darkreader-inline-*`, which was inert unless
    // the element carried the engine's marker attribute — that gate is what kept a site fix off
    // elements the engine had not themed. Our emitted rules read the property instead.
    //
    // Two things have to hold at once, and getting either wrong is a shipped regression:
    //   1. an element we themed takes the site fix's colour
    //   2. an element we did NOT theme does not
    const cell = '#grid .cell:nth-child(1)';
    const found = await probe(
        'dense-inline-styles.html',
        [cell, 'h1'],
        '.cell, h1 { --darkreader-inline-color: rgb(1, 240, 1) !important }',
    );
    expect(found[cell]).toBeDefined();
    expect(found[cell].color, 'the site fix did not reach an element we themed').toBe('rgb(1, 240, 1)');
    // ...and the same declaration must NOT reach an element with no inline colour at all,
    // which is the gate upstream's marker attribute provided.
    expect(found['h1'].color, 'the site fix reached an element we never themed').not.toBe('rgb(1, 240, 1)');
});

test('a themed descendant keeps its own colour under a site fix aimed at its ancestor', async () => {
    // The trap in the design above: custom properties INHERIT and the marker attribute did not.
    // Upstream declared the property inline on each themed element, so a themed descendant
    // carried its own value. We declare nothing, so without a reset every themed element under a
    // catalog-targeted ancestor would take the ancestor's fix colour instead of its own.
    const cell = '#grid .cell:nth-child(1)';
    const found = await probe(
        'dense-inline-styles.html',
        [cell],
        'body { --darkreader-inline-color: rgb(1, 240, 1) !important }',
    );
    expect(found[cell]).toBeDefined();
    expect(
        found[cell].color,
        'a site fix on <body> leaked into a themed descendant — the marker property is inheriting',
    ).not.toBe('rgb(1, 240, 1)');
});

test.describe('tier 2 — the legacy presentational attributes', () => {
    // These had NO browser coverage before this block. Every assertion above probes `style`
    // attributes, so `attributeRegistrations()` could have returned `[]`, or `themeAs` and
    // `emitAs` could have been swapped, and the entire purity corpus plus this file would have
    // stayed green while every legacy colour attribute silently stopped being themed. That is
    // exactly the invisible failure the tier-2 spec table was written to prevent.

    test('bgcolor and color are themed, including without the # the spec does not require', async () => {
        const ids = ['#bg-hash', '#bg-bare', '#bg-short', '#bg-named', '#font-color', '#font-bare'];
        const found = await probe('legacy-color-attributes.html', ids);
        expect(Object.keys(found)).toEqual(ids);

        for (const sel of ['#bg-hash', '#bg-bare', '#bg-short', '#bg-named']) {
            expect(
                isDark(found[sel].backgroundColor),
                `${sel} background ${found[sel].backgroundColor} left light — bgcolor not themed`,
            ).toBe(true);
        }
        // `<font color="111111">` is valid and renders dark; the value repair is what lets the
        // colour maths see it at all. Without it the themer is handed `111111`, parses nothing,
        // and the element keeps a near-black foreground on a dark background.
        for (const sel of ['#font-color', '#font-bare']) {
            expect(
                isDark(found[sel].color),
                `${sel} text ${found[sel].color} stayed dark — the value repair did not apply`,
            ).toBe(false);
        }
    });

    test('themeAs and emitAs stay separate — stroke is emitted as stroke', async () => {
        // ADR 0005 D3. `stroke` is themed as a border colour on <line>/<text> and as foreground
        // elsewhere, but must ALWAYS be emitted as `stroke`. Emitting `border-color` on an SVG
        // shape parses fine and paints nothing at all, which no mutation assertion can see.
        const ids = ['#svg-rect', '#svg-line', '#svg-text-stroke'];
        const found = await probe('legacy-color-attributes.html', ids);
        expect(Object.keys(found)).toEqual(ids);

        const stroke = await probeProperty('legacy-color-attributes.html', ids, 'stroke');
        for (const sel of ids) {
            expect(stroke[sel], `${sel} stroke was not themed`).not.toBe('rgb(51, 51, 51)');
            expect(stroke[sel], `${sel} lost its stroke entirely`).not.toBe('none');
        }
    });

    test('fill on <text> is themed; on a shape it is deferred, not guessed', async () => {
        // ADR 0005 D4: a shape's fill modifier depends on measured geometry, so one selector
        // would have to give two answers. Deferring is counted (#78); guessing would be silent
        // mis-theming. <text> is unconditional and therefore keyable.
        const fills = await probeProperty(
            'legacy-color-attributes.html',
            ['#svg-text', '#svg-rect', '#fill-none', '#fill-current'],
            'fill',
        );
        expect(fills['#svg-text'], '<text fill> was not themed').not.toBe('rgb(34, 34, 34)');
        // Not asserted as themed: the shape is deferred on purpose. Asserted as UNCHANGED, so
        // "we started guessing" would fail here rather than pass silently.
        expect(fills['#svg-rect'], 'a shape fill was themed by guesswork').toBe('rgb(255, 255, 255)');
        // `none` and `currentColor` were never themed upstream and must still not be.
        expect(fills['#fill-none']).toBe('none');
    });
});
