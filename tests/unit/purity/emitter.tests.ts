import {InlineRuleEmitter, MAX_FRAGMENT_CHARS} from '../../../src/purity/inline/emitter';
import type {Themer} from '../../../src/purity/inline/emitter';

import {createTableExpander} from '../../../src/purity/inline/expand';

// A stand-in for the engine's colour maths, matching the REAL rule at modify-css.ts:68 —
// themable only when the property name contains `color`, or is fill/stroke/background-image.
//
// The previous version of this stub also accepted the `background` SHORTHAND. That made it more
// permissive than the engine, so every test passed on a design where backgrounds were never
// themed at all — across all 32 fixtures. A stub must be at least as strict as the thing it
// replaces (ADR 0005 D1).
const invert: Themer = (property, value) => {
    const themable = property.includes('color') ||
        ['fill', 'stroke', 'background-image'].includes(property);
    if (!themable) {
        return null;
    }
    return value === '#fff' || value === 'rgb(255, 255, 255)' ? '#111' : '#eee';
};

const expand = createTableExpander({
    'background': [{property: 'background-color', value: 'rgb(255, 255, 255)'}],
    'background:#fff': [{property: 'background-color', value: 'rgb(255, 255, 255)'}],
});

/** The commonest tier-2 spec: `bgcolor` both themes and emits `background-color`. */
const BG = {themeAs: 'background-color', emitAs: 'background-color'};

const el = () => ({} as object);

