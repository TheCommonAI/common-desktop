import { useState, type FormEvent } from "react";

/**
 * The line the user types on, and the mark that sends it.
 *
 * A form, so that Enter submits without a key handler — and so that a phone
 * keyboard's Go key and a screen reader's "send" both mean the same thing.
 */

export interface ComposerProps {
  /**
   * Returns whether the message was taken. The field is cleared only on `true`,
   * so a question typed while the last one is still being answered is kept where
   * it is rather than being swallowed by a control that looked like it worked.
   */
  onSend: (text: string) => boolean;
  /**
   * A question is out on the network and has not come back.
   *
   * The field still takes what is typed — a draft is worth keeping, and the
   * send below already refuses to swallow it. What changes is that the refusal
   * stops being invisible: the mark stops looking pressable and the placeholder
   * says what is being waited on. Before this, pressing send during a wait did
   * nothing and said nothing, which was survivable when a local model answered
   * in a second and reads as a broken app against a routed answer that can take
   * four minutes.
   */
  busy?: boolean;
  /**
   * Why a question cannot be sent right now, when that is not because one is
   * already out: the network is off, this machine is still getting its share,
   * chat is still loading. The field still takes a draft; the mark stops looking
   * pressable and the placeholder says what is being waited on.
   */
  unavailable?: string;
}

/**
 * The send mark.
 *
 * A hexagon, and one drawn by hand rather than by a geometry function: three of
 * its six edges bow outward and three are straight, which is what the mock
 * supplied and what makes it a mark rather than an icon. It is the same
 * instinct as the download's dots — a shape that a person could have made — and
 * it is the only place in the app where the two halves of that idea meet.
 */
function SendMark() {
  return (
    <svg className="composer__mark" viewBox="0 0 14.44 12.5" aria-hidden="true">
      <path
        d="M4.62 2C5.78 0 8.66 0 9.82 2L13.28 8C14.44 10 12.99 12.5 10.68 12.5H3.76C1.45 12.5 0 10 1.16 8Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function Composer({ onSend, busy = false, unavailable }: ComposerProps) {
  const blocked = busy || unavailable !== undefined;
  const [text, setText] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = text.trim();
    if (question === "") return;
    if (onSend(question)) setText("");
  };

  return (
    <form className="composer" onSubmit={submit}>
      <input
        className="composer__input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        // Sentence case in the document, caps in the stylesheet: what is typed
        // is a message and reads as one, and only the placeholder is set in the
        // display face — the app asking in its own voice, the same voice as the
        // wordmark above it, where the line itself is set in the body face.
        placeholder={unavailable ?? (busy ? "Waiting for the network....." : "Type here.....")}
        aria-label="Message"
        autoComplete="off"
        spellCheck={false}
      />
      {/* Genuinely `disabled`, not merely dimmed: the send is already a no-op
          while a question is out, and `disabled` is the honest way to say so.
          Enter in the field above still reaches `submit`, still calls `onSend`,
          still gets `false` and still keeps the draft — so a question typed
          during a wait is neither sent nor lost. */}
      <button className="composer__send" type="submit" aria-label="Send" disabled={blocked}>
        <SendMark />
      </button>
    </form>
  );
}
