/**
 * What changed, in the app's own words, for the versions that have just arrived.
 *
 * An update lands silently — the update bar downloads it, the user presses
 * Restart, and a moment later the same screen is back with no sign that anything
 * happened. That is the right way for it to happen and the wrong way for it to
 * end: the app changed underneath the user and nothing said so, which is how
 * people come to believe a thing never improves.
 *
 * So the first time a version runs, it says what it brought — and not only what
 * that one version brought. A user who last opened 0.2.2 and comes back on 0.2.11
 * never ran the nine releases in between, so the notes for all of them are owed,
 * not just the newest. The notes are written here, shipped with the build, and
 * read from no network — because the moment to say this is the moment just after
 * an update, which is not a moment to be waiting on a request to GitHub to find
 * out what to say.
 *
 * ── Where the lines come from ─────────────────────────────────────────────────
 *
 * The `NOTES` map below is generated from `release-notes.json` at the repository
 * root — the same file the release body and `latest.json`'s `notes` are cut from,
 * so the release page and the card cannot say different things. Edit that file
 * and run `node scripts/make-notes.mjs whats-new`; a drift check in `verify`
 * fails the build if the two are out of step.
 */

/**
 * One line per change, per version.
 *
 * Written for the person using the app and not for whoever reads the commits:
 * plain sentences, active voice, saying what they can now do rather than what was
 * refactored. A version with no lines is simply left out of the source — the
 * honest outcome for a release that was all bug fixes, and the reason this is a
 * lookup and not a required field.
 *
 * The order within a version is the order the changes matter, most first.
 */
// >>> make-notes: generated — do not edit; run `node scripts/make-notes.mjs whats-new`

