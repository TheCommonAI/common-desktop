/**
 * Reconnecting, pinned.
 *
 * The report this feature exists for — "after set up and in chat, after turning
 * the laptop on and off again, it disconnects and there is no way to reconnect"
 * — is a wiring failure, not a missing mechanism: `common join` is a foreground
 * process that a reboot kills, and nothing ever started it again. So most of the
 * fix is calls that a test cannot reach. What *can* be reached is the four
 * decisions those calls rest on, and each of them is wrong in a way nobody would
 * see until it mattered:
 *
 * — `shouldSpawn`, which decides whether a reconnect starts a join or leaves a
 *   serving one alone. Read a live join as ended and a working node is restarted
 *   underneath itself; read a dead one as live and the reported bug survives the
 *   fix in silence. Both failures are quiet, and this is the rule for the whole
 *   feature.
 * — `mayRejoinNow`, the quiet-hours gate — including the midnight cross, which
 *   is the ordinary case here (22:00–07:00) and the one an interval test written
 *   the obvious way gets backwards.
 * — `joinInputs`, which recovers what to rejoin *as*. It must never guess a lane:
 *   a node filed under a model it is not serving is worse to the network than a
 *   machine that stayed off it.
 * — `networkFact`, which is the sentence the user reads. The load-bearing part is
 *   that "Common's command-line tool couldn't be started" must never come out as
 *   a sentence about the network.
 *
 * ── Why there is no runner here ────────────────────────────────────────────────
 *
 * The same harness as `lane-choice.test.mjs`, and for the same reason: no
 * frontend test runner, and adding vitest plus a jsdom for four functions would
 * be a larger change than the fix. Node strips TypeScript itself, so the sources
 * are copied into a temp directory with their import specifiers repointed — at
 * each other, since they are copied too, and at stand-ins for the two seams that
 * cannot load here (`./service`, which pulls in both implementations;
 * `@tauri-apps/api/core`, which throws outside the app; and `./backend`, which
 * imports both).
 *
 * Everything that decides anything is the real source, read from `src/` on every
 * run. `shouldSpawn` in particular is imported from `service.real.ts` rather than
 * re-written here: a test that pins a copy of a rule passes while the rule
 * drifts, which is the exact failure this file is meant to prevent.
 *
 * Run it with: node --test tests/rejoin.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------------------------------- harness ---------------------------------- */

