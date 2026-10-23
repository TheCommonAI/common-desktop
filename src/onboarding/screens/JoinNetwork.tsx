import { type ReactNode } from "react";
import ShareLog from "../../chat/ShareLog";
import ThinkingMark from "../../chat/ThinkingMark";
import Control from "../parts/Control";
import Statement from "../parts/Statement";
import type { ScreenProps } from "../steps";
import { chatReady, layersLabel, otherPeers, phaseOf, startPeer, stagesCovered, usePeer } from "../../peer/peer";

/**
 * The end, and the only green in the app.
 *
 * The peer is already running by the time this screen is reached: the previous one
 * started it and waited for it to have a share. What is left is the part that
 * cannot be rushed — loading that share into memory, announcing itself, and
 * finding the others — and then the sentence that ends the flow.
 *
 * It says only what the peer has said. "You're part of the network" appears when
 * the peer reports it is up and chat has loaded; before that, the caption names
 * which step it is on. How many other machines are there, and how many of the
 * model's stages have somebody serving them, come from the peer's own view of the
 * network. A network with a stage nobody serves cannot answer yet, and this screen
 * says that instead of pretending.
 */

export default function JoinNetwork({ next, back }: ScreenProps) {
  const view = usePeer();
  const phase = phaseOf(view);
  const status = view?.status ?? null;
  const others = otherPeers(status).length;
  const covered = stagesCovered(status);
  const share = layersLabel(status);

  let statement: ReactNode;
  let caption: ReactNode | readonly ReactNode[];
  let gauge: ReactNode | undefined;
  let controls: ReactNode | undefined;
  let live = false;

  if (phase === "up" && chatReady(view)) {
    const whole = covered !== null && covered.covered === covered.total;
    live = whole;
    statement = whole ? "You're part of the network." : "You're on the network.";
    caption = [
      share,
      others === 0 ? "the first machine here" : `${others} other ${others === 1 ? "machine" : "machines"} online`,
      covered === null ? null : whole ? "every part of the model is covered" : `${covered.covered} of ${covered.total} parts covered`,
    ];
    controls = (
      <>
        <Control onClick={next} arrow>
          {whole ? "Ask it something" : "Open chat"}
        </Control>
        {status?.url ? (
          <span className="sheet__fields" aria-label="Join address">
            {`Friends can join through you: common join --network ${status.url}`}
          </span>
        ) : null}
      </>
    );
  } else if (phase === "up") {
    statement = "Almost there.";
    caption = [share, "loading the chat part"];
    gauge = <ThinkingMark />;
  } else if (phase === "loading" || phase === "moving") {
    statement = phase === "moving" ? "Moving to where you're needed." : "Loading your share.";
    caption = [share, "putting it into memory"];
    gauge = <ThinkingMark />;
  } else if (phase === "error" || phase === "problem" || phase === "crashed" || phase === "off" || phase === "leaving") {
    statement = phase === "off" || phase === "leaving" ? "It isn't running." : "It hit a problem.";
    caption = [
      phase === "problem" ? view?.problem ?? null : status?.error ?? null,
      phase === "crashed" ? "It stopped on its own" : null,
    ];
    controls = (
      <>
        <Control
          onClick={() => {
            startPeer().catch(() => {});
          }}
          arrow
        >
          Try again
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
        <ShareLog />
      </>
    );
  } else {
    statement = "Joining the network.";
    caption = ["Finding the other machines", "telling them you're here"];
    gauge = <ThinkingMark />;
  }

  return (
    <Statement
      statement={statement}
      caption={caption}
      gauge={gauge}
      controls={controls}
      live={live}
      focusKey={live ? "live" : phase}
      announce
    />
  );
}
