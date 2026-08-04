# Handoff — ADR 0007 designed, backlog reconciled, tooling caught up

- **Date:** 2026-08-03
- **Boundary reason:** work-class switch. The design for #20 is written and merged; implementing it
  is engine work against a fresh spec and needs none of this session's context.
- **Picks up at:** issue #20 — implement ADR 0007. The ADR is the spec; read it first.

---

## STATE

| | |
|---|---|
| Branch / HEAD | `main` @ `0ec96a3f` (merge of #95) |
| Working tree | clean |
| CI on `main` | 6/6 green — `hygiene` `lint` `build` `test` `e2e` `purity` |
| Purity baseline | **empty** — `tests/purity/known-violations.json` has `"fixtures": {}` |
| Tests | 268 unit (Jest) · 101 purity + 33 skipped (Playwright) |
| Open PRs | none |
| Open issues | 64 |
| Skills | all 12 current by the drift check — but see the `create-pr` caveat below |

**Verify before building on any of this** — re-derive, don't trust:

```bash
git log --oneline -4 && git status --porcelain
gh pr view 95 --json state --jq .state    # must say MERGED
python3 -c "import json;print(len(json.load(open('tests/purity/known-violations.json'))['fixtures']))"  # 0
```

---

## TL;DR — what shipped

Three PRs, none of them engine code. This session bought the *next* session a clean run at #20.

| PR | What |
|---|---|
| #98 | **ADR 0007** — the design for #20, with three facts measured in Chromium rather than assumed |
| #72 | Release workflow — unblocked after 6 days, two review findings fixed |
| #95 | All 12 skills refreshed against the registry; two stale facts and one real bug fixed |

Backlog reconciled: **#17, #18, #77, #82, #83 closed** against verified code, **#96 and #97 filed**
for gaps that closing them would otherwise have dropped, **#80 and #81 commented** as latent.

---

## The next task: implement ADR 0007 (#20)

`docs/adr/0007-sync-style-placement.md` is the spec. Status is **Proposed** — it has not been
reviewed by anyone but its author, so disagree with it in an ADR rather than in code.

### What it decided

Overrides move out of page DOM entirely, into **one constructed `CSSStyleSheet` per document or
shadow root**, appended exactly once to `adoptedStyleSheets`, with each page sheet's overrides held
in an internally ordered rule range.

### The three things it measured, so you don't re-derive them

1. **Adopted sheets sort after every document sheet**, including one appended later. So the cascade
   goes from `A A' B B'` to `A B [A' B']`.
2. **Ordering inside `adoptedStyleSheets` is positional**, mid-array `splice` works, and it does not
   detach a reference the page holds.
3. **Reassignment does *not* detach a held reference.** Identity is stable while the page's sheets
   are silently dropped. `CLAUDE.md`'s "never reassign" rule is right; its stated rationale was not.

### The trap this section exists to flag

**`inMode === 'away'` is not an escape hatch.** The audit trail reads as though it were the
non-mutating alternative. It is not — `injectStyleAway` appends a container `<div>` to `<body>`
(`injection.ts:44`) and runs a `MutationObserver` that re-appends it whenever the page moves it.
Same violation, different node, plus a mutation war. Both modes have to go; there is nothing to fall
back to.

### The one behaviour change to pin with a fixture

`A A' B B'` → `A B [A' B']` flips exactly one case: a declaration in a later page sheet that the
engine **refused** to override, competing at equal specificity with an earlier one it themed. The
refusals are ADR 0006's deferred set (`var()` values, inline `!important`, geometry-dependent SVG
fill). Narrow and real. ADR 0007's acceptance criteria require a fixture that pins it deliberately
rather than leaving it to surface on a site.

### Sequencing note

D4 says **do not** empty `hostsBreakingOnStylePosition` in the same PR. It is upstream's file and E9
syncs it; mixing a behavioural rewrite with a catalog-shaped deletion makes both harder to review
and to merge.

---

## What I verified rather than took on faith

The previous handoff said to close five issues. Two of them were not done as literally specified,
and the difference was only visible by reading the merged code:

