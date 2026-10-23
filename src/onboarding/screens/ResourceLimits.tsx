import { useEffect, useState, type ReactNode } from "react";
import { formatClock } from "../copy";
import { defaultLimits } from "../flow";
import { CONTRIBUTE_CHOICES, DEFAULT_QUIET, QUIET_CHOICES } from "../limits";
import Choices from "../parts/Choices";
import Control from "../parts/Control";
import Statement from "../parts/Statement";
import TimeField from "../parts/TimeField";
import { onboardingService, type ResourceLimits } from "../service";
import type { ScreenProps } from "../steps";
import { useTask } from "../use-task";

/**
 * The two questions that stop a laptop from feeling hijacked: when it helps, and
 * whether it rests overnight.
 *
 * There used to be a third, "how much may it take". The layer network has no
 * throttle: a peer offers a slice of the model that fits in its memory and either
 * serves or does not. A percentage would have been a promise nothing keeps, so the
 * question is gone, and what is left is the part the app can honour — *when*, by
 * starting and stopping the peer itself.
 *
 * One question at a time, in one step: a state is not a step.
 */

type Question = "contribute" | "quiet";

export default function ResourceLimits({ flow, update, next, back }: ScreenProps) {
  const initial = defaultLimits(flow.hardware);
  const onBattery = flow.hardware?.power?.source === "battery";

  const [contribute, setContribute] = useState(initial.contribute);
  const [rest, setRest] = useState(initial.quietHours !== null);
  const [times, setTimes] = useState(initial.quietHours ?? DEFAULT_QUIET);
  const [question, setQuestion] = useState<Question>("contribute");

  const limits: ResourceLimits = { contribute, quietHours: rest ? times : null };

  // Written once, on Finish. A half-answered form is never sent, and the flow
  // is redrawn from what the service says it stored rather than from what it
  // was handed — an implementation clamps, and the clamp is the truth.
  const save = useTask<ResourceLimits, never>(() => onboardingService.setLimits(limits));

  useEffect(() => {
    if (save.state.status === "done") {
      update({ limits: save.state.value });
      next();
    }
  }, [save.state, update, next]);

  const contributeParts: readonly ReactNode[] =
    contribute === "plugged-in" && onBattery
      ? // The scan deciding something the user can see: the machine is on
        // battery, so waiting for the mains is where this starts, and it says so.
        ["You're on battery", "so this waits until you plug in"]
      : [
          {
            always: "Runs whenever the machine is awake",
            "plugged-in": "Waits until you're plugged in",
          }[contribute],
        ];

  const quietParts: readonly ReactNode[] = rest
    ? [`Pauses at ${formatClock(times.start)}`, `picks up at ${formatClock(times.end)}`]
    : ["Runs all night"];

  const saving = save.state.status === "running";

  let statement: ReactNode;
  let caption: ReactNode | readonly ReactNode[];
  let choices: ReactNode;
  let fields: ReactNode;
  let controls: ReactNode;
  let focusKey: string;

  if (save.state.status === "error") {
    focusKey = "error";
    statement = "That didn't save.";
    caption = [
      save.state.error.code === "permission-denied"
        ? "The system wouldn't write the settings"
        : "Something went wrong at this end",
      save.state.error.detail ?? null,
    ];
    choices = null;
    fields = null;
    controls = (
      <>
        <Control onClick={save.run} arrow>
          Try again
        </Control>
        <Control onClick={() => setQuestion("quiet")} quiet>
          Back
        </Control>
      </>
    );
  } else if (question === "contribute") {
    focusKey = "contribute";
    statement = "When should this machine help?";
    caption = contributeParts;
    choices = (
      <Choices
        label="When to contribute"
        name="contribute"
        value={contribute}
        choices={CONTRIBUTE_CHOICES}
        onChange={setContribute}
      />
    );
    fields = null;
    controls = (
      <>
        <Control onClick={() => setQuestion("quiet")} arrow disabled={saving}>
          Next
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  } else {
    focusKey = saving ? "saving" : "quiet";
    statement = "Should it rest overnight?";
    caption = saving ? ["Saving…"] : quietParts;
    choices = (
      <Choices
        label="Whether it rests overnight"
        name="quiet"
        // While saving the answer is settled and the line stops taking input,
        // so the screen is not inviting a change it is not going to read.
        value={rest ? "yes" : "no"}
        choices={QUIET_CHOICES}
        disabled={saving}
        onChange={(value) => setRest(value === "yes")}
      />
    );
    fields = rest ? (
      <>
        <TimeField
          label="Pause at"
          value={times.start}
          disabled={saving}
          onChange={(start) => setTimes((t) => ({ ...t, start }))}
        />
        <TimeField
          label="Pick up at"
          value={times.end}
          disabled={saving}
          onChange={(end) => setTimes((t) => ({ ...t, end }))}
        />
      </>
    ) : null;
    controls = (
      <>
        <Control onClick={save.run} arrow disabled={saving}>
          Finish
        </Control>
        <Control onClick={() => setQuestion("contribute")} quiet disabled={saving}>
          Back
        </Control>
      </>
    );
  }

  return (
    <Statement
      statement={statement}
      caption={caption}
      controls={
        <>
          {choices}
          {fields && <span className="sheet__fields">{fields}</span>}
          {controls}
        </>
      }
      focusKey={focusKey}
    />
  );
}
