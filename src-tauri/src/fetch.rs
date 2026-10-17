//! The first-run bootstrap: everything the app needs to be a node.
//!
//! This app runs a Python command-line tool and, to contribute, an Ollama beside
//! it. Both have always been prerequisites the user was expected to arrive with:
//! `backend.rs` says so at the top of the file — "the Python toolchain at
//! `~/.common-network` is already installed on any machine that can contribute".
//! This module is the change to that. On first run the app now goes and gets
//! them, checks them, and says plainly what it could and could not do.
//!
//! **The installers stay small.** `tauri.conf.json` carries no `externalBin`, and
//! the only thing under `resources` is the CLI itself — four `.py` files, 272 KB
//! between them, which is the price of a first run that works on a machine which has
//! never had the toolchain. Python and Ollama are a hundred and fifty megabytes
//! between them and are still fetched rather than shipped, for the reason that
//! matters: a payload fetched after the fact can be replaced without cutting a
//! release. The CLI is bundled because it is the one payload that **cannot** be
//! fetched — see below — and because at 272 KB it does not buy anything to defer it.
//!
//! The bundled CLI is a *seed and not a pinned copy*. The first time it runs it
//! replaces itself from the network's `main` branch — its own self-update, which is
//! on by default whenever it is run outside this app — so a fix to the CLI still
//! reaches users without an app release, and nobody is frozen at the version that
//! happened to ship in their installer.
//!
//! What it fetches, and from where:
//!
//! - **Python**, from [`python-build-standalone`][pbs] — a relocatable CPython
//!   per platform, unpacked under `~/.common-network/runtime/python`. Not
//!   python.org's installers, because those want an administrator and a licence
//!   dialog and write to `/Library` or `Program Files`; this one unpacks into a
//!   directory and needs neither. It is a *runtime for the CLI*, never the
//!   system Python — and a Python already on `PATH` is preferred to it, so most
//!   machines never fetch this at all.
//! - **cloudflared**, from Cloudflare's releases, into `~/.common-network/bin` —
//!   the one thing the CLI cannot work without and cannot fetch for itself.
//!   `join.py` refuses to open a tunnel without it, and `backend.rs`'s `cli_env`
//!   has always put `~/.common-network/bin` on the child's `PATH` in the stated
//!   belief that the installer leaves one there. It does not: this app never runs
//!   the CLI's own installer, so on a clean machine the join got all the way to
//!   the tunnel and stopped.
//! - **The Common CLI**, from the bundle rather than from the network, placed into
//!   `~/.common-network` by `backend.rs`'s seed — see the section below for why
//!   the network cannot supply it, and why there is no payload for it here.
//! - **Ollama**, from `ollama/ollama`'s releases, into
//!   `~/.common-network/runtime/ollama` — and **only when there is no Ollama
//!   already**. A machine that has Ollama keeps the one it has; this app is not
//!   in the business of replacing a working install with its own idea of one.
//!
//! [pbs]: https://github.com/astral-sh/python-build-standalone
//!
//! ## Verify, then install. Never the other way round.
//!
//! A download lands in `~/.common-network/.bootstrap/`, is hashed there, and only
//! a digest that matches is unpacked. Nothing is moved into place unverified, and
//! a mismatch deletes the file and reports itself. "curl exited zero" is not the
//! question and is never treated as the answer: a truncated transfer, a captive
//! portal's error page, and an archive swapped for another all exit zero.
//!
//! Two kinds of check, and the difference matters:
//!
//! - [`Checksum::Pinned`] — the digest is compiled in. This is the strong form:
//!   the bytes are tied to this source file, not to whatever the server is
//!   serving today.
//! - [`Checksum::Published`] — a `sha256sum`-style file fetched from the same
//!   release as the payload. This is the weaker form, and it is weaker in a way
//!   worth stating rather than glossing: it is fetched over the same TLS
//!   connection from the same origin, so it proves the transfer is intact and
//!   that the asset is the one that release published — it does **not** defend
//!   against a compromised origin. It is used where the publisher ships
//!   per-release sums and pinning a digest would mean the app went stale the day
//!   the publisher cut a new build.
//!
//! cloudflared is pinned, and pinned per asset, because Cloudflare publishes no
//! sums *file* for it — its digests are a list in the release body, which is not
//! the same thing. Read [`CLOUDFLARED_DIGESTS`] before refreshing those pins: for
//! `2026.10.1` the body's two macOS entries do not match the macOS tarballs the
//! release actually serves, and pinning from the body is how this app would come
//! to refuse every macOS install.
//!
//! ## Why the CLI is bundled and the rest are not
//!
//! **Because there is nothing published to fetch.** A release of
//! `TheCommonAI/common-network` carries no assets — no tarball, no zip, nothing to
//! download. A first run that tried to fetch the CLI would therefore fail on
//! precisely the machine all of this exists for, so the CLI travels inside the
//! installer and is placed by `cli_script` in `backend.rs`, which also decides when
//! the bundle may replace what is already there.
//!
//! There used to be a fourth payload here whose whole purpose was to write down the
//! shape a release would have to publish: the asset names were **invented** rather
//! than observed, and its checksum was an empty pin that fails closed. It has been
//! removed. It could not install anything and never would without a release
//! changing shape underneath it, and a row that is permanently unavailable is a trap
//! for whoever reads the table next — the seed, and the version comparison beside
//! it, are the single source for the CLI.
//!
//! The Python is now genuinely the one used, which is worth stating because it was
//! not always. `cli` in `backend.rs` builds every invocation as `python3 <script>`
//! and takes the interpreter from [`python_for_cli`], so a fetched runtime is reached
//! by naming it rather than by hoping a launcher will consult `PATH` — which the
//! `bin/common` wrapper does not, resolving its interpreter from a hardcoded list of
//! absolute system paths instead.
//!
//! One thing this does not solve, stated where it bites:
//!
//! - **macOS and Windows still will not vouch for any of it.** The app is
//!   ad-hoc signed and the Windows build is unsigned, and none of that is
//!   changed by downloading something at runtime. What *is* true, and is the
//!   reason this approach is less bad than it looks, is that `curl` does not set
//!   the quarantine attribute the way a browser does — so a payload fetched here
//!   is not quarantined, and on macOS Gatekeeper does not refuse it on first
//!   launch the way it refuses a downloaded `.app`. That is a property of `curl`,
//!   not something this file arranges, and it is not a substitute for signing.
//!
//! ## Shape
//!
//! The house rules from `backend.rs` are kept: every network hop is a `curl`
//! subprocess through [`silent`], no dependency is added — including for the
//! digest, which is [`crate::sha256`] — and every command does its blocking work
//! off the main thread. Progress is a [`tauri::ipc::Channel`], the same as
//! `ollama_pull`'s, so the screen can draw a transfer without the webview making
//! a request.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;
use tauri::ipc::Channel;

use crate::sha256;

/* --------------------------- the pinned table --------------------------- */

/// `python-build-standalone`'s release, which is a date rather than a version.
/// Pinned: the tarball for a build is immutable once cut, so a pinned digest
/// stays true, and the alternative — "latest" — is a moving target.
const PBS_BUILD: &str = "20261013";

/// The CPython these builds carry.
const PYTHON_VERSION: &str = "3.12.15";

/// The Ollama whose payloads are named below. Also pinned, for the same reason.
const OLLAMA_VERSION: &str = "0.40.4";

/// The cloudflared whose payloads are named below, and the digest of each.
///
/// Pinned rather than "latest" for the reason every other payload here is: a
/// moving target cannot be verified against a compiled-in digest, and this app
/// verifies before it installs. The cost is the same as the other payloads carry —
/// moving forward is an edit to this file.
const CLOUDFLARED_VERSION: &str = "2026.10.1";

const PBS_BASE: &str = "https://github.com/astral-sh/python-build-standalone/releases/download";
const OLLAMA_BASE: &str = "https://github.com/ollama/ollama/releases/download";
const CLOUDFLARED_BASE: &str = "https://github.com/cloudflare/cloudflared/releases/download";

/// The archive a payload arrives in, which decides how it is unpacked.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Archive {
    /// `.tar.gz` / `.tgz` — `tar -xzf`, which is on every platform this ships to
    /// (Windows 10 and later include bsdtar as `tar.exe`).
    TarGz,
    /// `.zip` — `unzip` on macOS and Linux, PowerShell's `Expand-Archive` on
    /// Windows, which has no `unzip`.
    Zip,
    /// `.tar.zst` — ollama's Linux packaging. Named rather than omitted so the
    /// table is honest about what Linux would need, and blocked everywhere
    /// because nothing this app can call unpacks zstd.
    TarZst,
    /// Nothing at all: the download *is* the program, and it is installed under
    /// the name [`Payload::member`] gives it. cloudflared's Linux and Windows
    /// builds arrive this way, while its macOS builds are a `.tgz` holding the
    /// same single file.
    Raw,
}

