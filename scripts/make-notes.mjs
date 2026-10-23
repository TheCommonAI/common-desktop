#!/usr/bin/env node
// One source of release notes, three surfaces.
//
// ── Why this is a script and not two hand-written copies ──────────────────────
//
// The same sentence about a release has to appear in three places: the GitHub
// release body, `latest.json`'s `notes` (which is that same file, handed to the
// manifest generator), and the in-app "What's new" card. Written by hand they
// drift, and the drift is invisible — the release page says one thing, the app
// says another, and nothing compares them. So the content lives once, in
// `release-notes.json`, and both outputs are cut from it here:
//
//   • `release-notes.md` — the preamble every release carries, plus the lines
//     for the version being released. `publish-preview.yml` used to heredoc
//     this, identically for every 0.2.x, with no per-version content at all.
//   • the NOTES map in `src/chat/whats-new.ts` — the same per-version lines,
//     spliced into the file between two markers so its hand-written prose
//     (which is the reason the card reads the way it does) is left alone.
//
//   node scripts/make-notes.mjs notes <version> [out-file]
//   node scripts/make-notes.mjs whats-new
//   node scripts/make-notes.mjs check
//
// `check` is the drift guard, in the same spirit as `check-version.mjs`: it
// fails loudly if the committed `whats-new.ts` is not byte-for-byte what
// `whats-new` would write, so the two surfaces cannot silently diverge. It runs
// in `verify`, before any artifact exists.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "release-notes.json");
const WHATS_NEW = join(ROOT, "src", "chat", "whats-new.ts");

/**
 * The markers the generated region sits between.
 *
 * Everything *between* them is rewritten from `release-notes.json`; everything
 * outside them is left as it was, so the file's essays survive a regeneration.
 * The check works by regenerating and comparing, which means a marker moved or
 * lost is a failure rather than a silent no-op.
 */
const BEGIN = "// >>> make-notes: generated — do not edit; run `node scripts/make-notes.mjs whats-new`";
const END = "// <<< make-notes: end generated";

function fail(message) {
  process.stderr.write(`make-notes: ${message}\n`);
  process.exit(1);
}