describe('InlineRuleEmitter', () => {
    it('emits one rule per distinct declaration', () => {
        const e = new InlineRuleEmitter(invert, expand);
        e.update(el(), 'color:#333');
        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS()).toBe('[style="color:#333"] { color: #eee !important; }');
    });

    it('shares one rule between elements carrying the same declaration', () => {
        // The whole point of keying by declaration: N elements, one rule.
        const e = new InlineRuleEmitter(invert, expand);
        for (let i = 0; i < 50; i++) {
            e.update(el(), 'color:#333');
        }
        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS().split('\n')).toHaveLength(1);
    });

    it('emits separate rules for the same property at different positions', () => {
        // They need different selectors, so they are genuinely different rules.
        const e = new InlineRuleEmitter(invert, expand);
        e.update(el(), 'color:#333');
        e.update(el(), 'color:#333;background:#fff');
        expect(e.stats().keys).toBe(3); // sole color, first color, last background
    });

    it('uses !important, because inline style outranks any selector we can write', () => {
        // This is the specificity win that replaces upstream DELETING the page's declaration.
        const e = new InlineRuleEmitter(invert, expand);
        e.update(el(), 'color:#333');
        expect(e.buildCSS()).toContain('!important');
    });

    it('skips declarations the themer declines', () => {
        const e = new InlineRuleEmitter(invert, expand);
        e.update(el(), 'width:10px');
        expect(e.stats().keys).toBe(0);
        expect(e.buildCSS()).toBe('');
    });

    describe('un-keyable attributes', () => {
        it('emits nothing for an attribute with a duplicated property', () => {
            const e = new InlineRuleEmitter(invert, expand);
            e.update(el(), 'color:#333;color:#444');
            expect(e.stats().keys).toBe(0);
            expect(e.stats().unkeyable).toBe(2);
        });

        it('skips only the var() declaration and keys the rest', () => {
            // Changed by ADR 0005 D6. The all-or-nothing rule is justified only for a
            // DUPLICATE, where a dead declaration's selector collides with a live one on
            // another element. A var() value simply cannot be keyed; dropping just that
            // declaration collides with nothing, so `background:#fff` is still themed.
            const e = new InlineRuleEmitter(invert, expand);
            e.update(el(), 'color:var(--x);background:#fff');
            expect(e.stats().keys).toBe(1);
            expect(e.stats().unkeyable).toBe(1);
            expect(e.buildCSS()).toContain('background-color');
        });
    });

    describe('reference counting', () => {
        it('keeps the rule while any element still references it', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el(); const b = el();
            e.update(a, 'color:#333');
            e.update(b, 'color:#333');
            e.release(a);
            expect(e.stats().keys).toBe(1);
            e.release(b);
            expect(e.stats().keys).toBe(0);
        });

        it('drops the old key when an element restyles', () => {
            // The repaint case: a virtual-DOM app rewrites the attribute every frame. Without
            // this the key table grows without bound.
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            e.update(a, 'color:#444');
            expect(e.stats().keys).toBe(1);
            expect(e.buildCSS()).toContain('color:#444');
        });

        it('does not grow when the same element is updated repeatedly with the same value', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            for (let i = 0; i < 100; i++) {
                e.update(a, 'color:#333');
            }
            expect(e.stats().keys).toBe(1);
        });

        it('treats a repeated identical update as a true no-op', () => {
            // The assertion above only checked key COUNT, which nets out to 1 even when the
            // rule is deleted and recreated every call — so it passed while the emitter
            // churned and re-emitted the entire sheet on every repaint. hasChanges is the
            // assertion that actually catches it.
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            const css = e.buildCSS();
            e.markClean();

            for (let i = 0; i < 10; i++) {
                e.update(a, 'color:#333');
                expect(e.hasChanges).toBe(false);
            }
            expect(e.buildCSS()).toBe(css);
            expect(e.stats().keys).toBe(1);
        });

        it('still returns the element keys on a no-op update', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            const first = e.update(a, 'color:#333');
            expect(e.update(a, 'color:#333')).toEqual(first);
        });

        it('detects a real change after a run of no-ops', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            e.update(a, 'color:#333');
            e.markClean();
            e.update(a, 'color:#999');
            expect(e.hasChanges).toBe(true);
            expect(e.stats().keys).toBe(1);
        });

        it('re-registers correctly after release, despite the no-op shortcut', () => {
            // release() must clear the remembered attribute, or a later identical update
            // would short-circuit against a rule that no longer exists.
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            e.release(a);
            expect(e.stats().keys).toBe(0);
            e.update(a, 'color:#333');
            expect(e.stats().keys).toBe(1);
            expect(e.buildCSS()).toContain('color:#333');
        });

        it('releasing an unknown element is a no-op', () => {
            const e = new InlineRuleEmitter(invert, expand);
            expect(() => e.release(el())).not.toThrow();
        });

        it('clearing the attribute releases the keys', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            e.update(a, null);
            expect(e.stats().keys).toBe(0);
        });
    });

    describe('presentational attributes (tier 2)', () => {
        it('emits an exact attribute match', () => {
            const e = new InlineRuleEmitter(invert, expand);
            e.updateAttribute(el(), 'bgcolor', '#fff', BG);
            expect(e.buildCSS()).toBe('[bgcolor="#fff"] { background-color: #111 !important; }');
        });

        it('themes by one property and emits another (ADR 0005 D3)', () => {
            // The engine themes SVG `stroke` as a colour but must WRITE `stroke`. Emitting the
            // themed name instead would put `color:` in the rule, which paints no stroke at all.
            const e = new InlineRuleEmitter(invert, expand);
            e.updateAttribute(el(), 'stroke', '#fff', {themeAs: 'color', emitAs: 'stroke'});
            expect(e.buildCSS()).toBe('[stroke="#fff"] { stroke: #111 !important; }');
        });

        it('restricts a rule to specific element types', () => {
            // How the engine's JavaScript element-type check becomes a selector.
            const e = new InlineRuleEmitter(invert, expand);
            e.updateAttribute(el(), 'stroke', '#fff', {
                themeAs: 'border-color', emitAs: 'stroke', tags: ['line', 'text'],
            });
            expect(e.buildCSS()).toContain('line[stroke="#fff"], text[stroke="#fff"]');
        });

        it('supports the complementary :not() case', () => {
            const e = new InlineRuleEmitter(invert, expand);
            e.updateAttribute(el(), 'stroke', '#fff', {
                themeAs: 'color', emitAs: 'stroke', qualifier: ':not(line):not(text)',
            });
            expect(e.buildCSS()).toContain('[stroke="#fff"]:not(line):not(text)');
        });

        it('keeps the two halves of the line/text split as separate rules', () => {
            // If the shape were not part of the key these would collapse into one rule, and
            // one of the two element groups would be themed with the wrong modifier.
            const e = new InlineRuleEmitter(invert, expand);
            e.updateAttribute(el(), 'stroke', '#fff', {
                themeAs: 'border-color', emitAs: 'stroke', tags: ['line', 'text'],
            });
            e.updateAttribute(el(), 'stroke', '#fff', {
                themeAs: 'color', emitAs: 'stroke', qualifier: ':not(line):not(text)',
            });
            expect(e.stats().keys).toBe(2);
        });

        it('shares one rule across elements with the same attribute value', () => {
            const e = new InlineRuleEmitter(invert, expand);
            for (let i = 0; i < 20; i++) {
                e.updateAttribute(el(), 'bgcolor', '#fff', BG);
            }
            expect(e.stats().keys).toBe(1);
        });

        it('treats an unchanged attribute as a true no-op', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.updateAttribute(a, 'bgcolor', '#fff', BG);
            e.markClean();
            e.updateAttribute(a, 'bgcolor', '#fff', BG);
            expect(e.hasChanges).toBe(false);
        });

        it('releases the old rule when the attribute value changes', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.updateAttribute(a, 'bgcolor', '#fff', BG);
            e.updateAttribute(a, 'bgcolor', '#000', BG);
            expect(e.stats().keys).toBe(1);
            expect(e.buildCSS()).toContain('[bgcolor="#000"]');
        });

        it('releases the rule when the attribute is removed', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.updateAttribute(a, 'bgcolor', '#fff', BG);
            e.updateAttribute(a, 'bgcolor', null, BG);
            expect(e.stats().keys).toBe(0);
        });

        it('keeps style and attribute keys independent on one element', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            e.updateAttribute(a, 'bgcolor', '#fff', BG);
            expect(e.stats().keys).toBe(2);
        });

        it('release() drops attribute rules for an element with NO style attribute', () => {
            // The leak: release() used to return early when there was no tier-1 registration,
            // so an element carrying only presentational attributes never had its tier-2 rules
            // freed. Reachable by every <rect fill="..."> in svg-heavy.html.
            //
            // The test below passes even with the bug present, because it calls update() first
            // and so never takes the short-circuit path. This one is the actual regression.
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.updateAttribute(a, 'stroke', '#fff', {themeAs: 'color', emitAs: 'stroke'});
            expect(e.stats().keys).toBe(1);
            e.release(a);
            expect(e.stats().keys).toBe(0);
        });

        it('release() drops the element\'s attribute rules too', () => {
            // Without this a removed element leaks its tier-2 rules forever.
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            e.updateAttribute(a, 'bgcolor', '#fff', BG);
            e.release(a);
            expect(e.stats().keys).toBe(0);
        });

        it('escapes a hostile attribute value', () => {
            const e = new InlineRuleEmitter(invert, expand);
            e.updateAttribute(el(), 'bgcolor', '#fff" i],*{x:y}[a="', BG);
            expect(e.buildCSS()).toContain('\\"');
        });
    });

    describe('oversized fragments', () => {
        it('skips a fragment beyond the memory guard', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const huge = `background-image:url(data:image/png;base64,${'x'.repeat(MAX_FRAGMENT_CHARS)})`;
            e.update(el(), huge);
            expect(e.stats().keys).toBe(0);
            expect(e.stats().oversized).toBe(1);
        });

        it('keeps a fragment just under the guard', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const value = 'y'.repeat(MAX_FRAGMENT_CHARS - 'color:'.length - 10);
            e.update(el(), `color:${value}`);
            expect(e.stats().oversized).toBe(0);
            expect(e.stats().keys).toBe(1);
        });
    });

    describe('change tracking', () => {
        it('reports changes when a rule is added or removed, not on a no-op update', () => {
            const e = new InlineRuleEmitter(invert, expand);
            const a = el();
            e.update(a, 'color:#333');
            expect(e.hasChanges).toBe(true);
            e.markClean();

            e.update(el(), 'color:#333'); // shares the existing rule
            expect(e.hasChanges).toBe(false); // nothing to re-emit

            e.update(el(), 'color:#999'); // new rule
            expect(e.hasChanges).toBe(true);
        });
    });

    it('clear() drops everything', () => {
        const e = new InlineRuleEmitter(invert, expand);
        e.update(el(), 'color:#333');
        e.clear();
        expect(e.stats().keys).toBe(0);
        expect(e.buildCSS()).toBe('');
    });

    it('re-themes an unchanged element after clear()', () => {
        // The no-op shortcut is a cache, and this is its invalidation path. Without it,
        // clear() left the shortcut claiming the element was still registered, so the next
        // identical update short-circuited against a deleted rule and the element was never
        // themed again — empty CSS, silently.
        const e = new InlineRuleEmitter(invert, expand);
        const a = el();
        e.update(a, 'color:#333');
        e.clear();
        e.update(a, 'color:#333');
        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS()).toContain('color:#333');
    });
});


