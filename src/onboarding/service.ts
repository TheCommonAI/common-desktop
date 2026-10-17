import { createRealService } from "./service.real";
import { createStubService } from "./service.stub";

/**
 * The onboarding contract.
 *
 * (This file, `service.stub.ts` and `service.real.ts` import each other,
 * deliberately: the interface names its two implementations, and each
 * implementation needs the error class. It is safe because none of the three
 * reads another at module scope — they touch each other's bindings only from
 * inside function bodies, or from the one choose-a-backend expression at the
 * bottom of this file, and all of those run after every module has finished
 * evaluating. Keep it that way.)
 *
 * Screens import `onboardingService` and the types below, and nothing else.
 *
 * ── Units ────────────────────────────────────────────────────────────────────
 *
 * Every measured quantity is BYTES and says so in its name: `totalBytes`,
 * `freeBytes`, `vramBytes`, `bytes`. Nothing is in gigabytes. "GB" means
 * different things to a hardware vendor, an operating system and a download
 * mirror — 10⁹ or 2³⁰ — and a contract that leaves that ambiguous is a
 * contract that produces off-by-7% disk checks. So the service speaks one unit
 * and the UI formats it. The one exception is argued where it occurs, in
 * `JoinProgress.fetch`.
 *
 * ── Progress ─────────────────────────────────────────────────────────────────
 *
 * Progress says *what is happening*, never how far along it is. The scan names
 * the read it is taking; the join names its phase, and in the one phase that
 * spends minutes moving bytes it also carries the fetcher's own account of
 * them. There is no percentage anywhere else, deliberately: this flow has never
 * been able to put a number on a registration or a model load, and a figure
 * invented to fill the space would be read as the truth.
 *
 * ── Cancelling ───────────────────────────────────────────────────────────────
 *
 * `cancel()` rejects `result` with an `OnboardingError` whose code is
 * `"cancelled"`, emits no further progress, and is idempotent — calling it
 * twice, or after the promise has settled, does nothing. Stopping is an
 * expected user action and must never surface as an error in the UI.
 *
 * What it stops is the *watching*, which is looser than the word suggests for
 * exactly one operation. A join is a node on the network: a cancel that ended
 * it would mean walking Back to an earlier screen silently took the user off
 * the network. See `joinNetwork`.
 *
 * ── Failure ──────────────────────────────────────────────────────────────────
 *
 * Errors cross the promise boundary as `OnboardingError` values. Narrow them
 * with `isOnboardingError`, switch on `code` for the sentence the user reads,
 * and keep `detail` for a secondary disclosure line — it is raw text from the
 * layer that failed, and it is never the primary sentence.
 */

/* --------------------------------- errors --------------------------------- */

export type OnboardingErrorCode =
  /** This platform, or this machine, cannot be onboarded at all. */
  | "unsupported"
  /** The system refused a read or a write. Recoverable by hand-entry or retry. */
  | "permission-denied"
  /** Offline, DNS, TLS, or the far side is down. */
  | "network"
  /** The `common` CLI the app runs could not be started. The join never left
   *  the machine, so this is not a network failure and must never be shown as
   *  one — and it is not an install for the user to go and do either. The app
   *  ships the CLI and fetches the Python it runs under; this means that fetch
   *  did not finish. See `provision.ts`. */
  | "cli-missing"
  /** The join ran and then stopped, taking its attempts with it. Like
   *  `cli-missing` this is a failure on *this* machine and must never be shown
   *  as a network one — whether the network ever heard from it is a separate
   *  question with its own evidence, and `detail` carries that evidence. */
  | "join-stopped"
  /** Not enough room for the weights. Carries the requirement in `detail`. */
  | "insufficient-disk"
  /** The model id is not available from any mirror. */
  | "not-found"
  | "timeout"
  /** Expected. Consumers must treat it as a no-op, never as an error. */
  | "cancelled"
  | "unknown";

