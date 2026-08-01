import type {Declaration} from './keys';
import {declarationKey, declarationSelector, escapeCSSString, parseInlineDeclarations, unkeyableCollides} from './keys';
import type {Expander} from './expand';

// The rule table for ADR 0004 tier 1.
//
// Upstream themed an inline-styled element by writing the themed value back into that
// element's `style` attribute. We instead emit one rule per distinct declaration into a sheet
// we own, so N elements sharing a declaration cost one rule rather than N writes — and the
// page's own DOM is never touched.
//
// This module deliberately knows nothing about colour. The engine passes in a `themer`, which
// keeps the whole rule-table lifecycle testable without loading the theming engine (and the
// engine's own `getModifiableCSSDeclaration` is not importable in a Node test — it reaches for
// `document` at module load).

/**
 * Produce the themed replacement for one declaration, or null to leave it alone.
 *
 * Returns the VALUE only; the emitter builds the declaration text.
 */
export type Themer = (property: string, value: string) => string | null;

/**
 * Skip declarations whose matched fragment is larger than this.
 *
 * This is a **memory** guard, not a speed one. Attribute-selector matching was measured flat
 * from 74 to 100,054 characters (~0.4ms either way, see issue #69), so long selectors do not
 * cost match time. What they do cost is a verbatim copy of the value inside our stylesheet
 * text — a page with many distinct large data-URI backgrounds would otherwise hold megabytes
 * of CSS. Do not lower this thinking it helps performance; it does not.
 */
export const MAX_FRAGMENT_CHARS = 4096;

/**
 * Key-field separator.
 *
 * U+0000 because key fields are arbitrary CSS text — an attribute value can contain any
 * printable character, so a visible delimiter would make `a=b c` ambiguous with `a=b` + `c`.
 * NUL cannot appear in an attribute value the DOM hands us, so it is the one safe choice.
 *
 * Written as an escape, NEVER as a literal. An earlier version embedded the raw byte in the
 * source, which is invisible in review, breaks grep and editors, and made string-matching
 * refactors silently fail. A reviewer flagged exactly this and I wrongly dismissed it.
 */
const KEY_SEP = '\u0000';

interface Rule {
    selector: string;
    /** Declaration text inside the rule body, e.g. `color: #e8e8ea !important`. */
    body: string;
    /** How many elements currently reference this key. */
    refs: number;
}

/**
 * How one presentational attribute becomes a rule (ADR 0005 D3).
 *
 * The two properties are separate because the engine treats them separately: it picks a colour
 * modifier by one name and writes the result under another. Collapsing them emits
 * `background-color` onto an SVG `<rect>`, which paints nothing.
 */
export interface AttributeSpec {
    /** The property whose colour maths applies. Often NOT the property emitted. */
    themeAs: string;
    /** The property actually written into the rule body. */
    emitAs: string;
    /** Appended to the attribute selector, e.g. `:not(line):not(text)`. */
    qualifier?: string;
    /** Restrict to these element types, e.g. `['line', 'text']`. Takes precedence over `qualifier`. */
    tags?: string[];
}

export interface EmitterStats {
    keys: number;
    /** Declarations skipped because the whole attribute was un-keyable (var(), duplicates). */
    unkeyable: number;
    /** Declarations skipped because their fragment exceeded MAX_FRAGMENT_CHARS. */
    oversized: number;
}

export class InlineRuleEmitter {
    private readonly rules = new Map<string, Rule>();
    private readonly perElement = new WeakMap<object, string[]>();
    /**
     * The attribute text each element was last registered with.
     *
     * Without this, `update()` releases before it retains, so re-registering an element with
     * an UNCHANGED attribute drops its sole-referenced rule to zero refs (deleting it) and
     * immediately recreates it. The key count nets out, so it looks fine — but the rule
     * churns and `dirty` is set, which re-emits and re-adopts the whole sheet on every
     * repaint. That defeats the entire reason this table is reference-counted.
     */
    private readonly lastAttr = new WeakMap<object, {attr: string; generation: number}>();
    /**
     * Tier-2 keys per element, addressed by `${attrName}<sep>${shape}`.
     *
     * Carries a generation for the same reason `lastAttr` does, and it is the same bug:
     * `updateAttribute` short-circuits when the slot already holds this key, but `clear()`
     * cannot empty a WeakMap. Without the generation, clearing the table left every element
     * still claiming its attribute rules exist, so the next identical registration returned
     * early against a rule that had been deleted and the element was never re-themed.
     */
    private readonly attrKeys = new WeakMap<object, {generation: number; slots: Map<string, string>}>();
    /**
     * Bumped by `clear()`. The shortcut above is a cache, and a cache needs an invalidation
     * path: without this, clearing the table leaves `lastAttr` still claiming an element is
     * registered, so the next identical update short-circuits against a rule that no longer
     * exists and the element is never re-themed. WeakMap cannot be cleared, so the generation
     * is compared instead.
     */
    private generation = 0;
    private unkeyableCount = 0;
    private oversizedCount = 0;
    private dirty = false;

