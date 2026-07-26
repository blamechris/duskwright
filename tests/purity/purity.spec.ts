import {test, expect} from '@playwright/test';
import type {BrowserContext} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {capture, launchClean, launchWithExtension} from './harness';
import {isViolation, describeViolation} from './ownership';
import {attributableToExtension} from './diff';
import {startFixtureServers} from '../fixtures/server.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// Settle budget. Long enough for late-injected-styles.html, whose last write lands at
// 1600ms, so a slow violation cannot hide behind an early snapshot.
const SETTLE_MS = 2200;

interface FixtureEntry {
    file: string;
    note?: string;
    nondeterministic?: boolean;
}

// Read synchronously at collection time so the per-fixture tests exist before the run
// starts — Playwright needs the test list up front.
const manifest = JSON.parse(
    readFileSync(join(HERE, '../fixtures/index.json'), 'utf8'),
) as {fixtures: FixtureEntry[]};

// The baseline of violations E1 imported and E2 has not fixed yet. See the file's own
// $comment: it is a ratchet, not an exclusion list. Entries may only be removed.
const baseline = JSON.parse(
    readFileSync(join(HERE, 'known-violations.json'), 'utf8'),
) as {fixtures: Record<string, string[]>};

let servers: Awaited<ReturnType<typeof startFixtureServers>>;
let treated: BrowserContext;
let clean: BrowserContext;

test.beforeAll(async () => {
    servers = await startFixtureServers();
    treated = await launchWithExtension();
    clean = await launchClean();
});

test.afterAll(async () => {
    await treated?.close();
    await clean?.close();
    await servers?.close();
});

test('the corpus is non-empty', () => {
    // A harness that silently runs zero fixtures reports green. Given how many gates in this
    // repo have already managed to pass while checking nothing, this is asserted first.
    expect(manifest.fixtures.length).toBeGreaterThan(20);
});

test('the extension is actually loaded and theming', async () => {
    // Without this, every other assertion below passes trivially if the extension fails to
    // load — a completely inert harness reporting a perfect score. This is the single most
    // important test in the file.
    const url = `${servers.pagesOrigin}/static-plain.html`;
    const withExt = await capture(treated, url, SETTLE_MS);
    const withoutExt = await capture(clean, url, SETTLE_MS);

    expect(
        withExt.mutations.length,
        'the extension produced no mutations at all — is it loaded?',
    ).toBeGreaterThan(withoutExt.mutations.length);
});

for (const entry of manifest.fixtures) {
    test.describe(entry.file, () => {
        test('produces no observable mutation of page-owned DOM', async () => {
            const url = `${servers.pagesOrigin}/${entry.file}`;
            const after = await capture(treated, url, SETTLE_MS);
            const before = await capture(clean, url, SETTLE_MS);

            // Subtract what the page does to itself; the residue is the extension's doing.
            const residue = attributableToExtension(after.mutations, before.mutations, {
                ignoreChildListCounts: Boolean(entry.nondeterministic),
            });
            const violations = residue.filter(isViolation);
            // Strip the trailing [path] so the signature is stable across runs.
            const seen = [...new Set(
                violations.map((v) => describeViolation(v).replace(/\s+\[.*$/, '').trim()),
            )].sort();
            const known = (baseline.fixtures[entry.file] ?? []).slice().sort();

            // Equality, not subset. A new violation fails; so does one that vanished,
            // because the baseline must then be tightened rather than left slack.
            expect(
                seen,
                seen.length > known.length
                    ? `NEW purity violation in ${entry.file} — this is a regression, fix the code`
                    : `${entry.file} now has FEWER violations than the baseline. Good — remove the fixed entries from tests/purity/known-violations.json`,
            ).toEqual(known);
        });

        test('leaves page-owned HTML and stylesheets byte-identical', async () => {
            test.skip(
                Boolean(entry.nondeterministic),
                'fixture rewrites itself on a timer; the observer assertion covers it',
            );
            test.skip(
                (baseline.fixtures[entry.file] ?? []).length > 0,
                'known-violating fixture: the serialized page cannot match until E2 lands',
            );
            const url = `${servers.pagesOrigin}/${entry.file}`;
            const before = await capture(clean, url, SETTLE_MS);
            const after = await capture(treated, url, SETTLE_MS);

            // adoptedStyleSheets changes fire no MutationRecord, so stylesheet text is the
            // only surface that catches them. This is not redundant with the observer
            // assertion — each catches what the other structurally cannot.
            expect(after.stylesheets, 'page-owned stylesheet text changed').toBe(before.stylesheets);
            expect(after.html, 'serialized page HTML changed').toBe(before.html);
        });
    });
}
