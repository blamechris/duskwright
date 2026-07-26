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

/** Serialize the page's own stylesheet text — the surface a MutationObserver cannot see. */
const READ_STYLESHEETS = `
(() => {
    const out = [];
    for (const sheet of Array.from(document.styleSheets)) {
        const owner = sheet.ownerNode;
        // Skip sheets belonging to nodes we created; everything else is the page's.
        if (owner && owner.nodeType === 1 && (
            owner.classList?.contains('darkreader') ||
            owner.classList?.contains('duskwright') ||
            owner.id === 'duskwright-theme'
        )) {
            continue;
        }
        let text;
        try {
            text = Array.from(sheet.cssRules).map((r) => r.cssText).join('\\n');
        } catch (err) {
            // Cross-origin sheet — unreadable by us and by the extension alike. Record the
            // fact rather than skipping, so a sheet appearing or vanishing still shows up.
            text = '(cors-restricted)';
        }
        out.push((owner && owner.nodeName ? owner.nodeName : '?') + '::' + text);
    }
    return out.join('\\n---\\n');
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

export interface PuritySnapshot {
    html: string;
    stylesheets: string;
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

    const stylesheets = await page.evaluate(READ_STYLESHEETS) as string;
    const html = await page.evaluate(STRIP_OURS) as string;

    await page.close();
    return {html, stylesheets, mutations};
}
