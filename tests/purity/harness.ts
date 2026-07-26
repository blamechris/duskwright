import {chromium} from '@playwright/test';
import type {BrowserContext, Page} from '@playwright/test';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {OWNERSHIP_RUNTIME} from './ownership';
import type {MutationDesc} from './ownership';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const EXTENSION_PATH = join(HERE, '../../build/release/chrome-mv3');

/**
 * The recorder, injected at document_start — before any page script and before the
 * extension's content script has themed anything.
 *
 * This half of the harness is not optional. ADR 0002 C4: three of ADR 0001's fourteen
 * violations mutate and revert before any final snapshot, so a before/after diff passes
 * while the page's own observer has already fired. Snapshot diffing alone would have let
 * them ship.
 */
const RECORDER = `
${OWNERSHIP_RUNTIME}

window.__purityLog = [];
window.__purityObserver = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
        var r = records[i];
        // Descriptions must be captured synchronously: by the time the test reads them the
        // nodes may have been moved, reverted, or detached — which is precisely how the
        // transient violations hide from a snapshot.
        window.__purityLog.push({
            type: r.type,
            target: __purityDesc(r.target),
            attributeName: r.attributeName,
            oldValue: r.oldValue,
            added: Array.prototype.map.call(r.addedNodes, __purityDesc),
            removed: Array.prototype.map.call(r.removedNodes, __purityDesc),
        });
    }
});
window.__purityObserver.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
});
`;

/**
 * Serialize the page's stylesheet text — the surface a MutationObserver cannot see.
 *
 * Covers BOTH `document.styleSheets` (from <style>/<link>) and `document.adoptedStyleSheets`.
 * They are disjoint collections: adopted constructed sheets do NOT appear in
 * `document.styleSheets`. An earlier version of this harness read only the former while its
 * README claimed the adopted surface was covered — the gate did not check what it advertised,
 * which is the failure mode this whole suite exists to prevent.
 */
const READ_STYLESHEETS = `
(() => {
    const isOurNode = (owner) => Boolean(owner && owner.nodeType === 1 && (
        owner.classList?.contains('darkreader') ||
        owner.classList?.contains('duskwright') ||
        owner.id === 'duskwright-theme'
    ));

    const textOf = (sheet) => {
        try {
            return Array.from(sheet.cssRules).map((r) => r.cssText).join('\\n');
        } catch (err) {
            // Cross-origin sheet — unreadable by us and by the extension alike. Record the
            // fact rather than skipping, so a sheet appearing or vanishing still shows up.
            return '(cors-restricted)';
        }
    };

    const documentSheets = [];
    for (const sheet of Array.from(document.styleSheets)) {
        if (isOurNode(sheet.ownerNode)) {
            continue;
        }
        documentSheets.push((sheet.ownerNode?.nodeName ?? '?') + '::' + textOf(sheet));
    }

    // Adopted sheets have no owner node, so ownership cannot be read off them. They are
    // compared as a multiset subset instead: §2 permits us to APPEND ours, so extra entries
    // are fine, but every sheet the page adopted must still be present and unchanged.
    const adopted = Array.from(document.adoptedStyleSheets ?? []).map(textOf);

    return {
        documentSheets: documentSheets.join('\\n---\\n'),
        adopted,
        // ADR 0001 item 14, as CORRECTED: the harm would be a page reference going STALE,
        // not object identity changing. Measured in Chromium, adoptedStyleSheets is an
        // ObservableArray whose setter writes THROUGH to the same backing object, so even
        // a wholesale reassignment leaves a held reference live. Identity meanwhile changes
        // for an unrelated reason - the MAIN-world proxy wraps the getter - so asserting on
        // identity produced a false positive against a violation that was not occurring.
        pageArrayLive: window.__pageAdoptedRef === undefined
            ? null
            : window.__pageAdoptedRef.length === document.adoptedStyleSheets.length &&
              Array.prototype.every.call(
                  window.__pageAdoptedRef,
                  (s, i) => s === document.adoptedStyleSheets[i],
              ),
        // Recorded, NOT asserted. A wrapped accessor is not a DOM mutation and is not page
        // content, so it does not violate the invariant as stated — but it does make the
        // extension detectable, which is evidence for issue #25 (the MAIN-world proxy's fate).
        gettersIdentical: window.__pageAdoptedRef === undefined
            ? null
            : window.__pageAdoptedRef === document.adoptedStyleSheets,
    };
})()
`;

