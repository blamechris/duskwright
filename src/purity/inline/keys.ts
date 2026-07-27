// Declaration keys — the core of ADR 0004 tier 1.
//
// Upstream themed inline-styled elements by writing into their `style` attribute. That write
// is the Google Sheets failure: the attribute is the most commonly serialized per-element
// state in the DOM, so the theming becomes part of the user's document.
//
// Instead we read the attribute and emit a rule into OUR OWN sheet, matched with an attribute
// selector. Elements sharing a declaration share a rule, so the rule count is the number of
// distinct declarations rather than the number of elements.
//
// Three things make the naive version of this wrong. All three were found in review and
// confirmed in a browser; see ADR 0004 and the tests next to this file.
//
//   1. The attribute text is NOT stable and often never contains what you expect. Chromium
//      re-serializes the whole attribute on any CSSOM write, including to an unrelated
//      property, so `color:#333` becomes `color: rgb(51, 51, 51);`. An element styled through
//      the CSSOM carries rgb() from the first read. We therefore key off the attribute AS IT
//      CURRENTLY READS and rely on the style-attribute observer to re-key when it changes.
//      Nothing here may assume a canonical form.
//
//   2. A bare `[style*="color:#333"]` also matches `border-color:#3336`,
//      `background-color:#333333`, and `caret-color:#3339` — every `*-color` property
//      contains the substring `color:`. So the emitted selector must anchor to declaration
//      boundaries. We do that by making the surrounding `;` part of the matched fragment and
//      picking the operator from where the fragment sits, which is exact rather than
//      approximate.
//
//   3. Values legitimately contain `;` — `url(data:image/png;base64,…)` is in our own
//      media-heavy fixture. Splitting on `;` shreds one declaration into two useless
//      fragments, so the splitter has to understand strings, parens, and comments.

/** One declaration, located within the attribute text it came from. */
export interface Declaration {
    /** Lowercased property name, e.g. `background-color`. */
    property: string;
    /** Value as written, trimmed. Never normalized — see note 1 above. */
    value: string;
    /** Whether the declaration carried `!important`. */
    important: boolean;
    /**
     * The exact substring to match on, including any adjacent `;` separators. Making the
     * boundaries part of the fragment is what stops `color:` matching `border-color:`.
     */
    fragment: string;
    /** Attribute-selector operator implied by where the fragment sits in the attribute. */
    operator: '=' | '^=' | '$=' | '*=';
    /**
     * Why this declaration cannot be keyed at tier 1, or null when it can.
     *
     * A key is only sound when "same fragment" implies "same rendered result". Two shapes
     * break that implication, and both were confirmed in a browser:
     *
     *   'duplicate'  The attribute declares this property more than once, so all but the
     *                last are dead. `color:#333;color:#444` renders #444 — yet the dead
     *                `color:#333` derives `[style^="color:#333;"]`, which ALSO matches an
     *                element whose `color:#333` is live. Keying either one repaints the other.
     *
     *   'variable'   The value contains `var()`, so the rendered colour depends on inherited
     *                custom properties, not on the text. Two elements with byte-identical
     *                `color:var(--x)` rendered rgb(17,17,17) and rgb(238,238,238) while both
     *                matching the same selector.
     *
     * ADR 0004 already routes both to tier 3 (per-element structural selectors, hard-capped).
     * Surfacing it here is what lets the caller actually do that instead of silently emitting
     * a colliding key.
     */
    unkeyable: 'duplicate' | 'variable' | null;
}

