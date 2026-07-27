import {
    parseInlineDeclarations,
    declarationSelector,
    declarationKey,
    escapeCSSString,
    isTier1Safe,
    tier1Declarations,
} from '../../../src/purity/inline/keys';

// These tests are the detectors ADR 0004 risks 4, 4a and 4b name. Each of the three holes was
// found in review and confirmed in a real browser; the point of testing them here is that
// they are cheap to check and expensive to ship.

describe('parseInlineDeclarations', () => {
    it('parses the ordinary case', () => {
        const d = parseInlineDeclarations('color:#333;background:#fff');
        expect(d.map((x) => [x.property, x.value])).toEqual([
            ['color', '#333'],
            ['background', '#fff'],
        ]);
    });

    it('preserves the value exactly as written, without normalizing', () => {
        // Note 1 in keys.ts: we key off what the attribute actually says. Normalizing here
        // would produce a key that does not match the element it came from.
        const [d] = parseInlineDeclarations('color:   #333');
        expect(d.value).toBe('#333');
        const [c] = parseInlineDeclarations('color: rgb(51, 51, 51)');
        expect(c.value).toBe('rgb(51, 51, 51)');
    });

    it('lowercases the property but not the value', () => {
        const [d] = parseInlineDeclarations('COLOR:#ABC');
        expect(d.property).toBe('color');
        expect(d.value).toBe('#ABC');
    });

    it('detects !important and strips it from the value', () => {
        const [d] = parseInlineDeclarations('color:#333 !important');
        expect(d.important).toBe(true);
        expect(d.value).toBe('#333');
    });

    it('ignores empty declarations and stray separators', () => {
        expect(parseInlineDeclarations(';;color:#333;;').map((d) => d.property)).toEqual(['color']);
        expect(parseInlineDeclarations('')).toEqual([]);
        expect(parseInlineDeclarations('   ')).toEqual([]);
    });

    it('ignores a declaration with no colon', () => {
        expect(parseInlineDeclarations('garbage;color:#333').map((d) => d.property)).toEqual(['color']);
    });

    // --- risk 4b: value-internal semicolons -------------------------------------------
    describe('values containing semicolons', () => {
        it('does not split a data: URI — the media-heavy.html case', () => {
            const attr = 'background-image:url(data:image/png;base64,iVBORw0KGgo=);background-size:cover';
            const d = parseInlineDeclarations(attr);
            expect(d.map((x) => x.property)).toEqual(['background-image', 'background-size']);
            expect(d[0].value).toBe('url(data:image/png;base64,iVBORw0KGgo=)');
        });

        it('does not split inside a quoted string', () => {
            const d = parseInlineDeclarations('content:"a;b";color:#333');
            expect(d.map((x) => x.property)).toEqual(['content', 'color']);
            expect(d[0].value).toBe('"a;b"');
        });

        it('handles an escaped quote inside a string', () => {
            const d = parseInlineDeclarations('content:"a\\";b";color:#333');
            expect(d.map((x) => x.property)).toEqual(['content', 'color']);
        });

        it('handles nested parens', () => {
            const d = parseInlineDeclarations('background:linear-gradient(90deg,rgb(1,2,3),rgb(4,5,6));color:#333');
            expect(d.map((x) => x.property)).toEqual(['background', 'color']);
        });

        it('skips comments', () => {
            const d = parseInlineDeclarations('color:#333;/* ; not a separator ; */background:#fff');
            expect(d.map((x) => x.property)).toEqual(['color', 'background']);
        });

        it('does not treat a colon inside a url as the property separator', () => {
            const [d] = parseInlineDeclarations('background-image:url(https://x/y.png)');
            expect(d.property).toBe('background-image');
            expect(d.value).toBe('url(https://x/y.png)');
        });
    });

    // --- risk 4a: boundary anchoring --------------------------------------------------
    describe('boundary anchoring', () => {
        it('anchors a sole declaration with an exact match', () => {
            const [d] = parseInlineDeclarations('color:#333');
            expect(d.operator).toBe('=');
            expect(declarationSelector(d)).toBe('[style="color:#333"]');
        });

        it('anchors the first of several to the start, including the separator', () => {
            const [d] = parseInlineDeclarations('color:#333;background:#fff');
            expect(d.operator).toBe('^=');
            expect(declarationSelector(d)).toBe('[style^="color:#333;"]');
        });

        it('anchors the last to the end, including the separator', () => {
            const d = parseInlineDeclarations('color:#333;background:#fff')[1];
            expect(d.operator).toBe('$=');
            expect(declarationSelector(d)).toBe('[style$=";background:#fff"]');
        });

        it('anchors a middle declaration on both sides', () => {
            const d = parseInlineDeclarations('a:1;color:#333;b:2')[1];
            expect(d.operator).toBe('*=');
            expect(declarationSelector(d)).toBe('[style*=";color:#333;"]');
        });

        it('keeps the exact spacing the page wrote', () => {
            // Raw setAttribute text is preserved verbatim by the browser, so the fragment
            // must be too or it will not match the element it came from.
            const d = parseInlineDeclarations('color: #333 ; background : #fff')[1];
            expect(declarationSelector(d)).toBe('[style$="; background : #fff"]');
        });

        it('handles the canonical CSSOM serialization, which has a trailing semicolon', () => {
            const attr = 'color: rgb(51, 51, 51); background-color: rgb(255, 255, 255);';
            const d = parseInlineDeclarations(attr);
            expect(d.map((x) => x.property)).toEqual(['color', 'background-color']);
            expect(declarationSelector(d[0])).toBe('[style^="color: rgb(51, 51, 51);"]');
        });
    });
});

