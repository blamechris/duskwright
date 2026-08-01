// PURITY REWRITE (E2, ADR 0004 + ADR 0005). This file is upstream, and upstream files get
// minimal edits — but `overrideInlineStyle` IS the violation the project exists to remove, so
// its body is replaced rather than trimmed.
//
// What upstream did: read an element's inline styling, compute a themed value, then write that
// value into the element's own `style` attribute as a `--darkreader-inline-*` custom property
// and tag the element with a matching `data-darkreader-inline-*` attribute. Both writes are
// serializable page state — ADR 0001 items 1-5, and the Google Sheets failure verbatim.
//
// What happens now: the element is read and never written. Its declarations are registered with
// a rule table (`src/purity/inline/`), which emits selectors matching the attribute text into a
// stylesheet we own. The observers, the element-discovery walk and the shadow-root plumbing
// below are upstream's and are untouched.
//
// Deliberately NOT carried over, each counted in `inlineStyleStats()` rather than dropped
// silently — see the ADRs for why none of them is expressible as a shared declaration key:
//   - SVG `fill` on non-`<text>` elements (geometry-dependent modifier, ADR 0005 D4)
//   - whole-`<svg>` inversion via `data-darkreader-inline-invert` (ADR 0001 item 6)
//   - `background-image: url(...)` and the `background=` attribute (async + identity-dependent)
//   - `var()`-valued and inline-`!important` declarations (ADR 0005)
//
// Also gone, because both existed only to survive our own writes: the loop detector (a page
// that rewrote its style attribute in response to ours), and the ProseMirror early return (an
// editor that rebuilt its HTML after we wrote). Neither can be provoked by a reader.

import type {Theme} from '../../definitions';
import {push} from '../../utils/array';
import {isShadowDomSupported} from '../../utils/platform';
import {throttle} from '../../utils/throttle';
import {getDuration} from '../../utils/time';
import {iterateShadowHosts, createOptimizedTreeObserver} from '../utils/dom';
import {InlineStyleEngine} from '../../purity/inline/engine';
import type {InlineEngineStats} from '../../purity/inline/engine';
import {createProbeExpander} from '../../purity/inline/expand';
import {createBrowserValidator} from '../../purity/inline/ignore';

import type {CSSValueModifier} from './modify-css';
import {getModifiableCSSDeclaration} from './modify-css';
import {variablesStore} from './variables';


const INLINE_STYLE_ATTRS = ['style', 'fill', 'stop-color', 'stroke', 'bgcolor', 'color', 'background'];
export const INLINE_STYLE_SELECTOR = INLINE_STYLE_ATTRS.map((attr) => `[${attr}]`).join(', ');

let currentTheme: Theme | null = null;
let ignoreImageSelectors: string[] = [];

/**
 * A detached element used to hand the modifier a style context.
 *
 * `getModifiableCSSDeclaration` reads sibling declarations off the rule it is given — border
 * widths, `mask-image` — so it needs *a* style object. It must not be the page element's:
 * the whole premise of declaration keying is that one rule serves every element carrying that
 * declaration, so an answer that varies by element is unsound no matter how convenient.
 *
 * Never inserted, never observed, invisible to the page — the same argument as the shorthand
 * probe in `expand.ts`.
 */
let modifierProbe: HTMLElement | null = null;

function themeDeclaration(property: string, value: string): string | null | Promise<string | null> {
    // Both shapes return a declaration SET rather than a value, and both are already marked
    // un-keyable before they reach tier 1. Refused here too, so the tier-2 attribute path
    // cannot reach the modifier factory and subscribe to variable type changes.
    if (property.startsWith('--') || value.includes('var(')) {
        return null;
    }
    if (!modifierProbe) {
        modifierProbe = document.createElement('div');
    }
    modifierProbe.style.cssText = '';
    modifierProbe.style.cssText = `${property}: ${value}`;

    asyncCancelled = false;
    const mod = getModifiableCSSDeclaration(
        property,
        value,
        {style: modifierProbe.style, selectorText: ''} as CSSStyleRule,
        variablesStore,
        ignoreImageSelectors,
        isAsyncCancelled,
    );
    if (!mod || !currentTheme) {
        return null;
    }
    const themed = typeof mod.value === 'function'
        ? (mod.value as CSSValueModifier)(currentTheme)
        : mod.value;
    if (typeof themed === 'string') {
        return themed;
    }
    return themed instanceof Promise ? themed : null;
}

let engine: InlineStyleEngine | null = null;

function inlineEngine(): InlineStyleEngine {
    if (!engine) {
        engine = new InlineStyleEngine({
            themer: themeDeclaration,
            expand: createProbeExpander(),
            isValidSelector: createBrowserValidator(),
        });
    }
    return engine;
}

/**
 * The current rule text. Empty until elements have been registered — the sheet is filled in by
 * `commitInlineStyles()` as they are discovered, not once at startup.
 */
export function getInlineOverrideStyle(): string {
    return inlineEngine().buildCSS();
}

/** Keep one of our `<style>` elements in sync: the document's, or a shadow root's. */
export function attachInlineStyleSheet(style: HTMLStyleElement): void {
    inlineEngine().attachSheet(style);
}

/** Write pending rules into every attached sheet. Cheap when nothing changed. */
export function commitInlineStyles(): void {
    inlineEngine().commit();
}

/** Theming this build cannot express, counted so the gap stays visible. */
export function inlineStyleStats(): InlineEngineStats {
    return inlineEngine().stats();
}

const commitInlineStylesThrottled = throttle(() => inlineEngine().commit());

