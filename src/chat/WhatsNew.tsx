import { useEffect, useRef } from "react";
import Control from "../onboarding/parts/Control";

/**
 * What the version now running brought, said once, on the way in.
 *
 * The update itself is deliberately invisible: it downloads while the app is in
 * use and the restart puts the same screen back a second later. That is the right
 * way for it to happen and the wrong way for it to end. A thing that changes
 * underneath somebody and says nothing is a thing they will go on believing never
 * improves — and on this app that is a real cost, because most of what is worth
 * knowing about it is new.
 *
 * Modelled on `Settings`, because the two are the same kind of object: a card over
 * the conversation, opened with `showModal`, dismissed back to it. Three things
 * differ, and each is about this one being read rather than used. It is wider — the
 * notes are sentences, and a sentence in the settings card's 26rem column wraps
 * three times. It holds no controls but the one that closes it. And it has no
 * globe, which is the settings card's one piece of machinery and has nothing to
 * say here.
 *
 * The notes are shipped with the build rather than fetched. The moment to say this
 * is the moment after an update, which is exactly the moment not to be waiting on a
 * request to GitHub to find out what to say. See `whats-new.ts`.
 */

export interface WhatsNewProps {
  /** Driven from the outside rather than mounted on demand, for the reason
   *  `Chat` gives about `Settings`: an open modal dialog taken out of the DOM is
   *  a corner of the top layer with a history of leaving the page behind it
   *  inert. Two lines, and the same two lines. */
  open: boolean;
  /** The version these notes belong to. Named on the card, because "what's new"
   *  with no version under it is a claim about nothing in particular. */
  version: string;
  notes: readonly string[];
  onClose: () => void;
}

export default function WhatsNew({ open, version, notes, onClose }: WhatsNewProps) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // Read off the element rather than tracked a second time, as `Settings` does:
    // `showModal` twice throws, and whether closing a closed dialog is a no-op
    // varies by engine.
    if (open && !element.open) {
      element.showModal();
      // `showModal` lands focus on the first focusable descendant, which here is
      // the Done button at the *bottom* — so a screen reader would open the card
      // at its last word and the notes would never be read. Focus goes to the
      // heading instead, and Tab from there reaches Done the ordinary way.
      heading.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="whatsnew"
      aria-labelledby="whatsnew-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <h2 className="whatsnew__title" id="whatsnew-title" ref={heading} tabIndex={-1}>
        What&rsquo;s new
      </h2>
      <p className="whatsnew__version">Common {version}</p>

      {/* A list, because these are separate changes and not a paragraph arguing
          for them. The marker is drawn rather than set in type — the same small
          lozenge `.chat__foot-bar` uses for the connection, which is this app's
          mark for "a fact, not a dot". */}
      <ul className="whatsnew__notes">
        {notes.map((note) => (
          <li className="whatsnew__note" key={note}>
            {note}
          </li>
        ))}
      </ul>

      {/* One control, and it is the way out rather than an acknowledgement. It
          deliberately does not say "Got it": the card has told the user something
          and there is nothing in it for them to agree with. */}
      <div className="whatsnew__controls">
        <Control onClick={onClose} arrow>
          Done
        </Control>
      </div>
    </dialog>
  );
}
