# Native acceptance and release

1. Import the source into TheCommonAI/common-desktop, then run Desktop builds.
2. Test the Windows installer on a clean Windows 10 22H2/11 x64 machine first.
3. Test macOS Sonoma or newer on Apple Silicon and Intel. Check installation from
   the DMG and detection of an existing Ollama application.
4. Test model download/cancel/resume, a real local answer, network registration and
   a job through a staging gateway compatible with common-network main at 019a5ca.
5. Test idle/battery pause, concurrency, tunnel recovery, sleep/resume, tray reopen,
   login startup and shutdown/deregistration. Verify no extra worker remains.
6. Test reinstall/uninstall and retention of unrelated Ollama models.
7. Confirm desktop font embedding rights. Add trusted Windows signing and Apple
   Developer ID signing/notarization before public distribution. The workflow
   deliberately disables signing identity discovery for development builds.

No automated test replaces these native checks. Do not call an unsigned build
signed or notarized. Publish corresponding source with released binaries.

References:
- [Electron lifecycle/startup](https://www.electronjs.org/docs/latest/api/app)
- [Power monitoring](https://www.electronjs.org/docs/latest/api/power-monitor)
- [Electron Builder builds](https://www.electron.build/docs/features/github-actions/)
- [Ollama on Windows](https://docs.ollama.com/windows)
- [Ollama on macOS](https://docs.ollama.com/macos)

## 0.2.0 testable client

See [TESTABLE-NETWORK-CLIENT.md](TESTABLE-NETWORK-CLIENT.md) for the coordinated
gateway migration, signing configuration, updater prerequisites and native gates.
`Signed release candidate` builds verified artifacts but deliberately does not
publish them. Unsigned `Desktop builds` artifacts have automatic updates disabled.
Never advertise an unsigned preview as the unattended public release.
