import {readFile, readdir} from 'node:fs/promises';
import {join, extname} from 'node:path';

// ADR 0003 D5 states which references to upstream may remain. That was prose, and a review
// found it was already false — src/background/tab-manager.ts still compared tab URLs against
// a hardcoded 'https://darkreader.org/', which is runtime logic, not a diagnostic.
//
// A claim about the codebase that nothing checks will drift. This asserts it instead.

const SRC = join(__dirname, '../../../src');

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.json'];

// Directories that are upstream's to own. config/ is the fixes catalog, synced wholesale by
// E9 and never hand-edited — it legitimately contains upstream URLs in site-fix entries.
const SKIP_DIRS = new Set(['config', 'stubs']);

async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) {
                continue;
            }
            yield* walk(join(dir, entry.name));
        } else if (CODE_EXTENSIONS.includes(extname(entry.name))) {
            yield join(dir, entry.name);
        }
    }
}

describe('Upstream references in src/', () => {
    it('no runtime code reaches an upstream-controlled endpoint', async () => {
        const offenders: string[] = [];
        for await (const file of walk(SRC)) {
            const text = await readFile(file, 'utf8');
            text.split('\n').forEach((line, i) => {
                // Only flag real endpoints. A comment explaining why we do NOT point at
                // upstream is exactly the kind of line that should survive this check.
                const trimmed = line.trim();
                const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
                if (isComment) {
                    return;
                }
                if (/darkreader\.org|raw\.githubusercontent\.com\/darkreader|github\.com\/darkreader/.test(line)) {
                    offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${trimmed}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });

    it('the extension registers no uninstall URL and fetches no news feed', async () => {
        const links = await readFile(join(SRC, 'utils/links.ts'), 'utf8');
        // Both were live outbound requests inherited from upstream. Disabling them is what
        // makes the zero-telemetry claim in the README and store listing true.
        expect(links).toMatch(/export const NEWS_URL = '';/);
        expect(links).toMatch(/export const UNINSTALL_URL = '';/);

        // Disabling them at the constant is only half the job — the call sites must guard,
        // or fetch('') resolves against the extension's own origin and runs on a loop.
        const newsmaker = await readFile(join(SRC, 'background/newsmaker.ts'), 'utf8');
        expect(newsmaker).toMatch(/if \(!NEWS_URL\)/);
        const background = await readFile(join(SRC, 'background/index.ts'), 'utf8');
        expect(background).toMatch(/if \(UNINSTALL_URL\)/);
    });

    it('user-visible branding does not use the upstream name', async () => {
        const locale = await readFile(join(SRC, '_locales/en.config'), 'utf8');
        const hits = locale.split('\n').filter((l) => l.includes('Dark Reader'));
        // Exactly one permitted mention: the MIT attribution, which the licence requires
        // and honesty demands. Any other occurrence is upstream branding in our UI.
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain('fork of Dark Reader');
    });
});
