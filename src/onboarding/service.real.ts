import { invoke } from "@tauri-apps/api/core";

import { provisionNow, startProvisioning } from "../provision";
import {
  LADDER_REQUIREMENTS,
  TIERS,
  fitsHere,
  largestFitting,
  modelFor,
  tierFor,
  type ModelRequirement,
  type Requirements,
} from "./models";
import {
  OnboardingError,
  type EnsureJoinedResult,
  type HardwareReport,
  type JoinProgress,
  type JoinRequest,
  type JoinResult,
  type ModelOption,
  type ModelSuggestion,
  type OnboardingErrorCode,
  type OnboardingService,
  type Platform,
  type PowerSource,
  type ProgressOptions,
  type ResourceLimits,
  type ScanProgress,
  type Task,
} from "./service";

/**
 * The real backend.
 *
 * One process on this machine, and nothing else. Everything the flow needs
 * already exists here, so this file is mostly translation:
 *
 * — **`common`**, the installed CLI, reached through the Rust seam in
 *   `src-tauri/src/backend.rs`. Nothing is reimplemented: the gateway's opinion
 *   of what the network is short of, of who this machine is, and of whether it
 *   can be reached are all `common --json <verb>` read verbatim. A fix to the
 *   CLI is a fix to the app.
 *
 * — **`llama-server`**, which that CLI starts and talks to on loopback at
 *   127.0.0.1:11436. This file never addresses it directly. The model load and
 *   the test prompt are join phases, and the weights are fetched by the join's
 *   own runtime, so there is no second process here for this file to reach into.
 *
 * There was one. Ollama sat at 11434 and owned the model download, and the
 * paragraphs that used to stand here were all about it: CORS, the `Origin` a
 * page's fetch carries, the Windows webview's `http://tauri.localhost` origin
 * that ollama's allowlist does not hold, and why the pull therefore went through
 * Rust while the two reads beside it stayed in the page. That reasoning is gone
 * with the daemon, and so is the CSP line it argued for.
 *
 * What it bought is worth keeping, and is kept. The progress was the fetcher's
 * own account rather than this app's guess, which is still true — the CLI's
 * runtime prints its byte counts to the join's log, and this file reads those
 * lines back and reports them unparsed as `JoinProgress.fetch`.
 *
 * ── The two honest gaps ───────────────────────────────────────────────────────
 *
 * `setLimits` has no counterpart anywhere. The Alpha's own `config` carries a
 * gateway and a region and nothing about CPU, GPU or quiet hours, and `common`
 * has no verb that would take them. So the clamp is this file's and the storing
 * is the flow's; what is written here is a decision this machine has made about
 * itself, not a fact the network has been told. That is said plainly in the
 * returned value's own comment rather than dressed up as a write.
 *
 * `publicKeyFingerprint` has no source. The Alpha issues a bearer token — the
 * `node_token` in `identity.json` — and never a keypair, so there is no
 * fingerprint to show and inventing six hex pairs would be a fabrication on the
 * one screen that is meant to be proof. It comes back as an empty string. If a
 * keypair ever lands, the field is already here waiting for it.
 *
 * ── The third gap, which is not this file's ───────────────────────────────────
 *
 * This module assumes it is running inside the app. `service.ts` is what
 * guarantees that: it picks this implementation when Tauri's own marker is on
 * `window` and the stub when it is not, because a page in a browser has no
 * `invoke` and no ollama and should be reviewable anyway.
 */

/* ---------------------------------- plumbing ---------------------------------- */

/** A JSON object as it actually arrives: untyped, and possibly not an object at
 *  all. Every reader below starts here rather than trusting a cast, because
 *  these documents come from a CLI and a daemon that are both free to change. */
type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Json, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readNumber(source: Json, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The raw text of a failure, as a string.
 *
 * A Rust command rejects with the `String` it was written with, so the common
 * case is a string rather than an `Error`. Both are flattened to one line:
 * this ends up in the caption under the sentence, and a stack trace there is
 * not a disclosure, it is noise.
 */
function reason(from: unknown): string {
  let text: string;
  if (typeof from === "string") text = from;
  else if (from instanceof Error) text = from.message;
  else if (isJson(from) && typeof from.message === "string") text = from.message;
  else text = String(from);
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Which of the contract's codes a piece of raw text means.
 *
 * Ordered, because the patterns overlap: a permission failure inside a disk
 * check should be reported as the permission failure, since that is the one
 * the user can do something about, and "no space left on device" is the one
 * they cannot fix by granting access. Disk and permission come first for that
 * reason; the rest are unambiguous.
 *
 * This is a classifier over text written for humans, which is a weak thing to
 * be. It is worth it here because the alternative is `unknown` for every
 * failure, and `unknown` is the one code with no sentence on any screen.
 */
function classify(message: string): OnboardingErrorCode {
  const text = message.toLowerCase();
  // Ahead of the rest, because this one is *written* rather than inferred: the
  // Rust side gives a missing CLI a sentence of its own — the spawn in
  // `network_join` — so it is matched on those words rather than guessed at from
  // a syscall. It has to come before the rules below, which would otherwise file
  // it as something the user cannot act on.
  if (/command-line tool/.test(text)) return "cli-missing";
  if (/no space left|not enough (disk )?space|enospc|insufficient disk|disk quota/.test(text)) {
    return "insufficient-disk";
  }
  if (/permission denied|operation not permitted|eperm|eacces|not authorised|not authorized/.test(text)) {
    return "permission-denied";
  }
  if (/timed out|timeout|deadline exceeded|took too long/.test(text)) return "timeout";
  // A bare `not found` used to sit here, and it was a trap. The Windows wrapper
  // in `~/.common-network/bin/common.cmd` printed a false "python not found on
  // PATH" whenever its interpreter chain fell through, so a join that failed for
  // any reason at all — an unreachable peer, a bad argument — was filed as a
  // missing model and the screen blamed the catalogue. A model that is really
  // absent names itself, so require the word.
  if (/unknown model|no such model|model not found|does not exist|\b404\b/.test(text)) {
    return "not-found";
  }
  // A 5xx is the gateway failing, and 500 as much as 502, 503 and 504 — the bare
  // `500` used to be the one code of the four that fell through to `unknown`, which
  // is the only code with no sentence on a screen. A self-trial's setup died on a
  // live 500 from `/catalogue` and would have been reported as "something went
  // wrong", which names neither the machine nor the network and so points at
  // nothing the user can do.
  if (
    /could not resolve|nodename nor servname|connection refused|network is unreachable|no route to host|can't reach|cannot reach|unreachable|offline|tls|certificate|bad gateway|\b50[0234]\b|eof|failed to fetch|load failed/.test(
      text,
    )
  ) {
    return "network";
  }
  return "unknown";
}

/** What an unhandled rejection of this code would print. The screens do not
 *  read it — they switch on `code` and show `detail` — so this exists for the
 *  console and for anyone reading a log, and is deliberately one plain line. */
const SENTENCE: Record<OnboardingErrorCode, string> = {
  unsupported: "This machine can't be used.",
  "permission-denied": "The system refused that.",
  network: "Nothing came back.",
  "cli-missing": "Common's command-line tool couldn't be started.",
  "join-stopped": "The join didn't get through.",
  "insufficient-disk": "There isn't enough room.",
  "not-found": "That model isn't available.",
  timeout: "That took too long.",
  cancelled: "Stopped.",
  unknown: "Something went wrong.",
};

/** A failure from somewhere other than this file, wearing this file's shape. An
 *  `OnboardingError` already passing through is returned untouched — it knows
 *  its own code, and re-classifying its message would only be able to lose
 *  information. */
function asError(from: unknown): OnboardingError {
  if (from instanceof OnboardingError) return from;
  const detail = reason(from);
  const code = classify(detail);
  return new OnboardingError(code, SENTENCE[code], detail || undefined);
}

/** The one error a user's own stop produces. Built fresh each time so that it
 *  carries its own stack rather than the stack of whoever first asked. */
function stopped(message: string): OnboardingError {
  return new OnboardingError("cancelled", message);
}

/** What running work is handed so it can stop early. Read, never reset: a
 *  cancellation is one-way, which is what makes it safe to poll. */
interface Signal {
  readonly cancelled: boolean;
}

/**
 * One started operation.
 *
 * `Promise.race` against a rejection that only a `cancel()` can fire, which
 * gives cancellation the two properties the contract asks for without any of
 * the work having to know about it: it lands immediately rather than at the
 * next thing the work happens to check, and it is idempotent because the racing
 * promise settles once.
 *
 * The work still sees `signal.cancelled` and is expected to use it — a scan that
 * has three more `invoke`s to make should not make them — but nothing depends on
 * it doing so. The race is the guarantee; the flag is the courtesy.
 */
function start<T>(work: (signal: Signal) => Promise<T>): Task<T> {
  let cancelled = false;
  let settled = false;
  let halt!: (error: OnboardingError) => void;
  const halted = new Promise<never>((_, reject) => {
    halt = reject;
  });

  const result = Promise.race([work({ get cancelled() { return cancelled; } }), halted]).then(
    (value: T) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw asError(error);
    },
  );

  return {
    result,
    cancel() {
      if (cancelled || settled) return;
      cancelled = true;
      halt(stopped("Stopped."));
    },
  };
}

