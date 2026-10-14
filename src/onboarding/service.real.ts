import { Channel, invoke } from "@tauri-apps/api/core";

import { LANES, fitsHere, modelFor, tierFor } from "./models";
import {
  OnboardingError,
  type DownloadProgress,
  type DownloadRequest,
  type DownloadResult,
  type HardwareReport,
  type JoinProgress,
  type JoinRequest,
  type JoinResult,
  type Lane,
  type LaneOption,
  type LaneSuggestion,
  type OnboardingErrorCode,
  type OnboardingService,
  type PausableTask,
  type Platform,
  type PowerSource,
  type ProgressOptions,
  type ResourceLimits,
  type ScanProgress,
  type Task,
  type Tier,
} from "./service";

/**
 * The real backend.
 *
 * Two processes on this machine, and nothing else. Everything the flow needs
 * already exists here, so this file is mostly translation:
 *
 * — **`common`**, the installed CLI, reached through the Rust seam in
 *   `src-tauri/src/backend.rs`. Nothing is reimplemented: the gateway's opinion
 *   of what the network is short of, of who this machine is, and of whether it
 *   can be reached are all `common --json <verb>` read verbatim. A fix to the
 *   CLI is a fix to the app.
 *
 * — **ollama**, over loopback at 127.0.0.1:11434. The download is ollama's own
 *   `/api/pull` stream rather than a file this app fetches, which is what makes
 *   the progress real (bytes ollama counted), the pause real (the partial blob
 *   ollama keeps), the resume real (ollama continues from what it has) and the
 *   verification real (ollama checks its own digests and will not say
 *   `success` until it has).
 *
 * Ollama is called from the webview rather than through Rust, with one
 * exception, and the exception is the download.
 *
 * The reason is CORS, and it is worth stating because the obvious reading is
 * the wrong one. A `fetch` from the page carries an `Origin` header, and ollama
 * answers only the origins on its allowlist. On macOS and Linux that list holds
 * Tauri's `tauri://*`, so every call here works. On Windows Tauri's webview
 * origin is `http://tauri.localhost` — the workaround URL for `tauri://localhost`
 * that `wry` uses there — and ollama's defaults do not hold it, so the preflight
 * comes back `403` and the request never leaves. That is fatal for the download
 * and merely quiet for the rest: the two reads below (`/api/tags`, `/api/ps`)
 * are wrapped in a `catch` that keeps going, but a pull that cannot start is a
 * model that cannot be installed, and on Windows it was.
 *
 * It also cannot be seen in development. `npm run tauri dev` serves the page
 * from `http://localhost:1420`, which ollama does allow, so the download works
 * on a Windows dev machine and fails only in the packaged build.
 *
 * So the pull goes through `ollama_pull` in Rust, which runs `curl` and streams
 * ollama's NDJSON back over a channel. A subprocess sends no `Origin`, so the
 * question does not arise on any platform — and every line is still ollama's
 * own, so the progress, the pause and the verification stay as real as they
 * were. See the command's own comment in `backend.rs`.
 *
 * That leaves one line in the production CSP: 127.0.0.1:11434 has to be in
 * `connect-src` for the two reads that still happen here.
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
  if (/not found|does not exist|no such|unknown model|404/.test(text)) return "not-found";
  if (
    /could not resolve|nodename nor servname|connection refused|network is unreachable|no route to host|can't reach|cannot reach|unreachable|offline|tls|certificate|bad gateway|\b50[234]\b|eof|failed to fetch|load failed/.test(
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
  "join-stopped": "The join stopped on this machine.",
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

/* ---------------------------------- the lanes ---------------------------------- */

/**
 * The catalogue's `domain_tags` for the ladder models, gathered into the app's
 * three lanes.
 *
 * This is the whole of the model-choosing policy, and it is written from the
 * catalogue rather than invented: every domain below is a tag on one of the six
 * models the ladder already carries, in
 * `src/onboarding/models.ts` and in the network's own catalogue — `math`,
 * `arithmetic`, `word-problems` and `quantitative` on the qwen2.5-math pair and
 * on mathstral, `reasoning`, `logic`, `step-by-step` and `planning` on
 * deepseek-r1 and phi4-mini-reasoning, `code`, `programming` and `debugging` on
 * the qwen2.5-coder trio, `general`, `conversation` and `writing` on gemma3,
 * llama3.1 and qwen3. So a gap the network names in any of them is a gap one of
 * these three lanes can actually answer.
 *
 * The catalogue's medical lane — `medical`, `clinical`, `biomedical`, on
 * meditron-7b alone — is deliberately absent, because this app has no medical
 * lane to send it to. The effect is that a network short only of medical help
 * is a network this app reads as short of nothing, which is the true statement
 * about what this app can offer it.
 */
