## What

<!-- What changed, and why. Link the issue: Closes #N -->

## Epic

<!-- E0-E10, or "none" -->

## Purity impact

<!-- Required. Delete the lines that do not apply. -->

- [ ] This PR does not touch page-owned DOM in any way
- [ ] This PR changes theming behaviour and adds/updates a fixture for it
- [ ] This PR touches an upstream-derived file (justify below — the minimal-edit rule applies)

<!--
If you added a mutation of a page-owned element, stop. See CLAUDE.md.
The answer is a selector into our own sheet, a specificity win, a scoped filter on a
container, or an honest report to the user via coverage detection. Never a mutation.

If you touched an upstream file, say why here. Every diff line is a future merge conflict
against the fixes catalog we sync from upstream.
-->

## Test plan

- [ ] `npm test` passes
- [ ] `npm run test:purity` passes
- [ ] `npm run lint` passes
- [ ] Verified manually as an unpacked extension

<!-- If any box is unchecked, say why. -->