const NOTES: Record<string, readonly string[]> = {
  "0.2.0": [
    "The app is new underneath: a Rust shell around the system's own webview where the Electron client used to be, 7 MB where that one was 130. Same name, same downloads, same network.",
    "On a first run, setup keeps the whole window until it is done — the menu bar can no longer drop a brand-new machine into Feedback or Diagnostics halfway through.",
    "The menu-bar icon is drawn the way macOS wants it, black on transparent and tinted by the bar, and carries a dot when the app wants your attention.",
  ],
  "0.2.1": [
    "The model download works on Windows. It used to be a request from the page straight to the model server, and Windows' webview sends an origin that server refuses — so the transfer never started and the app blamed the network for it. The download goes through the app's own process now, where there is no origin to refuse.",
    "The release pipeline can pass its own gate again: the check that decides a build is fit to publish now recognises the Mac job by the name GitHub actually gives it.",
  ],
  "0.2.2": [
    "Your chats are saved. Close the app and they are still here when you come back, each one with its own history.",
    "That history goes out with your next question, so a follow-up like “and why?” lands on something.",
    "New chats are listed in the rail under New chat. Press one to carry on where you left off; press the × to be rid of it.",
    "A new version is offered in the rail, above Connected. Install fetches it quietly; Restart puts it in place.",
  ],
  "0.2.3": [
    "A first run waits for the model server to be listening before it asks it for a model. Asking once, immediately, meant setup could die on a machine where the server was simply still starting.",
    "When that wait runs out, the app says the server did not come up rather than reporting the download as a failure.",
  ],
  "0.2.4": [
    "Setup on Windows now runs the command-line tool Windows actually installs. It was looking for a name the installer never creates, so setup stopped on a failure that was nothing to do with the network.",
    "A missing tool is reported as a missing tool, instead of being passed off as the network being unreachable.",
  ],
  "0.2.5": [
    "On Windows, a machine could join the network, answer questions, and still be told the network had not replied. The app was misreading its own process as one that had stopped; that is fixed, and when a join really does stop the app now says so instead of blaming the network.",
    "Common now tells you when a new version is waiting. It looks for one more often than once a day, and it opens a card the moment it finds one rather than leaving a line in the rail to be noticed — and if you would rather not now, it asks again next time you open the app.",
    "Joining the network draws a mark while it works, so registering no longer looks like a screen that has stopped.",
  ],
  "0.2.6": [
    "On Windows, setup could stop at its last step. The join could not find Ollama on the machine, even with Ollama installed and running, so the machine ran the whole setup and then never joined the network. It finds it now.",
    "A join that does fail is better described: the app no longer blames the model catalogue for a problem that was somewhere else entirely.",
  ],
  "0.2.7": [
    "Leaving the network works, and says what happened. The button threw away the answer it was given and then claimed a happy ending over it; a failure is now reported beside buttons that stay put so it can be tried again.",
    "The model ladder is gated on the catalogue's own requirements — memory, GPU, video memory — instead of a flat 16 GB that was no model's requirement and put the top of the ladder out of reach of machines that run it.",
    "Reduced motion no longer stops the one thing that has to move. A download's progress row inks in as it fills rather than leaping from empty to full; everything else that travels — the opening, the steps, the update card — is still stopped on the same preference.",
    "The command-line tool now ships inside the app. Until now a first run on a machine without one simply failed, and it could not be downloaded because the network publishes no build to download. It is bundled, placed on first use, and keeps itself current from the network.",
  ],
  "0.2.8": [
    "A machine that reboots finds its way back onto the network. The join is a foreground process and a restart kills it, so a laptop could sit in a chat that looked perfectly healthy and was not serving at all.",
    "Settings has a Reconnect button, the status is asked again when the window comes back rather than read once at launch, and the app rejoins by itself when it opens after a restart.",
  ],
  "0.2.9": [
    "The command-line tool the app ships is now complete. The bundle was missing a file the tool imports on its first line — on exactly the machine that has nothing else to fall back on.",
    "The bundled tool replaces an older install and leaves a newer one alone, so a machine that took an early bundle is no longer stranded on it.",
    "The app no longer runs the tool under a Python too old for it. A Finder-launched app sees only the system's Python 3.9, which the tool cannot even be imported under; Common now requires 3.10 or newer.",
  ],
  "0.2.10": [
    "The fix in the previous release can actually run. The app only looked at the bundled tool when there was no tool at all — which is never true of a machine that has ever run Common, so the machines that needed the fix were exactly the ones that never got it.",
    "The bundle is checked on every launch now: what is missing is placed, what is older is replaced, and an install the user's own tool has moved ahead of is left alone.",
  ],
  "0.2.11": [
    "One install is all it takes. The first time Common runs it fetches everything it needs — a Python runtime and the tunnel binary that lets this machine be reached — and places its own command-line tool beside them. Nothing else has to be on the machine first.",
    "Ollama is gone. The network moved to llama.cpp some time ago and no longer needs a separate model daemon, so Common stops installing one, downloading one, and waiting on one. One model runtime on the machine, and it is not a second app.",
  ],
  "0.2.12": [
    "Connecting works again, and the fault was ours rather than your machine's. The network's gateway — the part of it that takes your question and hands it to a machine — was stopping itself: every thirty seconds it checked which machines were still reachable, and looking up their names would not let anything else in it run until each lookup had finished. A check that touches nothing took more than eight seconds to answer, and your question waited behind it until it gave up. The gateway no longer stops for a name.",
    "That check also cost more the quieter the network got. Every unreachable machine was retried for up to eight seconds, and the machines were checked strictly one after another, so a pass over a couple of dozen of them ran for minutes — and every request made during a pass waited its turn. Each machine is now looked up once and several are checked at a time, so one that has genuinely gone away is recorded as gone in the pass that finds it, instead of holding up everything else while it decides.",
    "Nothing in this app changed to make that work. The fault was in the gateway and the gateway is fixed, so it is already live and you have felt it before reading this — this release records the fix rather than delivering it.",
  ],
  "0.2.13": [
    "The network's catalogue changed under this app: Math, Code, and Writing specialists are gone, replaced by one general model family at four sizes. Common now follows that change — the setup screen that asked which lane you were for is gone with it, and the app instead recommends the largest size your machine can run comfortably.",
    "A machine with memory to spare is no longer held to a model chosen for a lane that no longer exists. The recommendation is read straight from the network's own requirements, so a floor that moves there moves with it here.",
    "The proof-of-life question asked right after joining no longer risks naming the wrong model by mistake. It now simply asks whatever your machine just started running, rather than keeping its own guess of what that should be called.",
  ],
  "0.2.14": [
    "A machine that updated from before the catalogue changed could land with no model and no way to choose one — Settings said \"No model chosen yet\" and showed nothing underneath it, because the control for picking a model was hidden behind already having one. It's shown outright now whenever none is chosen, so a previously-joined machine can pick a size and reconnect.",
  ],
  "0.2.15": [
    "Answers from a single machine arrive as they're typed, the way a chat is supposed to feel, instead of showing up all at once once the whole thing is ready. On a cold model that used to mean tens of seconds of nothing; now the words land as the network's machine writes them. A question the network splits across more than one machine still arrives all at once, because that answer genuinely isn't written until every machine involved has finished and the pieces are combined — there's nothing earlier to show.",
  ],
  "0.2.16": [
    "While an answer is still arriving, a small circle at the end of the text breathes, so you can tell it is still being written. It stops with the rest of the streamed text once the answer is complete, and it stays still for anyone who has reduced motion turned on.",
  ],
  "0.2.17": [
    "Setting up on a slow connection no longer gives up partway through the first model download. The wait keeps going while the download is still moving, and a download that really stalls now says so, with how far it got, instead of blaming the network.",
    "Common checks for a CLI update when it launches, so a machine that only ever runs the app gets fixes to the network's software without waiting for a new app release.",
    "The disk check on Windows no longer runs a command line with the drive path written into it.",
    "Answers have a wider reading column, and the setup screens are centred.",
  ],
  "0.3.0": [
    "On Windows the title bar is now the same dark as the app, instead of a light strip across the top of it. Windows 11 shows the full colour; Windows 10 keeps its own dark bar.",
    "If Common crashes, it keeps the details on this machine and shows a restart screen with a feedback button. Nothing is sent anywhere. The details go into the diagnostics report only when you choose to copy or save it.",
    "The diagnostics report also counts how many questions were asked, answered, failed or stopped, and how often a reconnect worked. Those counts stay on this machine and contain no conversation text.",
  ],
  "0.3.1": [
    "If a connection drops partway through an answer, Common now shows the answer as failed instead of showing the partial text as complete.",
    "Common's bundled network software is updated to the current release, so fixes to the network reach you with this update.",
  ],
};