const LANE_DOMAINS: Record<Lane, readonly string[]> = {
  math: [
    "math",
    "arithmetic",
    "word-problems",
    "quantitative",
    "logic",
    "reasoning",
    "step-by-step",
    "planning",
  ],
  code: ["code", "programming", "debugging", "sql", "databases", "queries"],
  writing: ["general", "conversation", "writing"],
};

/** How short the network's worst-served lane has to be before the ask is worth
 *  overriding the machine's own preference for. A share of the total gap, so it
 *  is a statement about the network's own shape rather than about a count that
 *  moves every day. */
function demandOf(share: number): "high" | "medium" | "low" {
  if (share >= 0.5) return "high";
  if (share >= 0.25) return "medium";
  return "low";
}

/**
 * What the network is short of, or `null`.
 *
 * Never rejects. The contract is explicit that an ask which does not land is
 * not an error, and the reason is in the shape of the thing: this is one clause
 * of one caption, and a network that cannot be reached is a network this machine
 * can still choose a lane for. Every failure below — a refused connection, a
 * document that will not parse, a gap table where nothing is actually short —
 * collapses to the same `null`, because the caller does the same thing about all
 * of them.
 *
 * The lane is picked by summing the gap over the domains that lane's models
 * cover, which is why the table above is the whole policy. The domain the
 * network names is not itself a lane, and treating it as one would mean the app
 * had a `word-problems` lane it could not staff.
 */
async function askNetwork(): Promise<LaneSuggestion["networkAsk"]> {
  let raw: string;
  try {
    raw = await invoke<string>("network_recommend");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJson(parsed) || !Array.isArray(parsed.domain_gaps)) return null;

  const totals: Record<Lane, number> = { math: 0, code: 0, writing: 0 };
  for (const entry of parsed.domain_gaps) {
    if (!isJson(entry)) continue;
    const domain = readString(entry, "domain");
    const gap = readNumber(entry, "gap");
    // A domain at zero, or in deficit, is not a gap — it is a domain the network
    // has covered. Including them would make the sum a measure of how much
    // traffic there is rather than of how short the network is.
    if (domain === null || gap === null || gap <= 0) continue;
    for (const lane of LANES) {
      if (LANE_DOMAINS[lane].includes(domain)) totals[lane] += gap;
    }
  }

  const total = LANES.reduce((sum, lane) => sum + totals[lane], 0);
  if (total <= 0) return null;

  let best: Lane = LANES[0];
  for (const lane of LANES) {
    if (totals[lane] > totals[best]) best = lane;
  }
  return { lane: best, demand: demandOf(totals[best] / total) };
}

/**
 * The lane this machine alone is best for.
 *
 * The lane whose model fits with the most room to spare — not the lane with the
 * biggest model, and not a fixed lane. Where two lanes fit equally the earlier
 * one wins, which is the order the interface lists them in, so Math is the
 * tie-break rather than an arbitrary default.
 *
 * When nothing fits — the full rung on a machine short of the 16 GB `fitsHere`
 * asks for — this falls back to the same order and returns Math. That is a
 * machine whose own preference is not a strong claim, and the caption already
 * says as much: this is the branch where the network's ask is *accepted* rather
 * than overridden, so the fallback is rarely the answer the user sees.
 */
function bestLaneFor(report: HardwareReport, tier: Tier): Lane {
  const memory = report.memory?.totalBytes ?? 0;
  let best: Lane = LANES[0];
  let roomiest = -Infinity;
  for (const lane of LANES) {
    const model = modelFor(lane, tier);
    if (!fitsHere(model.id, report)) continue;
    const room = memory - model.bytes;
    if (room > roomiest) {
      roomiest = room;
      best = lane;
    }
  }
  return best;
}

/**
 * Fit the machine, then let the network override it.
 *
 * The division of labour is the point. The **tier** is the machine's, from
 * `tierFor(memory)`, because only this machine knows how much memory it has.
 * The **lane** is the network's, from the gap table, because only the network
 * knows what it is short of — with the machine's own preference as the fallback
 * when the ask does not land or when the network's choice would not fit here.
 *
 * The one rejection is a machine whose memory could not be read: without a tier
 * there is no model ladder, and without a ladder there is no recommendation to
 * make. That is `permission-denied` rather than `unknown` because the screen
 * offers hand-entry for it, and hand-entry is a real fix for exactly this.
 */
