// Wiring the rule table into the theming engine — ADR 0004 step 2, corrected by ADR 0005.
//
// This is the module that removes the project's founding violation. Upstream themed an
// inline-styled element by writing the themed value back into that element's own `style`
// attribute and tagging it with a `data-darkreader-inline-*` marker. Both writes are
// serializable page state (ADR 0001 items 1-5), which is the Google Sheets failure verbatim.
//
// Here nothing is written to the element at all. We read what the page already wrote, derive a
// selector matching exactly that text, and emit a rule into a stylesheet we own.
//
// The colour maths is injected as a `Themer` rather than imported, so this file stays free of
// upstream imports and testable in Node. Same reason `emitter.ts` knows nothing about colour.
//
// The DOM-reading half is deliberately one small function (`readElementFacts`). Everything that
// DECIDES anything is pure and unit-tested, because this repo has no jsdom and adding one to
// test SVG element types would be the exact "stub friendlier than reality" failure that has
// already cost this module four bugs. The DOM behaviour is asserted against real Chromium.

import type {AttributeSpec, EmitterStats} from './emitter';
import {InlineRuleEmitter} from './emitter';
import type {Expander} from './expand';
import type {SelectorValidator} from './ignore';
import {ignoresEverything, usableIgnoreSelectors} from './ignore';

/**
 * Produce the themed replacement for one property/value pair, or null to leave it alone.
 *
 * A `Promise` return means the engine wanted to analyse an image before answering. Tier 1
 * cannot use that answer — see `deferred.asyncImage` — so it is counted and dropped.
 */
export type InlineThemer = (property: string, value: string) => string | null | Promise<string | null>;

/** Work this step deliberately does not do, counted rather than silently skipped. */
export interface DeferredCounts {
    /**
     * SVG `fill` on anything but `<text>` (ADR 0005 D4). Upstream picks the modifier from the
     * measured geometry of the element and its owning `<svg>`, so `<rect fill="#fff">` and
     * `<text fill="#fff">` would need one selector to give two different answers. Tier 3.
     */
    svgFill: number;
    /**
     * Whole-`<svg>` inversion (ADR 0001 item 6). Upstream serialises the SVG, analyses it as an
     * image, and writes `data-darkreader-inline-invert` onto the page's own `<svg>` — a P1
     * violation, and a per-element decision besides. Tier 3.
     */
    svgInvert: number;
    /**
     * `background-image: url(...)` and the `background="..."` attribute.
     *
     * Upstream themes these only on `<html>`/`<body>`, through an async image analysis whose
     * result is then conditioned on the element's identity: if the analysed image comes back
     * unchanged it substitutes `none`, to keep a big bright image off the page background.
     * "Which element is this?" is precisely what a shared declaration key cannot carry, and
     * theming without the substitution is worse than not theming — it leaves the bright image
     * in place while reporting the declaration as handled.
     */
    asyncImage: number;
}

export interface InlineEngineStats extends EmitterStats {
    deferred: DeferredCounts;
}

export interface InlineEngineOptions {
    themer: InlineThemer;
    expand: Expander;
    /** Used to drop catalog ignore-selectors the CSS parser rejects. See `ignore.ts`. */
    isValidSelector: SelectorValidator;
}

// ---------------------------------------------------------------------------------------------
// The decision layer. Pure — no DOM, no emitter, no theme.
// ---------------------------------------------------------------------------------------------

/**
 * Everything about an element that decides how it gets themed.
 *
 * Reading this is the only part that needs a DOM. Splitting it out is what makes the tier-2
 * spec table testable, and the spec table is where silent mis-theming lives: a `themeAs` and an
 * `emitAs` swapped by accident produces a rule that parses, applies, and paints nothing.
 */
export interface ElementFacts {
    style: string | null;
    bgcolor: string | null;
    color: string | null;
    stopColor: string | null;
    fill: string | null;
    stroke: string | null;
    isSVG: boolean;
    isSVGText: boolean;
    isSVGLine: boolean;
    isSVGRoot: boolean;
    /** `<link rel="mask-icon">`. Upstream refuses to touch these; writing provoked a DOMException. */
    isMaskIconLink: boolean;
    /** `class` of the element and of its parent — upstream's gate for SVG-as-image inversion. */
    className: string | null;
    parentClassName: string | null;
}

