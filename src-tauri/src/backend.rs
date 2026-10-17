//! The connect-and-contribute seam.
//!
//! This is deliberately the thinnest possible layer. The Python toolchain at
//! `~/.common-network` is already installed on any machine that can contribute,
//! and `common` is already the single source of truth for both the terminal
//! user and this app — so the app runs that CLI and hands its output to the UI
//! rather than reimplementing any of it. Nothing is bundled, nothing is
//! re-derived, and a fix to the CLI is a fix to the app.
//!
//! Three kinds of command live here, and the split is deliberate:
//!
//! - **Hardware reads** parse *machine* output (`sysctl`, `df`, `pmset`), so
//!   Rust owns their shape and returns typed structs. There is no `common` verb
//!   for any of them, which is the whole reason they are here.
//! - **Network verbs** are already JSON — `common --json status` prints one
//!   object and exits — so Rust does not re-encode them. It passes the string
//!   through and TypeScript maps it onto the onboarding contract, which is
//!   where those types already live. Re-declaring them in Rust would be a
//!   second copy to keep in sync, and the copy that drifted would be this one.
//! - **One place read**, which is neither: it goes to a third party rather than
//!   to this machine or to the network, and it is the only request the app makes
//!   that the user did not type. It is here rather than in the webview for a
//!   narrow reason — it keeps the lookup out of the page's CSP, the same way
//!   everything else here keeps `common` out of it.
//!
//! No new dependencies: `std::process::Command` and the `serde_json` that Tauri
//! already brings. Every command is `async` and does its blocking work on
//! `spawn_blocking`, because a synchronous Tauri command runs on the main
//! thread and `common recommend` waits up to 30s on the gateway.
//!
//! Scope note: this covers **connect and contribute** — reading this machine,
//! asking the network what it is short of, joining, and the gateway confirming
//! it can see the node — and the consumer's side of the same CLI, which is
//! `network_ask` and the stop that goes with it. It does not touch the resource
//! limits, which have no counterpart in the backend yet; those live wherever the
//! app puts them.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
// `Manager` is the trait that puts `path()` on the app handle, which is where a
// report is written. `config` and `package_info` are inherent methods and need no
// import; this one is what supplies the folder.
use tauri::Manager;

/* ------------------------------- running things ------------------------------- */

/// The user's home directory, on a platform that does not agree on what to call
/// it.
///
/// `HOME` is the POSIX answer and is what every macOS and Linux read here has
/// always used. Windows does not set it. It sets `USERPROFILE`, and on a domain
/// account it may only set `HOMEDRIVE` and `HOMEPATH`, which have to be joined
/// rather than read whole — so all three are tried, in that order.
///
/// This matters more than a path lookup usually would: `~/.common-network` is
/// where the CLI, the join log, the identity and the weights all live, so a
/// missed home is not one broken feature but every network feature at once.
fn home_dir() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(profile));
    }
    let drive = std::env::var_os("HOMEDRIVE").filter(|v| !v.is_empty());
    let path = std::env::var_os("HOMEPATH").filter(|v| !v.is_empty());
    if let (Some(drive), Some(path)) = (drive, path) {
        let mut joined = drive;
        joined.push(path);
        return Ok(PathBuf::from(joined));
    }
    Err("no HOME, USERPROFILE or HOMEDRIVE/HOMEPATH to place things under".to_string())
}

/// A `Command` that will not flash a console window on Windows.
///
/// Every program this file runs is a helper the user did not ask for — `common`,
/// `sysctl`, `df`, `pmset`, `powershell`, `curl`, `tasklist` — and Windows gives
/// each one a console for as long as it lives unless it is told not to. Left
/// alone, a black box appears and vanishes on every hardware read and on every
/// answer, which reads as a fault in an app whose whole manner is to be quiet.
///
/// Set here, once, rather than at each call site: there are fifteen of them and
/// the sixteenth would be the one that forgot. On every other platform this is
/// just `Command::new`.
///
/// Nothing here knows about the batch wrapper `install.ps1` writes, and nothing
/// here should. `std` already does — see `common_names`, which is where the
/// reason is written down, because the obvious-looking "fix" of naming `cmd.exe`
/// here is worse than doing nothing and is the first thing anyone would try.
fn silent(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let cmd = Command::new(program);
    // A second binding rather than a mutable one, so that the platforms which
    // have nothing to set do not carry a `mut` they never use.
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW`. Spelled out because `0x0800_0000` at a call site
        /// says nothing about what it does, and this is not a flag anyone
        /// recognises by sight.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    cmd
}

/* ------------------------------- the CLI itself ------------------------------- */

/// Where the bundle unpacked the seed copy of the CLI, if it carries one.
///
/// Set once, from `lib.rs`'s `setup`, because that is the only moment an
/// `AppHandle` exists to ask for the resource directory — and because `run_common`
/// and its four siblings are plain functions reached through `spawn_blocking`,
/// which have no handle and could not ask for themselves.
///
/// A `OnceLock` rather than managed state for the same reason: `State` is
/// reachable only from inside a command, and the callers here sit one layer below
/// that.
static CLI_SEED: OnceLock<PathBuf> = OnceLock::new();

/// Record where the bundled seed was unpacked. Called once, at startup.
pub fn use_cli_seed(dir: PathBuf) {
    let _ = CLI_SEED.set(dir);
}

/// `~/.common-network`, the directory the CLI's own installer owns.
fn cli_home(home: &Path) -> PathBuf {
    home.join(".common-network")
}

/// The files the seed places.
///
/// The siblings are neither optional nor decoration. `join.py` imports `worker.py`
/// and `runtime.py` as siblings, which is why the CLI's own installer fetches them
/// together rather than one at a time. `runtime.py` arrived with the llama.cpp
/// migration and was missing from this list until 0.2.9 — a seed without it is a
/// bundled CLI that cannot be imported at all, on the one machine that has nothing
/// else to fall back on.
const CLI_FILES: [&str; 5] = ["common.py", "join.py", "worker.py", "runtime.py", "chat.py"];

/// The `(major, minor, patch)` in a CLI file's `VERSION = "0.1.7"` line.
///
/// Read rather than executed, because this app may be looking at a CLI written for a
/// version of itself that no longer exists and must not run it to find out. Scoped to
/// the first line that begins with `VERSION`, so the string appearing inside prose or
/// a changelog cannot be mistaken for the declaration.
///
/// `None` is not an error. It means this copy cannot be judged, and every caller
/// treats that as a reason to overwrite nothing.
fn declared_version(source: &str) -> Option<(u32, u32, u32)> {
    let line = source
        .lines()
        .find(|line| line.trim_start().starts_with("VERSION"))?;
    let rest = line.split('"').nth(1)?;
    let mut parts = rest.trim().split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next()?.trim().parse().ok()?;
    let patch = parts.next()?.trim().parse().ok()?;
    Some((major, minor, patch))
}

/// Whether the bundled CLI is strictly newer than the one already in place.
///
/// The seed moves as one and is compared by `common.py`'s version, because
/// `runtime.py` and `worker.py` carry no `VERSION` line — they are the siblings of a
/// versioned CLI, not versions of their own.
///
/// Anything unjudgeable answers `false`, and that direction is the point. An existing
/// install is the user's: it may be one their own `common` has since updated from
/// `main`, and replacing it with a bundle this app cannot prove is newer would be a
/// downgrade wearing the costume of a fix.
fn seed_is_newer(seed: &Path, dir: &Path) -> bool {
    let Ok(installed) = std::fs::read_to_string(dir.join("common.py")) else {
        return true; // nothing is there to protect
    };
    let Ok(bundled) = std::fs::read_to_string(seed.join("common.py")) else {
        return false;
    };
    match (declared_version(&bundled), declared_version(&installed)) {
        (Some(bundled), Some(installed)) => bundled > installed,
        _ => false,
    }
}

/// Copy the bundled CLI into `~/.common-network`, over nothing that is newer.
///
/// Not fatal when it fails: the fallback in `cli` still finds a `common` installed
/// the traditional way, and that is a working app.
///
/// "Over nothing" once meant *literally* nothing, and that turned out to be a bug
/// with a long tail: this app runs the CLI with `--no-update`, so a machine that took
/// the seed once could never take a newer one — not from here, and not from the CLI's
/// own self-update either. This machine sat on 0.1.3 across three releases that way,
/// including one whose entire purpose was to make a failure legible. So an install
/// older than the bundle is now replaced, and anything else is left exactly as found.
fn seed_cli(seed: &Path, dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let replace = seed_is_newer(seed, dir);
    for name in CLI_FILES {
        let to = dir.join(name);
        if to.exists() && !replace {
            continue;
        }
        std::fs::copy(seed.join(name), &to)?;
    }
    Ok(())
}

/// The CLI script this app runs, keeping the bundled seed in place on the way.
///
/// The seed is what makes arriving with nothing work at all: without it the app
/// would have an interpreter and no program to hand it, which is precisely the
/// state `~/.common-network` is in on a machine that has only ever run this app.
///
/// The seed is consulted on every launch, and not only when `common.py` is absent.
/// Returning early on an existing `common.py` looked like the "do not clobber" rule
/// and was really a way to skip the repair entirely, which cost a release. This
/// machine had `common.py` at 0.1.7 and no `runtime.py` beside it, so `join.py`
/// imported `~/.common-network/runtime/` — the directory the llama.cpp runtime
/// unpacks into, which Python is perfectly happy to import as a namespace package —
/// and died on `module 'runtime' has no attribute 'is_installable'`. Nothing in the
/// app's logs said so, because nothing had been attempted. The five files travel
/// together or the CLI does not run.
///
/// What may be overwritten is still not decided here: `seed_cli` places what is
/// missing and replaces only what is strictly older, so a user whose own `common`
/// has moved ahead of the bundle keeps the copy they have.
fn cli_script(home: &Path) -> Option<PathBuf> {
    place_cli(CLI_SEED.get().map(PathBuf::as_path), home)
}

/// `cli_script` with the seed passed in, so the rule above can be tested without a
/// process-global `OnceLock` and without an app around it.
fn place_cli(seed: Option<&Path>, home: &Path) -> Option<PathBuf> {
    let dir = cli_home(home);
    if let Some(seed) = seed
        && let Err(e) = seed_cli(seed, &dir)
    {
        // Worth a line rather than a shrug: a seed that could not be placed is a
        // first run that cannot work, with nothing anywhere saying why.
        eprintln!("could not place the bundled CLI at {}: {e}", dir.display());
    }
    let script = dir.join("common.py");
    script.is_file().then_some(script)
}

/// A `common` invocation, resolved.
///
/// The command to run, and the path to name if it will not start.
struct Cli {
    cmd: Command,
    named: PathBuf,
}

/// Build a `common` invocation, whichever way this machine can run one.
///
/// The invocation is `python3 <script>`, and not the `bin/common` wrapper sitting
/// beside it, for a reason that is not stylistic. The wrapper is a shell script
/// that resolves its own interpreter — and the ones this app was tested against
/// resolve it from a hardcoded list of absolute system paths, never consulting
/// `PATH`. So a Python this app fetched could sit at
/// `~/.common-network/runtime/python/bin/python3` for the life of the install and
/// never once be the Python the CLI ran under, which would make the fetch pure
/// ceremony. Naming the interpreter and the script outright is also the one form
/// that is identical on all three platforms, where the wrapper needs a POSIX shell
/// that Windows does not have.
///
/// `COMMON_BIN` still wins outright: it is how somebody runs this app against a
/// checkout, and a seed must not get in the way of that.
fn cli() -> Result<Cli, String> {
    if let Ok(explicit) = std::env::var("COMMON_BIN")
        && !explicit.is_empty()
    {
        let path = PathBuf::from(explicit);
        return Ok(Cli {
            cmd: silent(&path),
            named: path,
        });
    }

    let home = home_dir()?;

    // The interpreter first, so that a machine with no Python is not seeded with a
    // script it could not run anyway.
    if let Some(python) = crate::fetch::python_for_cli(&home)
        && let Some(script) = cli_script(&home)
    {
        let mut cmd = silent(&python);
        cmd.arg(&script);
        return Ok(Cli { cmd, named: script });
    }

    // No interpreter this app can vouch for. The old path, which finds an installed
    // `common` or falls back to the name on `PATH` — the last case is a machine
    // where the wrapper, and whatever interpreter it can find for itself, is the
    // only thing that can work.
    let path = common_bin();
    Ok(Cli {
        cmd: silent(&path),
        named: path,
    })
}

/// What [`cli`] would run, for the diagnostics report.
///
/// The script and not the interpreter, because "which `common` is this app using"
/// is the question the report answers, and `python3` is not an answer to it.
fn cli_path() -> String {
    match cli() {
        Ok(resolved) => resolved.named.to_string_lossy().to_string(),
        Err(_) => common_bin().to_string_lossy().to_string(),
    }
}

/// The environment a `common` invocation needs, which is not always the one this
/// process was handed.
///
/// `PATH` is the whole of it, and it earns its place as a first act rather than a last
/// resort. `join.py` looks `cloudflared` up by name before it will serve anything and
/// gives up when it does not find it, so a join spawned without that directory on its
/// `PATH` dies before it has reached the network — and the app then spends its whole
/// four-minute budget reporting a gateway that was never asked.
///
/// A `PATH` is read once, at process start, and this app is routinely started from a
/// shell — or an Explorer — that was already running when the directory was written, so
/// what is on this process's `PATH` is not necessarily what is on the disk. Appended and
/// not prepended: a `cloudflared` the user installed somewhere of their own choosing
/// still wins the lookup, and this supplies the directory only when nothing else has.
///
/// There used to be a second directory — Ollama's, on Windows — added because the
/// `join.py` of that time asked `shutil.which("ollama")` before it did anything at all
/// and exited on the answer no. Both halves of that are gone: the join no longer looks
/// for a daemon, and neither does anything here.
fn cli_env(cmd: &mut Command) {
    // Belt and braces beside `--no-color`: the CLI also honours NO_COLOR, and a
    // stray escape sequence inside JSON is a parse error with a baffling cause.
    cmd.env("NO_COLOR", "1");

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = home_dir() {
        let bin = cli_home(&home).join("bin");
        if bin.is_dir() {
            dirs.push(bin);
        }
    }
    if dirs.is_empty() {
        return;
    }

    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|existing| std::env::split_paths(&existing).collect())
        .unwrap_or_default();
    paths.extend(dirs);
    if let Ok(joined) = std::env::join_paths(paths) {
        cmd.env("PATH", joined);
    }
}

/// A failed launch of the CLI, in the one form the interface can act on.
///
/// The single most consequential thing on this side of the boundary is that a
/// missing `common` and an unreachable gateway arrive at the user as the same
/// event — a helper that would not start — when the two are cured by opposite
/// things: one by a download, the other by a network. So this is the one message
/// in this file that is *written to be recognised* rather than only to be read,
/// and it is recognised on the words "command-line tool", which is what
/// `classify` in `service.real.ts` matches to produce the `cli-missing` code. The
/// phrasing is load-bearing. The path after it is the disclosure line, and it is
/// the first thing to look at when the `common` on `PATH` is not the one in use.
///
/// It lives here, and every site that starts the CLI goes through it, because a
/// sentence this specific is exactly the kind of thing that survives in the one
/// place it was written and is forgotten in the other three — and the site that
/// forgets is the one that reports the missing CLI as a network failure.
///
/// `NotFound` is the whole of the distinction, and on Windows it is asked to
/// carry one thing more than it means: `CreateProcess` says "not found" both
/// about a file that is not there and about a program it could not be made to
/// run. Both are the same fact from the user's side — the tool this app means to
/// run is not runnable here, and no join has left the machine — so the sentence
/// stands as written for both, and `common_names` is where the one case that
/// would have made this confusing is dealt with instead.
fn launch_error(bin: &std::path::Path, error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => format!(
            "Common's command-line tool is not installed ({})",
            bin.display()
        ),
        _ => format!("couldn't run {}: {error}", bin.display()),
    }
}

/// The volume the weights and the partial downloads will land on.
///
/// The flow asks for a volume with room for a model, and the honest answer is
/// the one the CLI will actually write to: `shutil.disk_usage(Path.home())`,
/// which is the home directory's volume on every platform. The web layer passes
/// `/` as a stand-in for "wherever they land", and that is a path that resolves
/// to the home volume on a Mac and does not exist at all on Windows — so a
/// placeholder is replaced and a real path is honoured.
///
/// macOS and Windows only, on the same predicate as `capture` and for the same
/// reason: the disk read for everywhere else refuses before it resolves a path.
#[cfg(any(target_os = "macos", windows))]
fn weights_volume(path: &str) -> Result<String, String> {
    if !path.is_empty() && path != "/" {
        return Ok(path.to_string());
    }
    let home = home_dir()?;
    if cfg!(windows) {
        // A drive root, `C:\`, which is what `DriveInfo` wants and what a
        // download path can be joined onto. `Component::Prefix` hands back `C:`
        // with no separator, so one is added rather than assumed.
        match home.components().next() {
            Some(std::path::Component::Prefix(prefix)) => {
                let mut root = prefix.as_os_str().to_string_lossy().to_string();
                if !root.ends_with('\\') {
                    root.push('\\');
                }
                Ok(root)
            }
            _ => Ok(home.to_string_lossy().to_string()),
        }
    } else {
        Ok(home.to_string_lossy().to_string())
    }
}

/// The names the CLI answers to inside the install directory, in the order the
/// machine is most likely to have one.
///
/// The two installers do not agree on the spelling and each writes only its own:
/// `install.sh` writes an extensionless `common` — a shell script, which is a
/// program on the platforms that run it that way — while `install.ps1` writes
/// `common.cmd`, because on Windows the CLI is a Python program and a batch file
/// is the only form a command line starts unprompted. `common.exe` is what an
/// MSVC-era install may have produced.
///
/// Windows is offered no extensionless candidate on purpose. `CreateProcess`
/// appends `.exe` to a name with no extension, so returning `common` there could
/// only ever be asking for a file that does not exist under that name; the batch
/// spelling is the one that works.
///
/// And the spelling is the whole of it. It is tempting to follow it up by having
/// `silent` name `cmd.exe` itself, on the reasoning that `CreateProcess` cannot
/// start a `.cmd`. It can — `std` sees to it. When `Command` spawns a program
/// whose name ends in `.bat` or `.cmd` (case-insensitively, after resolving the
/// path), it substitutes `command_prompt()` for the program and builds the
/// command line with `make_bat_command_line`, which produces
/// `cmd.exe /e:ON /v:OFF /d /c "script" args…`. That function is where the two
/// genuinely hard parts live: it quotes any argument containing ASCII
/// punctuation outside `#$*+-./:?@\_`, and it rewrites every `%` as `%%cd:~,%`
/// so that a `%VAR%` inside a question reaches the script as typed instead of
/// being expanded — `/e:ON` in the line above exists precisely to enable that
/// no-op. Nothing here could be improved by reimplementing it, and doing so by
/// hand would bypass it: a `cmd /C` written in `silent` would hand the command
/// line back to `cmd.exe` to be re-split, and would have to get the quoting and
/// the `%` rewrite right a second time, unasked and untested.
///
/// `windows` is a parameter rather than a `cfg!` so that a test on any platform
/// can pin both answers. Windows is where this went wrong and is the platform
/// least likely to be the one running the suite.
fn common_names(windows: bool) -> &'static [&'static str] {
    if windows {
        &["common.cmd", "common.exe"]
    } else {
        &["common"]
    }
}

