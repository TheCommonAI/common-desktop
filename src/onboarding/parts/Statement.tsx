import { useEffect, useRef, type ReactNode } from "react";

/**
 * One screen of the flow, in the three slots it is allowed.
 *
 * This is the register enforced structurally rather than by convention: there
 * is a statement, a caption, and a line of controls, and nowhere to put a table
 * or a gauge or a grid. A later edit that wants to add a fourth thing has to
 * change this file, which is the point.
 */

export interface StatementProps {
  /** The sentence. The only large type on screen. */
  statement: ReactNode;
  /**
   * The clause beneath it: a fragment, never a sentence — a full stop in caps
   * at that size is oppressive. Pass a string, or an array of parts, which are
   * joined with a middot by the stylesheet rather than by a separator string,
   * so nothing extra lands in the accessible name. Parts that are `null` are
   * dropped, which is how a read that failed costs the user a clause instead of
   * the screen.
   */
  caption?: ReactNode | readonly ReactNode[];
  /**
   * The one thing a screen may put between the clause and the controls: the mark
   * for "this is working and you are waiting". The download draws it as a hairline
   * gauge, because that step's subject is a duration and a duration can be
   * measured; the join draws the app's three dots, because that step's subject is
   * a promise and all there is to say about it is that it is still being kept. Two
   * users of one slot, and it stays a named slot rather than free space: a screen
   * can put a mark there or nothing, not a table.
   */
  gauge?: ReactNode;
  /** One line of text. The control that advances is in full ink; everything
   *  beside it is quiet. */
  controls?: ReactNode;
  /** The one green in the app, used at exactly one moment: the sentence that
   *  ends the flow. */
  live?: boolean;
  /**
   * Move focus to the statement whenever this changes — and on mount, so
   * changing a step gets it for free.
   *
   * The rule the screens follow: focus moves whenever a state change *replaces
   * the controls*, because the control the user was on has just unmounted and
   * focus would otherwise fall to the body. Where a state change leaves the
   * controls alone and only rewrites the sentence — the lane picker — nothing
   * moves and `announce` is used instead.
   */
  focusKey?: string | number;
  /**
   * Announce the statement as it changes. For the case `focusKey` cannot cover:
   * the user changed the sentence themselves without leaving the control that
   * changed it, so there is no focus move to hear and no live region to inherit.
   */
  announce?: boolean;
}

function isList(value: ReactNode | readonly ReactNode[]): value is readonly ReactNode[] {
  return Array.isArray(value);
}

const present = (part: ReactNode) => part !== null && part !== undefined && part !== false;

export default function Statement({
  statement,
  caption,
  gauge,
  controls,
  live,
  focusKey,
  announce,
}: StatementProps) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // `tabIndex={-1}` and no outline: this is a place for focus to land, not a
    // control, and the sentence is its own visible confirmation.
    heading.current?.focus();
  }, [focusKey]);

  return (
    <>
      <h1
        className={`statement${live ? " statement--live" : ""}`}
        tabIndex={-1}
        ref={heading}
        aria-live={announce ? "polite" : undefined}
      >
        {statement}
      </h1>

      {caption !== undefined && (
        <p className="caption">
          {isList(caption)
            ? caption.filter(present).map((part, index) => (
                // Position is the only identity these have, and the list is
                // rebuilt whole on every change.
                <span className="caption__part" key={index}>
                  {part}
                </span>
              ))
            : caption}
        </p>
      )}

      {gauge !== undefined && <div className="sheet__gauge">{gauge}</div>}

      {controls !== undefined && <div className="sheet__controls">{controls}</div>}
    </>
  );
}
