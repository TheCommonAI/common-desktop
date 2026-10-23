//! The peer: this machine's seat in the layer network.
//!
//! The app does not implement the network and does not talk to a gateway. It runs
//! the CLI's own peer, `common join --network --api`, as a long-lived child, and
//! reads what that peer says about itself from a status file. Everything the
//! screens show — what is downloading, which layers are ours, who else is on,
//! whether chat is ready — is that file. Chat goes to the same process, on
//! loopback, over its OpenAI-compatible API.
//!
//! Three jobs live here:
//!
//! - **Running it.** Start, stop (a polite signal, so the peer tells the others it
//!   is leaving), and a supervisor that restarts it with a growing pause if it
//!   dies while the user still wants it on.
//! - **Reading it.** The status file is untrusted input: it is validated, scrubbed
//!   of anything that could be a secret, and judged stale or crashed by its
//!   timestamp and whether its pid is alive.
//! - **Chatting through it.** `chat_stream` posts to the peer's API from here and
//!   hands tokens to the page as events, because the page cannot call loopback
//!   without CORS and because a stream is easiest to cancel from the side that
//!   owns the socket.
//!
//! No new dependencies. The HTTP is a hand-written client for one loopback
//! endpoint, which is small precisely because it only ever talks to our own peer.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::backend::{
    Cli, cli, cli_env, cli_path, cli_version, home_dir, launch_error, silent, tail_lines,
};

/// The port the peer serves its chat API on unless the status file says otherwise.
const DEFAULT_API_PORT: u16 = 11440;
/// A status file older than this, with no live process behind it, is a crash.
const STALE_SECONDS: f64 = 15.0;
/// How often the supervisor looks, and so how often the page is told.
const TICK: Duration = Duration::from_millis(1500);
/// A peer that stayed up this long was healthy, so its restart count starts over.
const HEALTHY_AFTER: Duration = Duration::from_secs(120);
/// The longest pause between restarts.
const MAX_BACKOFF: u64 = 60;
/// How long a freshly started peer is left alone before silence counts as death.
const START_GRACE: Duration = Duration::from_secs(90);
/// How long a stopped peer gets to say goodbye before it is ended.
const GRACE: Duration = Duration::from_secs(20);

const STATES: &[&str] = &[
    "starting",
    "downloading",
    "loading",
    "up",
    "moving",
    "leaving",
    "stopped",
    "error",
];

/* --------------------------------- paths ---------------------------------- */

fn net_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".common-network").join("net"))
}

/// Where the peer writes its status. The app hands this path to the child in
/// `COMMONNET_STATUS_FILE`, so both sides agree even when the variable is set.
fn status_path() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("COMMONNET_STATUS_FILE").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(explicit));
    }
    Ok(net_dir()?.join("status.json"))
}

fn log_path() -> Result<PathBuf, String> {
    Ok(net_dir()?.join("peer.log"))
}

fn now_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/* ------------------------------ the status file ----------------------------- */

/// Drop anything that looks like a credential, however deep. The contract says the
/// file never holds one; this is the belt to that braces, because the object goes
/// to the page and into reports people send to others.
fn scrub(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| {
                let k = key.to_ascii_lowercase();
                !(k.contains("token")
                    || k.contains("secret")
                    || k.contains("password")
                    || k == "key")
            });
            for v in map.values_mut() {
                scrub(v);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub),
        _ => {}
    }
}

/// The status file as a validated object, or `None` when it is missing, not JSON,
/// the wrong version, or names a state this build does not know.
fn read_status() -> Option<Value> {
    let raw = std::fs::read_to_string(status_path().ok()?).ok()?;
    let mut value: Value = serde_json::from_str(&raw).ok()?;
    let object = value.as_object()?;
    if object.get("v").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let state = object.get("state").and_then(Value::as_str)?;
    if !STATES.contains(&state) {
        return None;
    }
    scrub(&mut value);
    Some(value)
}

fn status_pid(status: &Value) -> Option<u32> {
    status.get("pid").and_then(Value::as_u64).map(|p| p as u32)
}

fn status_age(status: &Value) -> f64 {
    status
        .get("ts")
        .and_then(Value::as_f64)
        .map(|ts| (now_seconds() - ts).max(0.0))
        .unwrap_or(f64::INFINITY)
}

