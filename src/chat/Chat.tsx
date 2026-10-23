import { useCallback, useEffect, useRef, useState } from "react";
import Composer from "./Composer";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import Transcript from "./Transcript";
import UpdatePrompt from "./UpdatePrompt";
import WhatsNew from "./WhatsNew";
import {
  loadConversations,
  mostRecentlyUsed,
  newConversation,
  nextIdAbove,
  saveConversations,
  type Conversation,
} from "./conversations";
import { messagesFor } from "./context";
import { NO_ANSWER, stoppedAfter, type ChatMessage } from "./messages";
import { chatReady, otherPeers, peer, phaseOf, readEnabled, stagesCovered, usePeer, useAutostart } from "../peer/peer";
import { preview } from "../preview";
import { useContributionPolicy } from "./policy";
import {
  lookForUpdate,
  restartIntoUpdate,
  runningVersion,
  takeUpdate,
  type UpdateOffer,
} from "./updates";
import { readSeenVersion, rememberSeenVersion, whatsNewFor } from "./whats-new";

/**
 * What the flow hands over to.
 *
 * The onboarding's last screen is a sentence saying this machine is live and
 * nothing else; this is the thing that sentence was for. Which is why it opens
 * on the greeting and the composer and no empty state — the user has just been
 * told they are live, and a screen that then asks them to set something up
 * would be taking that back.
 *
 * The question goes to this machine's own peer, which passes it through the layers
 * of the model held by the network, and the answer streams back as it is made. See
 * `peer/` for the peer, and `messages.GREETING` for the sentence that says so.
 *
 * There is more than one conversation now, and they outlive the window: the list
 * is read off disk on the way in and written back on every change. This component
 * is where both of those happen, because it is the only thing that knows when a
 * chat has changed — see `conversations.ts` for the file and `Sidebar` for the
 * list. What has *not* changed is that a chat is a conversation; there is still
 * nothing here but the words and the machines that answered them.
 */

/**
 * Why a question cannot be sent right now, in the composer's own voice, or
 * `undefined` when it can. Only what the peer has said: it never guesses a state.
 */
function unavailableReason(phase: ReturnType<typeof phaseOf>, view: ReturnType<typeof usePeer>, paused: string | null): string | undefined {
  if (paused !== null) return `${paused}.....`;
  const status = view?.status;
  switch (phase) {
    case "unknown":
    case "starting":
      return "Getting ready.....";
    case "downloading": {
      const d = status?.download;
      const pct = d && d.total > 0 ? ` ${Math.round((d.bytes / d.total) * 100)}%` : "";
      return `Getting your share${pct}.....`;
    }
    case "loading":
    case "moving":
      return "Loading your share.....";
    case "leaving":
      return "Leaving the network.....";
    case "off":
      return "Not on the network — turn it on in Settings.....";
    case "problem":
    case "error":
      return "Can't join — see Settings.....";
    case "crashed":
      return "It stopped — see Settings.....";
    case "up":
      return status?.api?.ready === true ? undefined : "Loading the chat part.....";
  }
}

/** Every chat, and which one is on screen. */
interface Chats {
  /** Never empty. Both paths that could empty it — `deleteChat` and the initial
   *  state — put a fresh conversation in rather than let the rail draw nothing. */
  list: readonly Conversation[];
  activeId: string;
}

