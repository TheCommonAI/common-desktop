import { useCallback, useEffect, useRef, useState } from "react";
import { isOnboardingError, onboardingService } from "../onboarding/service";
import { gatewaySeesUs } from "./backend";
import { joinInputs, mayRejoinNow, type Rejoin } from "./rejoin";

/**
 * The React binding for a reconnect. The decisions it drives are in `rejoin.ts`.
 *
 * Split from that file for one reason worth writing down: the decisions —
 * whether the quiet hours allow this, what a reconnect asks for, what each state
 * says — are the parts worth testing, and a module with a hook in it cannot be
 * loaded by `tests/rejoin.test.mjs` without also mocking React. Nothing here
 * decides anything; it sequences calls and holds one piece of state.
 */

/** How often the gateway is asked whether it can reach this machine, once a join
 *  has registered, and how long it is asked for.
 *
 *  Two seconds, because the gap being covered is the gateway running its health
 *  check against a tunnel it has only just been told about — seconds, not minutes.
 *  Thirty is the allowance for a quick tunnel being slow rather than for one being
 *  broken, and past it the honest reading is "not reachable yet" rather than a
 *  machine to keep asking about. */
const SETTLE_POLL_MS = 2_000;
const SETTLE_BUDGET_MS = 30_000;

export interface RejoinOptions {
  /** A reconnect is starting.
   *
   *  `Chat` blanks its `seen` here rather than the hook holding a second copy of
   *  the connection state: the rail must not go on saying Connected while the
   *  machine is in the middle of coming back, and there must be one answer to
   *  "can the gateway reach us" rather than two that can disagree. */
  onStart: () => void;
  /** And the gateway's verdict once it is over.
   *
   *  Reported rather than returned, and polled rather than taken from the join:
   *  registering is a fact about this machine, and whether the gateway can route
   *  to it is the gateway's own answer. See `ensureJoined`. */
  onSettled: (seen: boolean) => void;
}

export interface RejoinHandles {
  /** Where the last attempt got to, for the rail and the Settings row to render. */
  state: Rejoin;
  /** Put this machine back on the network because the app started.
   *
   *  Fires at most once per process, and honours the user's quiet hours — see
   *  `mayRejoinNow` for why those and nothing else. */
  auto: () => void;
  /** Because the user pressed the button.
   *
   *  Every press counts, and the quiet hours are not consulted: a button somebody
   *  pressed is an instruction rather than a suggestion. */
  manual: () => void;
}

export function useRejoin({ onStart, onSettled }: RejoinOptions): RejoinHandles {
  const [state, setState] = useState<Rejoin>({ kind: "idle" });

  // Read through a ref so `run` does not change identity when the parent
  // re-renders with fresh closures. The automatic pass is guarded to fire once,
  // and a changing callback identity must not be the thing that decides it did.
  const report = useRef({ onStart, onSettled });
  useEffect(() => {
    report.current = { onStart, onSettled };
  });

  // Whether the automatic pass has been spent, and whether one is in flight. Two
  // refs rather than one because they answer different questions: the first is
  // "has this process already reconnected by itself", and a manual press must not
  // be blocked by it.
  const autoSpent = useRef(false);
  const busy = useRef(false);

  // A refused `await` must not write into a component that is gone. This is the
  // root screen and unmounting it means the app is closing, so this is cheap
  // rather than likely — but a reconnect runs for up to ninety seconds and the
  // window can be closed inside that, and the alternative is a promise holding a
  // dead component's setter.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Ask the gateway, until it says it can reach this machine or the budget runs
   *  out. */
  const settled = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + SETTLE_BUDGET_MS;
    for (;;) {
      if (!alive.current) return false;
      // A read that will not answer counts as "not yet" rather than as a failure:
      // the node is registering right now, and one refused `invoke` is not
      // evidence about a machine whose identity is already on disk.
      if (await gatewaySeesUs().catch(() => false)) return true;
      if (Date.now() > deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }, []);

  const run = useCallback(
    async (how: "auto" | "manual") => {
      if (how === "auto") {
        // Once per process. The window is hidden rather than unmounted when the app
        // is left in the tray, so a mount effect fires once; StrictMode fires it
        // twice and discards the first. Either way this guard is load-bearing
        // rather than defensive — what it prevents is a second `join.py` on the
        // port the first one is using, which is the exact thing the service's own
        // reuse guard exists to prevent.
        if (autoSpent.current) return;
        autoSpent.current = true;
      }
      if (busy.current) return;
      busy.current = true;

      // Released in a `finally` rather than at each of the six ways out, because
      // a path that forgets is a button that never works again: `busy` stays set
      // for the life of the window and every later press returns at the guard
      // above, in silence. This function has been edited once already to close a
      // path that did exactly that, so the release is structural now.
      try {
        const request = await joinInputs();

        if (request === null) {
          // Silence on the automatic pass: nobody asked, and a machine that cannot
          // say what it was set up as is either the onboarding's business or a
          // storage problem the user has not noticed. Neither is a sentence to open
          // the app with. A pressed button is the opposite and owes an answer.
          if (how === "manual") {
            setState({
              kind: "failed",
              code: "unknown",
              detail: "This machine was set up with a model this version doesn't know.",
            });
          }
          return;
        }

        if (how === "auto") {
          const gate = mayRejoinNow(request.limits, new Date());
          if (!gate.allowed) {
            // Said out loud rather than passed over in silence. A setting the user
            // forgot they set is the most confusing possible reason for a machine
            // not connecting, and the alternative is an app that looks broken at
            // 3am with no explanation on it.
            setState({ kind: "waiting", until: gate.until });
            return;
          }
        }

        if (!alive.current) return;

        setState({ kind: "working" });
        report.current.onStart();

        try {
          await onboardingService.ensureJoined(request).result;
        } catch (why: unknown) {
          if (!alive.current) return;
          if (isOnboardingError(why) && why.code === "cancelled") {
            // Stopped is not a fault to announce: reporting a press of Stop as a
            // broken machine would be the rail calling the user's own decision a
            // failure. But `onStart` already blanked the reading, so it is restored
            // from the gateway rather than left at "Checking" for the rest of the
            // session.
            report.current.onSettled(await gatewaySeesUs().catch(() => false));
            return;
          }
          setState(
            isOnboardingError(why)
              ? { kind: "failed", code: why.code, detail: why.detail ?? null }
              : { kind: "failed", code: "unknown", detail: null },
          );
          report.current.onSettled(false);
          return;
        }

        // Registered. Whether the gateway can route here is its own answer, asked
        // rather than assumed — a registered node the gateway cannot reach is a real
        // state, and this row exists to show it.
        const reached = await settled();
        if (!alive.current) return;
        setState(reached ? { kind: "reached" } : { kind: "failed", code: "timeout", detail: null });
        report.current.onSettled(reached);
      } finally {
        busy.current = false;
      }
    },
    [settled],
  );

  const auto = useCallback(() => {
    void run("auto");
  }, [run]);

  const manual = useCallback(() => {
    void run("manual");
  }, [run]);

  return { state, auto, manual };
}