/// Is there a process with this pid? Asked of the system, not of a handle: on
/// Windows the program this app starts is a wrapper that hands off to the real
/// peer and exits, so the handle outlives nothing and the pid is the only witness.
fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        let out = silent("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output();
        return match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")),
            Err(_) => false,
        };
    }
    #[cfg(not(windows))]
    {
        silent("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/* -------------------------------- the state --------------------------------- */

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    /// The user wants the peer on. The supervisor restarts it while this is true.
    want: bool,
    network: Option<String>,
    started: Option<Instant>,
    restarts: u32,
    next_try: Option<Instant>,
    last_exit: Option<String>,
    /// Why it cannot start at all (no CLI, CLI too old). Cleared by a new start.
    problem: Option<String>,
}

/// The one peer this app runs.
#[derive(Default)]
pub struct Peer(Mutex<Inner>);

/// What the page is told, on every tick and on request.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    /// The user has the peer switched on.
    want_running: bool,
    /// A process is alive that is (or is handing off to) our peer.
    running: bool,
    /// The peer's own account of itself, validated and scrubbed.
    status: Option<Value>,
    /// The file stopped being updated while its process is gone.
    crashed: bool,
    /// Seconds since the file was last written, when there is one.
    status_age: Option<f64>,
    restarts: u32,
    last_exit: Option<String>,
    /// A reason the peer cannot start, in a sentence for the user.
    problem: Option<String>,
    log_path: String,
    status_path: String,
}

fn view(inner: &mut Inner) -> PeerView {
    let handle_alive = match inner.child.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(code)) => {
                inner.last_exit = Some(format!("exited with {code}"));
                inner.child = None;
                false
            }
            Err(_) => false,
        },
        None => false,
    };
    let status = read_status();
    let age = status.as_ref().map(status_age);
    let pid_ok = status
        .as_ref()
        .and_then(status_pid)
        .map(pid_alive)
        .unwrap_or(false);
    let state = status
        .as_ref()
        .and_then(|s| s.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let finished = matches!(state, "stopped" | "leaving" | "error");
    let fresh = age.map(|a| a <= STALE_SECONDS).unwrap_or(false);
    // Alive means a process is there and, when we only have its pid, that it is
    // still writing. A pid that was reused by something else would not be fresh.
    let running = handle_alive || (pid_ok && fresh && !matches!(state, "stopped"));
    let crashed = status.is_some()
        && !finished
        && !running
        && age.map(|a| a > STALE_SECONDS).unwrap_or(false);
    PeerView {
        want_running: inner.want,
        running,
        status,
        crashed,
        status_age: age.filter(|a| a.is_finite()),
        restarts: inner.restarts,
        last_exit: inner.last_exit.clone(),
        problem: inner.problem.clone(),
        log_path: log_path()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        status_path: status_path()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    }
}

/* ------------------------------- starting it -------------------------------- */

/// Does the installed CLI know `join --network`? An older CLI would reject the flag
/// with a usage error that means nothing to the user, so ask first.
fn cli_knows_layer_network() -> Result<bool, String> {
    let Cli { mut cmd, named } = cli()?;
    let out = cmd
        .args(["--no-color", "--no-update", "join", "--help"])
        .output()
        .map_err(|e| launch_error(&named, e))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(text.contains("--network"))
}

fn spawn(network: Option<&str>) -> Result<Child, String> {
    let Cli { mut cmd, named } = cli()?;
    let dir = net_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path()?)
        .map_err(|e| format!("couldn't open the peer log: {e}"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("couldn't duplicate the log handle: {e}"))?;

    cmd.arg("--no-color")
        .arg("--no-update")
        .arg("join")
        .arg("--network");
    if let Some(net) = network.filter(|n| !n.trim().is_empty()) {
        cmd.arg(net.trim());
    }
    cmd.arg("--api");
    cli_env(&mut cmd);
    cmd.env("COMMONNET_STATUS_FILE", status_path()?);
    cmd.env("PYTHONUNBUFFERED", "1");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::from(log));
    cmd.stderr(Stdio::from(log_err));
    cmd.spawn().map_err(|e| launch_error(&named, e))
}

fn start_now(inner: &mut Inner) -> Result<(), String> {
    if inner.child.is_some() {
        return Ok(());
    }
    let network = inner.network.clone();
    let child = spawn(network.as_deref())?;
    inner.child = Some(child);
    inner.started = Some(Instant::now());
    inner.problem = None;
    Ok(())
}