/** A read that failed, as a value rather than as a rejection. The contract says
 *  one refused probe costs the user one field, never the screen, so the failure
 *  has to be able to travel alongside the successes. */
type Read<T> = { ok: true; value: T } | { ok: false; detail: string };

async function read<T>(command: string, args?: Json): Promise<Read<T>> {
  try {
    return { ok: true, value: (await invoke(command, args)) as T };
  } catch (from) {
    return { ok: false, detail: reason(from) };
  }
}

function asPlatform(value: string): Platform | null {
  return value === "macos" || value === "windows" || value === "linux" ? value : null;
}

function asPowerSource(value: string): PowerSource {
  return value === "battery" || value === "mains" ? value : "unknown";
}

/* -------------------------------- the readings -------------------------------- */

/**
 * Read this machine, one field at a time.
 *
 * The order is deliberate. The platform goes first because it is the only read
 * that cannot fail and the only one that can make the other four pointless —
 * there is no point shelling out to `pmset` on a machine that cannot be onboarded
 * at all. Each of the other four announces itself immediately before it runs, so
 * the screen's caption is about the read that is actually in flight rather than
 * about the read it last finished.
 *
 * A failed read is `null` in its field. Only the platform rejects, and only
 * because a machine that cannot be read is a machine this flow has nothing to
 * say to.
 */
function scanHardware(opts?: ProgressOptions<ScanProgress>): Task<HardwareReport> {
  return start(async (signal) => {
    const os = await read<{ platform: string; version: string }>("read_os");
    if (!os.ok) {
      throw new OnboardingError("unsupported", SENTENCE.unsupported, os.detail);
    }
    const platform = asPlatform(os.value.platform);
    if (platform === null) {
      throw new OnboardingError(
        "unsupported",
        SENTENCE.unsupported,
        `${os.value.platform} isn't a platform this flow can set up`,
      );
    }

    /** Between reads, and only between them: a read already in flight is left to
     *  finish, because its answer is a real answer and the cost of collecting it
     *  is already paid. */
    const next = (field: ScanProgress["field"]) => {
      if (signal.cancelled) throw stopped("Stopped.");
      opts?.onProgress?.({ field });
    };

    next("memory");
    const memory = await read<{ totalBytes: number }>("read_memory");
    next("graphics");
    const graphics = await read<{
      vendor: string;
      name: string;
      vramBytes: number | null;
      unified: boolean;
    }>("read_graphics");
    next("disk");
    // The volume the weights and the partial file will land on, which is the one
    // that matters: a machine with a roomy external disk and a full boot volume
    // has no room for a model.
    const disk = await read<{ freeBytes: number; totalBytes: number; path: string }>("read_disk", {
      path: "/",
    });
    next("power");
    const power = await read<{ source: string; batteryPercent: number | null }>("read_power");

    return {
      memory: memory.ok ? { totalBytes: memory.value.totalBytes } : null,
      graphics: graphics.ok ? graphics.value : null,
      disk: disk.ok ? disk.value : null,
      power: power.ok
        ? { source: asPowerSource(power.value.source), batteryPercent: power.value.batteryPercent }
        : null,
      os: { platform, version: os.value.version },
    };
  });
}

/* ------------------------------- the model choice ------------------------------- */

/**
 * What this machine should run.
 *
 * The whole recommendation, and it is about this machine alone. The catalogue is
 * still consulted — `ladderRequirements` reads the network's own `min_ram_gb`, so a
 * floor that moves there moves the fit with it — but it is consulted for figures
 * and not for an opinion. There used to be a second half to this: the gateway's gap
 * table decided which lane was worth joining, and that overrode the machine's own
 * answer when the two disagreed. It cannot any more, and the reason is the
 * catalogue rather than the protocol — with one family at four sizes there is
 * nothing for the network to choose between, because every machine that joins is
 * running the same weights at a different size. Asking would be asking a question
 * with one answer in it.
 *
 * What is left is the catalogue's own argument, which is about memory: run the
 * largest rung this machine carries with headroom, and the floor of the ladder when
 * it carries none. `tierFor` answers that from the table; this recomputes it
 * against the live figures so the two cannot disagree, and reports `fits`
 * separately so the screen can tell "the biggest that is comfortable" apart from
 * "the floor, at a squeeze". Those are two different sentences and a machine on the
 * edge is owed the second one.
 *
 * The one rejection is a machine whose memory could not be read: without it there is
 * no rung to name, and no amount of network will supply the figure. That is
 * `permission-denied` rather than `unknown` because the screen offers hand-entry for
 * it, and hand-entry is a real fix for exactly this.
 */
