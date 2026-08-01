import {
    attributeRegistrations,
    deferredWork,
    normalizeBgcolorAttr,
    normalizeColorAttr,
    InlineStyleEngine,
} from '../../../src/purity/inline/engine';
import type {ElementFacts, InlineThemer} from '../../../src/purity/inline/engine';
import {createTableExpander} from '../../../src/purity/inline/expand';

// The decision layer of the inline engine, tested without a DOM on purpose.
//
// This repo has no jsdom, and adding one to fake SVGTextElement / SVGLineElement would be the
// exact failure this module has already paid for four times: a stub friendlier than the thing
// it replaces, so the test passes on code the browser rejects. So the DOM read is one function
// (`readElementFacts`) asserted against real Chromium in tests/purity, and everything that
// DECIDES anything is pure and asserted here.
//
// What lives here is the tier-2 spec table. Getting it wrong is invisible: `themeAs` and
// `emitAs` swapped still produces a rule that parses and applies — it just paints the wrong
// property, or nothing at all (ADR 0005 D3).

const plain: ElementFacts = {
    style: null,
    bgcolor: null,
    color: null,
    stopColor: null,
    fill: null,
    stroke: null,
    isSVG: false,
    isSVGText: false,
    isSVGLine: false,
    isSVGRoot: false,
    isMaskIconLink: false,
    className: null,
    parentClassName: null,
};

const facts = (over: Partial<ElementFacts>): ElementFacts => ({...plain, ...over});

/** The registration for one attribute slot, identified the way the emitter identifies it. */
function slot(list: ReturnType<typeof attributeRegistrations>, attrName: string, emitAs: string) {
    return list.find((r) => r.attrName === attrName && r.spec.emitAs === emitAs);
}

describe('attributeRegistrations', () => {
    it('registers every slot on every pass, so a removed attribute releases its rule', () => {
        // The failure this guards: registering only the attributes that are PRESENT leaves the
        // rule for an attribute the page just deleted holding a reference forever, and the
        // element keeps being themed from a value it no longer has.
        const none = attributeRegistrations(facts({isSVG: true}));
        expect(none.every((r) => r.attrValue === null)).toBe(true);
        expect(none.map((r) => r.attrName)).toEqual(
            expect.arrayContaining(['bgcolor', 'color', 'stop-color', 'fill', 'stroke']),
        );
    });

    describe('themeAs vs emitAs (ADR 0005 D3)', () => {
        it('themes stop-color as a background but emits stop-color', () => {
            // Emitting `background-color` onto an SVG gradient stop paints nothing at all.
            const r = slot(attributeRegistrations(facts({isSVG: true, stopColor: '#fff'})), 'stop-color', 'stop-color');
            expect(r!.attrValue).toBe('#fff');
            expect(r!.spec.themeAs).toBe('background-color');
            expect(r!.spec.emitAs).toBe('stop-color');
        });

        it('themes stroke as a border on line/text and as foreground elsewhere', () => {
            const onLine = attributeRegistrations(facts({isSVG: true, isSVGLine: true, stroke: '#333'}));
            const onRect = attributeRegistrations(facts({isSVG: true, stroke: '#333'}));

            const linear = onLine.filter((r) => r.attrName === 'stroke' && r.attrValue !== null);
            expect(linear).toHaveLength(1);
            expect(linear[0].spec.themeAs).toBe('border-color');
            expect(linear[0].spec.emitAs).toBe('stroke');
            expect(linear[0].spec.tags).toEqual(['line', 'text']);

            const other = onRect.filter((r) => r.attrName === 'stroke' && r.attrValue !== null);
            expect(other).toHaveLength(1);
            expect(other[0].spec.themeAs).toBe('color');
            expect(other[0].spec.emitAs).toBe('stroke');
            expect(other[0].spec.qualifier).toBe(':not(line):not(text)');
        });

        it('registers both stroke shapes every pass so the unused one is released', () => {
            // Both shapes must appear even when only one carries a value, or an element that
            // changes type — or was registered under the other shape first — keeps a stale rule.
            const onLine = attributeRegistrations(facts({isSVG: true, isSVGLine: true, stroke: '#333'}));
            const strokes = onLine.filter((r) => r.attrName === 'stroke');
            expect(strokes).toHaveLength(2);
            expect(strokes.filter((r) => r.attrValue === null)).toHaveLength(1);
        });
    });

    describe('SVG fill (ADR 0005 D4)', () => {
        it('keys fill only on <text>, whose modifier is unconditional', () => {
            const onText = slot(attributeRegistrations(facts({isSVG: true, isSVGText: true, fill: '#fff'})), 'fill', 'fill');
            expect(onText!.attrValue).toBe('#fff');
            expect(onText!.spec.themeAs).toBe('color');
            expect(onText!.spec.tags).toEqual(['text']);
        });

        it('does NOT key fill on a shape, whose modifier depends on measured geometry', () => {
            // `<rect fill="#fff">` and `<text fill="#fff">` would need one selector to give two
            // different answers. Guessing is silent mis-theming, which is worse than deferring.
            const onRect = slot(attributeRegistrations(facts({isSVG: true, fill: '#fff'})), 'fill', 'fill');
            expect(onRect!.attrValue).toBeNull();
        });

        it('skips none and currentColor, which are not colours to modify', () => {
            for (const fill of ['none', 'currentColor']) {
                const r = slot(attributeRegistrations(facts({isSVG: true, isSVGText: true, fill})), 'fill', 'fill');
                expect(r!.attrValue).toBeNull();
            }
        });
    });

    describe('legacy value normalisation', () => {
        it('themes from the repaired value but keys off the raw attribute', () => {
            // `<td bgcolor="fff">` renders white. Theming from `fff` parses as nothing; keying
            // off `#fff` matches nothing. Both values are needed, separately.
            const r = slot(attributeRegistrations(facts({bgcolor: 'fff'})), 'bgcolor', 'background-color');
            expect(r!.attrValue).toBe('fff');
            expect(r!.spec.themeValue).toBe('#fff');
        });

        it('leaves a value that is already a colour alone', () => {
            const r = slot(attributeRegistrations(facts({bgcolor: 'red'})), 'bgcolor', 'background-color');
            expect(r!.spec.themeValue).toBe('red');
        });
    });

    it('leaves <link rel="mask-icon"> alone, as upstream does', () => {
        const r = slot(attributeRegistrations(facts({color: '#000', isMaskIconLink: true})), 'color', 'color');
        expect(r!.attrValue).toBeNull();
    });

    it('does not register SVG-only attributes on an HTML element', () => {
        // `<div fill="x">` is not SVG fill; emitting a rule for it would theme a property the
        // element does not have.
        const html = attributeRegistrations(facts({fill: '#fff', stroke: '#333', stopColor: '#fff'}));
        expect(html.map((r) => r.attrName)).toEqual(['bgcolor', 'color']);
    });
});