/// How a payload's bytes are checked before anything is unpacked.
enum Checksum {
    /// The digest is compiled in. The strong form — see the module header.
    Pinned(&'static str),
    /// A `sha256sum`-style file published beside the payload, looked up by the
    /// payload's file name. The weaker form — see the module header.
    Published(String),
}

/// One thing that can be fetched, and everything needed to do it safely.
struct Payload {
    /// The stable id the web layer names it by. Never shown to anyone.
    id: &'static str,
    /// What the screen calls it, because "cli" is not a sentence.
    label: &'static str,
    /// The version being installed or probed for. Printed.
    version: String,
    /// The file name inside the release. Also the key the published checksum
    /// file is searched for, which is why it is the bare name and not a path.
    asset: String,
    /// Where the bytes come from, or empty when nothing is published.
    url: String,
    checksum: Checksum,
    archive: Archive,
    /// The directory inside the archive holding the thing itself, when the
    /// archive wraps everything in one — `python-build-standalone` does, ollama's
    /// Windows zip does not. `None` means "the archive's contents, as they are".
    ///
    /// For the two shapes that resolve to a single file — [`Archive::Raw`], and a
    /// `.tgz` whose whole contents are the program — this is that file's name
    /// instead, because both the unpacking and the executable bit need to know it.
    member: Option<&'static str>,
    /// Where the payload ends up. For a wrapped archive this is the final path
    /// of the wrapped directory, not its parent.
    dest: PathBuf,
    /// The permission bits the installed file is given, on Unix.
    ///
    /// `None` for everything that is not a program. `Some` is what stops a
    /// fetched cloudflared from being a file the app has to run by naming an
    /// interpreter for it — the download arrives `644` from `curl`, `tar` would
    /// usually carry the mode through for the macOS tarball and cannot be relied
    /// on to, and a tunnel binary without its executable bit fails as a permission
    /// error inside `join.py`, a long way from the cause.
    mode: Option<u32>,
    /// Why it cannot be installed on this machine, when that is known without
    /// asking the network. `Some` means the fetch never starts.
    blocked: Option<String>,
    /// Whether a working one is already here, and what was found. Runs before
    /// anything is downloaded: an existing install always wins.
    probe: fn(&Path) -> Option<String>,
}

/* ------------------------------ the table ------------------------------ */

/// The `(os, arch)` key this machine answers to.
///
/// `std::env::consts` rather than `cfg!` so that the tables below can be selected
/// from, and tested, on any machine — a `cfg!` would make the Linux rows
/// unreachable from a macOS test and therefore never checked.
fn platform_key() -> (&'static str, &'static str) {
    (std::env::consts::OS, std::env::consts::ARCH)
}

/// The `python-build-standalone` triple for a platform, or `None` for one its
/// builds do not cover.
fn pbs_triple(key: (&str, &str)) -> Option<&'static str> {
    match key {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        _ => None,
    }
}

/// The file a Python build arrives in, for a triple.
fn python_asset(triple: &str) -> String {
    format!("cpython-{PYTHON_VERSION}+{PBS_BUILD}-{triple}-install_only.tar.gz")
}

/// Where that file is, for a triple. Pure, so the tests can pin every platform's
/// URL without being on that platform and without touching the network.
fn python_url(triple: &str) -> String {
    format!("{PBS_BASE}/{PBS_BUILD}/{}", python_asset(triple))
}

/// Where the `SHA256SUMS` covering every build in that release is.
fn python_sums_url() -> String {
    format!("{PBS_BASE}/{PBS_BUILD}/SHA256SUMS")
}

/// A row of a payload table: which machine, which file, which container, and
/// which directory inside it. The lifetimes are written out because these are
/// `'static` tables of `'static` strings.
type AssetRow = (
    &'static str,
    &'static str,
    &'static str,
    Archive,
    Option<&'static str>,
);

/// Ollama's payloads, by the machine they are for. Every platform is listed
/// rather than selected by `cfg!` for the reason [`platform_key`] gives.
// `rustfmt` would explode each row to one field per line, because a tuple
// element wider than `short_array_element_width_threshold` forces the whole
// literal vertical. Four rows become thirty lines and the table stops being a
// table. The rows are all inside the line-width limit; this keeps them aligned.
#[rustfmt::skip]
const OLLAMA_ASSETS: &[AssetRow] = &[
    // The macOS app, as a zip holding `Ollama.app`. Not `ollama-darwin.tgz`,
    // which holds the same thing and is also listed by ollama's checksum file —
    // the zip is what ollama's own installer uses, so it is the one whose layout
    // is known.
    ("macos", "aarch64", "Ollama-darwin.zip", Archive::Zip, Some("Ollama.app")),
    ("macos", "x86_64", "Ollama-darwin.zip", Archive::Zip, Some("Ollama.app")),
    ("windows", "x86_64", "ollama-windows-amd64.zip", Archive::Zip, None),
    ("linux", "x86_64", "ollama-linux-amd64.tar.zst", Archive::TarZst, None),
];

/// cloudflared's payloads, by the machine they are for.
///
/// A row names the file each platform arrives in, the container it is in, and the
/// name it is installed under — which is not the asset name on any platform, since
/// the assets carry their platform in the file name and the program does not.
#[rustfmt::skip] // See `OLLAMA_ASSETS`.
const CLOUDFLARED_ASSETS: &[AssetRow] = &[
    ("macos", "aarch64", "cloudflared-darwin-arm64.tgz", Archive::TarGz, Some("cloudflared")),
    ("macos", "x86_64", "cloudflared-darwin-amd64.tgz", Archive::TarGz, Some("cloudflared")),
    ("windows", "x86_64", "cloudflared-windows-amd64.exe", Archive::Raw, Some("cloudflared.exe")),
    ("linux", "x86_64", "cloudflared-linux-amd64", Archive::Raw, Some("cloudflared")),
];

/// The digest of each of those files, which is the pin.
///
/// Read from the release's **asset metadata**, and not from the release body the
/// way it looks like it should be. Cloudflare publishes no sums file, and for
/// `2026.10.1` the body's list is wrong for macOS: it gives
/// `35b7e34c…` for `cloudflared-darwin-arm64.tgz` and `8ccc6383…` for
/// `cloudflared-darwin-amd64.tgz`, while the bytes those URLs serve hash to
/// `647615df…` and `3b0dbaf3…`. The tarballs were re-cut after the body was
/// written. Pinning the body's numbers would have made every macOS install fail
/// with "the download did not match its published checksum", which is a sentence
/// that reads exactly like a corrupted transfer.
///
/// So: refresh these from `gh api repos/cloudflare/cloudflared/releases/tags/<tag>
/// --jq '.assets[] | "\\(.name) \\(.digest)"'`, which reports what the release
/// actually stores, and check the two agree with a download before committing.
/// Linux and Windows currently agree with the body as well; macOS does not.
///
/// Kept beside [`CLOUDFLARED_ASSETS`] rather than inside it only because a
/// 64-character hex literal in every row makes the table stop being a table.
/// `every_cloudflared_asset_has_a_digest_and_every_digest_an_asset` is what keeps
/// the two in step, and [`cloudflared_digest`] answers empty for anything it does
/// not know — which the verifier refuses rather than skips.
#[rustfmt::skip]
const CLOUDFLARED_DIGESTS: &[(&str, &str)] = &[
    ("cloudflared-darwin-arm64.tgz",  "647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc"),
    ("cloudflared-darwin-amd64.tgz",  "3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab"),
    ("cloudflared-windows-amd64.exe", "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6"),
    ("cloudflared-linux-amd64",       "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586"),
];

/// The digest pinned for an asset, or empty when none is.
fn cloudflared_digest(asset: &str) -> &'static str {
    CLOUDFLARED_DIGESTS
        .iter()
        .find(|(name, _)| *name == asset)
        .map(|(_, digest)| *digest)
        .unwrap_or("")
}

/// Where the CLI's files go, which is where its own installers put them —
/// `backend.rs`'s `common_bin()` looks under `~/.common-network/bin` and this
/// must agree with it, or the app would install the CLI somewhere it then does
/// not look.
fn cli_dir(home: &Path) -> PathBuf {
    home.join(".common-network")
}

/// The `bin` directory inside it, which is where `cloudflared` goes.
///
/// The same directory `cli_present` looks in for the launchers, and the one
/// `backend.rs`'s `cli_env` puts on the child's `PATH` — the app and the CLI's own
/// installer agree on this path, and the join only works because they do.
fn bin_dir(home: &Path) -> PathBuf {
    cli_dir(home).join("bin")
}

/// Where the fetched runtimes go. One directory, so that removing the app's
/// additions is removing one directory, and so that a runtime this app installed
/// is never confused with one the user installed.
fn runtime_dir(home: &Path) -> PathBuf {
    home.join(".common-network").join("runtime")
}

/// The `bin` directory a fetched Python's executables land in.
///
/// Read by [`python_for_cli`], which is what the CLI's interpreter is chosen from,
/// and by [`python_present`], which reports the same choice to the user. Not a
/// `PATH` entry: the interpreter is named outright rather than looked up, because
/// the `bin/common` launcher the app used to go through resolves its own Python
/// from a hardcoded list and never consults `PATH` at all.
pub fn runtime_bin_dir(home: &Path) -> PathBuf {
    let python = runtime_dir(home).join("python");
    if cfg!(windows) {
        python
    } else {
        python.join("bin")
    }
}

/// Everything that can be fetched on this machine, in the order it makes sense to
/// do it: the runtime the CLI needs, the tunnel it needs, then the model server.
fn payloads(home: &Path) -> Vec<Payload> {
    let key = platform_key();
    vec![
        python_payload(home, key),
        cloudflared_payload(home, key),
        ollama_payload(home, key),
    ]
}

