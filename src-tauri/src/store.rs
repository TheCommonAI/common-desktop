//! Where the conversations are kept.
//!
//! The chats are the user's own words, and they are the only thing this app
//! writes that it would be a loss to lose. Everything else it stores is either a
//! cache — the place, the date of the last update check — or something the
//! network already holds. So they get a file of their own in the app's private
//! data folder, and they are written carefully.
//!
//! ── Why the payload is a string ───────────────────────────────────────────────
//!
//! `conversations_write` takes the whole file as one opaque `String` and hands
//! back exactly what it reads. Rust does not learn the schema, and it should not.
//! The shape of a message is `ChatMessage` in `src/chat/messages.ts`; the app
//! already has a name and a type for it, and a declaration here would be a second
//! source of truth — the copy that drifts being, as ever, this one. It is the same
//! reason `save_diagnostics` takes text rather than a struct: what crosses this
//! boundary is a file, not a model.
//!
//! ── Why a write is two calls and not one ──────────────────────────────────────
//!
//! `fs::write` truncates and then writes, so a process that dies between the two
//! leaves a half-written file where the history used to be. This app is one that
//! gets force-quit, killed by a shutdown and quit from a tray menu at arbitrary
//! moments, because it is meant to be lived in rather than opened — so that window
//! is not hypothetical. The bytes therefore go to a sibling `.tmp` first and are
//! moved into place with `rename`, which is atomic within a filesystem: a reader
//! sees the whole of the old file or the whole of the new one, never a mixture.
//! The price of a crash is one stale `.tmp`, which the next write overwrites.
//!
//! ── What absence means ────────────────────────────────────────────────────────
//!
//! A missing file is `Ok(None)` and not an error. A first run and a user who has
//! deleted it are the same state, and both mean "no chats" — a thing the chat
//! screen has a first-class answer for. A file that is *there* and cannot be read
//! is an error, because the two want different things: no file is an empty list,
//! and an unreadable one is something the web layer should hear about before it
//! decides to replace it with what it happens to be holding.

use std::io;
use std::path::{Path, PathBuf};

/// The one file, inside the app's private data folder.
const FILE_NAME: &str = "conversations.json";

/// Where that file is, creating its folder if this is the first time.
///
/// `app_data_dir` resolves per the bundle identifier — `au.com.commonai.desktop`
/// — so this lands wherever the platform keeps an app's own storage:
/// `~/Library/Application Support/…` on macOS, `%APPDATA%\…` on Windows. It is
/// deliberately not `download_dir`, which is where the diagnostics report goes:
/// that file exists in order to leave, and this one exists in order to stay.
fn conversations_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no folder for this app's own data: {e}"))?;
    // Normally there already; on a fresh install it is not, and a chat that cannot
    // be saved because a folder was missing would be a poor first impression.
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    Ok(dir.join(FILE_NAME))
}

/// Read the file, with absence as a value rather than a failure.
fn read_file(path: &Path) -> io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Write the file by writing its replacement beside it and moving it over.
///
/// Built by appending to the name rather than with `with_extension`, which would
/// quietly turn `conversations.json` into `conversations.tmp` — a name a second
/// copy of the app, or a later version of this one, could be using for something
/// else. The sibling is this file and nothing else.
fn write_file(path: &Path, text: &str) -> io::Result<()> {
    let mut sibling = path.as_os_str().to_os_string();
    sibling.push(".tmp");
    let tmp = PathBuf::from(sibling);

    std::fs::write(&tmp, text)?;
    // A failed rename leaves the `.tmp` behind rather than deleting it: the file
    // it holds is the newer copy, and the next write is not far away.
    std::fs::rename(&tmp, path)
}

/// Every chat this machine has, as the web layer last wrote them.
///
/// `None` means there is no file yet — never that there is one and it would not
/// open. The distinction is the whole of the return type: the first is a chat
/// screen with one empty chat on it, and the second is a fact the caller may want
/// to leave the file alone over.
#[tauri::command]
pub async fn conversations_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = conversations_path(&app)?;
    read_file(&path).map_err(|e| format!("couldn't read {}: {e}", path.display()))
}

/// Replace every chat with what the web layer is holding.
///
/// A whole-file write rather than an append or a patch: the web layer owns the
/// list and this file is its shadow, so anything cleverer here would be a second
/// writer and a merge problem, on a file that is a few kilobytes.
#[tauri::command]
pub async fn conversations_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = conversations_path(&app)?;
    write_file(&path, &json).map_err(|e| format!("couldn't write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of its own, named for this test, so the cases can run beside
    /// each other and nothing is left behind.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("common-store-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("the directory")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn absence_is_a_value_and_not_an_error() {
        let dir = scratch("absent");
        assert_eq!(
            read_file(&dir.join(FILE_NAME)).expect("a read of nothing"),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_can_be_read_back_and_leaves_no_tmp_beside_it() {
        let dir = scratch("roundtrip");
        let path = dir.join(FILE_NAME);

        write_file(&path, r#"[{"id":"one"}]"#).expect("a write");

        assert_eq!(
            read_file(&path).expect("a read").as_deref(),
            Some(r#"[{"id":"one"}]"#)
        );
        // The sibling is the whole point of the pair, and it must not survive a
        // write that worked.
        assert_eq!(names_in(&dir), vec![FILE_NAME.to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_write_replaces_the_first_whole() {
        let dir = scratch("replace");
        let path = dir.join(FILE_NAME);

        write_file(&path, r#"[{"id":"one"},{"id":"two"}]"#).expect("a write");
        write_file(&path, r#"[{"id":"three"}]"#).expect("another write");

        // Not concatenated, not merged: a shorter file is a shorter file.
        assert_eq!(
            read_file(&path).expect("a read").as_deref(),
            Some(r#"[{"id":"three"}]"#)
        );
        assert_eq!(names_in(&dir), vec![FILE_NAME.to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