/** One tier-2 registration. A null `attrValue` releases whatever that slot was holding. */
export interface AttributeRegistration {
    attrName: string;
    attrValue: string | null;
    spec: AttributeSpec;
}

const BGCOLOR: AttributeSpec = {themeAs: 'background-color', emitAs: 'background-color'};
const COLOR: AttributeSpec = {themeAs: 'color', emitAs: 'color'};
const STOP_COLOR: AttributeSpec = {themeAs: 'background-color', emitAs: 'stop-color'};
/** Only `<text>` — its modifier is unconditionally `color`, so it is keyable (ADR 0005 D4). */
const TEXT_FILL: AttributeSpec = {themeAs: 'color', emitAs: 'fill', tags: ['text']};
/** `stroke` is themed as a border on `<line>`/`<text>` and as foreground everywhere else. */
const STROKE_LINEAR: AttributeSpec = {themeAs: 'border-color', emitAs: 'stroke', tags: ['line', 'text']};
const STROKE_OTHER: AttributeSpec = {themeAs: 'color', emitAs: 'stroke', qualifier: ':not(line):not(text)'};

/**
 * Legacy colour attributes accept bare hex. `<td bgcolor="fff">` is valid HTML and renders
 * white, so the value handed to the colour maths needs the `#` the page omitted.
 *
 * The *selector* still matches the attribute exactly as written; normalisation applies only to
 * the value we theme from. Conflating the two emits `[bgcolor="#fff"]`, which matches nothing
 * on a page that wrote `bgcolor="fff"`.
 */
export function normalizeBgcolorAttr(value: string): string {
    if (value.match(/^[0-9a-f]{3}$/i) || value.match(/^[0-9a-f]{6}$/i)) {
        return `#${value}`;
    }
    return value;
}

