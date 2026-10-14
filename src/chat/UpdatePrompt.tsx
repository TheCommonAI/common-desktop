import { useEffect, useRef } from "react";
import Control from "../onboarding/parts/Control";
import { askFor, type UpdateOffer } from "./updates";

/**
 * A new version, said out loud instead of waiting quietly in the rail.
 *
 * Updating was already automatic — `Chat` looks on the way in and again whenever
 * the window comes back — and it was still possible to use this app for a long time
 * without learning that a release existed. The check found it; all that happened was
 * a bar in the rail, and a rail is a place a user has no reason to look, because
 * nothing has ever been there before. An announcement that only reaches someone
 * already looking for it is not an announcement. That is what the person who had to
 * open Settings and press the button was telling us.
 *
 * So this is `WhatsNew`'s other half. That card says what the version you now have
 * brought; this one says there is a version you do not have yet and offers the one
 * action that changes that. They are the same object seen from either side of the
 * restart, and they are built the same way: kept mounted and driven by `open` rather
 * than mounted on demand, dismissed with `showModal`'s own `onClose`/`onCancel` back
 * to the conversation, and focused on the heading rather than on the first focusable
 * descendant — which here is a control at the bottom of the card, so a reader left to
 * `showModal` would begin this card at its last word.
 *
 * The version is named in the heading, because "an update is available" with nothing
 * under it is a claim about nothing in particular, and this card has no notes to
 * qualify it — that is the whole of why it is narrower than the other one.
 *
 * The word on the control comes from `updates.askFor`, which is the one place the
 * state of an update becomes a verb. The rail bar draws from the same function, so
 * the card and the bar cannot come to describe one state with two different words —
 * the failure `Settings` already had to write an argument against.
 */

/**
 * What the card says, in the card's register.
 *
 * Not `askFor`'s `says`, which is the rail's: a fragment beside a control in a
 * 13rem column. This is a sentence with room around it, and the version is the
 * subject of it. Kept apart rather than derived, so that shortening the bar to fit
 * the rail cannot quietly shorten the thing the card is saying.
 *
 * `null` for the four kinds with nothing to announce, which are exactly the four
 * `askFor` refuses — the two functions switch over the same states and are read
 * together.
 */
function headlineFor(offer: UpdateOffer): string | null {
  switch (offer.kind) {
    case "available":
      return `Common ${offer.version} is available.`;
    case "downloading":
      return `Getting Common ${offer.version}…`;
    case "staged":
      return `Common ${offer.version} is ready.`;
    case "restarting":
      // No version: by the time this is on screen the process is on its way out,
      // and a sentence naming a version the user can no longer see or act on is a
      // sentence about the past.
      return "Restarting…";
    case "unknown":
    case "checking":
    case "current":
    case "failed":
      return null;
  }
}

export interface UpdatePromptProps {
  /** Driven from the outside rather than mounted on demand, for the reason `Chat`
   *  gives about `Settings`: an open modal dialog taken out of the DOM is a corner
   *  of the top layer with a history of leaving the page behind it inert. */
  open: boolean;
  offer: UpdateOffer;
  onInstall: () => void;
  onRestart: () => void;
  /** The card was waved away — closed, cancelled, or `Later` pressed. The caller
   *  decides how long that lasts; nothing is remembered here. */
  onClose: () => void;
}

export default function UpdatePrompt({
  open,
  offer,
  onInstall,
  onRestart,
  onClose,
}: UpdatePromptProps) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // Read off the element rather than tracked a second time, as `WhatsNew` does:
    // `showModal` twice throws, and whether closing a closed dialog is a no-op
    // varies by engine.
    if (open && !element.open) {
      element.showModal();
      heading.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const ask = askFor(offer);
  const headline = headlineFor(offer);

  return (
    // Always rendered, even in the states with nothing to say. The element that must
    // not be taken out of the DOM is an *open* one, and this one is closed whenever
    // `headline` is null — but keeping the element unconditionally is one fewer
    // thing that has to stay in step with `open`, and a closed `<dialog>` is
    // `display: none` and costs nothing.
    <dialog
      ref={dialog}
      className="updateprompt"
      aria-labelledby="updateprompt-title"
      onClose={onClose}
      onCancel={onClose}
    >
      {headline !== null && ask !== null && (
        <>
          <h2 className="updateprompt__title" id="updateprompt-title" ref={heading} tabIndex={-1}>
            {headline}
          </h2>
          <div className="updateprompt__controls">
            {/* The arrow marks the control that moves things on, as it does
                everywhere else — including while that control is disabled and the
                work it stands for is already happening. The arrow is about where
                the card is pointing, not about whether it can be pressed. */}
            <Control
              onClick={ask.action === "install" ? onInstall : onRestart}
              disabled={ask.disabled}
              arrow
            >
              {ask.actionLabel}
            </Control>
            {/* "Later" everywhere the user has an answer to give, and never while the
                process is leaving — the restart is already in flight by the time
                `restarting` is on screen, so a control offering to defer it would be
                a control that does nothing, which is the same lie as the button that
                looks unpressed. Everywhere else it is the ordinary second answer:
                the release is still there, the rail's bar is still carrying it, and
                the card has said what it came to say. */}
            {offer.kind !== "restarting" && (
              <Control onClick={onClose} quiet>
                Later
              </Control>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