const ONBOARDING_DIR = fileURLToPath(new URL("../src/onboarding/", import.meta.url));
const CHAT_DIR = fileURLToPath(new URL("../src/chat/", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "rejoin-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** The contract, as much of it as the real service touches at runtime. The error
 *  class has to be a real class with a real `name`, because the service narrows
 *  with `instanceof` and the hook switches on `code`. */
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

/** The Tauri seam, for the copy of `service.real.ts` — which is here only so that
 *  `shouldSpawn` can be imported from the real source. Nothing in these tests
 *  calls into the machine. */
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

/** The chat's own seam, for the copy of `rejoin.ts`. `whoami` is the only thing
 *  `joinInputs` reaches for, and it answers from `globalThis.__whoami` — `null`
 *  for an identity that is not there, which is what the real one returns for a
 *  machine that has never joined — and rejects outright when that global is the
 *  string `"throws"`, which is the CLI not being on disk. `gatewaySeesUs` is here
 *  because the module exports it and a stand-in that omits an export can only
 *  fail later, at a call site that reads as unrelated. */
const BACKEND_MOCK = `
export async function whoami() {
  if (globalThis.__whoami === "throws") throw new Error("no common on this machine");
  const answer = globalThis.__whoami;
  return answer === undefined || answer === null ? null : answer;
}
export async function gatewaySeesUs() {
  return globalThis.__seen === true;
}
`;

/** Copy a source into the temp directory, pointing its imports at the copies.
 *  Node wants the extension on a relative specifier; the sources are written for
 *  a bundler, which does not. Takes the directory because the two under test live
 *  in different ones. */
function stage(fromDir, name, replacements) {
  let source = readFileSync(join(fromDir, name), "utf8");
  for (const [from, to] of replacements) source = source.split(from).join(to);
  writeFileSync(join(TMP, name), source);
}

writeFileSync(join(TMP, "service.mjs"), SERVICE_MOCK);
writeFileSync(join(TMP, "tauri.mjs"), TAURI_MOCK);
writeFileSync(join(TMP, "backend.mjs"), BACKEND_MOCK);

// The onboarding module, staged whole: `rejoin.ts` reads the stored flow and the
// limits, which means `flow.ts`, which means `models.ts` and `steps.ts`. Only the
// value imports need repointing — `steps.ts`'s sole import of `flow` is
// `import type`, so node's type stripping removes it and it needs no replacement.
stage(ONBOARDING_DIR, "models.ts", []);
stage(ONBOARDING_DIR, "steps.ts", []);
stage(ONBOARDING_DIR, "limits.ts", [['from "./service"', 'from "./service.mjs"']]);
stage(ONBOARDING_DIR, "flow.ts", [
  ['from "./models"', 'from "./models.ts"'],
  ['from "./service"', 'from "./service.mjs"'],
  ['from "./steps"', 'from "./steps.ts"'],
]);
stage(ONBOARDING_DIR, "service.real.ts", [
  ['from "./models"', 'from "./models.ts"'],
  ['from "./service"', 'from "./service.mjs"'],
  ['from "@tauri-apps/api/core"', 'from "./tauri.mjs"'],
]);
stage(CHAT_DIR, "rejoin.ts", [
  ['from "../onboarding/flow"', 'from "./flow.ts"'],
  ['from "../onboarding/limits"', 'from "./limits.ts"'],
  ['from "../onboarding/models"', 'from "./models.ts"'],
  ['from "../onboarding/service"', 'from "./service.mjs"'],
  ['from "./backend"', 'from "./backend.mjs"'],
]);

const { findModel, MODEL_CATALOG } = await import(pathToFileURL(join(TMP, "models.ts")).href);
const { shouldSpawn } = await import(pathToFileURL(join(TMP, "service.real.ts")).href);
const { joinInputs, mayRejoinNow, networkFact } = await import(
  pathToFileURL(join(TMP, "rejoin.ts")).href
);

/* ------------------------------- the fixtures ------------------------------- */

const KEY = "common.onboarding.progress";

/** A machine with no storage and nothing listening: the ordinary starting point. */
beforeEach(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  globalThis.__whoami = undefined;
  globalThis.__seen = undefined;
});

function storing(flow) {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ step: "join", flow }),
    setItem: () => {},
    removeItem: () => {},
  };
}

/** One model out of the real catalogue, so the tests name ids the app actually
 *  ships rather than ids that happen to be right today. */
const CODER = MODEL_CATALOG.full.code;
const MATH_LIGHT = MODEL_CATALOG.light.math;

const CAP = { cpuPercent: 50, gpuPercent: 40 };

function limitsWith(quietHours, contribute = "idle") {
  return { contribute, cap: CAP, quietHours };
}

/** A wall clock on one fixed day, so an assertion about 07:00 is not also an
 *  assertion about the date the suite happens to run on. */
function at(hours, minutes = 0) {
  return new Date(2026, 9, 16, hours, minutes);
}

/* --------------------------- reuse, or start a join --------------------------- */

/** What the gateway says about this machine. `nodeId` non-null with `healthy`
 *  false is the reboot's signature: the identity is still on disk, and the
 *  gateway has stopped being able to reach us. */
function gateway(nodeId, healthy) {
  return {
    joined: nodeId !== null,
    name: nodeId === null ? null : "studio.local",
    nodeId,
    node: nodeId === null ? null : { healthy },
  };
}

const NOTHING_KNOWN = gateway(null, null);