function suggestModel(report: HardwareReport): Task<ModelSuggestion> {
  return start(async () => {
    const memory = report.memory?.totalBytes;
    if (memory === undefined) {
      throw new OnboardingError(
        "permission-denied",
        "The system wouldn't say how much memory there is.",
        "no memory figure, so no rung of the ladder to fit",
      );
    }

    // The fit is worth computing against the network's own figures rather than
    // against a copy of them, which is the one thing the gateway is still asked
    // for here.
    const requirements = await ladderRequirements();

    const options: readonly ModelOption[] = TIERS.map((tier) => {
      const model = modelFor(tier);
      return { model, fits: fitsHere(model.id, report, requirements) };
    });

    // `null` from `largestFitting` is "nothing fits comfortably", and the answer is
    // then the floor of the ladder rather than a refusal: a 2 GB machine is still a
    // machine the network would rather have on the 2B than not have at all, and the
    // catalogue's floor exists for exactly it. `fits: false` is what stops that
    // from being dressed up as a recommendation.
    const comfortable = largestFitting(report, requirements);
    const model = modelFor(comfortable ?? tierFor(memory));

    return { model, fits: comfortable !== null, options };
  });
}


/**
 * The catalogue's requirements for the ladder, as the network currently spells
 * them, or the table in `models.ts` when the catalogue cannot be reached.
 *
 * Read live rather than committed, for the reason this file reads anything live:
 * the network's catalogue is the authority on what a model needs — it is the
 * document `common join` and the gateway's `/assign` both read — and a `min_ram_gb`
 * that moves there must move the app's answer with it. The table stands in when
 * there is no gateway, no CLI or no parse, so an offline machine still gets a fit
 * rather than no fit.
 *
 * Never rejects, like every other read here: this decides a caption, and a
 * caption is not worth failing a screen over. Only the ladder's four ids are read,
 * because the catalogue's other entries are models this app's ladder does not
 * carry and a requirement for one of those is a requirement for nothing.
 *
 * Field by field against the table, so a catalogue entry that has grown a new
 * shape loses the fields it no longer carries and keeps the ones it still does.
 */
async function ladderRequirements(): Promise<Requirements> {
  let raw: string;
  try {
    raw = await invoke<string>("network_catalogue");
  } catch {
    return LADDER_REQUIREMENTS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return LADDER_REQUIREMENTS;
  }
  if (!Array.isArray(parsed)) return LADDER_REQUIREMENTS;

  const found: Record<string, ModelRequirement> = { ...LADDER_REQUIREMENTS };
  for (const entry of parsed) {
    if (!isJson(entry)) continue;
    const id = readString(entry, "id");
    if (id === null) continue;
    const known = LADDER_REQUIREMENTS[id];
    if (known === undefined) continue;
    const gpu = entry["needs_gpu"];
    found[id] = {
      minRamGb: readNumber(entry, "min_ram_gb") ?? known.minRamGb,
      needsGpu: typeof gpu === "boolean" ? gpu : known.needsGpu,
      minVramGb: readNumber(entry, "min_vram_gb") ?? known.minVramGb,
    };
  }
  return found;
}

/* --------------------------------- the limits --------------------------------- */

/** The narrowest a cap may be set to, and the widest, in percent. A cap of zero
 *  is not a setting, it is a leave, and a leave has its own control. */
const CAP_FLOOR = 5;
const CAP_CEILING = 100;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Math.round(value)));

/**
 * Write the contribution limits. Returns what was stored.
 *
 * ── There is nowhere to write them ────────────────────────────────────────────
 *
 * Worth saying plainly rather than burying: the backend has no counterpart for
 * any of this. The Alpha's own `config` holds a gateway and a region and nothing
 * about CPU, GPU or quiet hours, `common` has no verb that would take them, and
 * so nothing here is sent anywhere. What this returns is the shape the app has
 * decided to hold its own preferences in, clamped, and the flow is what keeps
 * it — `flow.limits` and the settings card's own record.
 *
 * That is not nothing. The clamping is real and has to happen somewhere, the
 * return-what-you-stored rule is the contract's and is honoured, and when a
 * backend verb lands this function gains three lines and everything above it
 * stays exactly as it is.
 */
function setLimits(limits: ResourceLimits): Task<ResourceLimits> {
  return start(async () => ({
    contribute: limits.contribute,
    cap: {
      cpuPercent: clamp(limits.cap.cpuPercent, CAP_FLOOR, CAP_CEILING),
      gpuPercent: clamp(limits.cap.gpuPercent, CAP_FLOOR, CAP_CEILING),
    },
    // Quiet hours are passed through unvalidated on purpose: "HH:MM" is the
    // contract's own format, the time fields that produce them are the app's, and
    // a window that crosses midnight is the normal case rather than a mistake to
    // be corrected.
    quietHours: limits.quietHours,
  }));
}

/* ---------------------------------- the join ---------------------------------- */

/**
 * The question the model is asked to prove it answers.
 *
 * Chosen by measurement, not by taste. It has one right answer, so the screen can
 * be believed at a glance; it is short, so a small model says it in one line
 * rather than a paragraph; and it is answerable by the smallest rung of the
 * ladder as readily as the largest, so a failure here is the model not running
 * rather than the model being small. The arithmetic question the stub uses fails
 * all three — a 1B model answered 17 × 24 as 408 once and 406 the next time, which
 * is a test that cannot tell a working model from a broken one.
 */
const TEST_PROMPT = "What is the capital of France?";

/** What the gateway's own view of this machine looks like, narrowed to the
 *  fields anything here reads. `null` for anything that does not parse: every
 *  caller of this treats an unreadable status as "not registered", which is the
 *  safe direction — it costs a redundant join, never a wrong node. */
export interface Status {
  joined: boolean;
  name: string | null;
  nodeId: string | null;
  /** The gateway's own entry for this machine, out of the node list it serves —
   *  `null` when it has no entry at all, which is the one reading that means this
   *  machine is not registered, from over there. Presence and reachability are two
   *  different questions and this object is where both are answered: the entry
   *  exists once the gateway has the node, and `healthy` is true only once the
   *  gateway's own health check has passed against it. */
  node: { healthy: boolean } | null;
}

