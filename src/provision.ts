import { Channel, invoke } from "@tauri-apps/api/core";
import { formatBytes, formatTransfer } from "./onboarding/copy";

/**
 * The one install.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * Installing this app is supposed to be the only install. It ships the CLI in
 * its own bundle, and `fetch.rs` fetches the other two things a node needs that
 * the user should never be asked for — a Python to run the CLI with, and the
 * cloudflared that opens the tunnel. That bootstrap has been written, compiled
 * and registered as three Tauri commands for several releases, and nothing on
 * this side of the bridge had ever called it. So on a clean machine the join got
 * all the way to the tunnel and stopped, and the last line of `join.log` was the
 * CLI's own advice to go and install cloudflared by hand.
 *
 * This file is the caller.
 *
 * ── Why it runs at app start, and is not a step in the flow ──────────────────
 *
 * The obvious place is a seventh screen in the onboarding machine: the flow
 * already knows how to draw a wait and the service already knows how to stream
 * one. It is the wrong place, and the reason is the whole point of the feature.
 * A machine updating from an earlier release has *finished* onboarding and will
 * never see a step again — so a provisioning step would skip precisely the
 * population that has the missing pieces. The already-installed machine is the
 * case this exists for, so it runs at launch, for every machine, in the
 * background, and the screens read it instead of starting it.
 *
 * ── The shape, and why it is not a `Task<T>` ─────────────────────────────────
 *
 * There is no `cancel`. A `Task` is something one screen started and one screen
 * may abandon; this is one machine-wide fetch of two small files that everything
 * downstream needs, and a Back button that killed it would mean walking backwards
 * through setup took the Python away again. It runs to the end, and the only
 * reason it stops is the app quitting.
 *
 * Nor is it in `OnboardingService`. That contract exists to be implemented twice
 * so the screens can be reviewed in a browser, and every member of it is the
 * onboarding flow's. This belongs to the app, and the chat needs it as much as
 * the flow does — see `service.real.ts`'s `awaitServing`, which both join paths
 * go through.
 *
 * The decisions worth pinning are exported and pure — `missingFrom` and
 * `preparingSentences` — and `tests/provision.test.mjs` runs them against the
 * real source, for the reason the other two test files give.
 */

/* ---------------------------------- wire ---------------------------------- */

/** One payload, as `bootstrap_status` describes it before anything is fetched.
 *  A mirror of `PayloadStatus` in `fetch.rs`, which is the authority on every
 *  field but the two names it re-cases. */
export interface PayloadStatus {
  payload: string;
  label: string;
  version: string;
  url: string;
  present: boolean;
  detail: string;
  /** Why this machine cannot install it, or `null` when it can. */
  blocked: string | null;
  /** `"pinned"` or `"published"` — how the bytes would be checked. */
  checksum: string;
}

/** The bootstrap's own progress messages, mirroring `BootstrapEvent`.
 *
 *  Every variant but `downloading` and `done` names one payload rather than
 *  carrying its label, so the label map above is what turns an id back into
 *  something readable. */
export type BootstrapEvent =
  | { kind: "checking"; payload: string; label: string }
  | { kind: "present"; payload: string; detail: string }
  | { kind: "unavailable"; payload: string; message: string }
  | { kind: "downloading"; payload: string; received: number; total: number | null }
  | { kind: "verifying"; payload: string }
  | { kind: "installing"; payload: string }
  | { kind: "installed"; payload: string; detail: string }
  | { kind: "failed"; payload: string; message: string }
  | { kind: "done"; present: number; installed: number; unavailable: number; failed: number };

/** Where this machine has got to.
 *
 *  Five states rather than a flag and a message, because four of them are
 *  genuinely different screens and only one is a problem: `ready` is the ordinary
 *  answer and is reached without asking the network anything, `idle` is the frame
 *  before the first probe lands, `checking` is the probe itself, `working` is the
 *  only state with anything happening in it, and `failed` means the machine still
 *  cannot run a join — which the join will then say for itself, in its own
 *  sentence, rather than being made to wear this one. */
export type Provision =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "working";
      step: "download" | "verify" | "install";
      label: string;
      receivedBytes: number;
      totalBytes: number | null;
    }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

/* ------------------------------- the decisions ------------------------------- */