/// The `common` binary, in the order that gives the least surprising answer.
///
/// A `.app` launched from Finder inherits a minimal `PATH` that will not
/// include `~/.common-network/bin`, so the installed location is checked before
/// the `PATH` lookup rather than after it — and `COMMON_BIN` overrides both, for
/// a developer running from a checkout.
fn common_bin() -> PathBuf {
    if let Ok(explicit) = std::env::var("COMMON_BIN")
        && !explicit.is_empty()
    {
        return PathBuf::from(explicit);
    }
    // `home_dir` rather than `HOME`, which Windows does not set — a miss here
    // would not break one feature but every network one at once, since the
    // binary, the identity and the weights all live under this directory.
    if let Ok(home) = home_dir() {
        let dir = home.join(".common-network").join("bin");
        for name in common_names(cfg!(windows)) {
            let installed = dir.join(name);
            if installed.is_file() {
                return installed;
            }
        }
    }
    PathBuf::from("common")
}

/// The machine-readable document inside `common`'s stdout.
///
/// `--json` does not suppress the CLI's human preamble. `ask` writes
/// `asking llama3.2:1b locally (never leaves this machine)` to **stdout** and
/// only then the JSON, on the same stream — so handing back stdout verbatim
/// hands the caller a banner to parse, and `JSON.parse` on it is a syntax error
/// on the one screen where the user is waiting for an answer.
///
/// The rule is "the last line that is a JSON value", read from the end. That
/// covers the preamble above the document and any human line below it, and it
/// still returns `null`, which is a JSON value and is what `whoami` prints for a
/// machine that has never joined. If no line parses, the whole of stdout comes
/// back: a caller that cannot parse it should be able to show what it got.
fn last_json(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    for line in trimmed.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if serde_json::from_str::<serde_json::Value>(line).is_ok() {
            return line.to_string();
        }
    }
    trimmed.to_string()
}

