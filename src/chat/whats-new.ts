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
  "0.3.0": [
    "Common now runs on the new layer network. Instead of each computer running a small model on its own, the computers on the network each hold a slice of one large model and pass the work along, so a question is answered by the network as a whole.",
    "Joining is one step and sets itself up: it fetches only your share of the model, opens its own connection and starts serving. You can see what it is doing while it works.",
    "Answers appear word by word as they are made.",
    "If a computer drops out in the middle of an answer, another takes its place and the answer carries on.",
    "Settings now shows your layers, who else is online and the address friends can join through, and lets you leave or rejoin. The old model-picking and Ollama steps are gone.",
  ],
  "0.2.6": [
    "On Windows, setup could stop at its last step. The join could not find Ollama on the machine, even with Ollama installed and running, so the machine ran the whole setup and then never joined the network. It finds it now.",
    "A join that does fail is better described: the app no longer blames the model catalogue for a problem that was somewhere else entirely.",
  ],
  "0.2.5": [
    "On Windows, a machine could join the network, answer questions, and still be told the network had not replied. The app was misreading its own process as one that had stopped; that is fixed, and when a join really does stop the app now says so instead of blaming the network.",
    "Common now tells you when a new version is waiting. It looks for one more often than once a day, and it opens a card the moment it finds one rather than leaving a line in the rail to be noticed — and if you would rather not now, it asks again next time you open the app.",
    "Joining the network draws a mark while it works, so registering no longer looks like a screen that has stopped.",
  ],
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