/**
 * What is absent and could be installed here.
 *
 * Present and blocked are different questions and only one of them is a wait.
 * `present` is the machine already having it. `blocked` is the app knowing it
 * cannot put it there — a platform with nothing published for it, which is a
 * real answer and not a failure — so a payload in that state is not something to
 * download and not something to wait for either.
 *
 * The test is on a non-empty string rather than on `null`, so that a field that
 * arrived missing, or arrived as an empty string, is read as installable. Between
 * the two ways of being wrong that is the harmless one: an unnecessary download
 * that reports what went wrong beats a machine silently deciding not to try.
 */
export function missingFrom(statuses: readonly PayloadStatus[]): PayloadStatus[] {
  return statuses.filter((status) => {
    const blocked = typeof status.blocked === "string" && status.blocked.length > 0;
    return !status.present && !blocked;
  });
}

/**
 * What the join screen says while it waits for this.
 *
 * Here rather than in the screen for the reason `networkFact` is in `rejoin.ts`:
 * the wording is the part a test can hold still. It is also the part most likely
 * to be got wrong later, since the obvious sentence — "preparing this machine" —
 * is right for three of these states and a lie in the fourth.
 *
 * Which fourth: `failed`. There is nothing left to wait for once the fetch has
 * given up, so the caption says what is happening instead (the join going ahead
 * anyway, and about to report its own reason), rather than a promise of further
 * news that has already been broken.
 */
export function preparingSentences(provision: Provision): {
  statement: string;
  caption: readonly (string | null)[];
} {
  const statement = "Getting this machine ready.";
  switch (provision.kind) {
    case "working": {
      // The verb changes with the step, because the three are not one action and
      // the first clause is what the user reads: a line that went on saying
      // "Fetching" while the bytes were already in hand and being hashed would
      // be describing a download that had finished as one still running, which
      // is the confusion `BootstrapEvent` splits these variants to avoid in the
      // first place.
      const [doing, progress] =
        provision.step === "download"
          ? [`Fetching ${provision.label}`, transfer(provision.receivedBytes, provision.totalBytes)]
          : provision.step === "verify"
            ? [`Checking ${provision.label}`, "Making sure it arrived whole"]
            : [`Installing ${provision.label}`, "Putting it in place"];
      return { statement, caption: [doing, progress] };
    }
    case "idle":
    case "checking":
      return { statement, caption: ["Seeing what's already here"] };
    case "ready":
      return { statement, caption: ["Nothing to fetch"] };
    case "failed":
      // Read for one frame at most, if at all: the join gives up on the wait the
      // moment the fetch does and says its own sentence about the same machine.
      // It says the true thing for that frame rather than a promise of news that
      // has stopped coming.
      return { statement, caption: ["Carrying on without it"] };
  }
}

/** The one line of a transfer, in the units the rest of the app counts in. */
function transfer(receivedBytes: number, totalBytes: number | null): string {
  // No total until the far side sends a length, and a bar with no end is worse
  // than no bar — the same decision `DownloadModel` makes for a transfer that has
  // started without one.
  return totalBytes === null
    ? `${formatBytes(receivedBytes)} downloaded`
    : formatTransfer(receivedBytes, totalBytes);
}

/* -------------------------------- the runner -------------------------------- */

let state: Provision = { kind: "idle" };
let inFlight: Promise<Provision> | null = null;
const watchers = new Set<(next: Provision) => void>();

function publish(next: Provision): void {
  state = next;
  for (const watcher of watchers) watcher(next);
}

/** Where it has got to right now, for a screen that is rendering.
 *
 *  Not a subscription, and it is not enough on its own: a caller has to have
 *  started it — see `startProvisioning` — for there to be anything to read. */
export function provisionNow(): Provision {
  return state;
}

/** Watch it, for the one screen that draws the transfer. Returns the way out,
 *  shaped for a `useEffect` cleanup. */