test("the reboot: an identity on disk the gateway cannot reach starts a join", () => {
  // The reported bug, as a rule. `identity.json` survives the reboot, so the node
  // is reclaimable — and it is also why this is worth checking by hand: a guard
  // that read "an identity exists" as "something is serving" would leave the
  // machine off the network with no route back, which is exactly what happened.
  assert.equal(shouldSpawn(gateway("c-9f3a", false), null), true);

  // And the same identity with no gateway entry at all: presence and health are
  // two questions, and neither answers this one.
  assert.equal(shouldSpawn(gateway("c-9f3a", null), null), true);
});

test("a machine the gateway can reach is left alone", () => {
  // The other half of the rule, and the dangerous one: a spawn here puts a second
  // `join.py` on the port the first one is serving from.
  assert.equal(shouldSpawn(gateway("c-9f3a", true), null), false);
});

test("a join this app started is not started again", () => {
  // `running` and `handedOff` are both "ours, and alive". `handedOff` is the one
  // worth spelling out: on Windows the process this app holds is a wrapper that
  // exits as the join *starts*, so a guard that read a clean exit as a death took
  // a live node off the network.
  assert.equal(shouldSpawn(NOTHING_KNOWN, { state: "running" }), false);
  assert.equal(shouldSpawn(NOTHING_KNOWN, { state: "handedOff" }), false);
});

test("a join that has ended, and one that was never started, both start", () => {
  assert.equal(shouldSpawn(NOTHING_KNOWN, { state: "ended", code: "1" }), true);
  assert.equal(shouldSpawn(NOTHING_KNOWN, { state: "none" }), true);
  assert.equal(shouldSpawn(NOTHING_KNOWN, null), true);
});

test("an unreadable process read does not spare a machine that is not serving", () => {
  // `joinState` returns `null` only when this process did start a join and the
  // read then failed. That is not evidence a join is live, so it falls through to
  // the gateway's own answer — and when that is unhealthy too, this spawns. It is
  // the safe direction, because `join.py` reclaims its own node from the token on
  // disk rather than minting a second; the opposite error is a machine that is
  // never started again. Where `null` does mean "do not act" is the retry inside
  // `awaitServing`, which spends an attempt only on a confirmed end.
  assert.equal(shouldSpawn(gateway("c-9f3a", false), null), true);
  assert.equal(shouldSpawn(gateway("c-9f3a", true), null), false);
});

/* ------------------------------- the quiet gate ------------------------------- */

test("no window set is no reason to stay off the network", () => {
  assert.deepEqual(mayRejoinNow(limitsWith(null), at(3)), { allowed: true });
});

test("a window crossing midnight is quiet on both sides of it", () => {
  // The default, and the shape an interval test written the obvious way gets
  // backwards: `start < end` is false here, so a `start <= at && at < end` reads
  // 23:30 as *outside* the window it is plainly inside.
  const night = limitsWith({ start: "22:00", end: "07:00" });

  assert.deepEqual(mayRejoinNow(night, at(23, 30)), { allowed: false, until: "07:00" });
  assert.deepEqual(mayRejoinNow(night, at(3)), { allowed: false, until: "07:00" });
  assert.deepEqual(mayRejoinNow(night, at(22)), { allowed: false, until: "07:00" });
});

test("the ends of the window are the start-inclusive, end-exclusive pair", () => {
  const night = limitsWith({ start: "22:00", end: "07:00" });

  // 07:00 is the moment the machine may start serving again, so it is outside.
  assert.deepEqual(mayRejoinNow(night, at(7)), { allowed: true });
  assert.deepEqual(mayRejoinNow(night, at(6, 59)), { allowed: false, until: "07:00" });
  assert.deepEqual(mayRejoinNow(night, at(21, 59)), { allowed: true });
});

test("a window inside one day is honoured, and the end it names is the user's own clock", () => {
  // `until` is the *stored* end rather than a formatted date, so the sentence on
  // the Settings row shows the clock the user set and not one this app derived.
  const work = limitsWith({ start: "09:00", end: "17:00" });

  assert.deepEqual(mayRejoinNow(work, at(12)), { allowed: false, until: "17:00" });
  assert.deepEqual(mayRejoinNow(work, at(20)), { allowed: true });
  assert.deepEqual(mayRejoinNow(work, at(9)), { allowed: false, until: "17:00" });
});