fn python_payload(home: &Path, key: (&str, &str)) -> Payload {
    let (asset, url, blocked) = match pbs_triple(key) {
        Some(triple) => (python_asset(triple), python_url(triple), None),
        None => (
            format!("cpython-{PYTHON_VERSION}+{PBS_BUILD}-(no build for this machine)"),
            String::new(),
            Some(format!(
                "no Python build is published for {} {}",
                key.0, key.1
            )),
        ),
    };

    Payload {
        id: "python",
        label: "a Python runtime for the command-line tool",
        version: PYTHON_VERSION.to_string(),
        asset,
        url,
        checksum: Checksum::Published(python_sums_url()),
        archive: Archive::TarGz,
        // The tarball wraps everything in a top-level `python/`, which is the
        // layout the live test below installs and then checks.
        member: Some("python"),
        dest: runtime_dir(home).join("python"),
        // An interpreter is run by naming it, so it needs no bit of its own.
        mode: None,
        blocked,
        probe: python_present,
    }
}

fn cloudflared_payload(home: &Path, key: (&str, &str)) -> Payload {
    let named = CLOUDFLARED_ASSETS
        .iter()
        .find(|(os, arch, ..)| (*os, *arch) == key);

    let (asset, url, archive, name, blocked) = match named {
        Some((_, _, asset, archive, member)) => (
            *asset,
            format!("{CLOUDFLARED_BASE}/{CLOUDFLARED_VERSION}/{asset}"),
            *archive,
            member.unwrap_or("cloudflared"),
            None,
        ),
        // No `cfg!` guard here and none needed: the table is the whole answer to
        // "is there a build for this machine", and a machine with no row gets a
        // sentence rather than a download that 404s.
        None => (
            "(no build for this machine)",
            String::new(),
            Archive::Raw,
            "cloudflared",
            Some(format!(
                "no cloudflared build is published for {} {}",
                key.0, key.1
            )),
        ),
    };

    Payload {
        id: "cloudflared",
        label: "the tunnel that lets this machine be reached",
        version: CLOUDFLARED_VERSION.to_string(),
        asset: asset.to_string(),
        url,
        checksum: Checksum::Pinned(cloudflared_digest(asset)),
        archive,
        member: Some(name),
        dest: bin_dir(home),
        mode: Some(0o755),
        blocked,
        probe: cloudflared_present,
    }
}

fn ollama_payload(home: &Path, key: (&str, &str)) -> Payload {
    let named = OLLAMA_ASSETS
        .iter()
        .find(|(os, arch, ..)| (*os, *arch) == key);

    let (asset, url, archive, member, blocked) = match named {
        Some((_, _, asset, archive, member)) => (
            *asset,
            format!("{OLLAMA_BASE}/v{OLLAMA_VERSION}/{asset}"),
            *archive,
            *member,
            // The one platform-specific block that is not about publication.
            // Ollama ships Linux as `.tar.zst` and nothing on a stock machine
            // unpacks zstd — `tar -xzf` refuses it, and the `.tgz` ollama's own
            // installer falls back to is not published for current versions.
            (*archive == Archive::TarZst).then(|| {
                "ollama publishes this platform as a .tar.zst, which needs a zstd \
                 decompressor this app does not ship"
                    .to_string()
            }),
        ),
        None => (
            "(no build for this machine)",
            String::new(),
            Archive::Zip,
            None,
            Some(format!(
                "no Ollama build is published for {} {}",
                key.0, key.1
            )),
        ),
    };

    Payload {
        id: "ollama",
        label: "Ollama",
        version: OLLAMA_VERSION.to_string(),
        asset: asset.to_string(),
        url,
        checksum: Checksum::Published(format!("{OLLAMA_BASE}/v{OLLAMA_VERSION}/sha256sum.txt")),
        archive,
        member,
        // Under the runtime directory, and deliberately not `/Applications`:
        // replacing the user's own Ollama needs an administrator and is not this
        // app's decision to make.
        dest: match member {
            Some(member) => runtime_dir(home).join("ollama").join(member),
            None => runtime_dir(home).join("ollama"),
        },
        mode: None,
        blocked,
        probe: ollama_present,
    }
}

/* --------------------------------- probes -------------------------------- */

