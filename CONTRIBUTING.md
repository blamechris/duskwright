# Contributing to Duskwright

Duskwright is a Chrome/Chromium MV3 dark-mode extension forked from
[Dark Reader](https://github.com/darkreader/darkreader) (MIT), built around one guarantee: **the
extension never writes to page-owned DOM.** Most of what follows exists to protect that guarantee.

> **Status: early development.** Nothing is shipping yet, the surface changes week to week, and
> work is organised by epic. Open an issue before writing code — see below.

## Read these first

| Document | Why |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | The working agreement: the purity invariant in full, the minimal-edit rule for upstream-derived files, where new subsystems belong, and the model-delegation policy. Read it before touching anything. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The design of record. |
| [`docs/adr/`](docs/adr/) | Architecture decisions. Where an ADR and `ARCHITECTURE.md` disagree, **the ADR wins** — the design doc was written before the upstream source was audited. |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Applies to every interaction here. |

Security vulnerabilities do **not** go through issues or pull requests — see
[`SECURITY.md`](SECURITY.md).

## The purity invariant, in one paragraph

> The extension must never produce a mutation of the page DOM that the page's own JavaScript can
> observe as a change to its own content or serialize into its document model.

Extensions that recolor by writing `element.style` corrupt apps that serialize inline styles into
their own document model — a Google Sheet themed that way stays broken after you disable the
extension, and stays broken for colleagues. Duskwright's theming lives in a user-side layer the page
cannot see. Every violation upstream ever shipped was a *reasonable local decision*, so if a
mutation feels like the natural fix for the problem in front of you, that is exactly the moment the
invariant is protecting against. The alternatives are always: emit a selector into our own sheet,
win by specificity or `!important`, apply a scoped filter to a container, or report the failure
honestly through coverage detection. `CLAUDE.md` has the full forbidden/allowed list.

`tests/purity/` is a Playwright suite and a **blocking CI check**. Do not skip it, weaken it, or add
exclusions to make a PR pass. If it is red, the code is wrong. If you believe the harness itself is
wrong, write an ADR.

## Open an issue first

Discuss before you build. Every change should trace back to an issue, and every issue belongs to an
epic (`E0`–`E10`, tracked by the `E*` labels and the `epic` tracking issues).

| Template | Use it for |
|---|---|
| **Task** | A unit of work under an epic. Names its parent epic, concrete acceptance criteria, and the model tier. This is the normal path for features and refactors. |
| **Purity violation** | The extension wrote to page-owned DOM. Outranks every other open issue. |
| **Bug report** | Anything else broken in the extension. |
| **Site not themed well** | A specific site the engine handles badly. These become fixtures in the corpus. |

**Site fixes belong upstream.** `src/config/` is upstream's community-maintained catalog and is
synced on a schedule — do not hand-edit it here. A site themed badly by the *engine* (rather than by
Duskwright's picker, coverage detection, or rule engine) should be reported to
[upstream](https://github.com/darkreader/darkreader/issues), where a fix benefits everyone and flows
back to us through the sync.

## Setting up

Node 22 (what CI uses) and npm.

```bash
npm ci                      # install exactly what package-lock.json pins
npm run build               # release build → build/release/chrome-mv3 (and chrome, MV2)
npm run debug               # debug build   → build/debug/chrome-mv3 (and chrome, MV2)
npm run debug:watch:mv3     # debug MV3, rebuilt on every change
```

Load the extension at `chrome://extensions` with **Developer mode** on → **Load unpacked** →
`build/debug/chrome-mv3`.

Chrome/Chromium MV3 only. Firefox, Thunderbird, and Safari targets are stripped and must not be
reintroduced.

## Running the gates

```bash
npm test                    # Jest unit tests
npm run test:purity         # Playwright purity harness — THE BLOCKING GATE
npm run test:e2e            # Playwright end-to-end
npm run lint                # ESLint (npm run code-style is an alias)
```

CI runs, on every pull request:

- **hygiene** — required files present, upstream attribution retained in `LICENSE`/`README.md`, no
  literal control bytes in source, and no AI/agent attribution in tracked content or commit
  messages.
- **lint**, **build**, **test**
- **purity** — the blocking gate.
- **e2e** — advisory until the suite lands.

**A PR that changes theming behaviour without a fixture is incomplete.** Tests are part of done, not
a follow-up issue.

## Working with upstream-derived files

Upstream's fixes catalog is the cheapest site coverage this project will ever get, and it keeps
flowing only while merges stay tractable. So: **upstream files get minimal edits.** Not tidy edits —
minimal.

- Do not reformat, rename, refactor for style, modernize, or reorder imports in an upstream file you
  happened to open. Every added diff line is a line that can conflict on every future sync.
- New functionality goes in **new modules** — `src/picker/`, `src/rules/`, `src/coverage/`,
  `src/purity/`. Those are ours, and normal standards apply.
- Touching an upstream file is justified only by the purity rewrite or a real bug. Say which, in the
  PR.
- Generic engine fixes get proposed upstream as well, where they apply.
- Build-system modernization (Vite, a React popup rewrite) is deferred — do not start it.

**Naming:** the code is MIT, the trademark is not. Never use the Dark Reader name or logo in UI,
store assets, or docs, except to state factually that this is a fork of it.

## Pull requests

- **One purpose per PR.** Keep the change as small as it can be and still be complete.
- **Title in conventional-commit form** — `type(scope): summary`, under ~70 characters. Commit
  messages follow the same convention.
- **Fill in [the PR template](.github/PULL_REQUEST_TEMPLATE.md).** All four sections are load-bearing:
  - **What** — the change and the issue it closes (`Closes #N`).
  - **Epic** — `E0`–`E10`, or "none".
  - **Purity impact** — required. Confirm the PR does not touch page-owned DOM; if it changes
    theming behaviour, say which fixture covers it; if it touches an upstream-derived file, justify
    it there.
  - **Test plan** — `npm test`, `npm run test:purity`, `npm run lint`, and a manual check as an
    unpacked extension. If a box is unchecked, say why.
- **Green CI before review.** A red purity job is a wrong implementation, not a flaky gate.
- **Do not merge your own PR** without review.

### Attribution

The repository owner is the sole author of the work here. No agent or AI attribution appears
anywhere — not in commits, pull requests, issues, or docs — and no `Co-Authored-By` trailers of any
kind are used. CI enforces this on both tracked files and commit messages, so a stray trailer will
fail the build.

### On AI-assisted contributions

They are allowed, and this project's own documented workflow is agent-driven — see `CLAUDE.md`. What
matters is the output, not the tooling that produced it. If you use an assistant, the bar is
unchanged and it is entirely yours to meet:

- You are the author. You understand every line you submit and can defend it in review.
- The change is scoped to one purpose and does not drift into unrelated files.
- Tests, lint, and the purity gate are green, and behaviour changes ship with a fixture.
- Discussion in issues and reviews is yours — do not paste unreviewed generated text into a thread
  and leave a reviewer to argue with it.
- The attribution rule above still applies: no agent footers, no trailers.

A contribution that fails those bars gets closed for failing them, whatever wrote it.
