import Control from "../parts/Control";
import Statement from "../parts/Statement";
import type { ScreenProps } from "../steps";

/**
 * The first thing after the wordmark.
 *
 * It has one job: say what is about to happen, in the two clauses that matter —
 * a model on this machine, shared with a network of other people's machines —
 * and offer the one way forward. No back, because there is nowhere behind it.
 */
export default function Welcome({ next }: ScreenProps) {
  return (
    <Statement
      statement="Let's put this machine to work."
      caption={["A small model, running on your computer", "shared with the network"]}
      controls={
        <Control onClick={next} arrow>
          Scan this machine
        </Control>
      }
    />
  );
}