#[tauri::command]
pub async fn peer_start(app: AppHandle, network: Option<String>) -> Result<PeerView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Peer>();
        {
            let mut inner = state
                .0
                .lock()
                .map_err(|_| "peer state is poisoned".to_string())?;
            inner.want = true;
            inner.network = network.filter(|n| !n.trim().is_empty());
            inner.restarts = 0;
            inner.next_try = None;
            inner.problem = None;
        }
        // The check can take a moment and the lock should not be held across it.
        let ok = cli_knows_layer_network();
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "peer state is poisoned".to_string())?;
        match ok {
            Err(message) => {
                inner.want = false;
                inner.problem = Some(message.clone());
                return Err(message);
            }
            Ok(false) => {
                let message = "Your copy of Common's command-line tool is older than this app. \
                    Run the installer again to update it, then switch this on."
                    .to_string();
                inner.want = false;
                inner.problem = Some(message.clone());
                return Err(message);
            }
            Ok(true) => {}
        }
        // A peer that is already running (started by a previous run of the app, or
        // from a terminal) is adopted rather than started twice.
        let adopted = read_status()
            .map(|s| {
                status_age(&s) <= STALE_SECONDS && status_pid(&s).map(pid_alive).unwrap_or(false)
            })
            .unwrap_or(false);
        if !adopted {
            start_now(&mut inner)?;
        }
        Ok(view(&mut inner))
    })
    .await
    .map_err(|e| format!("start panicked: {e}"))?
}

/* -------------------------------- stopping it -------------------------------- */

/// Ask a process to leave. A polite interrupt on Unix, so the peer can publish
/// `leaving` and the others stop sending it work at once. Windows has no console
/// interrupt a GUI process can send without extra dependencies, so there the
/// process is ended and the others notice after its record ages out.
fn interrupt(pid: u32) {
    #[cfg(windows)]
    {
        let _ = silent("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = silent("kill").args(["-INT", &pid.to_string()]).output();
    }
}

fn force(pid: u32) {
    #[cfg(windows)]
    {
        let _ = silent("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = silent("kill").args(["-KILL", &pid.to_string()]).output();
    }
}

/// Stop the peer: ask it to leave, give it `GRACE` to do so, then end it.
fn stop_blocking(app: &AppHandle) {
    let state = app.state::<Peer>();
    let (child_pid, status_pid_) = {
        let mut inner = match state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        inner.want = false;
        inner.next_try = None;
        (
            inner.child.as_ref().map(|c| c.id()),
            read_status().as_ref().and_then(status_pid),
        )
    };
    let mut pids: Vec<u32> = [child_pid, status_pid_].into_iter().flatten().collect();
    pids.dedup();
    for pid in &pids {
        interrupt(*pid);
    }
    let deadline = Instant::now() + GRACE;
    while Instant::now() < deadline {
        if pids.iter().all(|p| !pid_alive(*p)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    for pid in &pids {
        if pid_alive(*pid) {
            force(*pid);
        }
    }
    if let Ok(mut inner) = state.0.lock() {
        if let Some(mut child) = inner.child.take() {
            let _ = child.wait();
        }
        inner.started = None;
    }
}

#[tauri::command]
pub async fn peer_stop(app: AppHandle) -> Result<PeerView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_blocking(&app);
        let state = app.state::<Peer>();
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "peer state is poisoned".to_string())?;
        Ok(view(&mut inner))
    })
    .await
    .map_err(|e| format!("stop panicked: {e}"))?
}

#[tauri::command]
pub async fn peer_status(app: AppHandle) -> Result<PeerView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Peer>();
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "peer state is poisoned".to_string())?;
        Ok(view(&mut inner))
    })
    .await
    .map_err(|e| format!("status panicked: {e}"))?
}

/// Called when the app quits: leave the network properly.
pub fn shutdown(app: &AppHandle) {
    let wanted = app
        .state::<Peer>()
        .0
        .lock()
        .map(|i| i.want || i.child.is_some())
        .unwrap_or(false);
    if wanted {
        stop_blocking(app);
    }
}

/* ------------------------------- the supervisor ------------------------------ */

