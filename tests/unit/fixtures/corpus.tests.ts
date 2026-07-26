import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

// The corpus is the yardstick every later epic is measured against. If a failure cause or a
// purity class quietly loses its fixture, every metric derived from the corpus keeps reporting
// green while covering less — the same "gate that cannot fail" shape the purity harness itself
// is designed against. So the coverage map is asserted, not assumed.

const FIXTURES_DIR = join(__dirname, '../../fixtures');
const PAGES_DIR = join(FIXTURES_DIR, 'pages');

interface Fixture {
    file: string;
    purityClass?: string;
    cause?: number;
    epics?: string[];
    note?: string;
}

interface Manifest {
    origins: {pages: number; crossOrigin: number};
    fixtures: Fixture[];
    knownGaps: string[];
}

async function loadManifest(): Promise<Manifest> {
    return JSON.parse(await readFile(join(FIXTURES_DIR, 'index.json'), 'utf8'));
}

describe('Fixture corpus', () => {
    it('manifest and directory agree in both directions', async () => {
        const manifest = await loadManifest();
        const onDisk = (await readdir(PAGES_DIR)).filter((f) => f.endsWith('.html')).sort();
        const listed = manifest.fixtures.map((f) => f.file).sort();

        // A fixture on disk but unlisted is invisible to the coverage map below.
        expect(onDisk).toEqual(listed);
    });

    it('covers all six purity classes from ARCHITECTURE.md §2', async () => {
        const manifest = await loadManifest();
        const required = [
            'static',
            'spa-inline',
            'adopted-stylesheets',
            'shadow-dom',
            'canvas',
            'contenteditable',
        ];
        const present = new Set(manifest.fixtures.map((f) => f.purityClass).filter(Boolean));
        expect([...required].filter((c) => !present.has(c))).toEqual([]);
    });

    it('covers the failure causes from ARCHITECTURE.md §1 that can be reproduced locally', async () => {
        const manifest = await loadManifest();
        // Cause 9 (chrome://, the Web Store) is deliberately absent: the extension is not
        // permitted to run there, so it cannot be a fixture. It is recorded in knownGaps and
        // verified by E7's restricted-page detection instead.
        const reproducible = [1, 2, 3, 4, 5, 6, 7, 8];
        const present = new Set(manifest.fixtures.map((f) => f.cause).filter((c) => c !== undefined));
        expect(reproducible.filter((c) => !present.has(c))).toEqual([]);
    });

    it('documents the causes it cannot cover rather than dropping them silently', async () => {
        const manifest = await loadManifest();
        expect(manifest.knownGaps.length).toBeGreaterThan(0);
        // Cause 9 must be named explicitly, so its absence above reads as a decision.
        expect(manifest.knownGaps.some((g) => g.includes('Cause 9'))).toBe(true);
    });

    it('has a throughput fixture for the E2 selector-emission cost question', async () => {
        const manifest = await loadManifest();
        const throughput = manifest.fixtures.find((f) => f.file === 'virtualized-table.html');
        expect(throughput).toBeDefined();
        expect(throughput!.epics).toContain('E2');
    });

    it('has both a positive and a negative case for coverage detection', async () => {
        const manifest = await loadManifest();
        const files = manifest.fixtures.map((f) => f.file);
        // Without the negative case, a detector that flags everything scores 100% recall.
        expect(files).toContain('coverage-partial.html');
        expect(files).toContain('coverage-tiny-light.html');
    });

    it('fixtures are self-contained — no external network dependencies', async () => {
        const manifest = await loadManifest();
        const localOrigins = [
            `http://127.0.0.1:${manifest.origins.pages}`,
            `http://127.0.0.1:${manifest.origins.crossOrigin}`,
        ];
        for (const {file} of manifest.fixtures) {
            const html = await readFile(join(PAGES_DIR, file), 'utf8');
            const urls = html.match(/https?:\/\/[^\s"'()]+/g) ?? [];
            const external = urls.filter((u) => !localOrigins.some((o) => u.startsWith(o)));
            // A fixture that reaches the internet turns "our code changed" into "a website
            // changed", which makes every regression ambiguous.
            expect({file, external}).toEqual({file, external: []});
        }
    });
});
