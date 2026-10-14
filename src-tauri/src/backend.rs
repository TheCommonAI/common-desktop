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
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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
fn run_common(verb: &str, extra: &[&str], json: bool) -> Result<String, String> {
    let bin = common_bin();
    let mut cmd = silent(&bin);
    cmd.arg("--no-color").arg("--no-update");
    if json {
        cmd.arg("--json");
    }
    cmd.arg(verb).args(extra);
    // Belt and braces beside `--no-color`: the CLI also honours NO_COLOR, and a
    // stray escape sequence inside JSON is a parse error with a baffling cause.
    cmd.env("NO_COLOR", "1");

    let out = cmd.output().map_err(|e| launch_error(&bin, e))?;

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
#[tauri::command]
pub async fn network_leave() -> Result<String, String> {
    off_thread(|| run_common("leave", &[], false)).await
}

/// Ask the local model something, through the same path the CLI uses.
///
/// This is the contribution proof: not "the network answered" but "this machine
/// answered", which is the thing being joined. `--local` keeps it off the
/// network entirely — the point is to prove the model here runs, and routing the
/// question through the gateway would prove something else.
#[tauri::command]
pub async fn network_ask_local(question: String, model: Option<String>) -> Result<String, String> {
    off_thread(move || {
        // Ollama first, for the same reason the download waits: this is the
        // proof that *this machine* can answer, and on a fresh install the daemon
        // may still be coming up. There is no channel here — this command answers
        // in one piece — so the wait is silent, and a machine that never answers
        // gets a sentence rather than a hang.
        if !await_ollama(
            Instant::now() + OLLAMA_WAIT,
            OLLAMA_POLL,
            ollama_answers,
            start_ollama,
            || true,
        ) {
            return Err(format!(
                "ollama isn't answering on {OLLAMA_HOST} — start it and try again"
            ));
        }

        let bin = common_bin();
        let mut cmd = silent(&bin);
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
        cmd.env("NO_COLOR", "1");

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
/// `--local` is a different product. It talks past the network to the Ollama
/// running on this machine and takes *the first model in its list* — so a
/// machine contributing a maths model, whose list happens to start there,
/// answers "hey" with mathematics. This machine contributes one specialist; the
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
        let bin = common_bin();
        let mut cmd = silent(&bin);
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
/// which would fill its buffer and wedge it. The log path is returned so a
/// failure can be shown to the user as text rather than as a silent nothing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinStarted {
    pub pid: u32,
    pub log_path: String,
}

#[tauri::command]
pub async fn network_join(
    model: Option<String>,
    name: Option<String>,
    lan: bool,
) -> Result<JoinStarted, String> {
    off_thread(move || {
        let bin = common_bin();

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

        let mut cmd = silent(&bin);
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
        cmd.env("NO_COLOR", "1");
        cmd.stdout(Stdio::from(log));
        cmd.stderr(Stdio::from(log_err));
        cmd.stdin(Stdio::null());

        // The failure that says the least and needs to say the most — see
        // `launch_error`, where the sentence for a missing CLI is written.
        let child = cmd.spawn().map_err(|e| launch_error(&bin, e))?;

        Ok(JoinStarted {
            pid: child.id(),
            log_path: log_path.to_string_lossy().to_string(),
        })
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
/// catalogue. What the ladder does not carry is the ollama tag each id pulls
/// from, and that mapping is the network's to know: `qwen2.5-math-7b` is
/// `mightykatun/qwen2.5-math:7b`, which no rule derives from the id. So the
/// download asks this, and falls back to treating the id as a tag.
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

/// The tail of the join log, for saying *why* a join did not come up.
///
/// `common join` does not return: it replaces itself with `join.py`, which
/// pulls the weights, starts the worker, opens the tunnel and then loops. So a
/// join that fails fails *out there*, and the only evidence is what it wrote.
/// Without this, a failed join is a spinner that stops on a timeout with
/// nothing to say — which is the worst thing a first-run screen can do.
///
/// A missing log is an empty string and not an error: "nothing has been logged"
/// and "the log could not be read" are different facts, and only the caller
/// knows which one it cares about.
#[tauri::command]
pub async fn network_join_log(tail: usize) -> Result<String, String> {
    off_thread(move || {
        let home = home_dir().map_err(|_| "no home to read the log from".to_string())?;
        let path = home.join(".common-network/join.log");
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
            Err(e) => return Err(format!("couldn't read {}: {e}", path.display())),
        };
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
        let start = lines.len().saturating_sub(tail);
        Ok(lines[start..].join("\n"))
    })
    .await
}

/* ------------------------------ a live join ------------------------------ */

/// Whether a process this app started is still alive.
///
/// `network_join` spawns `common join` detached and hands back its pid: that
/// process *is* the node, and it is meant to outlive the call that made it, so
/// there is no `Child` left to hold. Polling the pid is how "the join died" is
/// told apart from "the join is still working", and the two need different
/// words on screen — one is a failure to show the log of, the other is patience.
///
/// Signal 0 is the unix idiom: it performs the existence and permission checks
/// and delivers nothing. Status 0 means something is there.
#[cfg(unix)]
fn is_running(pid: u32) -> Result<bool, String> {
    let status = silent("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("couldn't ask after pid {pid}: {e}"))?;
    Ok(status.success())
}

/// Windows has no signal 0, so this reads `tasklist`. A filtered `tasklist`
/// with no match prints "No tasks are running which match the specified
/// criteria." rather than nothing, so the pid itself has to be looked for —
/// testing the output for emptiness would answer "running" every time.
#[cfg(windows)]
fn is_running(pid: u32) -> Result<bool, String> {
    let out = silent("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map_err(|e| format!("couldn't ask after pid {pid}: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
}

/// A pid can be reused, but the window here is the length of one onboarding and
/// a recycled pid would have to land on the exact number this app was handed.
/// The cost of being wrong is a spinner that runs a little longer, never a
/// wrong answer.
#[tauri::command]
pub async fn process_running(pid: u32) -> Result<bool, String> {
    off_thread(move || is_running(pid)).await
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
            cli_path: common_bin().to_string_lossy().to_string(),
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
    let bin = common_bin();
    let out = silent(&bin)
        .arg("--no-update")
        .arg("--version")
        .output()
        .ok()?;
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

/* ------------------------------ the model store ------------------------------ */

/// Where this machine's weights live, absolute.
///
/// `DownloadResult.path` is promised to the user verbatim, so it must be a real
/// path rather than the one that is conventional. `OLLAMA_MODELS` decides it if
/// it is set; the default is `~/.ollama/models`.
///
/// A daemon started with `OLLAMA_MODELS` set to something this process cannot
/// see would keep its weights somewhere else, and this would name the wrong
/// directory. That is why nothing here depends on the answer: `verified` comes
/// from ollama's own digest check, which is the only party that knows where the
/// bytes it wrote actually are.
#[tauri::command]
pub async fn ollama_models_dir() -> Result<String, String> {
    off_thread(|| {
        let dir = match std::env::var_os("OLLAMA_MODELS") {
            Some(custom) if !custom.is_empty() => PathBuf::from(custom),
            _ => {
                let home =
                    home_dir().map_err(|_| "no home to look for the weights under".to_string())?;
                home.join(".ollama/models")
            }
        };
        Ok(dir.to_string_lossy().to_string())
    })
    .await
}

/* ------------------------------ the pull stream ------------------------------ */

/// Ollama, on this machine. The same string as `OLLAMA` in
/// `src/onboarding/service.real.ts`, and hardcoded there for the reason given
/// there: the alternative is a setting whose only working value is this one.
const OLLAMA_PULL_URL: &str = "http://127.0.0.1:11434/api/pull";

/// Where ollama listens on this machine, for the sentences this file writes
/// about it. The URLs above and below spell the same host out again because a
/// `const` cannot be assembled from one, and `service.real.ts` holds a literal
/// copy for the same reason.
const OLLAMA_HOST: &str = "127.0.0.1:11434";

/// The cheapest question ollama answers, and the only thing asked of it that is
/// not the pull itself. A version string and nothing else: this goes out once a
/// second while the app waits for a daemon that is still starting, so answering
/// it has to cost nothing.
const OLLAMA_VERSION_URL: &str = "http://127.0.0.1:11434/api/version";

/// How long the app waits for ollama before it says it could not reach it.
///
/// A cold daemon takes seconds, not minutes, and the slow case is a first run
/// that has to start one: the `.app` or the Windows service has to come up,
/// bind, and load a runner. Thirty seconds is longer than that takes on the
/// machines this ships to, and short enough that a machine with no ollama at all
/// is not left staring at a spinner.
const OLLAMA_WAIT: Duration = Duration::from_secs(30);

/// How often the wait looks up to see whether ollama has answered yet.
const OLLAMA_POLL: Duration = Duration::from_secs(1);

/// One message of ollama's pull stream, on its way to the webview.
///
/// Variants rather than a bare line, because the failures are different animals
/// and the screen says different things about them. Ollama reports its own
/// refusals *inside* the stream — `{"error":"model not found"}`, one line among
/// the progress — and those are lines like any other, read by the same parser
/// that reads the bytes, so they need no variant of their own.
///
/// The ones that do are the ones with nothing to parse. `Unreachable` means the
/// transfer never began — ollama is not listening, which is the ordinary state
/// of a machine that has never run it, and the one case where the honest
/// sentence is "we could not reach it" rather than "it stopped". `Failed` means
/// it began and something ended it badly.
///
/// `Waiting` is the odd one out and is not a failure at all: it is the app
/// saying it is still trying, once a second, while it waits for a daemon that is
/// coming up. It exists because the alternative is worse than silence — a
/// progress bar that has not moved for half a minute is indistinguishable from a
/// hung one, and the whole point of waiting is that the user does nothing. Its
/// `seconds` count up from the start of the wait rather than down to the end of
/// it: a countdown to the moment the app gives up is a worse thing to watch for
/// half a minute than a figure that says it is still trying.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PullEvent {
    Line { line: String },
    Waiting { seconds: u32 },
    Unreachable { message: String },
    Failed { message: String },
}

/// One in-flight pull, as the cancel command needs to see it.
struct Pull {
    /// The `curl` process, once it has started. Behind a mutex of its own rather
    /// than the registry's, so that cancelling never waits on the thread that is
    /// reading from it.
    child: Mutex<Option<Child>>,
    /// Set by `ollama_pull_cancel` *before* it kills, so the reader can tell a
    /// deliberate stop from a `curl` that fell over. Order matters: the reverse
    /// leaves a window where a killed process reads as a failure.
    stopped: AtomicBool,
}

/// Every pull this app has running, by the id the webview gave it.
///
/// Ollama offers no way to cancel a pull — it is a stream that runs to its end.
/// `curl` does, and killing it is the correct stop rather than a crude one:
/// ollama keeps the blob it has written so far, which is what makes the next
/// attempt a resume instead of a restart. That property is the entire reason the
/// download screen has a pause button, so the transport must not be the thing
/// that loses it.
#[derive(Default)]
pub struct Pulls(Mutex<HashMap<String, Arc<Pull>>>);

/// Whether ollama answers on loopback right now.
///
/// One `curl` on the cheapest endpoint it has. Loopback either answers at once
/// or refuses at once, so the timeouts are a ceiling that is almost never paid —
/// they are there for the machine where something else holds the port and says
/// nothing, which would otherwise hang the wait rather than end it.
///
/// `--fail` so that a listener answering with a status code is not mistaken for
/// ollama: readiness means a 2xx from this URL, not merely a connection.
fn ollama_answers() -> bool {
    ollama_answers_at(OLLAMA_VERSION_URL)
}

/// The same probe against any URL, which is what lets the test at the foot of
/// this file point it at a port nothing is listening on. That refusal is the one
/// arm of this that can be checked on a machine with no daemon on it, and it is
/// worth checking: it is the arm the first run depends on.
fn ollama_answers_at(url: &str) -> bool {
    silent("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--connect-timeout",
            "1",
            "--max-time",
            "2",
        ])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Ask the platform to start ollama, and say whether the ask was taken.
///
/// The desktop app rather than `ollama serve` wherever there is one, because the
/// app owns the daemon's lifecycle and its port: a bare `serve` started beside a
/// running app only fails to bind, and says nothing this file can read. On
/// Windows that app is `ollama app.exe` under `%LOCALAPPDATA%\Programs\Ollama`,
/// asked for by path because the app is not on `PATH` while `ollama.exe` alone
/// is.
///
/// The daemon is spawned and the handle dropped, so it outlives the window:
/// quitting Common must not stop the model server the user's other tools are
/// also using.
fn start_ollama() -> bool {
    if cfg!(target_os = "macos") {
        // `open -a` has done its job once the app is launched, so its exit
        // status is the whole answer — and it does not wait on the daemon, which
        // is what the poll after it is for.
        return silent("open")
            .arg("-a")
            .arg("Ollama")
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    if cfg!(windows)
        && let Some(local) = std::env::var_os("LOCALAPPDATA")
    {
        let app = PathBuf::from(local)
            .join("Programs")
            .join("Ollama")
            .join("ollama app.exe");
        if app.is_file() {
            return silent(app).spawn().is_ok();
        }
    }

    // `ollama serve` is the fallback, and the only path on Linux.
    silent("ollama")
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// Wait for ollama to answer, asking the platform to start it once on the way.
///
/// This is the whole of the Windows first-run fix. `ollama_pull` ran `curl`
/// exactly once, at the instant the model was chosen, and a daemon that is
/// installed but not yet up loses that race: the pull dies with curl's
/// `CURLE_COULDNT_CONNECT` and the app says it could not reach ollama, which was
/// true for about two seconds and false for the rest of the machine's life.
///
/// So: probe, ask the platform to start it if the probe fails, then keep probing
/// until it answers or the deadline passes. The closures are seams rather than
/// indirection for its own sake — `answers` and `start` so the loop can be
/// tested without a daemon (see the tests at the foot of this file), and `tick`
/// so the caller decides what a second of waiting is worth saying, and can cut
/// the wait short when the user has.
///
/// - `deadline` — when to stop waiting and let the caller report it.
/// - `poll` — how long to sleep between probes.
/// - `answers` — whether ollama is up *now*.
/// - `start` — ask the platform to start it. Called at most once, and only ever
///   after a probe has already failed.
/// - `tick` — one turn of the wait. `false` abandons it immediately. It is handed
///   nothing because what is worth saying about a wait is how long it has been
///   going, and only the caller knows when it began.
fn await_ollama(
    deadline: Instant,
    poll: Duration,
    mut answers: impl FnMut() -> bool,
    mut start: impl FnMut() -> bool,
    mut tick: impl FnMut() -> bool,
) -> bool {
    let mut asked = false;
    loop {
        if answers() {
            return true;
        }
        if !asked {
            asked = true;
            let _ = start();
        }
        if deadline.saturating_duration_since(Instant::now()).is_zero() {
            return false;
        }
        if !tick() {
            return false;
        }
        std::thread::sleep(poll);
    }
}

/// Stream a model into ollama, as ollama's own NDJSON.
///
/// This runs in Rust rather than in the webview, and the reason is one word:
/// **CORS**. A `fetch` from the page carries an `Origin` header, and ollama
/// answers only the origins on its allowlist. On macOS and Linux that list
/// contains Tauri's `tauri://*`, so the download works and always has. On Windows
/// Tauri's webview origin is `http://tauri.localhost` — `wry`'s workaround URL
/// for `tauri://localhost`, per tauri 2.12.3 `manager/mod.rs:335` — and ollama's
/// defaults do **not** contain it, so the CORS preflight comes back `403` and the
/// transfer never starts. The model is chosen, the screen waits, and not one byte
/// is ever counted.
///
/// Worse, it cannot be caught in development: `npm run tauri dev` serves the page
/// from `http://localhost:1420`, which ollama *does* allow, so the pull works on
/// a Windows dev machine and fails only in the packaged build.
///
/// A subprocess sends no `Origin` at all, so the question does not arise on any
/// platform — which is the whole fix. The webview is still told every byte, so
/// the progress remains ollama's own accounting rather than this file's; only the
/// hop it takes to get there has changed.
///
/// `curl` rather than an HTTP crate, for the reason `where_am_i` gives below:
/// this file already reaches the outside world by running something and reading
/// what it says, and the update plugin's `reqwest` is not worth a direct
/// dependency to do it differently.
///
/// Before any of that, it waits for ollama to be up — see `await_ollama` — and
/// gives up only after `OLLAMA_WAIT` has passed with no answer. A refusal after
/// that wait is genuinely a machine with no daemon on it, rather than one whose
/// daemon had not finished starting, which is the distinction the first run used
/// to get wrong. Every entry into a pull goes through that wait, including the
/// two ways back in from a failure or a pause, so a resume re-checks readiness
/// without the screen having to ask for it.
#[tauri::command]
pub async fn ollama_pull(
    app: tauri::AppHandle,
    model: String,
    id: String,
    on_event: tauri::ipc::Channel<PullEvent>,
) -> Result<(), String> {
    let pull = Arc::new(Pull {
        child: Mutex::new(None),
        stopped: AtomicBool::new(false),
    });
    app.state::<Pulls>()
        .0
        .lock()
        .map_err(|_| "the pull registry is poisoned".to_string())?
        .insert(id.clone(), pull.clone());

    let registry = app.clone();
    let key = id.clone();

    let outcome = off_thread(move || {
        // Nothing is asked of ollama until it has answered something. This is the
        // Windows first run: the pull used to be fired at a daemon that had not
        // finished starting, so `ollama app.exe` had been launched and the
        // transfer still died on the connection. Now the launch is made here if
        // it is needed, the version endpoint is polled until it comes up, and the
        // transfer begins only then. The failure is reported by this code, and
        // only once the wait has actually run out.
        let began = Instant::now();
        let ready = await_ollama(
            began + OLLAMA_WAIT,
            OLLAMA_POLL,
            ollama_answers,
            start_ollama,
            || {
                // A failed send means the window has gone and there is nobody
                // left to wait for; a stop means the user has already said so and
                // the screen has already drawn it. Either way, stop waiting.
                //
                // The number is time spent, not time left: a countdown to the
                // moment the app gives up is a worse thing to watch for half a
                // minute than a figure that says it is still trying.
                !pull.stopped.load(Ordering::SeqCst)
                    && on_event
                        .send(PullEvent::Waiting {
                            seconds: began.elapsed().as_secs() as u32,
                        })
                        .is_ok()
            },
        );
        if !ready {
            // A stop during the wait is the user's own doing and is not reported
            // as a failure — the same rule the reaping below follows.
            if !pull.stopped.load(Ordering::SeqCst) {
                let _ = on_event.send(PullEvent::Unreachable {
                    message: format!(
                        "nothing answered on {OLLAMA_HOST} for {}s — start Ollama, \
                         then try again",
                        OLLAMA_WAIT.as_secs()
                    ),
                });
            }
            return Ok(());
        }

        // `--data` with the body handed to the process directly, rather than a
        // shell-quoted string: a model tag needs no escaping on any platform, and
        // a tag containing a quote could not break out of one.
        let body = serde_json::json!({ "model": model, "stream": true }).to_string();

        let mut child = match silent("curl")
            .args([
                "--silent",
                "--show-error",
                // Retry the connection, not the transfer. Ollama has just
                // answered the readiness probe above, so a refusal here means it
                // went away in between — and ten attempts a second apart is the
                // difference between a failed download and a slow one. `--retry`
                // does cover a POST on curl 8.x, which is worth stating because
                // it historically covered only idempotent methods.
                "--retry",
                "10",
                "--retry-connrefused",
                "--retry-delay",
                "1",
                // `-N`. Without it curl buffers, and a buffered stream is a
                // progress bar that sits still and then jumps to the end.
                "--no-buffer",
                "--request",
                "POST",
                "--header",
                "Content-Type: application/json",
                "--data",
                body.as_str(),
                OLLAMA_PULL_URL,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            // Reported rather than returned: a machine without `curl` is an
            // environment this code cannot change, and the screen has a sentence
            // for it. `Err` is kept for the failures that are this file's own.
            Err(e) => {
                let _ = on_event.send(PullEvent::Unreachable {
                    message: format!("couldn't run curl: {e}"),
                });
                return Ok(());
            }
        };

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "curl gave nothing to read".to_string())?;
        let stderr = child.stderr.take();

        if let Ok(mut slot) = pull.child.lock() {
            *slot = Some(child);
        }

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        // Held rather than returned on the spot, so that every way out of the
        // loop passes through the reaping below. A `curl` dropped without a
        // `wait` is a process left behind, and this one is spawned again on every
        // resume — so a pause loop would be the way to collect a few dozen of
        // them.
        let mut broken: Option<String> = None;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let text = line.trim_end();
                    if text.is_empty() {
                        continue;
                    }
                    // A send that fails means the window is gone. There is nobody
                    // left to report to, so the only useful thing to do is stop
                    // reading and let the process be reaped below.
                    if on_event
                        .send(PullEvent::Line {
                            line: text.to_string(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    broken = Some(format!("reading ollama's stream failed: {e}"));
                    break;
                }
            }
        }

        // Take the child back to reap it. When `ollama_pull_cancel` has killed
        // it, this returns the kill immediately rather than waiting out the
        // transfer.
        let status = pull
            .child
            .lock()
            .map_err(|_| "the pull was poisoned".to_string())?
            .take()
            .map(|mut child| child.wait());

        // `--show-error` is what puts a connection refusal here rather than
        // nowhere; it is read after the wait because curl writes it once and
        // never fills a pipe.
        let mut complaint = String::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_string(&mut complaint);
        }

        // A deliberate stop is not a failure and must not be reported as one: the
        // web layer has already drawn the pause, and every byte that arrived is
        // on disk waiting to be resumed.
        if pull.stopped.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Now that the process has been reaped, the read error can be the answer.
        // It is this file's own failure rather than ollama's, so it goes back as
        // an `Err`: there is no sentence for it on the screen and inventing one
        // would be worse than the shape the web layer already has for a command
        // that would not run.
        if let Some(message) = broken {
            return Err(message);
        }

        match status {
            Some(Ok(status)) if status.success() => Ok(()),
            Some(Ok(status)) => {
                let detail = complaint.trim();
                let message = if detail.is_empty() {
                    format!("ollama's pull stopped ({status})")
                } else {
                    detail.to_string()
                };
                // curl's own `CURLE_COULDNT_CONNECT`. Loopback either answers or
                // refuses, so this is the whole of "ollama is not running" — the
                // ordinary state of a machine that has never started it, and the
                // one failure that should say *we could not reach it* rather than
                // *it stopped*. Nothing was transferred either way, but only this
                // one is a fact about the machine rather than about the transfer.
                let event = if status.code() == Some(7) {
                    PullEvent::Unreachable { message }
                } else {
                    PullEvent::Failed { message }
                };
                // Not an `Err`: the environment, or ollama, said what went wrong
                // and the screen has a sentence for it. `Err` is kept for the
                // failures that are this file's own.
                let _ = on_event.send(event);
                Ok(())
            }
            Some(Err(e)) => Err(format!("couldn't wait for curl: {e}")),
            // No child, which only `ollama_pull_cancel` can arrange.
            None => Ok(()),
        }
    })
    .await;

    // Always, on every path: an entry left behind is a map that grows for the
    // life of the process and an id that a later cancel would find and kill
    // something under.
    if let Ok(mut registry) = registry.state::<Pulls>().0.lock() {
        registry.remove(&key);
    }

    outcome
}

/// Stop a pull this app started.
///
/// The one thing the transport has to add, because a stream that cannot be
/// interrupted makes the pause button a lie. Killing `curl` leaves ollama's
/// partial blob exactly where it is — not a side effect to tolerate but the point:
/// resuming posts the same request, and ollama carries on from what it already
/// has rather than starting over.
#[tauri::command]
pub async fn ollama_pull_cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let pull = app
        .state::<Pulls>()
        .0
        .lock()
        .map_err(|_| "the pull registry is poisoned".to_string())?
        .get(&id)
        .cloned();

    // An id with nothing behind it is a pause that raced the end of the transfer,
    // which is not a failure worth telling anyone about.
    let Some(pull) = pull else {
        return Ok(());
    };

    pull.stopped.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = pull.child.lock()
        && let Some(child) = slot.as_mut()
    {
        let _ = child.kill();
    }
    Ok(())
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

/* ---------------------------------- tests ---------------------------------- */

/// The readiness wait, exercised with a probe and a starter that are both
/// counters, so the whole thing runs in milliseconds and answers about this code
/// rather than about what happens to be installed on the machine.
///
/// It lives here, at the foot of the module, rather than in `tests/` beside
/// `manifest.rs`: `await_ollama` is private, and the four closures it takes are
/// the seams that make it testable — a test outside the crate could reach
/// neither.
///
/// What is deliberately *not* here is a test against a live daemon. That would
/// pass on a developer's laptop and fail on a build machine, reporting on the
/// machine instead of on the code. The one arm that can be checked anywhere is
/// the refusal, and it is checked below.
#[cfg(test)]
mod readiness {
    use super::*;
    use std::cell::Cell;

    /// Short enough that the suite is instant, long enough that the poll loop
    /// gets several goes at it.
    const QUICK: Duration = Duration::from_millis(10);

    /// A deadline a known number of polls away, so what the loop does is exact
    /// rather than a race against the wall clock.
    fn deadline_after(steps: u32) -> Instant {
        Instant::now() + QUICK * steps
    }

    /// A counter two closures can share.
    ///
    /// The probe and the starter are both handed to `await_ollama` at once, so
    /// they are alive together and each is `FnMut` — a plain `u32` captured by
    /// both is two mutable borrows of one place, which does not compile. A
    /// `Cell` is borrowed shared, and a counter has no need to be anything else.
    #[derive(Default)]
    struct Tally(Cell<u32>);

    impl Tally {
        fn bump(&self) -> u32 {
            self.0.set(self.0.get() + 1);
            self.0.get()
        }

        fn get(&self) -> u32 {
            self.0.get()
        }
    }

    #[test]
    fn a_daemon_that_is_already_answering_is_neither_watched_nor_started() {
        let probes = Tally::default();
        let starts = Tally::default();
        let ready = await_ollama(
            deadline_after(5),
            QUICK,
            || probes.bump() > 0,
            || {
                starts.bump();
                true
            },
            || true,
        );

        assert!(ready);
        assert_eq!(
            probes.get(),
            1,
            "one probe is the answer; the rest is waste"
        );
        assert_eq!(
            starts.get(),
            0,
            "nothing may be started when nothing is wrong"
        );
    }

    #[test]
    fn the_daemon_is_started_once_over_a_whole_wait_and_only_after_a_refusal() {
        let probes = Tally::default();
        let starts = Tally::default();
        let probes_when_started = Cell::new(None);
        let ready = await_ollama(
            deadline_after(5),
            QUICK,
            || probes.bump() > 2,
            || {
                starts.bump();
                probes_when_started.set(Some(probes.get()));
                false
            },
            || true,
        );

        assert!(ready, "the third probe answers, so the wait must succeed");
        assert_eq!(starts.get(), 1, "once for the wait, not once per second");
        // The order is the point. A launcher racing a daemon that is already up
        // fails to bind the port, so the start has to answer a refusal.
        assert_eq!(
            probes_when_started.get(),
            Some(1),
            "the daemon was started before a probe had said no"
        );
    }

    #[test]
    fn a_daemon_that_never_answers_gives_up_at_the_deadline() {
        let mut ticks = 0;
        let began = Instant::now();
        let ready = await_ollama(
            Instant::now() + QUICK * 3,
            QUICK,
            || false,
            || true,
            || {
                ticks += 1;
                true
            },
        );

        assert!(
            !ready,
            "nothing answered, so the wait must not claim it did"
        );
        assert!(ticks >= 1, "the screen is told the wait is happening");
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "the deadline is a deadline, not a suggestion: {:?}",
            began.elapsed()
        );
    }

    #[test]
    fn a_tick_that_says_stop_abandons_the_wait_on_that_tick() {
        let mut ticks = 0;
        let ready = await_ollama(
            Instant::now() + Duration::from_secs(60),
            QUICK,
            || false,
            || true,
            || {
                ticks += 1;
                false
            },
        );

        assert!(!ready, "a cancelled wait has not found a daemon");
        assert_eq!(ticks, 1, "a stop is acted on at once, not next second");
    }

    /// The refusal, which is the arm a first run actually meets, and the only
    /// one that can be checked without a daemon on the machine. A closed loopback
    /// port refuses immediately rather than sitting on the timeout, so this also
    /// pins that the probe costs about nothing when the answer is no.
    ///
    /// If `curl` is missing entirely the spawn fails and the probe still answers
    /// `false`, so this stays green on a machine that cannot run the pull at all
    /// — which is the honest reading, since such a machine has no first run.
    #[test]
    fn a_port_nothing_listens_on_is_not_ollama() {
        let began = Instant::now();
        assert!(!ollama_answers_at("http://127.0.0.1:45999/api/version"));
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "a closed loopback port must refuse at once, not time out: {:?}",
            began.elapsed()
        );
    }
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
