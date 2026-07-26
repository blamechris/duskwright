# Umbra — Architecture & Design

> Working name. Alternates: **Penumbra**, **Nocturne**, **Duskwright**, **Shade**.
> The build agent should confirm name + availability on the Chrome Web Store before rebranding the fork.

**What it is:** a fork of [Dark Reader](https://github.com/darkreader/darkreader) (MIT) that adds a
user-driven element picker, per-scope rule persistence, and a hard non-destructiveness guarantee.

**Targets:** Chrome / Chromium (MV3) for v1. Firefox and Safari are explicitly out of scope.

---

## 1. Why fork, and what changes

Dark Reader is already open source and MIT licensed, so "open source" is not the differentiator. Its
engine — HSL-aware color modification, stylesheet parsing and override generation, shadow-DOM
traversal, and a large community-maintained site-fix catalog — represents years of accumulated edge
cases. Rewriting that would be reconstructing a solved problem badly.

The three things we actually add:

| Gap | What we build |
|---|---|
| Silently fails on hard sites | **Coverage detection** — measure whether theming actually landed, and tell the user when it didn't |
| No manual recourse when it fails | **Element picker** — devtools-style inspect that lets the user darken a subtree by hand |
| Can leak into the document layer | **Purity invariant** — an enforced, CI-tested guarantee that we never mutate page-owned DOM |

### Why Dark Reader misses sites (the real causes)

Worth naming precisely, because each one maps to a different mitigation:

1. **Cross-origin stylesheets** — `sheet.cssRules` throws `SecurityError` on CORS-restricted sheets.
   Upstream falls back to re-fetching the CSS over the network, which fails when the CSS is
   auth-gated or behind a signed URL.
2. **Closed shadow roots** — unreachable by design. Open roots are handled via `adoptedStyleSheets`.
3. **Cross-origin / sandboxed iframes** — need `all_frames` injection; sandboxed frames may still refuse.
4. **Canvas and WebGL rendering** — Google Docs, Sheets, Figma. There is no DOM text to recolor.
   *No DOM-based engine can ever fix this.* Only compositing can.
5. **Strict CSP (`style-src`)** — blocks injected `<style>` elements on some sites.
6. **Runtime inline styles** — apps that repaint on every render outrun the MutationObserver, causing flashes.
7. **CSS-in-JS** — sheets appearing continuously with hash-generated class names.
8. **Site's own dark mode fighting ours** — `color-scheme` / `prefers-color-scheme` conflicts.
9. **Restricted pages** — `chrome://`, the Web Store, other extensions. Genuinely unfixable; detect and say so.

Causes 1–3 and 5–8 get engine work. Cause 4 gets the picker. Cause 9 gets an honest error message.

---

## 2. The Purity Invariant

This is the requirement that drives the most design decisions, so it gets stated as an enforceable rule
rather than an intention.

> **The extension must never produce a mutation of the page DOM that the page's own JavaScript can
> observe as a change to its own content or serialize into its document model.**

This is what guarantees the Google Sheets property: turn the extension off, or have a colleague open
the same doc, and the document is byte-identical to what it always was.

### Forbidden

- Writing `element.style.*` on any page-owned element
- Adding or removing classes or attributes on page-owned elements
- Inserting or modifying rules in page-owned `CSSStyleSheet` objects
- Touching `document.designMode`, `contenteditable`, or any editing surface
- Any write inside a region an application treats as document content

### Allowed

- Appending **our own** `CSSStyleSheet` to `document.adoptedStyleSheets` (additive; not serializable
  into the page's document model, and in Chromium constructed stylesheets are not subject to
  `style-src` the way `<style>` elements are)
- A single injected `<style id="umbra-theme">` in `<head>` as a fallback where CSSOM is unavailable
- Elements we create ourselves, always inside a shadow root we own, always removed on teardown

### How we target elements without touching them

Because we cannot tag an element with a class, the picker must produce a **structural CSS selector**
and emit a rule into our own sheet. Selector generation preference order:

1. Stable `id` (reject hash-like ids: `/\d{4,}|[a-f0-9]{8,}/`)
2. Semantic attributes — `data-testid`, `role`, `aria-label`, `name`
3. Unique class combination, filtering CSS-in-JS hashes (`css-1a2b3c`, `sc-bdVaJa`, `_1x2y3z`)
4. `:nth-child` structural path anchored at the nearest stable ancestor found by 1–3

Every stored selector carries a **confidence score** and a **match-count expectation**. On reapply, if
the selector matches zero elements or wildly more than expected, we degrade to no-op and surface a
"this rule no longer matches" notice rather than theming the wrong thing.

### Enforcement: the purity harness

This is a CI gate, not a code-review convention. A Playwright suite that, for each fixture page:

1. Snapshots `document.documentElement.outerHTML` plus the text of every page-owned stylesheet
2. Enables the extension and waits for the theming pipeline to settle
3. Re-snapshots, subtracting nodes whose ownership we can prove (our shadow host, our style element)
4. Asserts the remainder is **byte-identical**

Fixtures must include: a plain static page, a React SPA with inline styles, a page using
`adoptedStyleSheets`, a shadow-DOM component page, a canvas-rendered page, and a
`contenteditable`-based editor.

> **Highest-risk work in this project:** upstream's dynamic-theme engine *does* violate this
> invariant in places — notably `inline-style.ts`, which handles `style="color: …"` elements by
> attaching override classes. Auditing and rewriting that mutation surface is the single largest and
> riskiest epic. Budget accordingly; do not assume the fork is pure out of the box.

**Known tradeoff:** purely-selector-based handling of inline-styled elements is more expensive than
upstream's class-tagging approach. Where per-element selector emission is too costly (long lists,
virtualized tables), fall back to a scoped filter on the container rather than reintroducing mutation.

