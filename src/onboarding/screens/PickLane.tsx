import { useEffect, type ReactNode } from "react";
import { reportWithOverride } from "../flow";
import { LANE_LABEL } from "../models";
import Control from "../parts/Control";
import Statement from "../parts/Statement";
import { onboardingService, type Lane, type LaneOption, type LaneSuggestion } from "../service";
import type { ScreenProps } from "../steps";
import { outcomeKey, refused, useTask } from "../use-task";

/**
 * The recommendation.
 *
 * The statement *is* the recommendation — "Your machine can run the Math lane."
 * — so the sentence the user reads is the advice, not a label above it. There is
 * nothing beneath it to change it with: choosing the model is not the user's
 * job, and a screen that offers a choice it is also making on the user's behalf
 * is a screen that has not decided anything. The recommendation is written
 * through on Continue, and the one way to overrule it is a hatch in Settings.
 *
 * `recommended` is the lane the network is short of when this machine can carry
 * it, and the machine's own best lane otherwise. That ordering is the point of
 * the screen: the network's need is what makes a pool of these machines add up
 * to something, and a machine that cannot carry the ask is not a machine the
 * ask is for.
 */

function optionFor(suggestion: LaneSuggestion, lane: Lane): LaneOption | null {
  return suggestion.options.find((option) => option.lane === lane) ?? null;
}

/**
 * What the caption says, in the order of what the user most needs to know.
 *
 * Three branches, and the third is the one that earns this function its place:
 * when the ask is a lane this machine cannot carry, the caption says so plainly.
 * "The network is short of Code · your machine would rather do Math" is the
 * whole trade-off in one line, which is more than a label could carry.
 */
function laneParts(option: LaneOption, suggestion: LaneSuggestion): readonly ReactNode[] {
  if (!option.fits) {
    // Unreachable from here — a recommendation is only ever a lane this machine
    // can carry — but it stays as the honest description of what `fits` means,
    // and because a backend is free to recommend badly.
    return [`${option.model.label} will be slow here`, "that's allowed"];
  }

  const ask = suggestion.networkAsk;
  if (ask === null) {
    // An ask that did not land is not a failure — the contract says so — and the
    // network being unreachable while the recommendation still stands is the
    // ordinary case, not an error worth a sentence about one. It reads as the
    // absence of an ask because that is what it is.
    return ["No ask from the network", "going by your machine alone"];
  }
  if (ask.lane === option.lane) {
    return [`${LANE_LABEL[ask.lane]} is what the network is short of right now`];
  }
  return [
    `The network is short of ${LANE_LABEL[ask.lane]}`,
    `your machine would rather do ${LANE_LABEL[suggestion.byMachine]}`,
  ];
}

export default function PickLane({ flow, update, next, back }: ScreenProps) {
  const hardware = reportWithOverride(flow);

  const { state, run } = useTask<LaneSuggestion, never>(() =>
    // Unreachable: the step machine will not restore this step without a
    // report, and the screen before it always writes one.
    hardware === null
      ? refused<LaneSuggestion>("No hardware report.")
      : onboardingService.suggestLane(hardware),
  );

  useEffect(() => {
    run();
  }, [run]);

  const suggestion = state.status === "done" ? state.value : null;
  const recommended =
    suggestion === null ? null : optionFor(suggestion, suggestion.recommended);

  // Written through on the way out, so the step that follows always has a lane
  // and a model to work from — the same two fields the Settings hatch writes.
  const accept = () => {
    if (recommended !== null) {
      update({ lane: recommended.lane, modelId: recommended.model.id });
    }
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
      state.error.code === "permission-denied"
        ? "The system wouldn't say how much memory there is"
        : "The network didn't answer",
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
  } else if (suggestion === null || recommended === null) {
    focusKey = outcomeKey(state);
    statement = "One moment.";
    caption = ["Asking the network what it needs"];
    controls = (
      <Control onClick={back} quiet>
        Back
      </Control>
    );
  } else {
    focusKey = "done";
    statement = `Your machine can run the ${LANE_LABEL[recommended.lane]} lane.`;
    caption = laneParts(recommended, suggestion);
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
