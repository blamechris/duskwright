// Shorthand expansion — ADR 0005 D1.
//
// The tier-1 key is derived from the AUTHORED attribute text, because that is what the
// browser matches our selector against. But the engine's colour maths only themes properties
// whose name contains `color` (plus fill/stroke/background-image), and a page almost never
// writes those names: it writes `background:#fff`.
//
// Measured before this module existed: our deriver saw `background`, the themer refused it, and
// the result across all 32 corpus fixtures was text darkened with backgrounds left white. No
// crash, no failing test — the emitter's own test stub happened to accept `background` where the
// real themer does not.
//
// So we key the authored fragment and theme the EXPANDED longhands. Expansion is done by the
// browser itself, through a detached element:
//
//     background: #fff   ->   background-color: rgb(255, 255, 255)
//     border: 1px solid #333  ->  border-*-color: rgb(51, 51, 51)  (+ widths, styles)
//
// The probe element is created and never inserted into any document. It is not page-owned, no
// page observer can see it, and it never appears in any serialization — so this is purity-legal
// in a way that reading computed style off the real element would not be.

export interface Longhand {
    property: string;
    value: string;
}

export type Expander = (property: string, value: string) => Longhand[];

/**
 * Cap on memoised expansions.
 *
 * Distinct data-URI values are unbounded, and each would otherwise be remembered forever. The
 * cap is generous because entries are small; it exists so a hostile or merely unusual page
 * cannot grow this without limit.
 */
export const MAX_EXPANSION_CACHE = 2048;

/**
 * An expander backed by a detached element.
 *
 * Lazily created: constructing this at module load would touch `document`, which breaks Node
 * unit tests and would run before the content script has a document at all.
 */
export function createProbeExpander(): Expander {
    let probe: HTMLElement | null = null;
    const cache = new Map<string, Longhand[]>();

    return (property, value) => {
        const cacheKey = `${property}|${value}`;
        const hit = cache.get(cacheKey);
        if (hit) {
            return hit;
        }

        if (!probe) {
            // Never inserted. Never observed. Invisible to the page.
            probe = document.createElement('div');
        }

        const style = probe.style;
        style.cssText = '';
        // Assigning cssText makes the browser parse and expand exactly as it would for a real
        // style attribute — including rejecting invalid values, which we rely on below.
        style.cssText = `${property}: ${value}`;

        const out: Longhand[] = [];
        for (let i = 0; i < style.length; i++) {
            const name = style[i];
            const expanded = style.getPropertyValue(name);
            // `initial` longhands carry no page intent — `background: #fff` expands to eight
            // of them plus the one that matters. Theming `background-image: initial` is
            // meaningless and would emit a rule that changes nothing.
            if (expanded === 'initial') {
                continue;
            }
            out.push({property: name, value: expanded});
        }

        // An empty expansion means the browser rejected the declaration outright, e.g.
        // `color: not-a-colour`. The caller must skip it rather than key an invalid rule.
        if (cache.size >= MAX_EXPANSION_CACHE) {
            cache.clear();
        }
        cache.set(cacheKey, out);
        return out;
    };
}

/**
 * A pure expander for unit tests, built from an explicit table.
 *
 * Deliberately **strict**: an unlisted property expands to itself only if it already looks like
 * a longhand, and throws otherwise. A permissive stub is what let the shorthand defect reach
 * merge — the emitter's fake themer accepted `background` where the real engine refuses it — so
 * test doubles in this module fail loudly on anything they were not taught.
 */
export function createTableExpander(table: Record<string, Longhand[]>): Expander {
    return (property, value) => {
        const key = `${property}|${value}`;
        if (key in table) {
            return table[key];
        }
        if (property in table) {
            return table[property];
        }
        if (property.includes('-') || !isKnownShorthand(property)) {
            return [{property, value}];
        }
        throw new Error(
            `createTableExpander: no expansion taught for "${property}: ${value}". ` +
            'Add it to the table rather than letting the stub guess — a permissive stub is how ' +
            'the shorthand defect reached merge (ADR 0005 D1).',
        );
    };
}

/** The shorthands a test stub must be explicitly taught about. */
function isKnownShorthand(property: string): boolean {
    return [
        'background', 'border', 'font', 'margin', 'padding', 'outline',
        'all', 'transition', 'animation', 'flex', 'grid', 'inset',
    ].includes(property);
}