async function status(): Promise<Status> {
  const none: Status = { joined: false, name: null, nodeId: null, node: null };
  let raw: string;
  try {
    raw = await invoke<string>("network_status");
  } catch {
    return none;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!isJson(parsed)) return none;

  const identity = isJson(parsed.identity) ? parsed.identity : null;
  const node = isJson(parsed.node) ? parsed.node : null;
  return {
    joined: parsed.joined === true,
    name: identity === null ? null : readString(identity, "name"),
    nodeId: identity === null ? null : readString(identity, "node_id"),
    // `healthy` must be exactly true. A node the gateway still lists but has
    // stopped being able to reach is the case this whole field exists for, and
    // reading presence as health would put the green screen on a machine nobody
    // can route to.
    node: node === null ? null : { healthy: node.healthy === true },
  };
}

/** The join this app started, if it is still going.
 *
 * `common join` does not return — it replaces itself with `join.py`, which
 * pulls, serves and then loops for as long as the machine is contributing — so
 * whether it is still working is a question about a process and not about a
 * file. The handle that answers it lives in Rust, because the answer differs by
 * platform and the platform is known there; what is kept here is only the fact
 * that an attempt was made, so that a second call to `joinNetwork` is a retry and
 * not a second node. */
let joined = false;

/** Where in `join.log` the join this app started began writing — the byte offset
 *  `network_join` measures as it spawns it. `null` until an attempt is made.
 *
 *  Held for the same reason `joined` is, and against the same kind of error. The log
 *  is appended to across attempts *and across runs*, so its tail is not this attempt's
 *  tail: read without an offset it would be free to hand back the `✗` of a join that
 *  died an hour ago and offer it as the reason this one never arrived. The offset is
 *  what confines the read to the words this attempt wrote. */
let joinStart: number | null = null;

/** What became of the join this app started, as `backend.rs` reads it. */
export type JoinState =
  | { state: "none" }
  | { state: "running" }
  | { state: "handedOff" }
  | { state: "ended"; code: string };

/** How many times a join that died young is started again before the flow gives
 *  up on it.
 *
 *  Three, because the failure being retried is a coin flip rather than a broken
 *  thing: `join.py` gives its catalogue fetch ten seconds and the gateway has
 *  been measured at eight, so one loss is ordinary and three in a row is
 *  evidence. Only a *confirmed* end spends an attempt — see the wait in
 *  `joinNetwork` — so a slow join is never cut short by this, and the attempts
 *  are spread over a dying join's twelve seconds rather than the whole budget.
 *
 *  What a "confirmed end" is depends on the platform, which is the thing worth
 *  being careful about here: on Windows it can only ever be a wrapper that failed
 *  to hand off. A join that starts and then dies out there is not something this
 *  machine can see, so it is not retried — it is waited on, and then reported. */
const MAX_JOIN_ATTEMPTS = 3;

/** What the join this app started is doing — `null` when the read itself failed.
 *
 *  `null` and `{ state: "ended" }` are deliberately different answers, and
 *  conflating them is the mistake this function replaced. A read that failed is
 *  not knowledge of an end, and treating it as one spends a retry on a join that
 *  may be working — which puts a second `join.py` on the worker's port. The end
 *  this is built to notice is a *confirmed* one.
 *
 *  Which of the four states mean what is the platform's business, and is settled
 *  where the platform is known: `finished` in `backend.rs`, which is also where the
 *  reason `handedOff` exists at all is written down. On Windows the program this app
 *  holds is a batch wrapper that hands off and leaves, so a clean exit there is the
 *  ordinary way a join *starts* — read as a death, it took a friend's live node off
 *  the network and put "the network didn't answer" on screen about it. */
async function joinState(): Promise<JoinState | null> {
  // Nothing was started, so Rust has no handle to ask about. Answered here rather
  // than as `null`, because the two are read differently: this one may spawn, and
  // `null` may not.
  if (!joined) return { state: "none" };
  try {
    return await invoke<JoinState>("network_join_state");
  } catch {
    // The read, not the process. See above: not knowing is not knowing it stopped.
    return null;
  }
}

/** Start one `common join`, and keep nothing of it but the fact that it started.
 *
 *  A function rather than the one block it used to be, because the retry path
 *  starts it again after a death. `join.py` reclaims its own node from the token
 *  in `identity.json` rather than minting a second one, so a second attempt is
 *  this machine re-registering and not a duplicate node — which is the same
 *  reason the guard before it is allowed to spawn at all. */
/**
 * Whether this machine has to start a join, or is already serving one.
 *
 * The one rule the whole feature rests on, and the reason it is a named function
 * rather than a line inside `awaitServing`: getting it wrong puts a second
 * `join.py` on the worker's port, and the two ways of getting it wrong are both
 * quiet. Read a live join as ended and a working node is restarted underneath
 * itself; read a dead one as live and a machine that is not serving is never
 * started again. `tests/rejoin.test.mjs` pins it against this source rather than
 * against a copy, so the rule cannot drift while the test goes on passing.
 *
 * The first clause asks *for a state* rather than for the absence of `"ended"`,
 * which is the whole of why `handedOff` and `running` count and `none` does not.
 *
 * `start === null` is "the process read failed" — `joinState` returns it only
 * when this process did start something and the read then threw — and the answer
 * there is spawn, decided by the second clause alone: a failed read cannot show a
 * join to be live, so it is not evidence for leaving a machine alone. It is the
 * safe direction to be wrong in, because `join.py` reclaims its own node from the
 * token on disk rather than minting a second, and the opposite error is the
 * reported bug — a machine that is not serving and is never started again. Where
 * `null` does mean *do not act* is the retry inside `awaitServing`, which spends
 * an attempt only on a confirmed end; that distinction lives there, not here.
 */
export function shouldSpawn(known: Status, start: JoinState | null): boolean {
  const serving =
    (start !== null && start.state !== "none" && start.state !== "ended") ||
    (known.nodeId !== null && known.node?.healthy === true);
  return !serving;
}

async function spawnJoin(request: JoinRequest): Promise<void> {
  const started = await read<number>("network_join", {
    // The catalogue id, not an ollama tag or a weights filename: `join.py`
    // resolves those from the catalogue itself, and passing the id is what puts a
    // ladder id into `identity.catalogue_id` — so the node is filed under the
    // model the flow is showing the user, rather than under a name only the
    // fetcher knows.
    model: request.modelId,
    // No name. The CLI defaults to the hostname plus a short random suffix,
    // which is a better name than anything this flow would ask the user to
    // invent for a machine they are only setting up once.
    name: null,
    // The tunnel, not `--lan`: a home machine on a home network is the case
    // this flow is for, and it is the one that works without the user
    // knowing their own subnet.
    lan: false,
  });
  if (!started.ok) {
    // `network` stays the default — a join that would not start is honestly
    // that — but the missing CLI is the one failure that has to survive the
    // trip. Its remedy is a download, and "the network didn't answer" would send
    // the user to inspect a network this machine never used.
    throw new OnboardingError(
      classify(started.detail) === "cli-missing" ? "cli-missing" : "network",
      "Couldn't start the join.",
      started.detail,
    );
  }
  // Both set last, on the only path where a process was in fact started. `joined`
  // is what `joinState` reads first: with no attempt made there is no handle in
  // Rust to ask about, and "nothing was started" is a different answer from "it has
  // stopped" — the first would spend a retry, the second is the one that should.
  // `joinStart` is the offset that makes the log readable as *this* attempt's, and
  // it is set beside `joined` because the two are only ever true together.
  joinStart = started.value;
  joined = true;
}