/** Every version with notes, oldest first — the order the card reads them in,
 *  and the order `whatsNewFor` walks. Generated with the map above, because a
 *  key order that only happens to be ascending is not a guarantee. */
const ORDER: readonly string[] = [
  "0.2.0",
  "0.2.1",
  "0.2.2",
  "0.2.3",
  "0.2.4",
  "0.2.5",
  "0.2.6",
  "0.2.7",
  "0.2.8",
  "0.2.9",
  "0.2.10",
  "0.2.11",
  "0.2.12",
  "0.2.13",
  "0.2.14",
  "0.2.15",
  "0.2.16",
  "0.2.17",
  "0.3.0",
  "0.3.1",
];

// <<< make-notes: end generated

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
 * The notes for every version the user has not yet been told about are gathered
 * here — everywhere in `(seen, running]`, in ascending order — and not just the
 * running version's. A user moving 0.2.2 → 0.2.11 did not run 0.2.3 through
 * 0.2.10, and telling them only what 0.2.11 did leaves nine releases of fixes
 * unsaid. A version with no lines of its own contributes nothing and does not
 * stop the ones around it from being read.
 *
 * A first run counts as an update, which is the one judgement in this file worth
 * arguing. The alternative — record the version silently when nothing has been
 * seen, and speak only on later updates — reads better until you notice that
 * nobody would ever hear from it: the first release that ships this has no
 * predecessor that could have written the key, so the very update it was built for
 * would be the one it stayed quiet about. A fresh install therefore gets the tile
 * too, and reads it as what the app does rather than as what changed, which is a
 * fine thing for it to say either way. `seen` of `null` is read here as "everything
 * up to and including the running version".
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

  const notes: string[] = [];
  for (const version of ORDER) {
    // Anything at or below what has been read is not news. With nothing read,
    // nothing is excluded on this side.
    if (seen !== null && !isNewer(version, seen)) continue;
    // And nothing beyond the version now running — a machine that has not been
    // updated to a release must not be told about it.
    if (version !== running && !isNewer(running, version)) continue;
    const block = notesFor(version);
    if (block !== null) notes.push(...block);
  }

  // Nothing to say: either no version in the range has notes, or the running
  // version could not be compared at all (a `-beta.1` suffix, say), in which
  // case every comparison above was `false` and the honest answer is silence.
  return notes.length === 0 ? null : notes;
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
