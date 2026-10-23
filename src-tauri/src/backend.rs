//! The machine seam: reading this computer, finding the CLI, saving a report.
//!
//! The layer network itself lives in `peer.rs`. What stays here is what is true of
//! the machine and not of any network:
//!
//! - **Hardware reads** parse *machine* output (`sysctl`, `df`, `pmset`,
//!   PowerShell), so Rust owns their shape and returns typed structs. There is no
//!   `common` verb for any of them.
//! - **Finding `common`**, the CLI both the terminal user and this app run. The app
//!   never reimplements it: it starts `common join --network --api` and reads the
//!   status file that peer writes.
//! - **Saving a report** somewhere the user can find it.
//!
//! No new dependencies: `std::process::Command` and the `serde_json` that Tauri
//! already brings. Every command is `async` and does its blocking work on
//! `spawn_blocking`, because a synchronous Tauri command runs on the main thread.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
// `Manager` puts `path()` on the app handle, which is where a report is written.
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
pub(crate) fn home_dir() -> Result<PathBuf, String> {
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
pub(crate) fn silent(program: impl AsRef<std::ffi::OsStr>) -> Command {
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

/// The environment every CLI child gets.
///
/// `NO_COLOR` is belt and braces beside `--no-color`: a stray escape sequence in a
/// log the user is asked to send is a baffling thing to read.
pub(crate) fn cli_env(cmd: &mut Command) {
    cmd.env("NO_COLOR", "1");
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
pub(crate) fn launch_error(bin: &std::path::Path, error: std::io::Error) -> String {
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
pub(crate) fn common_bin() -> PathBuf {
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

/* --------------------------------- hardware --------------------------------- */

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

/// The last `lines` lines of `text`. The end is where a failure is.
pub(crate) fn tail_lines(text: &str, lines: usize) -> String {
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
pub(crate) fn cli_version() -> Option<String> {
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