/// A `Command` that will not flash a console window on Windows.
///
/// The same twelve lines as `backend.rs`'s `silent`, and duplicated rather than
/// shared: `backend.rs` is being edited elsewhere right now and this module must
/// not touch it. The first thing to do once that settles is to lift `silent`, the
/// home lookup and the `~/.common-network` path helpers into one small module
/// both files use. Until then this is the second copy, and it is written out in
/// full rather than approximated so that a fix to one is obviously a fix to the
/// other.
fn silent(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let cmd = Command::new(program);
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW`.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    cmd
}

/// The version a program reports, or `None` if it will not run at all.
///
/// `stdout` *and* `stderr`, because the programs asked disagree about which
/// stream `--version` goes to and neither is wrong: Python 3 prints to stdout,
/// and some builds have historically printed to stderr. Reading one stream would
/// make "already installed" depend on which.
fn reported_version(program: &str, args: &[&str]) -> Option<String> {
    let out = silent(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The `(major, minor)` in a `Python 3.12.15` line.
///
/// Written out rather than pulled from a crate, and written to fail closed: a
/// line that does not have two numbers in it is not a Python this app can judge,
/// and `None` sends the caller on to install a runtime it can trust.
fn parse_python_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.trim().strip_prefix("Python ")?;
    let mut parts = rest.trim().split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next()?.trim().parse().ok()?;
    Some((major, minor))
}

/// The oldest Python the CLI is run under.
///
/// 3.10, because `common.py` annotates with `dict | None`, which Python evaluates
/// when the `def` is executed and which is a `TypeError` on anything older.
///
/// This said 3.9, with a comment claiming that was the floor the CLI documented. The
/// CLI moved past it and this did not follow, so the app accepted `/usr/bin/python3`
/// — 3.9.6 on a stock macOS, and the `python3` a Finder-launched `.app` finds first,
/// since it inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — and handed it a script
/// that died on its own type annotation before reaching a single line of its own
/// logic. The `bin/common` wrapper has searched for `>= (3, 10)` since the day it was
/// written; this is the app finally agreeing with it.
const MIN_PYTHON: (u32, u32) = (3, 10);

/// Whether a version this app read off a `Python 3.x.y` line is one the CLI can run
/// under.
///
/// Split out so the floor can be tested without an interpreter to hand, and so both
/// callers cannot drift apart on it: one of them decides what the user is told and
/// the other decides what the CLI is actually run with.
fn python_is_supported(version: (u32, u32)) -> bool {
    version.0 == 3 && version >= MIN_PYTHON
}

/// A Python the CLI could run under, on `PATH` or fetched by a previous run.
///
/// The sentence form of [`python_for_cli`]'s answer, and deliberately the same
/// order — see that function for why the two must not diverge.
fn python_present(home: &Path) -> Option<String> {
    // The fetched runtime first: it is the one this app chose and can reason
    // about, and it is the interpreter `python_for_cli` will hand the CLI.
    let fetched = if cfg!(windows) {
        runtime_dir(home).join("python").join("python.exe")
    } else {
        runtime_bin_dir(home).join("python3")
    };
    if fetched.is_file() {
        return Some(format!("the runtime at {}", fetched.display()));
    }

    for name in ["python3", "python"] {
        let Some(text) = reported_version(name, &["--version"]) else {
            continue;
        };
        if let Some(version) = parse_python_version(&text)
            && python_is_supported(version)
        {
            return Some(format!("{name} on PATH ({text})"));
        }
    }
    None
}

/// A Python the CLI can be run under, as a path rather than the sentence
/// [`python_present`] returns.
///
/// The order is deliberately `python_present`'s order — fetched runtime first, then
/// `PATH` — because those two answers have to agree. One of them is shown to the
/// user and the other is what the CLI is actually run under, and a build in which
/// they could disagree would report a runtime it was not using, which is the exact
/// shape of quiet wrongness the rest of this file is written to avoid.
///
/// A bare `python3` comes back as the name and not as a resolved path on purpose:
/// `Command::new` performs the same `PATH` search the shell would, and hand-rolling
/// `which` to hand back a path we already know how to find would be one more copy to
/// keep in sync with the platforms.
pub fn python_for_cli(home: &Path) -> Option<PathBuf> {
    let fetched = if cfg!(windows) {
        runtime_dir(home).join("python").join("python.exe")
    } else {
        runtime_bin_dir(home).join("python3")
    };
    if fetched.is_file() {
        return Some(fetched);
    }

    for name in ["python3", "python"] {
        let Some(text) = reported_version(name, &["--version"]) else {
            continue;
        };
        if let Some(version) = parse_python_version(&text)
            && python_is_supported(version)
        {
            return Some(PathBuf::from(name));
        }
    }
    None
}

// A `common` that is already installed used to be reported from here, by the same
// names and in the same directory `common_names` and `common_bin` in `backend.rs`
// use. It went with the CLI's payload: it was that payload's probe and nothing else
// called it, so what it reported was the state of a fetch that no longer happens.
// Whether a CLI is in place is `cli_script`'s answer, and it is asked on every
// launch rather than reported.

/// A cloudflared that is already here, in either of the two places one can be.
///
/// `~/.common-network/bin` first, because that is where this app installs one and
/// where the CLI's own installer puts one when the user ran that instead; then
/// `PATH`, because `brew install cloudflared` is a perfectly good way to have one
/// and `join.py` looks no further than `shutil.which`. Finding either means the
/// fetch never starts, which is the rule for every payload here: an existing
/// install wins.
fn cloudflared_present(home: &Path) -> Option<String> {
    let local = bin_dir(home).join(cloudflared_name());
    if local.is_file() {
        return Some(format!("cloudflared at {}", local.display()));
    }
    reported_version(cloudflared_name(), &["--version"])
        .map(|text| format!("cloudflared on PATH ({text})"))
}

/// What cloudflared is called on this platform, which is also what the payload
/// installs it as and what the probe looks for.
fn cloudflared_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

/// An Ollama that is already installed, wherever the platform keeps it.
///
/// Checked before anything is downloaded and, when found, the fetch is skipped
/// entirely. This is the "do not clobber" rule at its most important: a user who
/// has Ollama has models in it, and a second copy that the app installed beside
/// it would be a second copy with none of them.
fn ollama_present(home: &Path) -> Option<String> {
    if let Some(text) = reported_version("ollama", &["--version"]) {
        return Some(format!("ollama on PATH ({text})"));
    }

    #[cfg(target_os = "macos")]
    if Path::new("/Applications/Ollama.app").is_dir() {
        return Some("Ollama.app in /Applications".to_string());
    }

    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        let app = PathBuf::from(local)
            .join("Programs")
            .join("Ollama")
            .join("ollama.exe");
        if app.is_file() {
            return Some(format!("Ollama at {}", app.display()));
        }
    }

    // One a previous run of this app fetched.
    let fetched = runtime_dir(home).join("ollama");
    if fetched.exists() {
        return Some(format!("the copy at {}", fetched.display()));
    }

    None
}

/* -------------------------------- the wire -------------------------------- */

/// One message of the bootstrap, on its way to the webview.
///
/// The variants are the states a payload passes through plus the ways it can end
/// without being installed, and the split is the same one `PullEvent` makes:
/// `Present` and `Unavailable` are not failures, they are answers, and the screen
/// says a different sentence for each. `Failed` is the only one that means
/// something went wrong, and its message is written to be a next step.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum BootstrapEvent {
    /// Looking for an existing install, before deciding to download anything.
    Checking { payload: String, label: String },
    /// Already on this machine. Nothing was downloaded and nothing was written.
    Present { payload: String, detail: String },
    /// Nothing to install from, and `message` says why. Not a failure.
    Unavailable { payload: String, message: String },
    /// A transfer is running. `total` is `None` when the server did not say how
    /// large the file is, which is a progress bar with no end rather than a bar
    /// that is wrong.
    Downloading {
        payload: String,
        received: u64,
        total: Option<u64>,
    },
    /// The bytes are in hand and the digest is being checked. Named separately
    /// because on a large payload this is a visible pause, and a pause with no
    /// label reads as a hang.
    Verifying { payload: String },
    /// The digest matched: it is being unpacked into place.
    Installing { payload: String },
    /// It is installed, and `detail` says what.
    Installed { payload: String, detail: String },
    /// It could not be done. `message` is the next step, not a diagnosis.
    Failed { payload: String, message: String },
    /// Every payload has been dealt with. The counts are the summary.
    Done {
        present: u32,
        installed: u32,
        unavailable: u32,
        failed: u32,
    },
}

/// What one payload's turn ended as.
#[derive(PartialEq, Eq, Debug)]
enum Outcome {
    Present,
    Installed,
    Unavailable,
    Failed,
    /// The user stopped it. Not a failure, and not counted as one.
    Stopped,
}

/// What `bootstrap_status` reports about one payload, before anything is done.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadStatus {
    pub payload: String,
    pub label: String,
    pub version: String,
    /// Where it would be fetched from, empty when nothing is published.
    pub url: String,
    /// Whether a working one is already on this machine.
    pub present: bool,
    /// What was found, when `present`.
    pub detail: String,
    /// Whether the app can install it here, and if not, the reason.
    pub blocked: Option<String>,
    /// `"pinned"` or `"published"` — how the bytes would be checked. On the wire
    /// because "we verify it" is a claim the interface should be able to be
    /// specific about.
    pub checksum: String,
}

/// The one bootstrap this process can have running, and the switch that stops it.
///
/// One rather than a map keyed by id, unlike `Pulls`: a pull is per-model and
/// several can be going at once, while a bootstrap is a one-off that installs
/// three things in a row. There is nothing a second concurrent one could mean.
#[derive(Default)]
pub struct Bootstrap {
    /// The `curl` of the transfer in flight, once it has started. Behind a mutex
    /// of its own so that stopping never waits on the thread reading from it.
    child: Mutex<Option<Child>>,
    /// Set by `bootstrap_cancel` *before* it kills, so the transfer loop can tell
    /// a deliberate stop from a `curl` that fell over. Order matters: the reverse
    /// leaves a window where a killed process reads as a failure.
    stopped: AtomicBool,
}

/* ------------------------------- the work ------------------------------- */

/// How often the transfer loop looks at the file to see how far along it is.
/// Fast enough to look like motion, slow enough that the events are not the
/// expensive part of the download.
const PROGRESS_TICK: Duration = Duration::from_millis(200);

/// The scratch directory every download and every unpack lands in.
///
/// Under `~/.common-network`, and therefore on the same filesystem as the
/// destination — which is what makes the final move a `rename` rather than a
/// copy, and a `rename` is what makes the install atomic rather than a window in
/// which a half-unpacked payload is the thing at the destination.
fn staging_dir(home: &Path) -> PathBuf {
    home.join(".common-network").join(".bootstrap")
}

/// Ask the server how large the file is, for the progress bar's denominator.
///
/// Best effort, and deliberately not fatal. A `HEAD` is a second request that
/// some servers answer with something other than the length, and a download that
/// refused to start because the progress bar could not be drawn would be a bad
/// trade. `--location` because release assets redirect; the *last*
/// `content-length` is the one for the final response rather than for a redirect.
fn content_length(url: &str) -> Option<u64> {
    let out = silent("curl")
        .args([
            "--silent",
            "--show-error",
            "--location",
            "--head",
            "--max-time",
            "15",
            url,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let headers = String::from_utf8_lossy(&out.stdout).to_string();
    headers
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<u64>().ok())?
        })
        .next_back()
}

/// The digest `sha256sum` would print for `asset`, out of a file it wrote.
///
/// Three spellings are in the wild and all three are accepted: the bare name,
/// `./name` — which is what ollama writes — and `*name`, which is what
/// `sha256sum --binary` writes. The name is compared on its last path component
/// so that a leading directory does not matter. Lines that are not a digest and a
/// name are skipped rather than refused, so a comment or a blank line does not
/// make the whole file unreadable.
fn digest_for(sums: &str, asset: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(hex), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = name.strip_prefix('*').unwrap_or(name);
        let name = name.rsplit('/').next().unwrap_or(name);
        if name == asset {
            return Some(hex.to_ascii_lowercase());
        }
    }
    None
}

/// Fetch a small text file — a checksum list — into memory.
fn curl_text(url: &str) -> Result<String, String> {
    let out = silent("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            "--max-time",
            "60",
            url,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("couldn't run curl: {e}"))?;
    if !out.status.success() {
        let complaint = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if complaint.is_empty() {
            format!("couldn't fetch the published checksums ({})", out.status)
        } else {
            complaint
        });
    }
    String::from_utf8(out.stdout).map_err(|_| "the published checksums were not text".to_string())
}

/// The digest the payload must have, from whichever source it declares.
fn expected_digest(payload: &Payload) -> Result<String, String> {
    let digest = match &payload.checksum {
        Checksum::Pinned(hex) => hex.to_string(),
        Checksum::Published(url) => {
            let sums = curl_text(url)?;
            digest_for(&sums, &payload.asset).ok_or_else(|| {
                format!(
                    "the published checksums do not list {} — nothing was installed",
                    payload.asset
                )
            })?
        }
    };

    // Fail closed. An empty pin is a payload someone wired up without finishing
    // the job, and installing it unchecked would be worse than refusing it.
    if digest.len() != 64 {
        return Err(
            "no checksum is pinned for this payload, so it cannot be verified \
             — nothing was installed"
                .to_string(),
        );
    }
    Ok(digest)
}

/// Whether the transfer should keep going. `false` means the window is gone.
///
/// Borrowing rather than `'static`, because the caller in `bootstrap_run` closes
/// over a channel it does not own — a `'static` bound here would force that
/// channel to be moved, which is the tail wagging the dog.
type Tell<'a> = dyn FnMut(BootstrapEvent) -> bool + 'a;

/// How a transfer ended, before anything has been checked.
#[derive(PartialEq, Eq, Debug)]
enum Transfer {
    /// The bytes are on disk. Not yet trusted — that is [`ensure`]'s next step.
    Complete,
    /// The user stopped it. Not a failure.
    Stopped,
}

/// Download `url` to `to`, reporting progress, stopping when told to.
///
/// The `curl` is a child held in `state` rather than waited on here, so that
/// `bootstrap_cancel` can find and kill it. This loop therefore *polls* rather
/// than blocks: it watches the file grow for the progress bar and asks
/// `try_wait` whether the transfer is over, and `bootstrap_cancel` — running on
/// another thread — reaches the same child through the mutex.
fn download(
    url: &str,
    to: &Path,
    err: &Path,
    total: Option<u64>,
    id: &str,
    state: &Bootstrap,
    tell: &mut Tell<'_>,
) -> Result<Transfer, String> {
    // `stderr` goes to a file rather than a pipe. A pipe would have to be drained
    // while the child runs or the child would block on a full buffer, and this
    // loop is busy watching the download; a file needs no draining and can be
    // read at the end, when the answer is worth reading.
    let complaints = std::fs::File::create(err)
        .map_err(|e| format!("couldn't make room for curl's diagnostics: {e}"))?;

    let child = silent("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            "--connect-timeout",
            "15",
            // Retries the *connection*, which is the ordinary failure a release
            // asset host has. Whether the bytes are usable is not curl's question
            // to answer and is not taken from its exit code either way — the
            // digest decides that.
            "--retry",
            "3",
            "--retry-connrefused",
            "--retry-delay",
            "2",
            "--output",
        ])
        .arg(to)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(complaints))
        .spawn()
        .map_err(|e| format!("couldn't run curl: {e}"))?;

    if let Ok(mut slot) = state.child.lock() {
        *slot = Some(child);
    } else {
        return Err("the bootstrap was poisoned".to_string());
    }

    // Watched until the child is gone or somebody says stop. `cancel` sets the
    // flag *before* it kills, so a dead child found here is told apart from a
    // deliberate stop by the flag and not by the exit status.
    loop {
        if state.stopped.load(Ordering::SeqCst) {
            break;
        }

        let received = std::fs::metadata(to).map(|meta| meta.len()).unwrap_or(0);
        if !tell(BootstrapEvent::Downloading {
            payload: id.to_string(),
            received,
            // Never larger than the file: a server that under-reported the length
            // would otherwise draw a bar past its own end.
            total: total.filter(|total| received <= *total),
        }) {
            break;
        }

        let finished = match state.child.lock() {
            Ok(mut slot) => match slot.as_mut() {
                Some(child) => child.try_wait(),
                // Taken from under us — only `cancel` and the reap below do that,
                // and both mean this loop is done.
                None => break,
            },
            Err(_) => return Err("the bootstrap was poisoned".to_string()),
        };

        match finished {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(PROGRESS_TICK),
            Err(e) => return Err(format!("couldn't wait for curl: {e}")),
        }
    }

    // Reap. When `cancel` has killed it this returns at once rather than waiting
    // out a transfer nobody wants.
    let status = state
        .child
        .lock()
        .map_err(|_| "the bootstrap was poisoned".to_string())?
        .take()
        .map(|mut child| child.wait());

    if state.stopped.load(Ordering::SeqCst) {
        return Ok(Transfer::Stopped);
    }

    match status {
        Some(Ok(status)) if status.success() => Ok(Transfer::Complete),
        Some(Ok(status)) => {
            let mut complaint = String::new();
            let _ = std::fs::File::open(err).and_then(|mut f| f.read_to_string(&mut complaint));
            let complaint = complaint.trim();
            Err(if complaint.is_empty() {
                format!("the download failed ({status})")
            } else {
                complaint.to_string()
            })
        }
        Some(Err(e)) => Err(format!("couldn't wait for curl: {e}")),
        // Nothing was in the slot: `cancel` got there first and the flag above
        // would have caught it, so this is a stop by another name.
        None => Ok(Transfer::Stopped),
    }
}