/// Watches the peer for the life of the app: tells the page what it sees, and
/// restarts the peer, with a growing pause, when it dies while it is wanted.
pub fn supervise(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(TICK);
            let state = app.state::<Peer>();
            let snapshot = {
                let mut inner = match state.0.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let mut snap = view(&mut inner);
                if let Some(started) = inner.started
                    && snap.running
                    && started.elapsed() > HEALTHY_AFTER
                {
                    inner.restarts = 0;
                }
                if inner.want && !snap.running && inner.problem.is_none() {
                    let due = inner.next_try.map(|t| Instant::now() >= t).unwrap_or(true);
                    // A peer takes a while to write its first status, and on Windows the
                    // process this app holds hands off and exits at once. Until the grace
                    // has passed, "no status yet" must not read as "dead", or a second
                    // peer would be started on top of the first.
                    let settled = inner
                        .started
                        .map(|t| t.elapsed() > START_GRACE)
                        .unwrap_or(true);
                    if due && settled {
                        let wait = (2u64 << inner.restarts.min(5)).min(MAX_BACKOFF);
                        inner.next_try = Some(Instant::now() + Duration::from_secs(wait));
                        inner.restarts = inner.restarts.saturating_add(1);
                        // The first start is the user's own; anything after it is a
                        // restart, and a failure to start is recorded, not retried hot.
                        if (inner.started.is_some() || snap.crashed)
                            && let Err(message) = start_now(&mut inner)
                        {
                            inner.problem = Some(message);
                        }
                        snap = view(&mut inner);
                    }
                }
                snap
            };
            let _ = app.emit("peer-status", &snapshot);
        }
    });
}

/* --------------------------------- the log ---------------------------------- */

#[tauri::command]
pub async fn peer_log_tail(lines: Option<usize>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = log_path()?;
        match std::fs::read(&path) {
            Ok(bytes) => Ok(tail_lines(
                &String::from_utf8_lossy(&bytes),
                lines.unwrap_or(60).min(400),
            )),
            Err(_) => Ok(String::new()),
        }
    })
    .await
    .map_err(|e| format!("log read panicked: {e}"))?
}

/// What to hand somebody when it will not connect. Reads only this machine: no
/// network call, and nothing secret — the status file is scrubbed on the way in.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    app_version: String,
    cli_path: String,
    cli_version: Option<String>,
    cli_knows_layer_network: Option<bool>,
    os: String,
    view: PeerView,
    log_tail: String,
}

#[tauri::command]
pub async fn diagnostics(app: AppHandle) -> Result<Diagnostics, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Peer>();
        let view = {
            let mut inner = state
                .0
                .lock()
                .map_err(|_| "peer state is poisoned".to_string())?;
            view(&mut inner)
        };
        let log_tail = log_path()
            .ok()
            .and_then(|p| std::fs::read(p).ok())
            .map(|b| tail_lines(&String::from_utf8_lossy(&b), 120))
            .unwrap_or_default();
        Ok(Diagnostics {
            app_version: app.package_info().version.to_string(),
            cli_path: cli_path(),
            cli_version: cli_version(),
            cli_knows_layer_network: cli_knows_layer_network().ok(),
            os: std::env::consts::OS.to_string(),
            view,
            log_tail,
        })
    })
    .await
    .map_err(|e| format!("diagnostics panicked: {e}"))?
}

/* ---------------------------------- chatting --------------------------------- */

/// One running chat request: a flag to stop reading, and the socket to shut so a
/// blocked read wakes up at once.
struct Run {
    cancel: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
}

/// The chats in flight, by the id the page chose.
#[derive(Default)]
pub struct Chats(Mutex<HashMap<String, Arc<Run>>>);

/// Where a chat event goes. The command sends them to the page; a test collects them.
type Emit<'a> = &'a dyn Fn(Value);

/// Splits a byte stream into lines without losing a line that straddles two reads.
#[derive(Default)]
struct Lines(Vec<u8>);

impl Lines {
    fn push(&mut self, bytes: &[u8], mut each: impl FnMut(&str)) {
        self.0.extend_from_slice(bytes);
        while let Some(at) = self.0.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.0.drain(..=at).collect();
            each(String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']));
        }
    }
}

