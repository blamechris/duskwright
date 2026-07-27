// ADR 0001 item 7 / ADR 0004 step 0.
//
// The per-site fixes catalog carries ~60 selectors shaped like
// `html[data-darkreader-scheme="dark"] .foo`. Upstream made those work by writing
// `data-darkreader-scheme` onto `<html>` — but `<html>` is page-owned, so that write is a
// purity violation and it serializes into the page's own markup.
//
// We already know the scheme at the moment we emit that CSS into our own sheet, so the
// attribute is redundant. Resolve the selector statically instead:
//
//   matching scheme      ->  `html`          (rule applies, as before)
//   non-matching scheme  ->  `html:not(*)`   (valid, parses, matches nothing)
//
// Neutralizing rather than deleting the rule avoids having to parse rule boundaries, which
// would mean a real CSS parser for no benefit — a never-matching selector costs one bucket
// lookup and is unambiguously correct.
//
// This is deliberately a standalone module with no imports: it keeps the edit to the upstream
// engine down to one import plus one call site, and it means the ~60 catalog entries that now
// depend on this transform can be unit-tested without loading the engine.

// The catalog uses six distinct shapes for this attribute, not just the obvious one:
//
//   html[data-darkreader-scheme="dark"]                        46x
//   html[data-darkreader-scheme="dimmed"]                       7x
//   [data-darkreader-scheme="dimmed"] .foo                      3x   (no html prefix)
//   [data-darkreader-scheme="dark"] .foo                        2x
//   html[data-theme="dark"][data-darkreader-scheme="dark"]      1x   (another attr first)
//   html[data-darkreader-scheme="dark"].light                   1x
//
// So we match the attribute selector itself wherever it appears, rather than assuming it is
// glued to `html`. An earlier version anchored on `html[...]` and silently left five catalog
// entries still depending on an attribute we no longer write — caught by the test that reads
// the real catalog, which is exactly why that test reads the real catalog.
//
// The captured group is the character immediately preceding the attribute, which tells us
// whether the attribute is part of a larger compound (`html[...]`, `...[a][b]`) or stands at
// the start of one (`[...] .foo`). That distinction decides what a removal must leave behind.
const SCHEME_SELECTOR = /([^\s,>+~(]?)\[data-darkreader-scheme=(["']?)(dark|dimmed)\2\]/g;

export type ColorScheme = 'dark' | 'dimmed';

export function resolveSchemeSelectors(cssText: string, current: ColorScheme): string {
    return cssText.replace(
        SCHEME_SELECTOR,
        (_match, prev: string, _quote: string, scheme: string) => {
            if (scheme !== current) {
                // Valid, parses, matches nothing. Keeps rule boundaries intact so we never
                // need a real CSS parser just to drop a rule.
                return `${prev}:not(*)`;
            }
            // Matching scheme: the attribute carried no meaning beyond the scheme, so drop
            // it. If it began the compound there is nothing left to qualify, and `:root` is
            // the equivalent of the `<html>` it was always attached to.
            return prev === '' ? ':root' : prev;
        },
    );
}