function suggestLane(report: HardwareReport): Task<LaneSuggestion> {
  return start(async () => {
    const memory = report.memory?.totalBytes;
    if (memory === undefined) {
      throw new OnboardingError(
        "permission-denied",
        "The system wouldn't say how much memory there is.",
        "no memory figure, so no rung of the ladder to fit",
      );
    }

    const tier = tierFor(memory);
    const options: readonly LaneOption[] = LANES.map((lane: Lane) => {
      const model = modelFor(lane, tier);
      return { lane, model, fits: fitsHere(model.id, report) };
    });

    const byMachine = bestLaneFor(report, tier);
    const ask = await askNetwork();
    const askFits = ask !== null && (options.find((option) => option.lane === ask.lane)?.fits ?? false);

    return {
      recommended: ask !== null && askFits ? ask.lane : byMachine,
      byMachine,
      // The ask is reported whether or not it was taken, because the screen's
      // caption is a sentence about the difference between the two — and when
      // they agree there is no difference to explain.
      networkAsk: ask,
      options,
    };
  });
}

/* --------------------------------- the weights --------------------------------- */

/** Ollama, on this machine. Not configurable, because the alternative is a
 *  setting whose only working value is this one. The webview may call it only
 *  for the two reads below; the download goes through Rust, and the file header
 *  says why. */
const OLLAMA = "http://127.0.0.1:11434";

/** How long to wait for Ollama to become ready, in milliseconds. */
const OLLAMA_READY_TIMEOUT_MS = 30_000;
/** How often to poll Ollama readiness, in milliseconds. */
const OLLAMA_POLL_INTERVAL_MS = 1_000;

/**
 * Check if Ollama is responding.
 *
 * Uses `/api/version` which is lightweight and always available when Ollama
 * is running. Returns true if Ollama responds, false otherwise.
 */