describe('normalizeBgcolorAttr / normalizeColorAttr', () => {
    it('restores the # on bare three- and six-digit hex', () => {
        expect(normalizeBgcolorAttr('fff')).toBe('#fff');
        expect(normalizeBgcolorAttr('FFFFFF')).toBe('#FFFFFF');
        expect(normalizeColorAttr('abc')).toBe('#abc');
    });

    it('mirrors upstream four-digit handling for color only', () => {
        // color="abcd" -> #abcd00. Odd, and upstream's; bgcolor does not do it, and inventing
        // symmetry here would change what the page renders.
        expect(normalizeColorAttr('abcd')).toBe('#abcd00');
        expect(normalizeColorAttr('#abcd')).toBe('#abcd00');
        expect(normalizeBgcolorAttr('abcd')).toBe('abcd');
    });

    it('leaves named colours and functional values untouched', () => {
        expect(normalizeColorAttr('red')).toBe('red');
        expect(normalizeBgcolorAttr('rgb(1,2,3)')).toBe('rgb(1,2,3)');
    });
});

describe('deferredWork', () => {
    it('counts a shape fill, so the SVG gap is visible rather than assumed', () => {
        expect(deferredWork(facts({isSVG: true, fill: '#fff'})).svgFill).toBe(1);
        expect(deferredWork(facts({isSVG: true, isSVGText: true, fill: '#fff'})).svgFill).toBe(0);
        expect(deferredWork(facts({isSVG: true, fill: 'none'})).svgFill).toBe(0);
    });

    it('counts an <svg> upstream would have inverted as an image', () => {
        // Upstream's own gate: `logo` in the class of the svg or its parent. Anything else was
        // never inverted, so counting it would overstate what we dropped.
        expect(deferredWork(facts({isSVG: true, isSVGRoot: true, className: 'site-logo'})).svgInvert).toBe(1);
        expect(deferredWork(facts({isSVG: true, isSVGRoot: true, parentClassName: 'logo-wrap'})).svgInvert).toBe(1);
        expect(deferredWork(facts({isSVG: true, isSVGRoot: true, className: 'chart'})).svgInvert).toBe(0);
        expect(deferredWork(facts({isSVG: true, className: 'logo'})).svgInvert).toBe(0);
    });

    it('counts nothing for a plain HTML element', () => {
        expect(deferredWork(facts({style: 'color:#333'}))).toEqual({svgFill: 0, svgInvert: 0});
    });
});

