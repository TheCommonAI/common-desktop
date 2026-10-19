// The Windows caption, painted to the app's own ground.
//
// macOS needs none of this: `titleBarStyle` is "Transparent" in tauri.conf.json,
// so the app's ground runs up to the top edge and the window's controls sit on it.
// Windows has no such option, and the native caption is kept on purpose. It is
// what a Windows user reaches for to move, minimise or close the window, and it
// cannot be put back once removed. So it is painted instead, in the same colour as
// the app behind it, with light buttons, so it reads as part of the window rather
// than a light stripe laid across a dark one.
//
// The caption colour is a Windows 11 attribute (DWM, build 22000 and later). On
// Windows 10 the colour call does nothing and the caption stays dark, which is the
// closest that system gets.

use tauri::WebviewWindow;

/// The app's ground: `--ground` in App.css and `backgroundColor` in tauri.conf.json.
#[cfg(windows)]
const GROUND: u32 = 0x0028_2929; // COLORREF is 0x00BBGGRR, so #292928 is written backwards.

#[cfg(windows)]
const DWMWA_CAPTION_COLOR: u32 = 35;

#[cfg(windows)]
#[link(name = "dwmapi")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut std::ffi::c_void,
        attribute: u32,
        value: *const std::ffi::c_void,
        size: u32,
    ) -> i32;
}

/// Paint the window's caption to the app's ground.
///
/// The theme is set to dark through Tauri rather than through DWM directly. Windows
/// re-decides the theme whenever its own setting changes, and a dark-mode flag set
/// behind its back is undone at that point, leaving the caption buttons dark on dark.
#[cfg(windows)]
pub fn match_ground(window: &WebviewWindow) {
    let _ = window.set_theme(Some(tauri::Theme::Dark));

    let Ok(hwnd) = window.hwnd() else { return };
    let colour = GROUND;
    // A failure here is the Windows 10 case, and the dark theme above already stands in
    // for it, so the result is not looked at.
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_CAPTION_COLOR,
            (&colour as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// Nothing to paint anywhere else: the macOS title bar already is the ground.
#[cfg(not(windows))]
pub fn match_ground(_window: &WebviewWindow) {}