export default function Chat() {
  // Ids are a counter rather than a timestamp or an index. A timestamp can
  // repeat inside one millisecond and two messages in a row are exactly that
  // close; an index would be right until the day a message is ever removed.
  //
  // A counter for the session, which is why loading a chat has to resume it above
  // whatever the file got up to — see `nextIdAbove`.
  const nextId = useRef(1);

  // A ref, not state: it never renders, and putting it in state would rebuild
  // `send` on every keystroke's worth of change for no visible difference.
  const answering = useRef(false);

  // When the question currently out on the network was sent, or zero when none
  // is. Read by `release` on the way out, which has to write down how long the
  // user held on and cannot ask `Thinking`, since `Thinking` is being unmounted
  // in the same breath.
  const askingSince = useRef(0);

  // Which request a late reply belongs to. A killed request does not stop
  // existing: `stopAsk` rejects the promise it was waiting on, and that rejection
  // would otherwise be written into the transcript as an answer from the network.
  // Bumped by every `release`, which is the one place a question is given up —
  // stopping it, leaving the chat it was asked in, or starting another.
  const generation = useRef(0);

  const [chats, setChats] = useState<Chats>(() => {
    const first = newConversation();
    return { list: [first], activeId: first.id };
  });
  const [thinking, setThinking] = useState(false);
  // True from the first word of an answer until it ends. `thinking` covers the wait
  // before the first word; this covers the words arriving, when the composer is
  // still busy but the "Thinking" mark has done its job.
  const [streaming, setStreaming] = useState(false);
  const [settings, setSettings] = useState(() => preview().settings);

  const view = usePeer();
  const phase = phaseOf(view);
  const paused = useContributionPolicy();
  // Bring the peer up on launch if the user left it on. Policy may then hold it
  // back; that is the policy's call, not this effect's.
  useAutostart(readEnabled() && paused === null);
  // The peer's latest view, for the line under an answer — read when the answer
  // finishes, not when it starts.
  const latestView = useRef(view);
  latestView.current = view;

  // The one stream in flight, so it can be let go of.
  const stopStream = useRef<(() => void) | null>(null);

  // The notes for a version that has just arrived, or `null` for the ordinary
  // launch where there is nothing to say. Read once, at launch, off the same
  // version read the Settings row uses — see `whats-new.ts` for what counts as an
  // update and why a first run counts as one.
  const [fresh, setFresh] = useState<{ version: string; notes: readonly string[] } | null>(null);

  // What the file is believed to hold. `null` until it has been read at all, which
  // is the whole of what keeps the first render from being written over the chats
  // that have not been loaded yet.
  const onDisk = useRef<readonly Conversation[] | null>(null);

  // Whether there is a newer version of the app, and which one this is.
  //
  // Two pieces of state rather than one, because they answer questions with
  // different costs: the version is a local read that is always available, and
  // the offer depends on a check that is rationed. Settings has to be able to name
  // the version it would be moving off at a moment the check did not run.
  const [offer, setOffer] = useState<UpdateOffer>({ kind: "unknown" });
  const [version, setVersion] = useState("");

  // The version the user has waved away, if any, and only for as long as this launch
  // lasts. Nothing is written to disk, which is the whole of "ask again next launch":
  // a dismissal that outlived the process would be a person who said "later" once and
  // then never heard about the release again, which is the state this card exists to
  // get out of. A later release re-asks on its own, since the version it names is not
  // the one that was dismissed.
  const [wavedAway, setWavedAway] = useState<string | null>(null);

  const active = chats.list.find((chat) => chat.id === chats.activeId) ?? chats.list[0];

  /**
   * The chats on disk, once, on the way in.
   *
   * The seeded conversation above is a real chat rather than a placeholder,
   * because there is a frame on screen before this promise settles and it has to
   * be a working screen. Adopting the stored list then replaces it — the read is
   * one local file, so it lands before a hand could reach the keyboard, and the
   * alternative is the merge bookkeeping of a race nobody can lose.
   */
  useEffect(() => {
    let live = true;
    loadConversations().then((stored) => {
      if (!live) return;
      // Nothing saved: a first run, or a file that could not be read. What is on
      // screen stands, and `onDisk` records the state of the world as empty so
      // that the effect below stops holding writes back.
      if (stored.length === 0) {
        onDisk.current = [];
        return;
      }
      nextId.current = nextIdAbove(stored);
      onDisk.current = stored;
      setChats({ list: stored, activeId: mostRecentlyUsed(stored).id });
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Write the chats back whenever they change.
   *
   * Guarded on `onDisk`, which is `null` until the file has been read: without
   * that, the first render — one empty chat — would be written over everything the
   * user has a few milliseconds before it was going to be loaded.
   *
   * The comparison is by reference, which here is exact rather than merely cheap.
   * Every mutation above builds a new list, so identity is a faithful answer to
   * "has this changed", and a deep comparison would be a slower way of asking the
   * same question. It also means a save never fires for a change this session did
   * not make, so a field some later build adds to the file is not silently dropped
   * by a version that does not know about it.
   */
  useEffect(() => {
    if (onDisk.current === null) return;
    if (onDisk.current === chats.list) return;
    onDisk.current = chats.list;
    saveConversations(chats.list);
  }, [chats.list]);

  /**
   * Look for a new version, on the way in and whenever the window comes back.
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
      if (!live) return;
      setVersion(found);
      const notes = whatsNewFor(readSeenVersion(), found);
      if (notes !== null) setFresh({ version: found, notes });
    });
    lookForUpdate((next) => {
      if (live) setOffer(next);
    });

    // And again when the window comes back, which is the case a launch-time check
    // cannot cover. This app is built to be left open for weeks and this file
    // always said so — `updates.INTERVAL_MS` argues that "a laptop that has been
    // asleep for a week should learn about an update when it wakes and the user
    // looks at it" — but until now nothing woke it up to look. Unforced, so the
    // throttle still rations the request; this is the moment the answer may have
    // changed, not a reason to ask more often.
    const onWake = () => {
      if (document.visibilityState === "visible") lookForUpdate(setOffer);
    };
    document.addEventListener("visibilitychange", onWake);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onWake);
    };
  }, []);

  /**
   * The card's own button, which gets past the throttle.
   *
   * Not guarded by `live`: React 19 dropped the warning about setting state on an
   * unmounted component, and this is only reachable from a card inside this
   * component, so an unmount and a click cannot overlap.
   */
  const checkForUpdate = useCallback(() => {
    lookForUpdate(setOffer, { force: true });
  }, []);

  /**
   * Fetch and stage the version the bar is offering.
   *
   * Guarded on the offer rather than on a ref because the click and the state are
   * never far apart: the first press moves the offer to `downloading`, which draws
   * the button disabled, and the guard is what holds if a second click lands in the
   * same frame as the first.
   */
  const installUpdate = useCallback(() => {
    if (offer.kind !== "available") return;
    takeUpdate(offer.version, setOffer);
  }, [offer]);

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

  /**
   * Add a line to one chat.
   *
   * The id and the clock are minted out here rather than inside the updater, so
   * that the updater stays a pure function of the state it is handed: React may
   * call it twice, and `nextId.current++` run twice would burn an id — and worse,
   * could put two different lines under one render.
   *
   * The chat is named rather than taken from the active one, so that a reply lands
   * in the chat its question was asked in even if the rail has moved on. A chat
   * that has been deleted in the meantime simply does not match, and the line goes
   * nowhere — which is right: there is no conversation left for it to belong to.
   */
  const append = useCallback((id: string, line: Omit<ChatMessage, "id" | "at">): number => {
    const message: ChatMessage = { ...line, id: nextId.current++, at: new Date() };
    const now = Date.now();
    setChats((current) => ({
      ...current,
      list: current.list.map((chat) =>
        chat.id === id ? { ...chat, updatedAt: now, messages: [...chat.messages, message] } : chat,
      ),
    }));
    return message.id;
  }, []);

  /** Add words to an answer that is still arriving, or set the line under it. */
  const extend = useCallback((id: string, messageId: number, patch: { more?: string; servedBy?: string }) => {
    const now = Date.now();
    setChats((current) => ({
      ...current,
      list: current.list.map((chat) =>
        chat.id === id
          ? {
              ...chat,
              updatedAt: now,
              messages: chat.messages.map((m) =>
                m.id === messageId
                  ? { ...m, text: patch.more ? m.text + patch.more : m.text, servedBy: patch.servedBy ?? m.servedBy }
                  : m,
              ),
            }
          : chat,
      ),
    }));
  }, []);

  const send = useCallback(
    (question: string): boolean => {
      // One at a time. A second question while the first is still being answered
      // would interleave two streams into one transcript.
      if (answering.current) return false;
      if (!chatReady(latestView.current)) return false;
      answering.current = true;
      const mine = generation.current;
      const id = active.id;
      // Real turns, not a flattened string: the peer's API takes a conversation.
      const turns = messagesFor(active.messages, question);
      askingSince.current = Date.now();
      append(id, { role: "user", text: question });
      setThinking(true);

      // The answer's own message, made when its first word arrives so the wait
      // before it is shown as the wait and not as an empty bubble.
      let answerId: number | null = null;
      const done = () => {
        askingSince.current = 0;
        answering.current = false;
        stopStream.current = null;
        setThinking(false);
        setStreaming(false);
      };
      stopStream.current = peer.chat(`q${Date.now()}`, turns, {
        onDelta: (text) => {
          if (generation.current !== mine) return;
          if (answerId === null) {
            answerId = append(id, { role: "assistant", text });
            setThinking(false);
            setStreaming(true);
          } else {
            extend(id, answerId, { more: text });
          }
        },
        onDone: () => {
          if (generation.current !== mine) return;
          if (answerId === null) {
            // The stream ended without a word: the network answered with nothing.
            append(id, { role: "assistant", text: NO_ANSWER, failed: true });
          } else {
            const status = latestView.current?.status;
            const covered = stagesCovered(status);
            const online = otherPeers(status).length + 1;
            if (covered !== null) {
              extend(id, answerId, {
                servedBy: `answered across ${covered.total} parts of the model · ${online} ${online === 1 ? "machine" : "machines"} online`,
              });
            }
          }
          done();
        },
        onError: (_status, message) => {
          if (generation.current !== mine) return;
          // The server's own sentence is already for a person ("not enough peers
          // yet"); it is shown as the line under the question, and anything that
          // had arrived before it stays above.
          append(id, { role: "assistant", text: message || NO_ANSWER, failed: true });
          done();
        },
      });
      return true;
    },
    [active, append, extend],
  );

  /**
   * Let go of whatever question is out on the network, and write down that it was
   * let go of.
   *
   * Four things have to happen together and none of them is enough alone. A line
   * has to be left under the question, because the chat now outlives the window: a
   * transcript that ends on a bare question reads as a bug today, and will still
   * read as one three weeks from now when it is loaded back off disk. The process
   * has to be killed, or a donated machine goes on being spent on a question nobody
   * is waiting for — and on a network of a few laptops the node it holds is one the
   * next question could be routed to. And `generation` has to move, or the
   * rejection that kill produces is written into a conversation that has already
   * stopped caring about it.
   *
   * Every exit shares this. Starting another chat, opening a different one and
   * deleting the one you are in all abandon a question as surely as pressing stop
   * does — leaving a chat was the only way out before `Stop waiting` existed, and it
   * would be strange for the newer and lighter exits not to give the node back.
   *
   * `waitedMs` is passed by `Stop waiting`, which took the number from `Thinking`
   * — the component that mounted, started a clock and is the only thing that knows
   * when the last answer was drawn. The other callers do not have it and the
   * elapsed time is measured from the send instead, which for them is the same
   * number to within a frame.
   */
  const release = useCallback(
    (id: string, waitedMs?: number) => {
      if (askingSince.current !== 0) {
        const since = askingSince.current;
        askingSince.current = 0;
        // Words that already arrived stay; the note goes under them.
        append(id, {
          role: "assistant",
          text: stoppedAfter(waitedMs ?? Date.now() - since),
          stopped: true,
        });
      }
      stopStream.current?.();
      stopStream.current = null;
      generation.current += 1;
      answering.current = false;
      setThinking(false);
      setStreaming(false);
    },
    [append],
  );

  /** `Stop waiting`, whose number comes from the clock the user was watching. */
  const stopWaiting = useCallback(
    (waitedMs: number) => {
      release(active.id, waitedMs);
    },
    [active.id, release],
  );

  /**
   * Open another chat.
   *
   * Opening the one you are already in does nothing at all — not merely a render
   * skipped: leaving a chat is what `release` is for, and re-selecting the current
   * row must not give up a question the user is still waiting on.
   */
  const selectChat = useCallback(
    (id: string) => {
      if (id === chats.activeId) return;
      release(chats.activeId);
      setChats((current) => ({ ...current, activeId: id }));
    },
    [chats.activeId, release],
  );

  /** Start one. Added to the rail rather than replacing it, which is the whole
   *  difference from the single-chat version of this: the chat you were in is
   *  still there when you come back. */
  const newChat = useCallback(() => {
    release(chats.activeId);
    const chat = newConversation();
    setChats((current) => ({ list: [chat, ...current.list], activeId: chat.id }));
  }, [chats.activeId, release]);

  const deleteChat = useCallback(
    (id: string) => {
      const mine = id === chats.activeId;
      // A question still out belongs to the chat going away, and there will be
      // nowhere left to put its answer — so the node is given back now rather than
      // spent on a reply with no chat to land in.
      if (mine) release(id);
      setChats((current) => {
        const list = current.list.filter((chat) => chat.id !== id);
        // The rail is never empty: an empty one would be a screen with no way back
        // to a conversation, including the one that was just deleted.
        if (list.length === 0) {
          const chat = newConversation();
          return { list: [chat], activeId: chat.id };
        }
        // Deleting a chat you are not in leaves you where you were.
        if (!mine) return { ...current, list };
        // Otherwise, the row that was under the one removed — or the new last row,
        // when it was the bottom of the rail.
        const at = current.list.findIndex((chat) => chat.id === id);
        return { list, activeId: list[Math.min(at, list.length - 1)].id };
      });
    },
    [chats.activeId, release],
  );

  /** Close the what's-new card, and remember that it has been read.
   *
   *  Recorded here rather than when the card was shown, so that quitting with it
   *  still open shows it again next launch instead of losing it for good. */
  const dismissWhatsNew = useCallback(() => {
    if (fresh !== null) rememberSeenVersion(fresh.version);
    setFresh(null);
  }, [fresh]);

  /** The version an update is about, or `null` when the offer names none. Only
   *  three of the kinds carry one, and `restarting` is not among them. */
  const offeredVersion =
    offer.kind === "available" || offer.kind === "downloading" || offer.kind === "staged"
      ? offer.version
      : null;

  /**
   * Whether the update card is on screen.
   *
   * Two conditions, and both are doing work.
   *
   * `fresh === null` is the collision guard. The first launch after an update is the
   * one moment at which both of this app's self-opening cards want the screen: the
   * notes for the version that just arrived, and — because a check runs on the same
   * mount — the offer of whatever has been released since. Two modals is not a thing
   * that can happen, so one of them has to yield, and it is not the notes. They are
   * about the version the user is now running, which no later moment will be about
   * again; the offer will still be true in a minute.
   *
   * `restarting` opens the card even though it names no version, because reaching
   * that state with the card closed is ordinary rather than exceptional: the rail's
   * bar carries `Restart` and so does `Settings`, and either of them can be pressed
   * while this card is shut. The button then looks unpressed for the second between
   * the click and the process going, and the answer to an unpressed button is another
   * click — which is the whole of why `UpdateOffer` has a `restarting` at all.
   */
  const updateOpen =
    fresh === null &&
    (offer.kind === "restarting" || (offeredVersion !== null && offeredVersion !== wavedAway));

  /** Wave the offer away. Only a version can be dismissed, and only for this launch.
   *
   *  Reachable by `Later`, by Escape, and by the dialog's own close — all three are
   *  the same answer, so all three land here. The rail's bar is deliberately not
   *  dismissed with it: it is the affordance rather than the announcement, and a
   *  release the user has deferred is one they still need a way to act on. */
  const dismissUpdate = useCallback(() => {
    if (offeredVersion !== null) setWavedAway(offeredVersion);
  }, [offeredVersion]);

  return (
    <section className="chat" aria-label="Chat">
      <Sidebar
        paused={paused}
        chats={chats.list}
        activeId={chats.activeId}
        onSelect={selectChat}
        onDelete={deleteChat}
        onNewChat={newChat}
        onSettings={() => setSettings(true)}
        offer={offer}
        onInstall={installUpdate}
        onRestart={restartForUpdate}
      />
      <div className="chat__main">
        <Transcript messages={active.messages} thinking={thinking} onStop={stopWaiting} />
        <Composer onSend={send} busy={thinking || streaming} unavailable={unavailableReason(phase, view, paused)} />
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
        version={version}
        offer={offer}
        onCheck={checkForUpdate}
        onInstall={installUpdate}
        onRestart={restartForUpdate}
      />
      {/* The other card, and the only one that opens itself. Everything the
          settings card's comment says about staying mounted applies here too —
          the difference is only that this one is opened by the app rather than by
          a click, once, on the first launch after an update. */}
      <WhatsNew
        open={fresh !== null}
        version={fresh === null ? "" : fresh.version}
        notes={fresh === null ? [] : fresh.notes}
        onClose={dismissWhatsNew}
      />
      {/* The card the app opens for the other direction: not what this version
          brought, but the one waiting. Same three properties as the notes card —
          kept mounted, opened by the app rather than by a click, and yielding to the
          notes on the one launch where both would want the screen. See `updateOpen`
          above for the collision, and `UpdatePrompt` for why it exists at all. */}
      <UpdatePrompt
        open={updateOpen}
        offer={offer}
        onInstall={installUpdate}
        onRestart={restartForUpdate}
        onClose={dismissUpdate}
      />
    </section>
  );
}
