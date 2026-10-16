import { titleFor, type Conversation } from "./conversations";
import type { Rejoin } from "./rejoin";
import { askFor, type UpdateOffer } from "./updates";

/**
 * The sidebar: the mark, the chats, the update, and the foot.
 *
 * This was written against a rail of folders, and the argument then was that a
 * chat is a conversation, so a tree of folders beside it would be an inventory of
 * something the user is not doing. That still holds. What changed underneath it is
 * that the conversations now outlive the window — see `conversations.ts` — so the
 * rail has something to list that is not an inventory. It is the app's memory: one
 * row per chat, newest first, with the one you are in marked. Below it comes the
 * one entry that is not a chat at all, an update, as a bar carrying the single
 * control that acts on it.
 *
 * The foot is the one row that is two things rather than one: a status reading and
 * the way into Settings, side by side. It used to be a single button across the
 * whole row, which meant the control the user pressed was named "Connected" — a
 * status line that did something. Two controls, each doing its own job, is what
 * that row always should have been.
 */

/** The gear that opens Settings.
 *
 *  Drawn, not set in type. There is no icon font in this app: the CSP is
 *  `style-src 'self'`, so no stylesheet or font from another origin can load, and
 *  every mark in the app is a path in the markup instead — the pencil below, the
 *  arrow in `Control`, the hexagon in `Composer`.
 *
 *  This one is drawn twice: a 1.8-weight outline, and a 1.0-weight copy at half
 *  opacity sitting just under it. The offset ghost is what makes it read as
 *  drawn by hand rather than generated — the same intent as the globe's jittered
 *  dots, and the reason the two circles are not concentric.
 *
 *  A 24-unit square, against the 14 the pencil uses, because a gear has more
 *  teeth than a pencil has edges and at 14 they close up into a blob. */
const GEAR_MARK = (
  <svg
    className="chat__gear-mark"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <g strokeWidth="1.8">
      <path d="M10.5 5.3 L10.8 2.7 L13.2 2.7 L13.5 5.1 L15.8 6.1 L17.6 4.7 L19.3 6.4 L18 8.2 L18.8 10.5 L21.2 10.8 L21.6 13.2 L18.8 13.5 L18 15.8 L19.4 17.7 L17.8 19.5 L15.7 17.8 L13.5 18.9 L13.2 21.5 L10.8 21.3 L10.5 18.9 L8.2 17.9 L6.4 19.3 L4.5 17.8 L6.1 15.8 L5.2 13.5 L2.9 13.2 L2.5 10.8 L5.2 10.5 L6 8.2 L4.4 6.2 L6.2 4.5 L8.1 6 Z" />
      <path d="M12.3 15 C11.6 15 10.9 14.7 10.3 14.4 C9.8 14 9.3 13.4 9.1 12.8 C8.9 12.2 8.9 11.3 9.2 10.7 C9.5 10.1 10.2 9.5 10.8 9.3 C11.4 9 12.2 9 12.8 9.2 C13.4 9.4 14 9.8 14.4 10.3 C14.8 10.8 15.1 11.6 15.1 12.3 C15.1 12.9 14.7 13.7 14.2 14.2 C13.7 14.6 12.9 14.9 12.3 15 Z" />
    </g>
    <g strokeWidth="1" opacity=".5">
      <path d="M10.5 5.2 L10.8 2.8 L13.2 2.9 L13.5 5 L15.6 6.3 L17.7 4.5 L19.7 6.1 L17.7 8.3 L18.9 10.5 L21.4 10.8 L21 13.2 L18.8 13.5 L18 15.8 L19.4 17.7 L17.8 19.6 L15.7 17.8 L13.5 18.7 L13.2 21.1 L10.8 21.3 L10.5 19 L8.2 17.9 L6.2 19.6 L4.6 17.7 L6 15.8 L5.4 13.5 L2.8 13.2 L2.6 10.8 L5.1 10.5 L6.1 8.2 L4.8 6.4 L6.4 4.7 L8.3 6.2 Z" />
      <path d="M12.5 15 C11.8 15.1 10.9 14.9 10.3 14.6 C9.7 14.3 9.2 13.7 9.1 13.1 C8.9 12.4 8.9 11.4 9.1 10.8 C9.4 10.2 9.9 9.5 10.5 9.2 C11.1 8.9 12 8.8 12.6 9 C13.3 9.1 14.2 9.6 14.6 10.1 C15 10.6 15.1 11.4 15.1 12.1 C15.1 12.7 14.8 13.6 14.3 14.1 C13.9 14.6 13.2 14.9 12.5 15 Z" />
    </g>
  </svg>
);