/** The last thing this attempt's join said about a problem, or `null` if it has said
 *  nothing that reads as one.
 *
 *  This answers a question the process handle cannot be asked on Windows. What this app
 *  holds there is `common.cmd`, a batch wrapper that exits *cleanly* the moment it has
 *  handed off to `join.py` — so a clean exit is how a join normally starts, the app sees
 *  `HandedOff` either way, and a join that then dies out there dies unwitnessed.
 *  `join.log` is the only account of it.
 *
 *  What the log cannot say is whether the process is still alive, and the caller must not
 *  pretend otherwise. `✗` is not a death marker: `join.py` prints it from `die_with_fix`
 *  and also from the `except` handlers in its re-registration loop, which it then carries
 *  on running — and a node whose re-registration failed is exactly a node the gateway
 *  stops listing, so that line is the likeliest one to be last here. An uncaught
 *  traceback's final line does mean a death, but it is not the only shape this returns.
 *
 *  A line of evidence, then, and not a verdict: "this is what the join last complained
 *  about". The sentence it is shown under is worded to be true either way.
 *
 *  Read only from `joinStart`, so what comes back is this attempt's words and not a dead
 *  attempt's last rites. A `null` means the join has said nothing that reads as a problem —
 *  which covers both "it is working" and "it died silently", two cases this file cannot
 *  tell apart. The caller's fallback is the sentence for a gateway that never answered,
 *  which claims nothing about this machine and is the honest thing to say about both. */
async function joinStoppedReason(): Promise<string | null> {
  if (joinStart === null) return null;
  const tail = await read<string | null>("network_join_tail", { from: joinStart });
  if (!tail.ok || tail.value === null) return null;
  // The last line that reads as a problem, and not the first: an attempt that was retried
  // appends rather than replaces, and the newest account is the one that says why the
  // join is not up *now*.
  //
  // A failure glyph, or the line Python ends an uncaught traceback on. Not a mention of
  // the word "error", which was this filter's first shape and was wrong: `join.py` prints
  // one of those every half hour on a perfectly healthy node — "could not self-update
  // (…), continuing with current version" — and offering that as the reason a join failed
  // would be a caption whose own words say it did not matter.
  const FAILED = /^\s*✗/;
  // `urllib.error.HTTPError: …`, and the name has to *end* in the word, so a sentence with
  // "error" somewhere in the middle of it is not a match. `socket.gaierror` is the one
  // exception Python spells with a lowercase `e`.
  const TRACEBACK_END = /^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?:Error|error)\s*:/;
  const lines = tail.value.split("\n").filter((line) => FAILED.test(line) || TRACEBACK_END.test(line));
  const last = lines.at(-1)?.trim();
  if (last === undefined || last === "") return null;
  // A clause, not a paragraph. The caption's type is small and uppercase and the sheet
  // is narrow; past a line's worth the tail of the sentence is what the user loses.
  return last.length > 120 ? `${last.slice(0, 119)}…` : last;
}

/**
 * How far along the weight fetch is, from the join's own log — `null` when there
 *  is no fetch underway to report.
 *
 *  This is what replaced a screen. The weights used to be pulled by ollama,
 *  which streamed a byte count this file turned into a bar; the fetch happens
 *  inside the join now, and the only account of it is `join.log`. The CLI's
 *  runtime prints one line per ten percent while it downloads —
 *  `  qwen3:8b   40%  1.7 GB of 4.3 GB` — and this reads the last of them back.
 *
 *  Deliberately unparsed, and that is the same judgement the contract makes: the
 *  name and the two sizes are handed on exactly as the fetcher rendered them,
 *  because bytes re-derived from "1.7 GB" would be a number this file invented.
 *  Only the percentage is read as a number, and only to answer one question —
 *  whether the fetch is still going. At `100` the bytes are in hand and the
 *  caption can go back to saying what the join itself is doing.
 *
 *  Read from `joinStart` like everything else here, so a machine whose weights
 *  arrived on an earlier attempt does not report that attempt's last line as
 *  this one's work.
 */
/** The fetcher's count, as `JoinProgress` carries it. Optional there, because
 *  only one phase has one; this is the read that produces it, so the only absent
 *  answer it gives is `null`. */
type FetchLine = Exclude<JoinProgress["fetch"], undefined>;

async function joinFetchProgress(): Promise<FetchLine | null> {
  if (joinStart === null) return null;
  const line = await read<FetchLine | null>("network_join_progress", { from: joinStart });
  return line.ok ? line.value : null;
}

/** One read of the network's opinion of this node, for the confirming phase. */
async function healthy(): Promise<boolean> {
  const current = await status();
  return current.node !== null && current.node.healthy;
}

/** The phase emitter a join hands to the screen it is running behind. The
 *  second argument carries whichever of the two extras this phase has: the
 *  fetcher's own count while the weights move, and the model's answer once it has
 *  spoken. A phase that has neither passes nothing. */
type Say = (
  phase: JoinProgress["phase"],
  extra?: { answered?: JoinProgress["answered"]; fetch?: JoinProgress["fetch"] },
) => void;

/** How long a first join waits for the gateway to list this machine. Four
 *  minutes, and unchanged: it covers a cold model coming off disk on a slow
 *  machine, and a first run is the one time that is a reasonable thing to wait
 *  through. */
const JOIN_DEADLINE_MS = 240_000;

/** How often the wait asks. One second, which is a compromise the gateway
 *  sets: polling faster asks a service that is already being asked by everyone
 *  else, and polling slower makes a node that arrived in two seconds look like
 *  one that arrived in four. */
const JOIN_POLL_MS = 1000;

/** A reconnect's budget, and it is nothing like four minutes. There is no model
 *  to load here and no weights to verify — `join.py` is being started and asked
 *  to register a token that is already on disk. Ninety seconds is generous for
 *  that, and the point of the shorter number is that a user who pressed a button
 *  is owed an answer while they are still looking at it. */
