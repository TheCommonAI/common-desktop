import { invoke } from "@tauri-apps/api/core";

import {
  OnboardingError,
  type HardwareReport,
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
 * The real backend: this machine, read through Rust.
 *
 * What is left of it is the two things that are true of a computer and not of any
 * network — what it has, and when it is willing to be used. Joining the network,
 * getting a share of the model and chatting are not here: they are the peer, and
 * the peer is `src/peer/`.
 */

/* ---------------------------------- plumbing ---------------------------------- */

/** A JSON object as it actually arrives: untyped, and possibly not an object at
 *  all. Every reader below starts here rather than trusting a cast, because
 *  these documents come from a CLI and a daemon that are both free to change. */
type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  // Anything that reads as the network being unreachable, or a failing upstream.
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
  "cli-missing": "Common's command-line tool isn't installed.",
  "insufficient-disk": "There isn't enough room.",
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

/* --------------------------------- the limits --------------------------------- */


/**
 * Write the contribution limits. Returns what was stored.
 *
 * The layer network has no throttle to turn: a peer offers a slice of the model
 * that fits in its memory, and it either serves or it does not. So there is no
 * "how much", only "when" — and the app enforces that itself, by starting and
 * stopping the peer (see `chat/policy.ts`). Nothing here is sent anywhere; what
 * this returns is what the app will hold itself to.
 */
function setLimits(limits: ResourceLimits): Task<ResourceLimits> {
  return start(async () => ({
    contribute: limits.contribute,
    // Quiet hours are passed through unvalidated on purpose: "HH:MM" is the
    // contract's own format, the time fields that produce them are the app's, and
    // a window that crosses midnight is the normal case rather than a mistake to
    // be corrected.
    quietHours: limits.quietHours,
  }));
}

/* ---------------------------------- the seam ---------------------------------- */

export function createRealService(): OnboardingService {
  return { scanHardware, setLimits };
}