    constructor(
        private readonly themer: Themer,
        /**
         * Expands an authored declaration into longhands (ADR 0005 D1). Required, not
         * defaulted: an identity default would silently reproduce the defect where
         * `background:#fff` was never themed because the engine only themes `*-color`.
         */
        private readonly expand: Expander,
    ) {}

    /**
     * Register an element's current inline style, replacing whatever it was registered with
     * before. `token` identifies the element; the caller passes the element itself.
     *
     * Returns the keys now attributed to this element.
     */
    update(token: object, attr: string | null): string[] {
        // A repeated identical update must be a TRUE no-op, not a release-and-retain that
        // happens to net out. See lastAttr above.
        const remembered = this.lastAttr.get(token);
        if (attr !== null && remembered?.attr === attr && remembered.generation === this.generation) {
            return this.perElement.get(token) ?? [];
        }

        // Declarations only. Releasing the whole token here would take this element's
        // presentational-attribute rules with it, and the caller registers those AFTER the
        // style attribute — so every style change would silently un-theme every `bgcolor`,
        // `stroke` and `fill` on the same element until the next full pass.
        this.releaseDeclarations(token);
        if (!attr) {
            return [];
        }

        const parsed = parseInlineDeclarations(attr, this.expand);
        // ADR 0005 D6: only a COLLIDING reason takes the whole attribute out of tier 1. A
        // duplicated longhand does, because the dead declaration's selector also matches an
        // element where that declaration is live. var() and inline !important simply cannot be
        // keyed, and skipping just those collides with nothing.
        if (parsed.some((d) => d.unkeyable !== null && unkeyableCollides(d.unkeyable))) {
            this.unkeyableCount += parsed.length;
            return [];
        }

        const keys: string[] = [];
        for (const decl of parsed) {
            if (decl.unkeyable !== null) {
                this.unkeyableCount++;
                continue;
            }
            const key = this.retain(decl);
            if (key) {
                keys.push(key);
            }
        }
        this.perElement.set(token, keys);
        this.lastAttr.set(token, {attr, generation: this.generation});
        return keys;
    }

    /**
     * Register a presentational attribute — ADR 0004 tier 2.
     *
     * `bgcolor`, `color`, `background`, `fill`, `stroke` and `stop-color` are legacy HTML/SVG
     * attributes whose entire value is the value, so there is no declaration boundary to
     * anchor and the selector is a plain exact match: `[bgcolor="#fff"]`.
     *
     * This exists because `setStaticValue` in the engine is the single funnel for BOTH these
     * and style-attribute declarations. Replacing the write for one and not the other would
     * leave half the P0 violation in place.
     *
     * ADR 0005 D3: `themeAs` and `emitAs` are separate, because the engine deliberately uses
     * different properties for the two roles. `stroke` is THEMED as `border-color` on
     * SVGLineElement and SVGTextElement and as `color` elsewhere — but must always be EMITTED
     * as `stroke`. Emitting `background-color` on an SVG `<rect>` paints nothing at all.
     *
     * `tags` narrows a rule to specific element types, which is how the element-type
     * discrimination the engine performs in JavaScript becomes expressible as a selector.
     * `qualifier` covers the complementary case:
     *
     *     line[stroke="#333"], text[stroke="#333"]  { stroke: <themed as border-color> }
     *     [stroke="#333"]:not(line):not(text)       { stroke: <themed as color> }
     *
     * SVG `fill` is deliberately NOT routed here — ADR 0005 D4. Its modifier depends on the
     * measured geometry of the element and its root, so `<rect fill="#fff">` and
     * `<text fill="#fff">` would need one selector to give two different answers.
     */
    updateAttribute(
        token: object,
        attrName: string,
        attrValue: string | null,
        spec: AttributeSpec,
    ): string | null {
        const {themeAs, emitAs, qualifier = '', tags} = spec;
        // The shape is part of the identity: one attribute value themed two different ways for
        // two element types must not collapse into a single rule.
        const shape = `${emitAs}|${themeAs}|${qualifier}|${(tags ?? []).join(',')}`;
        const slot = `${attrName}${KEY_SEP}${shape}`;
        // A stale generation means `clear()` happened: the slots point at rules that no
        // longer exist, so they are neither read nor released — just replaced.
        const stored = this.attrKeys.get(token);
        const previous = stored?.generation === this.generation ? stored.slots : undefined;
        const existingKey = previous?.get(slot);

        if (attrValue === null) {
            if (existingKey) {
                this.releaseKey(existingKey);
                previous!.delete(slot);
            }
            return null;
        }

        const key = `@${attrName}=${attrValue}${KEY_SEP}${shape}`;
        if (existingKey === key) {
            return key; // unchanged — a true no-op, same as update()
        }
        if (existingKey) {
            this.releaseKey(existingKey);
        }

        const rule = this.rules.get(key);
        if (rule) {
            rule.refs++;
        } else {
            const themed = this.themer(themeAs, attrValue);
            if (themed == null) {
                previous?.delete(slot);
                return null;
            }
            // Themed as one property, emitted as another (ADR 0005 D3).
            const attrSel = `[${attrName}="${escapeCSSString(attrValue)}"]`;
            const selector = tags && tags.length > 0
                ? tags.map((tag) => `${tag}${attrSel}`).join(', ')
                : `${attrSel}${qualifier}`;
            this.rules.set(key, {
                selector,
                body: `${emitAs}: ${themed} !important`,
                refs: 1,
            });
            this.dirty = true;
        }

        const slots = previous ?? new Map<string, string>();
        slots.set(slot, key);
        this.attrKeys.set(token, {generation: this.generation, slots});
        return key;
    }

