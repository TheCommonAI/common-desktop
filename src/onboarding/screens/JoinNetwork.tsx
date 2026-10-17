import { useState, type ReactNode } from "react";
import ShareLog from "../../chat/ShareLog";
import ThinkingMark from "../../chat/ThinkingMark";
import { preparingSentences } from "../../provision";
import { useProvision } from "../../useProvision";
import { formatBytes, formatLatency } from "../copy";
import { LANE_LABEL, findModel } from "../models";
import Control from "../parts/Control";
import Statement from "../parts/Statement";
import { onboardingService, type JoinProgress, type JoinResult, type ModelSpec } from "../service";
import type { ScreenProps } from "../steps";
import { refused, useTask } from "../use-task";

/**
 * The end, and the only green in the app.
 *
 * The verification is a sequence of statements rather than a checklist, which
 * makes it the purest screen in the register: one thing is happening at a time,
 * and the statement is the thing. Nothing starts until the user asks, and
 * nothing is offered while it runs — there is no useful way to interrupt a
 * registration, so there is no control offering to. What it does have is a mark,
 * because a screen that changes nothing for two minutes is indistinguishable from
 * one that has stopped; see `gauge` below.
 *
 * The last state had no controls at all, and the flow ended on the sentence. It
 * has exactly one now, because the sentence is no longer the end of anything:
 * it says this machine is live, and there is now a screen where being live is
 * worth something. One control, and it is the only place in the flow where the
 * forward move does not go to another step.
 *
 * The states where it does *not* work carry a way to leave with the evidence — a
 * report of this machine, this is `ShareLog`. Two of them do say "it will not
 * connect", and they are different failures: one is the gateway not being able to
 * route here, which is a firewall and not a bug report; the other is the gateway
 * never answering at all. The third is nearer this side of the glass — the join
 * never got through — and saying "the network didn't answer" about it is what this
 * screen used to do to a Windows machine whose node was listed in `/peers`, which
 * is the mistake the split below exists to prevent. Which of the three is showing
 * is decided by the error's `code`, and the detail line under each is whatever
 * evidence came with it: the join log, or the exit code when there is no log.
 */

/** The clause for a phase, which is the whole caption: the phase *is* the
 *  information, so there is no second line for it to sit beside.
 *
 *  `"preparing"` is the one case the renderer does not use, because that phase is
 *  not a step of the join and its words are somewhere a test can hold them still
 *  — see `preparingSentences`. It is answered here anyway: a function over a
 *  union that leaves one arm to fall off the end returns nothing, and a screen
 *  with no sentence on it is the exact failure this file's header is about. */
function phaseStatement(phase: JoinProgress["phase"], label: string): ReactNode {
  switch (phase) {
    case "preparing":
      return "Getting this machine ready.";
    case "registering":
      return "Registering this machine.";
    case "fetching-model":
      // The one phase whose wait is genuinely long, and the only one of the six
      // that used to be a screen of its own. It is not the join doing this — the
      // CLI's runtime is, on its way up — which is why the line under it is the
      // fetcher's own count rather than anything this app worked out.
      return `Fetching ${label}.`;
    case "loading-model":
      return `Loading ${label}.`;
    case "test-prompt":
      return "Asking it something.";
    case "confirming":
      return "Checking the network can see you.";
  }
}

/** The line under the statement, which says what is being waited for. Split out
 *  beside `phaseStatement` and for the same reason: a function over the union
 *  makes a phase without words a missing arm rather than a frame with nothing on
 *  it.
 *
 *  `"preparing"` is the one arm not here, and unlike in `phaseStatement` that is
 *  not a gap to be filled — that phase draws a transfer of its own and its words
 *  come from `provision.ts`, where a test can hold them still. The caller settles
 *  it before it gets here, which is why the parameter excludes it rather than
 *  answering it with something empty. */
