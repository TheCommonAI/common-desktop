import { useEffect, useState, type ReactNode } from "react";
import {
  captionText,
  formatBytes,
  formatEta,
  formatTransfer,
} from "../copy";
import { findModel } from "../models";
import Control from "../parts/Control";
import Rule from "../parts/Rule";
import Statement from "../parts/Statement";
import {
  onboardingService,
  type DownloadProgress,
  type DownloadResult,
  type HardwareReport,
} from "../service";
import type { ScreenProps } from "../steps";
import { refused, useTask } from "../use-task";

/**
 * The long one, and the screen with the most ways to be in the middle of
 * something.
 *
 * Nothing starts until the user says so: this is the only step whose work costs
 * real time and real disk, and beginning it on arrival would be a decision made
 * for them. Before it begins, it says what the download will cost and whether
 * there is room — the disk warning is this state, not a dialog over it.
 *
 * The gauge is a hairline. The numbers are the type.
 */

/** What a transfer needs beyond the weights themselves: room for the partial
 *  file beside the finished one while the checksum is checked. */
const HEADROOM = 1.15;

/** Rounded up to the nearest tenth of a gigabyte, and up rather than to
 *  nearest: this is a requirement, and a requirement that rounds down is one
 *  the check it describes can fail. */
function requirement(bytes: number): number {
  return Math.ceil((bytes * HEADROOM) / 1e8) * 1e8;
}

export default function DownloadModel({ flow, update, next, back }: ScreenProps) {
  const model = flow.modelId === null ? null : findModel(flow.modelId);
  const free = flow.hardware?.disk?.freeBytes ?? null;
  const required = model === null ? 0 : requirement(model.bytes);
  const blocked = free !== null && free < required;

  const { state, run, cancel, pause, resume } = useTask<DownloadResult, DownloadProgress>(
    (opts) =>
      model === null
        ? refused<DownloadResult>("No model chosen.")
        : onboardingService.downloadModel({ modelId: model.id }, opts),
  );

  // Re-reading the disk, for the other fix to a full disk: the user frees space
  // elsewhere and comes back. Its own task, so leaving the screen cancels it
  // like everything else.
  const recheck = useTask<HardwareReport, never>(() => onboardingService.scanHardware());
  useEffect(() => {
    if (recheck.state.status === "done") update({ hardware: recheck.state.value });
  }, [recheck.state, update]);

  /** The last two controls are about to be replaced by two different ones. */
  const [confirming, setConfirming] = useState(false);

  const progress = state.status === "running" || state.status === "error" ? state.progress : null;
  const total = progress?.totalBytes ?? null;
  const fraction =
    progress !== null && total !== null && total > 0 ? progress.receivedBytes / total : null;

  const label = model?.label ?? "the model";

  /** The caption as a plain line, for the gauge to read out. */
  let parts: readonly (string | null)[];
  /** Whether the caption is beside a gauge that is on screen. */
  let gauged = false;

  let statement: ReactNode;
  /** `undefined`, not `null`, for a state with nothing to offer — an empty
   *  control line would still be a line. */
  let controls: ReactNode | undefined;
  let focusKey: string;

  if (confirming) {
    focusKey = "confirm";
    statement = "Stop the download?";
    parts = [
      total === null ? null : `${formatBytes(progress?.receivedBytes ?? 0)} stays on disk`,
      "you can pick it up again later",
    ];
  } else if (state.status === "done") {
    focusKey = "done";
    statement = "That's the model.";
    parts = [label, "ready"];
  } else if (state.status === "error") {
    focusKey = "error";
    statement = "The download stopped.";
    parts = [
      total === null
        ? null
        : `${formatTransfer(progress?.receivedBytes ?? 0, total)} is on disk`,
      "resuming will be quick",
      state.error.detail ?? null,
    ];
    gauged = true;
  } else if (state.status === "running") {
    const current = state.progress;
    focusKey = current?.state === "paused" ? "paused" : current?.state === "verifying" ? "verifying" : "running";
    statement = `Downloading ${label}.`;
    if (current === null) {
      parts = ["Starting…"];
    } else if (current.state === "verifying") {
      parts = ["Checking the file…"];
    } else if (current.state === "paused") {
      parts = [`Paused at ${formatBytes(current.receivedBytes)}`];
    } else if (current.totalBytes === null) {
      parts = [`${formatBytes(current.receivedBytes)} downloaded`, formatEta(current.etaSeconds)];
    } else {
      parts = [
        formatTransfer(current.receivedBytes, current.totalBytes),
        formatEta(current.etaSeconds),
      ];
    }
    gauged = true;
  } else if (blocked) {
    focusKey = "blocked";
    statement = "There isn't room for this one.";
    parts = [
      `Needs ${formatBytes(required)}`,
      free === null ? null : `you have ${formatBytes(free)} free`,
    ];
  } else {
    focusKey = "ready";
    statement = "Ready when you are.";
    parts = [
      label,
      model === null ? null : formatBytes(model.bytes),
      free === null ? null : `${formatBytes(free)} free`,
    ];
  }

  if (confirming) {
    controls = (
      <>
        <Control onClick={() => setConfirming(false)} arrow>
          Keep going
        </Control>
        <Control
          onClick={() => {
            setConfirming(false);
            cancel();
          }}
          quiet
        >
          Stop
        </Control>
      </>
    );
  } else if (state.status === "done") {
    controls = (
      <>
        <Control onClick={next} arrow>
          Continue
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  } else if (state.status === "error") {
    controls = (
      <>
        <Control onClick={run} arrow>
          Resume
        </Control>
        <Control onClick={() => setConfirming(true)} quiet>
          Cancel
        </Control>
      </>
    );
  } else if (state.status === "running") {
    controls =
      state.progress?.state === "verifying" ? undefined : (
        <>
          {state.progress?.state === "paused" ? (
            <Control onClick={resume}>Resume</Control>
          ) : (
            <Control onClick={pause}>Pause</Control>
          )}
          <Control onClick={() => setConfirming(true)} quiet>
            Cancel
          </Control>
        </>
      );
  } else if (blocked) {
    controls = (
      <>
        <Control onClick={back} arrow>
          Choose another lane
        </Control>
        <Control
          onClick={recheck.run}
          quiet
          disabled={recheck.state.status === "running"}
        >
          Check again
        </Control>
      </>
    );
  } else {
    controls = (
      <>
        <Control onClick={run} arrow>
          Download
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  }

  return (
    <Statement
      statement={statement}
      caption={parts}
      controls={controls}
      focusKey={focusKey}
      gauge={gauged ? <Rule fraction={fraction} label={captionText(...parts)} /> : undefined}
    />
  );
}
