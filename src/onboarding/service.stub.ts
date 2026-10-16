import {
  OnboardingError,
  type DownloadProgress,
  type DownloadRequest,
  type DownloadResult,
  type EnsureJoinedResult,
  type HardwareReport,
  type JoinProgress,
  type JoinRequest,
  type JoinResult,
  type Lane,
  type LaneOption,
  type LaneSuggestion,
  type OnboardingService,
  type OnboardingErrorCode,
  type PausableTask,
  type ProgressOptions,
  type ResourceLimits,
  type ScanProgress,
  type Task,
} from "./service";
import { LANES, findModel, fitsHere, gb, modelFor, tierFor } from "./models";

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
 * deliberate and it is the only place this file is not honest: the rate it
 * reports is a plausible line rate, so the estimate the user reads is the
 * estimate a real transfer would give. The pacing is the demo's.
 *
 * ── Reaching the other states ────────────────────────────────────────────────
 *
 * In development, `window.commonStub` exposes `options`, `gb()` and
 * `findModel()`. Set a field, walk the flow again:
 *
 *   commonStub.options.freeDiskBytes = gb(3)      // the blocked download
 *   commonStub.options.memoryBytes = gb(8)       // the light tier
 *   commonStub.options.onBattery = true          // the battery-derived default
 *   commonStub.options.networkAskLane = "code"   // the lane conflict
 *   commonStub.options.networkAskLane = null     // the unreachable-ask caption
 *   commonStub.options.gatewayUnreachable = true // the failed verification
 *   commonStub.options.fail = "network"          // a rejection somewhere
 *   commonStub.options.fail = "cli-missing"      // the install that isn't there
 *   commonStub.options.unreadable = ["memory"]   // the read the user supplies by hand
 *   commonStub.options.unreadable = ["graphics"] // a clause that simply goes missing
 *   commonStub.options.speed = 0                 // no waiting at all
 *
 * The console is no use for a screen that has already read its options by the
 * time it opens — the hardware scan and the lane suggestion both start on
 * arrival. So in development the same fields are also read from storage at
 * load, which reaches every screen: set `common.stub` to a JSON object, reload,
 * and the flow runs with it. Same field names, same values.
 */

