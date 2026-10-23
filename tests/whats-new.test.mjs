/**
 * The update card, and the one file both it and the release page are cut from.
 *
 * Two things are pinned here, and both are quiet when they are wrong:
 *
 * — `whatsNewFor`, which decides what the card says. It used to answer with the
 *   running version's notes alone, so a user coming back on 0.2.11 after last
 *   opening 0.2.2 learned what 0.2.11 did and never what 0.2.3 through 0.2.10
 *   fixed. It now gathers every version in `(seen, running]`. A mistake in that
 *   range is invisible: the card still opens, still reads well, and simply omits
 *   releases — so the range is asserted exactly, against `release-notes.json`.
 * — The generated region of `src/chat/whats-new.ts`. `release-notes.json` is the
 *   source for the release body and `latest.json`'s `notes` as well, and if the
 *   committed card stops matching it, the release page and the app disagree about
 *   the same release, silently. The same check runs in `verify`.
 *
 * Run it with: node --test tests/whats-new.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------------------------------- harness ---------------------------------- */

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const WHATS_NEW_TS = fileURLToPath(new URL("../src/chat/whats-new.ts", import.meta.url));
const SOURCE_JSON = fileURLToPath(new URL("../release-notes.json", import.meta.url));

const TMP = mkdtempSync(join(tmpdir(), "whats-new-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** `whats-new.ts` imports nothing, so it is staged as a straight copy — the
 *  point of the staging is only that Node loads it as TypeScript, the way a
 *  bundler would. */
const COMMITTED = readFileSync(WHATS_NEW_TS, "utf8");
writeFileSync(join(TMP, "whats-new.ts"), COMMITTED);

const WHATS_NEW = pathToFileURL(join(TMP, "whats-new.ts")).href;
const { notesFor, whatsNewFor } = await import(WHATS_NEW);

/* ---------------------------------- the source ---------------------------------- */

const SOURCE = JSON.parse(readFileSync(SOURCE_JSON, "utf8"));
const VERSIONS = SOURCE.versions.map((entry) => entry.version);

/** The lines for a half-open range of versions, oldest first — `(after, through]`,
 *  which is exactly what the card is supposed to gather. `null` for `after` is
 *  the first-run case and takes everything up to and including `through`. */
function notesAfter(after, through) {
  const start = after === null ? 0 : VERSIONS.indexOf(after) + 1;
  const end = VERSIONS.indexOf(through) + 1;
  assert.ok(start < end, `${after} → ${through} is not a forwards range`);
  return SOURCE.versions.slice(start, end).flatMap((entry) => entry.notes);
}

/* ------------------------------ what the card says ------------------------------ */

test("a first run is told everything, from the beginning, in order", () => {
  const notes = whatsNewFor(null, "0.2.11");
  assert.deepEqual(notes, notesAfter(null, "0.2.11"));
  // Named ends, so a range that silently lost a version at either edge fails even
  // if `notesAfter` were wrong in the same direction.
  assert.equal(notes[0], notesFor("0.2.0")[0]);
  assert.equal(notes.at(-1), notesFor("0.2.11").at(-1));
});

test("an update is told every release it skipped, and not the one it left", () => {
  const notes = whatsNewFor("0.2.2", "0.2.11");
  assert.deepEqual(notes, notesAfter("0.2.2", "0.2.11"));
  // The heart of it: 0.2.3 through 0.2.10 are owed, and 0.2.2 is not repeated.
  assert.equal(notes[0], notesFor("0.2.3")[0]);
  assert.equal(notes.includes(notesFor("0.2.2")[0]), false);
  // The old shape — the running version's notes and nothing else — must not be
  // what this returns. If it were, the card would be back to one version.
  assert.notDeepEqual(notes, notesFor("0.2.11"));
});

test("a small step up is told only what the step carried", () => {
  assert.deepEqual(whatsNewFor("0.2.9", "0.2.11"), notesAfter("0.2.9", "0.2.11"));
});

test("the judgement about first runs is unchanged", () => {
  // A fresh install on the newest version hears the whole story, which the file
  // argues for at length. This is that argument, pinned.
  assert.deepEqual(whatsNewFor(null, "0.2.0"), notesAfter(null, "0.2.0"));
});

test("nothing is said when there is nothing to say", () => {
  // "" is `appVersion` failing to answer.
  assert.equal(whatsNewFor(null, ""), null);
  assert.equal(whatsNewFor("0.2.2", ""), null);
  // Already read.
  assert.equal(whatsNewFor("0.2.11", "0.2.11"), null);
  // Gone backwards: a user who returned to an older build is not owed a second
  // telling.
  assert.equal(whatsNewFor("0.2.11", "0.2.2"), null);
  // A version that cannot be ordered — a suffix, say — is silence rather than a
  // guess, on both sides of the comparison.
  assert.equal(whatsNewFor(null, "0.2.11-beta.1"), null);
  assert.equal(whatsNewFor("beta", "0.2.11"), null);
});

test("no line is written for two versions at once", () => {
  // The card keys its list by the text of each line. Two identical lines across
  // the cumulative range would collide as React keys, and a duplicated sentence
  // is a copy-paste rather than a repeat worth saying twice.
  const all = notesAfter(null, "0.2.11");
  assert.equal(new Set(all).size, all.length);
});

/* ------------------------------ the one source ------------------------------ */

test("the committed card is exactly what the generator would write", async () => {
  const { renderWhatsNew } = await import(
    pathToFileURL(fileURLToPath(new URL("../scripts/make-notes.mjs", import.meta.url))).href
  );
  assert.equal(
    renderWhatsNew(COMMITTED, SOURCE),
    COMMITTED,
    "src/chat/whats-new.ts has drifted from release-notes.json — " +
      "run `node scripts/make-notes.mjs whats-new` and commit the result",
  );
});

test("every version the card knows about is in the source, in order", () => {
  // The generated `ORDER` is what `whatsNewFor` walks, so a version present in
  // the map but missing from it — or in the wrong place — changes what is said.
  for (const version of VERSIONS) assert.notEqual(notesFor(version), null);
  assert.deepEqual(
    VERSIONS,
    [...VERSIONS].sort((a, b) => {
      const left = a.split(".").map(Number);
      const right = b.split(".").map(Number);
      for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
      return 0;
    }),
  );
});
