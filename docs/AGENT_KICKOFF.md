# Agent Kickoff Prompt

> Paste everything below the line into a fresh agent session started in the empty project directory.
> `ARCHITECTURE.md` should be dropped into that directory first — the prompt assumes it is there.

---

You are bootstrapping a new open-source project from scratch in the current working directory. Read
`ARCHITECTURE.md` in this directory in full before doing anything else. It is the design of record.
Where this prompt and that document disagree, the document wins on technical design and this prompt
wins on process.

## What we're building

**Umbra** (working name — confirm Chrome Web Store availability and propose alternates if taken): a
fork of [Dark Reader](https://github.com/darkreader/darkreader) (MIT licensed) that adds three things
upstream lacks — a devtools-style element picker for manually darkening page regions, per-scope rule
persistence, and a hard, CI-enforced guarantee that the extension never mutates page-owned DOM.

Chrome/Chromium, Manifest V3, v1 only. Firefox and Safari are explicitly out of scope; strip those
build targets from the fork.

The single most important product requirement: **the theming must live entirely in a user-side layer
that the page's own JavaScript cannot observe or serialize.** The motivating failure is Google Sheets
— existing extensions can leave the actual document with white or light-gray text, so disabling the
extension or opening the doc as another user shows a broken sheet. `ARCHITECTURE.md` §2 states this
as the "Purity Invariant" and specifies a Playwright harness that enforces it in CI. Treat that
harness as a blocking gate, not a nice-to-have.

## Phase 0 — onboarding, before any code

1. **Skills.** There is a `skill-templates` repo, both locally on this machine and on GitHub under my
   account. Find it (check `gh repo list`, and common local paths), read it, and work out its
   intended integration flow yourself — I'm not going to spell it out. Onboard the relevant skills
   into this repo the way that repo expects. If the flow is ambiguous, pick the most reasonable
   reading, do it, and tell me what you assumed.

2. **Repo.** Use the GitHub CLI (`gh`) to create the repository and configure it: MIT license,
   description, topics, issue templates, a PR template, branch protection on `main` requiring CI to
   pass, and labels for the epics below.

3. **`CLAUDE.md`.** Write it for future agent sessions, not for me. It must cover: the purity
   invariant and why it exists (a future agent that doesn't understand it will break it), the
   relationship to upstream and the rule that upstream files get minimal edits to keep merges
   tractable, where new subsystems live, how to run the test suites, and the model-delegation policy
   below.

4. **Read upstream before writing anything.** Specifically: their MV3 migration commits (the service
   worker ephemerality lessons are hard-won), `src/inject/dynamic-theme/`,
   `src/generators/modify-colors.ts`, and `src/inject/dynamic-theme/inline-style.ts` — that last one
   is the primary purity violation you'll need to rewrite. Write up what you learn as an ADR before
   you touch it.

## Phase 1 — scope the work

Convert §8 of `ARCHITECTURE.md` into GitHub epics on the issues board — one issue per epic, each
decomposed into concrete child issues with acceptance criteria. Do not start implementing until the
board exists and I've had a chance to look at it.

Respect the stated ordering constraint: **E2 (purity invariant) lands before E4 (picker) and E5
(treatments).** Building the picker on an engine that still mutates page DOM means retrofitting the
guarantee later, which is how it quietly gets dropped.

For each epic, note in the issue body which model tier you intend to use for it.

## Working agreement

- **This is not a one-shot build.** Work epic by epic. Land E0 and E1, show me a working loaded
  unpacked extension, then continue.
- **Model delegation, up and down the ladder.** Use a cheaper model for mechanical implementation,
  test scaffolding, and fixture authoring. Reserve the strongest model for the purity audit, selector
  generation strategy, coverage detection heuristics, and any architectural decision. Say which tier
  you're using and why when it isn't obvious.
- **ADRs for anything that diverges from `ARCHITECTURE.md`.** Short `docs/adr/NNNN-*.md` files. The
  design doc was written without access to the actual upstream source; if reality contradicts it, I
  want the contradiction written down, not silently resolved.
- **Tests are part of done.** Vitest for units, Playwright for the purity harness and E2E. A PR that
  changes theming behavior without a fixture is incomplete.
- **Fixture corpus early.** Build the ~30-site fixture corpus in E1, not E7. Every subsequent epic
  gets measured against it, so it needs to exist before there's anything to measure.
- **Ask me** when a decision is genuinely product-shaped (naming, default hotkey, what the popup
  emphasizes) rather than technical. Don't ask me about technical choices the design doc already
  covers — just implement them, or write an ADR if you disagree.

## Fork hygiene — get this right at the start

- MIT fork: retain upstream's copyright in `LICENSE`, add ours, ship a `NOTICE` file.
- README states plainly that this is a fork of Dark Reader and links upstream.
- Do **not** use the Dark Reader name or logo anywhere. The code is MIT; the trademark is not.
- `git remote add upstream` and keep it working. Set up the scheduled fixes-config sync (E9) early —
  it's the cheapest ongoing source of site coverage we'll ever get.
- Where we fix something generic in the engine, plan to upstream it back.

## First deliverable

Report back with:

1. What you found in `skill-templates` and how you integrated it
2. The created repo URL and its configuration
3. The epic board, with child issues and acceptance criteria
4. Your ADR on the upstream purity audit — specifically, an honest inventory of every place the
   forked engine currently mutates page-owned DOM, and your proposed replacement for each
5. Anything in `ARCHITECTURE.md` that turned out to be wrong once you read the actual source
