import type { ReactNode } from "react";

/**
 * A control, as a line of text.
 *
 * No box, no fill, no border. What a real button needs — a hit area, a focus
 * ring, a disabled state — is in the stylesheet; what it does not need is any
 * of the furniture that would make the line of controls look like a toolbar.
 */

export interface ControlProps {
  children: ReactNode;
  onClick?: () => void;
  /** Everything beside the control that advances: Back, Cancel, Try again. */
  quiet?: boolean;
  /** The trailing arrow. Only the control that moves the flow on carries one,
   *  so the arrow means "this is the way forward" and not "this is a button". */
  arrow?: boolean;
  disabled?: boolean;
}

export default function Control({ children, onClick, quiet, arrow, disabled }: ControlProps) {
  return (
    <button
      type="button"
      className={`control${quiet ? " control--quiet" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      {arrow && (
        // The arrow is the only decorative thing in the flow, and it is the
        // accessible name's one chance to be wrong.
        //
        // Drawn rather than typed. Google's standard `latin` subset carries
        // U+2191 and U+2193 but not U+2192, so a literal "→" in either vendored
        // face falls back to whatever the system has and puts one glyph of a
        // different design next to "Continue" on every screen of the flow. Same
        // 14-unit square as the pencil and the hexagon, same habit: the app
        // draws its own marks. `currentColor` so it follows the ink through
        // hover, focus and disabled without a rule of its own.
        <span className="control__arrow" aria-hidden="true">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.8 7h8.4" />
            <path d="M8.1 3.9 11.2 7l-3.1 3.1" />
          </svg>
        </span>
      )}
    </button>
  );
}
