import { createRealService } from "./service.real";
import { createStubService } from "./service.stub";

/**
 * The onboarding contract: reading this machine, and the limits it is held to.
 *
 * (This file, `service.stub.ts` and `service.real.ts` import each other,
 * deliberately: the interface names its two implementations, and each needs the
 * error class. It is safe because none of the three reads another at module scope.)
 *
 * What used to live here and does not any more: picking a lane, fetching a model
 * through Ollama, and registering with a gateway. The layer network has none of
 * them. A machine does not choose what it serves — the network tells it which
 * layers are least covered — and it does not download "a model" but its own share
 * of one, which is the peer's job and shows up as the peer's progress. That is in
 * `src/peer/`.
 *
 * Every measured quantity is BYTES and says so in its name. Nothing is in
 * gigabytes: "GB" means different things to a vendor, an operating system and a
 * mirror, so the service speaks one unit and the UI formats.
 *
 * Errors cross the promise boundary as `OnboardingError` values. Narrow them with
 * `isOnboardingError`, switch on `code` for the sentence the user reads, and keep
 * `detail` for a secondary disclosure line.
 */

/* --------------------------------- errors --------------------------------- */

export type OnboardingErrorCode =
  /** This platform, or this machine, cannot be onboarded at all. */
  | "unsupported"
  /** The system refused a read or a write. Recoverable by hand-entry or retry. */
  | "permission-denied"
  /** Offline, DNS, TLS, or the far side is down. */
  | "network"
  /** The `common` CLI the app runs is not on this machine. The join never left
   *  the machine, so this is not a network failure and must never be shown as
   *  one: the remedy is an install, not a retry. */
  | "cli-missing"
  /** Not enough room for the weights. Carries the requirement in `detail`. */
  | "insufficient-disk"
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

/** A read that failed is `null` in its field. `os` is always present. */
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

/**
 * When this machine is willing to be used.
 *
 * Only "when", never "how much": a peer offers a slice of the model that fits in
 * its memory and either serves or does not, so there is no throttle to set. The
 * app enforces these itself by starting and stopping the peer.
 */
export interface ResourceLimits {
  contribute: "always" | "plugged-in";
  /** Local wall-clock "HH:MM". `null` means no schedule. `end` earlier than
   *  `start` means the window crosses midnight, which is the normal case. */
  quietHours: { start: string; end: string } | null;
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

/** A transfer, which can additionally be held and let go. Kept for the task hook;
 *  nothing in the layer network is pausable, since the peer resumes by itself. */
export interface PausableTask<T> extends Task<T> {
  pause(): void;
  resume(): void;
}

/* -------------------------------- contract -------------------------------- */

export interface OnboardingService {
  /**
   * Read this machine. Cheap, idempotent, safe to auto-start on mount.
   *
   * A single read that fails is `null` in its field, never a rejection, so a
   * refused graphics probe does not cost the user the whole screen. Reject with
   * `unsupported` only when the platform itself cannot be onboarded.
   */
  scanHardware(opts?: ProgressOptions<ScanProgress>): Task<HardwareReport>;

  /** Hold the limits. MUST return what was actually stored. */
  setLimits(limits: ResourceLimits): Task<ResourceLimits>;
}

function insideApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The one line that swaps the backend: the app reads the real machine, a browser gets the stub. */
export const onboardingService: OnboardingService = insideApp()
  ? createRealService()
  : createStubService();
