import { useCallback, useEffect, useRef, useState } from "react";
import Composer from "./Composer";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import Transcript from "./Transcript";
import { GREETING, NO_ANSWER, stoppedAfter, type ChatMessage } from "./messages";
import { askNetwork, gatewaySeesUs, stopAsk, type NetworkAnswer } from "./backend";
import {
  lookForUpdate,
  restartIntoUpdate,
  runningVersion,
  type UpdateOffer,
} from "./updates";

/**
 * What the flow hands over to.
 *
 * The onboarding's last screen is a sentence saying this machine is live and
 * nothing else; this is the thing that sentence was for. Which is why it opens
 * on the greeting and the composer and no empty state — the user has just been
 * told they are live, and a screen that then asks them to set something up
 * would be taking that back.
 *
 * The question goes to the network, not to the model on this machine, and the
 * answer says which machine gave it. See `backend.askNetwork` for why the local
 * path was the wrong one, and `messages.GREETING` for the sentence that had to
 * change with it.
 */

/** Which machine answered, in the CLI's own register.
 *
 *  The CLI prints `answered by <node> · closest of 4 nodes`, and a footer saying
 *  `composed by 3 specialists + <aggregator>` when the network judged the
 *  question to want more than one machine. The candidate count is left off here:
 *  it is routing detail, and the CLI itself only shows it because a terminal has
 *  room for it. What the conversation needs is the thing a chat window normally
 *  hides — that this answer came from somewhere, and from whose machine.
 *
 *  `undefined` rather than a stand-in text when the gateway named nobody, so a
 *  line that would say nothing is not printed at all. */
function provenance(reply: NetworkAnswer): string | undefined {
  if (reply.panel.length > 1) return `composed by ${reply.panel.length} machines`;
  return reply.node === null ? undefined : `served by ${reply.node}`;
}

