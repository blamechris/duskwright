import type {MutationDesc} from './ownership';

// A MutationObserver installed at document_start sees the browser parsing the document —
// every element the page is made of arrives as a childList record. That is the page building
// itself, not the extension writing to it, and a harness that reports it produces 30 lines of
// noise per fixture and hides the three lines that matter.
//
// Filtering by "looks like parsing" would be guesswork. Instead we run each fixture twice —
// once in a clean browser, once with the extension loaded — and take the multiset difference.
// Whatever the page does on its own appears in both logs and cancels. The residue is, by
// construction, attributable to the extension.
//
// This also removes an entire class of harness bug: there is no hand-maintained allowlist of
// "normal" mutations to drift out of date, and no way for a violation to be quietly excluded
// by a pattern someone added to make CI green.

/** A stable identity for a mutation, so occurrences can be counted across two runs. */
function key(m: MutationDesc): string {
    const nodes = (ns: MutationDesc['added']) =>
        ns.map((n) => `${n.tag ?? `#${n.nodeType}`}${n.ours ? '!ours' : ''}`).sort().join(',');
    return [
        m.type,
        m.target.path,
        m.attributeName ?? '',
        nodes(m.added),
        nodes(m.removed),
    ].join('|');
}

export interface DiffOptions {
    /**
     * Fixtures that rewrite themselves on a timer produce a different number of childList
     * records per run, so those cannot cancel exactly. Attribute and characterData records
     * are still compared strictly — which is where inline-style violations live, and those
     * are the ones such fixtures exist to catch.
     */
    ignoreChildListCounts?: boolean;
}

/**
 * Mutations present in `treated` that are not accounted for by `control`.
 */
export function attributableToExtension(
    treated: MutationDesc[],
    control: MutationDesc[],
    options: DiffOptions = {},
): MutationDesc[] {
    const budget = new Map<string, number>();
    for (const m of control) {
        const k = key(m);
        budget.set(k, (budget.get(k) ?? 0) + 1);
    }

    const residue: MutationDesc[] = [];
    for (const m of treated) {
        const k = key(m);
        const remaining = budget.get(k) ?? 0;
        if (remaining > 0) {
            budget.set(k, remaining - 1);
            continue;
        }
        if (options.ignoreChildListCounts && m.type === 'childList' && budget.has(k)) {
            // The page does this to itself, just a different number of times this run.
            continue;
        }
        residue.push(m);
    }
    return residue;
}