// The defect ADR 0005 D1 exists to fix, asserted directly.
describe('shorthand expansion (ADR 0005 D1)', () => {
    it('themes background-color from an authored `background` shorthand', () => {
        // Before D1 this emitted NOTHING: the deriver saw the authored `background`, the
        // engine's themer only accepts names containing `color`, and the result across all 32
        // corpus fixtures was text darkened with backgrounds left white.
        const e = new InlineRuleEmitter(invert, expand);
        e.update(el(), 'background:#fff');
        expect(e.stats().keys).toBe(1);
        const css = e.buildCSS();
        expect(css).toContain('background-color:');
        // The SELECTOR still keys the authored text, or it would not match the element.
        expect(css).toContain('[style="background:#fff"]');
    });

    it('keys the authored fragment while theming the expanded property', () => {
        const e = new InlineRuleEmitter(invert, expand);
        e.update(el(), 'background:#fff');
        // Authored on the left of the brace, expanded on the right. That asymmetry IS the fix.
        expect(e.buildCSS()).toBe('[style="background:#fff"] { background-color: #111 !important; }');
    });

    it('emits one rule with several declarations when a shorthand expands to several', () => {
        const multi = createTableExpander({
            'border': [
                {property: 'border-top-color', value: 'rgb(51, 51, 51)'},
                {property: 'border-left-color', value: 'rgb(51, 51, 51)'},
            ],
        });
        const e = new InlineRuleEmitter(invert, multi);
        e.update(el(), 'border:1px solid #333');
        expect(e.stats().keys).toBe(1);
        const css = e.buildCSS();
        expect(css).toContain('border-top-color:');
        expect(css).toContain('border-left-color:');
    });

    it('skips a declaration whose expansion themes nothing', () => {
        const e = new InlineRuleEmitter(invert, createTableExpander({
            'margin': [{property: 'margin-top', value: '1px'}],
        }));
        e.update(el(), 'margin:1px');
        expect(e.stats().keys).toBe(0);
    });
});

