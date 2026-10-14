import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

/**
 * The two things the chat asks of the machine.
 *
 * Both go through Rust rather than straight at the CLI or the gateway, for a
 * reason that is not stylistic: the gateway sends no CORS headers, so a webview
 * cannot call it directly, and `common` is a process. Rust is the only thing on
 * this side of the app that can do either.
 *
 * Neither is the onboarding's `OnboardingService`, and they are not a second
 * contract. That interface exists to be implemented twice and to survive a
 * backend being swapped underneath it. These are two calls with a return value
 * each and no state machine between them, and dressing them up in a `Task<T>`
 * would be inventing ceremony for two lines of `invoke`.
 */

/**
 * Are we the app, or a browser looking at the app's page?
 *
 * It matters because `invoke` throws outside the app, and because a page opened
 * in a browser is how this screen gets reviewed. Tauri v2 puts this on `window`
 * before the bundle runs, so it is readable from module scope by the time
 * anything calls in.
 */
function insideApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Whether the gateway can route to this machine — the same question the join
 * screen ends on, asked again later, because the answer is allowed to change.
 *
 * `joined` is not the question. It says an identity exists on disk, which stays
 * true forever once it is written and is therefore no evidence of anything right
 * now. `node` is the gateway's own view of us, and it is what the sidebar shows.
 *
 * Nor is *listing* the question. The gateway keeps a node in `/nodes` for a
 * while after it stops answering, and it marks the entry `healthy: false` in the
 * meantime — so presence says "we have heard of this machine", and the green bar
 * is a claim about routing. It needs the field that means routing.
 */
export async function gatewaySeesUs(): Promise<boolean> {
  if (!insideApp()) return true;
  const raw = await invoke<string>("network_status");
  const status = JSON.parse(raw) as { node?: { healthy?: unknown } | null };
  return status.node?.healthy === true;
}

/** What the network answered, and which machines answered it. */
export interface NetworkAnswer {
  answer: string;
  /** The machine that answered, as the gateway names it. `null` when the network
   *  composed the answer instead — see `panel`. */
  node: string | null;
  /** The machines that answered this together, when the network judged the
   *  question to want more than one. Empty for the ordinary answer, which is one
   *  machine, one model, one reply. */
  panel: readonly string[];
  /** The whole request, routing and model load included. `null` when the CLI
   *  could not separate the answer's time from the process's own startup — a
   *  number that is partly the machine waking up is worse than no number. */
  totalMs: number | null;
}

/**
 * Ask the network.
 *
 * This is `common ask`, the CLI's own default: the question goes to the gateway
 * and the gateway routes it. Not `--local`, which is a different product — it
 * skips the network and takes whatever model this machine's Ollama lists first,
 * so a machine contributing one specialist answers every question with that
 * specialist. The machine the user is sitting on is one node among the network's,
 * and it is not privileged.
 */
export async function askNetwork(question: string): Promise<NetworkAnswer> {
  if (!insideApp()) return PREVIEW_ANSWER;
  const raw = await invoke<string>("network_ask", { question });
  const parsed = JSON.parse(raw) as {
    answer?: unknown;
    node?: unknown;
    panel?: unknown;
    total_ms?: unknown;
  };
  if (typeof parsed.answer !== "string") {
    throw new Error("the network returned nothing readable");
  }
  return {
    answer: parsed.answer,
    node: typeof parsed.node === "string" ? parsed.node : null,
    panel: Array.isArray(parsed.panel)
      ? parsed.panel.filter((name): name is string => typeof name === "string")
      : [],
    totalMs: typeof parsed.total_ms === "number" ? parsed.total_ms : null,
  };
}

/**
 * Let go of the question that is out on the network.
 *
 * Reaches past the promise above to the process behind it. `network_ask` waits
 * up to four minutes for a routed answer — `REQUEST_TIMEOUT_SECONDS` in the CLI
 * — and the machine serving it is a donated one that somebody else's question
 * could be using. So merely not listening is not enough: unless the process is
 * killed, the transcript says a question was abandoned while the network goes on
 * spending a node to answer it.
 */
export function stopAsk(): void {
  if (!insideApp()) return;
  // Fire and forget. The caller has already decided it does not want the answer,
  // so a failure here — the app unable to reach its own Rust side — is not
  // something the person who pressed stop could act on.
  invoke("network_ask_stop").catch(() => {});
}

/* -------------------------------- the machine -------------------------------- */

/**
 * This machine's standing on the network, as the network records it.
 *
 * Every field is nullable and `null` is the honest value throughout, because
 * "the CLI did not answer" and "the CLI answered that there is nothing" are
 * different facts and the card says different things about each. `name` is the
 * identity the gateway knows this machine by; the node id is not shown — it is
 * a UUID with no human use, whereas the name is what the user would recognise.
 */
export interface Whoami {
  name: string;
  gateway: string;
  /** The catalogue model the gateway has this machine filed under, which is not
   *  necessarily the one the flow downloaded. */
  catalogueId: string | null;
}

