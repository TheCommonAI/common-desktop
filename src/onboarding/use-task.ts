import { useCallback, useEffect, useRef, useState } from "react";
import {
  OnboardingError,
  isOnboardingError,
  type PausableTask,
  type Task,
} from "./service";

/**
 * One async operation, in the four states it can be in.
 *
 * The progress is carried on the state rather than alongside it because the
 * error state needs it: a download that failed two thirds of the way through
 * has to be able to say so, and a `progress` slot that only exists while
 * running cannot.
 */
export type TaskState<T, P> =
  | { status: "idle" }
  | { status: "running"; progress: P | null }
  | { status: "done"; value: T }
  | { status: "error"; error: OnboardingError; progress: P | null };

/** How a screen starts its work. The service call is made here, at run time,
 *  rather than being passed in already started, so that nothing begins until
 *  something asks it to. */
export type TaskFactory<T, P> = (opts: {
  onProgress: (progress: P) => void;
}) => Task<T> | PausableTask<T>;

export interface TaskHandle<T, P> {
  state: TaskState<T, P>;
  /** Start it. Calling twice cancels the first run, so a retry is just a run. */
  run: () => void;
  /** Stop it and go back to idle. Safe in any state. */
  cancel: () => void;
  /** No-ops unless the operation is actually pausable — see `PausableTask`. */
  pause: () => void;
  resume: () => void;
}

function isPausable<T>(task: Task<T> | PausableTask<T>): task is PausableTask<T> {
  return "pause" in task;
}

/** A task that is over before it starts, for a screen whose input has gone
 *  missing. Rejecting rather than guessing means a broken invariant surfaces as
 *  the screen's own error state instead of a sentence about a machine nobody
 *  read. */
export function refused<T>(message: string): Task<T> {
  return { result: Promise.reject(new OnboardingError("unsupported", message)), cancel() {} };
}

/**
 * A focus key that changes when the *outcome* arrives and not before.
 *
 * For screens whose running states keep the same controls and only move a
 * caption along, this is what stops every poll from yanking focus back to the
 * statement. It also collapses the first render — `idle` for one frame before
 * the auto-start effect runs — into the same value as `running`, so a screen
 * that starts its own work focuses once rather than twice.
 */
export function outcomeKey<T, P>(state: TaskState<T, P>): string {
  return state.status === "done" || state.status === "error" ? state.status : "working";
}

export function useTask<T, P>(factory: TaskFactory<T, P>): TaskHandle<T, P> {
  const [state, setState] = useState<TaskState<T, P>>({ status: "idle" });

  // The latest factory, held in a ref rather than in the dependency list: a
  // screen's factory closes over that screen's own inputs and would be a new
  // function every render, so making `run` depend on it would restart the work
  // on every render. Screens that need to react to an input changing call
  // `run` themselves.
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  const live = useRef<Task<T> | PausableTask<T> | null>(null);

  // Bumped on every run, every cancel and on unmount. A task from any earlier
  // generation is inert: it cannot write state and cannot clear the live slot.
  // This is what makes React's StrictMode double-invoke harmless in
  // development — the first mount's task is cancelled and its late rejection
  // lands on a generation that no longer exists.
  const generation = useRef(0);

  const cancel = useCallback(() => {
    generation.current += 1;
    const task = live.current;
    live.current = null;
    task?.cancel();
    setState({ status: "idle" });
  }, []);

  const run = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    live.current?.cancel();
    live.current = null;

    let latest: P | null = null;
    setState({ status: "running", progress: null });

    const task = factoryRef.current({
      onProgress: (progress) => {
        if (generation.current !== mine) return;
        latest = progress;
        setState({ status: "running", progress });
      },
    });
    live.current = task;

    task.result.then(
      (value) => {
        if (generation.current !== mine) return;
        live.current = null;
        setState({ status: "done", value });
      },
      (error: unknown) => {
        if (generation.current !== mine) return;
        live.current = null;
        // Stopping is something the user did, not something that went wrong.
        // `cancel` has already put the state back to idle, and letting the
        // rejection through would replace that with an error nobody caused.
        if (isOnboardingError(error) && error.code === "cancelled") return;
        setState({
          status: "error",
          error: isOnboardingError(error)
            ? error
            : new OnboardingError("unknown", "Something went wrong."),
          progress: latest,
        });
      },
    );
  }, []);

  const pause = useCallback(() => {
    const task = live.current;
    if (task && isPausable(task)) task.pause();
  }, []);

  const resume = useCallback(() => {
    const task = live.current;
    if (task && isPausable(task)) task.resume();
  }, []);

  // Unmounting a step kills its work. Without this, walking Back out of the
  // download would leave the transfer running behind a screen that no longer
  // exists — and walking back in would start a second one.
  useEffect(() => {
    return () => {
      generation.current += 1;
      const task = live.current;
      live.current = null;
      task?.cancel();
    };
  }, []);

  return { state, run, cancel, pause, resume };
}
