#!/usr/bin/env node
// The version lives in three files, and a release is only self-consistent when all
// three agree.
//
//   package.json                 the webview bundle
//   src-tauri/Cargo.toml         the binary
//   src-tauri/tauri.conf.json    the bundle the updater compares against
//
// The last one is the one that matters, because the updater does not read the
// manifest's version against the tag or against the release page — it compares it
// against the version compiled into the copy already running on someone's machine.
// A release whose tag says v0.3.0 while the bundle says 0.2.0 does not fail loudly:
// it publishes, the manifest is well-formed, and every installed copy correctly
// decides it is already up to date. Nothing updates, and nothing errors.
//
// So this runs in `verify`, before any artifact exists, and again in the publish
// workflow against the tag being pushed.
//
//   node scripts/check-version.mjs [tag]
//
// With no tag it checks that the three files agree. With a tag (`v0.3.0`, or a bare
// `0.3.0`) it also checks that the tag agrees with them.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`check-version: ${message}\n`);
  process.exit(1);
}

function read(relative) {
  try {
    return readFileSync(join(ROOT, relative), "utf8");
  } catch {
    fail(`${relative} is missing — run this from the repository root`);
  }
}

/**
 * The version of the crate itself, not of anything it depends on.
 *
 * A bare `/^version = "(.+)"/m` would match the first `version` key anywhere in the
 * file, which is `[package]` today and could stop being so the moment someone adds a
 * `[workspace.package]` or reorders a table. So the search is scoped to the
 * `[package]` table: it starts at that header and stops at the next one.
 */
function cargoVersion() {
  const toml = read("src-tauri/Cargo.toml");
  const lines = toml.split("\n");

  const start = lines.findIndex((line) => line.trim() === "[package]");
  if (start === -1) fail("src-tauri/Cargo.toml has no [package] table");

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  for (const line of lines.slice(start + 1, end)) {
    // TOML forbids two `version` keys in one table, so the first match is the one.
    const found = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (found !== null) return found[1];
  }
  fail("src-tauri/Cargo.toml [package] has no version");
}

const versions = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/Cargo.toml": cargoVersion(),
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
};

for (const [file, version] of Object.entries(versions)) {
  if (typeof version !== "string" || version === "") fail(`${file} has no version`);
}

const distinct = [...new Set(Object.values(versions))];
if (distinct.length > 1) {
  const detail = Object.entries(versions)
    .map(([file, version]) => `  ${file}: ${version}`)
    .join("\n");
  fail(`the version files disagree — the updater compares against tauri.conf.json:\n${detail}`);
}
const version = distinct[0];

// `v0.3.0` in a release, `0.3.0` in a package — both are the same statement, and
// insisting on one shape here would only mean the caller has to remember which.
const tag = process.argv[2]?.trim().replace(/^v/, "");
if (tag !== undefined && tag !== "" && tag !== version) {
  fail(
    `the tag says ${tag} but the source says ${version} — every installed copy would ` +
      `correctly refuse this release, since the updater compares the manifest's version ` +
      `against the version compiled into the running app`,
  );
}

// The publish workflow reads this rather than parsing the tag a second time, so the
// version it stamps into `latest.json` is the one that was checked, not one re-derived.
const output = process.env.GITHUB_OUTPUT;
if (output !== undefined && output !== "") {
  appendFileSync(output, `version=${version}\n`);
}

process.stdout.write(`check-version: ${version} (agreed in all three files)\n`);
