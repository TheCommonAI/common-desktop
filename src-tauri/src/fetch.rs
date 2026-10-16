//! The first-run bootstrap: the three things the app needs to be a node.
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
//! - **The Common CLI**, from the bundle rather than from the network — see the
//!   section below for why the network cannot supply it. Placed into
//!   `~/.common-network`, the same directory the CLI's own `install.sh` and
//!   `install.ps1` own, and only when nothing is there already.
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
//!   the publisher cut a new build. The CLI's entry is pinned, because a release
//!   of our own is a release we can pin.
//!
//! ## Why the CLI is bundled and the other two are not
//!
//! **Because there is nothing published to fetch.** `TheCommonAI/common-network`
//! has one release, `v0.1.4`, and it carries **zero assets** — no tarball, no zip,
//! nothing to download. A first run that tried to fetch the CLI would therefore fail
//! on precisely the machine all of this exists for, so the CLI travels inside the
//! installer and the fetch's CLI entry is left as the shape a release would have to
//! fill in: [`CLI_ASSETS`] holds the asset names such a release would publish, and
//! they are **invented** — not names observed in the wild — with an empty
//! [`CLI_SHA256`] that fails closed. Nothing on the shipping path consults any of it;
//! `cli_script` in `backend.rs` is what actually places the CLI.
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

const PBS_BASE: &str = "https://github.com/astral-sh/python-build-standalone/releases/download";
const OLLAMA_BASE: &str = "https://github.com/ollama/ollama/releases/download";
const CLI_BASE: &str = "https://github.com/TheCommonAI/common-network/releases/download";

/// The tag of the Common CLI release this app would install from.
///
/// One of the three things to change when a release carries a payload. The tag
/// itself is real — `TheCommonAI/common-network` has this release — but it has no
/// assets, which is what [`CLI_PUBLISHED`] records.
const CLI_TAG: &str = "v0.1.4";

/// Whether that release actually carries the files [`CLI_ASSETS`] names.
///
/// It does not. This is `false` today, and while it is `false` the CLI is
/// reported as unavailable and never fetched — see the module header. It is a
/// separate constant from the names so that the names are still built, still
/// checked by the tests, and still shown to the user as where the payload would
/// come from; flipping this to `true` is not enough on its own, because the names
/// below are guesses and [`CLI_SHA256`] is empty.
const CLI_PUBLISHED: bool = false;

/// The digest of the CLI payload, once there is one to digest.
///
/// Empty on purpose, and the emptiness is load-bearing twice. It is the third
/// thing to fill in when a release appears, and it is what the verifier refuses
/// on if one appears before anyone fills it in — an empty pin fails closed, and a
/// placeholder that hashed *something* would be worse than none, because it would
/// happily install whatever arrived.
const CLI_SHA256: &str = "";

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
    member: Option<&'static str>,
    /// Where the payload ends up. For a wrapped archive this is the final path
    /// of the wrapped directory, not its parent.
    dest: PathBuf,
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

/// The files the Common CLI payload *would* arrive in.
///
/// **These names are invented.** No release publishes them; they are what a
/// release would have to publish for [`bootstrap_run`] to install the CLI, and
/// they are here so that the shape of the missing thing is written down rather
/// than living in someone's head. See [`CLI_PUBLISHED`].
#[rustfmt::skip] // See `OLLAMA_ASSETS`.
const CLI_ASSETS: &[AssetRow] = &[
    ("macos", "aarch64", "common-cli-macos-arm64.tar.gz", Archive::TarGz, None),
    ("macos", "x86_64", "common-cli-macos-x64.tar.gz", Archive::TarGz, None),
    ("windows", "x86_64", "common-cli-windows-x64.zip", Archive::Zip, None),
    ("linux", "x86_64", "common-cli-linux-x64.tar.gz", Archive::TarGz, None),
];