const RECONNECT_DEADLINE_MS = 90_000;

/** And asked less often, because this one is waiting on a single round trip to
 *  the gateway rather than on a model. */
const RECONNECT_POLL_MS = 2500;

/**
 * Register, and wait until the gateway has this node in its own list.
 *
 * The half of a join that is about *arriving*, split out because a reconnect
 * needs exactly this and none of what follows it. `joinNetwork` goes on to load
 * the model, prove it answers, and confirm reachability, and every one of those
 * belongs to a machine being set up. A machine coming back after a reboot has
 * the weights on disk and the node token written already — it needs to register
 * again, which is what this does.
 *
 * ── Guard one: something is already serving ──────────────────────────────────
 *
 * Three cases, and only the middle one is subtle.
 *
 * — A join **this app started and has not seen end** is reused. That is the
 *   retry path: a `"confirming"` that did not come good must not put a second
 *   `join.py` on the same port. It is asked as "not ended" rather than as
 *   "alive" because on Windows the process this app holds is a wrapper that
 *   hands off and leaves — so it has always already ended, and a question
 *   phrased as "is it alive" can only ever answer no. See `joinState`.
 *
 * — An identity **and** a gateway that can reach it is reused. Checking the
 *   identity alone would be wrong, and this is the hole the second clause
 *   closes: a `join.py` killed outright — a crash, a `kill -9`, a reboot —
 *   leaves `identity.json` behind while the process is gone, so an identity
 *   on disk is not evidence that anything is serving. What it *is* evidence
 *   of is a node token, and `join.py` sends that token back on the next
 *   registration to reclaim its own node rather than minting a second one —
 *   which is why spawning again here is safe rather than a duplicate.
 *
 * — Otherwise, spawn. Which is the fresh case, and also the stale one.
 *
 * ── The wait, in one part: registering ───────────────────────────────────────
 *
 * It ends when the gateway has this node in its list — `node`, and not the
 * identity appearing on disk. The identity is a *file*, written by whichever
 * join registered last, and it outlives the process that wrote it: reading
 * `nodeId !== null` as "registered" is what once let a join that had died twelve
 * seconds in look exactly like one that had succeeded — through a model load and
 * a ninety-second confirming poll, on a node that had been gone before either
 * began. The token that file holds is what lets a new attempt reclaim the same
 * node rather than mint a second, but reclaiming is not the same as having it.
 * So the identity is asked for beside the entry, and only for the node id this
 * flow goes on to show; the gateway's own list is what says this machine
 * arrived.
 *
 * Listing, and deliberately not `healthy` — which is the correction here.
 * Registration and reachability are two questions and the gateway keeps two
 * fields for them: its entry appears once it has accepted a registration, and
 * `healthy` turns true only when its own health check has passed against the
 * tunnel. This phase used to ask the second question for four minutes and then
 * report the answer as a network failure. A friend's Windows machine was told
 * "it took too long to answer" while its node sat in `/peers` and its own log
 * said "you are live" — and it never reached the model load or the test prompt,
 * which is everything the rest of this flow exists to do. Asking reachability
 * later does not drop it: `joinNetwork` asks it in `confirming`, where a `false`
 * is reported rather than thrown and the screen has a state for it.
 *
 * Which is why a death is retried here instead of surfacing as an error. A
 * join dies young on the far side's slowness rather than this machine's, and
 * the cure for that is another attempt — spent only on a *confirmed* end, so
 * a join that is merely slow keeps its attempt and keeps its port. See
 * `MAX_JOIN_ATTEMPTS`.
 *
 * On Windows "confirmed end" is narrower than it sounds, and that is the
 * point: the wrapper's exit says nothing about the join, so the only end this
 * loop can witness there is a wrapper that failed to hand off. Everything
 * after that is the gateway's to notice — which is what the screen has always
 * claimed, and what this loop used to contradict.
 */
