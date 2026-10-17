import {
  OnboardingError,
  type EnsureJoinedResult,
  type HardwareReport,
  type JoinProgress,
  type JoinRequest,
  type JoinResult,
  type ModelOption,
  type ModelSuggestion,
  type OnboardingService,
  type OnboardingErrorCode,
  type ProgressOptions,
  type ResourceLimits,
  type ScanProgress,
  type Task,
} from "./service";
import { TIERS, findModel, fitsHere, gb, largestFitting, modelFor, tierFor } from "./models";

/**
 * The stub.
 *
 * `service.ts` says what a real implementation owes its callers. This file
 * demonstrates that it can be done and lets the flow be walked before the
 * backend exists. It is written to the same rules rather than to something
 * easier, because the rules are the contract's teeth, and a stub that cheats
 * them teaches the screens to depend on the cheating.
 *
 * The data is fixed. A hardware scan that returned whatever this machine
 * happens to be would make every screenshot a different screenshot, and the
 * states worth looking at — a tight disk, a battery, an 8 GB machine — would be
 * the ones that could not be reached on demand. So the report is a constant and
 * `stubOptions` moves it.
 *
 * ── A note on the numbers ────────────────────────────────────────────────────
 *
 * The stub runs in seconds what its captions say takes minutes. That is
 * deliberate and it is the only place this file is not honest: the weight fetch
 * ticks through ten percent at a time over a few seconds, where the real one
 * spends minutes on the same lines. The shape is real — the fields, the order,
 * the sentence the caption goes back to when the bytes are in hand — and only
 * the pacing is the demo's.
 *
 * ── Reaching the other states ────────────────────────────────────────────────
 *
 * In development, `window.commonStub` exposes `options`, `gb()` and
 * `findModel()`. Set a field, walk the flow again:
 *
 *   commonStub.options.freeDiskBytes = gb(3)      // no room for the weights
 *   commonStub.options.memoryBytes = gb(8)       // the 8 GB ceiling
 *   commonStub.options.memoryBytes = gb(2)       // nothing fits: the floor at a squeeze
 *   commonStub.options.onBattery = true          // the battery-derived default
 *   commonStub.options.gatewayUnreachable = true // the failed verification
 *   commonStub.options.fail = "network"          // a rejection somewhere
 *   commonStub.options.fail = "cli-missing"      // the install that isn't there
 *   commonStub.options.unreadable = ["memory"]   // the read the user supplies by hand
 *   commonStub.options.unreadable = ["graphics"] // a clause that simply goes missing
 *   commonStub.options.speed = 0                 // no waiting at all
 *
 * The console is no use for a screen that has already read its options by the
 * time it opens — the hardware scan and the model suggestion both start on
 * arrival. So in development the same fields are also read from storage at
 * load, which reaches every screen: set `common.stub` to a JSON object, reload,
 * and the flow runs with it. Same field names, same values.
 */

export interface StubOptions {
  /** Reported total memory, and the only input the recommendation has: it decides
   *  which rung is named, whether that rung is the comfortable one, and — below
   *  about 2.5 GB — whether anything in the ladder fits at all. */
  memoryBytes: number;
  /** Reported free disk. Set below the model size to reach the blocked state. */
  freeDiskBytes: number;
  /** Reported power source. Drives the limits screen's default. */
  onBattery: boolean;
  /** Whether the gateway fails to confirm it can see this node. */
  gatewayUnreachable: boolean;
  /** Reads that came back unreadable. The contract says a failed read is `null`
   *  in its field and never a rejection, so this is the only route to the screen
   *  where the user supplies a figure by hand and to the dropped-clause case. */
  unreadable: readonly ScanProgress["field"][];
  /** Reject the next call that can reject with this code, then clear itself. */
  fail: OnboardingErrorCode | null;
  /** Scales every delay. 1 is a walkable ten seconds per long step; 0 removes
   *  the wait. */
  speed: number;
}

export const stubOptions: StubOptions = {
  memoryBytes: gb(16),
  freeDiskBytes: gb(118),
  onBattery: false,
  gatewayUnreachable: false,
  unreadable: [],
  fail: null,
  speed: 1,
};

/* --------------------------------- plumbing -------------------------------- */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every timer a task owns, and one way to stop them all. `cancel()` on any
 *  operation is exactly `stop()` plus a rejection: there is no path where a
 *  callback outlives the task that scheduled it. */
interface Job {
  after(milliseconds: number, fn: () => void): void;
  stop(): void;
}