/** As above, plus upstream's four-digit form. Mirrored exactly rather than reasoned about. */
export function normalizeColorAttr(value: string): string {
    if (value.match(/^[0-9a-f]{3}$/i) || value.match(/^[0-9a-f]{6}$/i)) {
        return `#${value}`;
    }
    if (value.match(/^#?[0-9a-f]{4}$/i)) {
        const hex = value.startsWith('#') ? value.substring(1) : value;
        return `#${hex}00`;
    }
    return value;
}

/** See `DeferredCounts.asyncImage`. */
function isDeferredImage(property: string, value: string): boolean {
    return (property === 'background-image' || property === 'list-style-image') && value.includes('url(');
}

/** `none` and `currentColor` are not colours to modify; upstream skips them and so do we. */
function isThemableFill(value: string | null): value is string {
    return value !== null && value !== 'none' && value !== 'currentColor';
}

/**
 * The tier-2 registrations for an element — ADR 0004 tier 2, ADR 0005 D3/D4.
 *
 * Every slot appears on every pass, including with a null value, because "the page removed
 * this attribute" has to release the rule that slot was holding. The two `stroke` shapes are
 * mutually exclusive by selector, so exactly one of them can ever match a given element.
 */
export function attributeRegistrations(facts: ElementFacts): AttributeRegistration[] {
    const out: AttributeRegistration[] = [
        {
            attrName: 'bgcolor',
            attrValue: facts.bgcolor,
            spec: facts.bgcolor === null
                ? BGCOLOR
                : {...BGCOLOR, themeValue: normalizeBgcolorAttr(facts.bgcolor)},
        },
        {
            attrName: 'color',
            // Upstream refuses `<link rel="mask-icon" color="#000">`. We do not write, so the
            // DOMException it was avoiding cannot happen — but we keep the same set of elements
            // it acts on rather than widen coverage on a hunch.
            attrValue: facts.isMaskIconLink ? null : facts.color,
            spec: facts.isMaskIconLink || facts.color === null
                ? COLOR
                : {...COLOR, themeValue: normalizeColorAttr(facts.color)},
        },
    ];

    if (!facts.isSVG) {
        return out;
    }

    out.push({attrName: 'stop-color', attrValue: facts.stopColor, spec: STOP_COLOR});
    out.push({
        attrName: 'fill',
        attrValue: facts.isSVGText && isThemableFill(facts.fill) ? facts.fill : null,
        spec: TEXT_FILL,
    });

    const linear = facts.isSVGLine || facts.isSVGText;
    out.push({attrName: 'stroke', attrValue: linear ? facts.stroke : null, spec: STROKE_LINEAR});
    out.push({attrName: 'stroke', attrValue: linear ? null : facts.stroke, spec: STROKE_OTHER});
    return out;
}

/**
 * The theming this step cannot express, so the gap is visible rather than assumed.
 *
 * Nothing here writes anything. The point is that a capability we dropped shows up in `stats()`
 * instead of surfacing months later as "SVG logos stopped inverting".
 */
export function deferredWork(facts: ElementFacts): Pick<DeferredCounts, 'svgFill' | 'svgInvert'> {
    if (!facts.isSVG) {
        return {svgFill: 0, svgInvert: 0};
    }
    const svgFill = isThemableFill(facts.fill) && !facts.isSVGText ? 1 : 0;
    // Upstream's own gate for treating an `<svg>` as an image worth inverting.
    const svgInvert = facts.isSVGRoot && (
        Boolean(facts.className?.includes('logo')) ||
        Boolean(facts.parentClassName?.includes('logo'))
    ) ? 1 : 0;
    return {svgFill, svgInvert};
}

// ---------------------------------------------------------------------------------------------
// The DOM layer.
// ---------------------------------------------------------------------------------------------

/** The one function here that needs a live DOM. */
export function readElementFacts(element: Element): ElementFacts {
    const isSVG = element instanceof SVGElement;
    return {
        style: element.getAttribute('style'),
        bgcolor: element.getAttribute('bgcolor'),
        color: element.getAttribute('color'),
        stopColor: isSVG ? element.getAttribute('stop-color') : null,
        fill: isSVG ? element.getAttribute('fill') : null,
        stroke: isSVG ? element.getAttribute('stroke') : null,
        isSVG,
        isSVGText: element instanceof SVGTextElement,
        isSVGLine: element instanceof SVGLineElement,
        isSVGRoot: element instanceof SVGSVGElement,
        isMaskIconLink: element instanceof HTMLLinkElement && element.rel === 'mask-icon',
        className: element.getAttribute('class'),
        parentClassName: element.parentElement?.getAttribute('class') ?? null,
    };
}

export class InlineStyleEngine {
    private readonly emitter: InlineRuleEmitter;
    private readonly isValidSelector: SelectorValidator;
    /** Every `<style>` carrying our rules: one per document, one per shadow root. Ours, always. */
    private readonly sheets = new Set<HTMLStyleElement>();
    private ignoreSelectors: readonly string[] = [];
    private ignoreEverything = false;
    private deferred: DeferredCounts = {svgFill: 0, svgInvert: 0, asyncImage: 0};

    constructor({themer, expand, isValidSelector}: InlineEngineOptions) {
        this.isValidSelector = isValidSelector;
        this.emitter = new InlineRuleEmitter((property, value) => {
            if (isDeferredImage(property, value)) {
                // Refused BEFORE the themer runs. Asking for it starts a real image load and
                // analysis whose result we would only discard — wasted work, and a request the
                // page never made.
                this.deferred.asyncImage++;
                return null;
            }
            const themed = themer(property, value);
            if (typeof themed === 'string') {
                return themed;
            }
            if (themed && typeof (themed as Promise<string | null>).then === 'function') {
                // Swallow the rejection: an image that fails to load must not surface as an
                // unhandled rejection in the page's console, which the page can observe.
                (themed as Promise<string | null>).catch(() => null);
                this.deferred.asyncImage++;
            }
            return null;
        }, expand);
    }

    /**
     * The site's `ignoreInlineStyle` selectors — 229 catalog sites use this.
     *
     * Under declaration keying there is no per-element early return available, so the exclusion
     * becomes a `:not()` on every emitted rule. See `ignore.ts` for why invalid selectors are
     * dropped one at a time rather than allowed to poison the rule.
     */
    setIgnoreSelectors(selectors: readonly string[]): void {
        // Validated ONCE, and the validated list is the only one used afterwards.
        //
        // `matchesIgnored` below calls `element.matches()` on these, and `matches()` THROWS
        // SyntaxError on an invalid selector — which would propagate out through
        // `overrideInlineStyle` and abort the whole discovery pass, so one typo in the synced
        // catalog would leave the entire page unthemed. That is precisely the failure the
        // qualifier's validation exists to prevent, and keeping a second unvalidated copy
        // around defeated it.
        this.ignoreSelectors = usableIgnoreSelectors(selectors, this.isValidSelector);
        this.ignoreEverything = ignoresEverything(selectors);
        this.emitter.setIgnoreQualifier(
            this.ignoreEverything || this.ignoreSelectors.length === 0
                ? ''
                : `:not(${this.ignoreSelectors.join(', ')})`,
        );
    }

    /** A sheet to keep in sync. Ours, always — never a page-owned stylesheet. */
    attachSheet(style: HTMLStyleElement): void {
        this.sheets.add(style);
        style.textContent = this.emitter.buildCSS();
    }

    detachSheet(style: HTMLStyleElement): void {
        this.sheets.delete(style);
    }

    /**
     * Read an element's inline styling and register the rules it needs.
     *
     * Idempotent: re-registering an element whose attributes have not changed is a true no-op,
     * not a release-and-retain that nets out. The discovery pass re-visits every element on
     * every theme change, so that distinction is the difference between a stable sheet and one
     * that is rebuilt on every repaint.
     */
    register(element: Element): void {
        // Only the per-element match needs the DOM; the site-wide case is a flag, and it is
        // checked inside `registerFacts` so the seam cannot skip it.
        if (this.matchesIgnored(element)) {
            // The rule for an ignored element carries a `:not()` excluding it anyway, so
            // emitting it is pure waste. Release rather than skip: an element can be moved
            // into an ignored region after it was registered.
            this.emitter.release(element);
            return;
        }
        this.registerFacts(element, readElementFacts(element));
    }

    /**
     * `register()` with the DOM read already done.
     *
     * The seam exists so the whole lifecycle — register, re-register, release, the exclusion
     * qualifier, the deferred counts — is drivable without a DOM. There is no jsdom in this
     * repo, and adding one to fake `SVGTextElement` would be the exact "stub friendlier than
     * reality" failure that has already cost this module four bugs.
     */
    registerFacts(token: object, facts: ElementFacts): void {
        if (this.ignoreEverything) {
            this.emitter.release(token);
            return;
        }
        // Tier 1 FIRST. `update()` releases this element's declaration keys, and the tier-2
        // registrations below must not be swept up in that release.
        this.emitter.update(token, facts.style);
        for (const {attrName, attrValue, spec} of attributeRegistrations(facts)) {
            this.emitter.updateAttribute(token, attrName, attrValue, spec);
        }

        const {svgFill, svgInvert} = deferredWork(facts);
        this.deferred.svgFill += svgFill;
        this.deferred.svgInvert += svgInvert;
    }

    /** Drop every rule this element referenced. `object` because the token identifies it. */
    release(token: object): void {
        this.emitter.release(token);
    }

    /**
     * Push the current rule text into every attached sheet.
     *
     * Returns whether anything was written, so a caller can tell a real update from a no-op.
     */
    commit(): boolean {
        if (!this.emitter.hasChanges) {
            return false;
        }
        const css = this.emitter.buildCSS();
        for (const sheet of this.sheets) {
            sheet.textContent = css;
        }
        this.emitter.markClean();
        return true;
    }

    buildCSS(): string {
        return this.emitter.buildCSS();
    }

    stats(): InlineEngineStats {
        return {...this.emitter.stats(), deferred: {...this.deferred}};
    }

    clear(): void {
        this.emitter.clear();
        this.sheets.clear();
        this.deferred = {svgFill: 0, svgInvert: 0, asyncImage: 0};
    }

    private matchesIgnored(element: Element): boolean {
        for (let i = 0; i < this.ignoreSelectors.length; i++) {
            if (element.matches(this.ignoreSelectors[i])) {
                return true;
            }
        }
        return false;
    }
}