export interface SidebarProps {
  /** `null` while the check is still in flight. The line never claims a state it
   *  has not read, which is why this is three-valued rather than defaulting to
   *  "connected" and correcting itself a moment later. */
  seen: boolean | null;
  /** What this app has done about a reading it did not like. Owned by the chat, so
   *  the foot and the Settings row cannot disagree. */
  rejoin: Rejoin;
  /** Every chat this machine has, newest first. Never empty — `Chat` seeds one
   *  rather than let the rail draw a list with nothing in it. */
  chats: readonly Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
  onSettings: () => void;
  /** What is known about a newer version. Owned by the chat, so the rail and the
   *  Settings card cannot disagree about whether an update is waiting. */
  offer: UpdateOffer;
  onInstall: () => void;
  onRestart: () => void;
}

/**
 * What the update bar says and does, or `null` when there is nothing to act on.
 *
 * The words and the verb come from `askFor` in `updates.ts`, which is where the
 * argument for them lives — this app now offers an update from two surfaces, and one
 * of them writing its own "Install" is how the two stop agreeing about what they are
 * describing. What is left here is the mapping from the ask to *this* surface's two
 * callbacks, which is the only part the rail owns.
 */
function updateBar(
  offer: UpdateOffer,
  onInstall: () => void,
  onRestart: () => void,
): { label: string; action: string; act: () => void; disabled: boolean } | null {
  const ask = askFor(offer);
  if (ask === null) return null;
  return {
    label: ask.says,
    action: ask.actionLabel,
    act: ask.action === "install" ? onInstall : onRestart,
    disabled: ask.disabled,
  };
}

/** What the foot says, and which bar it draws.
 *
 *  The reconnect states are read first because they are newer news than the
 *  reading underneath them. While a reconnect is in flight the reading is
 *  deliberately blank — `Chat` clears it so the rail cannot go on saying
 *  Connected over routing nobody has established — and a failure is a more recent
 *  fact than the unseen state it caused. Silence and the resting state both fall
 *  through to the ordinary reading, which is genuinely the same claim: the gateway
 *  cannot reach this machine right now.
 *
 *  The label is short on purpose. This is a foot with room for one or two words,
 *  and the reason behind a `waiting` or a `failed` is a sentence on the Settings
 *  row that owns the control — the rail stays a display. */
function foot(seen: boolean | null, rejoin: Rejoin): { state: string; label: string } {
  if (rejoin.kind === "working") return { state: "checking", label: "Reconnecting" };
  if (rejoin.kind === "failed") return { state: "unseen", label: "Couldn't reconnect" };
  if (seen === null) return { state: "checking", label: "Checking" };
  return seen ? { state: "seen", label: "Connected" } : { state: "unseen", label: "Not seen" };
}

