/**
 * The lane choice, pinned.
 *
 * COM-5 — the app only ever picked the math lane — and COM-8 — and it picked
 * badly — are both properties of two functions that need no app around them:
 * `fitsHere` in `src/onboarding/models.ts`, which decides what this machine can
 * carry, and `suggestLane` in `src/onboarding/service.real.ts`, which decides
 * which lane to name. The shape of the bug is that the first demanded 16 GB of
 * memory and 4 GB of graphics memory that the catalogue does not ask for, and
 * read a graphics figure Windows never reports as zero — so every full model
 * failed everywhere, and the second, whose default lane was Math, named Math.
 *
 * ── Why there is no runner here ────────────────────────────────────────────────
 *
 * This project has no frontend test runner, and adding vitest and a jsdom for
 * two functions would be a larger change than the fix. Node strips TypeScript
 * itself, so the harness below copies the two real sources into a temp directory
 * with two specifiers repointed at stand-ins — `./service`, which imports both
 * implementations and so cannot be loaded here, and `@tauri-apps/api/core`,
 * which throws outside the app — and imports the copies. Everything that decides
 * anything is the real source, read from `src/` on every run; the only thing
 * mocked is the seam to the machine and to the network.
 *
 * Run it with: node --test tests/lane-choice.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------------------------------- harness ---------------------------------- */

const SOURCE_DIR = fileURLToPath(new URL("../src/onboarding/", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "lane-choice-"));
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
 *  is a machine with no app on it and the ordinary case for a lane choice. */
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
stage("models.ts", []);
stage("service.real.ts", [
  ['from "./models"', 'from "./models.ts"'],
  ['from "./service"', 'from "./service.mjs"'],
  ['from "@tauri-apps/api/core"', 'from "./tauri.mjs"'],
]);

const models = await import(pathToFileURL(join(TMP, "models.ts")).href);
const { createRealService } = await import(pathToFileURL(join(TMP, "service.real.ts")).href);

const { fitsHere, requirementFor, MODEL_CATALOG } = models;
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

/** The gaps document the gateway's `/demand/gaps` returns, as the seam delivers
 *  it: a JSON string, one entry per domain. */
function gaps(...entries) {
  return JSON.stringify({
    domain_gaps: entries.map(([domain, gap]) => ({ domain, gap, coverage: 0, demand: gap })),
  });
}

/** The catalogue, as the gateway's `GET /catalogue` returns it. */
function catalogue(...entries) {
  return JSON.stringify(entries);
}

/** A network that answers, and a catalogue that does not. */
function withNetwork(gapsJson) {
  globalThis.__invoke = (command) =>
    command === "network_recommend" ? gapsJson : Promise.reject(new Error("no catalogue"));
}

function withCatalogue(catalogueJson) {
  globalThis.__invoke = (command) =>
    command === "network_catalogue" ? catalogueJson : Promise.reject(new Error("no gaps"));
}

/** Nothing is listening: no gaps and no catalogue, which is a network this
 *  machine is choosing a lane without. */
function offline() {
  globalThis.__invoke = undefined;
}

async function suggest(report) {
  return service.suggestLane(report).result;
}

function option(suggestion, lane) {
  return suggestion.options.find((each) => each.lane === lane);
}

/* ------------------------- what this machine can carry ------------------------- */

test("COM-5: graphics memory the platform never reports is unknown, not zero", () => {
  const report = machine(16 * GiB);

  // The bug: `vramBytes ?? 0` read "unknown" as 0 and then asked 0 >= 4 GB.
  // Every full model failed on every Windows machine, whatever the card was.
  for (const lane of ["math", "code", "writing"]) {
    const model = MODEL_CATALOG.full[lane];
    assert.ok(
      fitsHere(model.id, report),
      `${model.id} should fit a 16 GiB machine whose card reports no memory`,
    );
  }

  // And a graphics read that failed outright is unknown in the same way: the
  // report cannot tell "no adapter" from "I could not look", so it may not
  // pretend to know either.
  assert.ok(fitsHere("qwen2.5-math-7b", machine(16 * GiB, null)));
});

test("the catalogue's floor decides the fit, at the catalogue's headroom", () => {
  // 11 GiB is on the full rung, and 80% of it is 9.45 GB: short of the 10 GB the
  // catalogue asks of Math 7B and Qwen3 8B, clear of the 8 GB it asks of Coder 7B.
  const eleven = machine(11 * GiB);
  assert.equal(fitsHere("qwen2.5-math-7b", eleven), false);
  assert.equal(fitsHere("qwen3-8b", eleven), false);
  assert.equal(fitsHere("qwen2.5-coder-7b", eleven), true);

  // 12 GiB clears all three, which is the point of measuring against the
  // catalogue's floor rather than the 16 GB the app used to demand.
  const twelve = machine(12 * GiB);
  for (const lane of ["math", "code", "writing"]) {
    assert.ok(fitsHere(MODEL_CATALOG.full[lane].id, twelve), `12 GiB should carry ${lane}`);
  }
});