export class OnboardingError extends Error {
  readonly code: OnboardingErrorCode;
  /** Raw text from the layer that failed — a syscall, an HTTP status line.
   *  Kept for a secondary line; never the sentence the user reads first. */
  readonly detail?: string;

  constructor(code: OnboardingErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
    this.detail = detail;
  }
}

/** Errors cross a promise boundary, so narrow them with this rather than with
 *  `catch` alone — it keeps working if the class is ever transpiled to a
 *  target where `instanceof` is unreliable. */
export function isOnboardingError(error: unknown): error is OnboardingError {
  return error instanceof OnboardingError;
}

/* --------------------------------- domain --------------------------------- */

export type Platform = "macos" | "windows" | "linux";
export type PowerSource = "battery" | "mains" | "unknown";
/**
 * Which rung of the model ladder this machine's memory can carry.
 *
 * One family at four sizes, so a rung *is* a model. There is no lane axis beside
 * it any more: the ladder used to be three lanes deep and the rung only said how
 * big, which is why the flow had to ask the user which lane they were for. With
 * prism-ml's Bonsai 2 there is one general line at four footprints, every lane
 * would have resolved to the same weights, and the axis was removed rather than
 * left standing as a control that changes nothing.
 */
export type Tier = "2b" | "4b" | "8b" | "9b";

/** A model as the interface needs to show it. `bytes` is the catalogue's figure,
 *  which is an estimate: the weights are fetched by the join, and the size the
 *  fetcher actually reports is its own. This is good enough for the two things
 *  it is used for, which are telling the user what they are about to spend and
 *  checking the disk has room. */
export interface ModelSpec {
  id: string;
  label: string;
  tier: Tier;
  bytes: number;
}

/** A read that failed is `null` in its field. `os` is always present. The four
 *  nullable reads are exactly the four the flow needs; nothing here is
 *  speculative. */
export interface HardwareReport {
  memory: { totalBytes: number } | null;
  graphics: {
    vendor: string;
    name: string;
    /** `null` when graphics memory is shared with the processor and cannot be
     *  split out — the normal case on Apple silicon. */
    vramBytes: number | null;
    unified: boolean;
  } | null;
  disk: { freeBytes: number; totalBytes: number; path: string } | null;
  power: { source: PowerSource; batteryPercent: number | null } | null;
  os: { platform: Platform; version: string };
}

export interface ScanProgress {
  /** The read being taken right now. */
  field: "memory" | "graphics" | "disk" | "power";
}

export interface ModelOption {
  model: ModelSpec;
  /** Whether this machine carries it with headroom. Drives a clause in the caption
   *  and never whether it is selectable — the user may always overrule the
   *  recommendation from Settings. */
  fits: boolean;
}

/**
 * What this machine should run.
 *
 * One field that decides and two that qualify it, where this used to be five
 * fields arbitrating between the machine and the network. The network has no say
 * any more and that is not a simplification of the protocol, it is the catalogue:
 * with one family at four sizes, the question "which weights?" is a question about
 * the machine, and the network's shortage cannot change the answer. An ask that
 * does not land used to be a third state the screen had to explain; there is no
 * ask, so there is no third state.
 */
export interface ModelSuggestion {
  /** The rung to run: the largest this machine carries with headroom, or the
   *  smallest rung when it carries none. */
  model: ModelSpec;
  /** Whether `model` clears the catalogue's floor at the catalogue's headroom.
   *  `false` means nothing in the ladder fits this machine, and `model` is then
   *  the floor of the ladder rather than a recommendation. The screen says so
   *  plainly instead of quietly naming a model that will not keep up. */
  fits: boolean;
  /** Every rung, smallest first. Carried so the screen can say what it is *not*
   *  recommending without asking the service a second question, and so Settings
   *  can offer the hatch from the same answer. */
  options: readonly ModelOption[];
}