// ---------------------------------------------------------------------------------------------
// The engine lifecycle, driven through `registerFacts` so it needs no DOM.
// ---------------------------------------------------------------------------------------------

const themeIt: InlineThemer = (property, value) => {
    // At least as strict as the real engine: it themes only names containing `color`, plus
    // fill/stroke/background-image. A stub more permissive than the thing it replaces is how
    // the shorthand defect reached merge (ADR 0005 D1).
    const themable = property.includes('color') || ['fill', 'stroke', 'background-image'].includes(property);
    return themable ? `themed(${value})` : null;
};

const expandIt = createTableExpander({
    'color': [{property: 'color', value: '#333'}],
    'background': [{property: 'background-color', value: 'rgb(255, 255, 255)'}],
});

const acceptAll = () => true;

function makeEngine(themer: InlineThemer = themeIt) {
    return new InlineStyleEngine({themer, expand: expandIt, isValidSelector: acceptAll});
}

describe('InlineStyleEngine', () => {
    it('emits a rule for a style attribute without touching the element', () => {
        const e = makeEngine();
        e.registerFacts({}, facts({style: 'color:#333'}));
        expect(e.buildCSS()).toContain('[style="color:#333"]');
        expect(e.buildCSS()).toContain('themed(#333)');
    });

    describe('the ignoreInlineStyle qualifier reaches the emitted rules', () => {
        // The half that `ignore-browser.spec.ts` cannot see. That spec proves a `:not()` built
        // from the catalog's selectors excludes the right elements; this proves the engine
        // actually puts it on the rules. Between them the chain is covered: catalog ->
        // `overrideInlineStyle`'s parameter -> here -> the selector.
        it('appends the exclusion to every rule', () => {
            const e = makeEngine();
            e.setIgnoreSelectors(['.entry-content *', '#panel > .row']);
            e.registerFacts({}, facts({style: 'color:#333'}));
            e.registerFacts({}, facts({bgcolor: '#fff'}));
            const lines = e.buildCSS().split('\n');
            expect(lines).toHaveLength(2);
            for (const line of lines) {
                expect(line).toContain(':not(.entry-content *, #panel > .row) {');
            }
        });

        it('emits no rule at all when the site ignores everything', () => {
            // `*` cannot be expressed as an exclusion — `:not(*)` would make every rule match
            // nothing, which is right in effect but pointless to emit.
            const e = makeEngine();
            e.setIgnoreSelectors(['*']);
            e.registerFacts({}, facts({style: 'color:#333'}));
            expect(e.buildCSS()).toBe('');
        });

        it('drops a selector the parser rejects instead of poisoning the rule', () => {
            // A `:not()` list is all-or-nothing, so one bad selector from the synced catalog
            // would invalidate our THEMING, not the exclusion.
            const e = new InlineStyleEngine({
                themer: themeIt,
                expand: expandIt,
                isValidSelector: (sel) => !sel.includes('((broken'),
            });
            e.setIgnoreSelectors(['.good *', '((broken']);
            e.registerFacts({}, facts({style: 'color:#333'}));
            expect(e.buildCSS()).toContain(':not(.good *)');
            expect(e.buildCSS()).not.toContain('broken');
        });
    });

    describe('sheets', () => {
        it('fills a sheet on attach and keeps it in sync on commit', () => {
            const e = makeEngine();
            const sheet = {textContent: 'stale'} as HTMLStyleElement;
            e.attachSheet(sheet);
            expect(sheet.textContent).toBe('');

            e.registerFacts({}, facts({style: 'color:#333'}));
            expect(e.commit()).toBe(true);
            expect(sheet.textContent).toContain('[style="color:#333"]');
        });

        it('reports a commit with nothing to do, so callers can tell it apart', () => {
            const e = makeEngine();
            e.registerFacts({}, facts({style: 'color:#333'}));
            expect(e.commit()).toBe(true);
            expect(e.commit()).toBe(false);
        });

        it('gives a sheet attached later the rules that already exist', () => {
            // A shadow root discovered mid-page must not start empty: an attribute selector in
            // the document sheet does not reach into it.
            const e = makeEngine();
            e.registerFacts({}, facts({style: 'color:#333'}));
            const late = {textContent: ''} as HTMLStyleElement;
            e.attachSheet(late);
            expect(late.textContent).toContain('[style="color:#333"]');
        });
    });

    describe('deferred work is counted, not silently dropped', () => {
        it('counts a shape fill and an svg logo', () => {
            const e = makeEngine();
            e.registerFacts({}, facts({isSVG: true, fill: '#fff'}));
            e.registerFacts({}, facts({isSVG: true, isSVGRoot: true, className: 'logo'}));
            expect(e.stats().deferred.svgFill).toBe(1);
            expect(e.stats().deferred.svgInvert).toBe(1);
        });

        it('counts a url() background WITHOUT asking the themer for it', () => {
            // Asking starts a real image load and analysis whose result is discarded — wasted
            // work, and a request the page never made.
            const asked: string[] = [];
            const e = makeEngine((property, value) => {
                asked.push(property);
                return themeIt(property, value) as string | null;
            });
            e.registerFacts({}, facts({style: 'background-image:url(a.png)'}));
            expect(e.stats().deferred.asyncImage).toBe(1);
            expect(asked).not.toContain('background-image');
        });
    });

    it('releases an element that moves into an ignored region', () => {
        // `register()` decides this from `element.matches`, so the DOM-free path cannot reach
        // it — but `release` is what it calls, and a leak here means the rule outlives the
        // element that needed it.
        const e = makeEngine();
        const token = {};
        e.registerFacts(token, facts({style: 'color:#333'}));
        expect(e.buildCSS()).not.toBe('');
        e.release(token);
        expect(e.buildCSS()).toBe('');
    });
});