/** How much this machine has actually contributed. */
export interface Contrib {
  /** Questions this machine answered, over the gateway's last 500 logged. */
  requestsServed: number;
  /** How many of those came back clean. `null` when the figure is not reported. */
  ok: number | null;
}

/**
 * Who this machine is to the network.
 *
 * `common whoami --json` prints the literal `null` when it has never joined, so
 * a missing identity is a `null` return and not a throw — the card then shows
 * the lane it chose locally and says nothing about a name it does not have.
 */
export async function whoami(): Promise<Whoami | null> {
  if (!insideApp()) return null;
  const raw = await invoke<string>("network_whoami");
  const parsed = JSON.parse(raw) as {
    name?: unknown;
    gateway?: unknown;
    catalogue_id?: unknown;
  } | null;
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof parsed.name !== "string") return null;
  return {
    name: parsed.name,
    gateway: typeof parsed.gateway === "string" ? parsed.gateway : "",
    catalogueId: typeof parsed.catalogue_id === "string" ? parsed.catalogue_id : null,
  };
}

/** How much this machine has served. Zero is a real answer and is shown as one. */
export async function contrib(): Promise<Contrib | null> {
  if (!insideApp()) return null;
  const raw = await invoke<string>("network_contrib");
  const parsed = JSON.parse(raw) as { requests_served?: unknown; ok?: unknown };
  if (typeof parsed.requests_served !== "number") return null;
  return {
    requestsServed: parsed.requests_served,
    ok: typeof parsed.ok === "number" ? parsed.ok : null,
  };
}

/**
 * Deregister this machine and forget its identity.
 *
 * Not reversible from here — the node token is discarded, so rejoining mints a
 * new identity rather than reclaiming the old one. That is why the card asks
 * first and why this is the last row in it.
 */
export async function leaveNetwork(): Promise<void> {
  if (!insideApp()) return;
  await invoke<string>("network_leave");
}

/* --------------------------------- the report --------------------------------- */

/**
 * This machine's identity, taken apart for a report.
 *
 * There is no node token here because there is no node token in the Rust struct
 * either — see `IdentitySummary` there. It is the credential the gateway knows
 * this machine by and a report is a thing that gets pasted into a chat window,
 * so it is left out at the point where the file is read rather than filtered out
 * afterwards, where a later edit could quietly stop filtering it.
 */
export interface IdentitySummary {
  gateway: string | null;
  name: string | null;
  nodeId: string | null;
  catalogueId: string | null;
  domainTags: readonly string[];
  /** Unix seconds. Kept a number so the date is written in the reader's own
   *  timezone, which only this side of the app knows. */
  joinedAt: number | null;
}

/**
 * Everything the app can say about this machine, for the times it will not
 * connect.
 *
 * Read-only, and read from disk: no network call is made to produce it, because
 * the moment it is wanted is the moment nothing can be reached. Each field that
 * can be missing carries its own `null`, and the two that can fail carry their
 * own error, so a machine that has never joined and has no CLI still produces a
 * full report — and the report is then a list of exactly what is absent, which
 * is the useful shape for the person reading it.
 */
export interface Diagnostics {
  appVersion: string;
  appIdentifier: string;
  osPlatform: string;
  osVersion: string;
  /** Read from `common --version`. `null` when the CLI is missing or refused. */
  cliVersion: string | null;
  /** The path the app actually runs. The first thing to check when the `common`
   *  on `PATH` is not the one in use. */
  cliPath: string;
  gateway: string;
  joined: IdentitySummary | null;
  identityPath: string;
  /** Why the identity could not be read. `joined: null` with no error here means
   *  there is simply no identity — never joined, which is a state, not a fault. */
  identityError: string | null;
  logPath: string;
  logBytes: number | null;
  logModified: number | null;
  /** The end of the join log, which is where a failure is. `null` when there is
   *  no log at all. */
  logTail: string | null;
  logError: string | null;
}

/**
 * Gather the report.
 *
 * Deliberately not wrapped in a try/catch that falls back to something: if the
 * Rust side cannot answer, there is no report, and a page of placeholders would
 * be a worse thing to hand to somebody than an error saying so.
 */
export async function diagnostics(): Promise<Diagnostics> {
  if (!insideApp()) return PREVIEW_DIAGNOSTICS;
  return await invoke<Diagnostics>("diagnostics");
}

/**
 * Write the report to a file and open the folder it landed in.
 *
 * The name is built here rather than in Rust because only this side knows the
 * reader's timezone, and the text is passed through rather than regenerated so
 * that the file and what is on the clipboard are the same bytes. Rust narrows
 * the name to safe characters before it becomes a path.
 *
 * Returns the path written. A failure to open the folder is not a failure to
 * write — the file is already there — so only a failure to write throws.
 */
export async function saveDiagnostics(name: string, text: string): Promise<string> {
  if (!insideApp()) throw new Error("Can't save a report outside the app.");
  return await invoke<string>("save_diagnostics", { name, text });
}