function phaseCaption(
  phase: Exclude<JoinProgress["phase"], "preparing">,
  model: ModelSpec | null,
  progress: JoinProgress | null,
): readonly ReactNode[] {
  switch (phase) {
    case "fetching-model": {
      const fetch = progress?.fetch;
      if (fetch === undefined) {
        // Reachable for the first tenth of the way and no further: the fetcher
        // prints a line at each ten percent, and before the first of them there
        // is no count to show. The statement already names what is coming; this
        // claims no more than that it is still coming.
        return ["The weights are on their way down"];
      }
      // Both halves, in this order. The fraction is how far along it is; the two
      // sizes say what is being waited for, which ten percentages on their own
      // never do. They are the fetcher's own rendering of them and not this
      // app's, so nothing here rounds a number it did not measure — see
      // `JoinProgress.fetch`, which is where that argument is made.
      return [`${fetch.percent}%`, `${fetch.done} of ${fetch.total}`];
    }
    case "loading-model":
      return [model === null ? null : `${formatBytes(model.bytes)} from disk into memory`];
    case "test-prompt":
      return progress?.answered === undefined
        ? // What the model was asked is not known until the answer comes back,
          // and this screen does not invent it. One true clause now, the proof in
          // a moment.
          ["Your machine is answering it"]
        : [
            `“${progress.answered.prompt}”`,
            `“${progress.answered.answer}”`,
            `${formatLatency(progress.answered.latencyMs)} on your machine`,
          ];
    case "confirming":
      return ["Waiting for the gateway to answer"];
    case "registering":
      // A name for this machine, and nothing else. It used to say "and a key for
      // it", which was false: the Alpha issues a bearer token to a node —
      // `identity.json` holds it — and never a keypair, so there is no key being
      // made here and nothing for a user to keep.
      return ["Choosing a name for this machine"];
  }
}

