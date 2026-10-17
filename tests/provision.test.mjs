/**
 * The one install, pinned.
 *
 * The fetch itself is Rust's and is tested there, against real bytes. What is
 * tested here is the thin layer that decides *whether* to run it and what to say
 * while it does — and every decision in that layer is quiet when it is wrong:
 *
 * — `missingFrom`, which is the difference between one probe per launch and
 *   re-downloading a Python on every machine that already has one. It also has
 *   to separate "absent" from "cannot be installed here", because a payload
 *   blocked on a platform is not a wait, and a machine that waited for one would
 *   sit on a screen until the budget ran out.
 * — The short-circuit in the runner. "An ordinary machine costs one probe and no
 *   requests at all" is a claim, and if it stops being true the cost lands on
 *   every launch of every install, silently.
 * — `preparingSentences`, which is what the join screen shows while it waits for
 *   a machine that is being got ready a long way from that screen. The clause
 *   most likely to be got wrong is the one that has to stop saying "Fetching"
 *   once the bytes are in hand.
 *
 * ── Why the runner is exercised through a cold module ─────────────────────────
 *
 * `startProvisioning` is a singleton on purpose — one machine, one fetch — so a
 * second call in the same module instance joins the first promise and answers
 * nothing new. That is a property worth testing (one of the tests below does)
 * and it is also why the runner tests import the staged source again with a
 * cache-busting query rather than sharing one instance: a singleton tested once
 * is a singleton tested not at all.
 *
 * Run it with: node --test tests/provision.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------------------------------- harness ---------------------------------- */

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const ONBOARDING_DIR = fileURLToPath(new URL("../src/onboarding/", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "provision-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** The Tauri seam, with a `Channel` that can actually be driven.
 *
 *  The bootstrap's events only exist once something sends them, so the mock keeps
 *  every channel it is handed and the tests push events through the one the
 *  runner created. `bootstrap_status` is answered from a global that is either an
 *  array (the same answer every time), a function (a different one per call —
 *  which is what the re-probe after a fetch needs) or the string `"throws"`. */
const TAURI_MOCK = `
export class Channel {
  constructor() {
    (globalThis.__channels ??= []).push(this);
  }
}
export function invoke(command, args) {
  if (command === "bootstrap_status") {
    const answer = globalThis.__status;
    if (answer === "throws") return Promise.reject("no dry run here");
    return Promise.resolve(typeof answer === "function" ? answer() : answer);
  }
  if (command === "bootstrap_run") {
    return Promise.resolve(globalThis.__run(args));
  }
  return Promise.reject(\`nothing is listening for \${command}\`);
}
`;

/** Copy a source into the temp directory, pointing its imports at the copies.
 *  Node wants the extension on a relative specifier; the sources are written for
 *  a bundler, which does not. */
function stage(fromDir, name, replacements) {
  let source = readFileSync(join(fromDir, name), "utf8");
  for (const [from, to] of replacements) source = source.split(from).join(to);
  writeFileSync(join(TMP, name), source);
}

writeFileSync(join(TMP, "tauri.mjs"), TAURI_MOCK);

// Both files are flat in the temp directory, so `provision.ts`'s one value import
// lands on the sibling copy rather than on the onboarding directory.
stage(ONBOARDING_DIR, "copy.ts", []);
stage(SRC_DIR, "provision.ts", [
  ['from "@tauri-apps/api/core"', 'from "./tauri.mjs"'],
  ['from "./onboarding/copy"', 'from "./copy.ts"'],
]);

const PROVISION = pathToFileURL(join(TMP, "provision.ts")).href;

/** A cold instance of the runner. The pure functions do not need one — they are
 *  the same code every time — but the singleton does. */
let generation = 0;
function cold() {
  generation += 1;
  return import(`${PROVISION}?v=${generation}`);
}

const { missingFrom, preparingSentences } = await import(PROVISION);

/* ------------------------------- the fixtures ------------------------------- */

/** A payload as `bootstrap_status` describes it, with everything defaulted to the
 *  uninteresting answer so each test names only the field it is about. */
function payload(over = {}) {
  return {
    payload: "python",
    label: "a Python runtime for the command-line tool",
    version: "3.12.15",
    url: "https://example.invalid/python.tar.gz",
    present: false,
    detail: "",
    blocked: null,
    checksum: "pinned",
    ...over,
  };
}

const PYTHON = payload();
const TUNNEL = payload({
  payload: "cloudflared",
  label: "the tunnel that lets this machine be reached",
  version: "2026.10.1",
});

/** A machine with nothing missing, nothing listening and no channels yet. The
 *  tests that want a fetch call `arrivesWith` or set `__status` themselves, so
 *  the default is the ordinary machine and the interesting one has to be asked
 *  for by name. */
beforeEach(() => {
  globalThis.__status = [PYTHON, TUNNEL].map((one) => ({ ...one, present: true }));
  globalThis.__channels = [];
  globalThis.__run = () => {};
});

/** A machine missing these payloads on the first ask, and holding them on every
 *  ask after it — which is what the re-probe at the end of a fetch sees, and the
 *  only way to tell "the machine still cannot run a join" apart from "the fetch
 *  worked". */
function arrivesWith(...names) {
  const absent = new Set(names);
  let asked = 0;
  globalThis.__status = () => {
    asked += 1;
    return [PYTHON, TUNNEL].map((one) => ({
      ...one,
      present: !absent.has(one.payload) || asked > 1,
    }));
  };
}

/* ------------------------------- what is missing ------------------------------- */

test("a payload that is already on the machine is not missing", () => {
  assert.deepEqual(missingFrom([{ ...PYTHON, present: true }]), []);
});

test("one that is absent and installable is", () => {
  assert.deepEqual(missingFrom([PYTHON]).map((one) => one.payload), ["python"]);
});

test("one the app cannot install here is not, however absent it is", () => {
  // A platform with nothing published for it. Reading this as a wait would hold
  // the join screen open for a download that is never going to start.
  assert.deepEqual(missingFrom([{ ...PYTHON, blocked: "no build for this platform" }]), []);
});

test("an empty reason is not a block", () => {
  // The field is `Option<String>` and arrives as `null`, so an empty string is
  // already an anomaly — and between an unnecessary download that reports itself
  // and a machine quietly deciding not to try, this is the harmless reading.
  assert.deepEqual(missingFrom([{ ...PYTHON, blocked: "" }]).map((one) => one.payload), ["python"]);
});

test("nor is a field that arrived missing altogether", () => {
  const { blocked, ...without } = PYTHON;
  assert.deepEqual(missingFrom([without]).map((one) => one.payload), ["python"]);
});

test("the order the machine listed them in is kept", () => {
  const order = [TUNNEL, PYTHON].map((one) => one.payload);
  assert.deepEqual(missingFrom([TUNNEL, PYTHON]).map((one) => one.payload), order);
});

/* --------------------------------- what is said --------------------------------- */

test("a transfer with a total reads as a fraction of it", () => {
  const { statement, caption } = preparingSentences({
    kind: "working",
    step: "download",
    label: "a Python runtime for the command-line tool",
    receivedBytes: 12_000_000,
    totalBytes: 30_000_000,
  });
  assert.equal(statement, "Getting this machine ready.");
  assert.deepEqual(caption, [
    "Fetching a Python runtime for the command-line tool",
    "12 of 30 MB",
  ]);
});

test("a transfer with no total says how much has arrived rather than nothing", () => {
  // The far side has not sent a length. `DownloadModel` makes the same call for
  // the same reason: a bar with no end is worse than a sentence with a number in
  // it, and silence here is a screen that looks hung.
  const { caption } = preparingSentences({
    kind: "working",
    step: "download",
    label: "the tunnel that lets this machine be reached",
    receivedBytes: 4_000_000,
    totalBytes: null,
  });
  assert.deepEqual(caption, ["Fetching the tunnel that lets this machine be reached", "4 MB downloaded"]);
});

test("verifying stops saying it is fetching", () => {
  // The bytes are in hand. A caption that went on saying "Fetching" would be
  // describing a finished download as a running one.
  const { caption } = preparingSentences({
    kind: "working",
    step: "verify",
    label: "a Python runtime for the command-line tool",
    receivedBytes: 30_000_000,
    totalBytes: 30_000_000,
  });
  assert.deepEqual(caption, ["Checking a Python runtime for the command-line tool", "Making sure it arrived whole"]);
});

test("installing says so too", () => {
  const { caption } = preparingSentences({
    kind: "working",
    step: "install",
    label: "the tunnel that lets this machine be reached",
    receivedBytes: 19_000_000,
    totalBytes: 19_000_000,
  });
  assert.deepEqual(caption, ["Installing the tunnel that lets this machine be reached", "Putting it in place"]);
});

test("every state has a sentence, and the failed one does not promise a wait", () => {
  const states = [
    { kind: "idle" },
    { kind: "checking" },
    { kind: "ready" },
    { kind: "failed", message: "no network" },
  ];
  for (const state of states) {
    const { statement, caption } = preparingSentences(state);
    assert.equal(typeof statement, "string");
    assert.ok(statement.length > 0, `${state.kind} has no statement`);
    assert.ok(caption.every((line) => typeof line === "string"), `${state.kind} has an empty caption`);
  }
});

/* -------------------------------- the runner -------------------------------- */

/** Drive the runner: start it, collect every state it publishes, and wait for it
 *  to settle. Returns the states in order and the final one. */
async function drive(module, events = []) {
  globalThis.__run = (args) => {
    for (const event of events) args.onEvent.onmessage(event);
  };
  const seen = [];
  const settled = module.startProvisioning();
  // Subscribed after the call, which is a deliberate and safe ordering: the first
  // state is published synchronously before the runner's first `await`, so it is
  // read from `provisionNow` rather than missed.
  seen.push(module.provisionNow());
  const stop = module.watchProvision((next) => seen.push(next));
  const final = await settled;
  stop();
  return { seen, final };
}

test("a machine that has everything asks for nothing", async () => {
  // The load-bearing test in this file. If the dry run stops short-circuiting,
  // every launch of every install re-probes and possibly re-fetches, and nothing
  // on screen would ever say so.
  const module = await cold();
  let ran = 0;
  globalThis.__run = () => {
    ran += 1;
  };

  const settled = await module.startProvisioning();

  assert.equal(ran, 0, "the fetch was run on a machine that needed nothing");
  assert.equal(settled.kind, "ready");
  assert.deepEqual(
    globalThis.__channels.filter((one) => one.onmessage !== undefined),
    [],
    "a channel was created and no events could have been sent through it",
  );
});

test("a dry run that will not answer is not read as a machine that is missing things", async () => {
  // The command refuses outside the app, which is how these screens are reviewed
  // in a browser. Refusing is not evidence that a fetch is needed.
  const module = await cold();
  globalThis.__status = "throws";
  let ran = 0;
  globalThis.__run = () => {
    ran += 1;
  };

  const settled = await module.startProvisioning();

  assert.equal(ran, 0);
  assert.equal(settled.kind, "ready");
});

test("what is missing is fetched with no payload named, so the installed ones cost a probe", async () => {
  const module = await cold();
  arrivesWith("python");
  const asked = [];
  globalThis.__run = (args) => {
    asked.push(args);
  };

  await module.startProvisioning();

  assert.equal(asked.length, 1);
  assert.equal(asked[0].only, null);
  assert.ok(asked[0].onEvent, "the run was given nowhere to report");
});

test("the state follows the events, with the label from the dry run", async () => {
  const module = await cold();
  const events = [
    { kind: "checking", payload: "python", label: PYTHON.label },
    { kind: "downloading", payload: "python", received: 1_000_000, total: 30_000_000 },
    { kind: "downloading", payload: "python", received: 30_000_000, total: 30_000_000 },
    { kind: "verifying", payload: "python" },
    { kind: "installing", payload: "python" },
    { kind: "installed", payload: "python", detail: "3.12.15" },
    { kind: "done", present: 1, installed: 1, unavailable: 0, failed: 0 },
  ];
  // And the machine has it afterwards, which is what the answer is derived from.
  arrivesWith("python");

  const { seen, final } = await drive(module, events);

  assert.equal(final.kind, "ready");
  // One `checking` from the runner itself, then one state per event that carries
  // one: `installed` and `done` carry none of their own.
  assert.deepEqual(
    seen.map((one) => one.kind),
    ["checking", "working", "working", "working", "working", "working", "ready"],
  );
  // The middle two are the ones with something to look at: a total to divide by,
  // and then — one event later, when the bytes are in hand — the same numbers
  // under a verb that no longer says they are still coming.
  assert.deepEqual(seen[2], {
    kind: "working",
    step: "download",
    label: PYTHON.label,
    receivedBytes: 1_000_000,
    totalBytes: 30_000_000,
  });
  assert.deepEqual(seen[4], {
    kind: "working",
    step: "verify",
    label: PYTHON.label,
    receivedBytes: 30_000_000,
    totalBytes: 30_000_000,
  });
  assert.equal(seen[5].step, "install");
});

test("a payload the run could not install leaves the machine failed, in its own words", async () => {
  const module = await cold();
  const events = [
    { kind: "checking", payload: "python", label: PYTHON.label },
    { kind: "failed", payload: "python", message: "the download did not match its published checksum" },
    { kind: "done", present: 1, installed: 0, unavailable: 0, failed: 1 },
  ];
  // Still not there, so the second probe is what says so — the stream's own
  // counts are not used, and this is the test that would catch it if they were.
  globalThis.__status = [PYTHON, { ...TUNNEL, present: true }];

  const { final } = await drive(module, events);

  assert.equal(final.kind, "failed");
  assert.equal(final.message, "the download did not match its published checksum");
});

test("a payload that is absent after a successful-looking run is still a failure", async () => {
  // The case the counts cannot see: the run reported `done` with nothing failed,
  // and the machine still cannot run a join. Asked rather than totalled.
  const module = await cold();
  const events = [{ kind: "done", present: 0, installed: 0, unavailable: 2, failed: 0 }];
  globalThis.__status = [PYTHON, { ...TUNNEL, present: true }];

  const { final } = await drive(module, events);

  assert.equal(final.kind, "failed");
  // No payload ever said why, so the message is built from what is left.
  assert.match(final.message, /Python/);
});

test("a run that throws fails without inventing a message when one was given", async () => {
  const module = await cold();
  const events = [
    { kind: "failed", payload: "cloudflared", message: "the tunnel did not install" },
  ];
  globalThis.__status = [PYTHON, TUNNEL];
  globalThis.__run = (args) => {
    for (const event of events) args.onEvent.onmessage(event);
    throw "the bootstrap was poisoned";
  };

  const final = await module.startProvisioning();

  assert.equal(final.kind, "failed");
  assert.equal(final.message, "the tunnel did not install");
});

test("a run that throws with nothing to say still says something", async () => {
  const module = await cold();
  globalThis.__status = [PYTHON, TUNNEL];
  globalThis.__run = () => {
    throw "the bootstrap was poisoned";
  };

  const final = await module.startProvisioning();

  assert.equal(final.kind, "failed");
  assert.equal(final.message, "the bootstrap was poisoned");
});

test("two callers share one fetch", async () => {
  // The launch and the join both ask, and React StrictMode mounts the launch
  // effect twice. A second fetch would be a second `curl` racing the first into
  // the same staging directory.
  const module = await cold();
  arrivesWith("python");
  let ran = 0;
  globalThis.__run = () => {
    ran += 1;
  };

  const [first, second] = await Promise.all([
    module.startProvisioning(),
    module.startProvisioning(),
  ]);

  assert.equal(ran, 1, "the machine was fetched twice");
  assert.equal(first, second, "the two callers got different answers");
});

test("a watcher that has stopped watching is not called again", async () => {
  // The screen unmounts; the fetch does not. A publisher that kept the callback
  // would be holding a dead component's setter for the life of the process.
  const module = await cold();
  const seen = [];
  const stop = module.watchProvision((next) => seen.push(next));
  stop();
  await drive(module, [{ kind: "done", present: 2, installed: 0, unavailable: 0, failed: 0 }]);
  assert.deepEqual(seen, []);
});