export default function Sidebar({
  seen,
  rejoin,
  chats,
  activeId,
  onSelect,
  onDelete,
  onNewChat,
  onSettings,
  offer,
  onInstall,
  onRestart,
}: SidebarProps) {
  const { state, label } = foot(seen, rejoin);
  const bar = updateBar(offer, onInstall, onRestart);

  return (
    // The attribute makes the sidebar's own padding draggable and nothing else
    // — Tauri tests the event's target, so the wordmark, the buttons and the
    // labels inside them are left alone. This is the whole reason a window with
    // a transparent titlebar can be moved at all, and the reason it is set on
    // the emptiest element on screen.
    //
    // On Windows the titlebar is not transparent — `titleBarStyle` and
    // `hiddenTitle` are macOS-only, and the platform's own frame is left in
    // place there, since it is what a Windows user reaches for to move or close
    // a window and it cannot be put back once removed. The attribute is inert
    // over there and costs nothing.
    <aside className="chat__side" data-tauri-drag-region>
      <p className="chat__mark">Common.</p>

      <button className="chat__new" type="button" onClick={onNewChat}>
        {/* A pencil, not a plus. A plus is a thing you put *into* something —
            a field, a list, a folder — and there is nothing here to put a chat
            into. The mock draws a pencil, which is the honest mark: what this
            does is start writing.
            Drawn in a 14-unit square and rotated into place, so the body and
            its point are two straight shapes meeting at a clean shoulder
            rather than one path bent around a diagonal. The body is an outline
            open at the bottom; the point is solid and closes it. */}
        <svg className="chat__new-mark" viewBox="0 0 14 14" aria-hidden="true">
          <g
            transform="rotate(45 7 7)"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5.2 1.9h3.6v7.7" />
            <path d="M5.2 1.9v7.7" />
          </g>
          <path transform="rotate(45 7 7)" d="M5.2 9.6h3.6L7 12.1z" fill="currentColor" />
        </svg>
        <span className="chat__label">New chat</span>
      </button>

      {/* The chats, newest first and scrolling rather than growing: the rail is a
          fixed height and a list long enough to push the foot off the bottom would
          take the connection and the way into Settings with it. Same scroll
          arrangement as the transcript, for the same reason.

          A row is two buttons, which is the right number — one to open the chat and
          one to be rid of it — and the second is only revealed on hover or when
          something inside the row has focus, so a rail at rest is a list of
          sentences rather than a list of sentences with a row of crosses beside it.
          It stays in the tab order while hidden, which means a keyboard user can
          reach it; that is deliberate, and the alternative is a control only a mouse
          can find. */}
      <nav className="chat__chats" aria-label="Conversations">
        {chats.map((chat) => {
          const title = titleFor(chat);
          const here = chat.id === activeId;
          return (
            <div className="chat__chat" key={chat.id}>
              <button
                type="button"
                className="chat__chat-name"
                onClick={() => onSelect(chat.id)}
                aria-current={here ? "true" : undefined}
              >
                {title}
              </button>
              <button
                type="button"
                className="chat__chat-forget"
                onClick={() => onDelete(chat.id)}
                aria-label={`Delete ${title}`}
              >
                {/* Typed rather than drawn, unlike every other mark here. U+00D7
                    is in the Latin-1 Supplement, which every subset of the four
                    vendored faces carries, and none of them declares a
                    `unicode-range` — so unlike U+2192, which is why `Control`
                    draws its arrow, this one is genuinely there to be typed. */}
                ×
              </button>
            </div>
          );
        })}
      </nav>

      {/* The bar, in the rail rather than over the conversation, and immediately
          above the foot — which is the whole of "above Connected", since the rail
          is a flex column and the foot pushes itself down with `margin: auto`.
          Nothing here is positioned. */}
      {bar !== null && (
        <div className="chat__update">
          {/* `role="status"`, not the foot's live region: those announce the
              connection, and an update arriving is a different fact that must not
              be read out as part of it. */}
          <span className="chat__update-say" role="status">
            {bar.label}
          </span>
          <button
            type="button"
            className="chat__update-do"
            onClick={bar.act}
            disabled={bar.disabled}
          >
            {bar.action}
          </button>
        </div>
      )}

      {/* The foot. The status is a live region rather than a caption, because it
          arrives a moment after the screen does and a screen reader has no other
          way to learn it — so `role="status"` stays on the label, where it was.
          The gear carries its own name from `aria-label` and its own words are
          the drawing, which is why the mark is `aria-hidden`: a reader hears
          "Settings, button" and not a description of some teeth. */}
      <div className={`chat__foot chat__foot--${state}`}>
        <span className="chat__foot-bar" aria-hidden="true" />
        <span className="chat__label" role="status">
          {label}
        </span>
        <button
          type="button"
          className="chat__gear"
          onClick={onSettings}
          aria-haspopup="dialog"
          aria-label="Settings"
        >
          {GEAR_MARK}
        </button>
      </div>
    </aside>
  );
}