- **#17** had two unmet acceptance criteria. The container-filter fallback was **untracked by any
  issue** — ADR 0004 turned it into tier 4 and blocked it on a headful GPU-raster measurement,
  because every filter number in evidence was taken on a paint-blind headless Chromium. Closing #17
  silently would have dropped it. Filed as **#96**.
- **#18**'s "byte-identical after enable → disable" fixture does not exist. It is not needed: the
  purity spec asserts byte-identity *while the extension is active*, which is the stronger claim —
  if the attribute is never written there is nothing to restore. Closed with that reasoning stated.
- **#77, #82, #83** are genuinely fixed, each confirmed at a specific line rather than by the PR
  description. Branch A is now `LEFT EXACTLY AS WRITTEN` (`catalog-markers.ts:334`), the presence
  selector uses `:where()` to stay `(0,1,0)` (`:100`), and the `initial` reset is at
  `emitter.ts:82`.

**#80 and #81 stay open, deliberately.** Both are real and both are currently unreachable: they live
behind the presence-test fallback, and on today's catalog all six marker-selecting rules collapse
instead — asserted by `expect(after).toBe(before + 6)` in `catalog-markers.tests.ts`, verified
passing. What makes them live again is an E9 sync bringing in a rule the collapse refuses. Since the
failure mode is *under*-matching, it presents as a site fix that quietly stops applying, not as
anything that turns CI red.

---

## Tooling, and one bug worth remembering

All 12 skills were behind — 8 on template version, all 12 on profile hash. The substantive pull is
`af9c1e4`: explicit-path staging and a branch assertion before writes, now in `create-pr`, `fix-ci`,
`skill`, and `session-lifecycle`.

Three defects found while doing it, all of the same species — **a claim in a comment that the code
underneath contradicts**:

1. **`fix-ci` polled with `MAX_WAIT=300` against a `purity` job measured at ~560s** across four runs.
   It would have timed out on every green run. The comment explaining the number said jobs
   "self-skip pre-E1", which stopped being true when E1 landed. Raised to 900s with the real
   per-job figures recorded.
2. **`create-pr`'s branch guard aborted in the case it was written for.** The comment says the step
   "runs AFTER a user-confirmation gate, so it is necessarily a fresh shell"; the code then wrote
   `${SESSION_BRANCH:?...}`, which does not re-declare anything — it demands the variable already be
   set. Found by review on #95, reproduced in bash, fixed here and filed upstream as
   `skill-templates#191` so a later `skill update` cannot reintroduce it.
3. **`adopted-stylesheets.html` documents a detector that does not detect** (#97). Its comment says
   a held reference detaches on reassignment. It does not — measured. This one becomes load-bearing
   the moment #20 lands, because that fixture stops being a corner case and becomes the guard on the
   main path.

The pattern is worth carrying into #20: **the comment is the least-tested part of the file.** Every
one of these passed review and CI while saying something false about the code beneath it.

### The `create-pr` caveat — read before running `skill update`

`create-pr` in this repo is **ahead of its registry template**. The lockfile pins it at `af9c1e4`,
which is the current registry hash, so `skill outdated` reports it clean — the drift check compares
hashes, not content, and cannot see the local fix.

`skill update create-pr` will therefore silently overwrite the fix and reintroduce the abort. Do not
run it until `skill-templates#191` lands upstream; after it lands, update normally and confirm the
`${SESSION_BRANCH:-${BRANCH:?...}}` form survived.

---

## Left undone, deliberately

- **ADR 0007 is `Proposed`, not `Accepted`.** D2 (rejecting one sheet per page sheet) and D3 (the
  behaviour change) are the parts most worth a second opinion before code is written against them.
- **`skill-templates#181`** — the scheduled-task wave relauncher — is still open upstream. Attended
  restarts are unaffected; an unattended one has no relauncher.
- **`pi` is installed on this machine but is not a compile target.** The compiler says so on every
  run. Add it to `targets:` in `.claude/skill-profile.md` if this repo is ever driven with pi;
  ignoring the note is fine otherwise.
