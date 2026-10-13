import { appVersion, updateCheck, updateRestart, updateStage } from "./backend";

/**
 * Keeping the app current, quietly.
 *
 * The app is a thing that lives in the menu bar and may not be quit for weeks, so
 * the interesting question is not when to check but how often to be *silent*. A
 * check that finds nothing must leave no trace: no line, no badge, no state the
 * user has to clear. Which is why the automatic path below reports `current` and
 * the surfaces treat that as the ordinary case rather than as news.
 *
 * The work is split so the cheap part is always done and the expensive part is
 * rationed. The version this app is running is a local read and is asked for on
 * every open; the release manifest is a request to GitHub and is fetched at most
 * once a day. A user who opens the app five times before lunch pays for one check.
 *
 * Nothing here is required for the app to work. Every path fails to a state the
 * surfaces can print honestly, and none of them throws at the caller — an app that
 * lost its update feed is still an app.
 */

/**
 * When the manifest was last fetched, so a day can be measured.
 *
 * Under the same `common.` prefix as the rest of this app's storage, and read and
 * written through the same guarded pair as `geo.readPlace` — `localStorage` throws
 * rather than returns when storage is unavailable, and a machine that cannot
 * remember when it last checked should check again rather than not at all. That is
 * the safe direction here, and it is the opposite of the safe direction for the
 * place cache, which is why this is not a shared helper: the failure of a cache
 * has to fall the way that costs less.
 */
const KEY = "common.updates.lastChecked";

/**
 * A day between checks.
 *
 * Day-length and not hour-length because the release cadence is a release
 * cadence, not a heartbeat: nothing is gained by asking four times for an answer
 * that changes weekly, and each ask is a request to a third party that logs it.
 * Nor is it checked on a timer while the app sits in the menu bar — a laptop that
 * has been asleep for a week should learn about an update when it wakes and the
 * user looks at it, not by waking itself up to ask.
 */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

function readLastChecked(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function rememberCheck(at: number): void {
  try {
    window.localStorage.setItem(KEY, String(at));
  } catch {
    // Nothing to do. A check that cannot be remembered simply happens again.
  }
}

/**
 * Everything that can be said about updating, as one value.
 *
 * `unknown` and `current` are different facts and the card says different things
 * about each: one is "nothing has been asked yet", the other is "the newest
 * version is the one you have". Collapsing them would make the card claim a check
 * that never happened on a day the throttle held it back.
 *
 * `downloading` carries the version because the version is the only thing worth
 * saying while it happens. There is no percentage: the update is a few megabytes
 * and the app is fully usable throughout, so a progress figure would be something
 * to watch rather than something to wait for.
 */
export type UpdateOffer =
  | { kind: "unknown" }
  | { kind: "checking" }
  | { kind: "current" }
  /** A release exists and nothing has been fetched. The state the rail's bar
   *  appears on, and the one `Install` acts from — see `takeUpdate` for why the
   *  download is no longer part of the check. */
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string }
  | { kind: "staged"; version: string }
  /** The restart has been asked for and the process is on its way out. Not a
   *  step in the download — see `restartIntoUpdate` — but the surfaces need it
   *  anyway: without it, the second between the click and the window coming back
   *  is a second in which the button looks unpressed, and the answer to an
   *  unresponsive button is another click. */
  | { kind: "restarting" }
  | { kind: "failed" };

/** Whether the app is in the middle of something the user should not start twice. */
export function busy(offer: UpdateOffer): boolean {
  return offer.kind === "checking" || offer.kind === "downloading";
}

/** The version running, which never depends on the throttle. */
export async function runningVersion(): Promise<string> {
  try {
    return await appVersion();
  } catch {
    // Only reachable if the app cannot answer for itself, which should not
    // happen — but a card that cannot name a version is better than a card that
    // fails to draw, so the surfaces get an empty string and print around it.
    return "";
  }
}

/**
 * Ask the manifest, and report what it offers.
 *
 * `report` is called at each state change rather than returned once, because a
 * check is a request and the card should be able to say it is happening. The whole
 * thing is wrapped, because a check that throws — offline, a proxy, a release feed
 * that has moved — must land on a state and not on an unhandled rejection.
 *
 * The throttle is skipped by `force`, which is what the card's own button passes.
 * A user who presses "Check for updates" has decided to spend the request, and
 * being told "you checked yesterday" by a button they just pressed is the kind of
 * thing that makes a person distrust a control.
 *
 * Finding a release stops here. It used to go on to fetch it unprompted, on the
 * argument that a downloaded update is one the user can act on instantly — but the
 * update is now offered in the rail with an `Install` on it, and a button whose
 * work has already been done behind the user's back is a button that lies about
 * what it did. See `takeUpdate`.
 */
export async function lookForUpdate(
  report: (offer: UpdateOffer) => void,
  options?: { force?: boolean },
): Promise<void> {
  if (options?.force !== true) {
    const last = readLastChecked();
    if (last !== null && Date.now() - last < INTERVAL_MS) return;
  }

  report({ kind: "checking" });
  try {
    const status = await updateCheck();

    // Marked here rather than at the end: what the throttle rations is reaching
    // the feed, and that has now happened whatever the download goes on to do. A
    // stage that fails on a full disk should not have this machine asking GitHub
    // about the same release again on the next three launches.
    rememberCheck(Date.now());

    report(
      status.available === null
        ? { kind: "current" }
        : { kind: "available", version: status.available.version },
    );
  } catch {
    report({ kind: "failed" });
  }
}

/**
 * Fetch the release the check found, and put it where a restart can reach it.
 *
 * Split out of `lookForUpdate` because it is the one part of the update path that
 * a user has to ask for. It is also the part that takes time — several megabytes
 * over whatever connection this machine has — which is why the state machine has a
 * `downloading` for it to report into rather than making the caller wait on a bare
 * promise.
 *
 * The version is passed in rather than read from the manifest again: this is the
 * release the user was offered, and re-asking the feed could fetch a newer one than
 * the bar named.
 */
export async function takeUpdate(
  version: string,
  report: (offer: UpdateOffer) => void,
): Promise<void> {
  report({ kind: "downloading", version });
  try {
    const staged = await updateStage();

    // `null` here is not a failure — it is the manifest having stopped offering
    // the release between the check and the fetch, which is what a withdrawn
    // release looks like. The honest report is that the running version is the
    // one to be on.
    report(staged === null ? { kind: "current" } : { kind: "staged", version: staged });
  } catch {
    report({ kind: "failed" });
  }
}

/**
 * Relaunch into the staged version.
 *
 * Does not resolve, and deliberately is not awaited: the process is replaced, so
 * the promise this returns is never settled and `await`ing it would leave the
 * caller hanging in a callback that never runs. Everything the caller wants to say
 * about restarting has to be said before this is called.
 */
export function restartIntoUpdate(): void {
  updateRestart().catch(() => {
    // Unreachable in practice — the process is gone before the invoke can fail —
    // and nothing a user could act on if it were not.
  });
}