export function watchProvision(watcher: (next: Provision) => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/**
 * Make sure this machine has what a join needs, then say where it ended up.
 *
 * Safe to call from anywhere and as often as you like: the second caller joins
 * the first one's promise rather than starting a second fetch. That matters
 * because both entry points are real — `App` calls it at launch, and
 * `awaitServing` calls it before a join in case a launch did not happen to be
 * this process's — and because React StrictMode mounts an effect twice.
 *
 * It never rejects. Every way this can go wrong ends as `failed`, which is an
 * answer rather than an error: nothing here is the thing the user asked for, so
 * nothing here is worth an error screen. The join that wanted this is a moment
 * away from reporting its own reason in its own words.
 */
export function startProvisioning(): Promise<Provision> {
  inFlight ??= run();
  return inFlight;
}

async function run(): Promise<Provision> {
  publish({ kind: "checking" });

  const known = await ask();
  // A dry run that will not answer is not evidence that anything is missing, and
  // an empty list is the ordinary machine — everything a node needs is already
  // there, so this costs one probe and not one request. Both are `ready` for the
  // same reason: the question this is answering is "is there anything for a join
  // to wait for", and the answer to that is no.
  const missing = known === null ? [] : missingFrom(known);
  if (missing.length === 0) {
    publish({ kind: "ready" });
    return state;
  }

  // Every payload, not just the missing ones, and that is the command's own
  // design: `bootstrap_run` probes before it fetches, so a payload that is
  // already installed costs one `--version` and no bytes. Naming only the missing
  // ones would mean N invokes, N channels and N summaries to reassemble what one
  // call already says.
  const labels = new Map((known ?? []).map((one) => [one.payload, one.label]));

  let label = missing[0]?.label ?? "";
  let receivedBytes = 0;
  let totalBytes: number | null = null;
  let said = "";

  const show = (step: "verify" | "install" | "download", name: string) =>
    publish({ kind: "working", step, label: name, receivedBytes, totalBytes });

  const channel = new Channel<BootstrapEvent>();
  channel.onmessage = (event: BootstrapEvent) => {
    switch (event.kind) {
      case "checking":
        // A new payload. Its bytes are not known yet, and keeping the last one's
        // would draw the previous file's progress bar over this one's name.
        label = event.label;
        receivedBytes = 0;
        totalBytes = null;
        show("download", label);
        break;
      case "downloading":
        receivedBytes = event.received;
        totalBytes = event.total;
        show("download", labels.get(event.payload) ?? label);
        break;
      case "verifying":
        // The size deliberately stays: the bytes are in hand and being checked,
        // and a caption that dropped from "19 of 19 MB" to nothing at the moment
        // the digest is computed would read as the download having restarted.
        show("verify", labels.get(event.payload) ?? label);
        break;
      case "installing":
        show("install", labels.get(event.payload) ?? label);
        break;
      case "failed":
        // Kept for the summary below, which prefers the payload's own sentence to
        // one this file would have to invent. The screen is not told yet: one
        // payload failing is not the run failing, and there is usually another
        // one behind it.
        said = event.message;
        break;
      default:
        // `present`, `unavailable`, `installed` and `done` carry no state of
        // their own. What each of them means for this machine is asked again
        // below rather than totalled from the stream, which is the difference
        // between knowing what happened and adding it up.
        break;
    }
  };

  try {
    await invoke("bootstrap_run", { only: null, onEvent: channel });
  } catch (why) {
    publish({ kind: "failed", message: said || complaint(why) });
    return state;
  }

  // Asked, rather than inferred from the counts. The summary would have to
  // decide which of `unavailable` and `failed` matters for *this* machine, and it
  // cannot: what a join needs is Python on disk and cloudflared on disk, and the
  // second probe is the only thing that answers that. It also survives the case
  // the counts cannot see at all — a payload that installed and then did not
  // work.
  const after = await ask();
  const left = after === null ? [] : missingFrom(after);
  if (left.length === 0) {
    publish({ kind: "ready" });
    return state;
  }

  publish({
    kind: "failed",
    message: said || `${left.map((one) => one.label).join(", ")} did not install`,
  });
  return state;
}

/** What is missing, or `null` when the machine will not say.
 *
 *  A refused `invoke` is caught here rather than propagated, and that is the one
 *  place this file is deliberately incurious. It refuses outside the app, which
 *  is how the screens get reviewed in a browser, and it refuses in the app if the
 *  command itself is missing — and neither is a thing to report to a user who
 *  asked for none of it. `null` means "no answer", which is not "nothing
 *  missing"; the two are separated at the call sites, where the difference
 *  matters. */
async function ask(): Promise<PayloadStatus[] | null> {
  try {
    const answer = await invoke<PayloadStatus[]>("bootstrap_status");
    return Array.isArray(answer) ? answer : null;
  } catch {
    return null;
  }
}

/** Tauri rejects with a string, but a command that panicked can arrive as
 *  anything, and a message is being built out of this either way. */
function complaint(why: unknown): string {
  if (typeof why === "string") return why;
  if (why instanceof Error) return why.message;
  return "the fetch stopped without saying why";
}