/// One `data:` line of the stream, as the page needs it.
fn handle_sse(emit: Emit, id: &str, line: &str, done: &mut bool) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let data = data.trim();
    if data == "[DONE]" {
        *done = true;
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The network stopped answering.");
        emit(json!({"id": id, "kind": "error", "status": 200, "message": message}));
        *done = true;
        return;
    }
    let choice = &value["choices"][0];
    if let Some(text) = choice["delta"]["content"].as_str()
        && !text.is_empty()
    {
        emit(json!({"id": id, "kind": "delta", "text": text}));
    }
    if choice["finish_reason"].is_string() {
        emit(json!({"id": id, "kind": "finish", "reason": choice["finish_reason"].clone()}));
    }
}

fn api_port() -> u16 {
    read_status()
        .and_then(|s| s["api"]["port"].as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_API_PORT)
}

/// Read a chunked body, handing each decoded piece on. Returns false if the framing is broken.
fn read_chunked(reader: &mut impl BufRead, mut piece: impl FnMut(&[u8])) -> bool {
    loop {
        let mut size_line = String::new();
        if reader.read_line(&mut size_line).unwrap_or(0) == 0 {
            return true;
        }
        let size_text = size_line.trim().split(';').next().unwrap_or("");
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            return false;
        };
        if size == 0 {
            return true;
        }
        let mut chunk = vec![0u8; size];
        if reader.read_exact(&mut chunk).is_err() {
            return true;
        }
        piece(&chunk);
        let mut crlf = [0u8; 2];
        let _ = reader.read_exact(&mut crlf);
    }
}

fn run_chat(port: u16, emit: Emit, id: &str, body: String, run: &Arc<Run>) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
        Ok(s) => s,
        Err(_) => {
            emit(json!({"id": id, "kind": "error", "status": 0,
                        "message": "Chat isn't running on this computer yet. Give it a moment after joining."}));
            return;
        }
    };
    // A long prompt can take minutes to read before the first word, so reads wait.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
    if let Ok(clone) = stream.try_clone()
        && let Ok(mut slot) = run.socket.lock()
    {
        *slot = Some(clone);
    }
    let request = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Accept: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    if stream.write_all(request.as_bytes()).is_err() {
        emit(
            json!({"id": id, "kind": "error", "status": 0, "message": "Couldn't reach chat on this computer."}),
        );
        return;
    }

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).unwrap_or(0) == 0 {
        if !run.cancel.load(Ordering::SeqCst) {
            emit(
                json!({"id": id, "kind": "error", "status": 0, "message": "Chat closed the connection."}),
            );
        }
        return;
    }
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut chunked = false;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
            break;
        }
        let lower = header.to_ascii_lowercase();
        if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        }
    }

    if !(200..300).contains(&status) {
        let mut raw = Vec::new();
        if chunked {
            read_chunked(&mut reader, |piece| raw.extend_from_slice(piece));
        } else {
            let _ = reader.take(64 * 1024).read_to_end(&mut raw);
        }
        let parsed: Option<Value> = serde_json::from_slice(&raw).ok();
        let message = parsed
            .as_ref()
            .and_then(|v| v["error"]["message"].as_str())
            .unwrap_or("The network couldn't answer that just now.")
            .to_string();
        emit(json!({"id": id, "kind": "error", "status": status, "message": message}));
        return;
    }

    let mut lines = Lines::default();
    let mut done = false;
    if chunked {
        read_chunked(&mut reader, |piece| {
            lines.push(piece, |line| handle_sse(emit, id, line, &mut done));
        });
    } else {
        let mut buffer = [0u8; 4096];
        loop {
            if run.cancel.load(Ordering::SeqCst) || done {
                break;
            }
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => lines.push(&buffer[..n], |line| handle_sse(emit, id, line, &mut done)),
            }
        }
    }
    if !run.cancel.load(Ordering::SeqCst) {
        emit(json!({"id": id, "kind": "done"}));
    }
}

#[tauri::command]
pub fn chat_stream(
    app: AppHandle,
    id: String,
    messages: Value,
    max_tokens: Option<u32>,
    temperature: Option<f64>,
) -> Result<(), String> {
    if !messages.is_array() {
        return Err("messages must be a list".to_string());
    }
    let body = json!({
        "model": "common",
        "messages": messages,
        "stream": true,
        "max_tokens": max_tokens.unwrap_or(1024),
        "temperature": temperature.unwrap_or(0.7),
    })
    .to_string();
    let run = Arc::new(Run {
        cancel: AtomicBool::new(false),
        socket: Mutex::new(None),
    });
    {
        let chats = app.state::<Chats>();
        let mut map = chats
            .0
            .lock()
            .map_err(|_| "chat state is poisoned".to_string())?;
        map.insert(id.clone(), run.clone());
    }
    std::thread::spawn(move || {
        let port = api_port();
        let send = |payload: Value| {
            let _ = app.emit("chat", payload);
        };
        run_chat(port, &send, &id, body, &run);
        if let Ok(mut map) = app.state::<Chats>().0.lock() {
            map.remove(&id);
        }
    });
    Ok(())
}

