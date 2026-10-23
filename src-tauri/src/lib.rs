// The machine seam: hardware reads, finding the CLI, saving a report. See
// `backend.rs`.
mod backend;

// The layer-network peer this app runs, its status, and chat through it. See
// `peer.rs` for why the app runs the CLI's own peer rather than a network of its own.
mod peer;

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

// The Windows caption, painted to the app's own ground. See `titlebar.rs` for why
// it is painted rather than removed.
mod titlebar;

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
        // The peer this app runs, and the chats streaming through it. The peer is
        // held as a handle plus the status file it writes: Windows hands the process
        // off, so the file's pid, not the handle, is what says it is alive.
        .manage(peer::Peer::default())
        .manage(peer::Chats::default())
        // The first-run fetch that is in flight, so that a cancel can find the
        // `curl` it means to stop.
        .manage(fetch::Bootstrap::default())
        .setup(|app| {
            build_tray(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                titlebar::match_ground(&window);
            }
            // Where the bundle unpacked the seed copy of the CLI. Resolved here and
            // nowhere else, because this is the one moment an `AppHandle` exists to
            // ask; the answer is stashed in a `OnceLock` for `backend::cli()`.
            if let Ok(dir) = app
                .path()
                .resolve("cli", tauri::path::BaseDirectory::Resource)
            {
                backend::use_cli_seed(dir);
            }
            // Off the launch path: the update runs on its own thread and nothing here
            // waits for it. See `refresh_cli_in_background` for why it is needed.
            backend::refresh_cli_in_background();
            peer::supervise(app.handle().clone());
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
            // The layer-network peer: start it, stop it (politely, so it tells the
            // others it is leaving), read what it says about itself.
            peer::peer_start,
            peer::peer_stop,
            peer::peer_status,
            peer::peer_log_tail,
            // What to hand somebody when it will not connect. Reads only this
            // machine, and the status file is scrubbed of anything secret.
            peer::diagnostics,
            backend::save_diagnostics,
            // Chat through the peer's own API on loopback, streamed to the page.
            peer::chat_stream,
            peer::chat_stop,
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
            // Quitting leaves the network properly: the peer is told to say goodbye
            // rather than being cut off, so nobody keeps sending it work.
            if let tauri::RunEvent::Exit = event {
                peer::shutdown(app);
            }
        });
}