export interface ResourceLimits {
  contribute: "always" | "plugged-in" | "idle";
  /** Percentages, 0..100. An implementation must clamp these against what the
   *  platform will actually allow and return what it stored, not what it was
   *  handed. */
  cap: { cpuPercent: number; gpuPercent: number };
  /** Local wall-clock "HH:MM". `null` means no schedule. `end` earlier than
   *  `start` means the window crosses midnight, which is the normal case. */
  quietHours: { start: string; end: string } | null;
}

export interface JoinRequest {
  /** The catalogue id of the weights to serve — one of the four in `models.ts`, and
   *  the whole of what this machine is asked to be. It replaces a `lane` field that
   *  used to sit beside it: the join reads the node's domain tags out of the
   *  catalogue entry it finds for this id, so the lane was never sent anywhere and
   *  with one family there is nothing left to send. */
  modelId: string;
  limits: ResourceLimits;
  /* There is no display name. The node's name is chosen by the backend from the
     machine and returned as `JoinResult.nodeName`; the UI never asks the user to
     invent one. */
}

export interface JoinProgress {
  /** `"preparing"` is not a step of the join — it is the machine being got
   *  ready for one. A join needs a Python to run the CLI with and the
   *  cloudflared that opens the tunnel, and the app fetches either if it is
   *  missing; see `provision.ts`. It comes first because it is the only phase
   *  that can, and it is never emitted on a machine that already has both.
   *
   *  `"fetching-model"` is the other one that is not the join's own work, and it
   *  is the same shape of fact: the CLI is downloading the weights, which is the
   *  longest thing this flow does and used to have a screen of its own. It is a
   *  phase because there is now nothing else to show it on — see `fetch`. */
  phase:
    | "preparing"
    | "registering"
    | "fetching-model"
    | "loading-model"
    | "test-prompt"
    | "confirming";
  /** Present only during `"fetching-model"`: the weights, as the process
   *  fetching them accounts for them.
   *
   *  These two are strings, and that is the one place this file breaks its own
   *  rule about bytes. The rule exists so that nothing downstream has to guess
   *  what a number means — and here the number is already a rendering, made by
   *  the layer that counted it ("1.2 GB of 4.3 GB"). Re-deriving bytes from it
   *  would mean inventing precision out of `1.2 GB`, which is somewhere between
   *  1.15 and 1.25 of them. Both halves are carried because the reader wants
   *  both: the fraction says how far along it is, and the size says what is
   *  being waited for, which ten percentages on their own never do. */
  fetch?: { name: string; percent: number; done: string; total: string };
  /** Present only during `"test-prompt"`, once the model has answered. Carried
   *  on progress as well as on the result so the screen can show the proof at
   *  the moment it arrives rather than at the end of the whole sequence. */
  answered?: { prompt: string; answer: string; latencyMs: number };
}

export interface JoinResult {
  nodeId: string;
  nodeName: string;
  modelId: string;
  testPrompt: { prompt: string; answer: string; latencyMs: number };
  /** Whether the network confirmed it can reach this node. `false` is a
   *  successful call reporting a failed check — see `joinNetwork`. */
  gatewaySeen: boolean;
  publicKeyFingerprint: string;
}

/**
 * What came of asking a machine that has *already* been set up to serve again.
 *
 * Deliberately not a `JoinResult`. There is no test prompt here and no
 * fingerprint to report, and filling those fields with plausible-looking values
 * would be inventing proof on the one screen whose subject is proof. What a
 * reconnect establishes is narrower: this node is registered again.
 */
export interface EnsureJoinedResult {
  nodeId: string;
  /** Read back after the wait, so it is the node this machine actually has now
   *  rather than the one the request named. */
  nodeName: string;
  /** Which weights this machine is now serving. Echoed from the request rather
   *  than read back, exactly as `JoinResult` echoes it: this is what the join was
   *  started with, and the caller that built the request is where it is confirmed. */
  modelId: string;
}

/* ---------------------------------- tasks ---------------------------------- */

export interface ProgressOptions<P> {
  onProgress?: (progress: P) => void;
}

