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
