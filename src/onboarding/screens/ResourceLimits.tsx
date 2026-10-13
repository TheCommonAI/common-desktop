import { useEffect, useState, type ReactNode } from "react";
import { formatClock } from "../copy";
import { defaultLimits } from "../flow";
import {
  CAP_CHOICES,
  CONTRIBUTE_CHOICES,
  DEFAULT_QUIET,
  QUIET_CHOICES,
  capChoiceOf,
} from "../limits";
import Choices from "../parts/Choices";
import Control from "../parts/Control";
import Statement from "../parts/Statement";
import TimeField from "../parts/TimeField";
import { onboardingService, type ResourceLimits } from "../service";
import type { ScreenProps } from "../steps";
import { useTask } from "../use-task";

/**
 * The three questions that stop a student laptop from feeling hijacked.
 *
 * One question at a time, in one step. The brief asks for five things here —
 * when to contribute, a processor cap, a graphics cap, and a schedule — and
 * five things on one screen is a settings page, which is exactly the register
 * this flow is not written in. Splitting them into three *steps* would make the
 * flow eight screens and contradict the brief's own count, so they are three
 * states inside step five. A state is not a step; step five stays one screen.
 *
 * The cap is the interesting one. Two sliders have no quiet editorial form, so
 * it is re-derived rather than shrunk: one named choice — A little, Some, Most
 * — whose caption discloses the percentages it really means.
 */

type Question = "contribute" | "cap" | "quiet";

export default function ResourceLimits({ flow, update, next, back }: ScreenProps) {
  const initial = defaultLimits(flow.hardware);
  const onBattery = flow.hardware?.power?.source === "battery";

  const [contribute, setContribute] = useState(initial.contribute);
  const [cap, setCap] = useState(initial.cap);
  const [rest, setRest] = useState(initial.quietHours !== null);
  const [times, setTimes] = useState(initial.quietHours ?? DEFAULT_QUIET);
  const [question, setQuestion] = useState<Question>("contribute");

  const limits: ResourceLimits = { contribute, cap, quietHours: rest ? times : null };

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

  const capChoice = capChoiceOf(cap)?.value ?? null;

  const contributeParts: readonly ReactNode[] =
    contribute === "plugged-in" && onBattery
      ? // The scan deciding something the user can see: the machine is on
        // battery, so waiting for the mains is where this starts, and it says so.
        ["You're on battery", "so this waits until you plug in"]
      : [
          {
            always: "Runs whenever the machine is awake",
            "plugged-in": "Waits until you're plugged in",
            idle: "Waits until you've stepped away",
          }[contribute],
        ];

  const capParts: readonly ReactNode[] = [
    `Up to ${cap.cpuPercent}% of the processor`,
    `${cap.gpuPercent}% of the graphics`,
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
        : "The network didn't answer",
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
        <Control onClick={() => setQuestion("cap")} arrow disabled={saving}>
          Next
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  } else if (question === "cap") {
    focusKey = "cap";
    statement = "How much may it take?";
    caption = capParts;
    choices = (
      <Choices
        label="How much it may take"
        name="cap"
        value={capChoice}
        choices={CAP_CHOICES}
        onChange={(value) => {
          const picked = CAP_CHOICES.find((c) => c.value === value);
          if (picked) setCap({ cpuPercent: picked.cpuPercent, gpuPercent: picked.gpuPercent });
        }}
      />
    );
    fields = null;
    controls = (
      <>
        <Control onClick={() => setQuestion("quiet")} arrow disabled={saving}>
          Next
        </Control>
        <Control onClick={() => setQuestion("contribute")} quiet>
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
        <Control onClick={() => setQuestion("cap")} quiet disabled={saving}>
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