/// Run `common` and hand back its stdout, trimmed.
///
/// `--no-update` is not an optimisation. Without it the CLI performs a
/// self-update over the network before doing anything else, which would make
/// every call here depend on GitHub being reachable and would let the app
/// silently replace the user's installed CLI. Neither belongs in a click
/// handler.
///
/// `--json` must precede the verb: `rest` is an `argparse.REMAINDER`, so
/// anything written after the verb is captured as free text and a flag there is
/// silently ignored.
///
/// The suppression above is about this app's calls and not about the copy of the
/// CLI on disk, which is worth being precise about now that the app can place one.
/// A seeded CLI is not a frozen one: the CLI updates *itself* from the network's
/// `main` branch whenever it is run without `--no-update`, which is what happens
/// the moment the user runs `common` from a terminal — so a fix to the CLI reaches
/// the machines running this app without an app release, and the seeded copy is a
/// starting point rather than the version anybody is stuck with.
fn run_common(verb: &str, extra: &[&str], json: bool) -> Result<String, String> {
    let Cli { mut cmd, named } = cli()?;
    cmd.arg("--no-color").arg("--no-update");
    if json {
        cmd.arg("--json");
    }
    cmd.arg(verb).args(extra);
    cli_env(&mut cmd);

    let out = cmd.output().map_err(|e| launch_error(&named, e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("common {verb} exited with {}", out.status)
        } else {
            // The CLI already writes a sentence a human can read ("✗ can't reach
            // the network."), and it is a better `detail` than anything this
            // layer could invent.
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if json { last_json(&stdout) } else { stdout })
}

/// Capture stdout from a system program, for the hardware reads.
///
/// macOS and Windows only, and the predicate is the mirror of the one the stubs
/// at the foot of each read carry. Those two platforms are the ones whose reads
/// shell out — `sysctl`, `df`, `pmset` on one, PowerShell on the other — and
/// everywhere else the read refuses without running anything at all, so nothing
/// there can call this.
#[cfg(any(target_os = "macos", windows))]
fn capture(program: &str, args: &[&str]) -> Result<String, String> {
    let out = silent(program)
        .args(args)
        .output()
        .map_err(|e| format!("couldn't run {program}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{program} exited with {}", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// One PowerShell expression, as text.
///
/// Windows has no counterpart to `sysctl`, `df` or `pmset`, and the CLI's own
/// Windows probe reaches for the platform's native answers where it can —
/// `GlobalMemoryStatusEx`, `shutil.disk_usage` — so this does the same through
/// the one shell Windows always has. `-NoProfile` keeps a user's profile from
/// changing what these return, and `-NonInteractive` guarantees it cannot sit
/// waiting on a prompt nobody can see. Nothing here is built from user input.
#[cfg(windows)]
fn powershell(script: &str) -> Result<String, String> {
    capture(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )
}

/* --------------------------------- hardware --------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRead {
    pub total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsRead {
    pub vendor: String,
    pub name: String,
    /// `None` when graphics memory is shared with the processor. On Apple
    /// silicon it always is, and reporting a number here would be inventing one.
    pub vram_bytes: Option<u64>,
    pub unified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRead {
    pub free_bytes: u64,
    pub total_bytes: u64,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerRead {
    pub source: String,
    pub battery_percent: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsRead {
    pub platform: String,
    pub version: String,
}

/// Physical memory.
///
/// `hw.memsize` is the installed figure, not the available one — which is what
/// the model ladder is fitted against, and the same read the CLI's own
/// `detect_hardware` takes.
#[cfg(target_os = "macos")]
fn read_memory_blocking() -> Result<MemoryRead, String> {
    let raw = capture("sysctl", &["-n", "hw.memsize"])?;
    let total_bytes = raw
        .trim()
        .parse::<u64>()
        .map_err(|e| format!("hw.memsize wasn't a number ({raw:?}): {e}"))?;
    Ok(MemoryRead { total_bytes })
}

/// Physical memory, the Windows way.
///
/// `Win32_ComputerSystem.TotalPhysicalMemory` is the same figure the CLI's own
/// Windows probe gets from `GlobalMemoryStatusEx`, reached through the shell
/// rather than through FFI. It is the installed total rather than the available
/// one, which is what the model ladder is fitted against and what `hw.memsize`
/// answers on a Mac.
#[cfg(windows)]
fn read_memory_blocking() -> Result<MemoryRead, String> {
    let raw = powershell("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory")?;
    let total_bytes = raw.trim().parse::<u64>().map_err(|e| {
        format!("Win32_ComputerSystem.TotalPhysicalMemory wasn't a number ({raw:?}): {e}")
    })?;
    Ok(MemoryRead { total_bytes })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_memory_blocking() -> Result<MemoryRead, String> {
    Err(format!(
        "this build reads memory on macOS and Windows only; {} is not implemented",
        std::env::consts::OS
    ))
}

/// The graphics device.
///
/// On Apple silicon the processor name is the graphics name, because the
/// graphics *is* the processor's — so `machdep.cpu.brand_string` answers this in
/// about a millisecond, where `system_profiler` takes one to three seconds to
/// say the same thing. Only an Intel Mac falls through to the slow probe, and
/// there the discrete card's own VRAM is a real number worth waiting for.
#[cfg(target_os = "macos")]
fn read_graphics_blocking() -> Result<GraphicsRead, String> {
    let brand = capture("sysctl", &["-n", "machdep.cpu.brand_string"])
        .unwrap_or_default()
        .trim()
        .to_string();

    if brand.starts_with("Apple") {
        return Ok(GraphicsRead {
            vendor: "Apple".to_string(),
            name: brand,
            vram_bytes: None,
            unified: true,
        });
    }

    let raw = capture("system_profiler", &["SPDisplaysDataType", "-json"])?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("system_profiler wasn't JSON: {e}"))?;

    let device = parsed
        .get("SPDisplaysDataType")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "system_profiler reported no display device".to_string())?;

    let field = |key: &str| {
        device
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    Ok(GraphicsRead {
        vendor: field("sppci_vendor").unwrap_or_else(|| "unknown".to_string()),
        name: field("sppci_model")
            .or_else(|| field("_name"))
            .unwrap_or_else(|| "unknown".to_string()),
        // e.g. "1536 MB", "4 GB", or the string "unified" on some integrated
        // parts — which is why this parses rather than slices.
        vram_bytes: field("spdisplays_vram").and_then(|s| parse_capacity(&s)),
        unified: false,
    })
}

/// `"1536 MB"` or `"4 GB"` → bytes. `"unified"` and anything else → `None`,
/// which is the honest answer for a graphics memory that cannot be split out.
///
/// macOS-only: it exists to read `system_profiler`'s spelling of a capacity, and
/// the Windows read deliberately does not ask for one — see
/// `read_graphics_blocking` for the Windows side.
#[cfg(target_os = "macos")]
fn parse_capacity(text: &str) -> Option<u64> {
    let lower = text.to_ascii_lowercase();
    let digits: String = lower
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let value: f64 = digits.parse().ok()?;
    if lower.contains("gb") {
        Some((value * 1e9) as u64)
    } else if lower.contains("mb") {
        Some((value * 1e6) as u64)
    } else {
        None
    }
}

/// The graphics device's name, the Windows way.
///
/// `AdapterRAM` is deliberately not read. Windows reports graphics memory in a
/// 32-bit field that saturates just under 4 GiB, so a card with 8 or 24 GiB
/// reports the same number as one with 4 — a figure that is right by luck and
/// silently wrong the rest of the time. `vram_bytes` is therefore `None`, which
/// is the same refusal to invent a number the Mac read makes for Apple silicon,
/// arrived at for the opposite reason. `unified` is false because a Windows
/// adapter reporting its own name is reporting its own memory.
///
/// The CLI's Windows probe skips the GPU entirely — "default to none rather
/// than guess" — so this goes one step past it, and only as far as a name, which
/// is a read rather than a guess.
#[cfg(windows)]
fn read_graphics_blocking() -> Result<GraphicsRead, String> {
    let raw = powershell(
        "(Get-CimInstance Win32_VideoController | Select-Object -First 1) | \
         ForEach-Object { \"$($_.AdapterCompatibility)|$($_.Name)\" }",
    )?;
    let line = raw.trim();
    if line.is_empty() {
        return Err("Win32_VideoController reported no display adapter".to_string());
    }
    // "NVIDIA|NVIDIA GeForce RTX 4090", or a lone name if the vendor is blank.
    let (vendor, name) = match line.split_once('|') {
        Some((vendor, name)) => (vendor.trim(), name.trim()),
        None => ("", line),
    };
    let or_unknown = |s: &str| {
        if s.is_empty() {
            "unknown".to_string()
        } else {
            s.to_string()
        }
    };
    Ok(GraphicsRead {
        vendor: or_unknown(vendor),
        name: or_unknown(name),
        vram_bytes: None,
        unified: false,
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_graphics_blocking() -> Result<GraphicsRead, String> {
    Err(format!(
        "this build reads graphics on macOS and Windows only; {} is not implemented",
        std::env::consts::OS
    ))
}

/// Free and total space on the volume holding `path`.
///
/// `-P` forces the POSIX output format, whose columns are stable; the default
/// output wraps onto two lines for a long device name and silently shifts every
/// field. `-k` fixes the unit at 1024-byte blocks so the arithmetic below is
/// exact rather than locale-dependent.
#[cfg(target_os = "macos")]
fn read_disk_blocking(path: &str) -> Result<DiskRead, String> {
    // A caller that hands over `/` means "wherever the weights land" rather
    // than the boot volume — see `weights_volume` — and a caller that names a
    // real path gets that path read.
    let target = weights_volume(path).unwrap_or_else(|_| path.to_string());
    let raw = capture("df", &["-Pk", &target])?;
    let line = raw
        .lines()
        .nth(1)
        .ok_or_else(|| format!("df -Pk {target} printed no data row"))?;
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 4 {
        return Err(format!(
            "df -Pk {target} printed an unexpected row: {line:?}"
        ));
    }
    // Filesystem, 1024-blocks, Used, Available, Capacity, Mounted on
    let total_blocks = cols[1]
        .parse::<u64>()
        .map_err(|e| format!("df total column wasn't a number ({:?}): {e}", cols[1]))?;
    let free_blocks = cols[3]
        .parse::<u64>()
        .map_err(|e| format!("df available column wasn't a number ({:?}): {e}", cols[3]))?;
    Ok(DiskRead {
        free_bytes: free_blocks * 1024,
        total_bytes: total_blocks * 1024,
        path: target,
    })
}

/// Free and total space on the volume the weights land on, the Windows way.
///
/// `DriveInfo` rather than `Get-PSDrive` or `Win32_LogicalDisk`: it is the same
/// numbers without a WMI round trip, and it takes a drive root directly. It
/// wants the trailing separator, which is why `weights_volume` keeps one.
#[cfg(windows)]
fn read_disk_blocking(path: &str) -> Result<DiskRead, String> {
    let target = weights_volume(path)?;
    let raw = powershell(&format!(
        "$d=[System.IO.DriveInfo]::new('{target}'); \
         \"$($d.TotalSize) $($d.AvailableFreeSpace)\""
    ))?;
    let mut cols = raw.split_whitespace();
    let total_bytes = cols
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| format!("DriveInfo({target}) printed no total: {raw:?}"))?;
    let free_bytes = cols
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| format!("DriveInfo({target}) printed no free space: {raw:?}"))?;
    Ok(DiskRead {
        free_bytes,
        total_bytes,
        path: target,
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_disk_blocking(path: &str) -> Result<DiskRead, String> {
    let _ = path;
    Err(format!(
        "this build reads disk on macOS and Windows only; {} is not implemented",
        std::env::consts::OS
    ))
}

/// Whether the machine is on mains or battery, and how much charge is left.
///
/// This is the read that visibly drives a later screen's default — the
/// contribution limit defaults to "only when plugged in" on battery — so it has
/// to be a real read rather than a guess. A desktop reports `mains` with no
/// battery percentage, which is correct and not a failure.
#[cfg(target_os = "macos")]
fn read_power_blocking() -> Result<PowerRead, String> {
    let raw = capture("pmset", &["-g", "batt"])?;

    let source = if raw.contains("AC Power") {
        "mains"
    } else if raw.contains("Battery Power") {
        "battery"
    } else {
        "unknown"
    };

    // The charge figure sits at the start of the second line, as "96%; ...".
    // Walked rather than matched with a regex, to keep this file dependency-free.
    let battery_percent = raw
        .lines()
        .nth(1)
        .and_then(|line| line.find('%').map(|pct| &line[..pct]))
        .and_then(|before| {
            let digits: String = before
                .chars()
                .rev()
                .take_while(char::is_ascii_digit)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            digits.parse::<u32>().ok()
        });

    Ok(PowerRead {
        source: source.to_string(),
        battery_percent,
    })
}

/// Mains or battery, and how much charge, the Windows way.
///
/// `PowerLineStatus` is read rather than `Win32_Battery.BatteryStatus`, whose
/// numbers distinguish seven flavours of charging — "Charging and High",
/// "Charging and Critical" — that this app has no use for. On a desktop the
/// status is `Online` with `BatteryLifePercent` at its 255 sentinel, which
/// becomes "mains, no percentage": the correct answer, not a failure, and the
/// same shape the Mac read gives a Mac mini.
///
/// `System.Windows.Forms` is a desktop-machine assembly, so a machine without it
/// fails here — which surfaces as an unknown power source rather than as a
/// wrong one.
#[cfg(windows)]
fn read_power_blocking() -> Result<PowerRead, String> {
    let raw = powershell(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $p=[System.Windows.Forms.SystemInformation]::PowerStatus; \
         \"$($p.PowerLineStatus) $($p.BatteryLifePercent)\"",
    )?;
    let mut cols = raw.split_whitespace();
    let line = cols.next().unwrap_or("");
    let source = match line {
        "Online" => "mains",
        "Offline" => "battery",
        // `Unknown`, or a machine that would not say.
        _ => "unknown",
    };
    // 255 is .NET's "no battery", and anything above 100 is not a charge.
    let battery_percent = cols
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|pct| *pct <= 100);
    Ok(PowerRead {
        source: source.to_string(),
        battery_percent,
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_power_blocking() -> Result<PowerRead, String> {
    Err(format!(
        "this build reads power on macOS and Windows only; {} is not implemented",
        std::env::consts::OS
    ))
}

/// The platform and its version. Cannot fail in any way worth reporting — the
/// compile target is the platform.
fn read_os_blocking() -> Result<OsRead, String> {
    // Each arm is the tail expression of its own cfg-stripped block, so exactly
    // one survives to be the body's value. Written with `return` in the first
    // arm, the body would fall through to `()` on macOS and not compile.
    #[cfg(target_os = "macos")]
    {
        let version = capture("sw_vers", &["-productVersion"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        Ok(OsRead {
            platform: "macos".to_string(),
            version,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(OsRead {
            platform: std::env::consts::OS.to_string(),
            version: String::new(),
        })
    }
}

/* --------------------------------- commands --------------------------------- */

/// Run one blocking read off the main thread. A synchronous Tauri command runs
/// on the main thread, and `read_graphics` on an Intel Mac is a
/// multi-second `system_profiler` — long enough to freeze the window it is
/// drawing.
async fn off_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the read panicked: {e}"))?
}

/// The four reads are four commands rather than one, and that is the point:
/// the flow takes them one at a time so the screen can say which one it is
/// waiting on, and so a single refusal costs its own field and not the screen.

#[tauri::command]
pub async fn read_memory() -> Result<MemoryRead, String> {
    off_thread(read_memory_blocking).await
}

#[tauri::command]
pub async fn read_graphics() -> Result<GraphicsRead, String> {
    off_thread(read_graphics_blocking).await
}

#[tauri::command]
pub async fn read_disk(path: String) -> Result<DiskRead, String> {
    off_thread(move || read_disk_blocking(&path)).await
}

#[tauri::command]
pub async fn read_power() -> Result<PowerRead, String> {
    off_thread(read_power_blocking).await
}

#[tauri::command]
pub async fn read_os() -> Result<OsRead, String> {
    off_thread(read_os_blocking).await
}

/* ---------------------------------- network ---------------------------------- */

/// What the network is short of. The lane ask, and the thing that makes
/// composition possible.
///
/// Returns `GET /demand/gaps` verbatim as JSON.
#[tauri::command]
pub async fn network_recommend() -> Result<String, String> {
    off_thread(|| run_common("recommend", &[], true)).await
}

/// This machine's registration, and whether the gateway can currently see it.
///
/// `{"joined": bool, "identity": {...}, "node": {...} | null}` — and a `node` of
/// `null` with `joined: true` is the honest "registered once, not reachable
/// now" that the join screen has a state for.
#[tauri::command]
pub async fn network_status() -> Result<String, String> {
    off_thread(|| run_common("status", &[], true)).await
}

/// This machine's node identity, or the JSON literal `null` when it has never
/// joined. `common` prints `null` rather than an empty string, which is why
/// this is a `String` and not an `Option`.
#[tauri::command]
pub async fn network_whoami() -> Result<String, String> {
    off_thread(|| run_common("whoami", &[], true)).await
}

/// How many questions this machine has answered. The contribution figure, and
/// the only reward the flow shows for it.
#[tauri::command]
pub async fn network_contrib() -> Result<String, String> {
    off_thread(|| run_common("contrib", &[], true)).await
}

/// Deregister this machine and forget its identity.
///
/// **Why this no longer runs `common leave`.** It did, and it did nothing.
/// `cmd_leave` in `common.py` is a tool for a *permanent* install: it runs
/// `join.py --remove-permanent`, which dispatches to a launchd, systemd or Task
/// Scheduler service and nothing else, and this app joins in the foreground
/// instead. So there is no service to remove, and the verb prints "no background
/// service found … press Ctrl+C there to leave." — with nothing deleted — and
/// then exits 0 while saying so.
///
/// `run_common` reads failure off the exit status, so the zero became a success.
/// The card said "This machine has left the network." while the identity file
/// survived, the node stayed registered and the join went on serving — and the
/// next read of `whoami` put the machine straight back on the card. That is the
/// whole of "the leave network button doesn't do anything": a button reporting
/// the truth about a command that had never been asked the right question.
///
/// So the teardown is done here, and it is the same three things `join.py` does
/// when it is interrupted — stop the process, deregister the node, forget the
/// identity — in that order, because `join.py` re-registers from its own loop
/// and would put the node back between the second step and the third.
#[tauri::command]
pub async fn network_leave() -> Result<String, String> {
    off_thread(|| {
        let home = home_dir()?;
        let dir = home.join(".common-network");

        // Read before stopping anything. `join.py`'s own handler deletes this
        // file, and the token inside it is the only thing that can take the node
        // off the gateway — so a copy taken first is what lets the fallback below
        // finish a job the signal started, and is also what tells us afterwards
        // whether there was a job at all.
        let credentials = identity_credentials(&dir);

        let stopped = stop_join(&dir)?;

        // Two ways to arrive here with work left. Nothing was running, so no
        // handler ran and nothing was deregistered or forgotten; or something was
        // signalled and did not stop, which on Windows is the expected shape
        // rather than the strange one, there being no SIGTERM to deliver.
        let gone = if dir.join("identity.json").exists() {
            let removed = match &credentials {
                // Best effort, and deliberately not fatal: a machine that cannot
                // reach the gateway must still be able to leave locally, or an
                // outage out there would strand the user on the network.
                Some(credentials) => deregister(credentials).is_ok(),
                // An identity that cannot be read cannot be used to deregister —
                // but it can still be forgotten, which is the half of leaving
                // that is this machine's to do.
                None => false,
            };
            forget(&dir)?;
            removed
        } else {
            // The handler got there first, and it only deletes the file after its
            // own DELETE has been attempted. So this is the network's answer, as
            // far as anything on this side can know it — the CLI swallows that
            // request's failure for the same reason we do, and neither of us can
            // see past the far side of a request that was never answered.
            credentials.is_some()
        };

        Ok(match (credentials.is_some(), gone) {
            (true, true) => "This machine has left the network.".to_string(),
            (true, false) => {
                "This machine has stopped contributing, but the network couldn't be reached to \
                 remove it — it may stay listed until the network notices."
                    .to_string()
            }
            (false, _) if stopped => "This machine has stopped contributing.".to_string(),
            (false, _) => "This machine was not on the network.".to_string(),
        })
    })
    .await
}

/* -------------------------------- leaving --------------------------------- */

/// The gateway, node id and token, for the one caller allowed to spend them.
///
/// `read_identity` cannot return the token and that is on purpose — see
/// `IdentitySummary`, where the reason is written down. This is a second reader
/// rather than a widened first one, and the separation is the point: the report
/// path cannot leak a credential by construction, while this path exists to use
/// one, once, in a request header. Nothing it returns is ever formatted into a
/// message that reaches the screen.
struct Credentials {
    gateway: String,
    node_id: String,
    token: String,
}

fn identity_credentials(dir: &std::path::Path) -> Option<Credentials> {
    let raw = std::fs::read_to_string(dir.join("identity.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let text = |key: &str| {
        parsed
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(Credentials {
        gateway: text("gateway")?,
        node_id: text("node_id")?,
        token: text("node_token")?,
    })
}

/// Take this node off the gateway.
///
/// The same `DELETE /nodes/{id}` with the same header that `join.py` makes when
/// it is interrupted, and with the same five-second patience — the gateway is a
/// donated machine away, and a click that hangs is worse than one that gives up
/// and says so. `curl` rather than an HTTP client, like every other request this
/// file makes; see the module note on new dependencies.
fn deregister(credentials: &Credentials) -> Result<(), String> {
    let url = format!(
        "{}/nodes/{}",
        credentials.gateway.trim_end_matches('/'),
        credentials.node_id
    );
    let out = silent("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "5",
            "--request",
            "DELETE",
        ])
        .arg("--header")
        .arg(format!("X-Common-Node-Token: {}", credentials.token))
        .arg(&url)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("couldn't run curl: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("the gateway answered {}", out.status)
    } else {
        stderr
    })
}

/// Forget this machine's identity, whether or not the network was told.
///
/// NotFound is success: the join's own handler removes the same file, and a race
/// between the two is the expected case rather than a fault. A failure to unlink
/// is not, because an identity that survives its own removal puts the machine
/// back on the network at the next read — which is the bug this whole command
/// exists to stop.
fn forget(dir: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(dir.join("identity.json")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("couldn't forget this machine's identity: {e}")),
    }
}

/// Stop whatever is serving this machine, and say whether anything was found.
///
/// **Signalled rather than reimplemented**, because `join.py` already knows how
/// to leave: its SIGINT/SIGTERM handler deregisters the node, clears the identity
/// and stops the tunnel, and that is the same path Ctrl+C takes — the very thing
/// the CLI's own "press Ctrl+C there to leave" points at. Doing it through the
/// process means the tunnel is closed by the code that opened it, which a
/// reimplementation here could not do without learning how the tunnel is tracked.
fn stop_join(dir: &std::path::Path) -> Result<bool, String> {
    let pids = join_processes(dir);
    if pids.is_empty() {
        return Ok(false);
    }

    let identity = dir.join("identity.json");
    let had_identity = identity.exists();

    for pid in &pids {
        terminate(*pid);
    }

    // Waited on by looking for the file the handler removes, rather than by
    // asking after each pid every second. That was the shape this file already
    // grew out of: `kill -0` on Windows is a fresh `tasklist` whose answer this
    // process cannot check, and on unix it is a subprocess a second for as long
    // as the wait lasts. The file is one `stat`, and it is the thing the caller
    // was going to look at next anyway.
    //
    // Seven seconds, because the handler's own DELETE has a five-second timeout
    // and is attempted before the file goes. A join that never wrote an identity
    // gets a shorter, fixed grace instead: there is nothing to watch for, and a
    // polite signal still needs *some* time before the hard one follows it.
    let patience = if had_identity { 70 } else { 10 };
    for _ in 0..patience {
        if had_identity && !identity.exists() {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Still there, so no handler ran: the process could not be signalled politely
    // (Windows has nothing that reaches Python's `SIGTERM` handler) or it is
    // wedged. Either way nothing here is going to leave on its own now, and a
    // machine that has been told to leave must not go on answering other
    // people's questions because a process declined to stop.
    for pid in &pids {
        kill_join(*pid);
    }
    Ok(true)
}

/// The pids running *this* machine's join, found by the script it runs.
///
/// By path rather than by name: matching `join.py` alone would find a join
/// belonging to a second account, a second install, or a stray checkout — and
/// leaving is not something that should be able to stop somebody else's node.
///
/// The app holds the `Child` it spawned (see `Join`), and on unix that child *is*
/// the join. It is not used here because it is the wrong shape for this question:
/// it lives in memory only, so a join started by a previous run of the app —
/// the ordinary case, a join outliving the window that started it — has no handle
/// at all; and on Windows it is the batch wrapper, which has already exited by
/// design. A search by path answers for every join, on either platform and from
/// either run, and one mechanism that always answers beats two that each answer
/// half the time.
#[cfg(unix)]
fn join_processes(dir: &std::path::Path) -> Vec<u32> {
    // The whole process list, matched here rather than in the query, for the same
    // reason the Windows branch below does it this way. `pgrep -f` takes an
    // extended regular expression, and a home directory is a path and not a
    // pattern: a `.` in a username is a wildcard to it, and a `+` — legal in a
    // Linux username — makes it a malformed pattern that exits with nothing on
    // stdout. An empty answer there is indistinguishable from "nothing is
    // running", which is the failure this whole section exists to remove. So `ps`
    // is asked for the list and the comparison is a plain substring test.
    let Ok(out) = silent("ps").args(["-Ao", "pid=,command="]).output() else {
        return Vec::new();
    };
    let script = dir.join("join.py").to_string_lossy().to_string();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| line.contains(&script))
        .filter_map(|line| line.split_whitespace().next())
        .filter_map(|pid| pid.parse::<u32>().ok())
        .collect()
}

#[cfg(windows)]
fn join_processes(dir: &std::path::Path) -> Vec<u32> {
    // Every process with its command line, filtered here rather than in the
    // query. A `Where-Object` would have to carry this machine's home directory
    // into a PowerShell string, where a backslash, a quote or a space in a
    // username breaks it — and a filter that quietly matches nothing looks
    // exactly like "nothing is running", which is the failure mode this whole
    // change is about.
    let Ok(out) = silent("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)\t$($_.CommandLine)\" }",
        ])
        .output()
    else {
        return Vec::new();
    };
    // Case-insensitively, because Windows does not distinguish the two in a path
    // and PowerShell will not have normalised the casing it reports.
    let script = dir.join("join.py").to_string_lossy().to_ascii_lowercase();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| line.to_ascii_lowercase().contains(&script))
        .filter_map(|line| line.split('\t').next()?.trim().parse::<u32>().ok())
        .collect()
}

/// Neither unix nor Windows, which are the two this app is built for. An empty
/// answer is the honest one: nothing here knows how to look.
#[cfg(not(any(unix, windows)))]
fn join_processes(_dir: &std::path::Path) -> Vec<u32> {
    Vec::new()
}

/// Ask a process to stop, so that it gets to run its own cleanup.
#[cfg(unix)]
fn terminate(pid: u32) {
    // SIGTERM and not SIGKILL, which is the whole point of the exercise: the
    // handler it triggers is what deregisters the node, forgets the identity and
    // closes the tunnel. Ending the process outright would leave all three.
    let _ = silent("kill").arg("-TERM").arg(pid.to_string()).status();
}

#[cfg(windows)]
fn terminate(pid: u32) {
    // Without `/F`, which is as close to a polite request as Windows offers. It is
    // not SIGTERM and Python's handler does not run for it, so the caller has to
    // be ready for the process still being there afterwards — the hard ending
    // below and the fallback in `network_leave` are both written for that.
    let _ = silent("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .status();
}

#[cfg(not(any(unix, windows)))]
fn terminate(_pid: u32) {}

/// End a process that would not go. `/T` on Windows takes the children with it,
/// which is what stops an orphaned tunnel outliving the node it belonged to.
#[cfg(unix)]
fn kill_join(pid: u32) {
    let _ = silent("kill").arg("-KILL").arg(pid.to_string()).status();
}

#[cfg(windows)]
fn kill_join(pid: u32) {
    let _ = silent("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .status();
}

#[cfg(not(any(unix, windows)))]
fn kill_join(_pid: u32) {}

/// Ask the local model something, through the same path the CLI uses.
///
/// This is the contribution proof: not "the network answered" but "this machine
/// answered", which is the thing being joined. `--local` keeps it off the
/// network entirely — the point is to prove the model here runs, and routing the
/// question through the gateway would prove something else.
#[tauri::command]
pub async fn network_ask_local(question: String, model: Option<String>) -> Result<String, String> {
    off_thread(move || {
        // Nothing is waited on here, and something used to be: this asked the
        // daemon whether it was up and started it if it was not, because on a
        // fresh install it could still be coming up. The CLI answers this from
        // `llama-server` now, which the join starts and supervises itself, so
        // there is nothing on this machine for the app to wake and no address
        // here for it to probe. When the model is not up the CLI says so in its
        // own words, and those are the better words — they come from the layer
        // that knows why.
        let Cli {
            mut cmd,
            named: bin,
        } = cli()?;
        // `--local` is a top-level flag and therefore must precede the verb; see
        // the REMAINDER note on `run_common`.
        cmd.arg("--no-color")
            .arg("--no-update")
            .arg("--local")
            .arg("--json");
        if let Some(m) = model.as_deref() {
            cmd.arg("--model").arg(m);
        }
        cmd.arg("ask").arg(&question);
        cli_env(&mut cmd);

        let out = cmd.output().map_err(|e| launch_error(&bin, e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "the local model didn't answer".to_string()
            } else {
                stderr
            });
        }
        // `ask` writes "asking <model> locally (never leaves this machine)" to
        // stdout ahead of its JSON — see `last_json`.
        Ok(last_json(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
}

/* ---------------------------- stopping a question ---------------------------- */

/// Bumped to let go of the question that is out on the network.
///
/// A counter and not a flag, because a flag races the question after it. The app
/// sends one question at a time, but a stop is followed by a new question within
/// a second or two, and a plain bool would be reset by the new question before
/// the old process had looked at it — leaving the old one running and letting
/// the new one see a change meant for somebody else. Each question takes a
/// reading as it starts and dies when the number moves, so only the question
/// actually out can see its own change.
static ASK_EPOCH: AtomicU64 = AtomicU64::new(0);

/// How often the wait looks up from the question to check it is still wanted.
/// Fast enough to feel immediate, slow enough not to spin a core while a machine
/// loads its weights.
const ASK_POLL: Duration = Duration::from_millis(150);

/// Let go of the question that is out on the network.
///
/// The CLI waits up to `REQUEST_TIMEOUT_SECONDS` — 240s, in `common.py` — for a
/// routed answer, and the app inherits every one of those seconds. That is a
/// long time to hold a machine, and on a network of a few donated laptops it is
/// a machine somebody else's question could be using: abandoning a question
/// without releasing the node it landed on is not a smaller thing than
/// answering it. So this kills the process rather than only looking away.
#[tauri::command]
pub fn network_ask_stop() {
    ASK_EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// Ask the network something, exactly as `common ask` does.
///
/// The consumer side of the product, and the one the chat uses. There is no
/// `--local` here and no `--model`, and both omissions are the whole of it:
/// the question goes to the gateway, which routes it to whichever machine on
/// the network is the best fit for what was actually asked.
///
/// `--local` is a different product. It talks past the network to whatever this
/// machine is serving and takes the first model on offer — so a machine
/// contributing a maths model answers "hey" with mathematics. This machine
/// contributes one specialist; the
/// network is what holds the rest, and answering from the one we happen to be
/// sitting on is not a smaller version of that — it is a different thing.
///
/// Nor is `--model` the way to name one. On this side of the CLI it does not
/// mean "prefer", it means "a node serving this and nothing else", and the CLI
/// refuses rather than reroute when none is up: a pin, not a nudge. The app has
/// no business pinning, so it passes neither flag and lets the router work.
///
/// The question does leave this machine — that is what routing is — and the
/// greeting in the transcript says so.
#[tauri::command]
pub async fn network_ask(question: String) -> Result<String, String> {
    off_thread(move || {
        let Cli {
            mut cmd,
            named: bin,
        } = cli()?;
        cmd.arg("--no-color").arg("--no-update").arg("--json");
        cmd.arg("ask").arg(&question);
        cmd.env("NO_COLOR", "1");
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        // Read before the spawn, so a stop landing between the two is seen
        // rather than missed.
        let epoch = ASK_EPOCH.load(Ordering::SeqCst);

        let mut child = cmd.spawn().map_err(|e| launch_error(&bin, e))?;

        // Both pipes are drained by their own threads for the whole of the wait
        // below. `Command::output` drains them too, but it waits without a way
        // out — and a pipe nobody reads fills at 64 KiB and stops whatever is
        // writing to it, which here would be the process this thread is waiting
        // on.
        let mut out_pipe = child.stdout.take();
        let mut err_pipe = child.stderr.take();
        let out_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(pipe) = out_pipe.as_mut() {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        });
        let err_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(pipe) = err_pipe.as_mut() {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        });

        let (stopped, status) = loop {
            if ASK_EPOCH.load(Ordering::SeqCst) != epoch {
                let _ = child.kill();
                let _ = child.wait();
                break (true, None);
            }
            match child.try_wait() {
                Ok(Some(done)) => break (false, Some(done)),
                Ok(None) => std::thread::sleep(ASK_POLL),
                Err(e) => {
                    // Nothing can be read from a wait that has failed, and
                    // leaving the child behind would leave it holding a node.
                    let _ = child.kill();
                    let _ = child.wait();
                    // Not `launch_error`: this child started, and a wait that
                    // fails is not a missing install however it is spelled. The
                    // sentence there is reserved for a launch, where the two
                    // readings it distinguishes are both live.
                    return Err(format!("couldn't run {}: {e}", bin.display()));
                }
            }
        };

        let stdout = out_reader.join().unwrap_or_default();
        let stderr = err_reader.join().unwrap_or_default().trim().to_string();

        // The transcript dropped this question the moment it was stopped, so
        // the wording below only has to be legible in a log.
        if stopped {
            return Err("stopped".to_string());
        }
        if !matches!(status, Some(done) if done.success()) {
            return Err(if stderr.is_empty() {
                "the network didn't answer".to_string()
            } else {
                stderr
            });
        }
        // Ahead of the JSON, `ask` prints "plotting request into vector space"
        // — see `last_json`.
        Ok(last_json(&stdout))
    })
    .await
}

/// Start contributing, and return immediately.
///
/// `common join` does not return: it `os.execv`s into `join.py`, which pulls the
/// model, opens a tunnel and then loops for as long as the machine is
/// contributing. So this spawns it and hands back the moment it is running,
/// leaving the caller to find out how it went by polling `network_status` — the
/// gateway's own answer, rather than this process's opinion of itself.
///
/// The child's output goes to a log file rather than to a pipe nobody drains,
/// which would fill its buffer and wedge it. That file holds the only account of a
/// join that fails out there, and `diagnostics` reads its tail back so a failure
/// reaches the user as text rather than as a silent nothing.
///
/// What comes back is not the join's outcome but the log's length at the moment it
/// started — the byte this attempt's first word lands on. It is the caller's handle on
/// *which* join a later `network_join_tail` is reading about, and it is needed because
/// the file outlives the attempt. The `Child` is kept, in `Join`, rather than dropped
/// with a pid handed back to the caller: a pid is only ever a number to be re-found,
/// and re-finding it means a second program — `tasklist` on Windows, `kill -0`
/// elsewhere — whose answer this process has no way to check. See `JoinState`, which is
/// what that cost.
#[tauri::command]
pub async fn network_join(
    app: tauri::AppHandle,
    model: Option<String>,
    name: Option<String>,
    lan: bool,
) -> Result<u64, String> {
    off_thread(move || {
        // Resolved before the log is opened: a machine with neither a Python this
        // app trusts nor an installed CLI should fail with the launch sentence,
        // rather than leaving behind a join log describing a join that never began.
        let Cli {
            mut cmd,
            named: bin,
        } = cli()?;

        let home = home_dir().map_err(|_| "no home to write the join log to".to_string())?;
        let dir = home.join(".common-network");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
        let log_path = dir.join("join.log");
        // Appended to, never truncated. The flow retries a join that dies young,
        // and a second attempt that wiped the first one's trace would destroy the
        // only account of why the retry was needed at all — which is the single
        // most useful thing this file holds when the far side is slow rather than
        // down, since two attempts failing identically is what distinguishes a
        // flaky gateway from a one-off. Nothing writes here once a join is up, so
        // the growth is one startup's worth per attempt.
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("couldn't open {}: {e}", log_path.display()))?;
        let log_err = log
            .try_clone()
            .map_err(|e| format!("couldn't duplicate the log handle: {e}"))?;

        // Where this attempt begins in the file, handed back so a later read can be
        // confined to this attempt's own bytes. The log is appended to across attempts
        // and across runs, so without this offset a tail read is free to resurrect a
        // `✗` from a join that died an hour ago and offer it as this one's cause —
        // which is how a merely-slow join becomes a confident, wrong sentence.
        let start = log
            .metadata()
            .map_err(|e| format!("couldn't measure {}: {e}", log_path.display()))?
            .len();

        cmd.arg("--no-color").arg("--no-update").arg("join");
        if let Some(m) = model.as_deref() {
            cmd.arg("--model").arg(m);
        }
        if let Some(n) = name.as_deref() {
            cmd.arg("--name").arg(n);
        }
        if lan {
            // The computer-lab path: no tunnel, nothing exposed to the internet.
            cmd.arg("--lan");
        } else {
            // Unattended: `join` otherwise stops at a prompt for the model, and
            // a GUI has no terminal to answer it with.
            cmd.arg("--auto");
        }
        cli_env(&mut cmd);
        cmd.stdout(Stdio::from(log));
        cmd.stderr(Stdio::from(log_err));
        cmd.stdin(Stdio::null());

        // The failure that says the least and needs to say the most — see
        // `launch_error`, where the sentence for a missing CLI is written.
        let child = cmd.spawn().map_err(|e| launch_error(&bin, e))?;

        // Held, not dropped. Whatever is in the slot is a join this app started
        // and has stopped asking about — the flow spawns at most one per run now —
        // and a stale handle is overwritten here rather than consulted.
        *app.state::<Join>()
            .0
            .lock()
            .map_err(|_| "the join handle is poisoned".to_string())? = Some(child);

        Ok(start)
    })
    .await
}

/* -------------------------------- catalogue -------------------------------- */

/// The gateway this build talks to when no identity says otherwise.
///
/// Same string as `DEFAULT_GATEWAY` in `common.py` and `join.py`. It is a
/// fallback and not the source of truth: a machine that has joined carries the
/// gateway it joined in its identity, and the catalogue must come from *that*
/// gateway — a build pointed at a staging gateway by an environment variable
/// would otherwise size its downloads against production.
const DEFAULT_GATEWAY: &str = "https://gateway-production-b820.up.railway.app";

/// The gateway this machine has joined, or the default.
fn gateway_base() -> String {
    let Ok(home) = home_dir() else {
        return DEFAULT_GATEWAY.to_string();
    };
    let path = home.join(".common-network/identity.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return DEFAULT_GATEWAY.to_string();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return DEFAULT_GATEWAY.to_string();
    };
    match parsed.get("gateway").and_then(|g| g.as_str()) {
        Some(gateway) if !gateway.is_empty() => gateway.to_string(),
        _ => DEFAULT_GATEWAY.to_string(),
    }
}

/// The models the network is willing to run, verbatim.
///
/// The app has its own ladder — six models with the labels and the sizes the
/// screens were drawn against — and every one of those ids is an id in this
/// catalogue. What the ladder does not carry is the tag each id is asked for by,
/// and that mapping is the network's to know: `qwen2.5-math-7b` is
/// `mightykatun/qwen2.5-math:7b`, which no rule derives from the id. So the app
/// asks this, and falls back to treating the id as the tag.
///
/// It is here rather than in the webview for the reason the header gives: the
/// gateway sends no CORS headers, so a page cannot fetch it and Rust can.
#[tauri::command]
pub async fn network_catalogue() -> Result<String, String> {
    off_thread(|| {
        let url = format!("{}/catalogue", gateway_base());
        let out = silent("curl")
            .args([
                "--silent",
                "--show-error",
                "--fail",
                "--location",
                "--max-time",
                "20",
                "--header",
                "Accept: application/json",
                &url,
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("couldn't run curl: {e}"))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("the catalogue request failed ({})", out.status)
            } else {
                stderr
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

/* ------------------------------ a live join ------------------------------ */

/// The join this app started, if it started one.
///
/// `Mutex<Option<Child>>` rather than a bare `Option<Child>`: `Child` is `Send`
/// but not `Sync`, so Tauri cannot manage it except behind a lock. Nothing here
/// is contended — the flow asks once a second — so the mutex is for the type
/// system rather than for the scheduling.
///
/// A finished child is left in the slot rather than cleared. `Child::try_wait`
/// caches the status, so a join that has ended answers the same way every time it
/// is asked, and the answer stays worth having: it is what the screen puts in its
/// disclosure line.
#[derive(Default)]
pub struct Join(Mutex<Option<Child>>);

/// What became of the join this app started.
///
/// Four answers, and `HandedOff` is the one this type exists for.
///
/// On unix the process spawned *is* the join. `common` is a shell script whose
/// last act is to `exec` the Python CLI, and `os.execv` replaces the process image
/// while keeping the pid, so `try_wait` returning nothing means the join is
/// working and returning a status means it has stopped. `kill -0` agreed with
/// this, at the price of a subprocess a second.
///
/// On Windows neither of those holds. `install.ps1` writes `common.cmd`, a batch
/// wrapper, and `Command` runs it through `cmd.exe` — so the program this app
/// holds is three layers away from the join. The wrapper's last act is to run the
/// Python CLI, which `os.execv`s into `join.py`, and on Windows that leaves a
/// process rather than replacing one. The program this app holds therefore exits,
/// cleanly and at once, by design — while the join it started carries on under a
/// pid nothing here was ever given.
///
/// Read as a death, that is the worst available reading. A friend's machine did
/// exactly this: the node was registered, the worker was listening, `/peers` listed
/// it, and the app had already spent all three of its attempts and put "the network
/// didn't answer" on screen about a network that plainly had. A pid is also a
/// locale-dependent text search to re-find on Windows, which is a second way to be
/// wrong in the same direction.
///
/// So the platform decides, here, where it is known — rather than on the far side of
/// the boundary, which would have to guess.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum JoinState {
    /// This app has not started a join.
    None,
    /// Still going. On Windows that means only that it has not handed off yet.
    Running,
    /// Exited cleanly, having handed off to a program this app cannot see. Windows
    /// only, and success rather than failure: the join is out there, and `network_status`
    /// is what says whether it arrived.
    HandedOff,
    /// Exited without handing off, so nothing this app started is serving.
    Ended { code: String },
}

/// What a finished child means, from its exit code and the platform.
///
/// A clean exit on Windows is the batch wrapper having done its job: `cmd.exe`
/// leaves with the status of the command it ran, and that command handed off. A
/// clean exit anywhere else is the join itself having stopped, which is news.
///
/// The two inputs are arguments rather than read from the environment so that a
/// test on any platform can pin every answer — the same reason `common_names`
/// takes `windows` instead of a `cfg!`. Windows is where this went wrong and is
/// the platform least likely to be the one running the suite.
///
/// The exit code is the single most useful fact about a join that stopped, and on
/// Windows close to the only one: a wrapper that failed to hand off is a batch file
/// that could not run Python, and the number is what says so.
fn finished(windows: bool, code: Option<i32>) -> JoinState {
    if windows && code == Some(0) {
        return JoinState::HandedOff;
    }
    JoinState::Ended {
        code: match code {
            Some(code) => format!("exit code {code}"),
            // No code means it was ended by a signal, which on unix is the only
            // way that happens — and there is no number to report.
            None => "ended by a signal".to_string(),
        },
    }
}

/// What the join this app started is doing now.
///
/// One `waitpid(WNOHANG)` or one `GetExitCodeProcess`, and no subprocess at all —
/// where asking after a pid cost a fresh `tasklist` or `kill` every second for four
/// minutes, and on Windows cost the answer too.
#[tauri::command]
pub async fn network_join_state(app: tauri::AppHandle) -> Result<JoinState, String> {
    let state = app.state::<Join>();
    let mut slot = state
        .0
        .lock()
        .map_err(|_| "the join handle is poisoned".to_string())?;
    let Some(child) = slot.as_mut() else {
        return Ok(JoinState::None);
    };
    match child.try_wait() {
        Ok(None) => Ok(JoinState::Running),
        Ok(Some(status)) => Ok(finished(cfg!(windows), status.code())),
        // Asking failed, which is not evidence of anything. `Running` here means
        // "keep waiting", never "it is up" — the caller reads it as one of the two
        // states that do not spend a retry, and the gateway is what decides whether
        // the join arrived. Guessing the other way would spend one of three
        // attempts against a join that may be fine, which is the bug being fixed.
        Err(_) => Ok(JoinState::Running),
    }
}

/* ------------------------------- diagnostics -------------------------------- */

/// This machine's place on the network, dismantled into named fields.
///
/// `node_token` is deliberately not among them. It is the credential that stands
/// for this node at the gateway, and a diagnostics report is a thing that ends up
/// pasted into a chat window or an email. It is absent **by construction** here
/// rather than stripped by a string pass over `identity.json`, because a pass is
/// something a later edit can forget to update and a field that was never read
/// cannot be leaked by one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySummary {
    pub gateway: Option<String>,
    pub name: Option<String>,
    pub node_id: Option<String>,
    pub catalogue_id: Option<String>,
    pub domain_tags: Vec<String>,
    /// Unix seconds, as the CLI writes it. Left as a number so that the web layer
    /// can put it in the reader's own timezone, which this side cannot.
    pub joined_at: Option<f64>,
}

/// What the app can say about itself and this machine, for someone who has to be
/// shown rather than told.
///
/// Three rules shape the whole of it:
///
/// — **It never uses the network.** A report is asked for precisely when nothing
///   can be reached, so it answers from disk and from this process alone. There is
///   no reachability probe here and there must not be one: a report that hangs for
///   thirty seconds at the moment it is most needed is worse than no report.
///
/// — **It cannot carry the node token.** See `IdentitySummary`.
///
/// — **Nothing in it is fatal.** Every field but the app's own version is an
///   `Option` or carries its own error, because the report worth having is the one
///   from the machine where things are missing. A machine that has never joined,
///   whose CLI is absent, and whose log is empty still produces a full report — and
///   that report says exactly that.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: String,
    /// The bundle identifier, which is what identifies this build to anything
    /// that has to look it up.
    pub app_identifier: String,
    pub os_platform: String,
    pub os_version: String,
    pub cli_version: Option<String>,
    /// The path the app actually ran, which is the first thing to check when the
    /// CLI on `PATH` is not the one the app is using.
    pub cli_path: String,
    pub gateway: String,
    pub joined: Option<IdentitySummary>,
    pub identity_path: String,
    /// Why the identity could not be read, when it could not. `joined: None` with
    /// no error means the file is simply not there — never joined.
    pub identity_error: Option<String>,
    pub log_path: String,
    pub log_bytes: Option<u64>,
    /// Unix seconds, for the same reason `joined_at` is a number.
    pub log_modified: Option<u64>,
    /// The end of the join log, which is where a failure is. `None` when the file
    /// is not there.
    pub log_tail: Option<String>,
    pub log_error: Option<String>,
}

/// How many lines of the join log a report carries. Long enough to hold a Python
/// traceback whole, which is what a failing join actually leaves behind.
const REPORT_LOG_LINES: usize = 120;

#[tauri::command]
pub async fn diagnostics(app: tauri::AppHandle) -> Result<Diagnostics, String> {
    // Read off the handle before the work is moved to a thread, since the closure
    // then needs nothing that is borrowed from it.
    let app_version = app.package_info().version.to_string();
    let app_identifier = app.config().identifier.clone();

    off_thread(move || {
        let os = read_os_blocking().unwrap_or(OsRead {
            platform: std::env::consts::OS.to_string(),
            version: String::new(),
        });

        let (joined, identity_path, identity_error) = read_identity();
        let (log_path, log_bytes, log_modified, log_tail, log_error) = read_join_log();

        Ok(Diagnostics {
            app_version,
            app_identifier,
            os_platform: os.platform,
            os_version: os.version,
            cli_version: cli_version(),
            cli_path: cli_path(),
            gateway: gateway_base(),
            joined,
            identity_path,
            identity_error,
            log_path,
            log_bytes,
            log_modified,
            log_tail,
            log_error,
        })
    })
    .await
}

/// The identity, taken apart. See `IdentitySummary` for why it is not forwarded.
fn read_identity() -> (Option<IdentitySummary>, String, Option<String>) {
    let path = match home_dir() {
        Ok(home) => home.join(".common-network/identity.json"),
        Err(e) => return (None, String::new(), Some(e)),
    };
    let shown = path.to_string_lossy().to_string();

    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        // Never having joined is `None` and no error: it is a state, not a fault,
        // and a report that called it one would send somebody looking for a bug.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (None, shown, None),
        Err(e) => {
            // Written out before the tuple, because the tuple moves `shown` into
            // its second slot and the message borrows it.
            let why = format!("couldn't read {shown}: {e}");
            return (None, shown, Some(why));
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(e) => {
            let why = format!("{shown} wasn't JSON: {e}");
            return (None, shown, Some(why));
        }
    };
    if parsed.is_null() {
        return (None, shown, None);
    }

    let text = |key: &str| {
        parsed
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    let summary = IdentitySummary {
        gateway: text("gateway"),
        name: text("name"),
        node_id: text("node_id"),
        catalogue_id: text("catalogue_id"),
        domain_tags: parsed
            .get("domain_tags")
            .and_then(|v| v.as_array())
            .map(|tags| {
                tags.iter()
                    .filter_map(|t| t.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        joined_at: parsed.get("joined_at").and_then(|v| v.as_f64()),
    };
    (Some(summary), shown, None)
}

/// How much of the join log a failing join is judged on. Shorter than a report's
/// because this is read to answer one question — did it stop, and saying what — and
/// a traceback's last frames plus a `die_with_fix` sentence are the whole of it.
const JOIN_TAIL_LINES: usize = 20;

/// The end of `join.log`, for a join that never arrived.
///
/// The app cannot witness a join dying on Windows: the process it holds is a batch
/// wrapper that exits cleanly having handed off, so `network_join_state` reports
/// `HandedOff` and has nothing to say about the join itself. The file the CLI writes is
/// then the only account there is — which is why reading it is what turns "the gateway
/// never listed this machine" from a guess into a report. A self-trial watched the full
/// four minutes of that sentence while a `✗` sat here from the first second — the join
/// had died in under one, on a missing tool, before it reached the network at all.
///
/// `from` is that attempt's `start`, the byte `network_join` measured when it spawned it,
/// so what comes back is this attempt's words and never an older attempt's. See there for
/// why the file's history has to be excluded rather than merely tolerated.
///
/// `None` is a machine that has never joined — a different thing from a join that left
/// no trace, and not a case to invent a sentence for.
#[tauri::command]
pub async fn network_join_tail(from: u64) -> Result<Option<String>, String> {
    let path = home_dir()?.join(".common-network").join("join.log");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("couldn't read {}: {e}", path.display())),
    };
    Ok(Some(tail_from(&raw, from, JOIN_TAIL_LINES)))
}

/// How much of an attempt's log a progress read looks back through. Small on
/// purpose: while a download is running its marks *are* the newest lines, so a
/// deeper look could only reach past the end of a finished one and report its
/// hundred as this one's.
const JOIN_PROGRESS_LINES: usize = 4;

/// The CLI's progress line, as the join screen draws it.
///
/// The weights are fetched by the CLI as part of joining, so the app has no stream
/// of its own to count bytes on — Ollama's pull was the last of those, and it went
/// with the daemon. What is here instead is the file the CLI already writes:
/// `_Progress` in `runtime.py` prints one ordinary line at each ten percent
/// whenever its output is not a terminal, and in the join this app starts it never
/// is. Reading that line is the whole mechanism, and deliberately the whole of it —
/// no new verb, no second account of what has been fetched, and so nothing for the
/// two sides to disagree about.
#[derive(Serialize)]
pub struct JoinFetch {
    /// What is arriving, in the CLI's own words: the weights' wire name, or
    /// `the llama.cpp runtime (b11700)`. Carried rather than translated, because
    /// the app has no better name for it than the layer that went to get it.
    name: String,
    percent: u32,
    /// The sizes as the CLI rendered them — `"1.2 GB"`, `"4.3 GB"`. Strings,
    /// because re-deriving bytes from the first would be inventing precision the
    /// count never had. See the argument at `service.ts`'s `JoinProgress.fetch`.
    done: String,
    total: String,
}

/// Where this attempt's download has got to, or `None` when the CLI has not said.
///
/// `None` is three different true things — no log at all, no fetch started, and a
/// fetch left to be re-read another day — and they are one answer to the screen,
/// because there is nothing to draw in any of them. A fetch that has *finished* is
/// deliberately not among them: the CLI's marks stop at the hundred and the line
/// saying so stays in the file for good, so a finished fetch reads as a hundred,
/// and the caller draws a percentage under a hundred or nothing at all.
///
/// Read from `from`, this attempt's first byte — `network_join`'s answer when it
/// spawned it — and by seeking to it rather than by slicing a whole-file read,
/// because this is called twice a second for as long as a multi-gigabyte download
/// lasts. `network_join_tail` reads the whole file for the opposite reason: it is
/// asked once, when a join has already died.
#[tauri::command]
pub async fn network_join_progress(from: u64) -> Result<Option<JoinFetch>, String> {
    let path = home_dir()?.join(".common-network").join("join.log");
    // A machine that has never joined has no log. That is not a failure and not a
    // sentence: it is a join with nothing to show yet.
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("couldn't read {}: {e}", path.display())),
    };
    // An offset the file cannot honour is a log that was rotated or rewritten, and
    // the honest answer to that is nothing — never the whole file, which would be
    // someone else's download reported as this one's. Failing the call instead
    // would put a sentence about the log over a download that is going fine.
    if file.seek(SeekFrom::Start(from)).is_err() {
        return Ok(None);
    }
    // An offset inside a character, or bytes that are not UTF-8 at all, land here
    // for the same reason and read the same way.
    let mut raw = String::new();
    if file.read_to_string(&mut raw).is_err() {
        return Ok(None);
    }
    Ok(progress_from(&raw, JOIN_PROGRESS_LINES))
}

/// The newest progress line in `raw`, read back into its parts.
///
/// The shape is fixed by the CLI — `runtime.py`'s `_Progress.update`, in the branch
/// it takes when its output is not a terminal — and is exactly:
///
/// ```text
///   <what>  <percent>%  <done> of <total>
/// ```
///
/// Two spaces between the fields, the percentage padded to three columns. Parsed
/// from the right, because `<what>` is free text — a wire name, or `the llama.cpp
/// runtime (b11700)` — and `<done>` is a rendered size that carries a space of its
/// own. A line that does not fit the shape is not this line, and that is what keeps
/// the join's ordinary output out of the answer: the percentage is the last thing
/// that has to parse, and only a mark has one. A failure sentence such as
/// `... stopped early (1.2 GB of 4.3 GB)` has the ` of ` and the sizes but no
/// percentage, and is refused for exactly that reason.
fn progress_from(raw: &str, lines: usize) -> Option<JoinFetch> {
    tail_lines(raw, lines).lines().rev().find_map(|line| {
        let (head, total) = line.trim().rsplit_once(" of ")?;
        let (head, done) = head.rsplit_once("  ")?;
        let (name, percent) = head.rsplit_once("  ")?;
        Some(JoinFetch {
            name: name.trim().to_string(),
            percent: percent.trim().trim_end_matches('%').parse().ok()?,
            done: done.trim().to_string(),
            total: total.trim().to_string(),
        })
    })
}

/// The last `lines` lines of the part of `raw` that a join starting at byte `from` wrote.
///
/// Sliced as bytes, which is sound because the offset is one the file itself produced — and
/// guarded all the same, because it is not sound *enough*. `from` crosses from the web layer,
/// and a slice into the middle of a character panics, where this app can only ever afford a
/// sentence.
///
/// An offset the file cannot honour — past its end, inside a character, not a number — reads
/// as the empty tail rather than as the whole file. That is the direction to fail in: a
/// missing answer is one the caller already has a fallback for, while an answer borrowed
/// from a previous attempt is the exact mistake this offset exists to prevent.
fn tail_from(raw: &str, from: u64, lines: usize) -> String {
    let start = usize::try_from(from)
        .ok()
        .filter(|f| *f <= raw.len() && raw.is_char_boundary(*f))
        .unwrap_or(raw.len());
    tail_lines(&raw[start..], lines).trim().to_string()
}

/// The join log's size, age and tail. Its *absence* is reported as the empty
/// answer rather than as an error, since a machine that has never joined has no
/// log and that is the normal case.
fn read_join_log() -> (
    String,
    Option<u64>,
    Option<u64>,
    Option<String>,
    Option<String>,
) {
    let path = match home_dir() {
        Ok(home) => home.join(".common-network/join.log"),
        Err(e) => return (String::new(), None, None, None, Some(e)),
    };
    let shown = path.to_string_lossy().to_string();

    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (shown, None, None, None, None);
        }
        Err(e) => {
            let why = format!("couldn't read {shown}: {e}");
            return (shown, None, None, None, Some(why));
        }
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let tail = tail_lines(&raw, REPORT_LOG_LINES);
            (shown, Some(meta.len()), modified, Some(tail), None)
        }
        Err(e) => {
            let why = format!("couldn't read {shown}: {e}");
            (shown, Some(meta.len()), modified, None, Some(why))
        }
    }
}

/// The last `lines` lines of `text`. The end is where a failure is.
fn tail_lines(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

/// The version out of `common --version`, which prints a block of ASCII art and
/// then, two lines from the bottom, the name and the version.
///
/// Read rather than assumed: `--version` is the CLI's own answer, it travels with
/// the CLI's self-updates, and the app does not otherwise track which version is
/// installed. `--no-update` keeps the call from reaching GitHub — this is the one
/// process this module starts that is allowed to be slow, and it is still local.
fn cli_version() -> Option<String> {
    let Cli { mut cmd, .. } = cli().ok()?;
    let out = cmd.arg("--no-update").arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    version_token(&String::from_utf8_lossy(&out.stdout))
}

/// The last whitespace-delimited token shaped like `v1.2.3`.
///
/// Searched from the end because the banner is full of words that are not
/// versions — "Common", "Alpha", "AGPL-3.0" — and the version is the last line
/// that has one.
fn version_token(text: &str) -> Option<String> {
    fn trim_edges(word: &str) -> &str {
        word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.')
    }
    text.split_whitespace()
        .rev()
        .map(trim_edges)
        .find(|word| {
            let rest = word.strip_prefix('v').unwrap_or(word);
            let groups: Vec<&str> = rest.split('.').collect();
            groups.len() == 3
                && groups
                    .iter()
                    .all(|g| !g.is_empty() && g.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_string)
}

/// Write a report somewhere the user can find it, and open that place.
///
/// The name is built by the web layer, which is the only side that knows the
/// reader's timezone; it is then narrowed to characters that cannot change which
/// directory the file lands in. A `..` or a separator arriving from a caller is
/// the one way this command could be made to write somewhere it was not asked to.
///
/// It goes to Downloads and not to `app_data_dir`, which is where the app's own
/// storage lives. The point of this file is that it leaves — it gets attached to
/// a message or dragged into a chat — and a user going back for it later looks in
/// the place they look for everything they have saved. The app's private folder
/// is the fallback for the system where Downloads cannot be resolved at all,
/// which is a real answer and a worse one, not an error.
///
/// The reveal is part of the same call rather than a second one, because a file
/// with nothing on screen pointing at it is a file the user will not find.
#[tauri::command]
pub async fn save_diagnostics(
    app: tauri::AppHandle,
    name: String,
    text: String,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let path_resolver = app.path();
    let dir = path_resolver
        .download_dir()
        .or_else(|_| path_resolver.app_data_dir())
        .map_err(|e| format!("nowhere to write a report: {e}"))?;
    let path = dir.join(format!("{}.txt", safe_stem(&name)));

    // `Downloads` is normally there already and the fallback normally is not, so
    // this is for the second one — and it is harmless for the first.
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    std::fs::write(&path, text).map_err(|e| format!("couldn't write {}: {e}", path.display()))?;

    let shown = path.to_string_lossy().to_string();
    // A report that was written but not shown is still a report, so the reveal is
    // allowed to fail without failing the save.
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(shown)
}

/// A bare filename stem: whatever was suggested, minus anything that could point
/// somewhere else. Empty or all-punctuation input falls back to a fixed name
/// rather than to an unnamed file.
fn safe_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c == '-' || c == '_');
    if trimmed.is_empty() {
        "common-report".to_string()
    } else {
        trimmed.to_string()
    }
}

/* ---------------------------------- place ---------------------------------- */

/// Roughly where this machine is, for the single dot on the settings globe.
///
/// **This is the only thing the app does that the user did not ask it to do.**
/// The lookup goes to a third party, and that third party learns this machine's
/// IP address, which is very nearly the answer it gives back. That is a real
/// cost, so it is paid once: the web layer caches the result and no second
/// request is ever made. It is also why the answer is a *city*, not a street —
/// the globe is a decoration and is not worth a precise answer.
///
/// `curl` rather than an HTTP crate, for the same reason the `common` verbs are
/// subprocesses: this file already reaches the outside world by running
/// something and reading what it says, and one more thing done that way costs no
/// new direct dependency. (`reqwest` is in the tree regardless — the updater
/// plugin pulls it in — but taking a direct dependency on it to draw one dot is
/// still not a trade worth making.) A machine without `curl` gets no dot, which
/// is the correct failure.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceRead {
    pub lat: f64,
    pub lon: f64,
    /// Whatever the service called this address — for a residential connection
    /// here, "South Australia, Australia". Nothing draws it today; it exists so
    /// that a surprising dot can be explained without asking the network a
    /// second question, and so a bug report can carry the string it was drawn
    /// from.
    pub label: String,
}

#[derive(serde::Deserialize)]
struct IpWho {
    success: Option<bool>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    city: Option<String>,
    country: Option<String>,
}

/// The name of a place, from whatever parts the service had.
fn place_label(city: Option<String>, country: Option<String>) -> String {
    match (city, country) {
        (Some(city), Some(country)) => format!("{city}, {country}"),
        (Some(city), None) => city,
        (None, Some(country)) => country,
        (None, None) => String::new(),
    }
}

#[tauri::command]
pub async fn where_am_i() -> Result<PlaceRead, String> {
    off_thread(|| {
        let out = silent("curl")
            // `--fail` is what turns a 4xx or 5xx into a failed exit rather than
            // an HTML error page that then fails to parse; `--max-time` is what
            // keeps a request nobody is waiting for from outliving the card.
            .args([
                "--silent",
                "--show-error",
                "--fail",
                "--location",
                "--max-time",
                "6",
                "--header",
                "Accept: application/json",
                "https://ipwho.is/",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("couldn't run curl: {e}"))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("the location lookup failed ({})", out.status)
            } else {
                stderr
            });
        }

        let answer: IpWho = serde_json::from_slice(&out.stdout)
            .map_err(|e| format!("couldn't read the location lookup: {e}"))?;

        // A well-formed answer that says no — a reserved address, a service that
        // has never heard of this one — is a refusal, not a place. It must not
        // fall through to the missing-coordinate branch and be read as 0, 0.
        if answer.success == Some(false) {
            return Err("the location lookup had no answer for this address".to_string());
        }
        let (Some(lat), Some(lon)) = (answer.latitude, answer.longitude) else {
            return Err("the location lookup returned no coordinates".to_string());
        };

        Ok(PlaceRead {
            lat,
            lon,
            label: place_label(answer.city, answer.country),
        })
    })
    .await
}

