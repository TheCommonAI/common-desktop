import { useEffect, useState, type ReactNode } from "react";
import { formatBytes } from "../copy";
import { capabilityOf, gb } from "../capability";
import Choices from "../parts/Choices";
import Control from "../parts/Control";
import Statement from "../parts/Statement";
import { onboardingService, type HardwareReport, type ScanProgress } from "../service";
import type { ScreenProps } from "../steps";
import { outcomeKey, useTask } from "../use-task";

/**
 * The read, and the only place the flow's later screens get their input.
 *
 * The four reads are one caption that changes rather than four rows: the phase
 * *is* the caption, and when the last read lands the same caption becomes the
 * report. Nothing moves, nothing is added — one line rewrites itself, which is
 * the whole register in one screen.
 */

const PHASES: Record<ScanProgress["field"], string> = {
  memory: "Reading memory…",
  graphics: "Reading graphics…",
  disk: "Reading disk…",
  power: "Reading power…",
};

/** Below this, free space is worth a clause on the way past. A share of the model
 *  is a few gigabytes, and the download lands beside a partial copy until it is
 *  checked; this is a heads-up, not a gate. */
const TIGHT = gb(8);

const MEMORY_CHOICES = [
  { value: gb(8), label: "8 GB" },
  { value: gb(16), label: "16 GB" },
  { value: gb(32), label: "32 GB" },
];

function powerClause(power: HardwareReport["power"]): string | null {
  if (power === null) return null;
  if (power.source === "mains") return "on mains power";
  if (power.source === "battery") {
    return power.batteryPercent === null ? "on battery" : `${power.batteryPercent}% battery`;
  }
  // "unknown" is a real answer, and a clause invented for it would not be.
  return null;
}

/** The report as one clause per read. A read that came back `null` is dropped,
 *  so a refused graphics probe costs the user a clause rather than the screen. */
function reportParts(hardware: HardwareReport): readonly ReactNode[] {
  const memory = hardware.memory?.totalBytes;
  const disk = hardware.disk?.freeBytes;
  return [
    memory === undefined ? null : `${formatBytes(memory)} memory`,
    hardware.graphics?.name ?? null,
    disk === undefined ? null : disk < TIGHT ? (
      // The one segment in full ink on this screen. Attention is earned by the
      // clause carrying more weight than its neighbours, not by a hue.
      <strong className="caption__strong" key="disk">
        {`${formatBytes(disk)} free — that's tight`}
      </strong>
    ) : (
      `${formatBytes(disk)} free`
    ),
    powerClause(hardware.power),
  ];
}

export default function HardwareScan({ flow, update, next, back }: ScreenProps) {
  const { state, run } = useTask<HardwareReport, ScanProgress>((opts) =>
    onboardingService.scanHardware(opts),
  );
  // Seeded from anything already chosen, so coming Back to this screen after
  // entering a figure by hand finds it still there.
  const [memory, setMemory] = useState<number | null>(flow.memoryOverrideBytes);

  // No guard against React's double-invoke: a ref would survive it and leave
  // nothing running. The generation counter in `useTask` already makes the
  // cancelled first run inert, so running unconditionally is the correct thing
  // to write here as well as the simpler one.
  useEffect(() => {
    run();
  }, [run]);

  const report = state.status === "done" ? state.value : null;
  // A memory the machine would not tell us is the one read the user can supply,
  // and the only one the rest of the flow cannot do without — the tier is
  // decided by it. Everything else nullable stays nullable, and its clause
  // simply goes missing.
  const unreadable = report !== null && report.memory === null;

  let statement: ReactNode;
  let caption: ReactNode | readonly ReactNode[];
  let controls: ReactNode;
  let focusKey: string;

  if (state.status === "error") {
    focusKey = "error";
    statement = "I couldn't read this machine.";
    caption = [
      "The system wouldn't let me look",
      "trying again often helps",
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
  } else if (unreadable) {
    focusKey = "hand";
    statement = "How much memory does it have?";
    caption = ["I couldn't read that one", "pick the closest"];
    controls = (
      <>
        <Choices
          label="Memory"
          name="memory"
          value={memory}
          choices={MEMORY_CHOICES}
          onChange={setMemory}
        />
        <Control
          onClick={() => {
            update({ hardware: report, memoryOverrideBytes: memory });
            next();
          }}
          arrow
          disabled={memory === null}
        >
          Continue
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  } else if (report !== null) {
    // The verdict comes before the next step, not after the download: a machine
    // the network cannot use should hear that now, not after a wait.
    const verdict = capabilityOf(report, flow.memoryOverrideBytes);
    if (verdict.can) {
      focusKey = "done";
      statement = "This machine can serve part of the model.";
      caption = [
        `${verdict.how[0].toUpperCase()}${verdict.how.slice(1)}`,
        `about ${formatBytes(verdict.offeredBytes)} to offer`,
        ...reportParts(report).slice(1),
      ];
      controls = (
        <>
          <Control
            onClick={() => {
              update({ hardware: report });
              next();
            }}
            arrow
          >
            Continue
          </Control>
          <Control onClick={back} quiet>
            Back
          </Control>
        </>
      );
    } else {
      focusKey = "cannot";
      statement = "This machine can't serve part of the model yet.";
      caption = [verdict.why, ...reportParts(report).slice(0, 2)];
      controls = (
        <>
          <Control onClick={run} arrow>
            Scan again
          </Control>
          <Control onClick={back} quiet>
            Back
          </Control>
        </>
      );
    }
  } else {
    const field = state.status === "running" ? (state.progress?.field ?? "memory") : "memory";
    focusKey = outcomeKey(state);
    statement = "Having a look.";
    caption = (
      // The one caption in the flow that is a live region: four reads land
      // while the statement above it stays put, so the focus that announces
      // everything else has nothing to announce.
      <span aria-live="polite">{PHASES[field]}</span>
    );
    controls = (
      <Control onClick={back} quiet>
        Back
      </Control>
    );
  }

  return <Statement statement={statement} caption={caption} controls={controls} focusKey={focusKey} />;
}