const QUOTE = /['"]/;

/**
 * Split a `style` attribute into declarations, respecting quoted strings, parentheses
 * (so `url(data:…;base64,…)` survives), and CSS comments.
 *
 * Returns the index range of each declaration (UTF-16 code units, as JS string indices —
 * not bytes) so the caller can compute exact boundaries. Non-ASCII values are safe because
 * every index here is produced and consumed by the same string API.
 */
function splitDeclarations(attr: string): Array<{start: number; end: number}> {
    const spans: Array<{start: number; end: number}> = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;

    for (let i = 0; i < attr.length; i++) {
        const c = attr[i];

        if (quote) {
            if (c === '\\') {
                i++; // escaped char inside a string
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }

        if (QUOTE.test(c)) {
            quote = c;
        } else if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth = Math.max(0, depth - 1);
        } else if (c === '/' && attr[i + 1] === '*') {
            const close = attr.indexOf('*/', i + 2);
            i = close === -1 ? attr.length : close + 1;
        } else if (c === ';' && depth === 0) {
            spans.push({start, end: i});
            start = i + 1;
        }
    }
    if (start < attr.length) {
        spans.push({start, end: attr.length});
    }
    return spans.filter((s) => attr.slice(s.start, s.end).trim() !== '');
}

/**
 * Parse a `style` attribute into keyed declarations.
 *
 * `attr` must be the attribute exactly as `getAttribute('style')` returned it — not
 * `style.cssText`, which normalizes, and not a value you have trimmed or rewritten. The
 * fragments are substrings of this exact text and are matched against it by the browser.
 */
export function parseInlineDeclarations(attr: string): Declaration[] {
    const out: Declaration[] = [];

    for (const {start, end} of splitDeclarations(attr)) {
        // Comments are stripped for PARSING only. The fragment below is still cut from the
        // original attribute text, because that is what the browser matches against — a
        // fragment with the comment removed would match nothing.
        const text = stripComments(attr.slice(start, end));
        const colon = findTopLevelColon(text);
        if (colon === -1) {
            continue;
        }

        const property = text.slice(0, colon).trim().toLowerCase();
        let value = text.slice(colon + 1).trim();
        if (!property || !value) {
            continue;
        }

        let important = false;
        const bang = value.toLowerCase().lastIndexOf('!important');
        if (bang !== -1 && value.slice(bang + '!important'.length).trim() === '') {
            important = true;
            value = value.slice(0, bang).trim();
        }

        // Widen to include the adjacent separators. Those separators ARE the anchor: a
        // fragment of `;color:#333;` cannot occur inside `;border-color:#333;`.
        const fragStart = start === 0 ? 0 : start - 1; // take the preceding ';'
        const fragEnd = end < attr.length ? end + 1 : attr.length; // take the trailing ';'
        const fragment = attr.slice(fragStart, fragEnd);

        const atStart = fragStart === 0;
        const atEnd = fragEnd === attr.length;
        const operator: Declaration['operator'] =
            atStart && atEnd ? '=' : atStart ? '^=' : atEnd ? '$=' : '*=';

        out.push({property, value, important, fragment, operator, unkeyable: null});
    }

    // A second pass, because "declared more than once" is a property of the whole attribute
    // and cannot be decided while parsing a single declaration.
    const counts = new Map<string, number>();
    for (const d of out) {
        counts.set(d.property, (counts.get(d.property) ?? 0) + 1);
    }
    for (const d of out) {
        if (counts.get(d.property)! > 1) {
            d.unkeyable = 'duplicate';
        } else if (containsVar(d.value)) {
            d.unkeyable = 'variable';
        }
    }
    return out;
}

/** `var(` at the top level of a value, not inside a string. */
function containsVar(value: string): boolean {
    if (!value.includes('var(')) {
        return false;
    }
    let quote: string | null = null;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (QUOTE.test(c)) {
            quote = c;
        } else if (value.startsWith('var(', i)) {
            return true;
        }
    }
    return false;
}

/**
 * Can every declaration in this attribute be keyed at tier 1?
 *
 * The unit is the ATTRIBUTE, not the declaration: a duplicate makes the whole attribute
 * suspect, because the colliding selector is derived from one of its declarations. The caller
 * should route the element to tier 3 rather than cherry-pick the safe declarations out of it.
 */
export function isTier1Safe(attr: string): boolean {
    return parseInlineDeclarations(attr).every((d) => d.unkeyable === null);
}

/** The declarations of `attr` that are safe to key, i.e. none if any of them is not. */
export function tier1Declarations(attr: string): Declaration[] {
    const all = parseInlineDeclarations(attr);
    return all.some((d) => d.unkeyable !== null) ? [] : all;
}

/** Remove CSS comments, leaving string contents alone. */
function stripComments(text: string): string {
    if (!text.includes('/*')) {
        return text;
    }
    let out = '';
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            out += c;
            if (c === '\\') {
                out += text[++i] ?? '';
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (QUOTE.test(c)) {
            quote = c;
            out += c;
        } else if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            i = close === -1 ? text.length : close + 1;
        } else {
            out += c;
        }
    }
    return out;
}

/** The colon separating property from value, ignoring any inside parens or strings. */
function findTopLevelColon(text: string): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (QUOTE.test(c)) {
            quote = c;
        } else if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth = Math.max(0, depth - 1);
        } else if (c === ':' && depth === 0) {
            return i;
        }
    }
    return -1;
}

/**
 * Escape a string for use inside a double-quoted CSS attribute-selector value.
 *
 * `\` and `"` obviously need escaping. So does the whole newline family — CR and FF are
 * normalized to LF during CSS input preprocessing and are just as fatal inside a string, and
 * an earlier version of this escaped only LF, which made `setAttribute('style', 'a:1\rb:2')`
 * produce a selector that threw `SyntaxError` from `.matches()`. That is reachable from any
 * page, so it is a real crash, not a theoretical one.
 *
 * Each is escaped to its OWN code point, not collapsed onto LF. An earlier version mapped
 * CR and FF both to `\\A ` (LF); that was syntactically valid but lossy — the selector then
 * looked for a newline the attribute did not contain, so it matched nothing. A real browser
 * caught that; the TypeScript simulation could not.
 */
export function escapeCSSString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        // \n -> \A, \r -> \D, \f -> \C. The trailing space terminates the hex escape.
        .replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16).toUpperCase()} `);
}

/**
 * The attribute selector matching every element whose `style` attribute contains this exact
 * declaration at a declaration boundary.
 */
export function declarationSelector(decl: Declaration): string {
    return `[style${decl.operator}"${escapeCSSString(decl.fragment)}"]`;
}

/**
 * A stable identity for a declaration, so two elements carrying the same declaration text
 * share one rule. Two serializations of the same logical declaration (`color:#333` and
 * `color: rgb(51, 51, 51);`) are deliberately DIFFERENT keys: they need different selectors,
 * and pretending otherwise is how note 1 above turns into silent mis-theming.
 */
export function declarationKey(decl: Declaration): string {
    return `${decl.operator} ${decl.fragment}`;
}
