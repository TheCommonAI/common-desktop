import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_SETTINGS,
  readSettings,
  type GroupSettings,
  type GroupStatus,
} from "./group-config";

/**
 * The panel's seam to the machine, and where its settings are kept.
 *
 * The four commands are in `src-tauri/src/group.rs`. Every one of them goes through
 * Rust, for the reason `backend.ts` gives: the file and the process are on this
 * machine, and the page's CSP does not let it reach the coordinator's port itself.
 *
 * The settings are the panel's own choices, so they are kept in the webview's
 * storage like the rest of the onboarding record, and read back defensively: a
 * private window or a blocked store falls back to the defaults and the panel still
 * renders.
 */

const KEY = "common.group.settings";

export function readStoredSettings(): GroupSettings {
  try {
    return readSettings(localStorage.getItem(KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeStoredSettings(settings: GroupSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // The choice still holds for this session in the panel's state. It just will
    // not survive a restart, and nothing here can say more usefully than that.
  }
}

export function groupStatus(settings: GroupSettings): Promise<GroupStatus> {
  return invoke<GroupStatus>("group_status", {
    configPath: settings.configPath,
    port: settings.port,
  });
}

export function startGroup(settings: GroupSettings): Promise<void> {
  return invoke<void>("group_start", {
    configPath: settings.configPath,
    port: settings.port,
  });
}

/** Resolves `true` when a coordinator this app started was stopped. */
export function stopGroup(): Promise<boolean> {
  return invoke<boolean>("group_stop");
}

/** The value written, as the Rust side stored it. */
export function setDraftTokens(configPath: string, draftTokens: number): Promise<number> {
  return invoke<number>("group_set_draft_tokens", { configPath, draftTokens });
}