describe('an invalid ignore selector cannot abort the theming pass', () => {
    // `matchesIgnored` calls `element.matches()`, and `matches()` THROWS SyntaxError on an
    // invalid selector. That exception propagates out through `overrideInlineStyle` and aborts
    // the whole discovery pass, so one typo in the synced catalog leaves the ENTIRE page
    // unthemed — the exact failure the qualifier's validation exists to prevent, defeated by a
    // sibling code path holding a second, unvalidated copy of the list.
    const rejectBroken = (sel: string) => !sel.includes('((broken');

    it('keeps only the selectors the parser accepted', () => {
        const e = new InlineStyleEngine({
            themer: themeIt, expand: expandIt, isValidSelector: rejectBroken,
        });
        e.setIgnoreSelectors(['.good *', '((broken', '  ', '.also-good']);
        e.registerFacts({}, facts({style: 'color:#333'}));
        expect(e.buildCSS()).toContain(':not(.good *, .also-good)');
    });

    it('emits no qualifier when every selector was rejected', () => {
        const e = new InlineStyleEngine({
            themer: themeIt, expand: expandIt, isValidSelector: rejectBroken,
        });
        e.setIgnoreSelectors(['((broken']);
        e.registerFacts({}, facts({style: 'color:#333'}));
        const css = e.buildCSS();
        expect(css).toContain('[style="color:#333"] {');
        expect(css).not.toContain(':not(');
    });

    it('never hands an unvalidated selector to element.matches()', () => {
        // The direct assertion: whatever `register()` tests against must have passed the
        // validator first. A fake element records every selector it is asked about.
        const asked: string[] = [];
        // Returns true for the valid selector, so `register()` takes its early-return path and
        // never reaches `readElementFacts` — which needs a real DOM. The selector list is the
        // thing under test here, not the element read.
        const fake = {
            matches(sel: string) {
                asked.push(sel);
                if (sel.includes('((broken')) {
                    throw new SyntaxError(`'${sel}' is not a valid selector`);
                }
                return true;
            },
        } as unknown as Element;

        const e = new InlineStyleEngine({
            themer: themeIt, expand: expandIt, isValidSelector: rejectBroken,
        });
        e.setIgnoreSelectors(['.good *', '((broken']);
        // Would throw if the raw list were used. The assertion is that it does not.
        expect(() => e.register(fake)).not.toThrow();
        expect(asked).toEqual(['.good *']);
    });
});
