# Release validation / 发布验证

Date: 2026-09-30. Platform: macOS. Host: DeepSeek Harness 0.2.0-rc.2.

## Build and package

`npm ci`, `npm run check` and `npm pack` passed. The prepack guard checks package exports, bundle patch, README, license and screenshot paths. Home: 21 tests. Reader: 47 tests. RSS: all seven test scripts passed. Counts refer to the corresponding repository only.

## Isolated host

Installed the built tarball into a fresh Web profile with a separate DSH_HOME, without a development-directory symlink. Started the full host and exercised the visible plugin:

Reader: displayed six starter books, opened Tao Te Ching and its chapter navigation.

Screenshots were captured from this environment. No model key was configured; live AI inference was not verified in this pass. Other operating systems, mobile devices, all real-world files and long-running behavior are outside this verification.

## Distribution

PR checks and merge are visible on GitHub. Releases include a prebuilt tarball and SHA256 file. Public download and reinstall evidence is recorded in the Release notes after publication. Topics and prepared marketplace metadata do not mean marketplace acceptance. No marketplace submission or npm publication is claimed.


## v1.0.2 — 2026-10-01

Build, 47 existing tests and the package export/README/license guard passed. Client activation fixtures were synchronized with the existing React DOM portal dependency and the reading-context Remote descriptor.

Installed the prebuilt v1.0.2 tarball into an independent Web profile with separate DSH_HOME and DSH_WORKSPACE directories. The installed package is a pnpm tarball installation, not a link to the source checkout. The composed profile contains the qiaomu-reader-dsh bundle and the full Harness host starts successfully.

In the installed UI: six starter books appeared; Tao Te Ching opened; Pure white was available beside Paper; choosing it made the page and reading header rgb(255,255,255). Selected a three-line passage in chapter three using the mouse, created a pink highlight, clicked it to open the annotation panel, and observed is-focused=true, border=0px, outline=none and box-shadow=none. The host saved theme=white and one highlight in the isolated book state file. See docs/qa/white-borderless-harness.png, which contains only a default test workspace and public-domain book.

Source release preparation covers the prior library and companion UI refinements too. Live AI inference, real user-file imports and other operating systems were not exercised in this release pass. GitHub CI, Release upload and public asset checksum are checked separately at publication time.
