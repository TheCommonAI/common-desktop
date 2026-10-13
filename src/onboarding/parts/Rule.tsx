import type { CSSProperties } from "react";

/**
 * The gauge, as a row of marks.
 *
 * No track chrome, no box, no percentage figure: a run of dots the width of the
 * text column, inked in from the left as the model arrives. On the download
 * screen the numbers in the caption are the type and this is the ambient thing
 * beneath them.
 *
 * Dots rather than one growing rule, and dots that are not quite round, not
 * quite the same size, and not quite on the same line. A hairline is a machine's
 * idea of progress; a row of marks is a hand's, and this screen is half an hour
 * of a machine's work on somebody's laptop — the one place in the flow that
 * should look like it was touched by a person rather than rendered. The wobble
 * is deterministic: the same mark wobbles the same way in every frame, because a
 * bar that redrew itself differently as it moved would look like it was
 * shivering, not drawn.
 */

/** How many marks the bar is made of. Fixed, so that the row is drawn once and
 *  then inked in, rather than reshuffling as the transfer moves. */
const MARKS = 36;

/**
 * The wobble for mark `i`: how big it is, how far off the line it sits, and how
 * far it leans. Three small arithmetic sequences with three different periods,
 * so the run does not visibly repeat — and arithmetic rather than a
 * floating-point hash, so the same index gives the same mark every time and the
 * numbers stay tunable by eye.
 */
function wobble(i: number) {
  return {
    size: 2.7 + ((i * 7) % 5) * 0.3, // 2.7 – 3.9 px across
    rise: (((i * 3) % 7) - 3) * 0.24, // ± 0.7 px off the line
    tilt: (((i * 5) % 9) - 4) * 1.6, // ± 6.4°
  };
}

export interface RuleProps {
  /** 0..1, or `null` while the total is still unknown. */
  fraction: number | null;
  /** What a reader hears instead of the bar. The caption, verbatim. */
  label: string;
}

export default function Rule({ fraction, label }: RuleProps) {
  // No longer held a hair short of the end. That hold existed because a solid
  // rule at 99% is indistinguishable from a finished one — and the last thing
  // this screen does before `verifying` is show it finishing. With marks the
  // hair is the mark itself: the run stops one mark short, visibly, and the
  // fraction can be read as what it is.
  const clamped = fraction === null ? 0 : Math.min(1, Math.max(0, fraction));
  const inked = clamped * MARKS;

  return (
    <div
      className="rule"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // Absent while the total is unknown, which is how a progressbar says
      // "indeterminate" — better than a number that is made up.
      aria-valuenow={fraction === null ? undefined : Math.round(clamped * 100)}
      aria-valuetext={label}
    >
      {Array.from({ length: MARKS }, (_, i) => {
        const { size, rise, tilt } = wobble(i);
        // The mark under the leading edge is caught mid-stroke and drawn a
        // little small — which is also what keeps a full run of marks from
        // reading as finished one mark early.
        const state = i + 1 <= inked ? "on" : i < inked ? "part" : null;
        return (
          <span
            key={i}
            // The row carries the semantics; the marks are how it is drawn.
            aria-hidden="true"
            className={state === null ? "rule__dot" : `rule__dot rule__dot--${state}`}
            style={
              {
                "--size": `${size.toFixed(2)}px`,
                "--rise": `${rise.toFixed(2)}px`,
                "--tilt": `${tilt.toFixed(1)}deg`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}