export default function JoinNetwork({ flow, next, back }: ScreenProps) {
  const model = flow.modelId === null ? null : findModel(flow.modelId);
  const label = model?.label ?? "the model";

  // The machine being got ready, for the phase that has to draw it. Subscribed
  // rather than started: the fetch begins at launch and belongs to the app, not
  // to this screen — a screen that started it would be a screen that could
  // abandon it, and the two files it brings are needed either way.
  const provision = useProvision();

  const { state, run } = useTask<JoinResult, JoinProgress>((opts) =>
    flow.lane === null || flow.modelId === null
      ? refused<JoinResult>("Nothing to join with.")
      : onboardingService.joinNetwork(
          {
            lane: flow.lane,
            modelId: flow.modelId,
            // The step machine will not have let the user here without an
            // answer, so this fallback is unreachable; it exists so that the
            // request type stays honest rather than to be used.
            limits: flow.limits ?? {
              contribute: "idle",
              cap: { cpuPercent: 50, gpuPercent: 40 },
              quietHours: null,
            },
          },
          opts,
        ),
  );

  /**
   * Which run this is. Focus has to move when the controls come and go — a
   * retry unmounts the button that was pressed — but not when one phase
   * replaces another, because nothing on screen unmounted. So the focus key is
   * constant for the length of a run and changes only when a new one starts,
   * and the phase changes are announced by the live region instead. Two
   * mechanisms, never both for the same change.
   */
  const [attempt, setAttempt] = useState(0);
  const start = () => {
    setAttempt((n) => n + 1);
    run();
  };

  const progress = state.status === "running" || state.status === "error" ? state.progress : null;
  // Before the first phase lands the request has still been sent, so the first
  // thing it does is the honest thing to say.
  const phase = progress?.phase ?? "registering";

  let statement: ReactNode;
  let caption: ReactNode | readonly ReactNode[];
  let gauge: ReactNode | undefined;
  let controls: ReactNode | undefined;
  let live = false;

  if (state.status === "done") {
    const join = state.value;
    if (join.gatewaySeen) {
      live = true;
      statement = `You're live in the ${LANE_LABEL[join.lane]} lane.`;
      caption = [`Node ${join.nodeId}`, label];
    } else {
      // A successful call reporting a failed check. The node is registered —
      // that is not in doubt, and saying otherwise would send the user looking
      // for a problem that is not there — but the gateway cannot route to it.
      //
      // The second clause used to read "usually a firewall", which is the one
      // likely cause that is wrong here: the gateway reaches this machine through
      // a tunnel this end opened *outward*, so a firewall on this end is not what
      // stands in the way — a network that filters the tunnel's host is, and a
      // quick tunnel that has gone stale is. Both are named, neither is chosen:
      // the app cannot tell them apart from here, and Try again is the move that
      // answers it either way.
      statement = "You're registered.";
      caption = ["But the gateway can't reach this machine", "usually a firewall or a restrictive network"];
    }
    controls = join.gatewaySeen ? (
      // The one control on the green screen, and the only forward move in the
      // flow that leads out of the flow. It does not name the chat, because the
      // thing the user wants is not "the chat" — it is to ask this machine
      // something, which is what the test prompt a moment ago already did.
      <Control onClick={next} arrow>
        Ask it something
      </Control>
    ) : (
      <>
        <Control onClick={start} arrow>
          Try again
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
        {/* The registered-but-unreachable case is still "it will not connect",
            which is the whole of what a report is for. */}
        <ShareLog />
      </>
    );
  } else if (state.status === "error") {
    // Two failures on this screen are not network failures, and they are the two
    // that need saying so most plainly.
    //
    // A missing `common` never left this machine — nothing was asked of any
    // network — so calling it one would send the user to inspect a gateway that
    // was never reached. It gets its own sentence and its own clause, and no
    // detail line: the detail is the same sentence with a path on it, and the path
    // is in the log the Share control carries.
    //
    // A join that did not get through reached the network, or was trying to, and the
    // app has given up on it. Saying "nothing came back from the gateway" there is the
    // wrong way round: it blames the far side for something this machine may have done,
    // and it is what a Windows machine was told while its node sat in `/peers`. The
    // detail is the fact that says which it was, and it arrives by two roads: the exit
    // code of a wrapper that failed to hand off, or — on Windows, where the handle sees
    // nothing and `join.log` is the only witness — the last line of the log that reads
    // as a failure. Neither road establishes that the process is *dead*, so the
    // sentence claims only that it did not get through.
    const missingCli = state.error.code === "cli-missing";
    const stopped = state.error.code === "join-stopped";
    statement = missingCli
      ? "Common isn't fully installed."
      : stopped
        ? "The join didn't get through."
        : "The network didn't answer.";
    caption = missingCli
      ? [
          // Nothing here is something the user has to go and find. The app ships
          // the tool and fetches the interpreter it runs under, so the sentence
          // names the half that can still be missing — and says the fetch is what
          // did not finish, rather than implying there is an install to go and
          // do. Telling someone to install a Python this app was about to
          // download for them is the mistake the previous wording made once
          // already, in the other direction.
          "Its command-line tool couldn't be started",
          "This app fetches the Python to run it with, and that didn't get through",
        ]
      : stopped
        ? [
            // What the app actually knows, and no more — which here is less than "it
            // stopped". Two roads reach this state and only one of them witnessed a
            // death: the exit code of a wrapper that failed to hand off, and, on
            // Windows, the last line of `join.log` that reads as one. The log cannot
            // separate a dead join from a live one that is failing, because `join.py`
            // prints the same `✗` for a re-registration it survives as for a failure it
            // does not. So the clause says only what both roads support: this join did
            // not get through, and the line below is the last thing it said about why.
            "Its join reported a problem",
            state.error.detail ?? null,
          ]
        : [
            state.error.code === "timeout"
              ? "It took too long to answer"
              : state.error.code === "network"
                ? "Nothing came back from the gateway"
                : "Something went wrong at this end",
            state.error.detail ?? null,
          ];
    controls = (
      <>
        <Control onClick={start} arrow>
          Try again
        </Control>
        <Control onClick={back} quiet>
          Back
        </Control>
        {/* This is the state the report exists for: the join failed, the reason
            is in a log on this machine, and the person who could read it is not
            sitting here. */}
        <ShareLog />
      </>
    );
  } else if (state.status === "running") {
    if (phase === "preparing") {
      // Not a step of the join, so not a step's sentence. The machine is being
      // got ready somewhere else in the app — the fetch starts at launch and
      // belongs to no screen — and the words for it, transfer included, are in
      // `provision.ts` where a test can reach them. This screen is only the
      // place they are read from, which is why the phase is on `JoinProgress`
      // at all.
      //
      // It is also the one state here that draws a transfer, and it is a much
      // smaller one than the flow's other wait: tens of megabytes rather than
      // gigabytes, and only on a machine that was missing something.
      const waiting = preparingSentences(provision);
      statement = waiting.statement;
      caption = waiting.caption;
    } else {
      statement = phaseStatement(phase, label);
      caption = phaseCaption(phase, model, progress);
    }
    // The mark, for the whole of the running state and for none of any other.
    //
    // This screen said nothing at all while it worked. Four phases of caption, each
    // one true, and every one of them a sentence that sits still — which is the same
    // thing on screen as a screen that has hung. The register will not carry a spinner
    // and should not: a spinner is furniture, and the app already has one mark for
    // "this is working and you are waiting", which is the one the chat shows while the
    // network has the question.
    //
    // Not per phase, and that is deliberate. From this side of the glass "the join is
    // running" is one state, the caption already names which part of it is happening,
    // and a rule with no cases is a rule that cannot be got wrong later. It goes the
    // moment the run does, whether that is a result or a failure, because the mark is
    // the promise of further news and there is none.
    gauge = <ThinkingMark />;
    controls = undefined;
  } else {
    statement = "One last thing.";
    caption = [
      "Registering this machine",
      "asking the model a question",
      "checking the gateway can see you",
    ];
    controls = (
      <>
        <Control onClick={start} arrow>
          Join the network
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
      caption={caption}
      gauge={gauge}
      controls={controls}
      live={live}
      focusKey={state.status === "idle" ? "ready" : `join-${attempt}`}
      announce={state.status !== "idle"}
    />
  );
}
