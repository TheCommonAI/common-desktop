//! The distributed model group, as the desktop sees it.
//!
//! A group is one model split across several llama.cpp RPC devices, with a
//! coordinator that the CLI runs as `join --local-only --distributed-config <file>`.
//! This file is the desktop's side of that. It reads the group's network.json for
//! the facts the panel shows, writes its one editable field back, asks the
//! coordinator's `/health` how far it has got, and starts and stops the coordinator
//! process the way `backend.rs` starts and stops the join.
//!
//! The CLI validates the whole configuration when the coordinator starts, and that
//! check is the one that counts. The checks here only stop the panel writing or
//! starting something the CLI would refuse, and they name the file when they do.
//!
//! Health is probed here rather than in the webview because the page's CSP allows
//! it to talk only to itself and to the IPC channel.

use serde::Serialize;
use serde_json::{Map, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

use crate::backend::{self, Cli};

/// The lowest port a group's coordinator may bind. Below this are system ports.
pub const MIN_COORDINATOR_PORT: u16 = 1024;

/// The range a group's `draft_tokens` may take. The CLI checks the same range in
/// `DistributedConfig`. It is repeated here so the panel refuses a value before it
/// is written.
pub const DRAFT_TOKENS_MIN: u32 = 1;
pub const DRAFT_TOKENS_MAX: u32 = 32;

/// What `draft_tokens` means when a configuration leaves the key out. This is the
/// CLI's own default, and it is used for that case only: the control reads the value
/// the file holds, so no other place has to know the number.
const DRAFT_TOKENS_DEFAULT: u32 = 4;

/// Where the coordinator's output goes, under `~/.common-network`. Appended to, like
/// the join's log, so a start that fails leaves its reason for the next look.
const COORDINATOR_LOG: &str = "coordinator.log";

/// How long a `/health` answer is waited for. Short, because the panel asks every
/// couple of seconds and a slow answer is itself the answer "loading".
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// How long a stopping coordinator is given to unload its model before it is killed.
/// Fifteen seconds, because llama-server has to release the weights and the RPC
/// connections before it exits.
const STOP_POLLS: u32 = 150;
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Whether the coordinator answers `/health` with 200, something else, or nothing.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ready,
    Loading,
    Stopped,
}

/// What the coordinator process this app started is doing.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Process {
    None,
    Running,
    Ended { code: String },
}

/// The panel's whole picture of one group, in one answer.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupStatus {
    /// Whether the file names a group the panel can show.
    configured: bool,
    /// Why a named file is not a usable group. `None` when nothing is named.
    problem: Option<String>,
    model_name: Option<String>,
    devices: Option<usize>,
    /// The value the file holds, or the CLI's default when the file leaves it out.
    draft_tokens: u32,
    health: Health,
    coordinator: Process,
    port: u16,
}

/// The coordinator this app started, if it started one. The same shape as
/// `backend::Join`: the child is held rather than re-found by pid, so a stop can be
/// answered from the process handle.
#[derive(Default)]
pub struct Coordinator(Mutex<Option<Child>>);

/// Map a path as the panel typed it. `~/` is the home directory; anything else is
/// taken as written, and the CLI resolves a relative one against the file.
fn expand(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Ok(home) = backend::home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(path)
}

/// A group's network.json, read as the object it is and checked for the one thing
/// every reader here relies on: that it is version 2 of the format.
fn read_group(path: &Path) -> Result<Map<String, Value>, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("{} is not JSON: {e}", path.display()))?;
    match value {
        Value::Object(map) if map.get("version").and_then(Value::as_u64) == Some(2) => Ok(map),
        Value::Object(_) => Err(format!("{} is not a version 2 group", path.display())),
        _ => Err(format!("{} is not a group configuration", path.display())),
    }
}

/// What the panel shows of a group, read from its configuration.
#[derive(Debug, PartialEq, Eq)]
struct Summary {
    model_name: String,
    devices: usize,
    draft_tokens: u32,
}

