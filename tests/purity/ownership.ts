// Ownership is the whole harness. Everything else is plumbing.
//
// The tempting filter is "ignore anything named darkreader/duskwright". That would be
// exactly wrong: `data-darkreader-inline-color` written onto a page's <td> is not our
// property on our element, it is OUR NAME ON THEIR ELEMENT — the single most common
// violation in ADR 0001, and a name-based filter would hide all of it.
//
// So ownership is decided by the NODE, never by the attribute or class name:
//
//   ours  = a node the extension itself created (its own <style>/<script>, its shadow host)
//   page  = literally everything else, including <html>, <head>, and <body>
//
// A write to a page-owned node is a violation regardless of what it is named.

/** A serialized description of a DOM node, captured synchronously inside the observer. */
export interface NodeDesc {
    nodeType: number;
    tag: string | null;
    id: string | null;
    classes: string[];
    /** Whether this node was created by the extension. */
    ours: boolean;
    /** Human-readable path, for the failure message. */
    path: string;
}

export interface MutationDesc {
    type: 'attributes' | 'childList' | 'characterData';
    target: NodeDesc;
    attributeName: string | null;
    oldValue: string | null;
    added: NodeDesc[];
    removed: NodeDesc[];
}

/**
 * The classifier, as a string so it can be injected into the page at document_start.
 *
 * Kept as source text rather than an imported function because `page.addInitScript` has to
 * serialize it into a world where none of our modules exist.
 */
export const OWNERSHIP_RUNTIME = `
// A node is ours only if the extension created it. We recognise those by the marker
// classes the engine puts on its OWN generated elements, plus our overlay host.
//
// This list is deliberately narrow. Anything not matched is treated as page-owned, so the
// harness fails closed: an unrecognised node of ours produces a false positive (loud, fixed
// in a minute), never a false negative (silent, ships).
function __purityIsOurs(node) {
    if (!node || node.nodeType !== 1) {
        return false;
    }
    const el = /** @type {Element} */ (node);
    const cls = el.classList;
    if (!cls) {
        return false;
    }
    // Upstream's generated elements. E2 collapses these into a single owned host; until
    // then the harness has to recognise what the engine actually emits.
    if (cls.contains('darkreader') || cls.contains('duskwright')) {
        return true;
    }
    if (el.id === 'duskwright-theme' || el.id === 'duskwright-host') {
        return true;
    }
    return false;
}

function __purityPath(node) {
    if (!node) {
        return '(null)';
    }
    if (node.nodeType === 3) {
        const parent = node.parentNode;
        return __purityPath(parent) + ' > #text';
    }
    if (node.nodeType === 9) {
        return '#document';
    }
    if (node.nodeType !== 1) {
        return '#node(' + node.nodeType + ')';
    }
    const parts = [];
    let cur = node;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
        let part = cur.tagName ? cur.tagName.toLowerCase() : '?';
        if (cur.id) {
            part += '#' + cur.id;
        } else if (cur.classList && cur.classList.length) {
            part += '.' + Array.prototype.join.call(cur.classList, '.');
        }
        parts.unshift(part);
        cur = cur.parentNode;
        depth++;
    }
    return parts.join(' > ');
}

function __purityDesc(node) {
    if (!node) {
        return {nodeType: -1, tag: null, id: null, classes: [], ours: false, path: '(null)'};
    }
    const isEl = node.nodeType === 1;
    return {
        nodeType: node.nodeType,
        tag: isEl && node.tagName ? node.tagName.toLowerCase() : null,
        id: isEl ? (node.id || null) : null,
        classes: isEl && node.classList ? Array.prototype.slice.call(node.classList) : [],
        ours: __purityIsOurs(node),
        path: __purityPath(node),
    };
}
`;

/**
 * Is this mutation a violation of the invariant?
 *
 * Runs in Node, over descriptions captured in the page.
 */
export function isViolation(m: MutationDesc): boolean {
    // Anything done to a node we own is our business.
    if (m.target.ours) {
        return false;
    }

    // The target is page-owned from here down.

    if (m.type === 'attributes' || m.type === 'characterData') {
        // A write onto a page-owned node. No exceptions — this is the invariant.
        return true;
    }

    // childList on a page-owned target. §2 permits us to add OUR OWN nodes in two places:
    // a single <style> fallback in <head>, and our overlay host on <html>. Adding or
    // removing anything else — including transiently — is observable by the page.
    const touched = [...m.added, ...m.removed];
    if (touched.length === 0) {
        return false;
    }
    const allOurs = touched.every((n) => n.ours);
    if (!allOurs) {
        // We moved or removed a node belonging to the page.
        return true;
    }
    const host = m.target.tag;
    return !(host === 'head' || host === 'html');
}

/** Group violations by the ADR 0001 site they correspond to, for a readable failure. */
export function describeViolation(m: MutationDesc): string {
    if (m.type === 'attributes') {
        return `attribute "${m.attributeName}" written on page-owned <${m.target.tag}>  [${m.target.path}]`;
    }
    if (m.type === 'characterData') {
        return `text content changed on page-owned node  [${m.target.path}]`;
    }
    const added = m.added.map((n) => `<${n.tag ?? '#text'}>${n.ours ? ' (ours)' : ''}`).join(', ');
    const removed = m.removed.map((n) => `<${n.tag ?? '#text'}>${n.ours ? ' (ours)' : ''}`).join(', ');
    const bits = [];
    if (added) {
        bits.push(`added ${added}`);
    }
    if (removed) {
        bits.push(`removed ${removed}`);
    }
    return `${bits.join('; ')} under page-owned <${m.target.tag}>  [${m.target.path}]`;
}
