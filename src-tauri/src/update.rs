// Updating the app from the GitHub release it is published to.
//
// ── Why this is three commands and not a plugin call from the web layer ───────
//
// The obvious shape would be `@tauri-apps/plugin-updater` plus
// `@tauri-apps/plugin-process` in the webview, which is what the plugin's own
// documentation shows. It is not the shape here, for three reasons that all
// point the same way:
//
// — Capabilities are the app's security boundary, and they gate the *webview*.
//   A check driven from Rust grants the webview nothing new: the updater is not
//   reachable from the page at all, so `updater:default` and
//   `process:allow-restart` do not have to be opened, and
//   `capabilities/default.json` is left exactly as it was.
//
// — Restarting does not need `tauri-plugin-process`. `AppHandle::restart` is in
//   tauri core, and it is the same call the process plugin would have forwarded.
//
// — Everything else in this app already crosses the boundary the same way: one
//   command in Rust, one wrapper in `backend.ts` behind `insideApp()`. An update
//   is not a special case and should not invent a second convention.
//
// ── What a check costs, and what it is allowed to say ─────────────────────────
//
// `update_check` reads. It fetches the manifest, compares versions and returns
// what it found; it downloads nothing and changes nothing. `update_stage` is the
// one that writes: it fetches the update, verifies its signature against the
// public key compiled into this binary, and writes the new version to disk
// *without* restarting, so the running app carries on and the restart becomes the
// user's decision rather than a surprise. `update_restart` is that decision.
//
// Splitting check from stage is what lets the app be quiet about it. A check that
// finds nothing costs one request and is never mentioned; a stage that succeeds
// has already done the slow part, so pressing Restart is a relaunch and not a
// download.
//
// ── The dev guard ────────────────────────────────────────────────────────────
//
// Under `npm run tauri dev` all three do nothing and report nothing available.
// There is no installed bundle in a dev run to replace — the binary lives in
// `target/debug` and is rewritten by every build — so a check there could only
// ever offer an update that could not be applied, which is worse than silence.
// A release build is what exercises this; see `docs/RELEASING.md`.
//
// The public key below lives in `tauri.conf.json`. Losing the private key it pairs
// with does not break this build, it breaks the *next* one for everybody already
// installed: their copies hold this public key and will refuse anything else.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// A version the manifest is offering, and the little the manifest says about it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    /// The version on offer, as the manifest names it.
    pub version: String,
    /// The release's own note, which is what `latest.json` carries in `notes`.
    /// Optional because a manifest without one is still a valid manifest.
    pub notes: Option<String>,
    /// `pub_date`, passed through as the string the manifest holds rather than
    /// parsed into a date here: this side cannot know the reader's timezone, and
    /// the web layer can.
    pub pub_date: Option<String>,
}

/// What the check found. `available: None` is the ordinary case and means the
/// running version is the newest one — not that the check failed. A check that
/// fails returns `Err` and is reported as a failure, because "up to date" and
/// "could not reach GitHub" are different things and only one of them is fine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub available: Option<AvailableUpdate>,
}

/// Ask the manifest what the newest version is. Downloads nothing.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();

    if tauri::is_dev() {
        return Ok(UpdateStatus {
            current,
            available: None,
        });
    }

    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let Some(update) = found else {
        return Ok(UpdateStatus {
            current,
            available: None,
        });
    };

    Ok(UpdateStatus {
        available: Some(AvailableUpdate {
            version: update.version.clone(),
            notes: update.body.clone(),
            pub_date: update
                .raw_json
                .get("pub_date")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        }),
        current,
    })
}

/// Fetch the offered update and write it to disk, without restarting.
///
/// Returns the version now staged, or `None` when there was nothing to stage.
/// The signature is checked by the plugin against the public key compiled into
/// this binary before anything is written, so a truncated or tampered download
/// fails here rather than being installed.
///
/// `restart_after_install(false)` is the whole point of the split: the install
/// completes, the running process keeps running the old binary, and the app can
/// offer the restart in its own time. Restarting from inside this call would
/// relaunch the app out from under whatever the user was doing.
#[tauri::command]
pub async fn update_stage(app: AppHandle) -> Result<Option<String>, String> {
    if tauri::is_dev() {
        return Ok(None);
    }

    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let Some(update) = found else {
        return Ok(None);
    };

    // Read before the update is consumed by the builder below.
    let version = update.version.clone();

    update
        .restart_after_install(false)
        // Neither callback is used: there is no progress to show. The download is
        // a few megabytes and the app is already usable while it happens, so a
        // progress bar would be a thing to watch rather than a thing to wait for.
        .download_and_install(|_chunk: usize, _total: Option<u64>| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    Ok(Some(version))
}

/// Relaunch into the staged version.
///
/// `restart` does not return, so this never produces its `Result` — the return
/// type exists only because a command has to have one. The web layer must not
/// wait on the promise, because it will not settle.
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<(), String> {
    app.restart()
}
