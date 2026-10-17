import { useEffect, type ReactNode } from "react";
import { formatBytes } from "../copy";
import { reportWithOverride } from "../flow";
import Control from "../parts/Control";
import Statement from "../parts/Statement";
import { onboardingService, type ModelSuggestion } from "../service";
import type { ScreenProps } from "../steps";
import { outcomeKey, refused, useTask } from "../use-task";

/**
 * The recommendation.
 *
 * The statement *is* the recommendation — "Your machine can run Bonsai 2 9B." —
 * so the sentence the user reads is the advice, not a label above it. There is
 * nothing beneath it to change it with: choosing the model is not the user's job,
 * and a screen that offers a choice it is also making on the user's behalf is a
 * screen that has not decided anything. The recommendation is written through on
 * Continue, and the one way to overrule it is a hatch in Settings.
 *
 * ── Why there is no choice here ───────────────────────────────────────────────
 *
 * There was one, in effect. This screen listed three lanes and asked which the
 * user was for, and the answer picked the weights. The catalogue is now one family
 * at four sizes, so every lane would resolve to the same model and the question
 * would be a control that changes nothing. What decides is memory — which this app
 * has already measured, and which the user has not.
 *
 * ── The one thing that makes this more than a sentence ────────────────────────
 *
 * `fits` is false only when nothing in the ladder clears the catalogue's floor, and
 * `model` is then the floor rather than a recommendation: a machine the network
 * would still rather have on the 2B than not have at all. Those are two different
 * claims, and both the statement and the caption say which one is being made —
 * naming a model that will not keep up, in the same words as one that will, is the
 * failure this screen exists to avoid.
 */

/**
 * What the caption says, in the order of what the user most needs to know.
 *
 * Two clauses when the answer is a recommendation, and the second is the one that
 * earns this function its place: naming the rung that was considered and refused
 * turns a default into a decision. "Bonsai 2 9B is too much for this machine" is
 * the whole trade-off in one line, and it is a claim the reader can hold against
 * the machine in front of them.
 *
 * The other branch is the honest one. When nothing fits, the caption stops calling
 * the answer a recommendation and says what it is, in the same breath as the size —
 * so the number the user is about to spend is not read as advice.
 */
function captionFor(suggestion: ModelSuggestion): readonly ReactNode[] {
  const { model, fits, options } = suggestion;
  const download = `${formatBytes(model.bytes)} to download`;

  if (!fits) {
    return [
      "Nothing in the four clears what the network asks for here",
      `${download}, and it will be slow`,
    ];
  }

  // The rung directly above the one being recommended, which by construction is
  // the first that did not fit — the ladder is ordered by what its rungs ask, so
  // anything further up asks for more still.
  const at = options.findIndex((option) => option.model.id === model.id);
  const above = at < 0 ? undefined : options[at + 1];

  return above === undefined
    ? ["The biggest of the four that fits with room to spare", download]
    : [
        "The biggest of the four that fits with room to spare",
        `${above.model.label} is too much for this machine`,
        download,
      ];
}

export default function PickModel({ flow, update, next, back }: ScreenProps) {
  const hardware = reportWithOverride(flow);

  const { state, run } = useTask<ModelSuggestion, never>(() =>
    // Unreachable: the step machine will not restore this step without a
    // report, and the screen before it always writes one.
    hardware === null
      ? refused<ModelSuggestion>("No hardware report.")
      : onboardingService.suggestModel(hardware),
  );

  useEffect(() => {
    run();
  }, [run]);

  const suggestion = state.status === "done" ? state.value : null;

  // Written through on the way out, so the step that follows always has a model to
  // join with — the same field the Settings hatch writes.
  const accept = () => {
    if (suggestion !== null) update({ modelId: suggestion.model.id });
    next();
  };

  let statement: ReactNode;
  let caption: ReactNode | readonly ReactNode[];
  let controls: ReactNode;
  let focusKey: string;

  if (state.status === "error") {
    focusKey = "error";
    statement = "I can't tell what fits.";
    caption = [
      // The memory figure is the one input this call cannot do without, and the
      // only reason it is allowed to reject: which rung a machine gets is a
      // question about this machine, and no network can supply the answer. Every
      // other failure on the way to it — no gateway, no catalogue, no CLI — falls
      // back to the table and still answers.
      state.error.code === "permission-denied"
        ? "The system wouldn't say how much memory there is"
        : "Something went wrong at this end",
      "trying again is the usual fix",
      state.error.detail ?? null,
    ];
    controls = (
      <>
        <Control onClick={run} arrow>
          Try again
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  } else if (suggestion === null) {
    focusKey = outcomeKey(state);
    statement = "One moment.";
    caption = ["Working out what fits on this machine"];
    controls = (
      <Control onClick={back} quiet>
        Back
      </Control>
    );
  } else {
    focusKey = "done";
    statement = suggestion.fits
      ? `Your machine can run ${suggestion.model.label}.`
      : `${suggestion.model.label} is the smallest of the four.`;
    caption = captionFor(suggestion);
    controls = (
      <>
        <Control onClick={accept} arrow>
          Continue
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  }

  return <Statement statement={statement} caption={caption} controls={controls} focusKey={focusKey} />;
}
