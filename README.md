# Common

Common is a client for a decentralised network of models running on the machines
people already own. A machine on its own answers everything badly; a network of
ordinary computers, each holding the thing it does well, answers most things
well. That is the whole idea, and the app has one side for each half of it.

**[Download it here.](https://commonai.com.au/join)**

This is a Tauri application — a Rust shell around a web interface — and it
replaces the Electron build this repository used to hold. It is a few megabytes
rather than a hundred and thirty, it starts without spinning up a browser, and
it updates itself.

## Download and install

| Computer | Installer |
| --- | --- |
| Windows 64-bit | [Common-win-x64.exe](https://github.com/TheCommonAI/common-desktop/releases/latest/download/Common-win-x64.exe) |
| Mac with Apple silicon (M-series) | [Common-mac-arm64.dmg](https://github.com/TheCommonAI/common-desktop/releases/latest/download/Common-mac-arm64.dmg) |
| Mac with an Intel processor | [Common-mac-x64.dmg](https://github.com/TheCommonAI/common-desktop/releases/latest/download/Common-mac-x64.dmg) |

Checksums for all three are in
[SHA256SUMS.txt](https://github.com/TheCommonAI/common-desktop/releases/latest/download/SHA256SUMS.txt).
No GitHub sign-in, no extracting a build artifact, and no Node.js, Python or
terminal commands are needed.

**Windows:** open the installer; Common installs for your user and opens.
**Mac:** open the DMG and drag Common to Applications, replacing any older copy.

Three things keep those links working, and each is easy to undo by accident:

- **the installer filenames carry no version.** Tauri names them
  `Common_0.2.0_x64-setup.exe`; `publish-preview.yml` renames them to the three
  above, and that workflow is the only place that does.
- **the release is published as a full release, not a prerelease.**
  `/releases/latest/download/<file>` resolves only to the newest
  *non-prerelease* release and 404s otherwise.
- **the app's own updater reads its manifest through the same
  `latest/download/` path**, so a prerelease breaks the website and every
  installed copy at the same moment.

## What it does

**Chat** asks the network a question. There is no model picker and no local
switch, and both omissions are deliberate: the question goes to the gateway,
which routes it to whichever machine is the best fit for what was actually
asked. The question does leave this computer — that is what routing is — and the
answer says which machine gave it.

**Contribute** reads this computer, asks the network what it is short of, and
downloads and serves the one model that would help. Your model runs here and
answers here. Contributing needs [Ollama](https://ollama.com) and a downloaded
model; the app walks through both, and neither is needed to use Chat.

On first launch, Common shows what it found on this machine, offers the model
the network most needs that this machine can actually run, and says what
serving it will cost in disk and memory before anything is downloaded. Resource
limits are yours to set and can be changed in Settings afterwards, along with
leaving the network, which forgets this machine's key.

## Requirements

- **macOS** 10.15 or newer, **Windows** 10 or newer. Linux packaging is
  experimental and not published.
- The `common` command-line tool. The app runs it rather than reimplementing it.
  It is already installed on any machine that can contribute; otherwise it comes
  from the network's own installer. The app looks in `~/.common-network/bin`
  before `PATH`, and `COMMON_BIN` overrides both.
- For Chat, nothing else. For Contribute, Ollama and a model.

## Building from source

Node 24, Rust stable, and whichever platform toolchain
[Tauri lists](https://tauri.app/start/prerequisites/) for your system.

```sh
npm ci
npm run tauri dev      # Vite on :1420, in the app shell
npm run tauri build    # a bundle in src-tauri/target/release/bundle
```

The gates CI runs, and the ones to run before pushing:

```sh
npm run typecheck
npm run build
node scripts/check-version.mjs
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

`npm run tauri dev` never checks for updates: the three updater commands no-op
outside a release build, so the update path is only exercised by a signed one.

## Releases

[`docs/RELEASING.md`](docs/RELEASING.md) covers the signing key, the repository
secrets, the three version files that have to agree, and the traps that make a
release which looks fine and silently never updates anyone.

The short version: the updater compares the manifest's version against the
version compiled into the copy already installed on someone's machine. A
manifest whose version is wrong produces no error anywhere, and no update
either. `src-tauri/tests/manifest.rs` pins the manifest's shape against the
updater plugin's own parser, which is the check that catches it.

## Layout

| path | what it is |
| --- | --- |
| `src/` | the interface: React, TypeScript, one stylesheet |
| `src/chat/` | the conversation, Settings, the rail, and the calls into Rust |
| `src/onboarding/` | first run: read the machine, offer a model, join |
| `src-tauri/src/backend.rs` | every read of this machine and every call to `common` |
| `src-tauri/src/lib.rs` | the window and the menu-bar icon |
| `src-tauri/src/update.rs` | check, stage, restart — driven from Rust, not the webview |
| `src-tauri/tests/manifest.rs` | the update manifest contract |
| `scripts/` | the version gate, the manifest writer, the icon renderer |
| `docs/` | the release procedure |

The updater is driven from Rust rather than from the webview, which is why
there is no `@tauri-apps/plugin-updater` dependency and no updater capability to
grant.

## Licence

AGPL-3.0-or-later, matching the network it talks to. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
