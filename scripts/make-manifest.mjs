#!/usr/bin/env node
// Assemble the update manifest the app's updater reads.
//
// ── Why this is a script and not a heredoc in the workflow ─────────────────────
//
// The manifest is the one file that has to be exactly right for an app to ever
// update itself again, and a mistake in it is silent: the app checks, fails to
// parse, and reports "couldn't reach the release feed" forever while the feed is
// perfectly reachable. That failure deserves a thing that can be run and checked
// by hand, on real artifacts, before a tag is pushed — not twenty lines inlined
// in YAML where the only way to test it is to cut a release.
//
// ── What the updater will and will not accept, read off the plugin ────────────
//
// These are not guesses. `tauri-plugin-updater` 2.13.3, `src/updater.rs`:
//
//   • `version` is semver. It also accepts the alias `name`.
//   • `notes` is optional. `pub_date` is optional, but if it is present it is
//     parsed with `OffsetDateTime::parse(.., Rfc3339)` and a parse failure fails
//     the *whole* manifest. A hand-written `pub_date` is therefore worse than no
//     `pub_date`, so this script always emits a real RFC 3339 instant.
//   • A manifest is either dynamic (`url` + `signature` at the top level, for a
//     server that resolves the platform itself) or static (`platforms`, a map).
//     This is the static form, because one GitHub release serves every platform.
//   • For a static manifest the lookup is `{os}-{arch}-{bundle_type}` and then
//     falls back to `{os}-{arch}` (updater.rs:262). The fallback is what these
//     keys use, so they stay stable whatever installer the bundler emits.
//
// `signature` is the *contents* of the `.sig` file Tauri wrote, not a path — the
// file is itself base64 of the minisign block, and it goes in verbatim.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "TheCommonAI/common-desktop";

/** Where each platform's update payload lives, as named in the release. */
const PLATFORMS = [
  { key: "darwin-aarch64", file: (v) => `Common_${v}_aarch64.app.tar.gz` },
  { key: "darwin-x86_64", file: (v) => `Common_${v}_x64.app.tar.gz` },
  { key: "windows-x86_64", file: () => "Common-win-x64.exe" },
];

function fail(message) {
  process.stderr.write(`make-manifest: ${message}\n`);
  process.exit(1);
}

/**
 * A real instant, or nothing.
 *
 * The caller may pass one in, because a release wants the same timestamp here and
 * in the notes. It is *pattern-checked before parsing*, and that ordering is the
 * whole point: `new Date("13 October 2026")` does not fail, it returns a plausible
 * instant, and `toISOString()` then turns it into a perfectly well-formed RFC 3339
 * string that the updater will happily accept. A validator that launders bad input
 * into good-looking output is worse than no validator, because the manifest is
 * valid, the release ships, and the date is simply wrong.
 *
 * So the two shapes RFC 3339 admits are spelled out, and anything else is refused
 * rather than interpreted. A bare `YYYY-MM-DD` is taken as midnight UTC, which is
 * the one reading of it that cannot surprise anyone.
 *
 * The day is checked against the month, for the same reason one layer down: the
 * 31st of February matches the pattern, and `new Date` does not reject it — it
 * rolls it forward to the 3rd of March, so the manifest would carry a date nobody
 * chose and look entirely well-formed doing it.
 */
function daysInMonth(year, month) {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31][month - 1];
}

function timestamp(given) {
  if (given === undefined) return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(given);
  const full = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(given);
  if (dateOnly === null && !full) {
    fail(`pub_date is not RFC 3339: ${given} (want 2026-10-13T20:30:00Z, not a phrase)`);
  }

  const [, year, month, day] = dateOnly ?? /^(\d{4})-(\d{2})-(\d{2})/.exec(given);
  if (Number(month) < 1 || Number(month) > 12) fail(`pub_date has no month ${month}: ${given}`);
  if (Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) {
    fail(`pub_date is not a day that exists: ${given}`);
  }

  const at = new Date(dateOnly === null ? given : `${given}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) fail(`pub_date is not a real instant: ${given}`);
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function main() {
  const [dir, version, tag, ...rest] = process.argv.slice(2);
  if (dir === undefined || version === undefined || tag === undefined) {
    fail("usage: make-manifest.mjs <artifacts-dir> <version> <tag> [pub_date] [notes-file]");
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`version is not semver: ${version}`);
  // The URLs are tag-pinned while the manifest itself stays on the version-less
  // endpoint, so a newer release published later cannot retroactively change what
  // an older manifest points at.
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`tag is not v<semver>: ${tag}`);

  const pubDate = timestamp(rest[0]);
  const notes = rest[1] === undefined ? undefined : readFileSync(rest[1], "utf8").trim();

  const platforms = {};

  for (const { key, file } of PLATFORMS) {
    const name = file(version);
    const path = join(dir, name);

    try {
      readFileSync(path);
    } catch {
      fail(`${key}: no such artifact ${path}`);
    }

    // A missing .sig is the failure that would otherwise ship silently: the release
    // would go out, the manifest would be written, and every installed copy would
    // reject the update at install time with "signature invalid".
    let signature;
    try {
      signature = readFileSync(`${path}.sig`, "utf8").trim();
    } catch {
      fail(`${key}: ${name}.sig is missing — the build was not signed`);
    }
    if (signature === "") fail(`${key}: ${name}.sig is empty`);

    platforms[key] = {
      signature,
      url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
    };
  }

  const manifest = { version, pub_date: pubDate, platforms };
  if (notes !== undefined && notes !== "") manifest.notes = notes;

  writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

  process.stdout.write(
    `make-manifest: ${Object.keys(platforms).length} platforms, version ${version}, ` +
      `pub_date ${pubDate}\n`,
  );
}

main();
