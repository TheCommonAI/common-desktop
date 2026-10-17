import { findModel, tierFor } from "./models";
import type { HardwareReport, ResourceLimits, Tier } from "./service";
import { STEP_ORDER, type StepId } from "./steps";

/**
 * What the flow carries, and how it survives being quit.
 *
 * Note what is NOT here: which join phase is underway, which limit question is
 * on screen. Those are processes, and a process cannot be restored into —
 * reopening onto a gauge with nothing behind it is worse than starting the step
 * over. Only what the user has *answered* is carried.
 */

export interface FlowState {
  /** The scan's report, or `null` before it has landed. */
  hardware: HardwareReport | null;
  /** Memory the user typed by hand when the scan could not read it. Kept
   *  beside the report rather than written into it, so a figure typed once does
   *  not poison a later re-scan. */
  memoryOverrideBytes: number | null;
  /** Which of the four models this machine is being set up to serve. Chosen on the
   *  third screen and written through to storage, so the join and the reconnect
   *  both read it back from here rather than deciding again. */
  modelId: string | null;
  /** `null` until the limits have been written. The join request needs a value,
   *  and a default is not the same as an answer. */
  limits: ResourceLimits | null;
}

const KEY = "common.onboarding.progress";

export interface Progress {
  step: StepId;
  flow: FlowState;
}

/** The contribution default, and the one place the scan visibly drives what
 *  comes after it: a machine on battery waits until it is plugged in, and a
 *  machine on mains helps when it is idle. Either way the user's own answer
 *  overwrites it — this is only where the question starts. */
export function defaultLimits(hardware: HardwareReport | null): ResourceLimits {
  return {
    contribute: hardware?.power?.source === "battery" ? "plugged-in" : "idle",
    cap: { cpuPercent: 50, gpuPercent: 40 },
    quietHours: { start: "22:00", end: "07:00" },
  };
}

export const INITIAL_FLOW: FlowState = {
  hardware: null,
  memoryOverrideBytes: null,
  modelId: null,
  limits: null,
};

/* --------------------------------- reading --------------------------------- */

/** The report as the user's hand-entry leaves it. */
export function reportWithOverride(flow: FlowState): HardwareReport | null {
  const hardware = flow.hardware;
  if (hardware === null) return null;
  if (flow.memoryOverrideBytes === null) return hardware;
  return { ...hardware, memory: { totalBytes: flow.memoryOverrideBytes } };
}

/** Which rung of the model ladder this flow is on, or `null` if the memory is
 *  still unknown. */
export function tierOf(flow: FlowState): Tier | null {
  const bytes = reportWithOverride(flow)?.memory?.totalBytes;
  return bytes === undefined ? null : tierFor(bytes);
}

/* -------------------------------- persistence ------------------------------- */

const CONTRIBUTE = ["always", "plugged-in", "idle"] as const;

function isClock(value: unknown): value is string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}

function readLimits(value: unknown): ResourceLimits | null {
  if (typeof value !== "object" || value === null) return null;
  const limits = value as Partial<ResourceLimits>;
  const contribute = CONTRIBUTE.find((c) => c === limits.contribute);
  const cap = limits.cap;
  const quiet = limits.quietHours;
  if (contribute === undefined || typeof cap !== "object" || cap === null) return null;
  if (typeof cap.cpuPercent !== "number" || typeof cap.gpuPercent !== "number") return null;
  if (quiet == null) return { contribute, cap: { cpuPercent: cap.cpuPercent, gpuPercent: cap.gpuPercent }, quietHours: null };
  if (typeof quiet !== "object") return null;
  if (!isClock(quiet.start) || !isClock(quiet.end)) return null;
  return {
    contribute,
    cap: { cpuPercent: cap.cpuPercent, gpuPercent: cap.gpuPercent },
    quietHours: { start: quiet.start, end: quiet.end },
  };
}

/** Whatever was stored, rebuilt field by field. A blob from an older build is
 *  a blob from an older build; every field is independently nullable, so the
 *  honest thing to do with a malformed one is drop it and keep the rest rather
 *  than throw away the user's whole position. */
