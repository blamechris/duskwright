import type {Theme} from '../../definitions';
import {forEach} from '../../utils/array';
import {isFirefox} from '../../utils/platform';

import {iterateCSSRules} from './css-rules';
import {defineSheetScope} from './style-scope';
import {createStyleSheetModifier} from './stylesheet-modifier';

let canUseSheetProxy = false;
document.addEventListener('__darkreader__inlineScriptsAllowed', () => canUseSheetProxy = true, {once: true});

const overrides = new WeakSet<CSSStyleSheet>();
const overridesBySource = new WeakMap<CSSStyleSheet, CSSStyleSheet>();

export interface AdoptedStyleSheetManager {
    render(theme: Theme, ignoreImageAnalysis: string[]): void;
    destroy(): void;
    watch(callback: (sheets: CSSStyleSheet[]) => void): void;
}

export function canHaveAdoptedStyleSheets(node: Document | ShadowRoot): boolean {
    return Array.isArray(node.adoptedStyleSheets);
}

const getAdoptedSheets: (node: Document | ShadowRoot) => CSSStyleSheet[] = isFirefox ?
    (node) => (node.adoptedStyleSheets as any).wrappedJSObject ?? node.adoptedStyleSheets :
    (node) => node.adoptedStyleSheets;

const createOverrideSheet: () => CSSStyleSheet = isFirefox ?
    () => {
        const pageWindow: any = (window as any).wrappedJSObject ?? window;
        return new pageWindow.CSSStyleSheet();
    } :
    () => new CSSStyleSheet();

