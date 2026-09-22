# Common Desktop

A standalone Electron desktop client using the approved Common design. Windows
is the first priority, macOS supports Apple Silicon and Intel, and Linux packaging
is experimental. The interface has User, Enthusiast, and Developer detail levels.

This app targets **common-network main at 019a5cac063c53736dd289e34cd29c163f847c0c**.
It makes no network-server changes and does not include the additional security
and privacy PR currently under review.

## Download and install

| Computer | Installer |
| --- | --- |
| Windows 64-bit | [Download Common for Windows (.exe)](https://github.com/TheCommonAI/common-desktop/releases/latest/download/Common-win-x64.exe) |
| Mac with Apple silicon (M-series) | [Download Common for Apple silicon (.dmg)](https://github.com/TheCommonAI/common-desktop/releases/latest/download/Common-mac-arm64.dmg) |
| Mac with an Intel processor | [Download Common for Intel Mac (.dmg)](https://github.com/TheCommonAI/common-desktop/releases/latest/download/Common-mac-x64.dmg) |

Checksums for all three are published alongside them in
[SHA256SUMS.txt](https://github.com/TheCommonAI/common-desktop/releases/latest/download/SHA256SUMS.txt).

**Windows:** open the installer; Common installs for your user and opens.
**Mac:** open the DMG and drag Common into Applications, replacing any older
copy. No GitHub sign-in, no extracting a build artifact, and no Node.js, Python
or terminal commands are needed.

> **Maintainers:** these links resolve to the newest release by themselves, and
> the website uses the same three URLs — so neither needs editing when a preview
> is published. Two things keep that true, and both are easy to undo by accident:
> installer filenames carry no version (`artifactName` in package.json), and
> `publish-preview.yml` publishes a full release, because
> `/releases/latest/download/<file>` resolves only to the newest *non-prerelease*
> release and 404s otherwise. The installers are still previews; the release
> title and notes say so, and only GitHub's badge is gone.
>
> This is the third arrangement. Preview.1's links pointed at a pinned Actions
> run and went on serving a build from before the icon changed, which looked like
> a caching bug on every machine that downloaded it; preview.2's named a release
> tag, which was correct but went stale the moment preview.3 existed.

On first launch, choose Chat, Contribute, or Both. Common guides contributors
through Ollama installation and local model downloads. Ollama's installer may
ask for confirmation; models need an internet connection and disk space.

These are **preview installers**. Windows is unsigned; the Mac builds carry
ad-hoc signatures checked inside the final DMGs, but are not Developer ID
signed or Apple-notarized. Windows SmartScreen or macOS Gatekeeper may warn or
block initial launch. Publisher signing, Apple notarization, and hands-on
installation testing remain outstanding.

The DMGs and the .exe are attached to the release itself rather than to a build
artifact behind a sign-in. See the
[current release notes and checksums](https://github.com/TheCommonAI/common-desktop/releases/latest),
or the [releases page](https://github.com/TheCommonAI/common-desktop/releases)
for earlier builds.

## Run from source (developers)

Install Node.js 24 LTS, then:

```sh
npm ci
npm start
```

The packaged app needs neither Node.js nor Python on the user's computer.
The explicit `install-electron` postinstall downloads Electron's pinned runtime.

## Features

- Guided role selection, measured hardware, Ollama setup, model downloads,
  contribution preferences, and connection.
- Windows Ollama installer download/launch; macOS disk-image download/open with
  drag-to-Applications instructions; detection of existing Ollama installations.
- Real model download progress, cancellation/resume, current network catalogue,
  and existing local model selection.
- Local or network chat with streaming, cancellation, conversation reset,
  and private-in-memory chat history for the current window.
- Markdown answers — headings, emphasis, lists, tables, blockquotes, fenced code
  and links — rendered as they stream. No dependency and no HTML from the model:
  every answer is escaped before it is parsed, so markup arrives as text. Links
  are only ever `http`/`https` and open in the system browser, never in-window.
- Native tray, optional startup at login on Windows/macOS, close-to-tray,
  contribution pause/resume, idle/battery policies, and one/two simultaneous jobs.
- App-managed cloudflared helper, baseline authenticated worker, registration,
  tunnel recovery and clean-shutdown deregistration.
- Measured CPU/RAM/disk/model and worker diagnostics. Unsupported statistics are
  labelled unavailable. No simulated metrics in the application.

## Build

```sh
npm run dist:win       # Windows NSIS installer (.exe)
npm run dist:portable  # Windows portable executable
npm run dist:mac       # Apple Silicon and Intel .dmg/.zip
npm run dist:linux     # Experimental Linux AppImage
```

Build Windows installers on Windows and Mac disk images on macOS. Outputs are in
`release/`. The included GitHub Actions workflow builds Windows/macOS by default;
Linux is a manual opt-in. Signing identities are not configured: workflow builds
are unsigned previews, not signed production releases.

The source repository is [TheCommonAI/common-desktop](https://github.com/TheCommonAI/common-desktop).
Use the installer links above to install Common. Actions also retains build artifacts.
The Publish desktop preview workflow can publish a new preview from a successful
Desktop builds run on main; provide the run ID and a new preview tag.

## Network and privacy behaviour

The default gateway is `https://gateway-production-b820.up.railway.app`.
This client uses `/health`, `/catalogue`, `POST /nodes`, `DELETE /nodes/{id}` and
`/v1/chat/completions`, with the existing node/worker token contract. It does not
use proposed APIs from the unmerged security work.

The gateway may require an active contributor token. Chat-only users can add an
existing token in Settings or use local chat. With idle-only contribution, a new
node is registered only after the idle delay; network chat may therefore be
unavailable while waiting or paused. This is the current gateway's access model.

Community messages and history go to the gateway and its selected workers. The
current gateway can retry/compose across contributors. A PC administrator can
inspect ordinary Ollama inference. Common does not control Ollama's own logs.
No confidential-computing, approved-node routing or guaranteed no-retention mode
is claimed. The contribution dashboard does not display incoming content.

Settings and gateway-specific credentials are stored in `settings.json` in
Electron's user-data directory. Credentials are stored locally; protect backups.
A different profile can be selected with `--user-data-dir=/absolute/path`.
Chat history is held in renderer memory and cleared on quit or destination change.

## One machine, one node

The node identity is shared with the terminal client rather than kept privately:
both read and write `~/.common-network/identity.json` in the format `common join`
writes (`gateway`, `name`, `node_id`, `node_token`, `catalogue_id`, `domain_tags`,
`joined_at`). A machine that joined from the terminal keeps its name and its
`node_token` when it opens the app, so `common status` sees the same node, and
chat from the app is authenticated by the token the terminal already holds.
The token is only ever read for the gateway that issued it.

One consequence: `common join` and desktop contribution on the *same machine* at
the same time both register that one name, and each registration overwrites the
other's `endpoint_url`. Run one at a time.

Every gateway request carries `X-Common-Client: common-desktop/<version>` (also
sent as the `User-Agent`), and `POST /nodes` includes the same string as a
`client` field. Local Ollama requests carry neither. This is how an app user is
told apart from a terminal user; gateway `main` at 019a5ca does not yet record
it, so the field is accepted and ignored until the gateway stores it.

## Background operation and uninstall

Ollama controls model memory and GPU scheduling. Common limits community jobs,
not OS memory. Other applications using Ollama share that runtime. Pausing cancels
active community jobs; it does not cancel unrelated personal Ollama sessions.
Counters reset when the worker reconnects.

Close keeps Common in the tray when enabled; Quit ends it and its owned helper
processes. Start at login is optional. Keep a portable executable at a stable
location if enabling startup. Disable startup before removing a portable or Mac
app. The Windows installer removes Common's startup entry on uninstall.
Ollama and models remain installed when Common is removed.

## Verification and release status

```sh
npm run check
npm test
```

Tests use local fixtures and synthetic content. See [validation](docs/VALIDATION.md)
and the [native acceptance checklist](docs/RELEASING.md). The released installers
were built successfully on Windows and macOS from commit
`6f99c960f18324bdb175bbf0620d9a1506ac7735`; automated checks also passed.
Interactive installation, tray, battery and real-inference checks are still required.

### Testable Network Client (0.2.0)

This pass adds verified setup, connection recovery, privacy controls, feedback,
persistent contribution statistics and diagnostics. It requires the companion
gateway observability migration. See [implementation and rollout notes](docs/TESTABLE-NETWORK-CLIENT.md)
for the complete scope, privacy/retention model and remaining native/signing gates.