/** A started operation. One shape for everything that runs, so one hook drives
 *  all of them and one cleanup rule cancels them all. */
export interface Task<T> {
  readonly result: Promise<T>;
  cancel(): void;
}

/* -------------------------------- contract -------------------------------- */

export interface OnboardingService {
  /**
   * Read this machine. Cheap, idempotent, safe to auto-start on mount.
   *
   * A single read that fails is reported as `null` in its field, never as a
   * rejection, so a refused graphics probe does not cost the user the whole
   * screen; the interface offers hand-entry instead. Reject with `unsupported`
   * only when the platform itself cannot be onboarded.
   */
  scanHardware(opts?: ProgressOptions<ScanProgress>): Task<HardwareReport>;

  /**
   * Fit this machine to a rung of the ladder.
   *
   * MUST NOT reject for want of a network — the answer does not depend on one any
   * more, and asking is where the live `min_ram_gb` figures come from, so an
   * unreachable gateway falls back to the table in `models.ts` rather than
   * failing. Reject only when the machine's own memory cannot be determined, which
   * is the one input there is no table for.
   */
  suggestModel(report: HardwareReport): Task<ModelSuggestion>;

  /**
   * Write the contribution limits. MUST return what was actually stored — an
   * implementation will clamp against the platform, and the interface redraws
   * from the return value rather than from what it sent.
   */
  setLimits(limits: ResourceLimits): Task<ResourceLimits>;

  /**
   * Register, prove the model answers here, and confirm the network can see
   * this node.
   *
   * The weights are fetched in here, by the CLI, as part of joining — there is
   * no separate download to start and so nothing in this interface to start it
   * with. That is also why `"fetching-model"` is a phase of this call and not a
   * screen of its own.
   *
   * Idempotent by machine: calling it twice must not create two nodes. A second
   * call returns the same `nodeId`, so a retry after a failed `"confirming"`
   * phase never double-registers. `gatewaySeen: false` is a successful call
   * reporting a failed check — not a rejection.
   */
  joinNetwork(
    request: JoinRequest,
    opts?: ProgressOptions<JoinProgress>,
  ): Task<JoinResult>;

  /**
   * Put a machine that has already been set up back on the network.
   *
   * The difference from `joinNetwork` is what it does *not* do: no model load,
   * no test prompt, and no fingerprint to report. It takes the same idempotency
   * guard — a join this app started and has not seen end is reused, and a node
   * the gateway can already reach is not re-registered — and then waits only
   * until the gateway has this node in its own list.
   *
   * For the case this exists for: `common join` is a foreground process, so
   * rebooting the laptop kills it. `identity.json` survives, which means the
   * node token survives with it, so re-running the join reclaims the same node
   * rather than minting a second. Reconnecting is safe by the CLI's design.
   *
   * Reachability is *not* established here. A registered node the gateway cannot
   * route to is a real state with its own sentence, and the caller asks that
   * question separately — `chat/rejoin.ts`, against the same read the rail and
   * Settings already show.
   */
  ensureJoined(request: JoinRequest): Task<EnsureJoinedResult>;
}

/**
 * Are we the app, or a browser looking at the app's page?
 *
 * Tauri writes this marker before the bundle runs, so it is readable from module
 * scope by the time anything asks. It is the same test `chat/backend.ts` makes,
 * and it makes it for the same reason: `invoke` throws outside the app, and a
 * page opened in a browser is how these screens get reviewed.
 */
function insideApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The one line that swaps the backend.
 *
 * In the app: the bundled CLI and this machine, for real. In a browser: the
 * stub, which has neither `invoke` nor a machine behind it but which is the only
 * way these screens can be looked at without building the app.
 *
 * This is the only place the choice is made, and nothing downstream of it knows
 * which service it was handed — the screens speak to the interface and the
 * interface is the same either way.
 */
export const onboardingService: OnboardingService = insideApp()
  ? createRealService()
  : createStubService();
