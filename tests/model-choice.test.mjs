/**
 * The model choice, pinned.
 *
 * Successor to `lane-choice.test.mjs`, after COM-5/COM-8's three-lane catalogue
 * was replaced by prism-ml's Bonsai 2 — one family at four sizes. Two properties
 * carry over unchanged, because the bug they pin was never about lanes: `fitsHere`
 * in `src/onboarding/models.ts` must read a graphics figure Windows never reports
 * as unknown rather than zero, and it must measure against the catalogue's own
 * floor rather than an app-invented one. What is new is `suggestModel` in
 * `src/onboarding/service.real.ts`, which picks a rung by memory alone now that
 * there is no lane to ask the network about.
 *
 * ── Why there is no runner here ────────────────────────────────────────────────
 *
 * This project has no frontend test runner, and adding vitest and a jsdom for two
 * functions would be a larger change than the fix. Node strips TypeScript itself,
 * so the harness below copies the two real sources into a temp directory with two
 * specifiers repointed at stand-ins — `./service`, which imports both
 * implementations and so cannot be loaded here, and `@tauri-apps/api/core`, which
 * throws outside the app — and imports the copies. Everything that decides
 * anything is the real source, read from `src/` on every run; the only thing
 * mocked is the seam to the machine and to the network.
 *
 * Run it with: node --test tests/model-choice.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------------------------------- harness ---------------------------------- */

