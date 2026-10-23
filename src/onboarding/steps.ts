import type { FlowState } from "./flow";

/**
 * The five steps, in order.
 *
 * A step is one screen. What happens *inside* a screen — the scan's four reads,
 * the download's progress, the two limit questions, the join's states
 * — is a state, not a step, and does not appear here. That distinction is what
 * keeps the limit questions in step five rather than turning them into steps
 * six, seven and eight.
 */

export type StepId = "welcome" | "scan" | "limits" | "download" | "join";

export const STEP_ORDER: readonly StepId[] = [
  "welcome",
  "scan",
  "limits",
  "download",
  "join",
];

/** What every screen is handed. Screens destructure only the parts they use —
 *  `Welcome` has no Back, and naming it would be a build error rather than an
 *  unused variable. */
export interface ScreenProps {
  flow: FlowState;
  /** Merge into the carried data. Writes through to storage. */
  update: (patch: Partial<FlowState>) => void;
  next: () => void;
  /** Leave to the previous step. A screen with its own questions handles those
   *  itself and calls this only when there is nothing left to undo. */
  back: () => void;
}

/* The screen components are not mapped to their steps here. They import
   `ScreenProps` from this file, so a table of them in this file would be a
   module cycle for no gain; the switch that pairs a step with a screen lives in
   `Onboarding.tsx`, next to the machine that moves between them. */