export default function Chat() {
  // Ids are a counter rather than a timestamp or an index. A timestamp can
  // repeat inside one millisecond and two messages in a row are exactly that
  // close; an index would be right until the day a message is ever removed.
  const nextId = useRef(1);

  // A ref, not state: it never renders, and putting it in state would rebuild
  // `send` on every keystroke's worth of change for no visible difference.
  const answering = useRef(false);

  // Which conversation the question belongs to. An answer still out on the
  // network was asked in the transcript that existed when it was sent, and
  // starting a new chat while one is out is an ordinary thing to do now that a
  // routed answer can take a minute — it used to be impossible to hit, because
  // a local model answered faster than anyone could reach for the button.
  // Without this the reply lands in the new conversation, under a question that
  // was never asked in it.
  const generation = useRef(0);

  const [messages, setMessages] = useState<readonly ChatMessage[]>(() => [
    { id: 0, role: "assistant", text: GREETING, at: new Date() },
  ]);
  const [thinking, setThinking] = useState(false);
  const [seen, setSeen] = useState<boolean | null>(null);
  const [settings, setSettings] = useState(false);

  // Whether there is a newer version of the app, and which one this is.
  //
  // Two pieces of state rather than one, because they answer questions with
  // different costs: the version is a local read that is always available, and
  // the offer depends on a check that is rationed to once a day. Settings has to
  // be able to name the version it would be moving off on a day the check did not
  // run.
  const [offer, setOffer] = useState<UpdateOffer>({ kind: "unknown" });
  const [version, setVersion] = useState("");

  useEffect(() => {
    // The read outlives a fast unmount, so the write is guarded rather than the
    // call. This also covers StrictMode's discarded first effect.
    let live = true;
    gatewaySeesUs().then(
      (answer) => {
        if (live) setSeen(answer);
      },
      // A gateway that will not answer is the unseen state, not an error this
      // screen has anything to say about: the conversation works either way.
      () => {
        if (live) setSeen(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  /**
   * Look for a new version, once, on the way in.
   *
   * From here rather than from `App`, which is where a launch-time check would
   * more obviously belong, for two reasons that are both about what else is
   * happening at launch. A machine that has just been through the flow is in the
   * middle of downloading a multi-gigabyte model, and an app update starting
   * alongside it would be competing for the same connection at the one moment the
   * user is waiting on it. And a machine that is already live does not replay the
   * flow — the chat is the first thing it draws, so this fires at launch anyway
   * for everyone the flow is behind.
   *
   * Nothing is awaited and nothing is shown while it happens: the report lands
   * whenever it lands, and `updates.lookForUpdate` has already decided that a
   * check finding nothing is not news.
   */
  useEffect(() => {
    let live = true;
    runningVersion().then((found) => {
      if (live) setVersion(found);
    });
    lookForUpdate((next) => {
      if (live) setOffer(next);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * The card's own button, which gets past the day-throttle.
   *
   * Not guarded by `live`: React 19 dropped the warning about setting state on an
   * unmounted component, and this is only reachable from a card inside this
   * component, so an unmount and a click cannot overlap.
   */
  const checkForUpdate = useCallback(() => {
    lookForUpdate(setOffer, { force: true });
  }, []);

  /**
   * Relaunch into the staged version.
   *
   * The state goes first and the call last, because the call does not come back:
   * `app.restart` replaces the process, so anything after it is written into a
   * process that is already gone. See `updates.restartIntoUpdate`.
   */
  const restartForUpdate = useCallback(() => {
    setOffer({ kind: "restarting" });
    restartIntoUpdate();
  }, []);

  const append = useCallback((line: Omit<ChatMessage, "id" | "at">) => {
    setMessages((previous) => [
      ...previous,
      { ...line, id: nextId.current++, at: new Date() },
    ]);
  }, []);

  const send = useCallback(
    (question: string): boolean => {
      // One at a time. A second question while the first is still out would
      // start a second `common` process and land the two answers in whichever
      // order they finished, which is not the order they were asked.
      if (answering.current) return false;
      answering.current = true;
      const mine = generation.current;
      append({ role: "user", text: question });
      setThinking(true);
      askNetwork(question)
        .then((reply) => {
          if (generation.current !== mine) return;
          append({
            role: "assistant",
            text: reply.answer,
            servedBy: provenance(reply),
          });
        })
        .catch(() => {
          if (generation.current !== mine) return;
          append({ role: "assistant", text: NO_ANSWER, failed: true });
        })
        .finally(() => {
          // Only the newest conversation owns the composer's busy state. A
          // stale reply must not clear a flag the new chat has already set.
          if (generation.current !== mine) return;
          answering.current = false;
          setThinking(false);
        });
      return true;
    },
    [append],
  );

  /**
   * Let go of whatever question is out on the network.
   *
   * Two things have to happen together and neither is enough alone. The process
   * has to be killed, or a donated machine goes on being spent on a question
   * nobody is waiting for — and on a network of a few laptops the node it holds
   * is one the next question could be routed to. And `generation` has to move, or
   * the rejection that kill produces is written into a conversation that has
   * already stopped caring about it.
   *
   * Both exits share this. Starting a new chat while a question is out abandons
   * that question as surely as pressing stop does — it was the only way out
   * before `Stop waiting` existed, and it would be strange for the newer and
   * lighter exit to be the only one that gives the node back.
   */
  const release = useCallback(() => {
    stopAsk();
    generation.current += 1;
    answering.current = false;
    setThinking(false);
  }, []);

  /**
   * Let go of the question, and write down how long it was held.
   *
   * The number comes from the caller rather than being measured here, because
   * here is not where the waiting happened: `Thinking` mounted, started its
   * clock, and is the only thing that knows when the last answer was rendered.
   * This callback runs from a click on that component, a moment later.
   *
   * It is written into the transcript because there is nowhere else to put it.
   * See `messages.stoppedAfter` for why the number is worth keeping and why this
   * is not the same line as `NO_ANSWER`.
   */
  const stopWaiting = useCallback(
    (waitedMs: number) => {
      release();
      append({ role: "assistant", text: stoppedAfter(waitedMs) });
    },
    [append, release],
  );

  const newChat = useCallback(() => {
    release();
    setMessages([
      { id: nextId.current++, role: "assistant", text: GREETING, at: new Date() },
    ]);
  }, [release]);

  return (
    <section className="chat" aria-label="Chat">
      <Sidebar seen={seen} onNewChat={newChat} onSettings={() => setSettings(true)} />
      <div className="chat__main">
        <Transcript messages={messages} thinking={thinking} onStop={stopWaiting} />
        {/* Only ever drawn with something to act on, so it is never a line about
            nothing. It is a button rather than a line with a control in it because
            there is exactly one thing to do here and making the sentence itself
            the target spares the user from aiming at a word inside it. */}
        {(offer.kind === "staged" || offer.kind === "restarting") && (
          <button
            className="chat__notice"
            type="button"
            onClick={restartForUpdate}
            disabled={offer.kind === "restarting"}
          >
            {offer.kind === "restarting"
              ? "Restarting…"
              : `Version ${offer.version} is ready. Restart to update.`}
          </button>
        )}
        <Composer onSend={send} busy={thinking} />
      </div>
      {/* Kept mounted and driven by `open`, rather than mounted on demand. A
          `<dialog>` that is closed is `display: none` and costs nothing, and
          taking an *open* modal dialog out of the DOM is a corner of the top
          layer with a history of leaving the page behind it inert. Opening and
          closing the same element is the path the platform is built for. The
          globe and the two network reads are gated on `open` inside, so a closed
          card is not turning a canvas behind the chat. */}
      <Settings
        open={settings}
        onClose={() => setSettings(false)}
        seen={seen}
        version={version}
        offer={offer}
        onCheck={checkForUpdate}
        onRestart={restartForUpdate}
      />
    </section>
  );
}
