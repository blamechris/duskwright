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
        // ADR 0001 item 14: upstream REASSIGNS node.adoptedStyleSheets rather than appending,
        // which detaches any array reference the page was holding. Fixtures that keep one
        // expose it here so the harness can catch that directly.
        pageArrayIntact: window.__pageAdoptedRef === undefined
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
    /** null when the fixture doesn't hold a reference; false means it was detached. */
    pageArrayIntact: boolean | null;
}

export interface PuritySnapshot {
    html: string;
    stylesheets: StylesheetState;
    /** Computed styles of a few probe elements — proof the extension is doing anything. */
    computed: Record<string, string>;
    mutations: MutationDesc[];
}

export async function launchWithExtension(): Promise<BrowserContext> {
    // MV3 service workers require a persistent context and the new headless mode.
    return chromium.launchPersistentContext('', {
        headless: true,
        channel: 'chromium',
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
        ],
    });
}

export async function launchClean(): Promise<BrowserContext> {
    return chromium.launchPersistentContext('', {headless: true, channel: 'chromium'});
}

/** Wait for the theming pipeline to settle. */
async function settle(page: Page, ms: number): Promise<void> {
    await page.waitForTimeout(ms);
}

export async function capture(context: BrowserContext, url: string, settleMs: number): Promise<PuritySnapshot> {
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