/// Where the CLI's files go, which is where its own installers put them —
/// `backend.rs`'s `common_bin()` looks under `~/.common-network/bin` and this
/// must agree with it, or the app would install the CLI somewhere it then does
/// not look.
fn cli_dir(home: &Path) -> PathBuf {
    home.join(".common-network")
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
/// do it: the runtime the CLI needs, the CLI, then the model server.
fn payloads(home: &Path) -> Vec<Payload> {
    let key = platform_key();
    vec![
        python_payload(home, key),
        cli_payload(home, key),
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
        blocked,
        probe: python_present,
    }
}

fn cli_payload(home: &Path, key: (&str, &str)) -> Payload {
    let named = CLI_ASSETS.iter().find(|(os, arch, ..)| (*os, *arch) == key);

    let (asset, url, archive, blocked) = match named {
        Some((_, _, asset, archive, _)) => (
            *asset,
            format!("{CLI_BASE}/{CLI_TAG}/{asset}"),
            *archive,
            (!CLI_PUBLISHED).then(|| {
                format!(
                    "the command-line tool has no published build to fetch — the only \
                     release of TheCommonAI/common-network ({CLI_TAG}) carries no \
                     downloadable files"
                )
            }),
        ),
        None => (
            "(no build for this machine)",
            String::new(),
            Archive::TarGz,
            Some(format!(
                "no command-line tool build is published for {} {}",
                key.0, key.1
            )),
        ),
    };

    Payload {
        id: "cli",
        label: "Common's command-line tool",
        version: CLI_TAG.trim_start_matches('v').to_string(),
        asset: asset.to_string(),
        url,
        checksum: Checksum::Pinned(CLI_SHA256),
        archive,
        // Unknown until a release publishes one: the CLI is expected to be a tree
        // that merges into `~/.common-network` beside whatever is already there,
        // which is what `install` does with an existing destination.
        member: None,
        dest: cli_dir(home),
        blocked,
        probe: cli_present,
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

/// A `common` that is already installed, by the same names and in the same
/// directory `common_names` and `common_bin` in `backend.rs` use.
///
/// Reporting only. It asks the question a user is asking — "have I already got
/// this?" — and the answer decides nothing, because the CLI is now bundled rather
/// than fetched and `cli_script` is what places it. It is what `bootstrap_status`
/// prints beside the seed.
///
/// All three spellings are checked rather than only the current platform's, for the
/// reason `common_names` gives: the launcher that ships with the CLI is a shell
/// script on Unix and a `.cmd` beside it on Windows, and a report that only knew
/// about one spelling would say "not installed" on a machine that has one.
fn cli_present(home: &Path) -> Option<String> {
    let bin = cli_dir(home).join("bin");
    for name in ["common", "common.cmd", "common.exe"] {
        let candidate = bin.join(name);
        if candidate.is_file() {
            return Some(format!("the command-line tool at {}", candidate.display()));
        }
    }
    None
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

/// Unpack `archive` from `file` into `into`.
fn extract(archive: Archive, file: &Path, into: &Path) -> Result<(), String> {
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

    match archive {
        Archive::TarGz => {
            let mut command = silent("tar");
            command.arg("-xzf").arg(file).arg("-C").arg(into);
            run(command)
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
                run(command)
            } else {
                let mut command = silent("unzip");
                command.arg("-q").arg(file).arg("-d").arg(into);
                run(command)
            }
        }
        // Refused rather than attempted: `tar -xzf` on a zstd stream fails with a
        // message about the gzip magic that says nothing about zstd, and the
        // caller has a better sentence for this — see `ollama_payload`.
        Archive::TarZst => Err(
            "this download is a .tar.zst, which needs a zstd decompressor this app \
             does not ship"
                .to_string(),
        ),
    }
}

/// Move `source` into `dest`, never over anything that is already there.
///
/// Two shapes, and the destination decides which:
///
/// - `dest` does not exist — the whole of `source` becomes `dest`. This is the
///   ordinary case, and because `source` was unpacked into the staging directory
///   under the same `~/.common-network`, the move is a `rename` within one
///   filesystem: atomic, and never a window in which a half-unpacked payload is
///   what is installed.
/// - `dest` already exists — `source`'s top-level entries are moved into it, and
///   an entry whose name is already taken is **left alone**. This is the CLI's
///   case: it installs into `~/.common-network`, which exists as soon as anything
///   of the app's does, and merging is the only reading of "install the CLI
///   beside what is already here" that cannot delete somebody's identity or
///   weights.
fn install(source: &Path, dest: &Path) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent to install into", dest.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("couldn't make {}: {e}", parent.display()))?;

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
    if let Err(message) = extract(payload.archive, &file, &unpacked) {
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
            for (table, name) in [(OLLAMA_ASSETS, "Ollama"), (CLI_ASSETS, "the CLI")] {
                assert!(
                    table.iter().any(|(os, arch, ..)| (*os, *arch) == key),
                    "no {name} payload for {key:?}",
                );
            }
        }

        for (os, arch, asset, ..) in OLLAMA_ASSETS.iter().chain(CLI_ASSETS) {
            assert!(
                !asset.is_empty() && !asset.contains('/'),
                "{os}/{arch} names a payload that is not a bare file name: {asset}",
            );
        }
    }

    /// The guard that makes an unfinished table entry fail closed.
    ///
    /// The CLI's digest is empty today. If the payload were ever reachable — by
    /// someone flipping `CLI_PUBLISHED` without filling this in — the verifier
    /// must refuse rather than install whatever arrived.
    #[test]
    fn an_empty_pinned_checksum_is_refused_rather_than_skipped() {
        let home = Path::new("/nonexistent-home-for-a-test");
        let payload = cli_payload(home, ("macos", "aarch64"));
        assert!(matches!(payload.checksum, Checksum::Pinned("")));
        assert!(
            expected_digest(&payload).is_err(),
            "an empty pinned checksum was accepted",
        );
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
}
