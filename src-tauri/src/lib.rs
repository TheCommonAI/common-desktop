// The connect-and-contribute backend seam. See `backend.rs` for what it does
// and why it is shaped the way it is.
mod backend;

// Updating the app from the release it is published to. See `update.rs` for why
// this is driven from here rather than from the web layer.
mod update;

// The conversations, on disk. The webview has no filesystem and this app has no
// storage plugin, so this is the only door the chats can go through.
mod store;

// The first run: fetching, checking and placing the Python runtime, the Common
// CLI that runs under it and cloudflared, so that arriving without them is no
// longer fatal. See `fetch.rs` for what it can and cannot get today.
mod fetch;

// SHA-256 for the check above. Hand-written rather than pulled in, under the
// no-new-dependency rule in `backend.rs`'s header — see `sha256.rs` for why a
// digest is a defensible thing to write by hand and an HTTP client is not.
mod sha256;

use tauri::{
    Manager, WindowEvent,
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

// `Reopen` is a macOS-only variant of `RunEvent` in Tauri 2 — the enum does not
// carry it on other targets at all, so the import is gated rather than the
// match being written to fall through on a variant that is not there to name.
#[cfg(target_os = "macos")]
use tauri::RunEvent;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// The menu bar icon.
///
/// Three things make it a macOS menu bar icon rather than a picture of one:
///
/// — `tray.png` is **black on nothing**. Not black on white, not a rounded
///   tile — a glyph and transparent pixels, with no background at all. That is
///   the whole of the brief's "plain black, transparent background, like every
///   other tray icon".
///
/// — `icon_as_template(true)` tells macOS to treat those pixels as a *mask*
///   rather than as artwork. macOS then draws it black in a light menu bar and
///   white in a dark one, inverts it when the bar is dimmed, and highlights it
///   when the menu is open — the same treatment the system's own icons get, and
///   nothing a fixed-colour bitmap could do.
///
/// — The glyph is the app's own mark: the dotted ring, at its own menu-bar grid
///   rather than the app icon's. `scripts/icons.py` draws it with twelve dots
///   where the 512px icon uses twenty; twenty dots at this size close into a
///   solid grey circle. Same mark, hinted for the bar.
///
/// The source PNG is 44×44 rather than 22×22 by design — `tray-icon` normalises
/// whatever it is given to 18 points tall and keeps the aspect, so the extra
/// pixels are what survives on a Retina display.
///
/// ── Why there are two of them ─────────────────────────────────────────────────
///
/// The black-on-nothing glyph above is only legible because macOS treats it as
/// a *mask* and paints it in whatever colour the bar needs. Windows has no such
/// idea: it draws the pixels it was handed, and a black glyph on the taskbar —
/// which is dark by default there — is a glyph nobody can see. So Windows gets
/// the app's own icon instead: a paper tile with the mark in ink on it, carrying
/// its own background rather than borrowing the bar's. This is the ordinary
/// Windows convention rather than a workaround.
#[cfg(target_os = "macos")]
const TRAY_PNG: &[u8] = include_bytes!("../icons/tray.png");
#[cfg(not(target_os = "macos"))]
const TRAY_PNG: &[u8] = include_bytes!("../icons/32x32.png");

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Common.", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Common.", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;

    let tray = TrayIconBuilder::new()
        .icon(Image::from_bytes(TRAY_PNG)?)
        .menu(&menu)
        // The macOS convention: a status item with a menu opens the menu on a
        // left click. The window is one item down in it.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            // `exit` does not go through `CloseRequested`, so this quits even
            // though the window's own close button no longer does.
            "quit" => app.exit(0),
            _ => {}
        });

    // "Treat this as a mask, not as artwork." Only macOS has the idea, so it is
    // asked for only there — set as a second binding rather than in the chain,
    // since an attribute cannot sit between two builder calls.
    #[cfg(target_os = "macos")]
    let tray = tray.icon_as_template(true);

    tray.build(app)?;

    Ok(())
}

