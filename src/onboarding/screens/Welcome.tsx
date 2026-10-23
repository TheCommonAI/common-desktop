import Control from "../parts/Control";
import Statement from "../parts/Statement";
import type { ScreenProps } from "../steps";

/**
 * The first thing after the wordmark.
 *
 * It has one job: say what is about to happen, in the two clauses that matter —
 * this machine holds one slice of a large model, and other people's machines hold
 * the rest — and offer the one way forward. No back, because there is nowhere behind it.
 */
export default function Welcome({ next }: ScreenProps) {
  return (
    <Statement
      statement="Let's put this machine to work."
      caption={["Run one slice of a large model", "together with other people's machines"]}
      controls={
        <Control onClick={next} arrow>
          Scan this machine
        </Control>
      }
    />
  );
}