describe('lifecycle bugs a WeakMap shortcut can hide', () => {
    const BGCOLOR = {themeAs: 'background-color', emitAs: 'background-color'};

    it('re-themes a presentational attribute after clear()', () => {
        // `updateAttribute` short-circuits when the slot already holds this key — but `clear()`
        // cannot empty a WeakMap, so without a generation check the element still claims a rule
        // that was deleted, returns early, and is never themed again. Exactly the bug the
        // generation counter was added for on tier 1, missed on tier 2.
        const e = new InlineRuleEmitter(invert, expand);
        const t = el();
        e.updateAttribute(t, 'bgcolor', '#fff', BGCOLOR);
        expect(e.stats().keys).toBe(1);

        e.clear();
        e.updateAttribute(t, 'bgcolor', '#fff', BGCOLOR);
        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS()).toContain('[bgcolor="#fff"]');
    });

    it('does not let a stale slot release another element\'s rule', () => {
        // After clear(), a stale slot names a key that no longer exists. If a DIFFERENT element
        // has since recreated that key, releasing the stale slot decrements a live rule to zero
        // and deletes it — un-theming an element that never changed.
        const e = new InlineRuleEmitter(invert, expand);
        const stale = el();
        e.updateAttribute(stale, 'bgcolor', '#fff', BGCOLOR);
        e.clear();

        const fresh = el();
        e.updateAttribute(fresh, 'bgcolor', '#fff', BGCOLOR);
        e.release(stale); // the stale element goes away

        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS()).toContain('[bgcolor="#fff"]');
    });

    it('keeps tier-2 rules alive when the style attribute changes', () => {
        // `update()` releases this element's declaration keys. Releasing the whole token takes
        // the attribute rules with it, and the caller registers those AFTER the style attribute
        // — so every style change silently un-themes every bgcolor, stroke and fill on the same
        // element until the next full pass.
        const e = new InlineRuleEmitter(invert, expand);
        const t = el();
        e.updateAttribute(t, 'bgcolor', '#fff', BGCOLOR);
        e.update(t, 'color:#333');
        expect(e.buildCSS()).toContain('[bgcolor="#fff"]');

        // And again on a genuine change, which is the path the "correct" ordering still hits.
        e.update(t, 'color:#444');
        expect(e.buildCSS()).toContain('[bgcolor="#fff"]');
        expect(e.stats().keys).toBe(2);
    });

    it('still releases both tiers when the element itself goes away', () => {
        const e = new InlineRuleEmitter(invert, expand);
        const t = el();
        e.update(t, 'color:#333');
        e.updateAttribute(t, 'bgcolor', '#fff', BGCOLOR);
        e.release(t);
        expect(e.stats().keys).toBe(0);
    });
});