/// Unpack `payload`'s archive from `file` into `into`, and set the mode it asks for.
///
/// Takes the payload rather than its `Archive` because the two shapes that resolve
/// to one file need its `member` — the name that file is to be known by — and its
/// `mode`. Both are things only the payload knows.
fn extract(payload: &Payload, file: &Path, into: &Path) -> Result<(), String> {
    let run = |mut command: Command| -> Result<(), String> {
        let out = command
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("couldn't unpack the download: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let complaint = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if complaint.is_empty() {
            format!("unpacking the download failed ({})", out.status)
        } else {
            format!("unpacking the download failed: {complaint}")
        })
    };

    match payload.archive {
        Archive::TarGz => {
            let mut command = silent("tar");
            command.arg("-xzf").arg(file).arg("-C").arg(into);
            run(command)?;
        }
        Archive::Zip => {
            if cfg!(windows) {
                let mut command = silent("powershell");
                command
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Expand-Archive",
                    ])
                    .arg("-LiteralPath")
                    .arg(file)
                    .arg("-DestinationPath")
                    .arg(into)
                    .arg("-Force");
                run(command)?;
            } else {
                let mut command = silent("unzip");
                command.arg("-q").arg(file).arg("-d").arg(into);
                run(command)?;
            }
        }
        // Refused rather than attempted: `tar -xzf` on a zstd stream fails with a
        // message about the gzip magic that says nothing about zstd, and the
        // caller has a better sentence for this — see `ollama_payload`.
        Archive::TarZst => {
            return Err(
                "this download is a .tar.zst, which needs a zstd decompressor this app \
                 does not ship"
                    .to_string(),
            );
        }
        // The download is the program. Copied rather than moved, so that the
        // caller's cleanup — which removes the staging file and the unpacked
        // directory together — stays the same shape for every payload.
        Archive::Raw => {
            let name = payload.member.ok_or_else(|| {
                "this payload arrives as a bare file but does not say what to call it".to_string()
            })?;
            std::fs::copy(file, into.join(name))
                .map_err(|e| format!("couldn't put the download in place: {e}"))?;
        }
    }

    // The executable bit, when the payload asks for one. `fs::copy` brings the
    // *source's* mode across on Unix, which for a file `curl` just wrote is `644`
    // — so a raw download has to be given its mode explicitly or the tunnel binary
    // is installed un-runnable. For the tarball the mode is usually already
    // right, since `tar` restores it and Cloudflare's archives carry `755`; this
    // sets it either way rather than trusting an archive to have.
    if let (Some(mode), Some(name)) = (payload.mode, payload.member) {
        set_mode(&into.join(name), mode)?;
    }
    Ok(())
}

