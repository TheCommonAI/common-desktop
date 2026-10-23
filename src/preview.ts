import type { StepId } from "./onboarding/steps";

/**
 * Jumping to a screen, for review in a browser.
 *
 * A page opened in a browser is how these screens get looked at without building
 * the app, but the flow needs clicks and the scripted peer needs time. These query
 * parameters skip both: `?step=` opens the flow at a screen, `?chat=1` opens the
 * chat, `?settings=1` opens the card over it, and `?at=SECONDS` starts the scripted
 * peer already that far into its arrival (see `peer/stub.ts`).
 *
 * Inside the app every one of them is ignored, so nothing here can change what a
 * user sees.
 */

export interface Preview {
  step: StepId | null;
  chat: boolean;
  settings: boolean;
  at: number | null;
  /** `?update=0`: no offer of a newer version, so the card does not cover what is being looked at. */
  noUpdate: boolean;
  /** Any jump (`?step=`, `?chat=1`) skips the pauses a person would sit through. */
  quick: boolean;
}

const STEPS: readonly StepId[] = ["welcome", "scan", "limits", "download", "join"];

export function preview(): Preview {
  const none: Preview = { step: null, chat: false, settings: false, at: null, noUpdate: false, quick: false };
  if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return none;
  try {
    const q = new URLSearchParams(window.location.search);
    const step = STEPS.find((s) => s === q.get("step")) ?? null;
    const at = Number(q.get("at"));
    return {
      step,
      chat: q.get("chat") === "1",
      settings: q.get("settings") === "1",
      at: q.has("at") && Number.isFinite(at) ? at : null,
      noUpdate: q.get("update") === "0",
      quick: step !== null || q.get("chat") === "1",
    };
  } catch {
    return none;
  }
}