export interface StubOptions {
  /** Reported total memory. Below ~9 GB the light tier is chosen. */
  memoryBytes: number;
  /** Reported free disk. Set below the model size to reach the blocked state. */
  freeDiskBytes: number;
  /** Reported power source. Drives the limits screen's default. */
  onBattery: boolean;
  /** The lane the network asks for, or `null` for an ask that did not land. */
  networkAskLane: Lane | null;
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
  networkAskLane: "math",
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
const ASK_MS = 1100;
const SAVE_MS = 700;
const VERIFY_MS = 900;

/** Ticks per download, and the pause between them. Together these are the
 *  demo's pacing: about ten seconds end to end, whatever the file's size. */
const DOWNLOAD_TICKS = 42;
const TICK_MS = 220;

/** The rate the caption reports, in bytes per second. The stub is faster than
 *  this and always will be; see the note at the top of the file. 17.5 MB/s puts
 *  a four-gigabyte model at about four minutes, which is what the design was
 *  drawn against. */
const REPORTED_RATE = 17_500_000;

const TEST_PROMPT = { prompt: "What is 17 × 24?", answer: "408", latencyMs: 1400 };

/**
 * Bytes already on disk, by model id.
 *
 * The contract says a cancelled or failed transfer leaves its partial file
 * behind, so that calling again resumes rather than restarts. A real
 * implementation finds those bytes on disk; the stub keeps the count, because
 * the count is what a resumed transfer has to report for the caption
 * "resuming will be quick" to be telling the truth rather than flattering the
 * user.
 */
const partial = new Map<string, number>();

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

function suggestLane(hardware: HardwareReport): Task<LaneSuggestion> {
  const j = job();
  const d = deferred<LaneSuggestion>();
  const settle = settler(j);

  j.after(ASK_MS, () => {
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
        // tier, and without a tier there is no recommendation to make.
        d.reject(
          failure("permission-denied", "The system wouldn't say how much memory there is."),
        );
        return;
      }

      const tier = tierFor(memory);
      const options: readonly LaneOption[] = LANES.map((lane: Lane) => {
        const model = modelFor(lane, tier);
        return { lane, model, fits: fitsHere(model.id, hardware) };
      });

      // The machine's own pick. A machine that has been read successfully is
      // taken to be a numbers machine, which is the least surprising thing a
      // stub can say and the thing the screenshots were drawn against.
      const byMachine: Lane = "math";

      const ask = stubOptions.networkAskLane;
      const askFits = ask !== null && (options.find((o) => o.lane === ask)?.fits ?? false);

      d.resolve({
        recommended: askFits && ask !== null ? ask : byMachine,
        byMachine,
        networkAsk: ask === null ? null : { lane: ask, demand: "high" },
        options,
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

function downloadModel(
  request: DownloadRequest,
  opts?: ProgressOptions<DownloadProgress>,
): PausableTask<DownloadResult> {
  const j = job();
  const d = deferred<DownloadResult>();
  const settle = settler(j);

  const model = findModel(request.modelId);
  const totalBytes = model?.bytes ?? gb(4);
  const chunk = Math.ceil(totalBytes / DOWNLOAD_TICKS);

  // Seeded from the partial file, so a transfer picked up after a cancel or a
  // failure continues rather than starting over.
  let receivedBytes = Math.min(totalBytes, partial.get(request.modelId) ?? 0);
  let ticks = receivedBytes > 0 ? 2 : 0;
  let state: DownloadProgress["state"] = "downloading";
  let pending = false;

  const emit = () => {
    const settledRate = ticks < 2;
    opts?.onProgress?.({
      receivedBytes,
      totalBytes,
      // The rate is withheld for the first two ticks, so the estimate the user
      // reads is never one that is still settling.
      bytesPerSecond: settledRate ? null : REPORTED_RATE,
      etaSeconds: settledRate
        ? null
        : Math.max(0, Math.round((totalBytes - receivedBytes) / REPORTED_RATE)),
      state,
      // The stub never waits for anything: it has no daemon to wait for.
      waitedSeconds: null,
    });
  };

  const verify = () => {
    state = "verifying";
    emit();
    j.after(VERIFY_MS, () => {
      settle(() => {
        const injected = takeFailure("network");
        if (injected) {
          // The one place a `detail` appears: raw text from the layer that
          // failed, for the secondary disclosure line, never the sentence.
          d.reject(
            failure("network", "The download stopped.", "read: connection reset by peer"),
          );
          return;
        }
        // Verified, so there is no longer a partial to resume.
        partial.delete(request.modelId);
        d.resolve({
          modelId: request.modelId,
          path: `/Users/you/Models/${request.modelId}.gguf`,
          bytes: totalBytes,
          verified: true,
        });
      });
    });
  };

  const step = () => {
    if (state !== "downloading") return;
    receivedBytes = Math.min(totalBytes, receivedBytes + chunk);
    ticks += 1;
    partial.set(request.modelId, receivedBytes);
    emit();
    if (receivedBytes >= totalBytes) {
      verify();
      return;
    }
    schedule();
  };

  /** One tick in flight at a time. A paused transfer leaves its tick to fire and
   *  be ignored, rather than racing a resumed one — which is what stops a
   *  pause-and-immediately-resume from running two chains. */
  function schedule() {
    if (pending) return;
    pending = true;
    j.after(TICK_MS, () => {
      pending = false;
      step();
    });
  }

  // The length is reported before anything has moved, so the caption can say
  // "of 4.2 GB" from the first frame rather than appearing without a
  // denominator. The first tick is scheduled rather than run inline, so that a
  // pause arriving inside it finds a single chain to stop, not two.
  emit();
  schedule();

  return {
    result: d.promise,
    pause() {
      if (state !== "downloading") return;
      state = "paused";
      emit();
    },
    resume() {
      if (state !== "paused") return;
      state = "downloading";
      schedule();
    },
    cancel() {
      settle(() => d.reject(failure("cancelled", "Download stopped.")));
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

function joinNetwork(
  request: JoinRequest,
  opts?: ProgressOptions<JoinProgress>,
): Task<JoinResult> {
  const j = job();
  const d = deferred<JoinResult>();
  const settle = settler(j);

  const at = (phase: JoinProgress["phase"], answered?: JoinProgress["answered"]) => () =>
    opts?.onProgress?.(answered ? { phase, answered } : { phase });

  j.after(0, at("registering"));
  j.after(REGISTER_MS, at("loading-model"));
  j.after(REGISTER_MS + LOAD_MS, at("test-prompt"));
  j.after(REGISTER_MS + LOAD_MS + ANSWER_MS, at("test-prompt", TEST_PROMPT));
  // The question is answered and the gateway has not spoken yet: its own beat,
  // because "checking the network can see you" is the step the user is actually
  // waiting on and the one the result turns on.
  j.after(REGISTER_MS + LOAD_MS + ANSWER_MS + CONFIRM_MS, at("confirming"));
  j.after(REGISTER_MS + LOAD_MS + ANSWER_MS + CONFIRM_MS * 2, () => {
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
        lane: request.lane,
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
        lane: request.lane,
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
  return { scanHardware, suggestLane, downloadModel, setLimits, joinNetwork, ensureJoined };
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