/// The three facts the panel shows, or the reason they cannot be read. Pure, so the
/// rules are tested without a file.
fn summarise(map: &Map<String, Value>) -> Result<Summary, String> {
    let model_name = map
        .get("model_name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .ok_or("model_name is missing from the group")?
        .to_string();
    let devices = map
        .get("devices")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or("devices must list the RPC devices in the group")?;
    let draft_tokens = match map.get("draft_tokens") {
        None => DRAFT_TOKENS_DEFAULT,
        Some(value) => value
            .as_u64()
            .filter(|v| (u64::from(DRAFT_TOKENS_MIN)..=u64::from(DRAFT_TOKENS_MAX)).contains(v))
            .map(|v| v as u32)
            .ok_or_else(|| {
                format!("draft_tokens must be a whole number from {DRAFT_TOKENS_MIN} to {DRAFT_TOKENS_MAX}")
            })?,
    };
    Ok(Summary {
        model_name,
        devices,
        draft_tokens,
    })
}

/// Refuse a draft length the CLI would refuse. Returns the value unchanged.
pub fn check_draft_tokens(value: u32) -> Result<u32, String> {
    if (DRAFT_TOKENS_MIN..=DRAFT_TOKENS_MAX).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "draft_tokens must be between {DRAFT_TOKENS_MIN} and {DRAFT_TOKENS_MAX}, not {value}"
        ))
    }
}

/// Refuse a port the coordinator cannot bind. The CLI takes the port as `--port`.
pub fn check_start_port(port: u16) -> Result<(), String> {
    if port < MIN_COORDINATOR_PORT {
        Err(format!(
            "the coordinator port must be {MIN_COORDINATOR_PORT} or higher"
        ))
    } else {
        Ok(())
    }
}

/// `/health` on the coordinator's loopback port. `None` when nothing answers in time.
///
/// Written against the socket directly, as `backend.rs` writes its own helpers, rather
/// than through an HTTP client: this is one request to 127.0.0.1 and the crate has no
/// HTTP dependency to lean on.
pub fn probe_health(port: u16) -> Option<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(PROBE_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(PROBE_TIMEOUT)).ok()?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut status_line = String::new();
    BufReader::new(stream).read_line(&mut status_line).ok()?;
    status_line.split_whitespace().nth(1)?.parse().ok()
}

/// The panel's reading of an answer. A 200 is ready. Any other answer means the
/// coordinator is up and not yet serving, which is what llama-server sends (503) while
/// the weights load. No answer is loading while this app's own coordinator is still
/// running, and stopped otherwise.
pub fn health_from(answer: Option<u16>, running: bool) -> Health {
    match answer {
        Some(200) => Health::Ready,
        Some(_) => Health::Loading,
        None if running => Health::Loading,
        None => Health::Stopped,
    }
}

/// What the coordinator process is doing, read without waiting on it. Read as "still
/// running" when the question itself fails: that is not evidence the process stopped.
fn process_of(slot: &mut Option<Child>) -> Process {
    let Some(child) = slot.as_mut() else {
        return Process::None;
    };
    match child.try_wait() {
        Ok(None) | Err(_) => Process::Running,
        Ok(Some(status)) => Process::Ended {
            code: match status.code() {
                Some(code) => format!("exit code {code}"),
                None => "ended by a signal".to_string(),
            },
        },
    }
}

/// The slot the coordinator lives in. Taken from a `State` the caller holds, because
/// the guard cannot outlive the state it was read from.
fn lock(state: &Coordinator) -> Result<std::sync::MutexGuard<'_, Option<Child>>, String> {
    state
        .0
        .lock()
        .map_err(|_| "the coordinator handle is poisoned".to_string())
}

/// The whole of the panel's picture: the file, the coordinator process, and `/health`.
#[tauri::command]
pub async fn group_status(
    app: tauri::AppHandle,
    config_path: String,
    port: u16,
) -> Result<GroupStatus, String> {
    backend::off_thread(move || {
        let state = app.state::<Coordinator>();
        let mut slot = lock(&state)?;
        let process = process_of(&mut slot);
        let answer = probe_health(port);
        let health = health_from(answer, process == Process::Running);

        let mut status = GroupStatus {
            configured: false,
            problem: None,
            model_name: None,
            devices: None,
            draft_tokens: DRAFT_TOKENS_DEFAULT,
            health,
            coordinator: process,
            port,
        };
        let named = config_path.trim();
        if named.is_empty() {
            return Ok(status);
        }
        match read_group(&expand(named)).and_then(|map| summarise(&map)) {
            Ok(summary) => {
                status.configured = true;
                status.model_name = Some(summary.model_name);
                status.devices = Some(summary.devices);
                status.draft_tokens = summary.draft_tokens;
            }
            Err(problem) => status.problem = Some(problem),
        }
        Ok(status)
    })
    .await
}