test("a graphics shortfall can only fail a model that asks for graphics memory", () => {
  // No model in this ladder asks for any, so the test is written against a
  // synthetic requirement: the day the catalogue asks for 4 GB, this is what the
  // four ways a machine can answer must come to.
  const asks = { "qwen2.5-math-7b": { minRamGb: 10, needsGpu: false, minVramGb: 4 } };
  const card = (vramBytes, unified) => ({
    vendor: "NVIDIA",
    name: "GeForce RTX 3060",
    vramBytes,
    unified,
  });
  const report = (graphics) => machine(16 * GiB, graphics);

  assert.equal(fitsHere("qwen2.5-math-7b", report(card(2 * GiB, false)), asks), false);
  assert.equal(fitsHere("qwen2.5-math-7b", report(card(6 * GiB, false)), asks), true);
  // Unknown is not zero: an unreadable figure cannot be shown to be short.
  assert.equal(fitsHere("qwen2.5-math-7b", report(card(null, false)), asks), true);
  // A unified machine's graphics memory is the memory the RAM floor already
  // counted, so the catalogue's separate demand for it does not apply twice.
  assert.equal(fitsHere("qwen2.5-math-7b", report(card(null, true)), asks), true);
});

test("a requirement nobody knows is not a refusal", () => {
  // The live catalogue's answer when it has one, the table when it does not: an
  // empty override falls through rather than answering "no requirement".
  assert.equal(requirementFor("qwen2.5-math-7b", {}).minRamGb, 10);
  assert.equal(requirementFor("not-a-model", {}), null);
  // An id that is not in the ladder has nothing to fail, and neither has a model
  // with no memory reported at all — the conservative answer where the memory is
  // unknown, which `suggestLane` refuses to reach.
  assert.ok(fitsHere("not-a-model", machine(16 * GiB)));
  assert.equal(fitsHere("qwen2.5-math-7b", machine(null)), false);
});

/* ---------------------------- which lane is named ---------------------------- */

test("COM-5: a full-rung Windows machine is not sent to Math by default", async () => {
  offline();
  const suggestion = await suggest(machine(16 * GiB));

  assert.deepEqual(
    suggestion.options.map((each) => each.fits),
    [true, true, true],
    "every full model fits a 16 GiB machine",
  );
  // Coder 7B asks 8 GB where the other two ask 10, so it leaves the most room on
  // this machine. Math used to be the answer here for no reason but being first.
  assert.equal(suggestion.byMachine, "code");
  assert.equal(suggestion.recommended, "code");
  assert.equal(suggestion.networkAsk, null, "nothing is listening, so there is no ask");
});

test("COM-8: a machine that can carry no lane is not handed Math", async () => {
  offline();
  // 9.5 GB is past the light rung's threshold and short of every full model's
  // floor: 80% of it is 7.6 GB. This is the machine the old code answered Math
  // for, because `best` started at Math and nothing ever moved it.
  const suggestion = await suggest(machine(9_500_000_000));

  assert.deepEqual(
    suggestion.options.map((each) => each.fits),
    [false, false, false],
    "nothing fits, and each option says so — the screen's caption reads from this",
  );
  assert.equal(suggestion.byMachine, "code", "the lane that asks least, not the first one");
  assert.equal(suggestion.recommended, suggestion.byMachine);
  assert.notEqual(suggestion.byMachine, "math");
});

test("the fit uses the catalogue's live figures when the catalogue answers", async () => {
  // The same 9.5 GB machine, against a catalogue that says Math 7B needs 5 GB.
  // Nothing in `models.ts` changed: the floor came from the network.
  withCatalogue(
    catalogue({
      id: "qwen2.5-math-7b",
      source: "ollama:mightykatun/qwen2.5-math:7b",
      min_ram_gb: 5,
      min_vram_gb: 0,
      needs_gpu: false,
    }),
  );
  const suggestion = await suggest(machine(9_500_000_000));

  assert.equal(option(suggestion, "math").fits, true);
  assert.equal(option(suggestion, "code").fits, false);
  assert.equal(suggestion.byMachine, "math");
});

test("COM-8: lane-neutral domains do not decide what the network is short of", async () => {
  // Every domain here describes how a request is put rather than what it is
  // about, and all of them used to be counted for Math — 400 of the 403 units
  // below, which is why the answer was always Math. `code` carries the only
  // domain that names a lane, so `code` is the answer the network is giving.
  withNetwork(
    gaps(
      ["logic", 100],
      ["reasoning", 100],
      ["step-by-step", 100],
      ["planning", 100],
      ["general", 100],
      ["conversation", 100],
      ["code", 3],
    ),
  );
  const suggestion = await suggest(machine(16 * GiB));

  assert.deepEqual(suggestion.networkAsk, { lane: "code", demand: "high" });
  assert.equal(suggestion.recommended, "code");
});

test("an ask made only of lane-neutral domains is no ask at all", async () => {
  withNetwork(gaps(["general", 90], ["conversation", 90], ["reasoning", 90]));
  const suggestion = await suggest(machine(16 * GiB));

  assert.equal(suggestion.networkAsk, null, "a shortage all three lanes answer is not evidence");
  assert.equal(suggestion.recommended, suggestion.byMachine);
});

test("the network's ask is taken when this machine can carry it, and not when it cannot", async () => {
  withNetwork(gaps(["word-problems", 10], ["math", 4]));
  const carries = await suggest(machine(16 * GiB));
  assert.deepEqual(carries.networkAsk, { lane: "math", demand: "high" });
  assert.equal(carries.byMachine, "code", "the machine's own answer, still reported");
  assert.equal(carries.recommended, "math", "the ask is taken: this machine can carry it");

  // The same ask against a machine that cannot carry Math: it is still reported,
  // because the caption is a sentence about the difference between the two, but
  // the recommendation stays on the lane the machine can actually run.
  const cannot = await suggest(machine(9_500_000_000));
  assert.deepEqual(cannot.networkAsk, { lane: "math", demand: "high" });
  assert.equal(cannot.recommended, "code");
  assert.equal(option(cannot, "math").fits, false);
});
