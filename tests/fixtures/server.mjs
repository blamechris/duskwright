// Serves the fixture corpus on two origins, because several fixtures only reproduce their
// failure mode across an origin boundary — a CORS-restricted stylesheet and a cross-origin
// iframe cannot be faked from a single host.
//
//   node tests/fixtures/server.mjs          # serve until killed
//   node tests/fixtures/server.mjs --check  # start, verify every fixture responds, exit
//
// Port 8788 serves tests/fixtures/pages, port 8789 serves tests/fixtures/cross-origin.
// Nothing here reaches the network: the whole point of the corpus is that it is pinned and
// offline, so a failing fixture always means our code changed, never that a website did.

import {createServer} from 'node:http';
import {readFile, readdir} from 'node:fs/promises';
import {join, extname, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const PAGES_PORT = 8788;
export const CROSS_ORIGIN_PORT = 8789;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

function serve(root, port, {cors}) {
    const server = createServer(async (req, res) => {
        // Strip query/hash, then normalize and reject any path that escapes the root.
        const rel = normalize(decodeURIComponent(req.url.split('?')[0].split('#')[0]));
        if (rel.includes('..')) {
            res.writeHead(403).end('forbidden');
            return;
        }
        const path = join(root, rel === '/' ? '/index.html' : rel);
        try {
            const body = await readFile(path);
            const headers = {'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream'};
            // The cross-origin host deliberately does NOT send Access-Control-Allow-Origin:
            // that restriction is the condition the CORS fixture exists to reproduce.
            if (cors) headers['Access-Control-Allow-Origin'] = '*';
            res.writeHead(200, headers).end(body);
        } catch {
            res.writeHead(404).end('not found');
        }
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export async function startFixtureServers() {
    const pages = await serve(join(HERE, 'pages'), PAGES_PORT, {cors: false});
    const cross = await serve(join(HERE, 'cross-origin'), CROSS_ORIGIN_PORT, {cors: false});
    return {
        pagesOrigin: `http://127.0.0.1:${PAGES_PORT}`,
        crossOrigin: `http://127.0.0.1:${CROSS_ORIGIN_PORT}`,
        async close() {
            await Promise.all([pages, cross].map((s) => new Promise((r) => s.close(r))));
        },
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const servers = await startFixtureServers();
    console.log(`fixtures:     ${servers.pagesOrigin}`);
    console.log(`cross-origin: ${servers.crossOrigin}`);

    if (process.argv.includes('--check')) {
        const names = (await readdir(join(HERE, 'pages'))).filter((f) => f.endsWith('.html'));
        let bad = 0;
        for (const name of names) {
            const res = await fetch(`${servers.pagesOrigin}/${name}`);
            if (!res.ok) {
                console.error(`  FAIL ${name} -> ${res.status}`);
                bad++;
            }
        }
        for (const name of ['cross-origin.css', 'cross-origin-frame.html']) {
            const res = await fetch(`${servers.crossOrigin}/${name}`);
            if (!res.ok) {
                console.error(`  FAIL ${name} -> ${res.status}`);
                bad++;
            }
        }
        console.log(bad ? `${bad} fixture(s) failed to serve` : `all ${names.length + 2} fixtures served OK`);
        await servers.close();
        process.exit(bad ? 1 : 0);
    }
}
