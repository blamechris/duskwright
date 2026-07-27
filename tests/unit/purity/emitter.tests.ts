import {InlineRuleEmitter, MAX_FRAGMENT_CHARS} from '../../../src/purity/inline/emitter';
import type {Themer} from '../../../src/purity/inline/emitter';

// A stand-in for the engine's colour maths. Deterministic so the tests assert on rule
// content, not on theme output.
const invert: Themer = (property, value) => {
    if (!property.includes('color') && property !== 'background') {
        return null;
    }
    return value === '#fff' ? '#111' : '#eee';
};

const el = () => ({} as object);

describe('InlineRuleEmitter', () => {
    it('emits one rule per distinct declaration', () => {
        const e = new InlineRuleEmitter(invert);
        e.update(el(), 'color:#333');
        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS()).toBe('[style="color:#333"] { color: #eee !important; }');
    });

    it('shares one rule between elements carrying the same declaration', () => {
        // The whole point of keying by declaration: N elements, one rule.
        const e = new InlineRuleEmitter(invert);
        for (let i = 0; i < 50; i++) {
            e.update(el(), 'color:#333');
        }
        expect(e.stats().keys).toBe(1);
        expect(e.buildCSS().split('\n')).toHaveLength(1);
    });

    it('emits separate rules for the same property at different positions', () => {
        // They need different selectors, so they are genuinely different rules.
        const e = new InlineRuleEmitter(invert);
        e.update(el(), 'color:#333');
        e.update(el(), 'color:#333;background:#fff');
        expect(e.stats().keys).toBe(3); // sole color, first color, last background
    });

    it('uses !important, because inline style outranks any selector we can write', () => {
        // This is the specificity win that replaces upstream DELETING the page's declaration.
        const e = new InlineRuleEmitter(invert);
        e.update(el(), 'color:#333');
        expect(e.buildCSS()).toContain('!important');
    });

    it('skips declarations the themer declines', () => {
        const e = new InlineRuleEmitter(invert);
        e.update(el(), 'width:10px');
        expect(e.stats().keys).toBe(0);
        expect(e.buildCSS()).toBe('');
    });

    describe('un-keyable attributes', () => {
        it('emits nothing for an attribute with a duplicated property', () => {
            const e = new InlineRuleEmitter(invert);
            e.update(el(), 'color:#333;color:#444');
            expect(e.stats().keys).toBe(0);
            expect(e.stats().unkeyable).toBe(2);
        });

        it('emits nothing for an attribute containing var(), even for its safe declarations', () => {
            // The colliding selector is derived from one of these declarations, so keeping
            // the "safe" one still leaves the collision.
            const e = new InlineRuleEmitter(invert);
            e.update(el(), 'color:var(--x);background:#fff');
            expect(e.stats().keys).toBe(0);
        });
    });

    describe('reference counting', () => {
        it('keeps the rule while any element still references it', () => {
            const e = new InlineRuleEmitter(invert);
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
            const e = new InlineRuleEmitter(invert);
            const a = el();
            e.update(a, 'color:#333');
            e.update(a, 'color:#444');
            expect(e.stats().keys).toBe(1);
            expect(e.buildCSS()).toContain('color:#444');
        });

        it('does not grow when the same element is updated repeatedly with the same value', () => {
            const e = new InlineRuleEmitter(invert);
            const a = el();
            for (let i = 0; i < 100; i++) {
                e.update(a, 'color:#333');
            }
            expect(e.stats().keys).toBe(1);
        });

        it('releasing an unknown element is a no-op', () => {
            const e = new InlineRuleEmitter(invert);
            expect(() => e.release(el())).not.toThrow();
        });

        it('clearing the attribute releases the keys', () => {
            const e = new InlineRuleEmitter(invert);
            const a = el();
            e.update(a, 'color:#333');
            e.update(a, null);
            expect(e.stats().keys).toBe(0);
        });
    });

    describe('oversized fragments', () => {
        it('skips a fragment beyond the memory guard', () => {
            const e = new InlineRuleEmitter(invert);
            const huge = `background-image:url(data:image/png;base64,${'x'.repeat(MAX_FRAGMENT_CHARS)})`;
            e.update(el(), huge);
            expect(e.stats().keys).toBe(0);
            expect(e.stats().oversized).toBe(1);
        });

        it('keeps a fragment just under the guard', () => {
            const e = new InlineRuleEmitter(invert);
            const value = 'y'.repeat(MAX_FRAGMENT_CHARS - 'color:'.length - 10);
            e.update(el(), `color:${value}`);
            expect(e.stats().oversized).toBe(0);
            expect(e.stats().keys).toBe(1);
        });
    });

    describe('change tracking', () => {
        it('reports changes when a rule is added or removed, not on a no-op update', () => {
            const e = new InlineRuleEmitter(invert);
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
        const e = new InlineRuleEmitter(invert);
        e.update(el(), 'color:#333');
        e.clear();
        expect(e.stats().keys).toBe(0);
        expect(e.buildCSS()).toBe('');
    });
});
