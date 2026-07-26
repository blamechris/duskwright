# duskwright skill profile

## Project Context
- **Tech:** TypeScript, Chrome/Chromium Manifest V3 browser extension. Forked from
  [Dark Reader](https://github.com/darkreader/darkreader) (MIT), upstream's build tasks retained.
- **Build system:** upstream's Node-based task runner (`tasks/build.js`), npm scripts. Vite
  migration is deliberately deferred to v2 — it maximizes merge-conflict surface against upstream.
- **Repo:** blamechris/duskwright
- **Main branch:** main
- **CI:** GitHub Actions `.github/workflows/ci.yml` — jobs `hygiene`, `lint`, `build`, `test`,
  `purity`. `purity` is a blocking gate and must never be weakened to make a PR pass.
- **Status:** Bootstrapping. E0 (repo setup) landing; E1 (fork ingest) next. No source imported yet,
  so `lint`/`build`/`test`/`purity` jobs self-skip until their prerequisites exist.
- **Hard requirements (never regress):**
  - **The purity invariant.** The extension must never produce a mutation of the page DOM that the
    page's own JavaScript can observe as a change to its own content or serialize into its document
    model. Enforced by `tests/purity/`. See `CLAUDE.md` and `docs/adr/0001-upstream-purity-audit.md`.
  - **Upstream mergeability.** Upstream-derived files get minimal edits only — no reformatting,
    renaming, or refactoring. The scheduled fixes-config sync (E9) depends on merges staying
    tractable.
  - **Chromium MV3 only.** Firefox and Thunderbird targets are stripped; do not reintroduce them.
  - **No Dark Reader name or logo** in branding or UI. The code is MIT; the trademark is not.
  - **Zero telemetry, no network calls** beyond the engine's existing CORS-stylesheet fallback.

## Build / Test Commands
- Build (the gate): `npm run build`
- Test: `npm test` (Vitest, unit)
- Purity harness (blocking): `npm run test:purity` (Playwright)
- E2E: `npm run test:e2e` (Playwright)
- Lint/typecheck: `npm run lint` (ESLint + Prettier)

Note: these npm scripts land with E1/E2. Before then, `hygiene` is the only CI job that does real
work.

## Conventions
- Branch prefix / naming: `feat/`, `fix/`, `refactor/`, `test/`, `docs/`, `chore/`
- Commit style: conventional commits. Scopes: `engine`, `picker`, `rules`, `coverage`, `purity`,
  `ui`, `background`, `build`, `ci`, `docs`, `fixes`
- Source file patterns:
  - Ours (normal standards): `src/picker/**`, `src/rules/**`, `src/coverage/**`, `src/purity/**`
  - Upstream (minimal edits): `src/inject/**`, `src/generators/**`, `src/background/**`, `src/ui/**`,
    `src/utils/**`, `src/api/**`, `src/config/**`
  - Tests: `tests/unit/**`, `tests/purity/**`, `tests/e2e/**`, `tests/fixtures/**`

## Skill Targets

`.claude/commands/<name>.md` is the provider-neutral source of truth. `skill add`/`update` compiles
each into every agent's native format via `scripts/compile-skill-targets.mjs`.

targets: claude, gemini, codex

- **claude** → `.claude/skills/<name>/SKILL.md`
- **gemini** → `.gemini/commands/<name>.toml` (skipped for bodies containing `{{…}}`/`!{…}`/`@{…}`)
- **codex** → `.codex/skills/<name>/SKILL.md`

All three emit version-controlled, repo-tracked artifacts.

## Cross-cutting: the purity invariant in spawned agents

Any skill that spawns subagents to write or review code must carry this, because subagents start
with fresh context and do not inherit `CLAUDE.md`:

> Never write `element.style.*`, add/remove classes or attributes, insert rules into page-owned
> stylesheets, or insert nodes into page DOM — on **any** page-owned element, including `<html>`,
> and including transiently. Theming goes into our own constructed stylesheet via a generated
> selector, or a scoped filter on a container, or is reported honestly to the user. Upstream's
> engine violates this in fourteen catalogued places; `docs/adr/0001-upstream-purity-audit.md` is
> the inventory. If a mutation looks like the natural solution, that is exactly the case the
> invariant exists for.

## agent-review Customizations

### Persona
**Duskwright Auditor** — expert in Chrome extension MV3 architecture, CSSOM, shadow DOM, content
script isolation, and the DOM-mutation surface of theming engines.

Mindset: *"Can the page tell we were here? Can it save what we did into its own document?"*

### Review priorities, in order
1. **Purity.** Any write to a page-owned element, sheet, or node tree — including transient inserts
   and including `<html>`/`<body>`. This outranks everything else. Cite the file:line and classify
   P0 (serializable) / P1 (observable) / P2 (destructive).
2. **Upstream diff hygiene.** Edits to `src/inject/**`, `src/generators/**`, and other
   upstream-derived paths: is each diff line necessary, or is it drive-by tidying that will conflict
   on the next fixes sync?
3. **MV3 correctness.** Service-worker ephemerality (no in-memory state across events), no
   `world: "MAIN"` outside the one justified proxy exception (ADR 0002 C2), `document_start` paint
   hold intact.
4. **Rule-engine correctness.** Scope precedence must stay a pure, unit-tested function; selector
   confidence and expected-match degradation must not silently theme the wrong element.
5. **Fixtures.** A change to theming behaviour without a fixture is incomplete.

### Known false positives
- `classList.add('darkreader')` / `classList.add('duskwright')` on elements the extension **created
  itself** is not a purity violation. Check whether the element came from `document.createElement`
  before flagging.
- `insertRule`/`deleteRule` against our own sync or override sheets is fine — only page-owned sheets
  are forbidden.

## create-issue Customizations
- Epic labels: `E0-bootstrap` … `E10-distribution`
- Type labels: `bug`, `enhancement`, `purity`, `site-coverage`, `upstream`, `docs`, `test`
- Priority labels: `priority:high`, `priority:medium`, `priority:low`
- Tier labels: `tier:cheap`, `tier:strong` — every task issue carries one (model-delegation policy)
- Child issues link the parent with a body line `Part of #N`

## create-pr Customizations
- Test plan lines: `npm test`, `npm run test:purity`, `npm run lint`, manual unpacked-extension check
- The PR template's **Purity impact** section is mandatory — never delete it, and never tick the
  "does not touch page-owned DOM" box for a PR that does
- Note the epic (E0–E10) in the PR body

## start-working Customizations
### Ready-to-work
- Unassigned, unblocked issues carrying an epic label
### Blocked
- `blocked`, `needs-design`
- **Ordering constraint, enforced:** E2 (purity invariant) lands before E4 (picker) and E5
  (treatments). Treat open E4/E5 issues as blocked while E2 issues remain open, even without a
  `blocked` label.
### Priority signals
- `purity` → always P0
- `site-coverage` → P2 until the E1 fixture corpus exists

## swarm-audit Customizations

### Domain-specific extended agents

| Agent | Lens | When to include |
|---|---|---|
| Purity Inspector | Every page-DOM write path; whether the harness would actually catch it | Any target touching the engine, picker, or treatments — which is most of them |
| Merge Steward | Diff surface against upstream; whether a change will survive the fixes sync | Target modifies upstream-derived files |
| MV3 Warden | Service-worker ephemerality, content-script world isolation, CSP, paint-hold timing | Target touches background, injection, or manifest |

### Grading criteria
- Weight purity violations above all other findings, including correctness and performance.
- A finding that the **harness would not catch** a real violation is more serious than the violation
  itself — it means the gate is broken.