function job(): Job {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  return {
    after(milliseconds, fn) {
      if (stopped) return;
      const id = setTimeout(() => {
        timers.delete(id);
        if (!stopped) fn();
      }, milliseconds * stubOptions.speed);
      timers.add(id);
    },
    stop() {
      stopped = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };
}

/** Settles a task at most once, and stops its timers as it does. Every method
 *  below settles through this, which is what makes `cancel()` idempotent and
 *  makes a cancel after a normal resolution a no-op. */
function settler(j: Job) {
  let done = false;
  return (settle: () => void) => {
    if (done) return;
    done = true;
    j.stop();
    settle();
  };
}

function failure(code: OnboardingErrorCode, message: string, detail?: string) {
  return new OnboardingError(code, message, detail);
}

/** Takes the pending injected failure, if it is this one. See `fail` above. */
function takeFailure(code: OnboardingErrorCode): OnboardingErrorCode | null {
  if (stubOptions.fail !== code) return null;
  stubOptions.fail = null;
  return code;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Math.round(value)));

/* ------------------------------- the readings ------------------------------- */

/** Fixed, so that a screenshot of the scan is the same screenshot tomorrow. */
function report(): HardwareReport {
  const out = stubOptions.unreadable;
  return {
    memory: out.includes("memory") ? null : { totalBytes: stubOptions.memoryBytes },
    graphics: out.includes("graphics")
      ? null
      : {
          vendor: "Apple",
          name: "Apple M2",
          // Unified memory cannot be split, which is the case the contract's
          // `vramBytes: null` and `unified: true` exist for.
          vramBytes: null,
          unified: true,
        },
    disk: out.includes("disk")
      ? null
      : { freeBytes: stubOptions.freeDiskBytes, totalBytes: gb(494), path: "/" },
    power: out.includes("power")
      ? null
      : stubOptions.onBattery
        ? { source: "battery", batteryPercent: 41 }
        : { source: "mains", batteryPercent: null },
    os: { platform: "macos", version: "15.0" },
  };
}

/* --------------------------------- the work --------------------------------- */

const SCAN_FIELD_MS = 420;
const CHOICE_MS = 1100;
const SAVE_MS = 700;

const TEST_PROMPT = { prompt: "What is 17 × 24?", answer: "408", latencyMs: 1400 };

function scanHardware(opts?: ProgressOptions<ScanProgress>): Task<HardwareReport> {
  const j = job();
  const d = deferred<HardwareReport>();
  const settle = settler(j);
  const phases: readonly ScanProgress["field"][] = ["memory", "graphics", "disk", "power"];

  phases.forEach((field, index) => {
    // The first read starts now, not after an interval — the screen has already
    // told the user it is having a look.
    j.after(SCAN_FIELD_MS * index, () => opts?.onProgress?.({ field }));
  });

  j.after(SCAN_FIELD_MS * phases.length, () => {
    settle(() => {
      const injected = takeFailure("unsupported");
      if (injected) {
        d.reject(failure("unsupported", "This machine can't be used."));
        return;
      }
      d.resolve(report());
    });
  });

  return {
    result: d.promise,
    cancel() {
      settle(() => d.reject(failure("cancelled", "Stopped.")));
    },
  };
}

/** The model choice, and it is the real one's arithmetic rather than an imitation
 *  of it — the same `largestFitting` over the same `TIERS`, the same fall to the
 *  floor when nothing is comfortable, and the same refusal when the memory read
 *  failed. What the stub supplies instead of a network is `fitsHere`'s default
 *  table, which is the answer the real service falls back to offline; so the two
 *  agree except when the live catalogue has moved, and that is a difference worth
 *  being able to see from the preview. */
function suggestModel(hardware: HardwareReport): Task<ModelSuggestion> {
  const j = job();
  const d = deferred<ModelSuggestion>();
  const settle = settler(j);

  j.after(CHOICE_MS, () => {
    settle(() => {
      const memory = hardware.memory?.totalBytes;
      // This call can reject for exactly one reason, and `fail` is documented as
      // rejecting the next call that can reject with that code — so it is
      // honoured here too, which is also the only way to reach the screen's own
      // error state by hand.
      const injected = takeFailure("permission-denied");
      if (injected) {
        d.reject(failure(injected, "The system wouldn't say how much memory there is."));
        return;
      }
      if (memory === undefined) {
        // The one thing this call will not guess at: without memory there is no
        // rung to name, and no amount of network would supply the figure. Set
        // `unreadable` to `["memory"]` to reach it.
        d.reject(
          failure("permission-denied", "The system wouldn't say how much memory there is."),
        );
        return;
      }

      const options: readonly ModelOption[] = TIERS.map((tier) => {
        const model = modelFor(tier);
        return { model, fits: fitsHere(model.id, hardware) };
      });

      // The machine's own pick, which is now the whole of the pick: the largest
      // rung it carries with headroom, or the floor when it carries none. A 16 GB
      // machine — the stub's default — takes the ceiling, so the preview opens on
      // the 9B; drop `memoryBytes` to 8 GB for the 4B, or to 2 GB for the floor
      // with `fits: false` under it.
      const comfortable = largestFitting(hardware);
      const model = modelFor(comfortable ?? tierFor(memory));

      d.resolve({ model, fits: comfortable !== null, options });
    });
  });

  return {
    result: d.promise,
    cancel() {
      settle(() => d.reject(failure("cancelled", "Stopped.")));
    },
  };
}