/// Bring the window back, whether it is hidden or merely behind something.
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The updater plugin, registered for the Rust side only. Nothing in the
        // webview calls it — the three commands in `update.rs` do — so this adds
        // no permission for the page and changes no capability.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The join this app started, so that "is it still working?" is answered by
        // the process handle rather than by hunting for its pid with a second
        // program. On Windows those two answers disagree, and the disagreement cost
        // a friend a working node reported as a dead network — see `JoinState`.
        .manage(backend::Join::default())
        // The first-run fetch that is in flight, so that a cancel can find the
        // `curl` it means to stop. One rather than a map: a bootstrap is a
        // one-off that installs three things in a row, and there is nothing a
        // second concurrent one could mean.
        .manage(fetch::Bootstrap::default())
        .setup(|app| {
            build_tray(app.handle())?;
            // Where the bundle unpacked the seed copy of the CLI. Resolved here and
            // nowhere else, because this is the one moment an `AppHandle` exists to
            // ask — the commands in `backend.rs` run their work through
            // `spawn_blocking` and have no handle to ask with, which is why the
            // answer is stashed in a `OnceLock` for them to read.
            if let Ok(dir) = app
                .path()
                .resolve("cli", tauri::path::BaseDirectory::Resource)
            {
                backend::use_cli_seed(dir);
            }
            Ok(())
        })
        // Closing the window hides it. The app is a thing that lives in the menu
        // bar and answers questions; the window is one view of it, and a red
        // button that ended a node the user had just joined would be the wrong
        // reading of a click on a red button.
        //
        // Nothing is trapped by this: Quit in the tray menu and ⌘Q both reach
        // `exit`, which bypasses this event entirely.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            // The four hardware reads, one at a time so the scan screen can say
            // which one it is waiting on and so one refusal costs one field.
            backend::read_memory,
            backend::read_graphics,
            backend::read_disk,
            backend::read_power,
            backend::read_os,
            // The network verbs. Thin passthroughs to `common --json …`.
            backend::network_recommend,
            backend::network_status,
            backend::network_whoami,
            backend::network_contrib,
            backend::network_leave,
            backend::network_ask_local,
            backend::network_ask,
            backend::network_ask_stop,
            backend::network_join,
            // Not a `common` verb: the catalogue lives at the gateway, so that a
            // download knows which tag to pull.
            backend::network_catalogue,
            // What the `join` this app started is doing. The join outlives the call
            // that made it, so what is held is its handle and not its answer.
            backend::network_join_state,
            // And what it said, for the case the handle cannot answer: on Windows the
            // wrapper exits cleanly having handed off, so a join can die without this
            // app being able to see it. The log is the only witness.
            backend::network_join_tail,
            // How far the weights have got: the progress line the CLI writes to
            // its own `join.log`, read from a byte offset, so the join screen can
            // draw a transfer that used to have a screen of its own.
            backend::network_join_progress,
            // The one read that leaves the machine without being asked to.
            // Asked for once, and cached in the web layer — see `backend.rs`.
            backend::where_am_i,
            // What to hand somebody when it will not connect. Reads only this
            // machine — no network call, and no node token — so it still answers
            // in exactly the case it exists for.
            backend::diagnostics,
            backend::save_diagnostics,
            // The first run. First what it *would* fetch, before it fetches
            // anything — no network, no writes, just what is already on the
            // machine and what could be added — then the fetch itself, streamed
            // so the screen can draw a transfer, and the way out of one, which
            // stops the `curl` and not the app.
            fetch::bootstrap_status,
            fetch::bootstrap_run,
            fetch::bootstrap_cancel,
            // Updating the app itself, from the release it is published to.
            update::update_check,
            update::update_stage,
            update::update_restart,
            // The chats, so that closing the app is not the end of them. The
            // payload is a string and Rust never looks inside it — see `store.rs`.
            store::conversations_read,
            store::conversations_write,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // A hidden window with no menu bar icon would be an app the user
            // cannot get back to, so the Dock icon has to reopen it. macOS calls
            // this when the icon is clicked and nothing is on screen.
            //
            // Windows has no equivalent event — clicking a taskbar icon there
            // restores a window by itself — so this arm is compiled away rather
            // than left in to never fire, and Windows reaches the window through
            // the tray menu's `Open Common` like everyone else.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
