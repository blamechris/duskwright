// ADR 0005 — expressing `ignoreInlineStyle` as a selector.
//
// `fixes.ignoreInlineStyle` is a per-site opt-out from inline theming, used by **229 sites**
// in the catalog across 846 selectors. Upstream implements it as an early return inside
// `overrideInlineStyle`: if the element matches, skip it.
//
// Under declaration keying there is no early return available. One rule serves every element
// carrying that declaration, so an ignored element and a non-ignored element with the same
// `style` text share a rule — skipping the ignored one is not something the emitter can do at
// registration time. The exclusion has to move into the selector:
//
//     [style^="color:#333;"]:not(.entry-content *, .comment-content *)
//
// Verified in Chromium: complex selectors and selector lists inside `:not()` both work, and
// exclude exactly the intended elements. (Both are Selectors Level 4; Chrome has supported
// them since 88, well under the extension's 106 floor.)
//
// Forgetting this would silently re-theme opted-out regions on 229 sites — invisible without
// a fixture, which is why one exists.

/**
 * Is this a selector the browser will accept?
 *
 * Injected so the builder is unit-testable without a DOM, and so the real check is the
 * browser's own parser rather than a regex approximating it.
 */
export type SelectorValidator = (selector: string) => boolean;

/** A validator backed by the real CSS parser. */
export function createBrowserValidator(): SelectorValidator {
    return (selector) => {
        try {
            document.createDocumentFragment().querySelector(selector);
            return true;
        } catch {
            return false;
        }
    };
}

/**
 * Build the `:not(...)` qualifier for a site's ignore selectors.
 *
 * Returns `''` when there is nothing to exclude, so the caller can append unconditionally.
 *
 * **Invalid selectors are dropped individually.** This is the important part: a `:not()` list
 * is all-or-nothing to the CSS parser, so one bad selector from the catalog would invalidate
 * the entire rule — and the rule is our theming, not the exclusion. The failure mode would be
 * "this declaration stops being themed anywhere on the page", from a typo in a synced file we
 * do not control. Dropping the bad entry degrades to "this one exclusion does not apply",
 * which is both smaller and in the safer direction.
 */
export function usableIgnoreSelectors(
    selectors: readonly string[],
    isValid: SelectorValidator,
): string[] {
    const usable: string[] = [];
    for (const raw of selectors) {
        const selector = raw.trim();
        if (!selector) {
            continue;
        }
        // Validate the selector as it will actually be used — inside :not(). A selector can
        // be valid standalone and still be rejected there, and testing the standalone form
        // would be testing the wrong thing.
        if (isValid(`:not(${selector})`)) {
            usable.push(selector);
        }
    }
    return usable;
}

export function buildIgnoreQualifier(
    selectors: readonly string[],
    isValid: SelectorValidator,
): string {
    const usable = usableIgnoreSelectors(selectors, isValid);
    if (usable.length === 0) {
        return '';
    }
    return `:not(${usable.join(', ')})`;
}

/**
 * Selectors that cannot be expressed as an exclusion and must keep the element out of tier 1
 * entirely.
 *
 * A bare `*` ignores everything on the page, and `:not(*)` would make every rule match
 * nothing — correct in effect, but it is clearer and cheaper to skip emission altogether.
 */
export function ignoresEverything(selectors: readonly string[]): boolean {
    return selectors.some((s) => s.trim() === '*');
}
