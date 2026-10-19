/**
 * The model group's settings, and the rules the panel applies to them.
 *
 * A group is one model split across RPC devices, served by a local coordinator.
 * The Rust side (`src-tauri/src/group.rs`) reads the group's file, probes the
 * coordinator and starts it. This file decides what the panel may ask for and how
 * it reads the answer, and it has no imports, so `tests/model-group.test.mjs` can
 * load it as it is.
 */

/** The port the panel probes when nothing has been chosen. Not the CLI's port: that
 *  one is `CLI_COORDINATOR_PORT` below, and the coordinator binds it whatever the
 *  panel says. */
export const DEFAULT_GROUP_PORT = 11437;

/** The port the CLI's coordinator binds. `--local-only` has no option to change it,
 *  so the panel can start a coordinator only on this one, and says so. */
export const CLI_COORDINATOR_PORT = 11436;

/** Below 1024 needs privileges that nothing the coordinator does needs. */
export const MIN_GROUP_PORT = 1024;
export const MAX_GROUP_PORT = 65535;

/** The range `draft_tokens` may take, as the CLI states it. The panel's control reads
 *  whatever value the file holds, so no other default lives here. */
export const DRAFT_TOKENS_MIN = 1;
export const DRAFT_TOKENS_MAX = 32;

/** How often the panel asks for the status while it is open. */
export const GROUP_POLL_MS = 2000;

export interface GroupSettings {
  /** The group's network.json, as typed. Empty when no group is chosen. */
  configPath: string;
  /** The port the panel probes and, where the CLI allows it, starts on. */
  port: number;
}

export const DEFAULT_SETTINGS: GroupSettings = { configPath: "", port: DEFAULT_GROUP_PORT };

export type GroupHealth = "ready" | "loading" | "stopped";

export type GroupProcess =
  | { state: "none" }
  | { state: "running" }
  | { state: "ended"; code: string };

/** The answer `group_status` gives. Mirrors `GroupStatus` in `group.rs`. */
export interface GroupStatus {
  configured: boolean;
  problem: string | null;
  modelName: string | null;
  devices: number | null;
  draftTokens: number;
  health: GroupHealth;
  coordinator: GroupProcess;
  port: number;
}

/** Whether a value is a port the panel will take. */
export function isGroupPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_GROUP_PORT && value <= MAX_GROUP_PORT;
}

/** A draft length as the control may write it: rounded, and held inside the range.
 *  `null` for a value that is not a number at all, so the control keeps its value. */
export function clampDraftTokens(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(DRAFT_TOKENS_MAX, Math.max(DRAFT_TOKENS_MIN, Math.round(value)));
}

/** The settings as they were stored. Anything unreadable falls back to the defaults
 *  field by field, so one bad value does not discard the other. */
export function readSettings(raw: string | null): GroupSettings {
  if (raw === null) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_SETTINGS };
  const record = parsed as Record<string, unknown>;
  return {
    configPath: typeof record.configPath === "string" ? record.configPath : "",
    port:
      typeof record.port === "number" && isGroupPort(record.port)
        ? record.port
        : DEFAULT_GROUP_PORT,
  };
}

export function healthLabel(health: GroupHealth): string {
  switch (health) {
    case "ready":
      return "Ready";
    case "loading":
      return "Loading";
    case "stopped":
      return "Stopped";
  }
}

/** The sentence that says what the group is, or why it is not one. */
export function groupFact(status: GroupStatus): string {
  if (!status.configured || status.modelName === null) {
    return status.problem ?? "No group is chosen.";
  }
  const devices = status.devices ?? 0;
  return `${status.modelName}, across ${devices} RPC ${devices === 1 ? "device" : "devices"}.`;
}

/** Why Start cannot be pressed, or `null` when it can. */
export function startBlock(status: GroupStatus, port: number): string | null {
  if (status.coordinator.state === "running") return "The coordinator is already running.";
  if (!status.configured) return "Choose a group's network.json first.";
  if (port !== CLI_COORDINATOR_PORT) {
    return `The CLI serves the coordinator on ${CLI_COORDINATOR_PORT}, so this group starts only on ${CLI_COORDINATOR_PORT}.`;
  }
  return null;
}