test("a window with the same end as its start covers nothing", () => {
  // Never quiet, not always quiet. 22:00–22:00 is a user who set a start and left
  // the end alone, and reading it as a 24-hour window would keep the machine off
  // the network forever with no way to notice.
  assert.deepEqual(mayRejoinNow(limitsWith({ start: "22:00", end: "22:00" }), at(22)), {
    allowed: true,
  });
});

test("a clock that is not a clock is not a reason to stay off the network", () => {
  // Storage is a text field that older builds and hand edits have both reached.
  // An unparseable window falls through to allowed, which is the direction that
  // fails towards the machine serving rather than towards it never connecting.
  assert.deepEqual(mayRejoinNow(limitsWith({ start: "25:99", end: "07:00" }), at(3)), {
    allowed: true,
  });
});

test("the plugged-in rule is deliberately not consulted", () => {
  // The decision this feature turned on. `defaultLimits` sets `"plugged-in"` on a
  // machine that is on battery, so gating on it would mean a rebooted, unplugged
  // laptop reports "waiting for the mains" instead of reconnecting — the reported
  // case, unfixed. Nothing enforces these limits anywhere either; `setLimits` says
  // so itself. Quiet hours are honoured because the app can violate those.
  assert.deepEqual(mayRejoinNow(limitsWith(null, "plugged-in"), at(3)), { allowed: true });
  assert.deepEqual(mayRejoinNow(limitsWith(null, "idle"), at(3)), { allowed: true });
});

/* ------------------------- what a reconnect asks for ------------------------- */

test("the stored flow is what a reconnect joins as", async () => {
  storing({ modelId: CODER.id, lane: "math", limits: limitsWith(null, "idle") });
  // A `whoami` that would answer something else, to prove the flow is preferred
  // and the CLI is never asked when the flow resolves.
  globalThis.__whoami = { catalogueId: MATH_LIGHT.id };

  const request = await joinInputs();

  assert.equal(request.modelId, CODER.id);
  assert.equal(request.lane, "code");
  assert.deepEqual(request.limits, limitsWith(null, "idle"));
});

test("the lane comes from the catalogue, never from the stored flow", async () => {
  // The stored `lane` is deliberately wrong here, and the catalogue's answer is
  // the one that must come out. A node filed under a lane it is not serving is
  // routed to on that basis, so a disagreement is not a detail to average.
  storing({ modelId: CODER.id, lane: "math", limits: null });

  const request = await joinInputs();

  assert.equal(request.lane, "code", "the catalogue's lane for this model, not the stored one");
  assert.equal(CODER.lane, "code");
});

test("a flow with no limits gets the same defaults the flow would have started from", async () => {
  storing({ modelId: MATH_LIGHT.id, lane: null, limits: null });

  const request = await joinInputs();

  assert.equal(request.modelId, MATH_LIGHT.id);
  assert.equal(request.lane, "math");
  // No hardware was stored, so nothing is on battery and the default is `idle` —
  // and the quiet window is the app's own default, which the gate then honours.
  assert.equal(request.limits.contribute, "idle");
  assert.deepEqual(request.limits.quietHours, { start: "22:00", end: "07:00" });
});

test("a storage that was cleared is answered by the identity on disk", async () => {
  // A fresh build over a surviving `~/.common-network`: the flow is gone, the node
  // token is not. The reconnect is still worth making, and `whoami` is where the
  // model comes from — this is the case that justifies asking it at all.
  globalThis.__whoami = { catalogueId: CODER.id };

  const request = await joinInputs();

  assert.equal(request.modelId, CODER.id);
  assert.equal(request.lane, "code");
});

