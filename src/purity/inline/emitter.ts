import type {Declaration} from './keys';
import {declarationKey, declarationSelector, parseInlineDeclarations} from './keys';

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

interface Rule {
    selector: string;
    /** Declaration text inside the rule body, e.g. `color: #e8e8ea !important`. */
    body: string;
    /** How many elements currently reference this key. */
    refs: number;
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
    private unkeyableCount = 0;
    private oversizedCount = 0;
    private dirty = false;

    constructor(private readonly themer: Themer) {}

    /**
     * Register an element's current inline style, replacing whatever it was registered with
     * before. `token` identifies the element; the caller passes the element itself.
     *
     * Returns the keys now attributed to this element.
     */
    update(token: object, attr: string | null): string[] {
        this.release(token);
        if (!attr) {
            return [];
        }

        const parsed = parseInlineDeclarations(attr);
        // isTier1Safe's rule, applied here so we only walk the attribute once: if ANY
        // declaration is un-keyable the whole attribute goes to tier 3, because the colliding
        // selector is derived from one of these declarations and dropping it is not enough.
        if (parsed.some((d) => d.unkeyable !== null)) {
            this.unkeyableCount += parsed.length;
            return [];
        }

        const keys: string[] = [];
        for (const decl of parsed) {
            const key = this.retain(decl);
            if (key) {
                keys.push(key);
            }
        }
        this.perElement.set(token, keys);
        return keys;
    }

    /** Drop this element's claim on its keys, deleting any rule that nobody else references. */
    release(token: object): void {
        const previous = this.perElement.get(token);
        if (!previous) {
            return;
        }
        for (const key of previous) {
            const rule = this.rules.get(key);
            if (!rule) {
                continue;
            }
            rule.refs--;
            if (rule.refs <= 0) {
                this.rules.delete(key);
                this.dirty = true;
            }
        }
        this.perElement.delete(token);
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

        const themed = this.themer(decl.property, decl.value);
        if (themed == null) {
            return null;
        }

        // `!important` because the page's own inline style is more specific than any selector
        // we can write. This is the specificity win ADR 0001 item 4 requires INSTEAD of
        // deleting the page's declaration, which is what upstream did.
        this.rules.set(key, {
            selector: declarationSelector(decl),
            body: `${decl.property}: ${themed} !important`,
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
        this.rules.clear();
        this.unkeyableCount = 0;
        this.oversizedCount = 0;
        this.dirty = true;
    }
}