/**
 * Rendered colours, used to prove the extension is actually doing something.
 *
 * Counting mutations was the obvious liveness signal and it is exactly wrong: it would start
 * failing the moment E2 succeeds and the mutations stop — the harness's most important test,
 * guaranteed to break precisely when the project works, and then "fixed" by weakening it.
 * Computed style keeps working no matter how the theming is delivered.
 */
const READ_COMPUTED = `
(() => {
    const probe = (sel) => {
        const el = document.querySelector(sel);
        if (!el) {
            return 'absent';
        }
        const s = getComputedStyle(el);
        return s.backgroundColor + ' / ' + s.color;
    };
    return {body: probe('body'), html: probe('html')};
})()
`;

/** Remove nodes we can prove are ours, so the remaining HTML is the page's own. */
const STRIP_OURS = `
(() => {
    const ours = document.querySelectorAll('.darkreader, .duskwright, #duskwright-theme, #duskwright-host');
    ours.forEach((el) => el.remove());
    return document.documentElement.outerHTML;
})()
`;

export interface StylesheetState {
    documentSheets: string;
    adopted: string[];
    /** null when the fixture holds no reference; false means it went stale. */
    pageArrayLive: boolean | null;
    /** Recorded for issue #25, not asserted — see the note in READ_STYLESHEETS. */
    gettersIdentical: boolean | null;
}

export interface PuritySnapshot {
    html: string;
    stylesheets: StylesheetState;
    /** Computed styles of a few probe elements — proof the extension is doing anything. */
    computed: Record<string, string>;
    mutations: MutationDesc[];
}

/**
 * Every capture gets its OWN browser context, and closes it afterwards.
 *
 * Sharing one persistent context across the corpus made the suite nondeterministic: two
 * consecutive full runs failed on different fixtures (late-injected-styles + css-variables,
 * then shadow-dom-closed) with no code change between them. State accumulates across 90+
 * page loads — per-site extension settings, caches, service-worker restarts — and leaks into
 * whichever fixture happens to run next.
 *
 * Intermittent red is disqualifying for a blocking gate. It trains everyone to re-run until
 * green, which is precisely how a real violation gets waved through. Isolation costs wall
 * clock and buys the only property that matters here: the same input always gives the same
 * answer.
 */
export async function launchContext(withExtension: boolean): Promise<BrowserContext> {
    // MV3 service workers require a persistent context.
    return chromium.launchPersistentContext('', {
        headless: true,
        channel: 'chromium',
        args: withExtension
            ? [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
            ]
            : [],
    });
}

/** Wait for the theming pipeline to settle. */
async function settle(page: Page, ms: number): Promise<void> {
    await page.waitForTimeout(ms);
}

export async function capture(
    withExtension: boolean,
    url: string,
    settleMs: number,
): Promise<PuritySnapshot> {
    const context = await launchContext(withExtension);
    try {
        return await captureIn(context, url, settleMs);
    } finally {
        await context.close();
    }
}

async function captureIn(context: BrowserContext, url: string, settleMs: number): Promise<PuritySnapshot> {
    const page = await context.newPage();
    await page.addInitScript(RECORDER);
    await page.goto(url, {waitUntil: 'load'});
    await settle(page, settleMs);

    // Read the log BEFORE touching the page ourselves, or our own strip would pollute it.
    const mutations: MutationDesc[] = await page.evaluate('window.__purityLog ?? []') as MutationDesc[];
    await page.evaluate('window.__purityObserver && window.__purityObserver.disconnect()');

    const stylesheets = await page.evaluate(READ_STYLESHEETS) as StylesheetState;
    const computed = await page.evaluate(READ_COMPUTED) as Record<string, string>;
    const html = await page.evaluate(STRIP_OURS) as string;

    await page.close();
    return {html, stylesheets, computed, mutations};
}