function setLimits(limits: ResourceLimits): Task<ResourceLimits> {
  const j = job();
  const d = deferred<ResourceLimits>();
  const settle = settler(j);

  j.after(SAVE_MS, () => {
    settle(() => {
      const injected = takeFailure("permission-denied");
      if (injected) {
        d.reject(failure("permission-denied", "The settings wouldn't save."));
        return;
      }
      // Clamped, and the clamp is returned rather than the input — the
      // contract's own example of what a real implementation owes its callers.
      d.resolve({
        contribute: limits.contribute,
        cap: {
          cpuPercent: clamp(limits.cap.cpuPercent, 5, 100),
          gpuPercent: clamp(limits.cap.gpuPercent, 5, 100),
        },
        quietHours: limits.quietHours,
      });
    });
  });

  return {
    result: d.promise,
    cancel() {
      settle(() => d.reject(failure("cancelled", "Stopped.")));
    },
  };
}

const REGISTER_MS = 900;
const LOAD_MS = 1100;
const ANSWER_MS = 1400;
const CONFIRM_MS = 1000;

/** The fetch, as the preview shows it: one line per ten percent, which is
 *  exactly the cadence the CLI's runtime prints at. Eleven emissions including
 *  the start, and then the caption goes back to the join's own sentence — the
 *  real one does the same, because the last of those lines stays in the log and
 *  reporting it for the rest of the join would describe work that had finished. */
const FETCH_MS = 420;
const FETCH_STEPS = 10;
const FETCH_START_MS = REGISTER_MS + 200;
const FETCHED_MS = FETCH_START_MS + FETCH_STEPS * FETCH_MS;

function joinNetwork(
  request: JoinRequest,
  opts?: ProgressOptions<JoinProgress>,
): Task<JoinResult> {
  const j = job();
  const d = deferred<JoinResult>();
  const settle = settler(j);

  const at = (phase: JoinProgress["phase"], answered?: JoinProgress["answered"]) => () =>
    opts?.onProgress?.(answered ? { phase, answered } : { phase });

  /** The weights, in the three fields the CLI's runtime prints them in — the
   *  name, the percentage, and the two sizes as that layer rendered them. Sizes
   *  are decimal, 10⁹ to the gigabyte, which is how the CLI reports a file and
   *  how `copy.ts` words one. */
  const model = findModel(request.modelId);
  const totalBytes = model?.bytes ?? gb(4);
  const name = model?.label ?? request.modelId;
  const fetching = (percent: number) => () =>
    opts?.onProgress?.({
      phase: "fetching-model",
      fetch: {
        name,
        percent,
        done: `${((totalBytes * percent) / 100 / 1e9).toFixed(1)} GB`,
        total: `${(totalBytes / 1e9).toFixed(1)} GB`,
      },
    });

  j.after(0, at("registering"));
  for (let i = 0; i < FETCH_STEPS; i += 1) {
    j.after(FETCH_START_MS + i * FETCH_MS, fetching((i + 1) * 10));
  }
  // Back to registering the moment the bytes are in hand, which is the phase the
  // real flow returns to and the reason this is a phase rather than a state of
  // its own. Then the join gets on with the model it now has.
  j.after(FETCHED_MS, at("registering"));
  j.after(FETCHED_MS + 400, at("loading-model"));
  j.after(FETCHED_MS + 400 + LOAD_MS, at("test-prompt"));
  j.after(FETCHED_MS + 400 + LOAD_MS + ANSWER_MS, at("test-prompt", TEST_PROMPT));
  // The question is answered and the gateway has not spoken yet: its own beat,
  // because "checking the network can see you" is the step the user is actually
  // waiting on and the one the result turns on.
  j.after(FETCHED_MS + 400 + LOAD_MS + ANSWER_MS + CONFIRM_MS, at("confirming"));
  j.after(FETCHED_MS + 400 + LOAD_MS + ANSWER_MS + CONFIRM_MS * 2, () => {
    settle(() => {
      // `cli-missing` and `join-stopped` are the two rejections here that are not
      // network failures, so neither gets the network's sentence. The screen shows
      // its own and never reads this — but a log that says "the network didn't
      // answer" about a file that is not on disk, or about a process that stopped on
      // this machine, is a log that lies, and the log is the thing a user sends.
      const injected =
        takeFailure("network") ??
        takeFailure("timeout") ??
        takeFailure("cli-missing") ??
        takeFailure("join-stopped");
      if (injected) {
        const stopped = injected === "join-stopped";
        d.reject(
          failure(
            injected,
            injected === "cli-missing"
              ? "Couldn't start the join."
              : stopped
                ? "The join didn't get through."
                : "The network didn't answer.",
            // The exit code is what the real path puts on this line, and the stopped
            // screen has a caption slot for it. Without one the preview would show
            // that slot empty, which reads as a screen that is broken rather than as
            // a detail that is genuinely absent.
            stopped ? "the join exit code 1" : undefined,
          ),
        );
        return;
      }
      // Registered whether or not the gateway could see it: a node that
      // registered and is unreachable is a successful call reporting a failed
      // check, which is why `gatewaySeen` is a field and not a rejection.
      d.resolve({
        nodeId: "c-9f3a",
        nodeName: "studio.local",
        modelId: request.modelId,
        testPrompt: TEST_PROMPT,
        gatewaySeen: !stubOptions.gatewayUnreachable,
        publicKeyFingerprint: "4b:9c:1e:77:2a:08",
      });
    });
  });

  return {
    result: d.promise,
    cancel() {
      settle(() => d.reject(failure("cancelled", "Stopped.")));
    },
  };
}