/* ---------------------------------- launch --------------------------------- */

/// The two facts that decide whether the CLI can be started at all.
///
/// Windows is the one platform whose installer writes a spelling no other
/// installer writes, and the difference between finding it and not is the
/// difference between a join that works and "couldn't start common: program not
/// found" — which is the whole of the Windows failure, and which reads to the
/// user as the network having gone quiet rather than as a missing file.
///
/// Nothing here can exercise `CreateProcess`, so what is pinned is the pair of
/// decisions that feed it: which spellings are looked for, and which sentence a
/// failed launch produces. The third decision — what to do with a `.cmd` once it
/// has been found — is not this file's to make and is not tested here; `std`
/// makes it, and `common_names` says where.
#[cfg(test)]
mod launch {
    use super::*;

    #[test]
    fn a_missing_cli_is_named_as_a_missing_cli_and_not_as_a_failed_join() {
        let bin = std::path::Path::new(r"C:\Users\A B\.common-network\bin\common.cmd");
        let missing = launch_error(bin, std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(
            missing.contains("command-line tool"),
            "service.real.ts reads this sentence as `cli-missing` on those two words and on no others: {missing}"
        );
        assert!(
            missing.contains("common.cmd"),
            "the path is what tells the `common` that was run from the one on PATH: {missing}"
        );

        let refused = launch_error(
            bin,
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        assert!(
            !refused.contains("command-line tool"),
            "only a file that is not there is a missing install; a refused launch is the same \
             event with a different remedy, and the interface must not offer a download for it"
        );
    }

    #[test]
    fn windows_is_offered_the_spelling_its_own_installer_writes_first() {
        let on_windows = common_names(true);
        assert_eq!(
            on_windows.first().copied(),
            Some("common.cmd"),
            "the name the Windows installer writes is the name that has to be found"
        );
        assert!(
            !on_windows.contains(&"common"),
            "CreateProcess appends .exe, so a bare `common` is a candidate that cannot exist"
        );

        assert_eq!(
            common_names(false),
            &["common"][..],
            "install.sh writes the extensionless name, and only that"
        );
    }
}

/* --------------------------------- a live join --------------------------------- */

/// The one judgement that decides whether a join this app started is reported as
/// working or as dead, which on a real machine was the whole of the difference
/// between a node that was registered and a screen saying it never answered.
///
/// Nothing here can spawn the wrapper, so what is pinned is the reading of a child
/// that has already left: the exit code it left with, and what that code means on
/// each platform. The platform is a parameter for the same reason `common_names`
/// takes one — this machine is not a Windows machine, and Windows is the only place
/// the answer differs.
#[cfg(test)]
mod live_join {
    use super::*;

    #[test]
    fn a_windows_wrapper_that_exits_cleanly_is_a_join_that_started_and_not_one_that_stopped() {
        assert!(
            matches!(finished(true, Some(0)), JoinState::HandedOff),
            "cmd.exe leaves with the status of the command it ran, and that command \
             handed off to join.py under a pid this app was never given — reading it \
             as a death is what put 'the network didn't answer' over a live node"
        );
    }

    #[test]
    fn the_same_clean_exit_is_a_death_where_the_process_spawned_is_the_join() {
        // On unix `os.execv` replaces the image and keeps the pid, so the child
        // this app holds *is* the join. A clean exit there is the join stopping,
        // and treating it as a handoff would leave the flow waiting on a node that
        // is gone until the four-minute deadline.
        assert!(matches!(finished(false, Some(0)), JoinState::Ended { .. }));
    }

    #[test]
    fn a_wrapper_that_could_not_hand_off_carries_the_number_that_says_so() {
        // A batch file that could not run Python is the case this is written for:
        // the exit code is the only fact about it that reaches the screen, and the
        // disclosure line under the sentence is where it goes.
        match finished(true, Some(1)) {
            JoinState::Ended { code } => assert!(
                code.contains('1'),
                "the code on screen has to be the code the process left: {code}"
            ),
            other => panic!("a failed handoff is a join that is not serving, not {other:?}"),
        }
    }

    #[test]
    fn a_child_ended_by_a_signal_says_so_rather_than_reporting_a_code_of_nothing() {
        match finished(false, None) {
            JoinState::Ended { code } => assert!(
                !code.contains('0'),
                "there is no code to report, and a zero would read as a clean exit: {code}"
            ),
            other => panic!("a signalled child has ended, not {other:?}"),
        }
    }
}

#[cfg(test)]
mod join_log {
    use super::*;

    /// What the CLI wrote on the run this was written for, in the shape the screen
    /// would have read it: the first act of a join, failing. `check_binaries` refusing
    /// is that act — cloudflared is the one program the join cannot fetch for itself,
    /// so a machine without it dies here, before it reaches the network at all.
    const A_DEAD_ATTEMPT: &str =
        "✗ cloudflared not found.\n# install it with: brew install cloudflared\n";

    #[test]
    fn a_second_attempt_is_read_from_its_own_first_byte_and_not_the_first_attempts() {
        // The whole reason `network_join` returns an offset. The log is appended to, so
        // the previous attempt's `✗` is still in the file — and a join that is merely
        // slow must not be handed the earlier attempt's death as its own cause.
        let raw = format!("{A_DEAD_ATTEMPT}\n ✓ you are live · node id: 24746682\n");
        assert_eq!(
            tail_from(&raw, A_DEAD_ATTEMPT.len() as u64, JOIN_TAIL_LINES),
            "✓ you are live · node id: 24746682"
        );
    }

    #[test]
    fn the_first_attempt_is_read_from_the_start_of_the_file() {
        assert_eq!(
            tail_from(A_DEAD_ATTEMPT, 0, JOIN_TAIL_LINES),
            A_DEAD_ATTEMPT.trim()
        );
    }

    #[test]
    fn an_offset_the_file_cannot_honour_reads_as_nothing_rather_than_as_someone_elses_lines() {
        // A rotated or rewritten log leaves an offset past the end of the file. Reading
        // the whole of it there would be reading a file this attempt did not write.
        assert_eq!(tail_from(A_DEAD_ATTEMPT, 9_999, JOIN_TAIL_LINES), "");
        // And an offset inside a character is not a slice Rust will make. A panic here
        // would be a blank screen where the report of the failure should be.
        assert_eq!(tail_from(A_DEAD_ATTEMPT, 1, JOIN_TAIL_LINES), "");
    }

    #[test]
    fn the_tail_is_the_end_of_what_this_attempt_wrote() {
        // The failure is at the end — `die_with_fix` prints its sentence last, and a
        // traceback ends on the exception — which is why it is a tail and not a head.
        let long: String = (1..=40).map(|n| format!("line {n}\n")).collect();
        let tail = tail_from(&long, 0, 3);
        assert_eq!(tail, "line 38\nline 39\nline 40");
    }
}

/// Placing the bundled CLI, which is the one thing standing between a machine that
/// has never had the toolchain and a first run that works.
#[cfg(test)]
mod seed {
    use super::*;

    /// A scratch directory of this test's own, so two tests cannot collide.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("common-seed-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    fn bundle(name: &str) -> PathBuf {
        let from = scratch(name);
        for file in CLI_FILES {
            std::fs::write(from.join(file), b"a stand-in payload").expect("a stand-in payload");
        }
        from
    }

    /// The bug that made the previous release's fix unreachable. `cli_script` used to
    /// return as soon as `common.py` was there, so on every machine that already had a
    /// CLI the seed was never consulted — and a bundled `runtime.py` could not reach
    /// the one install that was missing it.
    #[test]
    fn an_existing_cli_does_not_stop_a_missing_sibling_being_placed() {
        let home = scratch("existing-cli-home");
        let dir = cli_home(&home);
        std::fs::create_dir_all(&dir).expect("the directory the CLI lives in");
        std::fs::write(dir.join("common.py"), "VERSION = \"0.1.7\"\n").expect("an install");

        let found = place_cli(
            Some(&versioned_bundle("existing-cli-bundle", "0.1.7")),
            &home,
        )
        .expect("the script the app will run");

        assert_eq!(found, dir.join("common.py"));
        assert!(
            dir.join("runtime.py").is_file(),
            "join.py imports runtime as a sibling, so without the file it imports the \
             runtime/ directory the llama.cpp build unpacks into instead, and dies on \
             `module 'runtime' has no attribute 'is_installable'`"
        );
    }

    /// And a seed that cannot be placed must not take a working install with it. The
    /// old error path returned `None`, which the caller reads as "there is no CLI on
    /// this machine" — true of a first run, and false here.
    #[test]
    fn a_seed_that_cannot_be_placed_leaves_the_install_that_is_already_there() {
        let home = scratch("failed-seed-home");
        let dir = cli_home(&home);
        std::fs::create_dir_all(&dir).expect("the directory the CLI lives in");
        std::fs::write(dir.join("common.py"), "VERSION = \"0.1.7\"\n").expect("an install");

        let nowhere = scratch("failed-seed-bundle").join("nothing-was-unpacked-here");

        assert_eq!(
            place_cli(Some(&nowhere), &home),
            Some(dir.join("common.py")),
            "a seed that could not be placed made the app forget the CLI it already has"
        );
    }

    #[test]
    fn every_file_the_cli_needs_is_placed() {
        let to = scratch("every-file-home");

        seed_cli(&bundle("every-file-bundle"), &to).expect("the seed places");

        for name in CLI_FILES {
            assert!(
                to.join(name).is_file(),
                "{name} was not placed, and a `common` missing it is a `common` that \
                 cannot run"
            );
        }
    }

    /// `join.py` imports `worker.py` as a sibling — which is why the CLI's own
    /// installer fetches the two together rather than one at a time. A seed that placed
    /// one and not the other would give a join that starts, prints nothing, and dies on
    /// the import.
    #[test]
    fn the_worker_travels_with_the_join_that_imports_it() {
        assert!(CLI_FILES.contains(&"join.py"));
        assert!(CLI_FILES.contains(&"worker.py"));
    }

    /// The same argument as the worker's, one migration later. `runtime.py` arrived
    /// with llama.cpp and `join.py` imports it as a sibling; it was absent from
    /// `CLI_FILES` until 0.2.9, which made the bundled CLI one that could not be
    /// imported — on exactly the machine that has no other copy to fall back on.
    #[test]
    fn the_runtime_travels_with_the_join_that_imports_it() {
        assert!(CLI_FILES.contains(&"runtime.py"));
    }

    /// The rule that matters more than the placing does. `~/.common-network` may hold a
    /// CLI the user installed, or one their own `common` has since updated — and this app
    /// writing its own bundle over that would hand a working machine a program it did not
    /// ask for. So the bundle wins only over what is strictly older; see `seed_cli`.
    #[test]
    fn a_machine_that_already_has_the_cli_keeps_the_one_it_has() {
        let to = scratch("no-clobber-home");
        std::fs::write(to.join("common.py"), b"the version this machine updated to")
            .expect("an existing copy");

        seed_cli(&bundle("no-clobber-bundle"), &to).expect("the seed runs");

        assert_eq!(
            std::fs::read(to.join("common.py")).expect("read it back"),
            b"the version this machine updated to",
            "the seed overwrote a working install"
        );
    }

    /// Reading a version, and the two ways it fails to be readable. The second case
    /// is the one that matters: the CLI's own docstring says "The Common Network
    /// Alpha (v0.1.7)", which must not be read as a declaration.
    #[test]
    fn a_version_is_read_from_the_declaration_and_not_from_prose() {
        assert_eq!(declared_version("VERSION = \"0.1.7\"\n"), Some((0, 1, 7)));
        assert_eq!(
            declared_version("#!/usr/bin/env python3\nVERSION = \"1.10.2\"\n"),
            Some((1, 10, 2))
        );
        assert_eq!(
            declared_version("The Common Network Alpha (v0.1.7).\n"),
            None
        );
        assert_eq!(declared_version(""), None);
    }

    /// A bundle that declares a version, which is what the replacement rule reads.
    fn versioned_bundle(name: &str, version: &str) -> PathBuf {
        let from = scratch(name);
        for file in CLI_FILES {
            std::fs::write(
                from.join(file),
                format!("#!/usr/bin/env python3\nVERSION = \"{version}\"\n"),
            )
            .expect("a versioned payload");
        }
        from
    }

    /// The bug that kept this machine's CLI stale across three releases. The app runs
    /// the CLI with `--no-update`, so without the seed moving an install forward,
    /// nothing can: not the app, and not the CLI's own self-update.
    #[test]
    fn an_older_cli_is_replaced_by_the_bundled_one() {
        let to = scratch("older-home");
        std::fs::write(to.join("common.py"), "VERSION = \"0.1.3\"\n").expect("an old install");
        std::fs::write(to.join("worker.py"), "VERSION = \"0.1.3\"\n").expect("an old sibling");

        seed_cli(&versioned_bundle("older-bundle", "0.1.7"), &to).expect("the seed runs");

        for name in ["common.py", "worker.py"] {
            let placed = std::fs::read_to_string(to.join(name)).expect("read it back");
            assert_eq!(
                declared_version(&placed),
                Some((0, 1, 7)),
                "{name} was not carried forward with the rest of the seed"
            );
        }
    }

    /// And the direction that was already the rule, which the change above must not
    /// have cost: a copy newer than the bundle is the user's own. A seed that
    /// downgraded it would take a working CLI away and call it a fix.
    #[test]
    fn a_copy_newer_than_the_bundle_is_left_alone() {
        let to = scratch("newer-home");
        std::fs::write(to.join("common.py"), "VERSION = \"0.2.0\"\n").expect("a newer install");

        seed_cli(&versioned_bundle("newer-bundle", "0.1.7"), &to).expect("the seed runs");

        assert_eq!(
            std::fs::read_to_string(to.join("common.py")).expect("read it back"),
            "VERSION = \"0.2.0\"\n",
            "the seed overwrote a copy newer than its own"
        );
        // Leaving the newer script alone is not a reason to leave the directory
        // incomplete: a missing sibling is still placed.
        assert!(
            to.join("runtime.py").is_file(),
            "a newer common.py stopped the missing siblings from being placed"
        );
    }

    /// A directory that is not there yet is the ordinary case and not the edge one: it
    /// is what `~/.common-network` looks like on a machine that has only ever run this
    /// app. So the seed makes it rather than failing on it.
    #[test]
    fn the_home_the_cli_lives_in_is_made_when_it_is_not_there() {
        let to = scratch("makes-home-home").join(".common-network");

        seed_cli(&bundle("makes-home-bundle"), &to)
            .expect("the seed places into a directory that is not there yet");

        assert!(to.join("common.py").is_file());
    }
}
