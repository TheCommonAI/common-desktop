# Common

Common is a client for a decentralised network that runs one large model across
the machines people already own. No single computer holds the model: each holds a
slice of its layers, passes the work to the next, and the answer is the whole
network's. A machine that can't run the model alone can still be one slice of it,
and the more machines there are, the more it can carry. This app is both halves of
that: it makes your computer one of the slices, and it lets you talk to the whole.

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
  `Common_0.3.0_x64-setup.exe`; `publish-preview.yml` renames them to the three
  above, and that workflow is the only place that does.
- **the release is published as a full release, not a prerelease.**
  `/releases/latest/download/<file>` resolves only to the newest
  *non-prerelease* release and 404s otherwise.
- **the app's own updater reads its manifest through the same
  `latest/download/` path**, so a prerelease breaks the website and every
  installed copy at the same moment.

## What it does

**Joining** is one step and sets itself up. The app reads this computer, tells you
plainly whether it can serve part of the model (an Apple silicon Mac or an NVIDIA
graphics card with enough memory), and then runs the network's own peer,
`common join --network --api`. The peer prepares its runtime, downloads only the
layers it will serve, opens its own connection (nothing to forward on a router) and
announces itself to the others. The app shows what it is doing while it works: real
download progress, which layers are yours, how many other machines are online and
whether every part of the model has somebody serving it.

**Chat** goes to that same peer on this computer, which sends the question through
the layers held across the network and streams the answer back word by word. If a
computer drops out mid-answer another takes its place and the answer carries on. If
there aren't enough machines online yet, chat says so rather than guessing.

**Settings** shows the peer's own account of itself (state, layers, address, who
else is online), the address a friend can join through, and a Leave / Rejoin
control. Leaving tells the other machines you are going, so nobody sends you work.
You can also choose to contribute only when plugged in, and to rest overnight; the
app holds itself to those by stopping and starting the peer, because the network
has no throttle to turn. There is no "how much of the processor" setting for that
reason.

The network is open: a peer's address is public, and the machines serving the other
layers see the activations passing through them, which reveal a lot about the text.
Don't put anything private on it.

## Requirements

- **macOS** 10.15 or newer, **Windows** 10 or newer. Linux packaging is
  experimental and not published.
- The `common` command-line tool, a version that knows `join --network` (the layer
  network). The app runs it rather than reimplementing it, and tells you if the
  installed one is too old. The app looks in `~/.common-network/bin` before `PATH`,
  and `COMMON_BIN` overrides both.
- An Apple silicon Mac, or a Windows or Linux PC with an NVIDIA graphics card. The
  Windows/NVIDIA path is written but has not been run on real hardware yet.
- A few gigabytes of free disk for your share of the model, once.
- Nothing else: no Ollama, no Python to install by hand. The peer sets up its own
  runtime the first time.

Two of the three things the app needs from outside itself are **fetched on first
run**, not shipped inside the installer. That is what keeps the download a few
megabytes, and it means a payload can be replaced without cutting a release of
the app. Each is downloaded to a scratch directory, checked against a published
checksum or one compiled into the app, and only then unpacked; a download that
does not match is deleted and reported, never installed. **Anything already on the
machine wins** — nothing is fetched over a working install.

- **The `common` command-line tool**, which the app runs rather than
  reimplementing. It **ships inside the installer** — six Python files, about 431 KB —
  because the network publishes no release carrying a downloadable build, so there
  is nothing for a first run to fetch. It is a *seed* and not a pinned copy: the
  first time it runs it updates itself from the network's `main` branch, so a fix to
  the CLI reaches you without a new release of this app. An install under
  `~/.common-network` is only replaced by a *newer* bundled version, never by an older one, and `COMMON_BIN`
  overrides everything.
- **Python**, but only when there is no `python3` 3.9 or newer on `PATH`: a
  relocatable runtime from
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone),
  unpacked under `~/.common-network/runtime/python`. Never the system Python, and
  never over one.
- **cloudflared**, the tunnel the CLI opens so this machine can be reached, and
  the one thing it cannot fetch for itself. It comes from
  [Cloudflare's releases](https://github.com/cloudflare/cloudflared/releases),
  unpacked into `~/.common-network/bin`. A machine that already has one, there or
  on `PATH`, keeps the copy it has.

The app runs the CLI by naming the interpreter and the script — `python3
common.py` — rather than through the `bin/common` launcher beside it. That is what
lets a Python this app fetched actually be the Python the CLI runs under; the
launcher resolves its own interpreter and does not consult `PATH`.

Only the CLI is bundled, and it is AGPL-3.0-or-later, the same licence as this app.
Python and cloudflared stay with their distributors — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Building from source

Node 24, Rust stable, and whichever platform toolchain
[Tauri lists](https://tauri.app/start/prerequisites/) for your system.

```sh
npm ci
npm run tauri dev      # Vite on :1420, in the app shell
npm run dev            # just the page, in a browser, with a scripted peer
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
| `src-tauri/src/fetch.rs` | first run: fetch, check and install Python and cloudflared |
| `src-tauri/src/sha256.rs` | the digest that check is made with, written out rather than pulled in |
| `src-tauri/cli-seed/` | the CLI itself, shipped — placed once, then it keeps itself current |
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

## Looking at the screens without the app

`npm run dev` serves the page in a browser with a scripted stand-in for the peer,
so every state can be looked at on purpose. Add `?peer=` to pick one: nothing for
the whole arrival (about twenty seconds), `up`, `lonely` (chat answers "not enough
peers"), `crash`, `old-cli` and `error`. Add `?hardware=` to pick the machine:
`small`, `nvidia`, `none` or `fail`.

## Tests

`cargo test` in `src-tauri` covers the status-file validation and crash detection,
the credential scrub, the chunked-stream decoder and the conversation store.
