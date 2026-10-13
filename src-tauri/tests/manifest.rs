// The update manifest is the one artifact whose failure is invisible.
//
// If `latest.json` stops parsing, nothing crashes and nothing logs to the user: the
// check returns an error, the Settings card says "couldn't reach the release feed",
// and that is also what it says when the machine is simply offline. An app can go a
// year like that.
//
// So the manifest's shape is pinned here against `RemoteRelease` — the very type
// `tauri-plugin-updater` deserializes it into and the very code the running app
// executes. That makes this a test of the contract rather than of our own
// understanding of it: bumping the plugin and finding it has started demanding a
// field it used to tolerate fails here, in CI, instead of quietly on every installed
// copy.
//
// The fixture mirrors what `scripts/make-manifest.mjs` writes. If that script's output
// changes shape, this is where the change has to be justified.

use tauri_plugin_updater::RemoteRelease;

/// A manifest of the shape the publish workflow emits: static form, three platforms,
/// tag-pinned URLs, and a `pub_date` that is a real RFC 3339 instant.
const MANIFEST: &str = r#"
{
  "version": "0.2.0",
  "pub_date": "2026-10-13T20:30:00Z",
  "notes": "First Tauri release.",
  "platforms": {
    "darwin-aarch64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
      "url": "https://github.com/TheCommonAI/common-desktop/releases/download/v0.2.0/Common_0.2.0_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
      "url": "https://github.com/TheCommonAI/common-desktop/releases/download/v0.2.0/Common_0.2.0_x64.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
      "url": "https://github.com/TheCommonAI/common-desktop/releases/download/v0.2.0/Common-win-x64.exe"
    }
  }
}
"#;

#[test]
fn the_published_manifest_is_one_the_updater_can_read() {
    let release: RemoteRelease =
        serde_json::from_str(MANIFEST).expect("the updater must be able to parse our manifest");

    assert_eq!(release.version.to_string(), "0.2.0");
    assert_eq!(release.notes.as_deref(), Some("First Tauri release."));
    assert!(release.pub_date.is_some(), "pub_date should have parsed");

    // The lookup the updater actually performs on a static manifest: it tries
    // `{os}-{arch}-{bundle_type}` first and falls back to `{os}-{arch}`, which is the
    // form these keys use. Asking for them by the fallback name is asking the same
    // question the app asks itself.
    for target in ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"] {
        let url = release
            .download_url(target)
            .unwrap_or_else(|e| panic!("no download url for {target}: {e}"));
        assert!(
            url.as_str()
                .starts_with("https://github.com/TheCommonAI/common-desktop/"),
            "{target} points somewhere unexpected: {url}",
        );
        assert!(
            release.signature(target).is_ok_and(|s| !s.is_empty()),
            "{target} has no signature",
        );
    }
}

/// The trap, pinned so it cannot come back.
///
/// `pub_date` is parsed with `OffsetDateTime::parse(.., Rfc3339)` and a failure there
/// fails the entire manifest — not just the date. A hand-written date is therefore
/// worse than no date at all, and the temptation to write one is real, because every
/// human-readable form of it looks perfectly reasonable.
///
/// Note what is *not* in this list: a space where the `T` goes. RFC 3339 explicitly
/// allows that substitution, and `time` honours it, so `2026-10-13 20:30:00Z` is
/// accepted. `scripts/make-manifest.mjs` still refuses it, which is a generator being
/// stricter than its consumer on purpose — one canonical spelling in, so the manifest
/// reads the same however it was written.
#[test]
fn a_manifest_with_a_loose_date_is_rejected_wholesale() {
    for bad in [
        "13 October 2026",
        "2026-10-13",           // a date, but not an RFC 3339 datetime
        "2026-10-13T20:30:00",  // no offset — not an instant, just a local time
        "2026-13-01T00:00:00Z", // no such month
    ] {
        let manifest = MANIFEST.replace("2026-10-13T20:30:00Z", bad);
        let parsed = serde_json::from_str::<RemoteRelease>(&manifest);
        assert!(
            parsed.is_err(),
            "pub_date {bad:?} should not have parsed, but the manifest was accepted",
        );
    }
}

/// An update with no date is fine. It must not be the thing that stops an update
/// reaching people.
#[test]
fn a_manifest_without_a_date_still_parses() {
    let manifest = MANIFEST.replace("  \"pub_date\": \"2026-10-13T20:30:00Z\",\n", "");
    assert!(
        !manifest.contains("pub_date"),
        "the fixture was not stripped"
    );

    let release: RemoteRelease =
        serde_json::from_str(&manifest).expect("a manifest with no date must still parse");
    assert!(release.pub_date.is_none());
    assert!(release.download_url("darwin-aarch64").is_ok());
}
