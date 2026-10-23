# Third-party notices

Common Desktop itself is AGPL-3.0-or-later, matching the network it talks to.
See [LICENSE](LICENSE).

Common Desktop is a client. It does not implement the worker protocol; it runs
the `common` command-line tool, which is part of common-network and is licensed
with it. Everything below ships inside this application, except the last section,
which deliberately does not.

## Fonts

Four faces are embedded in the interface, and they do not share a licence.

**`display.woff2` and `annotation.woff2` — the supplied Wild Pines Park and
Notemakers Mark faces.** These come from the approved Common website prototype
and are **not** relicensed under AGPL. Their licence has not been established
for desktop embedding. **Before any public desktop release, either confirm
Common's existing licences for these faces cover embedding them in a
distributed application, or replace the WOFF2 files and the two `@font-face`
rules that name them.** System-font fallbacks are present, so removing them
degrades the typography rather than the interface.

**`plain.woff2` and `plain-italic.woff2` — Inter,** by Rasmus Andersson, under
the SIL Open Font License 1.1. Inter's licence text must ship alongside these
files; it is not yet included here.

**`KaTeX_*.woff2` / `KaTeX_*.ttf`,** the fonts KaTeX renders mathematics with,
under the SIL Open Font License 1.1. Their licence text must ship alongside
them; it is not yet included here.

## JavaScript

Bundled into the rendered interface:

| package | licence |
| --- | --- |
| React, ReactDOM | MIT |
| markdown-it | MIT |
| KaTeX | MIT |
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-opener` | MIT OR Apache-2.0 |

Development-only dependencies — Vite, TypeScript, the Tauri CLI — are not
distributed and their licences arrive with their packages.

## Rust

The Tauri framework and the Rust crate graph it links are statically compiled
into the binary, under MIT or Apache-2.0 licences. `src-tauri/Cargo.lock` pins
the exact set, and `cargo metadata` or `cargo license` enumerates their terms.

## Bundled

**The Common CLI** is part of
[common-network](https://github.com/TheCommonAI/common-network) and is licensed
with it, under AGPL-3.0-or-later — the same terms as this application, so it is
redistributed here under that licence rather than a separate grant. The network's
own `NOTICE` travels with it, at `src-tauri/cli-seed/NOTICE`.

It is five Python files — `common.py`, `join.py`, `worker.py`, `runtime.py` and
`chat.py`, 350 KB together — carried under the `resources` key in
`src-tauri/tauri.conf.json` and
copied into `~/.common-network` on first run, and only when nothing is there
already. It ships rather than being fetched because common-network publishes no
release carrying a downloadable build, so there is nothing for a first run to
fetch. The copy placed is a starting point rather than a pinned version: the CLI
updates itself from the network's `main` branch the first time it is run outside
this application.

## Downloaded separately

None of the following ships inside this application. Each is fetched on first run
by `src-tauri/src/fetch.rs` — or found already installed, in which case nothing is
fetched at all — and each stays under its own distributor's licence. The only
entry under `resources` is the CLI above, and there is no `externalBin`, so nothing
in this section is redistributed by Common Desktop.

**CPython**, from the
[python-build-standalone](https://github.com/astral-sh/python-build-standalone)
project, under the Python Software Foundation Licence 2.0. It is fetched only when
no Python 3.9 or newer is already on `PATH`, and it unpacks under
`~/.common-network/runtime/python`. The PSF licence text travels with the
downloaded runtime rather than with this application.