/// Give a file permission bits, on the platforms that have them.
///
/// A no-op on Windows, where `mode` means nothing and the extension is what makes
/// a file runnable. Written as a function rather than a `cfg!` at the call site so
/// the Unix path is one line and the Windows path is visibly nothing rather than
/// invisibly skipped.
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(mode);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("couldn't make {} runnable: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

/// Move `source` into `dest`, never over anything that is already there.
///
/// Three shapes, and the source and destination together decide which:
///
/// - `dest` does not exist — the whole of `source` becomes `dest`. This is the
///   ordinary case, and because `source` was unpacked into the staging directory
///   under the same `~/.common-network`, the move is a `rename` within one
///   filesystem: atomic, and never a window in which a half-unpacked payload is
///   what is installed.
/// - `source` is a single file — it lands *inside* `dest`, under the name it
///   already has, and an existing file of that name is left alone. This is
///   cloudflared's case: the destination is `bin`, which holds the CLI's
///   launchers too, and a payload that is one program is placed beside them rather
///   than becoming the directory.
/// - `dest` already exists and `source` is a tree — `source`'s top-level entries
///   are moved into it, and an entry whose name is already taken is **left
///   alone**. This is how a payload merges into `~/.common-network`, which exists
///   as soon as anything of the app's does; merging is the only reading of
///   "install this beside what is already here" that cannot delete somebody's
///   identity or weights.
fn install(source: &Path, dest: &Path) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent to install into", dest.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("couldn't make {}: {e}", parent.display()))?;

    if source.is_file() {
        std::fs::create_dir_all(dest)
            .map_err(|e| format!("couldn't make {}: {e}", dest.display()))?;
        let name = source
            .file_name()
            .ok_or_else(|| format!("{} has no name", source.display()))?;
        let target = dest.join(name);
        if target.exists() {
            return Ok(());
        }
        return std::fs::rename(source, &target)
            .map_err(|e| format!("couldn't move {} into place: {e}", target.display()));
    }

    if !dest.exists() {
        return std::fs::rename(source, dest)
            .map_err(|e| format!("couldn't move the download into {}: {e}", dest.display()));
    }

    let entries = std::fs::read_dir(source)
        .map_err(|e| format!("couldn't read the unpacked download: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("couldn't read the unpacked download: {e}"))?;
        let target = dest.join(entry.file_name());
        if target.exists() {
            continue;
        }
        std::fs::rename(entry.path(), &target)
            .map_err(|e| format!("couldn't move {} into place: {e}", target.display()))?;
    }
    Ok(())
}

/// Do one payload: probe, download, verify, unpack, place.
///
/// Takes a callback rather than a `Channel` so that the whole sequence can be run
/// by a test without a window — the same seam `await_ollama` in `backend.rs`
/// takes its closures for.
fn ensure(home: &Path, payload: &Payload, state: &Bootstrap, tell: &mut Tell<'_>) -> Outcome {
    if !tell(BootstrapEvent::Checking {
        payload: payload.id.to_string(),
        label: payload.label.to_string(),
    }) {
        return Outcome::Stopped;
    }

    // Existing installs win, always, and are checked before the blocked reason:
    // a machine that already has the CLI does not care that none is published.
    if let Some(detail) = (payload.probe)(home) {
        tell(BootstrapEvent::Present {
            payload: payload.id.to_string(),
            detail,
        });
        return Outcome::Present;
    }

    if let Some(reason) = &payload.blocked {
        tell(BootstrapEvent::Unavailable {
            payload: payload.id.to_string(),
            message: reason.clone(),
        });
        return Outcome::Unavailable;
    }

    let staging = staging_dir(home);
    if let Err(e) = std::fs::create_dir_all(&staging) {
        return fail(
            payload,
            tell,
            format!("couldn't make a place to download into: {e}"),
        );
    }

    // A leftover from an interrupted run must never be mistaken for this run's
    // bytes, so the scratch files are removed rather than resumed into.
    let file = staging.join(format!("{}.part", payload.id));
    let err = staging.join(format!("{}.curl-err", payload.id));
    let _ = std::fs::remove_file(&file);

    let total = content_length(&payload.url);
    match download(&payload.url, &file, &err, total, payload.id, state, tell) {
        Ok(Transfer::Stopped) => {
            let _ = std::fs::remove_file(&file);
            return Outcome::Stopped;
        }
        Ok(Transfer::Complete) => {}
        Err(message) => {
            let _ = std::fs::remove_file(&file);
            return fail(payload, tell, message);
        }
    }
    let _ = std::fs::remove_file(&err);

    if !tell(BootstrapEvent::Verifying {
        payload: payload.id.to_string(),
    }) {
        let _ = std::fs::remove_file(&file);
        return Outcome::Stopped;
    }

    let expected = match expected_digest(payload) {
        Ok(expected) => expected,
        Err(message) => {
            let _ = std::fs::remove_file(&file);
            return fail(payload, tell, message);
        }
    };

    let got = match sha256::digest_file(&file) {
        Ok(got) => sha256::hex(&got),
        Err(e) => {
            let _ = std::fs::remove_file(&file);
            return fail(
                payload,
                tell,
                format!("couldn't read the download back: {e}"),
            );
        }
    };

    if got != expected {
        let _ = std::fs::remove_file(&file);
        return fail(
            payload,
            tell,
            format!(
                "the download did not match its published checksum, so it was discarded \
                 and nothing was installed — the transfer was cut short, or the file is \
                 not the one that was published. Trying again is safe. Expected \
                 {expected}, got {got}."
            ),
        );
    }

    if !tell(BootstrapEvent::Installing {
        payload: payload.id.to_string(),
    }) {
        let _ = std::fs::remove_file(&file);
        return Outcome::Stopped;
    }

    // Unpack beside the destination, then move. Only the move touches the
    // destination, and only after the digest has been checked.
    let unpacked = staging.join(format!("{}.unpacked", payload.id));
    let _ = std::fs::remove_dir_all(&unpacked);
    if let Err(e) = std::fs::create_dir_all(&unpacked) {
        let _ = std::fs::remove_file(&file);
        return fail(
            payload,
            tell,
            format!("couldn't make room to unpack into: {e}"),
        );
    }
    if let Err(message) = extract(payload, &file, &unpacked) {
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir_all(&unpacked);
        return fail(payload, tell, message);
    }

    let source = match payload.member {
        Some(member) => unpacked.join(member),
        None => unpacked.clone(),
    };
    if !source.exists() {
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir_all(&unpacked);
        return fail(
            payload,
            tell,
            format!(
                "the download did not contain {} — nothing was installed",
                source.display()
            ),
        );
    }

    // The probe again, immediately before the move. The one at the top ran
    // several minutes and one download ago, and the rule that nothing working is
    // clobbered is worth being certain about rather than almost certain.
    if let Some(detail) = (payload.probe)(home) {
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir_all(&unpacked);
        tell(BootstrapEvent::Present {
            payload: payload.id.to_string(),
            detail,
        });
        return Outcome::Present;
    }

    let placed = install(&source, &payload.dest);
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_dir_all(&unpacked);

    match placed {
        Ok(()) => {
            tell(BootstrapEvent::Installed {
                payload: payload.id.to_string(),
                detail: format!("{} {}", payload.label, payload.version),
            });
            Outcome::Installed
        }
        Err(message) => fail(payload, tell, message),
    }
}

/// Report a failure, and answer with the outcome so callers read as one line.
fn fail(payload: &Payload, tell: &mut Tell<'_>, message: String) -> Outcome {
    tell(BootstrapEvent::Failed {
        payload: payload.id.to_string(),
        message,
    });
    Outcome::Failed
}

/* ------------------------------- commands ------------------------------- */

/// What the bootstrap would do on this machine, without doing any of it.
///
/// No network, no writes, and no downloads — every answer comes from looking at
/// the filesystem and running `--version`. It is what lets the interface say what
/// is missing before the user agrees to anything, which is the difference between
/// a first run that asks and one that starts fetching.
#[tauri::command]
pub async fn bootstrap_status(app: tauri::AppHandle) -> Result<Vec<PayloadStatus>, String> {
    let worker = app.clone();
    off_thread(move || {
        let home = home_of(&worker)?;
        Ok(payloads(&home)
            .iter()
            .map(|payload| {
                let found = (payload.probe)(&home);
                PayloadStatus {
                    payload: payload.id.to_string(),
                    label: payload.label.to_string(),
                    version: payload.version.clone(),
                    url: payload.url.clone(),
                    present: found.is_some(),
                    detail: found.unwrap_or_default(),
                    blocked: payload.blocked.clone(),
                    checksum: match &payload.checksum {
                        Checksum::Pinned(_) => "pinned".to_string(),
                        Checksum::Published(_) => "published".to_string(),
                    },
                }
            })
            .collect())
    })
    .await
}

/// Fetch, verify and install. `only` names one payload for a retry; `None` does
/// all of them in order.
///
/// Never fails the app: a payload that cannot be installed is reported as an event
/// and the next one is attempted, so one broken download does not cost the other
/// two. The `Result` is kept for the failures that are this file's own — a home
/// directory that cannot be found — and not for anything the network did.
#[tauri::command]
pub async fn bootstrap_run(
    app: tauri::AppHandle,
    only: Option<String>,
    on_event: Channel<BootstrapEvent>,
) -> Result<(), String> {
    let worker = app.clone();
    off_thread(move || {
        let home = home_of(&worker)?;
        let wanted = payloads(&home);
        let chosen: Vec<&Payload> = match &only {
            Some(id) => wanted.iter().filter(|p| p.id == id.as_str()).collect(),
            None => wanted.iter().collect(),
        };
        if chosen.is_empty() {
            let name = only.clone().unwrap_or_default();
            return Err(format!("there is no payload called {name:?} to install"));
        }

        // A fresh run clears the previous stop, so a retry after a pause is a
        // retry rather than a no-op that returns instantly.
        let state = worker.state::<Bootstrap>();
        state.stopped.store(false, Ordering::SeqCst);

        let mut tell = |event: BootstrapEvent| on_event.send(event).is_ok();

        let (mut present, mut installed, mut unavailable, mut failed) = (0u32, 0u32, 0u32, 0u32);
        for payload in chosen {
            match ensure(&home, payload, &state, &mut tell) {
                Outcome::Present => present += 1,
                Outcome::Installed => installed += 1,
                Outcome::Unavailable => unavailable += 1,
                Outcome::Failed => failed += 1,
                // A stop ends the run rather than counting. The screen has
                // already drawn the pause, and the next payload is not what the
                // user asked to stop but not what they asked to start either.
                Outcome::Stopped => return Ok(()),
            }
        }

        tell(BootstrapEvent::Done {
            present,
            installed,
            unavailable,
            failed,
        });
        Ok(())
    })
    .await
}

/// Stop the transfer in flight.
///
/// Killing `curl` leaves the partial file behind; `ensure` removes it, so a
/// cancelled bootstrap leaves nothing a later run could mistake for a download
/// that had finished.
#[tauri::command]
pub async fn bootstrap_cancel(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Bootstrap>();
    state.stopped.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = state.child.lock()
        && let Some(child) = slot.as_mut()
    {
        let _ = child.kill();
    }
    Ok(())
}

/* -------------------------------- plumbing -------------------------------- */

/// The home directory, from the app rather than from the environment.
///
/// `backend.rs` reads `HOME`, `USERPROFILE` and `HOMEDRIVE`/`HOMEPATH` by hand,
/// and this does not: Tauri's own resolver already implements the Windows dance,
/// and reaching it through the app handle is both shorter and one fewer copy of a
/// rule that is easy to get subtly wrong. What matters is that both answers are
/// the same directory, since the CLI, the identity and the weights all live under
/// it.
fn home_of(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|e| format!("couldn't find this machine's home directory: {e}"))
}

/// The house `spawn_blocking` wrapper, duplicated from `backend.rs` for the
/// reason [`silent`] is.
async fn off_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the bootstrap panicked: {e}"))?
}