---

## 3. Engine: a tiered ladder with explicit escalation

Rather than one strategy that either works or silently doesn't, the engine tries progressively blunter
instruments and *reports where it landed*.

```
Tier 0  Native      Site supports prefers-color-scheme: dark → force the media query, touch nothing else.
                    Cheapest and always the most correct result. Try this first, always.

Tier 1  Dynamic     Upstream's engine: parse stylesheets, analyze computed styles, emit overrides.
                    Best fidelity. Fails on causes 1–8 above.

Tier 2  Scoped      filter: invert(1) hue-rotate(180deg) on a subtree, with a counter-filter on
        Filter      img/video/canvas/svg/[style*="background-image"] so media renders normally.
                    Pure compositing — zero DOM interaction, and therefore trivially pure.
                    THIS IS THE ONLY THING THAT WORKS ON CANVAS APPS.

Tier 3  Manual      User-authored rules from the picker. Highest precedence, never auto-overridden.
```

Tier 2 deserves emphasis: for Google Docs/Sheets/Figma, a compositing filter is not a degraded
fallback, it is the **only correct mechanism**. It cannot touch document state because it never
enters the DOM. The picker exists to let the user aim it.

### Coverage detection

After Tier 1 settles, sample the rendered result:

- Walk the largest visible boxes (viewport-intersecting elements above an area threshold)
- Compute effective background luminance via `getComputedStyle`, resolving `transparent` up the
  ancestor chain
- Weight by painted area; compute a **light-surface ratio**

If the ratio exceeds a threshold (~15% of viewport area still light), the page is flagged
**partially themed**: the toolbar badge changes state and the popup offers a one-tap "fix this area"
that drops straight into the picker. Also detect the reverse — a page already dark before we ran —
and stand down rather than double-inverting.

This is the direct answer to "there are a lot of sites Dark Reader doesn't apply to." We can't fix
every site automatically, but we can stop failing silently.

---

## 4. Element picker

Entry points: `chrome.commands` hotkey (default `Alt+Shift+D`, user-rebindable), popup button, and
context-menu item. **Never auto-activates.**

### Overlay