async function awaitServing(
  request: JoinRequest,
  signal: Signal,
  say: Say,
  opts: { deadlineMs: number; intervalMs: number },
): Promise<Status> {
  // The machine before the join, and it is here rather than in either caller
  // because this is the one place both of them go through — the first join and
  // the reconnect alike.
  //
  // Before the `status()` below, and that ordering is the whole point. Everything
  // in this function reaches the CLI, and the CLI is a Python script: on a
  // machine with neither Python nor cloudflared, the very first read fails and
  // the screen says `cli-missing` about a tool it is holding in its own bundle.
  // Waiting until the join is *started* would be too late; there is no step of
  // this that works without it.
  //
  // Skipped outright once the answer is already known, so an ordinary machine
  // pays one comparison and not one frame. `failed` is skipped too and on
  // purpose: there is nothing left to wait for, the join is going to fail on its
  // own, and it has a better sentence for it than this file would.
  if (provisionNow().kind !== "ready") {
    say("preparing");
    await startProvisioning();
    // A cancel during the fetch is the user walking away from the join, not a
    // request to stop the fetch — which is one machine's, shared by every screen
    // and every later attempt. So the fetch carries on and only the join stops.
    if (signal.cancelled) throw stopped("Stopped.");
  }

  say("registering");

  const known = await status();
  const start = await joinState();
  const spawning = shouldSpawn(known, start);
  if (spawning) await spawnJoin(request);

  // Measured from here and not from the top of the function, which is where the
  // original put it too: starting a join is an invoke, and a budget that
  // included it would be a budget that quietly shrinks on a slow machine for a
  // reason that has nothing to do with the network.
  let deadline = Date.now() + opts.deadlineMs;
  let registered: Status | null = null;
  // An attempt is only spent on a join this call actually started. Reusing one
  // that was already serving leaves the count at zero, so a machine whose join
  // dies later in the wait gets all three.
  let attempts = spawning ? 1 : 0;
  // The last percentage the download showed, or -1 before any was read. Used to
  // tell a download that is moving from one that has stopped.
  let lastPercent = -1;
  for (;;) {
    if (signal.cancelled) throw stopped("Stopped.");
    const current = await status();

    // What the join is actually doing, asked of the log before the caption is
    // written. The weights are several gigabytes and the join fetches them
    // in here, so "Registering this machine." is the wrong description of the
    // eight minutes that spends — it is a true statement about the same process
    // that would leave the user watching a spinner with no reason to believe
    // anything was happening. Emitted every poll, so the count moves and so the
    // phrase returns the moment the bytes are in hand. See `joinFetchProgress`.
    const fetching = await joinFetchProgress();
    if (fetching !== null && fetching.percent < 100) say("fetching-model", { fetch: fetching });
    else say("registering");

    // A download that is moving is not a join that has failed. The deadline above
    // was sized for a cold start from disk, and a first run on a slower connection
    // spends longer than that fetching the weights, so while the percentage keeps
    // climbing the budget starts again from now. A download that stops climbing for
    // a whole budget is still a failure, and is reported as one below.
    if (fetching !== null && fetching.percent < 100) {
      if (fetching.percent > lastPercent) deadline = Date.now() + opts.deadlineMs;
      lastPercent = fetching.percent;
    }

    // The stop is read first, because it is the only thing on this line the loop
    // has been *told* rather than left to infer. Nothing of this app's is serving:
    // the joined process has ended without handing off, which is the only kind of
    // end a wrapper that has done its job never produces. A join that is still
    // working, or that has handed off and carried on out of sight, never reaches
    // here, so this cannot put a second `join.py` on the worker's port. A read that
    // failed is not an end and does not come here at all.
    //
    // Asked before the entry below for a case that is otherwise easy to misread: a
    // machine whose join died outright leaves its identity behind, and the gateway
    // goes on listing a node nobody is serving. Read the listing first and that
    // machine is told the gateway cannot reach it, when what happened is that it
    // stopped — a different sentence, and the one this state exists to say.
    const now = await joinState();
    if (now !== null && now.state === "ended") {
      if (attempts >= MAX_JOIN_ATTEMPTS) {
        // Not `network`. This machine started a join, watched it stop, and gave
        // up after three — the gateway was never asked and never refused, so the
        // sentence for an unanswered network is a lie here. What is left to say is
        // narrower and true: the process ended, and this is how. Why it ended is in
        // the log, which the report on this screen carries whole; a caption holds a
        // clause, and eight lines of log is not one.
        throw new OnboardingError(
          "join-stopped",
          SENTENCE["join-stopped"],
          `the join ${now.code}, ${attempts} times`,
        );
      }
      attempts += 1;
      await spawnJoin(request);
    }

    // Registered. The gateway has this node in its own list, and a node only gets
    // there through a registration it accepted — so over there, this machine
    // arrived.
    //
    // Not `healthy`, and the difference is the whole of the bug this line used to
    // carry: the entry exists as soon as the gateway has the node, while `healthy`
    // is its separate verdict that its health check gets through to the tunnel.
    // Waiting for the second one here held a spinner over a step that had finished
    // in seconds, and then blamed the network for the gateway's probe. Reachability
    // is asked in `confirming`, below, where it is reported on the screen that
    // already exists for it — rather than thrown at a machine that did register.
    if (current.nodeId !== null && current.node !== null) {
      registered = current;
      break;
    }

    if (Date.now() > deadline) {
      // The budget spent, and the gateway never once listed this machine.
      // That is the one failure left here, and it is silence: the loop leaves the
      // moment the gateway has the node, so a node it knows and cannot route to
      // never reaches this line — that is a registered machine with a routing
      // problem, and it is read out once the model has answered, in `joinNetwork`.
      //
      // Why the silence is two questions, and the log is what tells them apart. A
      // join that failed on its way up never reached the gateway at all, and
      // blaming the gateway for that is blaming the side that was never asked.
      // That is not a hypothetical: a Windows self-trial's join died in under a
      // second on `✗ ollama not found.` — the app had spawned it without Ollama's
      // directory on its `PATH` — and the screen spent the whole four minutes
      // saying "the gateway never listed this machine". On Windows the handle
      // cannot be asked, so `joinStoppedReason` is the only witness there is.
      //
      // The half of the question the log *can* carry, and no more: it says what the
      // join complained about, never whether the process is still up. The code below
      // is therefore not a claim that anything stopped — the sentence it leads to is
      // written to be true of a join that died and of one still failing out of sight.
      //
      // A line, and not the log. `detail` is rendered as a clause in the caption,
      // and `join.log` is written for a terminal: dropped in there it arrives
      // whole, in the caption's uppercase micro-type, and runs off the side of the
      // sheet. The one line answers the question; the rest is not lost, since
      // `ShareLog` on this very screen carries the log into the report.
      const stoppedHere = await joinStoppedReason();
      if (stoppedHere !== null) {
        // The join reported a problem, and this is the last of it. The screen for this
        // code reads that line as its second caption line, under a sentence worded to
        // survive the log's uncertainty — see `JoinNetwork.tsx`, where the reason this
        // is not `network` is written down at more length than a comment here could.
        throw new OnboardingError("join-stopped", SENTENCE["join-stopped"], stoppedHere);
      }
      // A download that was still running when the budget ran out is a stalled
      // download, not a gateway that never heard of the machine. The sentence has
      // to say which, or the user is sent to check the network when the fix is to
      // run the join again, which resumes the partial file.
      if (lastPercent >= 0 && lastPercent < 100) {
        throw new OnboardingError(
          "network",
          SENTENCE.network,
          `the model download stopped at ${lastPercent}% and did not move for ${Math.round(opts.deadlineMs / 1000)}s`,
        );
      }
      throw new OnboardingError("network", SENTENCE.network, "the gateway never listed this machine");
    }
    await wait(opts.intervalMs);
  }

  if (signal.cancelled) throw stopped("Stopped.");
  return registered;
}

/**
 * Register, prove the model answers here, and confirm the network can see it.
 *
 * ── Idempotent by machine ─────────────────────────────────────────────────────
 *
 * Two guards, in this order. A join this app already started and that is still
 * running is reused rather than restarted — a retry after a `"confirming"` that
 * never came good must not put a second `join.py` on the same port. And a node
 * the gateway already has is not re-registered at all: the identity on disk
 * names it, and `identity.node_id` is the answer.
 *
 * The case that is neither, and the reason the order matters: a join that died.
 * Its pid is gone, the gateway may or may not still list the node, and the right
 * thing is to run `common join` again — `join.py` keeps the node token in the
 * identity file and sends it back on the registration, so it reclaims its own
 * node instead of minting a second one. Rejoining is safe by the CLI's design,
 * not by this file's hope.
 *
 * ── Cancelling does not leave ─────────────────────────────────────────────────
 *
 * `cancel()` stops watching and nothing else. Walking Back out of this screen
 * unmounts it, which cancels the task, and a cancel that tore down the node would
 * mean that going back to look at the model screen silently took the user off the
 * network. The join is a node the user asked for; `Leave the network` is the
 * control that ends it, and it is the only one.
 *
 * ── `gatewaySeen: false` is a success ─────────────────────────────────────────
 *
 * If the node registers and the gateway never marks it healthy within the
 * budget, this resolves. The registration is not in doubt — the identity is on
 * disk — and the screen has a state for exactly this, which is a truer thing to
 * show than an error about a step that did in fact work.
 */
