# Duskwright

A dark mode extension for Chrome that **never writes to the page**.

> **Status: early development.** Nothing is shipping yet. The board tracks progress by epic.

## What makes it different

Duskwright is a fork of [Dark Reader](https://github.com/darkreader/darkreader) (MIT). Dark Reader's
engine is excellent and represents years of accumulated edge cases — rewriting it would be
reconstructing a solved problem badly. Duskwright adds three things upstream lacks.

### 1. It cannot damage your documents

Most dark-mode extensions recolor text by writing into each element's `style` attribute. On an app
that serializes inline styles into its own document model — Google Sheets, Google Docs, any rich
text editor — that theming becomes **part of your document**. Turn the extension off and the sheet
has white text on white. Share it with a colleague and it is broken for them too.

Duskwright's theming lives entirely in a user-side layer the page cannot observe or serialize. We
call this the **purity invariant**, and it is enforced by a Playwright suite that blocks CI: for
every fixture page, the page's serialized HTML, its stylesheet text, and a MutationObserver log
recorded from before the extension ran must all come back clean.

It is a guarantee, not a promise. See [`ARCHITECTURE.md`](ARCHITECTURE.md) §2.

### 2. It tells you when it didn't work

Every dark-mode extension fails on some sites. Duskwright measures whether theming actually landed —
sampling the rendered result for how much of the viewport is still light — and flags pages it only
partially themed instead of failing silently.

### 3. You can fix it yourself

A devtools-style element picker lets you point at a region and darken it by hand, with a live
preview. Rules persist per origin, path prefix, exact URL, or pattern. This is the only mechanism
that works on canvas-rendered apps like Google Docs and Figma, where there is no DOM text to
recolor and no DOM-based engine can ever help.

## Privacy

Zero telemetry. No analytics, no accounts, no network calls beyond the stylesheet fetching the
engine already needs to theme a page. The extension requires broad host permissions because a
dark-mode extension that works everywhere realistically needs them — the counterweight is that it
phones nowhere, and you can verify that in this repository.

## Building

```bash
npm ci
npm run build
```

Then load the build output as an unpacked extension at `chrome://extensions` with Developer Mode
enabled.

```bash
npm test              # unit tests
npm run test:purity   # the purity harness
npm run test:e2e      # end-to-end tests
```

Chrome/Chromium (Manifest V3) only. Firefox and Safari are out of scope.

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) — it covers the purity invariant, the minimal-edit rule for
upstream-derived files, and where new subsystems belong. Design decisions live in
[`docs/adr/`](docs/adr/).

## License and attribution

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

This project is a fork of [Dark Reader](https://github.com/darkreader/darkreader), copyright
Dark Reader Ltd., used under the MIT License. It is not affiliated with or endorsed by Dark Reader
Ltd. The code is MIT; the trademark is not, so the Dark Reader name and logo appear nowhere in this
project's branding.

Generic engine improvements are proposed back upstream where they apply.