    private releaseKey(key: string): void {
        const rule = this.rules.get(key);
        if (!rule) {
            return;
        }
        rule.refs--;
        if (rule.refs <= 0) {
            this.rules.delete(key);
            this.dirty = true;
        }
    }

    /** Drop this element's claim on its keys, deleting any rule that nobody else references. */
    release(token: object): void {
        // Tier-2 keys are released FIRST and unconditionally. An earlier version returned early
        // when the element had no tier-1 registration, which leaked the attribute rules of any
        // element carrying only presentational attributes and no `style` — every
        // `<rect fill="…">` in svg-heavy.html, for one.
        const attrs = this.attrKeys.get(token);
        if (attrs) {
            // Only if it is current. A stale slot names a key that `clear()` deleted; if
            // another element has since recreated that key, releasing it here would
            // decrement somebody else's rule to zero and delete a live one.
            if (attrs.generation === this.generation) {
                for (const key of attrs.slots.values()) {
                    this.releaseKey(key);
                }
            }
            this.attrKeys.delete(token);
        }

        this.releaseDeclarations(token);
    }

    /** Tier-1 keys only. `update()` uses this so it cannot disturb tier-2 registrations. */
    private releaseDeclarations(token: object): void {
        const previous = this.perElement.get(token);
        if (!previous) {
            return;
        }
        for (const key of previous) {
            this.releaseKey(key);
        }
        this.perElement.delete(token);
        this.lastAttr.delete(token);
    }

    private retain(decl: Declaration): string | null {
        if (decl.fragment.length > MAX_FRAGMENT_CHARS) {
            this.oversizedCount++;
            return null;
        }

        const key = declarationKey(decl);
        const existing = this.rules.get(key);
        if (existing) {
            existing.refs++;
            return key;
        }

        // ADR 0005 D1: theme the EXPANDED longhands, not the authored property. The engine's
        // colour maths only themes names containing `color` (plus fill/stroke/background-image),
        // and a page writes `background:#fff`. Keying the authored text while theming its
        // longhands is what makes tier 1 work at all.
        const bodies: string[] = [];
        for (const longhand of decl.longhands) {
            const themed = this.themer(longhand.property, longhand.value);
            if (themed != null) {
                // `!important` because the page's own inline style outranks any selector we can
                // write. This is the specificity win ADR 0001 item 4 requires INSTEAD of
                // deleting the page's declaration, which is what upstream did.
                bodies.push(`${longhand.property}: ${themed} !important`);
            }
        }
        if (bodies.length === 0) {
            return null;
        }

        this.rules.set(key, {
            selector: declarationSelector(decl),
            body: bodies.join('; '),
            refs: 1,
        });
        this.dirty = true;
        return key;
    }

    /** Whether the CSS has changed since the last `markClean()`. */
    get hasChanges(): boolean {
        return this.dirty;
    }

    markClean(): void {
        this.dirty = false;
    }

    /** The full CSS text for every live key. */
    buildCSS(): string {
        const out: string[] = [];
        for (const rule of this.rules.values()) {
            out.push(`${rule.selector} { ${rule.body}; }`);
        }
        return out.join('\n');
    }

    stats(): EmitterStats {
        return {
            keys: this.rules.size,
            unkeyable: this.unkeyableCount,
            oversized: this.oversizedCount,
        };
    }

    clear(): void {
        this.generation++;
        this.rules.clear();
        this.unkeyableCount = 0;
        this.oversizedCount = 0;
        this.dirty = true;
    }
}