Rendered into a closed shadow root on a host element we own, appended to `document.documentElement`
and removed on exit. Host is `pointer-events: none` except for the treatment menu; hit-testing uses
`document.elementFromPoint` on `pointermove`.

### Interaction

| Input | Behavior |
|---|---|
| Hover | Highlight box from `getBoundingClientRect`; label shows tag, classes, generated selector, confidence |
| `↑` / `↓` | Walk to parent / first child — lets the user widen a too-narrow selection (mirrors devtools) |
| `←` / `→` | Previous / next sibling |
| Click | Open treatment menu with live preview |
| `Esc` | Cancel, restore |

Iframe support: content scripts run in `all_frames`; the picker coordinates across frames via
`chrome.runtime` messaging so hovering into an iframe targets its contents, and the resulting rule
records the frame's URL alongside the selector.

### Treatment menu

Presented on click, each with live preview before commit:

- **Invert subtree** — Tier 2 scoped filter. The canvas-app answer.
- **Recolor subtree** — Tier 1 dynamic engine, scoped to this element only.
- **Force dark background** — background/border only, leave text alone. The "don't touch my font colors" option.
- **Exclude subtree** — protect a region from all theming. Essential for color pickers, image editors, swatch palettes, charts.

### Scope selection

On commit, the user chooses persistence granularity (default: **origin + path prefix**):

| Granularity | Example |
|---|---|
| Origin | `https://docs.google.com` |
| Origin + path prefix | `https://docs.google.com/spreadsheets` |
| Exact URL | with or without query string |
| Pattern | glob or regex, power users |

---

## 5. Rule engine

```ts
// One user-authored or built-in theming rule.
interface Rule {
  id: string;                    // uuid
  scope: {
    kind: 'origin' | 'prefix' | 'exact' | 'pattern';
    value: string;
    includeQuery?: boolean;      // only meaningful for 'exact'
  };
  frameUrl?: string;             // set when the rule targets an element inside an iframe
  selector: string;
  selectorMeta: {
    confidence: number;          // 0-1, from the generation strategy that won
    strategy: 'id' | 'attr' | 'class' | 'structural';
    expectedMatches: number;     // sanity check on reapply
  };
  treatment: 'invert' | 'recolor' | 'background-only' | 'exclude';
  params?: Record<string, number>;  // brightness, contrast, sepia, grayscale
  enabled: boolean;
  createdAt: number;
  source: 'user' | 'builtin' | 'imported';
}
```

**Precedence:** most-specific scope wins (`exact` > `prefix` > `origin` > `pattern`); within the same
specificity, later-created wins; `exclude` always beats any positive treatment at equal or greater
specificity. This ordering must be a pure, unit-tested function — it is the source of "why is this
site weird" bugs.

**Storage:**

- `chrome.storage.local` for rules — `sync` gives ~100KB total and 8KB per item, far too small for a
  real rule set. Request `unlimitedStorage`.
- `chrome.storage.sync` for global settings only (theme params, enabled state, shortcuts).
- Manual JSON **export/import** is the cross-device story for rules in v1. Do not promise sync.
- Schema `version` field and a migration runner from commit one. Rules are user-authored data; losing
  them is unacceptable.

---

## 6. MV3 constraints that will bite

- **Ephemeral service worker.** No in-memory state survives. All state lives in `chrome.storage` and
  is rehydrated per event. Upstream hit this hard during their own MV3 migration — read their
  migration commits before writing the background layer.
- **Flash of white.** Statically-declared content script at `run_at: document_start` applies a
  synchronous paint-hold (`html { background: #1a1a1a !important }`) before first paint, then the
  real theme refines it. Dynamic registration via `chrome.scripting.registerContentScripts` is too
  slow for this path.
- **CSP `style-src`.** Where injection is blocked, `declarativeNetRequest` can relax the header —
  but this materially worsens the store-review and security story. Gate it behind an explicit
  per-site opt-in with a clear warning; do not enable by default.
