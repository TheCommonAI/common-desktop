# Third-party notices

Common Desktop itself is AGPL-3.0-or-later, matching the network it talks to.
See [LICENSE](LICENSE).

Common Desktop is a client. It does not implement the worker protocol; it runs
the `common` command-line tool, which is part of common-network and is licensed
with it. Everything below is what ships inside this application.

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

## Downloaded separately

**Ollama** (MIT) is installed by the user, not bundled, and is fetched from its
own distributor. Model weights are fetched from the network and carry their own
licences, which vary — consult the relevant model's page.