function getInlineStyleElements(root: Node) {
    const results: HTMLElement[] = [];
    if (root instanceof Element && root.matches(INLINE_STYLE_SELECTOR)) {
        results.push(root as HTMLElement);
    }
    if (root instanceof Element || (isShadowDomSupported && root instanceof ShadowRoot) || root instanceof Document) {
        push(results, root.querySelectorAll(INLINE_STYLE_SELECTOR));
    }
    return results;
}

const treeObservers = new Map<Node, {disconnect(): void}>();
const attrObservers = new Map<Node, MutationObserver>();

let asyncCancelled = true;

function isAsyncCancelled() {
    return asyncCancelled;
}

export function watchForInlineStyles(
    elementStyleDidChange: (element: HTMLElement) => void,
    shadowRootDiscovered: (root: ShadowRoot) => void,
): void {
    deepWatchForInlineStyles(document, elementStyleDidChange, shadowRootDiscovered);
    iterateShadowHosts(document.documentElement, (host) => {
        deepWatchForInlineStyles(host.shadowRoot!, elementStyleDidChange, shadowRootDiscovered);
    });
}

function deepWatchForInlineStyles(
    root: Document | ShadowRoot,
    elementStyleDidChange: (element: HTMLElement) => void,
    shadowRootDiscovered: (root: ShadowRoot) => void,
): void {
    if (treeObservers.has(root)) {
        treeObservers.get(root)!.disconnect();
        attrObservers.get(root)!.disconnect();
    }

    const discoveredNodes = new WeakSet<Node>();

    function discoverNodes(node: Node) {
        getInlineStyleElements(node).forEach((el: HTMLElement) => {
            if (discoveredNodes.has(el)) {
                return;
            }
            discoveredNodes.add(el);
            elementStyleDidChange(el);
        });
        iterateShadowHosts(node, (n) => {
            if (discoveredNodes.has(n)) {
                return;
            }
            discoveredNodes.add(n);
            shadowRootDiscovered(n.shadowRoot!);
            deepWatchForInlineStyles(n.shadowRoot!, elementStyleDidChange, shadowRootDiscovered);
        });
    }

    const treeObserver = createOptimizedTreeObserver(root, {
        onMinorMutations: (_root, {additions}) => {
            additions.forEach((added) => discoverNodes(added));
            variablesStore.matchVariablesAndDependents();
        },
        onHugeMutations: () => {
            discoverNodes(root);
            variablesStore.matchVariablesAndDependents();
        },
    });
    treeObservers.set(root, treeObserver);

    let attemptCount = 0;
    let start: number | null = null;
    const ATTEMPTS_INTERVAL = getDuration({seconds: 10});
    const RETRY_TIMEOUT = getDuration({seconds: 2});
    const MAX_ATTEMPTS_COUNT = 50;
    let cache: MutationRecord[] = [];
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleAttributeMutations = throttle((mutations: MutationRecord[]) => {
        const handledTargets = new Set<Node>();
        mutations.forEach((m) => {
            const target = m.target as HTMLElement;
            if (handledTargets.has(target)) {
                return;
            }
            if (INLINE_STYLE_ATTRS.includes(m.attributeName!)) {
                handledTargets.add(target);
                elementStyleDidChange(target);
            }
        });
        variablesStore.matchVariablesAndDependents();
    });
    const attrObserver = new MutationObserver((mutations) => {
        if (timeoutId) {
            cache.push(...mutations);
            return;
        }
        attemptCount++;
        const now = Date.now();
        if (start == null) {
            start = now;
        } else if (attemptCount >= MAX_ATTEMPTS_COUNT) {
            if (now - start < ATTEMPTS_INTERVAL) {
                timeoutId = setTimeout(() => {
                    start = null;
                    attemptCount = 0;
                    timeoutId = null;
                    const attributeCache = cache;
                    cache = [];
                    handleAttributeMutations(attributeCache);
                }, RETRY_TIMEOUT);
                cache.push(...mutations);
                return;
            }
            start = now;
            attemptCount = 1;
        }
        handleAttributeMutations(mutations);
    });
    attrObserver.observe(root, {
        attributes: true,
        // Upstream also watched its own `data-darkreader-inline-*` markers here, because it
        // wrote them and had to notice a page stripping them back off. Nothing writes them now.
        attributeFilter: INLINE_STYLE_ATTRS,
        subtree: true,
    });
    attrObservers.set(root, attrObserver);
}

export function stopWatchingForInlineStyles(): void {
    asyncCancelled = true;
    treeObservers.forEach((o) => o.disconnect());
    attrObservers.forEach((o) => o.disconnect());
    treeObservers.clear();
    attrObservers.clear();
    commitInlineStylesThrottled.cancel();
    inlineEngine().clear();
}

/**
 * Register an element's inline styling. **Writes nothing to the element.**
 *
 * The signature is upstream's so the call sites in `index.ts` are unchanged. What it does is
 * not: the element is read, its declarations are keyed, and the rules land in a sheet we own.
 * See the file header for what that costs and what it removes.
 */
export function overrideInlineStyle(
    element: HTMLElement,
    theme: Theme,
    ignoreInlineSelectors: string[],
    ignoreImageAnalysisSelectors: string[],
): void {
    currentTheme = theme;
    ignoreImageSelectors = ignoreImageAnalysisSelectors;
    inlineEngine().setIgnoreSelectors(ignoreInlineSelectors);
    inlineEngine().register(element);

    // Upstream fed inline custom properties to the variable store from inside its write path.
    // Kept because it only READS the declaration block — it is how `--darkreader-root-vars`
    // learns about variables the page defined inline.
    if (element.style && element.getAttribute('style')?.includes('--')) {
        variablesStore.addInlineStyleForMatching(element.style);
    }

    // Coalesced to one sheet write per frame: the discovery pass calls this once per element,
    // and `index.ts` commits synchronously at the end of that pass so the first paint is not
    // a frame late.
    commitInlineStylesThrottled();
}