- **Isolated world only.** Never use `world: "MAIN"`. Page-world execution is the fastest route to
  violating the purity invariant.
- **Permissions.** A dark-mode extension realistically needs `<all_urls>`. Counterweight it with a
  zero-telemetry, no-network posture and say so plainly in the listing and README.

---

## 7. Stack and fork hygiene

**Keep upstream's structure and build for v1.** This is deliberate and worth defending: upstream's
`dynamic-theme-fixes.config` is a large, actively community-maintained catalog of per-site
workarounds. Diverging structurally means losing the ability to merge it. Keeping `git remote add
upstream` viable is worth more than a nicer build system.

- **Keep:** TypeScript, `src/inject/dynamic-theme/*`, `src/generators/modify-colors.ts`,
  `ConfigManager` and the fixes config format, shadow-DOM traversal, the existing build tasks.
- **Add as loosely-coupled new modules:** `src/picker/`, `src/rules/`, `src/coverage/`,
  `src/purity/`. Minimal edits to upstream files so merges stay tractable.
- **Rewrite where required:** the mutation surface flagged in §2 — mainly `inline-style.ts` and
  anything that adds classes to page elements.
- **Add tooling:** Vitest (unit), Playwright (purity harness + E2E), ESLint + Prettier, GitHub Actions CI.
- **Defer to v2:** build-system modernization (Vite + `@crxjs/vite-plugin`), popup UI rewrite in
  React. Tempting, but they maximize merge conflict surface for cosmetic gain.

**Upstream sync automation** is itself a feature: a scheduled workflow that pulls upstream's fixes
configs, opens a PR, and runs the test suite against them. Free site coverage forever.

**Licensing.** MIT fork. Retain upstream's copyright in `LICENSE`, add ours, ship a `NOTICE`. README
states plainly that this is a fork and links upstream. Do **not** use the Dark Reader name or logo —
the code is MIT, the trademark is not. Upstream generic engine fixes back where they apply.

---

## 8. Epics

Everything below becomes a GitHub epic. This is not a one-shot build.

| # | Epic | Notes |
|---|---|---|
| E0 | Repo bootstrap | `gh` repo creation, skill-templates onboarding, `CLAUDE.md`, CI skeleton, issue templates |
| E1 | Fork ingest | Import upstream, add `upstream` remote, verify build, rebrand, strip Firefox/Safari targets |
| E2 | **Purity invariant** | Audit + rewrite mutation surface; Playwright purity harness as a blocking CI gate. Highest risk. |
| E3 | Rule engine | Schema, scope precedence, storage, migrations, export/import |
| E4 | Element picker | Overlay, keyboard traversal, selector generation, iframe coordination |
| E5 | Treatment primitives | Scoped filter, scoped recolor, media counter-filter, exclude |
| E6 | Coverage detection | Luminance sampling, badge states, escalation into picker |
| E7 | Hard-case sites | Cross-origin sheets, shadow DOM, CSP, canvas apps; per-site fix catalog + fixtures |
| E8 | UI | Popup, options page, `chrome.commands` shortcuts, onboarding |
| E9 | Upstream sync | Scheduled fixes-config pull with automated PR |
| E10 | Distribution | Store listing, privacy policy, screenshots, release automation |

**Non-negotiable ordering:** E2 lands before E4 and E5. Building the picker on top of an engine that
still mutates page DOM means retrofitting the guarantee later, which is how the guarantee gets quietly
dropped.

---

## 9. Definition of done for v1

- Auto engine at parity with upstream on a fixture corpus of ~30 real sites
- Picker produces rules that survive reload and SPA navigation on Google Sheets, Google Docs, Figma,
  and at least three sites where upstream visibly fails
- Purity harness green in CI across all fixtures, including a Google Sheets round-trip test that
  proves cell formatting is untouched after enable → disable
- Coverage detection correctly flags partially-themed pages with < 10% false-positive rate on the corpus
- Theme injection adds < 100ms to first contentful paint on the corpus median
- Rule export/import round-trips losslessly
