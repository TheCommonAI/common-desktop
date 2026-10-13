import { useEffect, useRef, useState } from "react";
import ThinkingMark from "./ThinkingMark";

/**
 * What the app shows while the network has the question.
 *
 * Three things, and each carries one fact. A mark draws itself — three dots that
 * find each other and let go — so a wait that is going well looks different from
 * a process that has died; that is the whole of "something is happening". The
 * elapsed seconds appear once the answer is late enough that the user has
 * started counting. And `Stop waiting` is the way out of a wait that can run to
 * four minutes.
 *
 * ── Why there are no words ────────────────────────────────────────────────────
 *
 * There used to be a sentence here, the CLI's own: it prints `plotting request
 * into vector space` the moment the request goes out, and this said the same
 * thing in the same words. It is gone, and the mark is what replaced it. The
 * sentence was the CLI explaining itself to a terminal user who has no other
 * signal; the drawing says the same thing without borrowing the network's
 * vocabulary, and a chat window that opens with three dots is a convention the
 * user already knows how to read.
 *
 * What that costs, and it is real: this article sits inside the transcript's
 * `role="log"`, a live region, so the sentence was also the thing that told a
 * reader who cannot see the mark what was happening. Now the first thing that
 * region announces is the button below. The mark is `aria-hidden` because it is
 * a drawing and not information — see `ThinkingMark` — and there is nothing here
 * that can carry the same meaning as text.
 *
 * ── And the seconds ───────────────────────────────────────────────────────────
 *
 * The clock is `aria-hidden` for the same reason it always was: it ticks once a
 * second inside a live region, and would read itself aloud once a second. What a
 * reader is owed is the cold line below, which is a real change of state rather
 * than a count.
 *
 * ── And a way out ─────────────────────────────────────────────────────────────
 *
 * A routed answer can take four minutes, because that is `REQUEST_TIMEOUT_SECONDS`
 * in the CLI and the app inherits it. A terminal user has ⌃C for that; this had
 * nothing, and the composer is inert for the whole of it — you could type but
 * sending did nothing and said nothing. It reaches past the promise to the
 * process, and kills it, so the node stops being spent on a question nobody
 * wants the answer to.
 */

/** When the clock appears, and with it the way out. Under this the answer is
 *  usually back, and an escape hatch offered against a wait that is about to end
 *  is noise in a line whose whole job is to say the network is working. */
const CLOCK_AT_MS = 4_000;

/** When the line stops describing a normal wait. Fifteen seconds is long past
 *  the routing, which is tens of milliseconds, so by here the wait is a machine
 *  pulling weights into memory. */
const COLD_AT_MS = 15_000;

export interface ThinkingProps {
  /** Let go of the question, and say how long it was held on to. The wait is
   *  measured here because here is where the clock lives; the caller is what
   *  knows what to do with it. Kills the process behind it — see
   *  `backend.stopAsk` for why looking away is not enough. */
  onStop: (waitedMs: number) => void;
}

export default function Thinking({ onStop }: ThinkingProps) {
  const started = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    // Read from a clock rather than counted, so the number stays true if the
    // interval is late — which it will be, since this runs behind a webview
    // waiting on a subprocess.
    const id = window.setInterval(() => setElapsed(Date.now() - started.current), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <article className="msg msg--thinking">
      <ThinkingMark />
      {/* Nothing at all for the first few seconds: the mark is the whole of what
          there is to say until the wait is long enough to be worth a number. */}
      {elapsed >= CLOCK_AT_MS && (
        <p className="msg__text">
          <span className="thinking__clock" aria-hidden="true">
            {Math.round(elapsed / 1000)}s
          </span>
          {/* Not `aria-hidden`, unlike the clock beside it: this is the only
              control in the article, and now that the sentence above it is gone
              it is also the only thing here a reader can perceive. It carries
              its own name, so it needs no label. */}
          {/* Read from the clock rather than from `elapsed`, which is only as
              fresh as the last tick — up to a second stale, and the whole point
              of what this hands over is the number. */}
          <button
            type="button"
            className="thinking__stop"
            onClick={() => onStop(Date.now() - started.current)}
          >
            Stop waiting
          </button>
        </p>
      )}
      {elapsed >= COLD_AT_MS && (
        <p className="msg__text thinking__late">
          Taking a while. The first answer from a cold machine is the slow one.
        </p>
      )}
    </article>
  );
}