/// Start the coordinator the way `backend::network_join` starts the join: the CLI
/// resolved by `backend::cli`, its output appended to a log, and the child held in the
/// slot. The CLI is run with the same `--no-color --no-update` prefix every other call
/// uses.
#[tauri::command]
pub async fn group_start(
    app: tauri::AppHandle,
    config_path: String,
    port: u16,
) -> Result<(), String> {
    backend::off_thread(move || {
        check_start_port(port)?;
        let named = expand(config_path.trim());
        let path = std::fs::canonicalize(&named).map_err(|e| {
            format!(
                "couldn't find the group's configuration {}: {e}",
                named.display()
            )
        })?;
        read_group(&path)?;

        let state = app.state::<Coordinator>();
        let mut slot = lock(&state)?;
        if process_of(&mut slot) == Process::Running {
            return Err("the coordinator is already running".to_string());
        }

        let Cli {
            mut cmd,
            named: bin,
        } = backend::cli()?;
        let home = backend::home_dir()
            .map_err(|_| "no home to write the coordinator log to".to_string())?;
        let dir = home.join(".common-network");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
        let log_path = dir.join(COORDINATOR_LOG);
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("couldn't open {}: {e}", log_path.display()))?;
        let log_err = log
            .try_clone()
            .map_err(|e| format!("couldn't duplicate the log handle: {e}"))?;

        cmd.arg("--no-color")
            .arg("--no-update")
            .arg("join")
            .arg("--distributed-config")
            .arg(&path)
            .arg("--local-only")
            .arg("--port")
            .arg(port.to_string());
        backend::cli_env(&mut cmd);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::from(log));
        cmd.stderr(Stdio::from(log_err));

        // Its own process group, so Stop reaches the llama-server the CLI starts. Without
        // it, a coordinator killed past the grace period leaves the runtime holding the port.
        #[cfg(unix)]
        cmd.process_group(0);
        let child = cmd.spawn().map_err(|e| backend::launch_error(&bin, e))?;
        *slot = Some(child);
        Ok(())
    })
    .await
}

/// Send a signal to the coordinator's process group, so its llama-server goes with it.
#[cfg(unix)]
fn signal_group(pid: u32, signal: &str) {
    let _ = std::process::Command::new("kill")
        .args(["-s", signal, "--", &format!("-{pid}")])
        .status();
}

#[cfg(not(unix))]
fn signal_group(pid: u32, signal: &str) {
    if signal == "KILL" {
        backend::kill_join(pid);
    } else {
        backend::terminate(pid);
    }
}

/// Stop the coordinator: SIGTERM first, so the CLI stops its llama-server and the RPC
/// connections cleanly, then a kill if it has not gone within `STOP_POLLS`. Returns
/// `false` when this app had no coordinator running.
#[tauri::command]
pub async fn group_stop(app: tauri::AppHandle) -> Result<bool, String> {
    backend::off_thread(move || {
        let pid = {
            let state = app.state::<Coordinator>();
            let mut slot = lock(&state)?;
            match process_of(&mut slot) {
                Process::Running => slot.as_ref().map(Child::id),
                _ => None,
            }
        };
        let Some(pid) = pid else {
            return Ok(false);
        };

        signal_group(pid, "TERM");
        for _ in 0..STOP_POLLS {
            let state = app.state::<Coordinator>();
            let mut slot = lock(&state)?;
            if process_of(&mut slot) != Process::Running {
                return Ok(true);
            }
            drop(slot);
            std::thread::sleep(STOP_POLL_INTERVAL);
        }
        signal_group(pid, "KILL");
        Ok(true)
    })
    .await
}

/// Set `draft_tokens` in the group's configuration, leaving every other field as it
/// was. The coordinator reads the file only when it starts, so the change applies at
/// the next start.
#[tauri::command]
pub async fn group_set_draft_tokens(config_path: String, draft_tokens: u32) -> Result<u32, String> {
    backend::off_thread(move || {
        let named = expand(config_path.trim());
        let path = std::fs::canonicalize(&named).map_err(|e| {
            format!(
                "couldn't find the group's configuration {}: {e}",
                named.display()
            )
        })?;
        write_draft_tokens(&path, draft_tokens)
    })
    .await
}

