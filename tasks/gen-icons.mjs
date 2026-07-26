// Generates Duskwright's icon set from code, so the marks are reproducible and provably
// ours rather than derived from upstream's artwork.
//
//   node tasks/gen-icons.mjs
//
// The mark is a crescent — dusk, the moment the light goes. It reads at 16px, which is the
// only size that really matters for a toolbar icon. Store icons sit on a rounded-square
// field; toolbar icons are transparent so they adapt to the user's browser chrome.
//
// Rendering is 4x supersampled and composited manually: no image dependencies, because
// adding one to satisfy an icon build would be a poor trade for an extension whose whole
// pitch is that it does very little.

import {deflateSync} from 'node:zlib';
import {writeFileSync} from 'node:fs';

const SS = 4; // supersampling factor

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0; // filter: none
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // colour type: RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, {level: 9})),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function roundedSquare(x, y, size, radius) {
    const lo = radius, hi = size - radius;
    if (x >= lo && x <= hi) return y >= 0 && y <= size;
    if (y >= lo && y <= hi) return x >= 0 && x <= size;
    const cx = x < lo ? lo : hi;
    const cy = y < lo ? lo : hi;
    return inCircle(x, y, cx, cy, radius);
}

/**
 * @param {number} size output size in px
 * @param {{field: number[]|null, mark: number[]}} colors RGB triples; field null = transparent
 */
function renderIcon(size, colors) {
    const S = size * SS;
    const out = Buffer.alloc(size * size * 4);
    // Crescent: a disc with a second, offset disc subtracted from it.
    const r = S * 0.34;
    const cx = S * 0.46, cy = S * 0.5;
    const bite = {x: S * 0.60, y: S * 0.42, r: S * 0.31};

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let fieldHits = 0, markHits = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const x = px * SS + sx + 0.5;
                    const y = py * SS + sy + 0.5;
                    if (colors.field && roundedSquare(x, y, S, S * 0.22)) fieldHits++;
                    if (inCircle(x, y, cx, cy, r) && !inCircle(x, y, bite.x, bite.y, bite.r)) markHits++;
                }
            }
            const n = SS * SS;
            const fieldA = colors.field ? fieldHits / n : 0;
            const markA = markHits / n;
            // Composite mark over field over transparency.
            const a = markA + fieldA * (1 - markA);
            const i = (py * size + px) * 4;
            if (a > 0) {
                for (let c = 0; c < 3; c++) {
                    const fieldC = colors.field ? colors.field[c] : 0;
                    out[i + c] = Math.round((colors.mark[c] * markA + fieldC * fieldA * (1 - markA)) / a);
                }
            }
            out[i + 3] = Math.round(a * 255);
        }
    }
    return encodePNG(size, size, out);
}

const DUSK = [26, 22, 42];      // deep dusk field
const MOON = [232, 224, 208];   // warm moonlight
const INK = [32, 28, 48];       // dark mark, for light browser chrome

const targets = [
    // Store / manifest icons: mark on a dusk field.
    ['src/icons/dw_16.png', 16, {field: DUSK, mark: MOON}],
    ['src/icons/dw_48.png', 48, {field: DUSK, mark: MOON}],
    ['src/icons/dw_128.png', 128, {field: DUSK, mark: MOON}],
    // Toolbar icons: transparent field so they sit in the browser's own chrome.
    ['src/icons/dw_active_19.png', 19, {field: null, mark: MOON}],
    ['src/icons/dw_active_38.png', 38, {field: null, mark: MOON}],
    ['src/icons/dw_active_light_19.png', 19, {field: null, mark: INK}],
    ['src/icons/dw_active_light_38.png', 38, {field: null, mark: INK}],
];

for (const [path, size, colors] of targets) {
    writeFileSync(path, renderIcon(size, colors));
    console.log(`wrote ${path} (${size}x${size})`);
}
