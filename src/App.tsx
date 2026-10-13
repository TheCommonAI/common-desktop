import { useState } from "react";
import Chat from "./chat/Chat";
import Onboarding from "./onboarding/Onboarding";
import Wordmark from "./Wordmark";
import "./App.css";

/**
 * The opening wordmark plays once per machine, then never again. Clear this key
 * to see the opening on the next launch.
 */
const INTRO_SEEN = "common.intro.seen";

/**
 * And this machine has been joined to the network. Written at the one moment
 * that claim is known to be true — when the flow's green screen hands over — and
 * never cleared: a machine that has joined stays joined, so being asked to join
 * again on the next launch would be the app forgetting something it was told.
 *
 * The two flags are read in this order rather than together. A live machine goes
 * straight to the chat and does not replay the flow that got it there; the
 * opening is for the day this machine was new, and that day has passed.
 */
const LIVE_SEEN = "common.live.seen";

// Storage can be unavailable, and a failure there must mean the safe default —
// play the opening, start at the top — never a blank window.
function seen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function remember(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Nothing to do. Whatever was not remembered simply happens again.
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Phase = "intro" | "leaving" | "onboarding" | "chat";

export default function App() {
  const [phase, setPhase] = useState<Phase>(() =>
    seen(LIVE_SEEN) ? "chat" : seen(INTRO_SEEN) ? "onboarding" : "intro",
  );

  const begin = () => {
    if (phase !== "intro") return;
    remember(INTRO_SEEN);
    // With motion reduced there is no exit to wait for, so hand over at once.
    // That also keeps the animation from being the thing that advances the app.
    setPhase(prefersReducedMotion() ? "onboarding" : "leaving");
  };

  /** The flow is over and the machine is live. */
  const live = () => {
    remember(LIVE_SEEN);
    setPhase("chat");
  };

  return (
    <main className="stage">
      {phase === "chat" ? (
        <Chat />
      ) : (
        <>
          {/* Mounted during the exit as well as after it, so the flow is already
              in place as the wordmark clears rather than arriving behind it. */}
          {phase !== "intro" && <Onboarding onComplete={live} />}

          {phase !== "onboarding" && (
            <div
              className={`intro${phase === "leaving" ? " intro--leaving" : ""}`}
              onClick={begin}
              onAnimationEnd={(e) => {
                // The wordmark's arrival animation ends here too; only the exit
                // means the opening is done.
                if (e.animationName === "leave") setPhase("onboarding");
              }}
            >
              <Wordmark />
              {/* The pointer target is the whole frame, so the control for the
                  keyboard is a real button, parked out of sight. */}
              <button className="intro__begin" onClick={begin}>
                Begin
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