/// The write behind `group_set_draft_tokens`. The file is rewritten through a temporary
/// sibling and renamed over the original, so an interrupted write leaves the old
/// configuration whole. The keys are written back in the order `serde_json` uses, which
/// is alphabetical; the CLI reads the file by key and does not depend on the order.
pub fn write_draft_tokens(path: &Path, value: u32) -> Result<u32, String> {
    let value = check_draft_tokens(value)?;
    let mut map = read_group(path)?;
    map.insert("draft_tokens".to_string(), Value::from(value));

    let mut text = serde_json::to_string_pretty(&Value::Object(map))
        .map_err(|e| format!("couldn't write the group's configuration: {e}"))?;
    text.push('\n');

    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, text).map_err(|e| format!("couldn't write {}: {e}", temp.display()))?;
    if let Err(e) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("couldn't replace {}: {e}", path.display()));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    const GROUP: &str = r#"{
  "version": 2,
  "binary": "/opt/llama/bin/llama-server",
  "target_model": "/models/Qwen3-32B.gguf",
  "draft_model": null,
  "model_name": "Qwen3-32B",
  "rpc_servers": ["127.0.0.1:50051", "127.0.0.1:50052"],
  "devices": ["RPC0", "RPC1"],
  "tensor_split": [1, 1],
  "draft_device": "none",
  "context": 4096,
  "parallel": 1
}"#;

    /// A scratch directory of this test's own, cleared before use.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("common-group-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    fn parsed(text: &str) -> Map<String, Value> {
        match serde_json::from_str(text).expect("valid JSON") {
            Value::Object(map) => map,
            other => panic!("not an object: {other:?}"),
        }
    }

    /// A listener that answers one request with `status_line`, and the status the probe
    /// reads back from it.
    fn answer_once(status_line: &'static str) -> Option<u16> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("a loopback port");
        let port = listener.local_addr().expect("the port").port();
        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("a probe");
            let mut request = [0u8; 1024];
            let _ = conn.read(&mut request);
            let _ = conn.write_all(
                format!("{status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            );
        });
        let answer = probe_health(port);
        server.join().expect("the server finished");
        answer
    }

    #[test]
    fn draft_tokens_are_bounded_as_the_cli_bounds_them() {
        assert!(check_draft_tokens(0).is_err());
        assert_eq!(check_draft_tokens(1), Ok(1));
        assert_eq!(check_draft_tokens(32), Ok(32));
        assert!(check_draft_tokens(33).is_err());
    }

    #[test]
    fn a_missing_draft_length_reads_as_the_cli_default_and_a_bad_one_is_named() {
        let map = parsed(GROUP);
        let summary = summarise(&map).expect("a group without draft_tokens is valid");
        assert_eq!(summary.draft_tokens, DRAFT_TOKENS_DEFAULT);
        assert_eq!(summary.devices, 2);
        assert_eq!(summary.model_name, "Qwen3-32B");

        let mut bad = parsed(GROUP);
        bad.insert("draft_tokens".to_string(), Value::from(40));
        let problem = summarise(&bad).expect_err("40 is outside the range");
        assert!(problem.contains("draft_tokens"), "{problem}");
    }

    #[test]
    fn writing_draft_tokens_changes_that_field_and_no_other() {
        let dir = scratch("write");
        let path = dir.join("network.json");
        std::fs::write(&path, GROUP).expect("a group on disk");

        assert_eq!(write_draft_tokens(&path, 8), Ok(8));

        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("the file")).expect("JSON");
        let mut expected: Value = serde_json::from_str(GROUP).expect("JSON");
        expected["draft_tokens"] = Value::from(8);
        assert_eq!(after, expected);
        assert!(
            !dir.join("network.json.tmp").exists(),
            "the temporary file is renamed away"
        );

        let before_refusal = std::fs::read(&path).expect("the file");
        assert!(write_draft_tokens(&path, 33).is_err());
        assert_eq!(std::fs::read(&path).expect("the file"), before_refusal);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_not_a_version_two_group_is_left_alone() {
        let dir = scratch("version");
        let path = dir.join("network.json");
        let version_one = GROUP.replace("\"version\": 2", "\"version\": 1");
        std::fs::write(&path, &version_one).expect("a file on disk");

        assert!(write_draft_tokens(&path, 4).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).expect("the file"),
            version_one
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn health_is_read_from_the_status_line_the_coordinator_sends() {
        assert_eq!(answer_once("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(answer_once("HTTP/1.1 503 Service Unavailable"), Some(503));
        assert_eq!(
            health_from(answer_once("HTTP/1.1 200 OK"), false),
            Health::Ready
        );
        assert_eq!(
            health_from(answer_once("HTTP/1.1 503 Service Unavailable"), false),
            Health::Loading
        );
    }

    #[test]
    fn a_port_nothing_listens_on_is_stopped_or_loading_depending_on_this_apps_process() {
        let port = {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("a loopback port");
            listener.local_addr().expect("the port").port()
        };
        assert_eq!(probe_health(port), None);
        assert_eq!(health_from(None, false), Health::Stopped);
        assert_eq!(health_from(None, true), Health::Loading);
        assert_eq!(health_from(Some(200), false), Health::Ready);
    }

    #[test]
    fn the_coordinator_port_must_be_a_usable_port() {
        assert_eq!(check_start_port(11437), Ok(()));
        assert_eq!(check_start_port(MIN_COORDINATOR_PORT), Ok(()));
        assert!(check_start_port(80).is_err());
    }
}