test("a model this version does not ship falls back to the registered one", async () => {
  // The catalogue moved under a stored flow — a model dropped from a later build.
  // The node is registered as something this build *does* know, and that is the
  // better answer than nothing.
  storing({ modelId: "qwen-of-a-previous-era", lane: "writing", limits: null });
  globalThis.__whoami = { catalogueId: MATH_LIGHT.id };

  const request = await joinInputs();

  assert.equal(request.modelId, MATH_LIGHT.id);
  assert.equal(request.lane, "math");
});

test("an id nothing recognises is null, not a guess at the nearest lane", async () => {
  // The one refusal. Joining as the wrong lane is worse for the network than not
  // joining, and a default here would be a silent one — so `null` travels up to a
  // sentence on the Settings row instead.
  storing({ modelId: "qwen-of-a-previous-era", lane: "writing", limits: null });
  globalThis.__whoami = { catalogueId: "also-not-in-this-catalogue" };

  assert.equal(await joinInputs(), null);
});

test("no flow and no identity is null", async () => {
  assert.equal(await joinInputs(), null);
});

test("a CLI that will not answer is null rather than a rejection", async () => {
  // `whoami` reaches the CLI through Rust, so it rejects when the tool is not on
  // disk and throws on output that is not JSON. It is being asked a narrow
  // question — is there a registered id to fall back on — and a machine that
  // cannot answer has not got one. Thrown, this would take a whole reconnect down
  // over a fallback that was optional by construction.
  storing({ modelId: "qwen-of-a-previous-era", lane: "writing", limits: null });
  globalThis.__whoami = "throws";

  assert.equal(await joinInputs(), null);
});

/* ------------------------------- what is said ------------------------------- */

test("the reading is the sentence when a reconnect has nothing newer to add", () => {
  assert.equal(networkFact(true, { kind: "idle" }), "The gateway can reach this machine");
  assert.equal(networkFact(false, { kind: "idle" }), "The gateway can't reach this machine right now");
  assert.equal(networkFact(null, { kind: "idle" }), "Checking whether the gateway can see this machine");
  // A reconnect that reached the gateway says the reading it produced, which is
  // the same sentence — the alternative is a row that goes on reporting the
  // failure it has just fixed.
  assert.equal(networkFact(true, { kind: "reached" }), "The gateway can reach this machine");
});

test("the reconnect states are read before the reading underneath them", () => {
  // Otherwise a row would say "can't reach this machine" over a reconnect that is
  // in flight or already back.
  assert.equal(networkFact(false, { kind: "working" }), "Reconnecting this machine to the network.");
  assert.equal(networkFact(false, { kind: "waiting", until: "07:00" }), "Resting until 07:00.");
  // The stored end, verbatim, so the sentence shows the clock the user set.
  assert.equal(
    networkFact(false, { kind: "failed", code: "network", detail: null }),
    "The gateway never listed this machine.",
  );
});

test("a failure on this machine is never reported as a failure of the network", () => {
  // The distinction the join screen is built around, and it has to survive here.
  // "The network didn't answer" about a command-line tool that is not on disk
  // sends the user to inspect a network this machine never used.
  const said = networkFact(false, { kind: "failed", code: "cli-missing", detail: "no such file" });

  assert.match(said, /command-line tool/);
  assert.doesNotMatch(said, /network|gateway/i);
});

test("an unknown code still says something, and does not claim a cause", () => {
  const said = networkFact(false, { kind: "failed", code: "unknown", detail: null });
  assert.equal(said, "Couldn't reconnect.");
});

/* --------------------------------- a reminder --------------------------------- */

test("the catalogue still carries the shapes these tests name", () => {
  // The fixtures are derived from the real catalogue rather than hardcoded so
  // that a model id moving does not fail a test about reconnect logic. This is
  // what keeps that honest: `CODER` must be a full Coder and `MATH_LIGHT` a light
  // Math, or the two tests above that lean on their lanes are testing nothing
  // they meant to.
  assert.equal(CODER.lane, "code");
  assert.equal(CODER.tier, "full");
  assert.equal(MATH_LIGHT.lane, "math");
  assert.equal(MATH_LIGHT.tier, "light");
  assert.equal(findModel(CODER.id), CODER);
});