describe('the tier-1 half of the same stale-key bug', () => {
    // The tier-2 tests above have exact twins here. Fixing one half and not the other is the
    // pattern this epic keeps repeating, so both halves are asserted side by side.

    it('does not let a stale declaration release another element\'s rule', () => {
        const e = new InlineRuleEmitter(invert, expand);
        const stale = el();
        e.update(stale, 'color:#333');
        e.clear();

        const fresh = el();
        e.update(fresh, 'color:#333');
        e.release(stale);

        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS()).toContain('[style="color:#333"]');
    });

    it('does not corrupt the refcount when a stale element re-registers', () => {
        // The nastier shape: nothing looks wrong at the time. The stale element releases the
        // live rule and immediately recreates it, so refs reads 1 for two elements — and the
        // NEXT release un-themes an element that never changed.
        const e = new InlineRuleEmitter(invert, expand);
        const stale = el();
        e.update(stale, 'color:#333');
        e.clear();

        const fresh = el();
        e.update(fresh, 'color:#333');
        e.update(stale, 'color:#333');
        e.release(fresh);

        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS()).toContain('[style="color:#333"]');
    });

    it('re-themes a declaration after clear(), like tier 2 does', () => {
        const e = new InlineRuleEmitter(invert, expand);
        const t = el();
        e.update(t, 'color:#333');
        e.clear();
        e.update(t, 'color:#333');
        expect(e.stats().keys).toBe(1);
    });
});
