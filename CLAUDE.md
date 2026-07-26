# Duskwright — agent guide

You are working on **Duskwright**, a Chrome/Chromium MV3 dark-mode extension forked from
[Dark Reader](https://github.com/darkreader/darkreader) (MIT).

Read this file before touching anything. Then read `ARCHITECTURE.md` (the design of record) and
`docs/adr/` (the corrections to it, from reading the actual upstream source). Where `ARCHITECTURE.md`
and an ADR disagree, **the ADR wins** — the design doc was written without access to upstream.

---

## The purity invariant — read this twice

This is the product. Everything else is table stakes we inherited from upstream.

> **The extension must never produce a mutation of the page DOM that the page's own JavaScript can
> observe as a change to its own content or serialize into its document model.**

### Why it exists

Open a Google Sheet with a typical dark-mode extension. The extension recolors cell text by writing
into each cell element's `style` attribute. Sheets serializes inline styles into its own document
model. The white text is now **in the document** — turn the extension off and the sheet is broken;
open it as a colleague and it is broken for them too. The user's data has been damaged by a
cosmetic tool.

Duskwright exists because that is unacceptable. Theming lives entirely in a user-side layer the page
cannot see or serialize. That is the whole pitch.

### What this means when you write code

**Forbidden, always:**

- Writing `element.style.*` on any page-owned element (this includes `setProperty`, `removeProperty`,
  and `cssText`)
- Adding or removing classes or attributes on page-owned elements — including `<html>` and `<body>`
- Inserting or modifying rules in page-owned `CSSStyleSheet` objects
- Touching `document.designMode`, `contenteditable`, or any editing surface
- Any write inside a region an application treats as document content
- Inserting nodes into page DOM, **even transiently** — a page MutationObserver fires on the insert
  and the remove

**Allowed:**

- Appending **our own** `CSSStyleSheet` to `document.adoptedStyleSheets` — append only, never
  reassign the array (see ADR 0002 C5)
- A single injected `<style id="duskwright-theme">` in `<head>` as a fallback where CSSOM is
  unavailable
- Elements we create ourselves, always inside a shadow root we own, always removed on teardown

### The trap

Every violation in upstream was a *reasonable local decision*. Tagging an element is the obvious way
to override its inline style. Removing a conflicting plugin's class is the obvious way to win a
fight with it. Setting `data-darkreader-mode` on `<html>` is the obvious way to give your CSS
something to key off.

If you find yourself reaching for a mutation because it is the natural solution to the problem in
front of you, **that is exactly the moment the invariant is protecting against.** The answer is
always one of: emit a selector into our own sheet, win by specificity or `!important`, apply a
scoped filter to a container, or report the failure to the user via coverage detection and let them
aim the picker at it. Never mutate. Degrading gracefully is in scope; mutating is not.

### The gate

`tests/purity/` is a Playwright suite and a **blocking CI check**. It asserts three things per
fixture: byte-identical `outerHTML`, byte-identical page-owned stylesheet text, and an **empty
filtered MutationObserver log** recorded from before the extension was enabled. The observer half
is not optional — snapshot diffing alone misses transient mutations, which is how the guarantee
would quietly rot (ADR 0002 C4).

Do not skip, weaken, or add exclusions to this suite to make a PR pass. If it goes red, the code is
wrong. If you genuinely believe the harness is wrong, write an ADR.

---

## Relationship to upstream

Upstream is `git remote add upstream https://github.com/darkreader/darkreader.git`. Keep it working.

Upstream's `dynamic-theme-fixes.config` is a large, actively community-maintained catalog of
per-site workarounds, and E9 syncs it on a schedule. That catalog is the cheapest site coverage this
project will ever get, and it only keeps flowing while merges stay tractable.

**Therefore: upstream files get minimal edits.** Not "tidy edits" — minimal. Do not reformat, do not
rename, do not refactor for style, do not modernize, do not reorder imports in an upstream file you
happened to open. Every diff line you add to an upstream file is a line that can conflict on every
future sync.

- **New functionality goes in new modules** — `src/picker/`, `src/rules/`, `src/coverage/`,
  `src/purity/`. These are ours; normal standards apply.
- **Touching an upstream file** is justified only for the purity rewrite (E2) or a real bug. Say why
  in the PR.
- **Generic engine fixes get proposed upstream**, where they apply. It is a two-way relationship.
- **Build-system modernization is deferred to v2.** Vite and a React popup rewrite are tempting and
  maximize merge-conflict surface for cosmetic gain. Do not start them.

Targets: Chrome/Chromium MV3 only. Firefox MV2/MV3 and Thunderbird build targets are stripped (there
was never a Safari target — ADR 0002 C6). Do not reintroduce them.

**Naming:** the code is MIT, the trademark is not. Never use the Dark Reader name or logo in UI,
store assets, or docs, except to factually state that this is a fork of it.

---

## Where things live

```
src/
  inject/dynamic-theme/   UPSTREAM. The engine. Minimal edits.
                          modify-colors.ts lives here, NOT in src/generators/ (ADR 0002 C3).
                          inline-style.ts is the primary purity violation — see ADR 0001.
  generators/             UPSTREAM. Theme generation, filters. Minimal edits.
  config/                 UPSTREAM. The fixes catalog. Synced from upstream by E9 — do not hand-edit.
  background/, ui/, utils/, api/   UPSTREAM.

  picker/                 OURS. Element picker overlay, selector generation, iframe coordination.
  rules/                  OURS. Rule schema, scope precedence, storage, migrations, export/import.
  coverage/               OURS. Luminance sampling, badge state, escalation into the picker.
  purity/                 OURS. Runtime ownership tracking the harness asserts against.

tests/
  unit/                   Vitest.
  purity/                 Playwright. THE BLOCKING GATE.
  e2e/                    Playwright.
  fixtures/               The ~30-site corpus. Built in E1 — every later epic is measured against it.

docs/adr/                 Architecture decisions. Anything diverging from ARCHITECTURE.md lands here.
ARCHITECTURE.md           Design of record. Left unedited; ADRs are the diff against it.
```

---

## Running things

```bash
npm ci                    # install
npm run build             # build the extension (Chrome MV3)
npm test                  # Vitest unit tests
npm run test:purity       # Playwright purity harness — the blocking gate
npm run test:e2e          # Playwright end-to-end
npm run lint              # ESLint + Prettier
```

Load unpacked from the build output directory in `chrome://extensions` with Developer Mode on.

**A PR that changes theming behaviour without a fixture is incomplete.** Tests are part of done, not
a follow-up issue.

---

## Model delegation policy

Cost discipline: the session's top model orchestrates, cheaper tiers execute. State which tier you
are using and why whenever it is not obvious.

**Use a cheaper tier for:** mechanical implementation against a written spec, test scaffolding,
fixture authoring, config and manifest edits, docs, mechanical refactors within our own modules.

**Reserve the strongest tier for:**

- Anything touching the purity invariant — audits, the `inline-style.ts` rewrite, harness design
- Selector generation strategy (correctness here determines whether user rules survive reload)
- Coverage detection heuristics (false-positive rate is an acceptance criterion)
- Any architectural decision, and any ADR

The rule of thumb: if getting it wrong is *invisible* — a rule that silently stops matching, a
mutation that slips past the gate, a false-positive coverage flag — it needs the strong tier. If
getting it wrong makes CI red, a cheap tier is fine.

---

## Working agreement

- **Not a one-shot build.** Work epic by epic. **E2 lands before E4 and E5** — building the picker
  on an engine that still mutates page DOM means retrofitting the guarantee later, which is how it
  quietly gets dropped.
- **ADRs for anything diverging from `ARCHITECTURE.md`.** Short `docs/adr/NNNN-*.md`.
- **Ask about product-shaped decisions** — naming, default hotkey, what the popup emphasizes. Do not
  ask about technical choices the design doc already covers; implement them, or write an ADR if you
  disagree.
- **Zero telemetry, no network calls** beyond upstream's existing CORS-stylesheet fallback. The
  extension needs `<all_urls>`; the counterweight is that it phones nowhere, and the README and
  store listing say so plainly.
- **Attribution:** the repo owner is the sole author. No `Co-Authored-By` trailers, no "Generated
  with" lines, no AI or agent attribution anywhere — commits, PRs, issues, or docs.

## Skills

Skills come from the `blamechris/skill-templates` registry and install on demand. Asked to run `/X`?
Check `.claude/commands/X.md`. Missing → `skill add X`, then invoke. Present but
`.claude/skills/X/SKILL.md` missing → just not compiled → `node scripts/compile-skill-targets.mjs
--name X`. This repo compiles for `claude`, `gemini`, and `codex` (see `.claude/skill-profile.md`).
