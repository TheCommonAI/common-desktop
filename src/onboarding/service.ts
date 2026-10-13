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
 * `freeBytes`, `vramBytes`, `receivedBytes`, `bytesPerSecond`. Nothing is in
 * gigabytes. "GB" means different things to a hardware vendor, an operating
 * system and a download mirror — 10⁹ or 2³⁰ — and a contract that leaves that
 * ambiguous is a contract that produces off-by-7% disk checks. So the service
 * speaks one unit and the UI formats.
 *
 * ── Progress ─────────────────────────────────────────────────────────────────
 *
 * Progress is ABSOLUTE BYTES RECEIVED, never a fraction, plus the total once
 * the far side has reported one. A fraction cannot show the user "2.2 of 4.2
 * GB", and the total is genuinely unknown until the headers land.
 * `onProgress` fires at most about ten times a second.
 *
 * For a download, the last event before `result` resolves reports
 * `receivedBytes === totalBytes` with `state: "verifying"`. The promise
 * resolving means the file is on disk and its checksum matched — not that the
 * last byte arrived.
 *
 * ── Pausing ──────────────────────────────────────────────────────────────────
 *
 * `pause()` is synchronous and returns void. It does NOT settle `result` —
 * neither resolve nor reject. It takes effect at the next chunk boundary, the
 * service emits exactly one event with `state: "paused"`, and then progress goes
 * silent. `resume()` continues from the last `receivedBytes` and must never
 * restart the transfer. `pause()` while paused, and `resume()` while running,
 * are no-ops.
 *
 * ── Cancelling ───────────────────────────────────────────────────────────────
 *
 * `cancel()` rejects `result` with an `OnboardingError` whose code is
 * `"cancelled"`, emits no further progress, and is idempotent — calling it
 * twice, or after the promise has settled, does nothing. Stopping is an
 * expected user action and must never surface as an error in the UI. A
 * cancelled download leaves its partial file on disk, so a later call resumes
 * rather than restarts.
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
export type Lane = "math" | "code" | "writing";
/** Which rung of the model ladder this machine's memory can carry. */
export type Tier = "full" | "light";

/** A model as the interface needs to show it. The authoritative download size
 *  is whatever `downloadModel` reports on progress; `bytes` here is an estimate
 *  good enough for the pre-flight disk check and for telling the user what they
 *  are about to spend. */
export interface ModelSpec {
  id: string;
  label: string;
  lane: Lane;
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

export interface LaneOption {
  lane: Lane;
  model: ModelSpec;
  /** Whether this machine carries the model with headroom. Drives a clause in
   *  the caption, never whether the lane is selectable — the user may always
   *  override the recommendation. */
  fits: boolean;
}

export interface LaneSuggestion {
  /** What to select by default: the lane the network is short of when this
   *  machine can carry it, otherwise the lane the machine alone is best for. */
  recommended: Lane;
  /** What the machine alone would pick, at its tier. The honest baseline, and
   *  the yardstick the caption measures the network's ask against. */
  byMachine: Lane;
  /** The lane the network is short of, or `null` when the ask did not land. An
   *  unreachable ask is NOT an error; see `suggestLane`. */
  networkAsk: { lane: Lane; demand: "high" | "medium" | "low" } | null;
  /** All three lanes at this machine's tier, in Math · Code · Writing order. */
  options: readonly LaneOption[];
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

export interface DownloadRequest {
  modelId: string;
}

export interface DownloadProgress {
  receivedBytes: number;
  /** `null` until the far side reports a length. */
  totalBytes: number | null;
  /** `null` until the rate has settled — about the first two seconds. A number
   *  here that is still settling reads to the user as a broken estimate. */
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  state: "downloading" | "paused" | "verifying";
}

export interface DownloadResult {
  modelId: string;
  /** Absolute. Shown to the user verbatim. */
  path: string;
  bytes: number;
  verified: boolean;
}

export interface JoinRequest {
  lane: Lane;
  modelId: string;
  limits: ResourceLimits;
  /* There is no display name. The node's name is chosen by the backend from the
     machine and returned as `JoinResult.nodeName`; the UI never asks the user to
     invent one. */
}

export interface JoinProgress {
  phase: "registering" | "loading-model" | "test-prompt" | "confirming";
  /** Present only during `"test-prompt"`, once the model has answered. Carried
   *  on progress as well as on the result so the screen can show the proof at
   *  the moment it arrives rather than at the end of the whole sequence. */
  answered?: { prompt: string; answer: string; latencyMs: number };
}

export interface JoinResult {
  nodeId: string;
  nodeName: string;
  lane: Lane;
  modelId: string;
  testPrompt: { prompt: string; answer: string; latencyMs: number };
  /** Whether the network confirmed it can reach this node. `false` is a
   *  successful call reporting a failed check — see `joinNetwork`. */
  gatewaySeen: boolean;
  publicKeyFingerprint: string;
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

/** A transfer, which can additionally be held and let go. Only the download is
 *  pausable — a scan cannot be paused — and typing it separately is what stops
 *  a screen from offering a Pause control that would do nothing. */
export interface PausableTask<T> extends Task<T> {
  pause(): void;
  resume(): void;
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
   * Fit the memory to a lane, then ask the network what it is short of.
   *
   * MUST NOT reject for want of a network. An ask that does not land is
   * `networkAsk: null` and the interface says so in one clause. Reject only when
   * the machine's own tier cannot be determined.
   */
  suggestLane(report: HardwareReport): Task<LaneSuggestion>;

  /**
   * Fetch the weights. The long one. See the header for the exact meaning of
   * progress, pause, resume and cancel.
   */
  downloadModel(
    request: DownloadRequest,
    opts?: ProgressOptions<DownloadProgress>,
  ): PausableTask<DownloadResult>;

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
   * Idempotent by machine: calling it twice must not create two nodes. A second
   * call returns the same `nodeId`, so a retry after a failed `"confirming"`
   * phase never double-registers. `gatewaySeen: false` is a successful call
   * reporting a failed check — not a rejection.
   */
  joinNetwork(
    request: JoinRequest,
    opts?: ProgressOptions<JoinProgress>,
  ): Task<JoinResult>;
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
 * In the app: the installed CLI and the daemon on loopback, for real. In a
 * browser: the stub, which has neither `invoke` nor ollama behind it but which is
 * the only way these six screens can be looked at without building the app.
 *
 * This is the only place the choice is made, and nothing downstream of it knows
 * which service it was handed — the screens speak to the interface and the
 * interface is the same either way.
 */
export const onboardingService: OnboardingService = insideApp()
  ? createRealService()
  : createStubService();
