/**
 * The sidebar: the mark, the one way to start over, and the foot.
 *
 * Three things, and the space between them is the point. The mock this follows
 * puts everything else in the conversation itself, which is right — a chat is a
 * conversation, and a rail of folders and history beside it would be an
 * inventory of something the user is not doing.
 *
 * The foot is the one row that is two things rather than one: a status reading
 * and the way into Settings, side by side. It used to be a single button across
 * the whole row, which meant the control the user pressed was named "Connected"
 * — a status line that did something. Two controls, each doing its own job, is
 * what that row always should have been.
 */

/** The gear that opens Settings.
 *
 *  Drawn, not set in type. There is no icon font in this app: the CSP is
 *  `style-src 'self'` and `font-src 'self' data:`, so no stylesheet or font from
 *  another origin can load, and every mark in the app is a path in the markup
 *  instead — the pencil below, the arrow in `Control`, the hexagon in `Composer`.
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
  onNewChat: () => void;
  onSettings: () => void;
}

export default function Sidebar({ seen, onNewChat, onSettings }: SidebarProps) {
  const state = seen === null ? "checking" : seen ? "seen" : "unseen";

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

      {/* The foot. The status is a live region rather than a caption, because it
          arrives a moment after the screen does and a screen reader has no other
          way to learn it — so `role="status"` stays on the label, where it was.
          The gear carries its own name from `aria-label` and its own words are
          the drawing, which is why the mark is `aria-hidden`: a reader hears
          "Settings, button" and not a description of some teeth. */}
      <div className={`chat__foot chat__foot--${state}`}>
        <span className="chat__foot-bar" aria-hidden="true" />
        <span className="chat__label" role="status">
          {state === "checking" ? "Checking" : state === "seen" ? "Connected" : "Not seen"}
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
