/**
 * What changed, in the app's own words, for the version that has just arrived.
 *
 * An update lands silently — the update bar downloads it, the user presses
 * Restart, and a moment later the same screen is back with no sign that anything
 * happened. That is the right way for it to happen and the wrong way for it to
 * end: the app changed underneath the user and nothing said so, which is how
 * people come to believe a thing never improves.
 *
 * So the first time a version runs, it says what it brought. The notes are
 * written here, shipped with the build, and read from no network — because the
 * moment to say this is the moment just after an update, which is not a moment to
 * be waiting on a request to GitHub to find out what to say.
 */

/**
 * One line per change, per version.
 *
 * Written for the person using the app and not for whoever reads the commits:
 * plain sentences, active voice, saying what they can now do rather than what was
 * refactored. A version with no entry here simply gets no tile — the honest
 * outcome for a release that was all bug fixes, and the reason this is a lookup
 * and not a required field.
 *
 * The order within a version is the order the changes matter, most first.
 */
const NOTES: Record<string, readonly string[]> = {
  "0.2.2": [
    "Your chats are saved. Close the app and they are still here when you come back, each one with its own history.",
    "That history goes out with your next question, so a follow-up like “and why?” lands on something.",
    "New chats are listed in the rail under New chat. Press one to carry on where you left off; press the × to be rid of it.",
    "A new version is offered in the rail, above Connected. Install fetches it quietly; Restart puts it in place.",
  ],
};

/** What this version brought, or `null` for one with nothing written down. */
export function notesFor(version: string): readonly string[] | null {
  return NOTES[version] ?? null;
}

/** The version whose notes have been read, under the same `common.` prefix as
 *  the rest of this app's storage. */
const KEY = "common.whatsNew.seenVersion";

export function readSeenVersion(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    // Storage unavailable. Failing to `null` reads as "nothing has been read
    // yet", which shows the tile again — the safe direction, since the cost is
    // one dismissal and the other direction is notes nobody ever sees.
    return null;
  }
}

/** Mark a version's notes as read. Fails soft: a tile shown twice is a much
 *  smaller problem than an exception thrown from a click on Done. */
export function rememberSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(KEY, version);
  } catch {
    // Nothing to do.
  }
}

/**
 * What to say about the version now running, or `null` to say nothing.
 *
 * A first run counts as an update, which is the one judgement in this file worth
 * arguing. The alternative — record the version silently when nothing has been
 * seen, and speak only on later updates — reads better until you notice that
 * nobody would ever hear from it: the first release that ships this has no
 * predecessor that could have written the key, so the very update it was built for
 * would be the one it stayed quiet about. A fresh install therefore gets the tile
 * too, and reads it as what the app does rather than as what changed, which is a
 * fine thing for it to say either way.
 *
 * The version is recorded when the tile is dismissed and not when it is shown, so
 * that a quit in between does not lose the notes.
 */
export function whatsNewFor(seen: string | null, running: string): readonly string[] | null {
  // "" is `appVersion` failing to answer, not a version.
  if (running === "") return null;
  // Only forwards. A user who has gone back to an older build is not owed a
  // second telling of notes they have already read.
  if (seen !== null && !isNewer(running, seen)) return null;
  return notesFor(running);
}

/** Which of two dotted versions is ahead, compared as numbers.
 *
 *  Numbers and not strings, because "0.2.10" sorts before "0.2.9" as text and
 *  will not as numbers. Anything that is not a plain dotted number — an empty
 *  string from a failed read, a `-beta.1` suffix — is not compared at all: this
 *  is used to decide whether to show a paragraph of prose, and the honest answer
 *  when the versions cannot be ordered is to say nothing. */
function isNewer(version: string, than: string): boolean {
  const left = groups(version);
  const right = groups(than);
  if (left === null || right === null) return false;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function groups(version: string): number[] | null {
  const parts = version.split(".");
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}
