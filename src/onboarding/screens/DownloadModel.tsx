import { useEffect, useState, type ReactNode } from "react";
import { formatBytes, formatTransfer } from "../copy";
import Control from "../parts/Control";
import Rule from "../parts/Rule";
import Statement from "../parts/Statement";
import type { ScreenProps } from "../steps";
import { captionText } from "../copy";
import { layersLabel, phaseOf, startPeer, stopPeer, usePeer, writeEnabled } from "../../peer/peer";
import ShareLog from "../../chat/ShareLog";

/**
 * Getting this machine's share of the model.
 *
 * Not "the model": the network splits one large model by layers, and this machine
 * downloads only the layers it will serve. The layers are not chosen here. The
 * network says which are least covered right now and the peer takes those, so the
 * first thing this screen can say about the share is how big it is, and that only
 * once the peer has worked it out.
 *
 * Nothing starts until the user says so, as before: this is the step that costs
 * real time and real disk, and beginning it on arrival would be a decision made
 * for them. The progress is the peer's own, read from its status file: real bytes,
 * not an estimate. There is no pause. The peer resumes a download it was stopped
 * in, so stopping is cheap, and a pause button for a process that keeps no partial
 * state of its own would be a button that lies.
 */

export default function DownloadModel({ next, back }: ScreenProps) {
  const view = usePeer();
  const phase = phaseOf(view);
  const status = view?.status ?? null;
  const [asked, setAsked] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Something already running (a previous run of the app, or this one before a
  // restart) is the peer's progress to show, not a reason to ask again.
  const started = asked || phase === "starting" || phase === "downloading" || phase === "loading" || phase === "up" || phase === "moving";

  useEffect(() => {
    if (!asked) return;
    writeEnabled(true);
  }, [asked]);

  const begin = () => {
    setRefused(null);
    setAsked(true);
    startPeer().catch((error: unknown) => {
      setAsked(false);
      setRefused(typeof error === "string" ? error : "I couldn't start it.");
    });
  };

  const download = status?.download ?? null;
  const fraction = download !== null && download.total > 0 ? download.bytes / download.total : null;
  const share = layersLabel(status);

  let statement: ReactNode;
  let caption: ReactNode | readonly ReactNode[];
  let controls: ReactNode;
  let focusKey: string;
  let gauge: ReactNode | undefined;

  if (confirming) {
    focusKey = "confirm";
    statement = "Stop getting your share?";
    caption = [
      download === null ? null : `${formatBytes(download.bytes)} stays on disk`,
      "you can pick it up again later",
    ];
    controls = (
      <>
        <Control onClick={() => setConfirming(false)} arrow>
          Keep going
        </Control>
        <Control
          onClick={() => {
            setConfirming(false);
            setAsked(false);
            writeEnabled(false);
            stopPeer().catch(() => {});
          }}
          quiet
        >
          Stop
        </Control>
      </>
    );
  } else if (refused !== null) {
    focusKey = "refused";
    statement = "I couldn't start it.";
    caption = [refused];
    controls = (
      <>
        <Control onClick={begin} arrow>
          Try again
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  } else if (phase === "problem" || phase === "error" || phase === "crashed") {
    focusKey = "trouble";
    statement =
      phase === "crashed" ? "It stopped on its own." : phase === "problem" ? "It can't start." : "It hit a problem.";
    caption = [
      phase === "problem" ? view?.problem ?? null : status?.error ?? "Trying again often helps",
      view?.lastExit ?? null,
    ];
    controls = (
      <>
        <Control onClick={begin} arrow>
          Try again
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
        <ShareLog />
      </>
    );
  } else if (started && (phase === "loading" || phase === "up" || phase === "moving")) {
    focusKey = "done";
    statement = "That's your share.";
    caption = [share, status?.model ?? null];
    controls = (
      <Control onClick={next} arrow>
        Continue
      </Control>
    );
  } else if (started) {
    // Starting, or downloading. Both are "working"; the caption says which part.
    focusKey = phase === "downloading" ? "downloading" : "starting";
    statement = phase === "downloading" ? "Getting your share." : "Getting ready.";
    if (phase === "downloading" && download !== null && download.total > 0) {
      caption = [share, formatTransfer(download.bytes, download.total)];
    } else if (phase === "downloading") {
      caption = [share, "starting the download"];
    } else {
      caption = ["Setting up the runtime", "the first time takes a few minutes"];
    }
    gauge = <Rule fraction={fraction} label={captionText(...(Array.isArray(caption) ? caption : [caption as string]))} />;
    controls = (
      <Control onClick={() => setConfirming(true)} quiet>
        Cancel
      </Control>
    );
  } else {
    focusKey = "ready";
    statement = "Ready when you are.";
    caption = [
      "Downloads only the layers you'll serve",
      "a few gigabytes, once",
    ];
    controls = (
      <>
        <Control onClick={begin} arrow>
          Get my share
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
      </>
    );
  }

  return (
    <Statement statement={statement} caption={caption} controls={controls} focusKey={focusKey} gauge={gauge} />
  );
}
