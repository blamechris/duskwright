import {test, expect, chromium} from '@playwright/test';
import type {Browser, Page} from '@playwright/test';

import {
    parseInlineDeclarations,
    declarationSelector,
    isTier1Safe,
} from '../../src/purity/inline/keys';

// The unit tests next to keys.ts simulate CSS attribute-selector semantics in TypeScript.
// That simulation has already been wrong once — an earlier version asserted substring
// containment regardless of operator, which is not what a browser does, and the test passed
// while proving nothing.
//
// So the load-bearing cases are also asserted against a real Chromium, where `element.matches`
// is ground truth rather than a model of it. Anything in here failing means the simulation and
// the browser have diverged, which is the single most dangerous state for this module.

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

/** Create elements with the given style attributes, return whether each matches `selector`. */
async function matchesEach(selector: string, attrs: string[]): Promise<boolean[]> {
    return page.evaluate(([sel, list]) => {
        const host = document.getElementById('host')!;
        host.innerHTML = '';
        const els = (list as string[]).map((a) => {
            const d = document.createElement('div');
            d.setAttribute('style', a);
            host.appendChild(d);
            return d;
        });
        // Throws on an invalid selector — which is itself a result worth failing on.
        return els.map((e) => e.matches(sel as string));
    }, [selector, attrs] as const);
}

test.describe('derived selectors, against a real browser', () => {
    test('matches the element it was derived from, in every position', async () => {
        const attrs = [
            'color:#333',
            'color:#333;background:#fff',
            'a:1;color:#333;b:2',
            'a:1;color:#333',
            'color: #333 ; background : #fff',
            'color: rgb(51, 51, 51); background-color: rgb(255, 255, 255);',
        ];
        for (const attr of attrs) {
            for (const decl of parseInlineDeclarations(attr)) {
                const [matched] = await matchesEach(declarationSelector(decl), [attr]);
                expect(matched, `${declarationSelector(decl)} should match ${attr}`).toBe(true);
            }
        }
    });

    test('does not match any of the *-color family colliders', async () => {
        // A bare [style*="color:#333"] matches every one of these.
        const colliders = [
            'border-color:#3336',
            'background-color:#333333',
            'caret-color:#3339',
            'outline-color:#333',
            'text-decoration-color:#333',
            'column-rule-color:#333',
        ];
        const themed = parseInlineDeclarations('color:#333')[0];
        const results = await matchesEach(declarationSelector(themed), ['color:#333', ...colliders]);
        expect(results[0]).toBe(true);
        expect(results.slice(1)).toEqual(colliders.map(() => false));
    });

    test('does not match a longer value of the same property', async () => {
        const first = parseInlineDeclarations('color:#333;x:1')[0];
        const [self, longer] = await matchesEach(declarationSelector(first), ['color:#333;x:1', 'color:#3336;x:1']);
        expect(self).toBe(true);
        expect(longer).toBe(false);
    });

    test('survives the data: URI in media-heavy.html without splitting', async () => {
        const attr = 'background-image:url(data:image/png;base64,iVBORw0KGgo=);background-size:cover';
        const decls = parseInlineDeclarations(attr);
        expect(decls.map((d) => d.property)).toEqual(['background-image', 'background-size']);
        for (const d of decls) {
            const [matched] = await matchesEach(declarationSelector(d), [attr]);
            expect(matched).toBe(true);
        }
    });

    test('produces a valid selector for control characters and quotes', async () => {
        // Escaping only LF left CR and FF unescaped, which threw SyntaxError from .matches().
        // Any page can reach this via setAttribute, so it is a real crash.
        for (const attr of ['a:1\rb:2', 'a:1\fb:2', 'a:1\nb:2', 'content:"he said \\"hi\\""', 'content:"a\\\\b"']) {
            for (const d of parseInlineDeclarations(attr)) {
                const sel = declarationSelector(d);
                // The assertion is that this does not throw.
                await expect(matchesEach(sel, [attr]), `invalid selector from ${JSON.stringify(attr)}`)
                    .resolves.toEqual([true]);
            }
        }
    });

    test('a selector cannot be escaped out of by a hostile value', async () => {
        const attr = 'content:"x" i],*{color:red}[style*="';
        for (const d of parseInlineDeclarations(attr)) {
            const results = await matchesEach(declarationSelector(d), [attr, 'color:#333']);
            expect(results[0]).toBe(true);
            // The unrelated element must not be caught by an injected `*` rule.
            expect(results[1]).toBe(false);
        }
    });
});

test.describe('un-keyable shapes are rejected before they can mis-theme', () => {
    test('a duplicated property would otherwise collide with a live declaration', async () => {
        const dead = parseInlineDeclarations('color:#333;color:#444')[0];
        const [dupMatches, liveMatches] = await matchesEach(declarationSelector(dead), [
            'color:#333;color:#444', // renders #444 — the keyed declaration is dead
            'color:#333;background:#fff', // renders #333 — genuinely live
        ]);
        // Both match: that is the collision, and it is why the shape is rejected.
        expect(dupMatches && liveMatches).toBe(true);
        expect(isTier1Safe('color:#333;color:#444')).toBe(false);
    });

    test('var() renders differently under different inherited values, same selector', async () => {
        const decl = parseInlineDeclarations('color:var(--x)')[0];
        const colours = await page.evaluate(([sel]) => {
            const host = document.getElementById('host')!;
            host.innerHTML = '';
            const mk = (varValue: string) => {
                const wrap = document.createElement('div');
                wrap.style.setProperty('--x', varValue);
                const child = document.createElement('div');
                child.setAttribute('style', 'color:var(--x)');
                wrap.appendChild(child);
                host.appendChild(wrap);
                return {colour: getComputedStyle(child).color, matches: child.matches(sel as string)};
            };
            return [mk('#111'), mk('#eee')];
        }, [declarationSelector(decl)] as const);

        expect(colours[0].colour).not.toBe(colours[1].colour);
        expect(colours[0].matches && colours[1].matches).toBe(true);
        expect(isTier1Safe('color:var(--x)')).toBe(false);
    });
});
