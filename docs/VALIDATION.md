# Validation record — 9 September 2026

The 0.1.0 desktop preview installers were built from commit
`6f99c960f18324bdb175bbf0620d9a1506ac7735` in
[native build run 34414778207](https://github.com/TheCommonAI/common-desktop/actions/runs/34414778207).

- Source checks and automated tests passed on Ubuntu.
- Automated tests and NSIS installer generation passed on Windows.
  The build log confirms `oneClick=true` and `perMachine=false`.
- Automated tests and Apple silicon/Intel DMG and ZIP packaging passed on macOS.
- The release workflow checked executable/DMG file signatures, required both Mac
  architectures, calculated SHA-256 checksums, and published the installers.
- Linux packaging remains experimental and was not run for this release.
- No live public node was registered during these checks.

The [preview release](https://github.com/TheCommonAI/common-desktop/releases/tag/v0.1.0-preview.1)
contains the actual Windows installer and both Mac disk images.

These checks establish automated test and packaging success, not interactive
acceptance. Installation on a fresh Windows or Mac computer, first-run Ollama
setup, tray behaviour, battery/idle policies, startup, uninstall and real-network
inference still need the hands-on checks in [RELEASING.md](RELEASING.md).
Native UI execution and browser preview were blocked in the earlier workspace;
no new visual acceptance pass is claimed. The approved design assets are retained.

The installers are unsigned previews. Publisher signing and Apple notarization
are not configured. Operating-system warnings or launch blocks are possible.

No changes were made to common-network or its pending security PR.

## Mac signature repair — 11 September 2026

Miles's installed preview.1 failed codesign verification with
"code has no resources but signature indicates they must be present".
The old workflow skipped signing after the Electron bundle was customised.

Build [34575986442](https://github.com/TheCommonAI/common-desktop/actions/runs/34575986442),
commit `c43b5fb1554c7d5eeffb69a88d52c5e4a4e1492c`, explicitly ad-hoc signs the
final Mac app bundles. A new required build step mounts each finished DMG
read-only and runs `codesign --verify --deep --strict --verbose=2` against
Common.app. Both arm64 and x64 apps reported "valid on disk" and
"satisfies its Designated Requirement"; both identify their signature as adhoc.
Automated tests and Windows packaging also passed.

Preview.2 contains these repaired packages. Ad-hoc signing establishes internal
signature consistency, not an authenticated publisher or Apple notarization.
Gatekeeper acceptance and interactive application launch on a downloaded,
quarantined copy still require testing. This does not claim the Mac installation
experience is production-ready.