function readFlow(value: unknown): FlowState {
  const source = (typeof value === "object" && value !== null ? value : {}) as Partial<FlowState>;
  // The model id is checked against the ladder, not merely for being a string. A
  // flow written by a build whose ladder was a different ladder holds ids this one
  // has never heard of, and `spawnJoin` sends whatever is here straight to
  // `common join --model` — where an id the catalogue does not know is not an
  // error, it is read as an Ollama registry tag. So a stale id is a node
  // provisioned out of the wrong catalogue, quietly, and dropping it here is what
  // stops that: the step machine then walks back to the screen that picks one.
  const modelId =
    typeof source.modelId === "string" && findModel(source.modelId) !== null ? source.modelId : null;
  return {
    hardware: typeof source.hardware === "object" && source.hardware !== null ? source.hardware : null,
    memoryOverrideBytes:
      typeof source.memoryOverrideBytes === "number" ? source.memoryOverrideBytes : null,
    modelId,
    limits: readLimits(source.limits),
  };
}

/** Whether a step has everything it needs to be shown. */
function canEnter(step: StepId, flow: FlowState): boolean {
  switch (step) {
    case "welcome":
    case "scan":
      return true;
    case "model":
      return flow.hardware !== null;
    case "limits":
      return flow.modelId !== null;
    case "join":
      return flow.modelId !== null && flow.limits !== null;
  }
}

/** The stored step, walked back to the last one this data supports. Restoring
 *  into a step whose input is missing would show a screen with nothing behind
 *  it. */
function lastEnterable(step: StepId, flow: FlowState): StepId {
  let index = STEP_ORDER.indexOf(step);
  while (index > 0 && !canEnter(STEP_ORDER[index], flow)) index -= 1;
  return STEP_ORDER[index];
}

/** Read the position. Returns `null` for "start at the top", which is also what
 *  every failure means — a storage that will not answer must never cost the
 *  user the window. Same discipline as `App.tsx`'s opening. */
export function readProgress(): Progress | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { step?: unknown; flow?: unknown };
    if (typeof parsed !== "object" || parsed === null) return null;
    const flow = readFlow(parsed.flow);
    const step = STEP_ORDER.find((s) => s === parsed.step);
    if (step === undefined) return null;
    return { step: lastEnterable(step, flow), flow };
  } catch {
    return null;
  }
}

export function writeProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Nothing to do. The flow simply starts at the top next time.
  }
}

/* ------------------------------ the same answers ----------------------------- */

/**
 * The answers, for a surface that is not the flow.
 *
 * Settings asks the same questions the flow asked and must give the same
 * answers, so it reads and writes this one record rather than opening a second
 * store beside it. Two stores would mean two truths about how much of this
 * machine the network may use, and there is no version of that which is fine.
 *
 * `null` means nothing has ever been answered here, which is a real state — a
 * machine handed a finished build, or a storage that will not answer — and not
 * an error. Callers fall back to `defaultLimits(...)`.
 */
export function readStoredFlow(): FlowState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { flow?: unknown };
    if (typeof parsed !== "object" || parsed === null) return null;
    return readFlow(parsed.flow);
  } catch {
    return null;
  }
}

/**
 * Write one answer back, leaving everything else exactly as it was found.
 *
 * The stored `step` is written back verbatim rather than recomputed. Settings is
 * not a position in the flow, and a dialog that silently moved where the user
 * resumes from would be the last surface that should. The one exception is a
 * record that does not exist at all: `lastEnterable` on read walks a step back
 * to what the data supports, so a flow written from nothing lands at the end of
 * the flow, which reads as "go on to the chat".
 */
export function patchStoredFlow(patch: Partial<FlowState>): void {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    const stored = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
      step?: unknown;
      flow?: unknown;
    };
    const flow: FlowState = { ...readFlow(stored.flow), ...patch };
    const step = STEP_ORDER.find((s) => s === stored.step) ?? STEP_ORDER[STEP_ORDER.length - 1];
    localStorage.setItem(KEY, JSON.stringify({ step, flow }));
  } catch {
    // As everywhere else: a storage that will not answer costs the user the
    // setting, never the window.
  }
}
