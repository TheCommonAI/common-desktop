import { useCallback, useEffect, useState, type ComponentType } from "react";
import { INITIAL_FLOW, readProgress, writeProgress, type FlowState, type Progress } from "./flow";
import HardwareScan from "./screens/HardwareScan";
import JoinNetwork from "./screens/JoinNetwork";
import PickModel from "./screens/PickModel";
import ResourceLimits from "./screens/ResourceLimits";
import Welcome from "./screens/Welcome";
import { STEP_ORDER, type ScreenProps, type StepId } from "./steps";

/**
 * The flow, and the only thing that moves it.
 *
 * Five screens, one at a time. A screen is handed the data it carries, one way
 * to add to it, and two ways to move — and it decides nothing about where it
 * sits in the order. That is the whole reason the machine is here rather than
 * in each screen, and the reason a screen can be read on its own.
 */

/** The step→screen table. A `Record` rather than a switch so that adding a step
 *  to `STEP_ORDER` without writing its screen is a type error at the table,
 *  where the missing screen is, rather than a blank frame at runtime. */
const SCREENS: Readonly<Record<StepId, ComponentType<ScreenProps>>> = {
  welcome: Welcome,
  scan: HardwareScan,
  model: PickModel,
  limits: ResourceLimits,
  join: JoinNetwork,
};

interface Position {
  progress: Progress;
  /** Which way the last move went, for the entrance. `"none"` on the first
   *  screen, which is already arriving on `.onboarding`'s own hand-off — two
   *  entrances stacked on each other read as a stutter, not as an arrival. */
  dir: "forward" | "back" | "none";
}

export interface OnboardingProps {
  /**
   * Leave the flow for the thing it was building towards, which is the chat.
   *
   * This is the seam the plan left open on purpose: there was nowhere to leave
   * *to* when the green screen was written, and an unused prop would have been a
   * build error under `noUnusedLocals`. Now there is somewhere, and it is reached
   * by calling the flow's own `next` past its last step rather than by any screen
   * knowing what comes after it.
   */
  onComplete?: () => void;
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [position, setPosition] = useState<Position>(() => ({
    // A restored step is one the carried data still supports; `readProgress`
    // walks a step back to the last one it can actually show. Reading it is
    // guarded the same way the opening is: any failure simply starts at the top.
    progress: readProgress() ?? { step: "welcome", flow: INITIAL_FLOW },
    dir: "none",
  }));

  const { progress, dir } = position;

  // Persisted after the change rather than during it, so the updaters below stay
  // pure. Every write is a whole position, so a repeated one is the same one.
  useEffect(() => {
    writeProgress(progress);
  }, [progress]);

  const update = useCallback((patch: Partial<FlowState>) => {
    setPosition((pos) => ({
      ...pos,
      progress: { ...pos.progress, flow: { ...pos.progress.flow, ...patch } },
    }));
  }, []);

  /** Move one step, and say which way. A move off either end does nothing at
   *  all — including leaving the direction alone, so a screen that called it
   *  when there was nowhere to go would not re-play its own entrance. */
  const move = useCallback((delta: 1 | -1) => {
    setPosition((pos) => {
      const target = STEP_ORDER[STEP_ORDER.indexOf(pos.progress.step) + delta];
      if (target === undefined || target === pos.progress.step) return pos;
      return {
        progress: { ...pos.progress, step: target },
        dir: delta === 1 ? "forward" : "back",
      };
    });
  }, []);

  const next = useCallback(() => {
    // Past the last step there is nothing in the flow to advance to, and that is
    // not a dead end any more: the last screen's one control is the door out.
    if (progress.step === STEP_ORDER[STEP_ORDER.length - 1]) onComplete?.();
    else move(1);
  }, [progress.step, move, onComplete]);
  const back = useCallback(() => move(-1), [move]);

  const Screen = SCREENS[progress.step];

  return (
    <section className="onboarding" aria-label="Getting started">
      {/* `key` is load-bearing. Without it React reuses this element across
          steps and the entrance animation plays once, for the whole flow. */}
      <div key={progress.step} className={dir === "none" ? "sheet" : `sheet sheet--${dir}`}>
        <Screen flow={progress.flow} update={update} next={next} back={back} />
      </div>
    </section>
  );
}