/// Stop a chat: flag it, and shut the socket so a read that is waiting for the
/// next word wakes up now rather than when the word arrives.
#[tauri::command]
pub fn chat_stop(app: AppHandle, id: String) {
    let run = app
        .state::<Chats>()
        .0
        .lock()
        .ok()
        .and_then(|map| map.get(&id).cloned());
    if let Some(run) = run {
        run.cancel.store(true, Ordering::SeqCst);
        if let Ok(slot) = run.socket.lock()
            && let Some(socket) = slot.as_ref()
        {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

/* ----------------------------------- tests ----------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_removes_anything_that_looks_like_a_credential_at_any_depth() {
        let mut value = json!({
            "state": "up",
            "token": "x",
            "peers": [{"peer": "a", "Block_Token": "y", "nested": {"api_key": 1, "key": 2, "secret_thing": 3, "ok": 4}}],
        });
        scrub(&mut value);
        let text = value.to_string();
        assert!(!text.contains("\"token\""));
        assert!(!text.contains("Block_Token"));
        assert!(!text.contains("secret_thing"));
        assert!(!text.contains("\"key\""));
        assert!(text.contains("\"ok\":4"));
        assert!(
            text.contains("api_key"),
            "only exactly `key` or the listed words go"
        );
    }

    #[test]
    fn lines_survive_a_split_across_reads() {
        let mut got = Vec::new();
        let mut lines = Lines::default();
        lines.push(b"data: {\"a\"", |l| got.push(l.to_string()));
        lines.push(b":1}\r\n\r\ndata: [DONE]\n", |l| got.push(l.to_string()));
        assert_eq!(got, vec!["data: {\"a\":1}", "", "data: [DONE]"]);
    }

    #[test]
    fn chunked_bodies_are_decoded_in_order() {
        let raw = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        let mut reader = BufReader::new(&raw[..]);
        let mut out = Vec::new();
        assert!(read_chunked(&mut reader, |p| out.extend_from_slice(p)));
        assert_eq!(out, b"Wikipedia");
    }

    #[test]
    fn a_status_older_than_the_limit_with_no_process_is_a_crash() {
        let mut inner = Inner::default();
        let dir = std::env::temp_dir().join(format!("peer-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("status.json");
        let stale = json!({"v": 1, "state": "up", "pid": 999_999, "ts": now_seconds() - 120.0});
        std::fs::write(&file, stale.to_string()).unwrap();
        unsafe { std::env::set_var("COMMONNET_STATUS_FILE", &file) };
        let v = view(&mut inner);
        assert!(v.crashed && !v.running);
        // A cleanly stopped peer is not a crash, however old the file.
        let stopped =
            json!({"v": 1, "state": "stopped", "pid": 999_999, "ts": now_seconds() - 120.0});
        std::fs::write(&file, stopped.to_string()).unwrap();
        let v = view(&mut inner);
        assert!(!v.crashed && !v.running);
        // An unknown state or a wrong version is not trusted at all.
        std::fs::write(&file, json!({"v": 2, "state": "up"}).to_string()).unwrap();
        assert!(read_status().is_none());
        std::fs::write(&file, json!({"v": 1, "state": "dancing"}).to_string()).unwrap();
        assert!(read_status().is_none());
        unsafe { std::env::remove_var("COMMONNET_STATUS_FILE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- chat, against a fake peer on loopback ---- */

    use std::net::TcpListener;
    use std::sync::Mutex as StdMutex;

    /// A one-shot HTTP server: reads the request head, writes `reply`, then holds the
    /// connection for `hold` before closing. Returns the port.
    fn fake_peer(reply: Vec<u8>, hold: Duration) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut seen = Vec::new();
                let mut byte = [0u8; 1];
                while !seen.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        return;
                    }
                    seen.push(byte[0]);
                }
                // The body is read off so the client's write does not block; its content is
                // not what is under test.
                let want = String::from_utf8_lossy(&seen)
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut body = vec![0u8; want];
                let _ = stream.read_exact(&mut body);
                let _ = stream.write_all(&reply);
                let _ = stream.flush();
                std::thread::sleep(hold);
            }
        });
        port
    }

    fn chat_events(port: u16) -> Vec<Value> {
        let events = StdMutex::new(Vec::new());
        let run = Arc::new(Run {
            cancel: AtomicBool::new(false),
            socket: Mutex::new(None),
        });
        run_chat(
            port,
            &|v| events.lock().unwrap().push(v),
            "t",
            "{}".to_string(),
            &run,
        );
        events.into_inner().unwrap()
    }

    fn text_of(events: &[Value]) -> String {
        events
            .iter()
            .filter(|e| e["kind"] == "delta")
            .filter_map(|e| e["text"].as_str())
            .collect()
    }

    const SSE: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
                       data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n\
                       data: [DONE]\n\n";

    #[test]
    fn a_chunked_event_stream_arrives_as_deltas_then_done() {
        let mut reply = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        // Split mid-event on purpose: a chunk boundary is not an event boundary.
        let (a, b) = SSE.split_at(40);
        for part in [a, b] {
            reply.extend_from_slice(format!("{:x}\r\n{}\r\n", part.len(), part).as_bytes());
        }
        reply.extend_from_slice(b"0\r\n\r\n");
        let events = chat_events(fake_peer(reply, Duration::from_millis(0)));
        assert_eq!(text_of(&events), "Hello");
        assert_eq!(events.last().unwrap()["kind"], "done");
        assert!(
            events
                .iter()
                .any(|e| e["kind"] == "finish" && e["reason"] == "stop")
        );
    }

    #[test]
    fn a_close_delimited_stream_works_too() {
        // What Python's http.server sends: HTTP/1.0 style, no length, ends when the socket closes.
        let reply =
            format!("HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\n{SSE}").into_bytes();
        let events = chat_events(fake_peer(reply, Duration::from_millis(0)));
        assert_eq!(text_of(&events), "Hello");
        assert_eq!(events.last().unwrap()["kind"], "done");
    }

    #[test]
    fn a_503_becomes_one_error_with_the_servers_own_sentence() {
        let body = r#"{"error":{"message":"Not enough peers are online to answer yet.","type":"unavailable"}}"#;
        let reply = format!(
            "HTTP/1.0 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes();
        let events = chat_events(fake_peer(reply, Duration::from_millis(0)));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["kind"], "error");
        assert_eq!(events[0]["status"], 503);
        assert_eq!(
            events[0]["message"],
            "Not enough peers are online to answer yet."
        );
    }

    #[test]
    fn nothing_listening_is_a_friendly_error_not_a_hang() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let events = chat_events(port);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["status"], 0);
        assert!(
            events[0]["message"]
                .as_str()
                .unwrap()
                .contains("Chat isn't running")
        );
    }

    #[test]
    fn stopping_wakes_a_read_that_is_waiting_for_the_next_word() {
        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n";
        let reply = format!("HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\n{first}")
            .into_bytes();
        // The peer then goes quiet for far longer than the test waits.
        let port = fake_peer(reply, Duration::from_secs(30));
        let events = Arc::new(StdMutex::new(Vec::new()));
        let run = Arc::new(Run {
            cancel: AtomicBool::new(false),
            socket: Mutex::new(None),
        });
        let (e2, r2) = (events.clone(), run.clone());
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            run_chat(
                port,
                &|v| e2.lock().unwrap().push(v),
                "t",
                "{}".to_string(),
                &r2,
            );
        });
        // Wait for the first word, then stop it the way `chat_stop` does.
        while events.lock().unwrap().is_empty() {
            assert!(started.elapsed() < Duration::from_secs(5), "no first word");
            std::thread::sleep(Duration::from_millis(10));
        }
        run.cancel.store(true, Ordering::SeqCst);
        if let Some(socket) = run.socket.lock().unwrap().as_ref() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        worker.join().unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the read was not woken"
        );
        assert!(
            events.lock().unwrap().iter().all(|e| e["kind"] != "done"),
            "a stopped answer is not a finished one"
        );
    }

    /* ---- against a real node, when one is running ---- */

    /// Point `COMMON_E2E_STATUS` at a real peer's status file (and have it started with
    /// `--api`) to run this; without it the test does nothing. It checks the real file
    /// through the same reader the app uses, then asks the real chat API a question.
    #[test]
    fn a_real_node_is_read_and_answers() {
        let Some(path) = std::env::var_os("COMMON_E2E_STATUS") else {
            eprintln!("skipped: COMMON_E2E_STATUS is not set");
            return;
        };
        unsafe { std::env::set_var("COMMONNET_STATUS_FILE", &path) };
        let status = read_status().expect("the status file was not a valid v1 document");
        eprintln!("status: state={} api={}", status["state"], status["api"]);
        assert_eq!(status["state"], "up");
        assert_eq!(status["api"]["ready"], true);
        assert!(status_age(&status) < STALE_SECONDS, "status is stale");
        assert!(
            status_pid(&status).map(pid_alive).unwrap_or(false),
            "its pid is not alive"
        );
        let text = status.to_string().to_ascii_lowercase();
        assert!(
            !text.contains("token") && !text.contains("secret"),
            "a credential reached the page"
        );

        let port = api_port();
        let body = json!({"model": "common", "stream": true, "max_tokens": 48, "temperature": 0,
            "messages": [{"role": "user", "content": "What is the capital of France? Answer in one short sentence."}]})
            .to_string();
        let events = StdMutex::new(Vec::new());
        let run = Arc::new(Run {
            cancel: AtomicBool::new(false),
            socket: Mutex::new(None),
        });
        run_chat(port, &|v| events.lock().unwrap().push(v), "e2e", body, &run);
        let events = events.into_inner().unwrap();
        let answer = text_of(&events);
        eprintln!("answer: {answer:?}");
        assert!(
            events.iter().all(|e| e["kind"] != "error"),
            "chat errored: {events:?}"
        );
        assert!(answer.contains("Paris"), "unexpected answer: {answer:?}");
        assert_eq!(events.last().unwrap()["kind"], "done");
    }

    /// With `COMMON_E2E_LEAVE` pointing at a live peer's status file: the app's polite
    /// interrupt makes it say goodbye and exit, and it is not mistaken for a crash.
    #[test]
    fn a_real_node_leaves_cleanly_when_interrupted() {
        let Some(path) = std::env::var_os("COMMON_E2E_LEAVE") else {
            eprintln!("skipped: COMMON_E2E_LEAVE is not set");
            return;
        };
        unsafe { std::env::set_var("COMMONNET_STATUS_FILE", &path) };
        let pid = status_pid(&read_status().expect("no status")).expect("no pid");
        assert!(pid_alive(pid));
        interrupt(pid);
        let started = Instant::now();
        while pid_alive(pid) {
            assert!(
                started.elapsed() < GRACE,
                "it did not leave within the grace period"
            );
            std::thread::sleep(Duration::from_millis(250));
        }
        eprintln!("left in {:.1}s", started.elapsed().as_secs_f64());
        let status = read_status().expect("status vanished");
        eprintln!("final state: {}", status["state"]);
        assert!(matches!(
            status["state"].as_str(),
            Some("stopped") | Some("leaving")
        ));
        let mut inner = Inner::default();
        let v = view(&mut inner);
        assert!(!v.crashed && !v.running);
    }

    /// With `COMMON_E2E_CRASHED` pointing at the status file of a peer that was
    /// killed (SIGKILL) more than 15 s ago: it reads as crashed, and not as running.
    #[test]
    fn a_real_killed_node_reads_as_crashed() {
        let Some(path) = std::env::var_os("COMMON_E2E_CRASHED") else {
            eprintln!("skipped: COMMON_E2E_CRASHED is not set");
            return;
        };
        unsafe { std::env::set_var("COMMONNET_STATUS_FILE", &path) };
        let status = read_status().expect("no status");
        let pid = status_pid(&status).expect("no pid");
        assert!(!pid_alive(pid), "the process is still there");
        eprintln!(
            "state in file: {}, age {:.0}s",
            status["state"],
            status_age(&status)
        );
        let mut inner = Inner::default();
        let v = view(&mut inner);
        assert!(
            v.crashed,
            "a killed peer should read as crashed: {:?}",
            v.status_age
        );
        assert!(!v.running);
    }
}