/** The one source, parsed and sanity-checked. */
function loadSource() {
  let text;
  try {
    text = readFileSync(SOURCE, "utf8");
  } catch {
    fail("release-notes.json is missing — run this from the repository root");
  }

  let source;
  try {
    source = JSON.parse(text);
  } catch (error) {
    fail(`release-notes.json is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(source.preamble) || source.preamble.length === 0) {
    fail("release-notes.json has no preamble");
  }
  if (!Array.isArray(source.versions) || source.versions.length === 0) {
    fail("release-notes.json has no versions");
  }

  // Ascending, because the card concatenates them in this order and a version
  // out of place would show 0.2.9's notes above 0.2.3's. Compared as numbers,
  // since "0.2.10" sorts before "0.2.9" as text.
  let previous = null;
  for (const entry of source.versions) {
    if (typeof entry.version !== "string" || !Array.isArray(entry.notes)) {
      fail(`a version entry is not { version, notes }: ${JSON.stringify(entry)}`);
    }
    if (entry.notes.length === 0 || entry.notes.some((note) => typeof note !== "string" || note === "")) {
      fail(`${entry.version} has an empty note — the card skips a version with no lines by leaving it out`);
    }
    const order = entry.version.split(".").map(Number);
    if (previous !== null && compare(order, previous) <= 0) {
      fail(`versions are not in ascending order: ${entry.version} follows a version it should precede`);
    }
    previous = order;
  }

  return source;
}

function compare(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * The release body for one version: the preamble, then what that version did.
 *
 * The section is dropped entirely when a version carries no lines, rather than
 * left as an empty heading — a release that changed nothing a user can see is a
 * release whose notes are the download instructions and nothing else.
 */
export function renderReleaseNotes(source, version) {
  const entry = source.versions.find((one) => one.version === version);
  if (entry === undefined) {
    fail(`no notes for ${version} in release-notes.json — every released version needs an entry`);
  }

  const blocks = [...source.preamble];
  if (entry.notes.length > 0) {
    blocks.push(`## What's new in ${version}\n\n${entry.notes.map((note) => `- ${note}`).join("\n")}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * `whats-new.ts` with its generated region cut from the source.
 *
 * Spliced rather than written whole: the file's comments argue for its voice and
 * for the first-run judgement, and they belong to whoever edits the file, not to
 * this generator. Only the two constants that must not drift are generated.
 */
export function renderWhatsNew(committed, source) {
  const lines = committed.split("\n");
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (begin === -1) fail(`src/chat/whats-new.ts has lost its "${BEGIN}" marker`);
  if (end === -1) fail(`src/chat/whats-new.ts has lost its "${END}" marker`);
  if (end < begin) fail("src/chat/whats-new.ts has its make-notes markers the wrong way round");

  const region = [
    BEGIN,
    "",
    "const NOTES: Record<string, readonly string[]> = {",
    ...source.versions.flatMap(({ version, notes }) => [
      `  ${JSON.stringify(version)}: [`,
      // `JSON.stringify` escapes exactly what a TypeScript string literal needs
      // escaped and nothing more, so the typographic quotes in the 0.2.2 lines
      // survive as themselves rather than as \u escapes.
      ...notes.map((note) => `    ${JSON.stringify(note)},`),
      "  ],",
    ]),
    "};",
    "",
    "/** Every version with notes, oldest first — the order the card reads them in,\n" +
      " *  and the order `whatsNewFor` walks. Generated with the map above, because a\n" +
      " *  key order that only happens to be ascending is not a guarantee. */",
    "const ORDER: readonly string[] = [",
    ...source.versions.map(({ version }) => `  ${JSON.stringify(version)},`),
    "];",
    "",
    END,
  ];

  return [...lines.slice(0, begin), ...region, ...lines.slice(end + 1)].join("\n");
}

function readWhatsNew() {
  try {
    return readFileSync(WHATS_NEW, "utf8");
  } catch {
    fail("src/chat/whats-new.ts is missing — run this from the repository root");
  }
}

const USAGE = `usage:
  make-notes.mjs notes <version> [out-file]   write the release notes (default release-notes.md)
  make-notes.mjs whats-new                    rewrite src/chat/whats-new.ts from release-notes.json
  make-notes.mjs check                        fail if whats-new.ts is not what whats-new would write`;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const source = loadSource();

  if (command === "notes") {
    const [version, out = "release-notes.md"] = rest;
    if (version === undefined) fail(USAGE);
    const markdown = renderReleaseNotes(source, version);
    writeFileSync(out, markdown);
    const entry = source.versions.find((one) => one.version === version);
    process.stdout.write(`make-notes: ${out} — ${entry.notes.length} lines for ${version}\n`);
    return;
  }

  if (command === "whats-new") {
    const committed = readWhatsNew();
    writeFileSync(WHATS_NEW, renderWhatsNew(committed, source));
    process.stdout.write(`make-notes: src/chat/whats-new.ts — ${source.versions.length} versions\n`);
    return;
  }

  if (command === "check") {
    const committed = readWhatsNew();
    const wanted = renderWhatsNew(committed, source);
    if (committed === wanted) {
      process.stdout.write(`make-notes: src/chat/whats-new.ts matches release-notes.json\n`);
      return;
    }
    const at = firstDifference(committed, wanted);
    const line = committed.slice(0, at).split("\n").length;
    fail(
      `src/chat/whats-new.ts does not match release-notes.json (first difference at line ${line}) — ` +
        `run \`node scripts/make-notes.mjs whats-new\` and commit the result`,
    );
  }

  fail(USAGE);
}

/** The index of the first character two strings disagree at, or the length of
 *  the shorter one when one is a prefix of the other. */
function firstDifference(left, right) {
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) return i;
  }
  return shared;
}

// Only run the CLI when this file is the program. Imported (by the tests) it
// exports its renderers and touches nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