function joinNetwork(request: JoinRequest, opts?: ProgressOptions<JoinProgress>): Task<JoinResult> {
  return start(async (signal) => {
    const say: Say = (phase, extra) => opts?.onProgress?.({ phase, ...extra });

    // Register, and wait until the gateway has this machine in its own list. The
    // reasoning — the reuse guard, why the listing and not `healthy`, why a young
    // death is retried rather than reported — is all in `awaitServing`, which the
    // reconnect path calls too.
    const registered = await awaitServing(request, signal, say, {
      deadlineMs: JOIN_DEADLINE_MS,
      intervalMs: JOIN_POLL_MS,
    });

    if (signal.cancelled) throw stopped("Stopped.");

    // Unconditionally loading, and this used to be a question. A cold model
    // spends most of the ask loading and a warm one spends all of it answering,
    // so the phase was chosen by asking ollama whether the model was already
    // resident — a fact about this machine, read from this machine.
    //
    // There is no longer anywhere to read it from. `llama-server` is started by
    // the join and this file never addresses it, so the warm case cannot be
    // detected and the phase is now the join's own shape rather than a
    // measurement of it. What is lost is real and small: a machine whose model
    // is already in memory shows the loading sentence for the fraction of a
    // second that turns out to take.
    say("loading-model");

    const question = TEST_PROMPT;
    let answer: string;
    let latencyMs: number | null;
    try {
      // No model named, deliberately, and that is the fix for a name this app
      // cannot know. The ask has to name whatever `llama-server` is serving, and
      // the CLI sets that name itself: for an `ollama:` source it is the tag with
      // the scheme stripped, and for the `gguf:` sources the catalogue is now made
      // of it is the weights file's own stem — "Ternary-Bonsai-2-9B-Q2_0" for the 9B.
      // A table of those here would be a second copy of `runtime.py`'s naming rule,
      // free to drift from it and, as it did when the catalogue changed, to name a
      // model that has never been on this machine.
      //
      // There is nothing to look up. `--model` is optional and the CLI falls back
      // to the only model the backend is serving, which on this path is always the
      // one this join just started: one `llama-server`, one set of weights. Naming
      // it was never what made the question specific.
      const raw = await invoke<string>("network_ask_local", { question, model: null });
      const parsed: unknown = JSON.parse(raw);
      if (!isJson(parsed) || typeof parsed.answer !== "string") {
        throw new OnboardingError("unknown", SENTENCE.unknown, "the model returned nothing readable");
      }
      answer = parsed.answer.trim();
      latencyMs = readNumber(parsed, "latency_ms");
    } catch (from) {
      const error = asError(from);
      // The model not answering is not the network not answering, but there is
      // nothing the flow can do about either and the screen has one error state.
      // What matters is that the disclosure line carries the model's own refusal,
      // which is the only clue about which of the two it was.
      throw new OnboardingError(
        error.code === "network" ? "unknown" : error.code,
        "The model on this machine didn't answer.",
        error.detail ?? error.message,
      );
    }

    if (signal.cancelled) throw stopped("Stopped.");
    const answered = { prompt: question, answer, latencyMs: latencyMs ?? 0 };
    say("test-prompt", { answered });

    // Confirming — and the only place reachability is asked, now that `registering`
    // stops at the gateway holding the node. `healthy` is not the entry and not the
    // node's own word: the gateway sets it when its health check gets through to the
    // tunnel, and it stays false until one does. So it is polled rather than asked
    // once, because there is a real gap between the gateway accepting a registration
    // and its probe succeeding — and on a quick tunnel there may be no such moment at
    // all, which is the case this phase exists to report rather than to throw at.
    //
    // A `false` at the end of it is a successful call reporting a failed check: the
    // machine is registered, and the screen for it says so.
    say("confirming");
    let seen = false;
    const CONFIRM_DEADLINE = Date.now() + 90_000;
    for (;;) {
      if (signal.cancelled) throw stopped("Stopped.");
      if (await healthy()) {
        seen = true;
        break;
      }
      if (Date.now() > CONFIRM_DEADLINE) break;
      await wait(1500);
    }

    // Read again rather than trusting the registration read: the join may have
    // reclaimed an older identity or minted a new one in the meantime, and the
    // node id the screen shows must be the one this machine actually has now.
    // `registered` is the fallback for a status read that stopped answering.
    const final = await status();
    return {
      nodeId: final.nodeId ?? registered.nodeId ?? "",
      nodeName: final.name ?? registered.name ?? "this machine",
      modelId: request.modelId,
      testPrompt: answered,
      gatewaySeen: seen,
      // Empty, and not filled with six hex pairs to look the part: the Alpha
      // issues a bearer token rather than a keypair, so there is no fingerprint
      // here and inventing one would be a fabrication on the screen whose whole
      // job is proof. See the file header.
      publicKeyFingerprint: "",
    };
  });
}

/**
 * Put a machine that has already been set up back on the network.
 *
 * The whole of a reconnect: the guard `joinNetwork` opens with, and then only the
 * wait for the gateway to list this machine. What it leaves out is everything
 * that makes a first run a first run — warming the model, proving it answers with
 * a test prompt, and holding on for up to ninety more seconds while the gateway's
 * own health check catches up. A machine coming back after a reboot has the
 * weights on disk and the node token written already, and the user who pressed the
 * button is owed an answer sooner than four minutes.
 *
 * Reachability is deliberately not settled here. `EnsureJoinedResult` reports that
 * this node registered again, which is a fact about this machine; whether the
 * gateway can *route* to it is the gateway's answer, and asking for it here would
 * put a second opinion beside the one the rail and Settings already read through
 * `gatewaySeesUs()`. Two reads that can disagree is how a screen ends up saying
 * Connected over a machine nobody can reach.
 */
function ensureJoined(request: JoinRequest): Task<EnsureJoinedResult> {
  return start(async (signal) => {
    // No phase emitter, because there is nothing to emit to: a reconnect from the
    // chat is one state on one row of Settings rather than the six-step sequence
    // the onboarding screen draws. Passing a no-op rather than threading a
    // progress channel down from a surface that would discard it.
    const registered = await awaitServing(request, signal, () => {}, {
      deadlineMs: RECONNECT_DEADLINE_MS,
      intervalMs: RECONNECT_POLL_MS,
    });

    // Read again rather than trusting the registration read, for the same reason
    // `joinNetwork` does: the join may have reclaimed an older identity or minted
    // a new one in the meantime. `registered` is the fallback for a status read
    // that stopped answering.
    const final = await status();
    return {
      nodeId: final.nodeId ?? registered.nodeId ?? "",
      nodeName: final.name ?? registered.name ?? "this machine",
      modelId: request.modelId,
    };
  });
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/* ---------------------------------- the seam ---------------------------------- */

export function createRealService(): OnboardingService {
  return { scanHardware, suggestModel, setLimits, joinNetwork, ensureJoined };
}
