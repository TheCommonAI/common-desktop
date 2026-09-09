# Common Desktop

A standalone Electron desktop client using the approved Common design. Windows
is the first priority, macOS supports Apple Silicon and Intel, and Linux packaging
is experimental. The interface has User, Enthusiast, and Developer detail levels.

This app targets **common-network main at 019a5cac063c53736dd289e34cd29c163f847c0c**.
It makes no network-server changes and does not include the additional security
and privacy PR currently under review.

## Run

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
are unsigned development artifacts, not signed public releases.

The source repository is [TheCommonAI/common-desktop](https://github.com/TheCommonAI/common-desktop).
Open its Actions tab to follow the native build jobs and download their artifacts.

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
and the [native acceptance checklist](docs/RELEASING.md). The earlier build session
was lost before its binaries were saved. This deliverable contains recovered,
rechecked source, not those lost Windows/Mac executables. Native execution,
installation, tray, battery and real-inference checks are still required.
