# Testable Network Client — 0.2.0

This is a coordinated desktop/gateway change. Deploy the companion gateway branch
and migration **010_client_observability.sql before distributing this client**.
Older gateways cannot acknowledge reports or perform the authenticated worker probe;
the desktop deliberately does not turn an unsupported check into “ready”.

## Scope delivered

| Request | Implementation |
| --- | --- |
| 1 Feedback | Sidebar, settings and error entry points; feedback/problem forms, categories, rating, optional contact, optional sanitised attachment; server acknowledgment and report ID. No success message for an unacknowledged report. |
| 2 Local events | Structured allowlisted events; latest 1,000 events / seven days, latest 200 activity rows / seven days. |
| 3 Telemetry | Off by default; explicit explanation and setting; random installation ID, broad hardware and operational data; bounded in-memory queue and backoff; turning off clears and aborts pending delivery. |
| 4 Error codes | Stable classifications, fixed user messages and in-memory cause chains; only safe cause types/codes leave memory. |
| 5 Setup test | Sequential live stages, real synthetic local/network inference, exact failed stage, diagnostic actions. Chat-only skips unneeded contributor stages. |
| 6 Connection health | Independent gateway, Ollama, model, helper, registration, worker and contribution state; no binary “network reachable” success claim. |
| 7 Recovery | Exponential backoff with jitter, provider cooldown, gateway ownership checks, expired-registration recovery, helper loss, model inventory change, power/sleep reconciliation. |
| 8 Quiet startup | Restores saved contribution policy, hidden login launch, tray fallback, startup chat-path check and contributor checks. |
| 9 Tray | State/model, open, pause/resume, test, diagnostics, retry, settings, quit; attention icon and notification. |
| 10–11 Performance | Content-free timing/usage extraction in chat and worker; user receipt, enthusiast timing and developer breakdown. Actual queue delay and internal inference start remain unavailable. |
| 12–13 Contribution | Persistent session/today/all-time counters and sampled uptime/contribution time; bounded local job history without content. |
| 14–15 Diagnostics | Human-readable sections, suggestions, retry/start/download actions, JSON, copy and export. |
| 16 Model health | Tiny synthetic inference before advertising a model; keyed by selected tag/digest, invalidated by disappearance or failed jobs. |
| 17 Startup check | Saved chat path tested quietly; contributors checked before advertising. Deleted models and missing helpers cannot appear ready. |
| 18–19 Onboarding | Completion requires a successful path test; step/preferences/downloads persist; failed/cancelled setup stays incomplete. |
| 20 Recommendations | Memory-based labels, explicit unknown GPU compatibility, no predicted exact speed. |
| 21 Benchmark | Optional standard synthetic inference; stored TTFT and measured rate. |
| 22 Presets | Light: idle + AC + one job. Balanced: AC + one job. Maximum: battery allowed + two jobs. No claimed CPU/GPU throttling. |
| 23 Crashes | Main error hooks, renderer failure hooks, interrupted-run marker; next-launch report prompt and consented crash event. |
| 24 Updates | Periodic checks and explicit download/install using electron-updater. Disabled for unsigned builds; fixed repository, no downgrade/prerelease channel, OS publisher verification. |
| 25 Build identity | Runtime application version; packaged source commit stamped by build workflows. |
| 26 Signing | Separate signed candidate workflow with required secrets, force-signing and platform verification. Actual certificates remain an operator prerequisite. |
| 27 Credentials | Electron safeStorage (DPAPI/Keychain; secure Linux backend when available), encrypted file, atomic legacy settings migration, no basic_text/plaintext fallback. |
| 28 Sanitisation | One allowlisted desktop boundary for events, exported diagnostics, telemetry, report attachments and crashes; independent server allowlist. |
| 29 Overview | Gateway counts healthy contributors/endpoints seen within 90 seconds. Busy count is omitted because no reliable aggregate exists. |
| 30 Tests | Failure-focused local HTTP, service, persistence, privacy and renderer tests; companion gateway route/security tests. Native unattended acceptance remains a release gate. |

## Privacy and retention

The installation UUID is pseudonymous and links sessions; it is not a guarantee of
anonymity. A gateway necessarily sees a transport IP. Operators must configure
proxy/access logs accordingly. Custom model names are replaced by `custom-model`;
diagnostic node identity is installation-salted. Exact CPU names and OS account
names are never in exported/central diagnostics. Known numeric timing and usage
fields are allowed; arbitrary strings, stack text and process logs are not.

Written feedback/contact is explicitly supplied by the user and is separate from
automatic diagnostics. The UI warns against including private conversations or
credentials. Telemetry is retained for 30 days (plus at most one hourly pruning
interval), reports for 90 days (plus the pruning interval). Intake also caps row
counts. Only authenticated operator endpoints expose either dataset.

Changing gateways turns telemetry off so sharing with a new operator requires
a fresh opt-in. Temporary policy/manual pauses mark the node unavailable but
retain its credential; quitting deregisters it. This avoids losing network-chat
access just because the user returns from idle.

Telemetry only queues events created while enabled. Events queued offline are
memory-only and capped at 200; a crash/outage can lose unsent events. A previous
unclean exit is reported on next launch if consent remains enabled. This is not
an exact accounting or billing system. Sampled contribution time excludes long
sleep gaps. Token totals include only counts reported by the provider. Streaming
rate uses observed output time when engine duration is unavailable; network TTFT
includes routing and transport. Unknown internal queue/start times stay null.

## Credential migration

Legacy settings secrets are encrypted before settings.json is replaced. If the OS
store is unavailable, migration fails closed and preserves the original file for
recovery. The desktop imports a matching legacy CLI identity into its encrypted
store, then removes that plaintext identity. It no longer writes fresh plaintext
credentials for the CLI. The CLI must reauthenticate independently until it gains
compatible secure storage. Existing third-party backups are outside the app's control.

## Rollout order and remaining gates

1. Back up the gateway database; apply migrations with `python -m app.migrate`.
2. Deploy gateway code and set `ADMIN_TOKEN` for operator access. Confirm
   `/network/overview`, `/client/reports`, `/client/telemetry` and authenticated
   `/nodes/{id}/health` on staging. Disable request-body logging for intake.
3. Configure the `signed-releases` GitHub environment and the secrets/variables
   listed in `signed-build.yml`. Obtain Windows signing and Apple Developer ID
   certificates; this change does not create or purchase them.
4. Build signed candidates. Test installation, Keychain/DPAPI migration, tray,
   login startup, sleep/wake, network switching, a real model and public tunnel on
   both Windows and macOS. Test a genuine signed version-to-version update.
5. Publish verified installer and update metadata together in a stable GitHub
   release only after those checks. Keep unsigned builds in the preview channel;
   the updater does not consume preview releases.
6. Run the ten-person unattended pilot; review private report/telemetry endpoints
   and follow up only where the tester voluntarily supplied contact details.

Automated tests do not establish that the public gateway is deployed, that a
certificate exists, or that the ten-person acceptance criterion has been met.