/* --------------------------------- tests --------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// Every form `sha256sum` writes, plus the lines that are not entries.
    ///
    /// This is the parse step the whole "verify before installing" rule rests on,
    /// and its failure mode is the quiet one: a parser that matched nothing would
    /// not install anything wrong, but it would also refuse every good download,
    /// and a parser that matched the *wrong* line would install someone else's
    /// file. Both are worth pinning.
    #[test]
    fn a_checksum_file_is_read_in_every_form_sha256sum_writes() {
        const SUM: &str = "ba32036ad8f4c434d97a1ee7feef8b7edc0fac16777639b97e39c74a108e4440";
        let file = format!(
            "# a comment, and a blank line\n\
             \n\
             {SUM}  ./ollama-darwin.zip\n\
             1111111111111111111111111111111111111111111111111111111111111111 *some-other.zip\n\
             {SUM}  cpython-3.12.15+20261013-aarch64-apple-darwin-install_only.tar.gz\n"
        );

        // `./name` — what ollama writes.
        assert_eq!(digest_for(&file, "ollama-darwin.zip").as_deref(), Some(SUM));
        // `*name` — what `sha256sum --binary` writes.
        assert_eq!(
            digest_for(&file, "some-other.zip").as_deref(),
            Some("1111111111111111111111111111111111111111111111111111111111111111"),
        );
        // The bare name — what python-build-standalone writes.
        assert_eq!(
            digest_for(
                &file,
                "cpython-3.12.15+20261013-aarch64-apple-darwin-install_only.tar.gz"
            )
            .as_deref(),
            Some(SUM),
        );

        // A name that is there but not as a name, and one that is not there at
        // all. Neither may return something plausible.
        assert_eq!(digest_for(&file, "some-other"), None);
        assert_eq!(digest_for(&file, "not-a-payload.zip"), None);
        // A line whose first field is not a digest is not an entry.
        assert_eq!(
            digest_for("nothex  payload.zip\n", "payload.zip"),
            None,
            "a non-digest first field was read as one",
        );
    }

    /// The URL every platform's Python comes from, pinned to the string that was
    /// actually fetched and hashed when this was written. All four are checked on
    /// whichever machine runs the suite, so a typo in any one of them fails here
    /// rather than on the one platform that would have noticed.
    #[test]
    fn the_python_urls_are_the_ones_that_were_verified() {
        assert_eq!(
            python_url("aarch64-apple-darwin"),
            "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/\
             cpython-3.12.15+20261013-aarch64-apple-darwin-install_only.tar.gz",
        );
        assert_eq!(
            python_url("x86_64-apple-darwin"),
            "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/\
             cpython-3.12.15+20261013-x86_64-apple-darwin-install_only.tar.gz",
        );
        assert_eq!(
            python_url("x86_64-pc-windows-msvc"),
            "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/\
             cpython-3.12.15+20261013-x86_64-pc-windows-msvc-install_only.tar.gz",
        );
        assert_eq!(
            python_url("x86_64-unknown-linux-gnu"),
            "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/\
             cpython-3.12.15+20261013-x86_64-unknown-linux-gnu-install_only.tar.gz",
        );

        assert_eq!(
            python_sums_url(),
            "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/\
             SHA256SUMS",
        );
    }

    /// Every platform the app builds for has a row in every table. A platform
    /// with no row is a platform where the fetch is refused for a reason the user
    /// cannot act on, so the rows are checked here rather than discovered there.
    #[test]
    fn every_platform_the_app_ships_to_is_named_in_the_tables() {
        for key in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
            ("linux", "x86_64"),
        ] {
            assert!(pbs_triple(key).is_some(), "no Python build for {key:?}");
            for (table, name) in [
                (OLLAMA_ASSETS, "Ollama"),
                (CLOUDFLARED_ASSETS, "cloudflared"),
            ] {
                assert!(
                    table.iter().any(|(os, arch, ..)| (*os, *arch) == key),
                    "no {name} payload for {key:?}",
                );
            }
        }

        for (os, arch, asset, ..) in OLLAMA_ASSETS.iter().chain(CLOUDFLARED_ASSETS) {
            assert!(
                !asset.is_empty() && !asset.contains('/'),
                "{os}/{arch} names a payload that is not a bare file name: {asset}",
            );
        }
    }

    /// Every cloudflared asset has a digest and every digest an asset.
    ///
    /// They are two tables, so they could drift — and one direction of that drift
    /// is the dangerous one. An asset with no digest still fetches, and then fails
    /// verification, on a machine that had one working before this changed. This
    /// is the check that makes the split safe rather than merely tidy.
    #[test]
    fn every_cloudflared_asset_has_a_digest_and_every_digest_an_asset() {
        for (os, arch, asset, ..) in CLOUDFLARED_ASSETS {
            let digest = cloudflared_digest(asset);
            assert_eq!(
                digest.len(),
                64,
                "{os}/{arch} ({asset}) has no usable pinned digest",
            );
            assert!(
                digest.chars().all(|c| c.is_ascii_hexdigit()),
                "{os}/{arch} ({asset}) has a digest that is not hex: {digest}",
            );
        }
        for (asset, _) in CLOUDFLARED_DIGESTS {
            assert!(
                CLOUDFLARED_ASSETS.iter().any(|(_, _, a, ..)| a == asset),
                "{asset} is pinned but no platform installs it",
            );
        }
        // And the direction that must fail closed rather than quietly: an asset
        // nobody pinned gets nothing, which is what `expected_digest` refuses on.
        assert_eq!(cloudflared_digest("cloudflared-darwin-amd64-2020.tgz"), "");
    }

    /// The guard that makes an unfinished table entry fail closed.
    ///
    /// Every pinned payload in the table has a digest today. The one that does not
    /// is the case a future asset added without its digest would land in — and the
    /// verifier must refuse rather than install whatever arrived.
    #[test]
    fn an_empty_pinned_checksum_is_refused_rather_than_skipped() {
        let home = Path::new("/nonexistent-home-for-a-test");
        let payload = cloudflared_payload(home, ("macos", "aarch64"));
        assert!(matches!(payload.checksum, Checksum::Pinned(d) if d.len() == 64));

        // A payload whose pin is empty — the state an unfinished row is in.
        let unfinished = Payload {
            checksum: Checksum::Pinned(""),
            ..cloudflared_payload(home, ("macos", "aarch64"))
        };
        assert!(
            expected_digest(&unfinished).is_err(),
            "an empty pinned checksum was accepted",
        );
    }

    /// A payload that arrives as a bare executable is installed as one, runnable.
    ///
    /// Two things are checked and they are the two that would break silently: that
    /// the file lands *in* `bin` under the name the payload gave it rather than
    /// becoming `bin` itself, and that it comes out executable — `fs::copy` brings
    /// `644` across from a fresh download, and an un-runnable tunnel binary fails
    /// inside `join.py`, a long way from here.
    #[test]
    fn a_raw_payload_lands_in_the_directory_and_is_made_runnable() {
        let root = std::env::temp_dir().join("common-bootstrap-raw");
        let _ = std::fs::remove_dir_all(&root);

        let home = root.join("home");
        std::fs::create_dir_all(&home).expect("a scratch home");
        // The Linux row on purpose, whichever machine this runs on: it is a bare
        // executable, and the point of the test is the shape rather than the
        // platform. Taking the running platform's row would test the tarball on a
        // Mac the way the tarball test already does.
        let payload = cloudflared_payload(&home, ("linux", "x86_64"));
        assert_eq!(
            payload.archive,
            Archive::Raw,
            "the Linux build changed shape"
        );

        // Stand in for the download: a file in the staging directory named the way
        // `ensure` names its scratch files.
        let staging = staging_dir(&home);
        std::fs::create_dir_all(&staging).expect("a staging directory");
        let downloaded = staging.join("cloudflared.part");
        std::fs::write(&downloaded, b"#!/bin/sh\n").expect("a downloaded file");

        // The digest is what `ensure` checks before this point; the file's shape is
        // what is under test, so the pin is bypassed the same way a passing
        // verification leaves things.
        let unpacked = staging.join("cloudflared.unpacked");
        std::fs::create_dir_all(&unpacked).expect("a place to unpack");
        extract(&payload, &downloaded, &unpacked).expect("the raw payload unpacks");

        let name = payload.member.expect("a raw payload names its file");
        let staged = unpacked.join(name);
        assert!(staged.is_file(), "the download did not become {name}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&staged)
                .expect("the staged file")
                .permissions()
                .mode();
            assert_eq!(
                mode & 0o111,
                0o111,
                "the staged payload was not made executable: {mode:o}",
            );
        }

        // And the move: into `bin`, beside whatever else is there, under its name.
        std::fs::create_dir_all(bin_dir(&home)).expect("a bin directory");
        std::fs::write(bin_dir(&home).join("common"), b"a launcher").expect("something to keep");
        install(&staged, &payload.dest).expect("the move into bin");

        assert!(
            bin_dir(&home).join(name).is_file(),
            "cloudflared is not in bin after the move",
        );
        assert!(
            bin_dir(&home).join("common").is_file(),
            "the raw payload's move removed the launcher beside it",
        );
        // The one thing that must never be true: `bin` replaced by the file.
        assert!(bin_dir(&home).is_dir(), "bin stopped being a directory");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The macOS tarball is a `.tgz` holding the same single file, so the second
    /// shape reaches the same place by a different route.
    #[test]
    fn a_single_file_archive_installs_the_same_way_as_a_raw_one() {
        let root = std::env::temp_dir().join("common-bootstrap-tgz");
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        std::fs::create_dir_all(&home).expect("a scratch home");

        let payload = cloudflared_payload(&home, ("macos", "aarch64"));
        assert_eq!(
            payload.archive,
            Archive::TarGz,
            "the macOS build changed shape"
        );

        // `tar` is the unpacker here and building a real archive would test `tar`
        // rather than this file, so the layout the tarball produces is staged
        // directly: one file, at the root, under the name the payload expects.
        let unpacked = root.join("unpacked");
        std::fs::create_dir_all(&unpacked).expect("a place to unpack");
        let name = payload.member.expect("a named file");
        std::fs::write(unpacked.join(name), b"#!/bin/sh\n").expect("the archive's contents");

        set_mode(&unpacked.join(name), payload.mode.expect("a mode")).expect("set the mode");
        std::fs::create_dir_all(&payload.dest).expect("a bin directory");
        install(&unpacked.join(name), &payload.dest).expect("the move into bin");
        assert!(
            payload.dest.join(name).is_file(),
            "the tarball's file is not in bin"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The version parse, including the shapes that must not be read as a usable
    /// Python.
    #[test]
    fn a_python_version_is_read_only_from_a_python_version_line() {
        assert_eq!(parse_python_version("Python 3.12.15"), Some((3, 12)));
        assert_eq!(parse_python_version("Python 3.9.6\n"), Some((3, 9)));
        assert_eq!(parse_python_version("  Python 3.13.0"), Some((3, 13)));
        // Not a version line, or not a version.
        assert_eq!(parse_python_version("python 3.12.15"), None);
        assert_eq!(parse_python_version("Python"), None);
        assert_eq!(parse_python_version(""), None);
        assert_eq!(parse_python_version("Python three.twelve"), None);
    }

    /// Parsing a 3.9 and accepting a 3.9 are two different questions, and the app got
    /// the second one wrong for as long as `common.py` has needed 3.10.
    ///
    /// 3.9 is the case worth naming: it is not an exotic version to refuse, it is
    /// `/usr/bin/python3` on a stock macOS and the first `python3` a Finder-launched
    /// `.app` can see. Refusing it is what sends the lookup on to a runtime that can
    /// actually run the CLI.
    #[test]
    fn a_python_older_than_the_cli_needs_is_refused() {
        assert!(!python_is_supported((3, 9)));
        assert!(!python_is_supported((3, 8)));
        assert!(!python_is_supported((2, 7)));
        assert!(python_is_supported((3, 10)));
        assert!(python_is_supported((3, 14)));
        // A Python 4 is not a Python this app has been taught to reason about, and
        // guessing that it behaves like the last 3 would be the same mistake in the
        // other direction.
        assert!(!python_is_supported((4, 0)));
    }

    /// The move that is allowed to look at an existing destination, pinned on a
    /// throwaway tree: a payload that lands somewhere new is renamed whole, and a
    /// payload that lands beside something already there is merged without
    /// anything being overwritten.
    #[test]
    fn installing_never_replaces_what_is_already_there() {
        let root = std::env::temp_dir().join("common-bootstrap-install");
        let _ = std::fs::remove_dir_all(&root);

        // A destination that does not exist: the whole source becomes it.
        let source = root.join("stage/python");
        std::fs::create_dir_all(source.join("bin")).expect("a staged tree");
        std::fs::write(source.join("bin/python3"), b"runtime").expect("a file");
        install(&source, &root.join("runtime/python")).expect("a fresh install");
        assert!(root.join("runtime/python/bin/python3").is_file());
        assert!(
            !source.exists(),
            "the source should have been moved, not copied",
        );

        // A destination that does exist: entries merge, and the one already there
        // is left exactly as it was.
        let kept = root.join("cli");
        std::fs::create_dir_all(kept.join("identity")).expect("something already there");
        std::fs::write(kept.join("identity/node.json"), b"mine").expect("a file to keep");
        let staged = root.join("stage/cli");
        std::fs::create_dir_all(staged.join("bin")).expect("a staged tree");
        std::fs::write(staged.join("bin/common"), b"cli").expect("a file");
        std::fs::create_dir_all(staged.join("identity")).expect("a colliding entry");
        std::fs::write(staged.join("identity/node.json"), b"theirs")
            .expect("a file that must lose");
        install(&staged, &kept).expect("a merging install");

        assert!(
            kept.join("bin/common").is_file(),
            "the new entry did not land",
        );
        assert_eq!(
            std::fs::read(kept.join("identity/node.json")).expect("read it back"),
            b"mine",
            "an install overwrote a file that was already there",
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The one test that touches the network, and it is ignored by default so
    /// that `cargo test` never depends on GitHub being up.
    ///
    /// It runs the real thing over the real URL into a scratch home: download,
    /// hash, compare against the published `SHA256SUMS`, unpack, move. Run it
    /// with:
    ///
    /// ```text
    /// cargo test -- --ignored --nocapture bootstrap
    /// ```
    ///
    /// It is ~25 MB, and it installs nothing that outlives the test.
    #[test]
    #[ignore = "downloads the Python payload; run with --ignored"]
    fn the_python_payload_downloads_verifies_and_installs() {
        let key = platform_key();
        if pbs_triple(key).is_none() {
            eprintln!("skipped: no Python build is published for {key:?}");
            return;
        }

        let home = std::env::temp_dir().join("common-bootstrap-live");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("a scratch home");

        // The probe is replaced with one that always says "not here", because the
        // machine running this almost certainly has a `python3` on `PATH` — which
        // is the correct reason to skip the download in the app, and would make
        // this test assert nothing at all.
        let mut payload = python_payload(&home, key);
        payload.probe = |_| None;

        let state = Bootstrap::default();
        let mut seen: Vec<String> = Vec::new();
        let outcome = ensure(&home, &payload, &state, &mut |event| {
            seen.push(format!("{event:?}"));
            true
        });

        assert_eq!(outcome, Outcome::Installed, "events: {seen:#?}");
        assert!(
            payload.dest.join("bin").join("python3").is_file()
                || payload.dest.join("python.exe").is_file(),
            "the runtime is not where it was supposed to land: {}",
            payload.dest.display(),
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    /// The same run for cloudflared, and the one that answers whether the pinned
    /// digests are the digests of the bytes those URLs actually serve.
    ///
    /// That question is not academic here. Cloudflare's release body and its release
    /// *assets* disagree about the macOS tarballs for `2026.10.1` — see
    /// [`CLOUDFLARED_DIGESTS`] — and a pin taken from the wrong one of those two
    /// places produces a payload that downloads perfectly and is then refused, which
    /// reads to a user like a corrupted transfer and would be a bug this suite could
    /// not otherwise see.
    ///
    /// The second half is the inverse and is the more important one: with the pin
    /// deliberately wrong, the run must **refuse**, leave nothing in place, and say
    /// so. A verifier that quietly installed on a mismatch would make the whole
    /// table decorative.
    #[test]
    #[ignore = "downloads the cloudflared payload; run with --ignored"]
    fn the_cloudflared_payload_downloads_verifies_and_installs() {
        let key = platform_key();
        let name = {
            let probe = cloudflared_payload(Path::new("/nowhere"), key);
            if probe.blocked.is_some() {
                eprintln!("skipped: no cloudflared build is published for {key:?}");
                return;
            }
            probe.member.expect("a filename")
        };

        // --- the pin as committed: it must install ---
        let home = std::env::temp_dir().join("common-bootstrap-cf");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("a scratch home");

        // Always "not here", because a machine may well have cloudflared on PATH —
        // which is the right reason for the app to skip the download, and would make
        // this assert nothing.
        let mut payload = cloudflared_payload(&home, key);
        payload.probe = |_| None;

        let state = Bootstrap::default();
        let mut seen: Vec<String> = Vec::new();
        let outcome = ensure(&home, &payload, &state, &mut |event| {
            seen.push(format!("{event:?}"));
            true
        });

        assert_eq!(outcome, Outcome::Installed, "events: {seen:#?}");
        let installed = payload.dest.join(name);
        assert!(
            installed.is_file(),
            "cloudflared is not at {}",
            installed.display(),
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&installed)
                .expect("the installed file")
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "it is not executable: {mode:o}");
        }
        // And the probe now finds what was installed, which is what stops the next
        // launch from fetching it again. The real probe, not `payload.probe`, which
        // was replaced above precisely so that this download would happen.
        assert!(
            cloudflared_present(&home).is_some(),
            "the probe does not see the copy that was just installed",
        );
        let _ = std::fs::remove_dir_all(&home);

        // --- the pin wrong: it must refuse, and leave nothing ---
        let home = std::env::temp_dir().join("common-bootstrap-cf-wrong");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("a scratch home");

        let mut wrong = cloudflared_payload(&home, key);
        wrong.probe = |_| None;
        wrong.checksum =
            Checksum::Pinned("0000000000000000000000000000000000000000000000000000000000000000");

        let mut events: Vec<String> = Vec::new();
        let outcome = ensure(&home, &wrong, &state, &mut |event| {
            events.push(format!("{event:?}"));
            true
        });

        assert_eq!(outcome, Outcome::Failed, "events: {events:#?}");
        assert!(
            events
                .iter()
                .any(|e| e.contains("did not match its published checksum")),
            "the refusal did not say what happened: {events:#?}",
        );
        assert!(
            !wrong.dest.join(name).exists(),
            "a payload that failed verification was installed anyway",
        );
        // Nothing left behind that a later run could mistake for a download.
        let leftovers: Vec<_> = std::fs::read_dir(staging_dir(&home))
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok().map(|e| e.file_name()))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "a refused download left scratch files behind: {leftovers:?}",
        );
        let _ = std::fs::remove_dir_all(&home);

        // --- the other shape, against real bytes ---
        //
        // The running platform's row is a tarball on macOS and a bare executable on
        // Windows, and only one of those is ever exercised by the half above — so
        // the Raw shape, which is what Windows users actually get and which cannot
        // be run here at all, is fetched through the Linux row. Nothing tries to
        // *execute* it; what is under test is that a real download of a real bare
        // executable verifies, unpacks into a directory as a file, and comes out
        // runnable.
        let home = std::env::temp_dir().join("common-bootstrap-cf-raw");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("a scratch home");

        let mut raw = cloudflared_payload(&home, ("linux", "x86_64"));
        assert_eq!(raw.archive, Archive::Raw, "the Linux build changed shape");
        raw.probe = |_| None;

        let mut events: Vec<String> = Vec::new();
        let outcome = ensure(&home, &raw, &state, &mut |event| {
            events.push(format!("{event:?}"));
            true
        });
        assert_eq!(outcome, Outcome::Installed, "events: {events:#?}");
        let raw_name = raw.member.expect("a filename");
        assert_eq!(
            raw_name, "cloudflared",
            "it is not installed under its name"
        );
        assert!(
            raw.dest.join(raw_name).is_file(),
            "the raw payload did not land in bin",
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(raw.dest.join(raw_name))
                .expect("the installed file")
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "it is not executable: {mode:o}");
        }

        let _ = std::fs::remove_dir_all(&home);
    }
}