export function createAdoptedStyleSheetOverride(node: Document | ShadowRoot): AdoptedStyleSheetManager {
    let cancelAsyncOperations = false;

    function iterateSourceSheets(iterator: (sheet: CSSStyleSheet) => void) {
        forEach(getAdoptedSheets(node), (sheet) => {
            if (!overrides.has(sheet)) {
                iterator(sheet);
            }
            defineSheetScope(sheet, node);
        });
    }

    // Purity: mutate adoptedStyleSheets IN PLACE rather than assigning a fresh array.
    //
    // To be clear about what this does and does not buy, because ADR 0001 originally got it
    // wrong: reassigning does NOT detach a reference the page is holding. adoptedStyleSheets
    // is an ObservableArray whose setter writes through to the same backing object, so a held
    // reference stays live — measured in Chromium, with and without this change, identical
    // either way. The correction is recorded in ADR 0001 item 14 and ADR 0002 C5.
    //
    // In-place splicing is kept anyway because it is what ADR 0002 C5 mandates, it costs
    // nothing, it matches the pattern index.ts already uses for our own sheet, and it does not
    // depend on a write-through behaviour that is an implementation detail rather than a
    // guarantee. It is a style preference, not a fix for observable harm.
    function injectSheet(sheet: CSSStyleSheet, override: CSSStyleSheet) {
        const sheets = getAdoptedSheets(node);
        const overrideIndex = sheets.indexOf(override);
        if (overrideIndex >= 0) {
            sheets.splice(overrideIndex, 1);
        }
        // Recomputed after the removal above, which can shift the source sheet's position.
        const sheetIndex = sheets.indexOf(sheet);
        sheets.splice(sheetIndex + 1, 0, override);
    }

    function clear() {
        const sheets = getAdoptedSheets(node);
        for (let i = sheets.length - 1; i >= 0; i--) {
            const sheet = sheets[i];
            if (overrides.has(sheet)) {
                sheets.splice(i, 1);
            }
        }
        sourceSheets = new WeakSet();
        sourceDeclarations = new WeakSet();
    }

    const cleaners: Array<() => void> = [];

    function destroy() {
        cleaners.forEach((c) => c());
        cleaners.splice(0);
        cancelAsyncOperations = true;
        clear();
        if (frameId) {
            cancelAnimationFrame(frameId);
            frameId = null;
        }
    }

    let rulesChangeKey = 0;

    function getRulesChangeKey() {
        let count = 0;
        iterateSourceSheets((sheet) => {
            count += sheet.cssRules.length;
        });
        if (count === 1) {
            // MS Copilot issue, where there is an empty `:root {}` style at the beginning.
            // Counting all the rules for all the shadow DOM elements can be expensive.
            const rule = getAdoptedSheets(node)[0].cssRules[0];
            return rule instanceof CSSStyleRule ? rule.style.length : count;
        }
        return count;
    }

    let sourceSheets = new WeakSet<CSSStyleSheet>();
    let sourceDeclarations = new WeakSet<CSSStyleDeclaration>();

    function render(theme: Theme, ignoreImageAnalysis: string[]) {
        clear();

        const sheets = getAdoptedSheets(node);
        for (let i = sheets.length - 1; i >= 0; i--) {
            const sheet = sheets[i];
            if (overrides.has(sheet)) {
                continue;
            }

            sourceSheets.add(sheet);
            const readyOverride = overridesBySource.get(sheet);
            if (readyOverride) {
                rulesChangeKey = getRulesChangeKey();
                injectSheet(sheet, readyOverride);
                continue;
            }

            const rules = sheet.cssRules;
            const override = createOverrideSheet();
            overridesBySource.set(sheet, override);
            iterateCSSRules(rules, (rule) => sourceDeclarations.add(rule.style));

            const prepareSheet = () => {
                for (let i = override.cssRules.length - 1; i >= 0; i--) {
                    override.deleteRule(i);
                }
                override.insertRule('#__darkreader__adoptedOverride {}');
                injectSheet(sheet, override);
                overrides.add(override);
                return override;
            };

            const sheetModifier = createStyleSheetModifier();
            sheetModifier.modifySheet({
                prepareSheet,
                sourceCSSRules: rules,
                theme,
                ignoreImageAnalysis,
                force: false,
                isAsyncCancelled: () => cancelAsyncOperations,
            });
        }

        rulesChangeKey = getRulesChangeKey();
    }

    let callbackRequested = false;

    function handleArrayChange(callback: (sheets: CSSStyleSheet[]) => void) {
        if (callbackRequested) {
            return;
        }
        callbackRequested = true;
        queueMicrotask(() => {
            callbackRequested = false;
            const sheets = getAdoptedSheets(node).filter((s) => !overrides.has(s));
            sheets.forEach((sheet) => overridesBySource.delete(sheet));
            callback(sheets);
        });
    }

    function checkForUpdates() {
        return getRulesChangeKey() !== rulesChangeKey;
    }

    let frameId: number | null = null;

    function watchUsingRAF(callback: (sheets: CSSStyleSheet[]) => void) {
        frameId = requestAnimationFrame(() => {
            if (canUseSheetProxy) {
                return;
            }
            if (checkForUpdates()) {
                handleArrayChange(callback);
            }
            watchUsingRAF(callback);
        });
    }

    function addSheetChangeEventListener(type: string, listener: (e: CustomEvent) => void) {
        node.addEventListener(type, listener as EventListener);
        cleaners.push(() => node.removeEventListener(type, listener as EventListener));
    }

    function watch(callback: (sheets: CSSStyleSheet[]) => void) {
        const onAdoptedSheetsChange = () => {
            canUseSheetProxy = true;
            handleArrayChange(callback);
        };
        addSheetChangeEventListener('__darkreader__adoptedStyleSheetsChange', onAdoptedSheetsChange);
        addSheetChangeEventListener('__darkreader__adoptedStyleSheetChange', onAdoptedSheetsChange);
        addSheetChangeEventListener('__darkreader__adoptedStyleDeclarationChange', onAdoptedSheetsChange);

        if (canUseSheetProxy) {
            return;
        }
        watchUsingRAF(callback);
    }

    return {
        render,
        destroy,
        watch,
    };
}