/**
 * CSS attribute-selector semantics, so a collision test asserts what the browser would
 * actually do. Checking substring containment regardless of operator is not the same thing:
 * `[style="color:#333"]` is an EXACT match and cannot match `border-color:#3336`, even though
 * the fragment is a substring of it.
 */
function attrMatches(decl: {operator: string; fragment: string}, attr: string): boolean {
    switch (decl.operator) {
        case '=': return attr === decl.fragment;
        case '^=': return attr.startsWith(decl.fragment);
        case '$=': return attr.endsWith(decl.fragment);
        default: return attr.includes(decl.fragment);
    }
}

// The regression this whole design exists to prevent. A bare [style*="color:#333"] matches
// every one of these; the anchored selectors must match only the intended element.
describe('cross-property collisions (risk 4a)', () => {
    const COLLIDERS = [
        'border-color:#3336',
        'background-color:#333333',
        'caret-color:#3339',
        'outline-color:#333',
        'text-decoration-color:#333',
        'column-rule-color:#333',
    ];

    it('sanity: a bare substring selector WOULD match all of them', () => {
        // Establishes that these are real colliders, so the assertions below mean something.
        for (const other of COLLIDERS) {
            expect(other.includes('color:#333')).toBe(true);
        }
    });

    it.each(COLLIDERS)('a sole-declaration key does not match %s', (other) => {
        const themed = parseInlineDeclarations('color:#333')[0];
        expect(attrMatches(themed, 'color:#333')).toBe(true);
        expect(attrMatches(themed, other)).toBe(false);
    });

    it.each(COLLIDERS)('a first-declaration key does not match %s alongside another', (other) => {
        const themed = parseInlineDeclarations('color:#333;x:1')[0];
        expect(attrMatches(themed, 'color:#333;x:1')).toBe(true);
        expect(attrMatches(themed, `${other};x:1`)).toBe(false);
    });

    it.each(COLLIDERS)('a middle-declaration key does not match %s in the middle', (other) => {
        const themed = parseInlineDeclarations('a:1;color:#333;b:2')[1];
        expect(attrMatches(themed, 'a:1;color:#333;b:2')).toBe(true);
        expect(attrMatches(themed, `a:1;${other};b:2`)).toBe(false);
    });

    it('a same-property longer value does not collide either', () => {
        // `color:#333` must not match `color:#3336`.
        const first = parseInlineDeclarations('color:#333;x:1')[0];
        expect(attrMatches(first, 'color:#3336;x:1')).toBe(false);
        const sole = parseInlineDeclarations('color:#333')[0];
        expect(attrMatches(sole, 'color:#3336')).toBe(false);
    });

    it('a last-declaration key does not match a colliding last declaration', () => {
        const themed = parseInlineDeclarations('x:1;color:#333')[1];
        expect(attrMatches(themed, 'x:1;color:#333')).toBe(true);
        expect(attrMatches(themed, 'x:1;border-color:#333')).toBe(false);
    });
});

describe('non-ASCII values', () => {
    // Raised in review: the split indices are UTF-16 code units, not bytes. They are produced
    // and consumed by the same string API, so this works — asserted rather than argued.
    it('keeps multi-byte values intact and anchors them correctly', () => {
        const attr = 'font-family:"\u65E5\u672C\u8A9E";color:#333';
        const d = parseInlineDeclarations(attr);
        expect(d.map((x) => x.property)).toEqual(['font-family', 'color']);
        expect(d[0].value).toBe('"\u65E5\u672C\u8A9E"');
        expect(declarationSelector(d[1])).toBe('[style$=";color:#333"]');
    });

    it('handles emoji, which are surrogate pairs', () => {
        const attr = 'content:"\uD83C\uDF19";color:#333';
        const d = parseInlineDeclarations(attr);
        expect(d.map((x) => x.property)).toEqual(['content', 'color']);
        expect(d[0].value).toBe('"\uD83C\uDF19"');
    });
});

describe('escapeCSSString', () => {
    it('escapes backslashes and double quotes', () => {
        expect(escapeCSSString('a"b')).toBe('a\\"b');
        expect(escapeCSSString('a\\b')).toBe('a\\\\b');
        // Backslash first, or the escape of the quote gets double-escaped.
        expect(escapeCSSString('a\\"b')).toBe('a\\\\\\"b');
    });

    it('produces a selector that survives a quoted value', () => {
        const [d] = parseInlineDeclarations('content:"he said \\"hi\\""');
        expect(declarationSelector(d)).toContain('\\\\\\"');
    });
});