/** The reconnect, in the preview's terms: the registration beat, and then a node.
 *
 *  Shorter than `joinNetwork` by the two beats that are the difference being
 *  modelled — nothing is loaded into memory and nothing is asked of the model,
 *  because a machine coming back after a reboot has the weights on disk and the
 *  identity written already. */
function ensureJoined(request: JoinRequest): Task<EnsureJoinedResult> {
  const j = job();
  const d = deferred<EnsureJoinedResult>();
  const settle = settler(j);

  j.after(REGISTER_MS, () => {
    settle(() => {
      // The same two non-network failures `joinNetwork` can be handed, because a
      // reconnect fails the same two ways. A missing CLI and a join that stopped
      // are properties of *this machine*, and a preview that could only draw the
      // network's sentence for them would be showing the wrong screen for a
      // failure the real service deliberately does not call a network one.
      const injected =
        takeFailure("network") ??
        takeFailure("timeout") ??
        takeFailure("cli-missing") ??
        takeFailure("join-stopped");
      if (injected) {
        const stopped = injected === "join-stopped";
        d.reject(
          failure(
            injected,
            injected === "cli-missing"
              ? "Couldn't start the join."
              : stopped
                ? "The join didn't get through."
                : "The network didn't answer.",
            stopped ? "the join exit code 1" : undefined,
          ),
        );
        return;
      }
      // The same machine the join above reports, because it is the same machine:
      // a reconnect reclaims this node rather than minting a second one, which is
      // the property the whole feature rests on. A second name here would make the
      // preview quietly contradict the thing it exists to demonstrate.
      d.resolve({
        nodeId: "c-9f3a",
        nodeName: "studio.local",
        modelId: request.modelId,
      });
    });
  });

  return {
    result: d.promise,
    cancel() {
      settle(() => d.reject(failure("cancelled", "Stopped.")));
    },
  };
}

export function createStubService(): OnboardingService {
  return { scanHardware, suggestModel, setLimits, joinNetwork, ensureJoined };
}

/* The stub is the only part of the app that cannot be reached from the UI, so
   in development it gets a handle — and a way in that the console cannot use,
   for the screens that read their options on arrival. Dev-only, and
   deliberately not typed onto `Window`: nothing in the app may depend on it.
   In a production build `import.meta.env.DEV` is false and this is dead code. */
if (import.meta.env.DEV) {
  try {
    const saved = localStorage.getItem("common.stub");
    if (saved !== null) Object.assign(stubOptions, JSON.parse(saved) as Partial<StubOptions>);
  } catch {
    // A malformed blob is a malformed blob. The defaults stand.
  }

  (globalThis as unknown as Record<string, unknown>).commonStub = {
    options: stubOptions,
    gb,
    findModel,
  };
}