/** A version the release manifest is offering. */
export interface AvailableUpdate {
  /** The version on offer. */
  version: string;
  /** The release's own note, when the manifest carries one. */
  notes: string | null;
  /** The manifest's `pub_date`, passed through as written. The reader's own
   *  timezone is a thing only this side knows, so the string is not parsed
   *  into a date until something has to show it. */
  pubDate: string | null;
}

/** What a check found. `available: null` means the running version is the
 *  newest one — not that the check failed, which throws instead. */
export interface UpdateStatus {
  current: string;
  available: AvailableUpdate | null;
}

/**
 * Ask whether there is a newer version. Downloads nothing.
 *
 * Throws when the manifest cannot be reached, rather than reporting "up to
 * date". The two are different things and only one of them is fine, and a
 * failure that reads as success is how an app goes a year without updating.
 */
export async function updateCheck(): Promise<UpdateStatus> {
  if (!insideApp()) return PREVIEW_UPDATE;
  return await invoke<UpdateStatus>("update_check");
}

/**
 * Fetch the offered update and write it to disk, without restarting.
 *
 * Returns the version now staged, or `null` when there was nothing to stage.
 * The download is verified against a signature before anything is written, so
 * this is also where a corrupted or tampered update fails.
 *
 * Split from `updateCheck` so the app can be quiet: a check that finds nothing
 * is never mentioned, and by the time this returns the slow part is done.
 */
export async function updateStage(): Promise<string | null> {
  if (!insideApp()) throw new Error("There is nothing to update outside the app.");
  return await invoke<string | null>("update_stage");
}

/**
 * Relaunch into the staged version.
 *
 * Does not resolve: the process is replaced, so the promise this returns is
 * never settled. Callers must not wait on it to decide anything — set the
 * state that means "restarting" first, and let this be the last thing.
 */
export async function updateRestart(): Promise<void> {
  if (!insideApp()) throw new Error("There is nothing to restart outside the app.");
  await invoke<null>("update_restart");
}

/**
 * The version of the app that is running.
 *
 * This is the one update fact that is always available, so it is asked for
 * separately rather than taken from a check. A check is throttled — see
 * `INTERVAL_MS` — and may not have run at all — but the Settings card has to be
 * able to name the version it is offering to move off, at any moment, whether or
 * not anything was fetched. This reads the bundle's own version: local, no network,
 * no manifest.
 */
export async function appVersion(): Promise<string> {
  if (!insideApp()) return PREVIEW_UPDATE.current;
  return await getVersion();
}

/** The stand-in, for a page running outside the app. */
export const PREVIEW_DIAGNOSTICS: Diagnostics = {
  appVersion: "0.2.0",
  appIdentifier: "au.com.commonai.desktop",
  osPlatform: "preview",
  osVersion: "",
  cliVersion: null,
  cliPath: "not the app",
  gateway: "not the app",
  joined: null,
  identityPath: "not the app",
  identityError: null,
  logPath: "not the app",
  logBytes: null,
  logModified: null,
  logTail: "There is no log here. This is the browser preview, not the app.",
  logError: null,
};

/**
 * The stand-in, for a page running outside the app.
 *
 * A stub rather than an error, on the same footing as `service.stub.ts`: this
 * screen is reviewed in a browser, and a transcript that cannot be seen cannot
 * be judged. It is written so that nothing it says is untrue *of the preview* —
 * it says there is no network here, because there is not — which is the one
 * thing a stand-in can do that inventing an answer cannot.
 */
const PREVIEW_ANSWER: NetworkAnswer = {
  answer:
    "There's no network behind me here. This is the browser preview, not the app; " +
    "in the app the question goes out to the network and a machine answers it.",
  node: null,
  panel: [],
  totalMs: null,
};

/**
 * The stand-in, for a page running outside the app.
 *
 * It offers an update, which it did not used to, and the argument for the change
 * is the argument the other stubs make: a surface that cannot be reached without
 * building the app is a surface that gets reviewed by whoever remembers what it
 * looked like last time. The update card is the newest of those, and both ordinary
 * routes to it are shut in development — `update.rs` answers `available: null` on a
 * dev build, deliberately, since a dev build hitting the real manifest would offer
 * an update to a version that has no build behind it. So without this the card would
 * first be seen by a user.
 *
 * The line that still holds is the one about *acting* on a lie. `updateStage` and
 * `updateRestart` throw outside the app, so pressing `Install` here reports the
 * failure rather than pretending to have fetched anything, and nothing can be left
 * half-staged. That is the difference between previewing an offer and previewing an
 * install, and it is why an `available` is honest where a `staged` would not be.
 *
 * `current` is what the browser reports as the running version and should be kept in
 * step with the release; `available` is a whole minor ahead so that the card has
 * something unambiguous to name, and so that the two never have to be compared.
 */
export const PREVIEW_UPDATE: UpdateStatus = {
  current: "0.2.4",
  available: { version: "0.3.0", notes: null, pubDate: null },
};