describe('declarationKey', () => {
    it('is shared by identical declarations, so they share one rule', () => {
        const a = parseInlineDeclarations('color:#333')[0];
        const b = parseInlineDeclarations('color:#333')[0];
        expect(declarationKey(a)).toBe(declarationKey(b));
    });

    it('differs when the position differs, because the selector must differ', () => {
        const first = parseInlineDeclarations('color:#333;x:1')[0];
        const sole = parseInlineDeclarations('color:#333')[0];
        expect(declarationKey(first)).not.toBe(declarationKey(sole));
    });

    it('treats the two serializations of one logical declaration as different keys', () => {
        // Deliberate: they need different selectors. Collapsing them is how note 1 in
        // keys.ts turns into silent mis-theming.
        const literal = parseInlineDeclarations('color:#333')[0];
        const canonical = parseInlineDeclarations('color: rgb(51, 51, 51);')[0];
        expect(declarationKey(literal)).not.toBe(declarationKey(canonical));
    });
});


// Both of these were found in review and confirmed in a real browser. Each produces a key
// that is sound-looking but wrong — the silent mis-theming class.
describe('un-keyable shapes', () => {
    describe('duplicate properties', () => {
        // `color:#333;color:#444` renders #444, but the DEAD `color:#333` derives
        // `[style^="color:#333;"]`, which also matches an element whose `color:#333` is live.
        // Browser-confirmed: rgb(68,68,68) and rgb(51,51,51), both matching that selector.
        it('marks every declaration of a duplicated property', () => {
            const d = parseInlineDeclarations('color:#333;color:#444');
            expect(d.map((x) => x.unkeyable)).toEqual(['duplicate', 'duplicate']);
        });

        it('marks only the duplicated property, not its neighbours', () => {
            const d = parseInlineDeclarations('color:#333;background:#fff;color:#444');
            expect(d.map((x) => [x.property, x.unkeyable])).toEqual([
                ['color', 'duplicate'],
                ['background', null],
                ['color', 'duplicate'],
            ]);
        });

        it('treats differing case as the same property', () => {
            const d = parseInlineDeclarations('COLOR:#333;color:#444');
            expect(d.every((x) => x.unkeyable === 'duplicate')).toBe(true);
        });
    });

    describe('var() values', () => {
        // Same literal text, different inherited --x, different rendered colour, same key.
        // Browser-confirmed: rgb(17,17,17) vs rgb(238,238,238), both matching.
        it('marks a value containing var()', () => {
            expect(parseInlineDeclarations('color:var(--x)')[0].unkeyable).toBe('variable');
            expect(parseInlineDeclarations('color:rgb(var(--r),0,0)')[0].unkeyable).toBe('variable');
        });

        it('does not mark a literal "var(" inside a string', () => {
            const [d] = parseInlineDeclarations('content:"var(--x)"');
            expect(d.unkeyable).toBeNull();
        });

        it('does not mark an unrelated property whose name contains var', () => {
            expect(parseInlineDeclarations('--variant:1')[0].unkeyable).toBeNull();
        });
    });

    describe('tier-1 gating', () => {
        it('rejects the whole attribute when any declaration is un-keyable', () => {
            // The colliding selector is derived FROM one of these declarations, so
            // cherry-picking the safe ones out still leaves the collision.
            expect(isTier1Safe('color:#333;color:#444')).toBe(false);
            expect(isTier1Safe('color:var(--x);background:#fff')).toBe(false);
            expect(tier1Declarations('color:#333;color:#444')).toEqual([]);
        });

        it('accepts an ordinary attribute', () => {
            expect(isTier1Safe('color:#333;background:#fff')).toBe(true);
            expect(tier1Declarations('color:#333;background:#fff')).toHaveLength(2);
        });
    });
});

describe('escapeCSSString — the newline family', () => {
    // CR and FF are normalized to LF during CSS input preprocessing and are equally fatal
    // inside a string. Escaping only LF produced a selector that threw SyntaxError from
    // .matches(), reachable from any page via setAttribute.
    // Each escapes to its OWN code point. Collapsing CR and FF onto \A is syntactically
    // valid but lossy: the selector then looks for a newline the attribute does not contain
    // and matches nothing. A real browser caught that; this simulation could not.
    it.each([
        ['newline', '\n', 'A'],
        ['carriage return', '\r', 'D'],
        ['form feed', '\f', 'C'],
    ])('escapes %s to its own code point', (_name, ch, hex) => {
        expect(escapeCSSString(`a:1${ch}b:2`)).toBe(`a:1\\${hex} b:2`);
    });

    it('escapes CRLF as two distinct code points', () => {
        expect(escapeCSSString('a:1\r\nb:2')).toBe('a:1\\D \\A b:2');
    });

    it('leaves the resulting selector free of raw control characters', () => {
        const [d] = parseInlineDeclarations('content:"x"');
        expect(declarationSelector(d)).not.toMatch(/[\n\r\f]/);
    });
});
