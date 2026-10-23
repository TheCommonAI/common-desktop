import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { preview } from "../preview";

/**
 * What the chat asks of the app itself: save a report, and the app's own updates.
 *
 * Everything about the network — the peer, its status, the chat stream — is in
 * `src/peer/`. This file used to carry the old network's verbs (ask through the
 * gateway, who am I, what have I contributed, leave) and the diagnostics built on
 * them; none of that exists any more. What remains is about the app, not the
 * network, and goes through Rust because the updater is driven from there.
 */

function insideApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Write a report somewhere the user can find it, and open that place. Rust
 * narrows the name to a bare filename stem, so a caller cannot make it write
 * anywhere else.
 */
export async function saveDiagnostics(name: string, text: string): Promise<string> {
  if (!insideApp()) throw new Error("Can't save a report outside the app.");
  return await invoke<string>("save_diagnostics", { name, text });
}

/** A version the release manifest is offering. */
export interface AvailableUpdate {
  /** The version on offer. */
  version: string;
  /** The release's own note, when the manifest carries one. */
  notes: string | null;
  /** The manifest's `pub_date`, passed through as written. The reader's own
   *  timezone is a thing only this side knows, so the string is not parsed
   *  into a date until something has to show it. */
  pubDate: string | null;
}

/** What a check found. `available: null` means the running version is the
 *  newest one — not that the check failed, which throws instead. */
export interface UpdateStatus {
  current: string;
  available: AvailableUpdate | null;
}

/**
 * Ask whether there is a newer version. Downloads nothing.
 *
 * Throws when the manifest cannot be reached, rather than reporting "up to
 * date". The two are different things and only one of them is fine, and a
 * failure that reads as success is how an app goes a year without updating.
 */
export async function updateCheck(): Promise<UpdateStatus> {
  if (!insideApp()) return preview().noUpdate ? { current: PREVIEW_UPDATE.current, available: null } : PREVIEW_UPDATE;
  return await invoke<UpdateStatus>("update_check");
}

/**
 * Fetch the offered update and write it to disk, without restarting.
 *
 * Returns the version now staged, or `null` when there was nothing to stage.
 * The download is verified against a signature before anything is written, so
 * this is also where a corrupted or tampered update fails.
 *
 * Split from `updateCheck` so the app can be quiet: a check that finds nothing
 * is never mentioned, and by the time this returns the slow part is done.
 */
export async function updateStage(): Promise<string | null> {
  if (!insideApp()) throw new Error("There is nothing to update outside the app.");
  return await invoke<string | null>("update_stage");
}

/**
 * Relaunch into the staged version.
 *
 * Does not resolve: the process is replaced, so the promise this returns is
 * never settled. Callers must not wait on it to decide anything — set the
 * state that means "restarting" first, and let this be the last thing.
 */
export async function updateRestart(): Promise<void> {
  if (!insideApp()) throw new Error("There is nothing to restart outside the app.");
  await invoke<null>("update_restart");
}

/**
 * The version of the app that is running.
 *
 * This is the one update fact that is always available, so it is asked for
 * separately rather than taken from a check. A check is throttled — see
 * `INTERVAL_MS` — and may not have run at all — but the Settings card has to be
 * able to name the version it is offering to move off, at any moment, whether or
 * not anything was fetched. This reads the bundle's own version: local, no network,
 * no manifest.
 */
export async function appVersion(): Promise<string> {
  if (!insideApp()) return PREVIEW_UPDATE.current;
  return await getVersion();
}

/**
 * The stand-in, for a page running outside the app.
 *
 * It offers an update, which it did not used to, and the argument for the change
 * is the argument the other stubs make: a surface that cannot be reached without
 * building the app is a surface that gets reviewed by whoever remembers what it
 * looked like last time. The update card is the newest of those, and both ordinary
 * routes to it are shut in development — `update.rs` answers `available: null` on a
 * dev build, deliberately, since a dev build hitting the real manifest would offer
 * an update to a version that has no build behind it. So without this the card would
 * first be seen by a user.
 *
 * The line that still holds is the one about *acting* on a lie. `updateStage` and
 * `updateRestart` throw outside the app, so pressing `Install` here reports the
 * failure rather than pretending to have fetched anything, and nothing can be left
 * half-staged. That is the difference between previewing an offer and previewing an
 * install, and it is why an `available` is honest where a `staged` would not be.
 *
 * `current` is what the browser reports as the running version and should be kept in
 * step with the release; `available` is a whole minor ahead so that the card has
 * something unambiguous to name, and so that the two never have to be compared.
 */
export const PREVIEW_UPDATE: UpdateStatus = {
  current: "0.2.4",
  available: { version: "0.3.0", notes: null, pubDate: null },
};