async function isOllamaReady(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA}/api/version`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure Ollama is running and ready before making API calls.
 *
 * Polls `/api/version` every second. If Ollama isn't responding, attempts to
 * start it (on Windows, via the installed Ollama app; on macOS/Linux, assumes
 * it's already running or will be started by the user). Throws after 30 seconds
 * if Ollama never becomes ready.
 *
 * This fixes the "curl: (7) Failed to connect to 127.0.0.1:11434" error that
 * occurs when the app tries to pull a model before Ollama has finished starting.
 */
async function ensureOllamaReady(): Promise<void> {
  const deadline = Date.now() + OLLAMA_READY_TIMEOUT_MS;
  let startAttempted = false;

  while (Date.now() < deadline) {
    if (await isOllamaReady()) {
      return;
    }

    // Try to start Ollama once if it's not responding
    if (!startAttempted) {
      startAttempted = true;
      try {
        await invoke("start_ollama");
      } catch {
        // Starting failed, but keep polling — it might come up on its own
      }
    }

    await wait(OLLAMA_POLL_INTERVAL_MS);
  }

  throw new OnboardingError(
    "network",
    "Ollama isn't responding. Please make sure Ollama is installed and running.",
    `Ollama at ${OLLAMA} did not respond within ${OLLAMA_READY_TIMEOUT_MS / 1000} seconds`,
  );
}

/** One message from `ollama_pull`, as `PullEvent` in `backend.rs` sends it.
 *
 * `line` is ollama's own NDJSON, verbatim — the same text the webview used to
 * read off the response body, and the reason the parser below is unchanged.
 * `waiting` is ollama not being up yet, once a second until it is; its `seconds`
 * count up from the start of the wait. `unreachable` is ollama not being there
 * at all; `failed` is a transfer that started and did not finish. Both of those
 * are only ever sent when the transfer is over and there is no line that could
 * have said it. */
type PullEvent =
  | { kind: "line"; line: string }
  | { kind: "waiting"; seconds: number }
  | { kind: "unreachable"; message: string }
  | { kind: "failed"; message: string };

/**
 * The six rungs of the ladder, as ollama tags.
 *
 * The catalogue is the authority on these and is asked first, so that a tag
 * which changes there changes here. This table is the offline answer, and it is
 * not a guess: every pair below was read out of the live catalogue, and this
 * exists because the download and the test prompt both need a tag and neither
 * should fail because the gateway is unreachable.
 */
const LADDER_TAGS: Record<string, string> = {
  "qwen2.5-math-7b": "mightykatun/qwen2.5-math:7b",
  "qwen2.5-math-1.5b": "mightykatun/qwen2.5-math:1.5b",
  "qwen2.5-coder-7b": "qwen2.5-coder:7b",
  "qwen2.5-coder-1.5b": "qwen2.5-coder:1.5b",
  "qwen3-8b": "qwen3:8b",
  "llama3.2-3b": "llama3.2:3b",
};

/** The ollama tag for a ladder id, from the catalogue if it can be reached and
 *  from the table if it cannot. `null` for an id that is in neither, which for a
 *  flow that has only ever written ladder ids is unreachable. */
async function tagFor(modelId: string): Promise<string | null> {
  const fromTable = LADDER_TAGS[modelId];
  let catalogue: string;
  try {
    catalogue = await invoke<string>("network_catalogue");
  } catch {
    return fromTable ?? null;
  }
  try {
    const parsed: unknown = JSON.parse(catalogue);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!isJson(entry) || readString(entry, "id") !== modelId) continue;
        const source = readString(entry, "source");
        // `ollama:<tag>`, and nothing else is pullable: an `api:` or `graph:`
        // source is a hosted model and has no weights to fetch.
        if (source !== null && source.startsWith("ollama:")) return source.slice("ollama:".length);
      }
    }
  } catch {
    // A catalogue that will not parse is a catalogue that cannot be consulted.
  }
  return fromTable ?? null;
}

/** How often progress may be reported, in milliseconds. Ten a second is the
 *  contract's ceiling and is already more than a caption can be read at. */
const EMIT_MS = 100;

/** The window the transfer rate is measured over. Two seconds, because the
 *  contract says the rate is withheld until it has settled and this is what
 *  settled means here. */
const RATE_WINDOW_MS = 2000;

/**
 * Fetch the weights, through ollama's own pull stream.
 *
 * The stream is ollama's accounting, layer by layer, keyed by digest. That
 * keying is what makes a resumed transfer correct rather than approximately
 * correct: ollama re-reports the same digests it did before, each starting from
 * the bytes already on disk, and summing over a map means a layer seen twice is
 * counted once. A running total would double-count the whole partial file on
 * every resume.
 *
 * `pause` stops the read and then aborts, in that order, so the count the user is
 * shown is the count that was true when they pressed the button rather than one
 * that arrives a chunk later. Ollama keeps the blob it was writing; the resume
 * posts the same request again and ollama carries on from where it got to, which
 * may be very slightly ahead of the number on screen. That is the honest
 * direction for the discrepancy to run — the alternative is a progress bar that
 * reaches the total and then keeps going.
 */
function downloadModel(
  request: DownloadRequest,
  opts?: ProgressOptions<DownloadProgress>,
): PausableTask<DownloadResult> {
  let settled = false;
  let cancelled = false;
  let paused = false;
  let state: DownloadProgress["state"] = "downloading";
  /**
   * The id of the pull Rust is running, or `null`.
   *
   * An id rather than a handle, because the transfer no longer lives in this
   * process. `ollama_pull_cancel` looks it up in a map on the Rust side, which
   * is what makes a stop safe to get wrong: a cancel that arrives after the
   * transfer has ended finds nothing and does nothing, where an abort on a
   * stale handle would be a coin flip.
   */
  let pull: string | null = null;
  /** Bytes per layer, by ollama's digest. See the note above. */
  const layers = new Map<string, { total: number; bytes: number }>();
  /** Rate samples, newest last, cleared whenever the transfer stops. */
  const samples: { at: number; received: number }[] = [];
  let lastEmit = -Infinity;
  let confirmed = false;
  /** Whether the final `verifying` event has gone out. The contract promises it
   *  before `result` resolves, and it must not go out twice: this is the flag
   *  that keeps "ollama said so" and "the stream ended" from both announcing it. */
  let announced = false;

  /**
   * The ollama tag, resolved once. The flow deals in ladder ids — `qwen2.5-math-7b`
   * — and ollama deals in tags — `mightykatun/qwen2.5-math:7b`. The difference is
   * invisible everywhere except here, which is exactly where getting it wrong
   * would ask ollama to pull a model that does not exist under that name.
   */
  let tag: string | null = null;
  let tagReady: Promise<void> | null = null;
  const resolveTag = () => {
    tagReady ??= tagFor(request.modelId).then((found) => {
      tag = found;
    });
    return tagReady;
  };
  /** What to call the model when talking to ollama. Before the catalogue has
   *  answered this is the ladder id, which is only ever used to build a request
   *  that has not been sent yet. */
  const forOllama = () => tag ?? request.modelId;

  let resolve!: (value: DownloadResult) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<DownloadResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const received = () => {
    let sum = 0;
    for (const layer of layers.values()) sum += layer.bytes;
    return sum;
  };

  const expected = () => {
    if (layers.size === 0) return null;
    let sum = 0;
    for (const layer of layers.values()) sum += layer.total;
    return sum;
  };

  /** Bytes per second over the last two seconds, or `null` while the window is
   *  still too young to mean anything. */
  const rate = (at: number, bytes: number): number | null => {
    samples.push({ at, received: bytes });
    // Keep one sample older than the window as the anchor, so the measurement
    // spans the full two seconds rather than the few milliseconds since the
    // oldest sample that still fits inside it.
    while (samples.length > 1 && at - samples[1].at > RATE_WINDOW_MS) samples.shift();
    const first = samples[0];
    const span = (at - first.at) / 1000;
    if (span < RATE_WINDOW_MS / 1000) return null;
    const moved = bytes - first.received;
    return moved > 0 ? moved / span : null;
  };

  const emit = (force = false) => {
    // Once the final event has gone out, it is final: nothing that arrives after
    // it may take its place as the last thing the screen was told.
    if (announced) return;
    const at = performance.now();
    if (!force && at - lastEmit < EMIT_MS) return;
    lastEmit = at;
    const bytes = received();
    const total = expected();
    const speed = state === "paused" ? null : rate(at, bytes);
    opts?.onProgress?.({
      receivedBytes: bytes,
      totalBytes: total,
      bytesPerSecond: speed,
      etaSeconds:
        speed === null || total === null ? null : Math.max(0, Math.round((total - bytes) / speed)),
      state,
      waitedSeconds: null,
    });
  };

  /**
   * Stop the transfer Rust is running, if one is.
   *
   * Fire and forget. The answer is not needed: a pause has already drawn itself,
   * a failure is already on its way to `reject`, and an id Rust does not know
   * about is a cancel that raced the end of the transfer — which is not an error
   * and must not become one.
   */
  const stopPull = () => {
    if (pull === null) return;
    const id = pull;
    pull = null;
    void invoke("ollama_pull_cancel", { id }).catch(() => {
      // A cancel that cannot be delivered changes nothing that is on screen.
    });
  };

  const fail = (error: OnboardingError) => {
    if (settled) return;
    settled = true;
    stopPull();
    reject(error);
  };

  const finish = (value: DownloadResult) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  /**
   * The last word before the numbers stop moving: the file is all there and what
   * is left is the check. It is the event the contract names as the one that has
   * to say so, and it is idempotent because ollama says so three times — once
   * per digest, once for the manifest, once on `success` — and a screen that
   * redraws the same sentence three times in a row is a screen that looks stuck.
   */
  const verify = () => {
    if (announced) return;
    state = "verifying";
    const total = expected();
    const bytes = received();
    opts?.onProgress?.({
      receivedBytes: total ?? bytes,
      totalBytes: total,
      bytesPerSecond: null,
      etaSeconds: null,
      state,
      waitedSeconds: null,
    });
    announced = true;
  };

  /**
   * Ollama is not up yet, and Rust is waiting for it.
   *
   * The only thing the screen hears while that happens, once a second — a first
   * run on a cold Windows machine would otherwise be thirty seconds of one
   * unchanging frame, which is what a hang looks like.
   *
   * It draws itself rather than going through `emit`, for the reason `verify`
   * does: `emit` reports a transfer, and there is no transfer yet. It also
   * deliberately leaves `state` alone, so that the first line of ollama's to
   * arrive puts the screen back to reporting bytes without anything having to
   * notice that it had stopped. The count it carries is whatever earlier lines
   * established — nothing on a first run, the resumed total after a pause.
   */
  const waiting = (seconds: number) => {
    if (announced) return;
    opts?.onProgress?.({
      receivedBytes: received(),
      totalBytes: expected(),
      bytesPerSecond: null,
      etaSeconds: null,
      state: "waiting",
      waitedSeconds: seconds,
    });
  };

  /** One line of ollama's NDJSON. */
  const absorb = (line: string) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Ollama writes whole JSON objects, one per line. A line that is not one
      // is a line this code has no reading for; skipping it is better than
      // failing a four-gigabyte transfer over a keepalive.
      return;
    }
    if (!isJson(event)) return;

    const error = readString(event, "error");
    if (error !== null) {
      fail(new OnboardingError(classify(error), "The download stopped.", error));
      return;
    }

    const status = readString(event, "status") ?? "";
    const digest = readString(event, "digest");
    const total = readNumber(event, "total");
    const completed = readNumber(event, "completed");
    if (digest !== null && total !== null) {
      layers.set(digest, { total, bytes: completed ?? 0 });
      emit();
      return;
    }
    // Anything else with a `total` is ollama's aggregate for the manifest, and
    // the per-layer map above already has those bytes.
    if (status.startsWith("verifying") || status.startsWith("writing manifest")) {
      verify();
      return;
    }
    if (status === "success") {
      confirmed = true;
      verify();
      return;
    }
    // "pulling manifest", "pulling <digest>" and the rest are ollama saying what
    // it is about to do; the bytes are the only thing worth reporting.
  };

  /** One trip through the stream. Called again by `resume`. */
  const pump = async (): Promise<void> => {
    // Ensure Ollama is running before attempting to pull. This fixes the
    // "curl: (7) Failed to connect" error on Windows where Ollama may still
    // be starting up when the app tries to download a model.
    await ensureOllamaReady();

    // Before the first byte, and only once: the ladder id becomes the tag ollama
    // will answer to.
    await resolveTag();
    if (tag === null) {
      throw new OnboardingError(
        "not-found",
        "That model isn't available to download.",
        `${request.modelId} is not an ollama model`,
      );
    }
    if (paused || cancelled || settled) return;

    const mine = `${request.modelId}:${Date.now()}`;
    pull = mine;

    const channel = new Channel<PullEvent>();

    channel.onmessage = (event) => {
      // A pause or a cancel stops the transfer on purpose and has already been
      // reported; a failure has already been handed to `reject`. Anything that
      // arrives after that is a line nobody is left to draw.
      if (paused || cancelled || settled) return;
      // Wrapped because this is a callback and nothing above it is listening: an
      // exception raised in here is swallowed by the dispatcher that called it,
      // which for a throw out of the drawing code `absorb` calls into would mean
      // a download that appears to keep working while the bug goes unreported.
      // `fail` is the only way out of a callback, so every path uses it.
      try {
        if (event.kind === "line") {
          absorb(event.line);
          return;
        }
        // Not an ending and not a byte: ollama still coming up, and Rust saying
        // so once a second so the screen is not silent while it waits.
        if (event.kind === "waiting") {
          waiting(event.seconds);
          return;
        }
        // The two endings that carry no stream. The split is the one the old code
        // drew between a rejected `fetch` and a non-ok response, kept because the
        // two are different things to be told: "not listening" is the ordinary
        // state of a machine that has never run ollama, and "stopped halfway" is
        // not.
        fail(
          new OnboardingError(
            "network",
            event.kind === "unreachable"
              ? "Couldn't reach the model on this machine."
              : "The download stopped.",
            event.message,
          ),
        );
      } catch (from) {
        fail(asError(from));
      }
    };

    try {
      await invoke("ollama_pull", { model: forOllama(), id: mine, onEvent: channel });
    } catch (from) {
      if (paused || cancelled || settled) return;
      // Rust declining the call, rather than ollama saying something: there is no
      // message of ollama's to show, so this keeps the older, vaguer sentence.
      throw new OnboardingError(
        "network",
        "Couldn't reach the model on this machine.",
        reason(from),
      );
    } finally {
      // Only this trip's id, so a pause that has already started the next one
      // cannot have it cleared out from under it.
      if (pull === mine) pull = null;
    }

    // The transfer ended, one way or another. A pause, a cancel or a failure
    // that has already been reported all end here without a second word.
    if (paused || cancelled || settled) return;

    // The stream ended. Ollama says `success` only after it has checked the
    // digests of everything it wrote, so a stream that stops without one is a
    // transfer that did not finish — including the case where the connection
    // closed cleanly, which is the one that would otherwise look like success.
    if (!confirmed) {
      throw new OnboardingError(
        "network",
        "The download stopped.",
        "ollama closed the stream before confirming the file",
      );
    }
  };

  const settle = async (): Promise<void> => {
    // The bytes as ollama itself accounts for them, rather than as this file
    // summed them: the two agree, and when they do not it is ollama's figure that
    // is the file on disk.
    let bytes = received();
    try {
      const tags = (await fetch(`${OLLAMA}/api/tags`).then((response) => response.json())) as unknown;
      if (isJson(tags) && Array.isArray(tags.models)) {
        for (const entry of tags.models) {
          if (!isJson(entry) || readString(entry, "name") !== forOllama()) continue;
          const size = readNumber(entry, "size");
          if (size !== null) bytes = size;
        }
      }
    } catch {
      // The count above is a true count of the bytes ollama reported; a second
      // opinion that cannot be reached changes nothing.
    }

    // The directory rather than the blob: ollama's blobs are named by digest, so
    // the directory is the only path here a person can act on. `path` is promised
    // to the user verbatim and is not drawn by any screen today.
    let path = "";
    try {
      path = await invoke<string>("ollama_models_dir");
    } catch {
      path = "";
    }

    // The contract's last word before the promise settles. Ollama usually says
    // so itself — "verifying sha256 digest" arrives on the stream — and when it
    // does, this must not say it a second time.
    if (!announced) verify();
    finish({
      modelId: request.modelId,
      path,
      bytes: expected() ?? bytes,
      verified: confirmed,
    });
  };

  const begin = () => {
    void pump().then(
      () => {
        if (settled || paused || cancelled) return;
        void settle().catch((from: unknown) => fail(asError(from)));
      },
      (from: unknown) => {
        if (settled || paused || cancelled) return;
        fail(asError(from));
      },
    );
  };

  begin();

  return {
    result,
    pause() {
      if (settled || paused || state !== "downloading") return;
      paused = true;
      state = "paused";
      // The window is dropped rather than kept: a rate that averages across a
      // pause is a rate for a transfer that was not happening.
      samples.length = 0;
      lastEmit = -Infinity;
      emit(true);
      // Killing `curl` leaves ollama's partial blob where it is, which is what
      // makes `resume` a resume: the same request goes out again and ollama
      // carries on from the bytes it already has.
      stopPull();
    },
    resume() {
      if (settled || !paused) return;
      paused = false;
      state = "downloading";
      samples.length = 0;
      lastEmit = -Infinity;
      begin();
    },
    cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      // The partial file stays: that is what makes the next attempt a resume,
      // and it is why stopping costs the user nothing.
      fail(stopped("Download stopped."));
    },
  };
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
 * rather than a paragraph; and it is outside every lane's specialism, so the
 * proof is that the model is running rather than that it is any good at what it
 * was picked for. The arithmetic question the stub uses fails all three — a 1B
 * model answered 17 × 24 as 408 once and 406 the next time, which is a test that
 * cannot tell a working model from a broken one.
 */
const TEST_PROMPT = "What is the capital of France?";

/** What the gateway's own view of this machine looks like, narrowed to the
 *  fields anything here reads. `null` for anything that does not parse: every
 *  caller of this treats an unreadable status as "not registered", which is the
 *  safe direction — it costs a redundant join, never a wrong node. */
interface Status {
  joined: boolean;
  name: string | null;
  nodeId: string | null;
  /** The gateway's view: `null` when it has never heard of this node, or when it
   *  has heard of it and can no longer route to it. */
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

/** What became of the join this app started, as `backend.rs` reads it. */
type JoinState =
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
async function spawnJoin(request: JoinRequest): Promise<void> {
  const started = await read<null>("network_join", {
    // The catalogue id, not the ollama tag: `join.py` resolves the tag from
    // the catalogue itself, and passing the id is what puts a ladder id into
    // `identity.catalogue_id` — so the node is filed under the model the
    // flow's lane screen is showing, rather than under a tag name.
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
  // Set last, on the only path where a process was in fact started. It is what
  // `joinState` reads first: with no attempt made there is no handle in Rust to
  // ask about, and "nothing was started" is a different answer from "it has
  // stopped" — the first would spend a retry, the second is the one that should.
  joined = true;
}

/** The tail of the join's log, as the disclosure line under a failure. This is
 *  the whole reason the log exists: a join fails *out there*, in a process this
 *  one does not own. */
async function joinLog(): Promise<string> {
  try {
    const tail = await invoke<string>("network_join_log", { tail: 8 });
    return tail.trim();
  } catch {
    return "";
  }
}

/** One read of the network's opinion of this node, for the confirming phase. */
async function healthy(): Promise<boolean> {
  const current = await status();
  return current.node !== null && current.node.healthy;
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
 * mean that going back to look at the lane screen silently took the user off the
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
    const say = (phase: JoinProgress["phase"], answered?: JoinProgress["answered"]) =>
      opts?.onProgress?.(answered === undefined ? { phase } : { phase, answered });

    say("registering");

    /**
     * Guard one: something is already serving.
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
     */
    const known = await status();
    const start = await joinState();
    const already = (start !== null && start.state !== "none" && start.state !== "ended") ||
      (known.nodeId !== null && known.node?.healthy === true);
    if (!already) await spawnJoin(request);

    /**
     * The wait, in three parts, each ending on evidence rather than on a timer.
     *
     * **registering** ends when the gateway can reach this node — `node.healthy`,
     * and not the identity appearing on disk. The identity is a *file*, written by
     * whichever join registered last, and it outlives the process that wrote it:
     * reading `nodeId !== null` as "registered" is what once let a join that had
     * died twelve seconds in look exactly like one that had succeeded — through a
     * model load and a ninety-second confirming poll, on a node that had been gone
     * before either began. The token that file holds is what lets a new attempt
     * reclaim the same node rather than mint a second, but reclaiming is not the
     * same as having it.
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
     * after that is the gateway's to notice — which is what the sentence below the
     * log has always claimed, and what this loop used to contradict.
     *
     * **loading-model** and **test-prompt** are the same wait seen two ways, and
     * which one is shown is decided by whether the model is already in memory —
     * `/api/ps` is ollama's list of loaded models, so a cold start says
     * `loading-model` (and the caption, "{size} from disk into memory", is
     * literally what is happening) and a warm one goes straight to "your machine
     * is answering it". **confirming** is the gateway's own answer, polled,
     * because nothing else can give it.
     */
    const DEADLINE = Date.now() + 240_000;
    let registered: Status | null = null;
    let attempts = already ? 0 : 1;
    for (;;) {
      if (signal.cancelled) throw stopped("Stopped.");
      const current = await status();

      // Healthy is the only test here that is not a proxy for something else, and
      // the identity is asked for beside it only so the node id this flow goes on
      // to show is one that exists rather than one it read and then lost.
      if (current.nodeId !== null && current.node?.healthy === true) {
        registered = current;
        break;
      }

      // Nothing of this app's is serving, and — unlike every other reading on this
      // line — that is now something this loop has actually been told rather than
      // inferred: the joined process has ended without handing off, which is the
      // only kind of end a wrapper that has done its job never produces. A join
      // that is still working, or that has handed off and carried on out of sight,
      // never reaches here, so this cannot put a second `join.py` on the worker's
      // port. A read that failed is not an end and does not come here at all.
      const now = await joinState();
      if (now !== null && now.state === "ended") {
        if (attempts >= MAX_JOIN_ATTEMPTS) {
          // Not `network`. This machine started a join, watched it stop, and gave
          // up after three — the gateway was never asked and never refused, so
          // the sentence for an unanswered network is a lie here, and the one the
          // log below is there to disprove. What is left to say is narrower and
          // true: the process ended, and this is how.
          throw new OnboardingError(
            "join-stopped",
            SENTENCE["join-stopped"],
            (await joinLog()) || `the join ${now.code}, ${attempts} times`,
          );
        }
        attempts += 1;
        await spawnJoin(request);
      }

      if (Date.now() > DEADLINE) {
        // The one failure here that is a failure: nothing reachable after four
        // minutes. Which sentence it gets is decided by what the *gateway* said
        // rather than by what this machine thinks of itself. A node the gateway is
        // listing is one it has heard from — it registered, and it cannot be reached
        // — which is a different failure from silence and needs different words.
        // Asking the process instead is what put "nothing came back from the
        // gateway" on screen for a node the gateway was listing.
        const heard = current.nodeId !== null;
        throw new OnboardingError(
          heard ? "timeout" : "network",
          SENTENCE[heard ? "timeout" : "network"],
          (await joinLog()) || (heard ? "the gateway knows this node but cannot reach it" : "nothing registered"),
        );
      }
      await wait(1000);
    }

    if (signal.cancelled) throw stopped("Stopped.");

    const tag = await tagFor(request.modelId);
    if (signal.cancelled) throw stopped("Stopped.");

    // A cold model spends most of the ask loading; a warm one spends all of it
    // answering. Asking ollama which it is turns the phase into a fact.
    const cold = !(await modelIsLoaded(tag));
    say(cold ? "loading-model" : "test-prompt");

    const question = TEST_PROMPT;
    let answer: string;
    let latencyMs: number | null;
    try {
      const raw = await invoke<string>("network_ask_local", { question, model: tag });
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
    say("test-prompt", answered);

    // Confirming. The gateway's own list is polled rather than asked once, because
    // it is populated by the node's worker reaching *it*, and there is a real gap
    // between registering and being marked healthy. A `false` at the end of it is
    // a successful call reporting a failed check.
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
      lane: request.lane,
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

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Whether ollama has the model in memory right now. Unknown counts as cold,
 *  which shows the sentence that is true whether or not it was: a load is what
 *  the first ask after a join always partly is. */
async function modelIsLoaded(tag: string | null): Promise<boolean> {
  if (tag === null) return false;
  try {
    const parsed = (await fetch(`${OLLAMA}/api/ps`).then((response) => response.json())) as unknown;
    if (!isJson(parsed) || !Array.isArray(parsed.models)) return false;
    return parsed.models.some((entry) => isJson(entry) && readString(entry, "name") === tag);
  } catch {
    return false;
  }
}

/* ---------------------------------- the seam ---------------------------------- */

export function createRealService(): OnboardingService {
  return { scanHardware, suggestLane, downloadModel, setLimits, joinNetwork };
}
