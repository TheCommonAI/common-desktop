# Releasing Common, and how updates reach people who already have it

Two things ship from this repository, and they are not the same thing:

- **Installers**, for someone who does not have Common yet. The website links
  straight at these.
- **An update manifest**, `latest.json`, for copies that are already installed and
  ask GitHub whether there is anything newer.

They share one release, one tag, and one set of artifacts. Getting either wrong is
recoverable; getting the manifest wrong is not obvious, because an app that cannot
read the manifest reports "couldn't reach the release feed" — the same thing it says
when it is offline. See *Traps* at the bottom before cutting a release.

## The version is in three places and they must agree

| file | field |
|---|---|
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `version` |
| `src-tauri/tauri.conf.json` | `version` |

`scripts/check-version.mjs` fails the build when they disagree, and when the tag
being pushed disagrees with all three. The updater compares semver against the
version compiled into the running binary, so a release whose tag says `v0.3.0`
while the bundle says `0.2.0` produces a manifest that every installed copy will
correctly refuse.

## The signing key

The updater will not install a payload whose signature it cannot verify against the
public key compiled into the app. That public key is in `src-tauri/tauri.conf.json`
under `plugins.updater.pubkey`. The private half is **not in this repository** and
must never be:

```
~/.tauri/common-desktop.key       # private — the only copy that exists
~/.tauri/common-desktop.key.pub  # public  — the value committed in tauri.conf.json
```

**Losing that private key permanently ends automatic updates for every installed
copy.** They hold the matching public key and will refuse anything else, forever.
There is no rotation and no recovery; the only remedy is asking everyone to
download a fresh installer by hand. Back it up somewhere durable before the first
real release, and do not regenerate it casually.

It was made once with:

```sh
npx tauri signer generate -w ~/.tauri/common-desktop.key
```

The key currently in use has an **empty password**. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
must therefore be set to an empty string in CI rather than left unset — the CLI
distinguishes the two.

### The two repository secrets

The repo needs exactly two, and they are its first:

| secret | value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the **contents** of `~/.tauri/common-desktop.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty |

The CLI takes the key material itself, not a path — handing it a path produces
`failed to decode base64 secret key`, because it tries to read the path *as* base64.

## Cutting a release

1. Agree the three version files, commit, push to `main`.
2. Wait for **Desktop builds** to go green. All three jobs — `verify`, `windows`,
   `macos` — must conclude `success`; the publish workflow checks for those three
   names by name and will refuse otherwise.
3. Dispatch **Publish desktop release** with that run's ID and the tag `v0.2.0`.
   It downloads the tested artifacts, renames them to the stable names the website
   links to, generates `SHA256SUMS.txt`, calls `scripts/make-manifest.mjs` to write
   `latest.json`, and publishes it as a **full release, not a prerelease**.

Step 3 is a person, deliberately. The workflow used to publish on any edit to
itself, which meant changing how releases are made shipped one as a side effect.

## The four URLs the website links to

These resolve only against the newest **full** release. `commonai.com.au/join`
hard-codes them, so they must keep working and keep meaning the same thing:

```
/releases/latest/download/Common-win-x64.exe
/releases/latest/download/Common-mac-arm64.dmg
/releases/latest/download/Common-mac-x64.dmg
/releases/latest/download/SHA256SUMS.txt
```

Tauri emits `Common_0.2.0_aarch64.dmg`, `Common_0.2.0_x64.dmg` and
`Common_0.2.0_x64-setup.exe`. The publish workflow renames them to the four above.
Nothing else may be renamed — the website's names are a contract with pages that
are not in this repository.

## What the manifest must look like

`scripts/make-manifest.mjs` writes it, and it is the authority on the shape. The
rules below are read off `tauri-plugin-updater` 2.13.3, `src/updater.rs`, not guessed:

- `version` is semver. The alias `name` is also accepted.
- `notes` is optional. A release body is a reasonable thing to put there.
- `platforms` maps updater target strings to `{ signature, url }`. The lookup tries
  `{os}-{arch}-{bundle_type}` and then falls back to `{os}-{arch}`, so the keys used
  are `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`.
- `signature` is the **contents** of the `.sig` file Tauri wrote — which is itself
  base64 of a minisign block. The file goes in verbatim as a string.

## Traps

**`pub_date` must be strict RFC 3339, or omit it.** The plugin parses it with
`OffsetDateTime::parse(.., Rfc3339)` and a failure fails the *whole manifest*, so a
hand-written date is worse than none. `make-manifest.mjs` refuses anything that is
not exactly `YYYY-MM-DDThh:mm:ssZ` or `YYYY-MM-DD`, and checks the day exists —
because `new Date("2026-02-31")` rolls quietly to 3 March rather than failing, and
`new Date("13 October 2026")` succeeds outright.

**A release published as a prerelease breaks the website and the updater at the
same instant.** Both use `/releases/latest/...`, which skips prereleases. Hence
`--prerelease=false --latest`, and hence the publish workflow refuses preview-style
tags.

**Both macOS architectures produce a `Common.app.tar.gz`**, in their own target
directories. They must be renamed apart or the upload collides, and each needs its
own entry in the manifest — one tarball cannot serve both.

**The Windows `.exe` is the updater payload as well as the installer.** With
`createUpdaterArtifacts: true` the NSIS installer *is* the update bundle, so
`Common-win-x64.exe` is both the website's download and the `windows-x86_64`
payload. There is no separate `.nsis.zip`, and its `.sig` is the signature that goes
in the manifest.

**`npm run tauri dev` never checks for updates.** All three commands no-op under
`tauri::is_dev()`. The only way to exercise the update path is a signed release
build.

## Signing and Gatekeeper

Mac builds are **ad-hoc signed** (`signingIdentity: "-"` in `tauri.conf.json`), not
Developer ID signed and not notarised; Windows is unsigned. The updater verifies
*our* tarball signature, which proves the payload came from us — but Gatekeeper and
SmartScreen know nothing about it and may still object to the replaced bundle on
the next launch. A Developer ID certificate and an Apple notarisation key are the
only real fix, and `signed-build.yml` is where they would go. It is inert today: all
nine of its secrets and variables are absent.