const SOURCE_DIR = fileURLToPath(new URL("../src/onboarding/", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "model-choice-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** The contract, as much of it as the real service touches at runtime. The error
 *  class has to be a real class with a real `name`, because `asError` narrows
 *  with `instanceof` and the screen switches on `code`. */
const SERVICE_MOCK = `
export class OnboardingError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
    this.detail = detail;
  }
}
`;

/** The Tauri seam. Every read here goes through `globalThis.__invoke`, which each
 *  test sets to what its machine and its network answer — or leaves unset, which
 *  is a machine with no app on it and the ordinary case for a model choice. */
const TAURI_MOCK = `
export function invoke(command, args) {
  const respond = globalThis.__invoke;
  if (typeof respond !== "function") {
    return Promise.reject(new Error(\`nothing is listening for \${command}\`));
  }
  return Promise.resolve(respond(command, args));
}
export class Channel {}
`;

/** The app's own fetch, for the copy of `service.real.ts`.
 *
 *  Always `ready`, which is the ordinary machine — everything a join needs is
 *  already on it — so the wait at the top of `awaitServing` is skipped and what
 *  runs here is the join itself. The real decisions in that file are
 *  `tests/provision.test.mjs`'s, and none of them is a model choice. */
const PROVISION_MOCK = `
export function provisionNow() {
  return { kind: "ready" };
}
export async function startProvisioning() {
  return provisionNow();
}
`;

/** Copy a source into the temp directory, pointing its imports at the copies and
 *  the stand-ins. Node wants the extension on a relative specifier; the sources
 *  are written for a bundler, which does not. */
function stage(name, replacements) {
  let source = readFileSync(join(SOURCE_DIR, name), "utf8");
  for (const [from, to] of replacements) source = source.split(from).join(to);
  writeFileSync(join(TMP, name), source);
}

writeFileSync(join(TMP, "service.mjs"), SERVICE_MOCK);
writeFileSync(join(TMP, "tauri.mjs"), TAURI_MOCK);
writeFileSync(join(TMP, "provision.mjs"), PROVISION_MOCK);
stage("models.ts", []);
stage("service.real.ts", [
  ['from "./models"', 'from "./models.ts"'],
  ['from "./service"', 'from "./service.mjs"'],
  ['from "../provision"', 'from "./provision.mjs"'],
  ['from "@tauri-apps/api/core"', 'from "./tauri.mjs"'],
]);

const models = await import(pathToFileURL(join(TMP, "models.ts")).href);
const { createRealService } = await import(pathToFileURL(join(TMP, "service.real.ts")).href);

const { TIERS, fitsHere, requirementFor, modelFor, largestFitting } = models;
const service = createRealService();

/* ---------------------------------- machines ---------------------------------- */

const GiB = 1024 ** 3;

/** What Windows hands over: the card is named and its memory is deliberately not
 *  read, because the field the platform offers saturates just under 4 GiB — see
 *  `read_graphics_blocking` in `src-tauri/src/backend.rs`. `unified` is false
 *  because the memory is the card's own; it is simply not reported. */
const DISCRETE_UNREPORTED = {
  vendor: "NVIDIA",
  name: "GeForce RTX 3060",
  vramBytes: null,
  unified: false,
};

function machine(memoryBytes, graphics = DISCRETE_UNREPORTED) {
  return {
    memory: memoryBytes === null ? null : { totalBytes: memoryBytes },
    graphics,
    disk: null,
    power: null,
    os: { platform: "windows", version: "10.0.19045" },
  };
}

/** The catalogue, as the gateway's `GET /catalogue` returns it. */
function catalogue(...entries) {
  return JSON.stringify(entries);
}

function withCatalogue(catalogueJson) {
  globalThis.__invoke = (command) =>
    command === "network_catalogue" ? catalogueJson : Promise.reject(new Error("no catalogue"));
}

/** Nothing is listening: no catalogue reachable, which is a network this machine
 *  is choosing a model without — the ordinary case for `suggestModel`, which
 *  falls back to the table in `models.ts` rather than failing. */
function offline() {
  globalThis.__invoke = undefined;
}

async function suggest(report) {
  return service.suggestModel(report).result;
}

function option(suggestion, tier) {
  return suggestion.options.find((each) => each.model.tier === tier);
}

/* ------------------------- what this machine can carry ------------------------- */

test("COM-5: graphics memory the platform never reports is unknown, not zero", () => {
  const report = machine(16 * GiB);

  // The bug this pins predates the Bonsai catalogue: `vramBytes ?? 0` read
  // "unknown" as 0 and then asked 0 >= some floor. No model in this ladder asks
  // for any graphics memory, so every rung must fit regardless.
  for (const tier of TIERS) {
    const model = modelFor(tier);
    assert.ok(
      fitsHere(model.id, report),
      `${model.id} should fit a 16 GiB machine whose card reports no memory`,
    );
  }

  // And a graphics read that failed outright is unknown in the same way: the
  // report cannot tell "no adapter" from "I could not look", so it may not
  // pretend to know either.
  assert.ok(fitsHere("bonsai2-9b", machine(16 * GiB, null)));
});

test("the catalogue's floor decides the fit, at the catalogue's headroom", () => {
  // 4 GiB is short of the 9B's 5 GB floor at 80% headroom (3.2 GB available) and
  // clear of the 8B's 4 GB floor... actually 80% of 4 GiB (4.29 GB) is 3.44 GB,
  // short of the 8B's 4 GB too. Clear of the 4B's 3 GB and the 2B's 2 GB.
  const four = machine(4 * GiB);
  assert.equal(fitsHere("bonsai2-9b", four), false);
  assert.equal(fitsHere("bonsai-8b", four), false);
  assert.equal(fitsHere("bonsai2-4b", four), true);
  assert.equal(fitsHere("bonsai2-2b", four), true);

  // 8 GiB clears all four, which is the point of measuring against the
  // catalogue's floor rather than a flat figure invented for one lane.
  const eight = machine(8 * GiB);
  for (const tier of TIERS) {
    assert.ok(fitsHere(modelFor(tier).id, eight), `8 GiB should carry ${tier}`);
  }
});

test("a graphics shortfall can only fail a model that asks for graphics memory", () => {
  // No model in this ladder asks for any, so the test is written against a
  // synthetic requirement: the day the catalogue asks for 4 GB, this is what the
  // four ways a machine can answer must come to.
  const asks = { "bonsai2-9b": { minRamGb: 5, needsGpu: false, minVramGb: 4 } };
  const card = (vramBytes, unified) => ({
    vendor: "NVIDIA",
    name: "GeForce RTX 3060",
    vramBytes,
    unified,
  });
  const report = (graphics) => machine(16 * GiB, graphics);

  assert.equal(fitsHere("bonsai2-9b", report(card(2 * GiB, false)), asks), false);
  assert.equal(fitsHere("bonsai2-9b", report(card(6 * GiB, false)), asks), true);
  // Unknown is not zero: an unreadable figure cannot be shown to be short.
  assert.equal(fitsHere("bonsai2-9b", report(card(null, false)), asks), true);
  // A unified machine's graphics memory is the memory the RAM floor already
  // counted, so the catalogue's separate demand for it does not apply twice.
  assert.equal(fitsHere("bonsai2-9b", report(card(null, true)), asks), true);
});

test("a requirement nobody knows is not a refusal", () => {
  // The live catalogue's answer when it has one, the table when it does not: an
  // empty override falls through rather than answering "no requirement".
  assert.equal(requirementFor("bonsai2-9b", {}).minRamGb, 5);
  assert.equal(requirementFor("not-a-model", {}), null);
  // An id that is not in the ladder has nothing to fail, and neither has a model
  // with no memory reported at all — the conservative answer where the memory is
  // unknown, which `suggestModel` refuses to reach.
  assert.ok(fitsHere("not-a-model", machine(16 * GiB)));
  assert.equal(fitsHere("bonsai2-9b", machine(null)), false);
});

test("largestFitting steps down from the ceiling and is null when nothing fits", () => {
  assert.equal(largestFitting(machine(16 * GiB)), "9b");
  assert.equal(largestFitting(machine(4 * GiB)), "4b");
  // 2 GiB clears none of the four floors at headroom (80% of 2 GiB is 1.72 GB,
  // short even of the 2B's 2 GB).
  assert.equal(largestFitting(machine(2 * GiB)), null);
});

/* ---------------------------- which model is named ---------------------------- */

test("a machine with room to spare is recommended the ceiling, not a default", async () => {
  offline();
  const suggestion = await suggest(machine(16 * GiB));

  assert.deepEqual(
    suggestion.options.map((each) => each.fits),
    [true, true, true, true],
    "every rung fits a 16 GiB machine",
  );
  assert.equal(suggestion.model.tier, "9b");
  assert.equal(suggestion.fits, true);
});

test("a machine that carries no rung comfortably is still given the floor, honestly", async () => {
  offline();
  // 1.5 GiB clears none of the four floors at headroom: 80% of it is 1.29 GB,
  // short even of the 2B's 2 GB. This is the machine the old lane ladder would
  // have answered Math for, for no reason but being first.
  const suggestion = await suggest(machine(1.5 * GiB));

  assert.deepEqual(
    suggestion.options.map((each) => each.fits),
    [false, false, false, false],
    "nothing fits, and each option says so — the screen's caption reads from this",
  );
  assert.equal(suggestion.model.tier, "2b", "the floor of the ladder, not a refusal");
  assert.equal(suggestion.fits, false);
});

test("the fit uses the catalogue's live figures when the catalogue answers", async () => {
  // The same 1.5 GiB machine, against a catalogue that says the 2B needs 1 GB.
  // Nothing in `models.ts` changed: the floor came from the network.
  withCatalogue(
    catalogue({
      id: "bonsai2-2b",
      source: "gguf:https://huggingface.co/prism-ml/bonsai2-2b#sha256",
      min_ram_gb: 1,
      min_vram_gb: 0,
      needs_gpu: false,
    }),
  );
  const suggestion = await suggest(machine(1.5 * GiB));

  assert.equal(option(suggestion, "2b").fits, true);
  assert.equal(suggestion.model.tier, "2b");
  assert.equal(suggestion.fits, true);
});

test("suggestModel rejects only when the machine's own memory cannot be read", async () => {
  offline();
  await assert.rejects(
    suggest(machine(null)),
    (error) => error.code === "permission-denied",
  );
});
