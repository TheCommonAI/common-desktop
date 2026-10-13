import type { ChatMessage } from "./messages";
import { formatTime } from "./messages";
import { renderMessage } from "./markdown";
import Thinking from "./Thinking";

/**
 * The conversation, and nothing else.
 *
 * A log of articles rather than a list of divs: each one is a thing that was
 * said, at a time, by somebody. The two roles are the same markup and are told
 * apart only by the stylesheet, because a bubble and a paragraph are the same
 * sentence laid out differently and giving them different elements would be
 * saying they are different kinds of thing.
 *
 * The text is set from the model's own markup rather than printed as it arrived
 * — see `markdown.ts`, which is where the escaping, the link filtering and the
 * TeX guards live, and which is the only thing in the app that returns HTML.
 */

export interface TranscriptProps {
  messages: readonly ChatMessage[];
  /** A question is out on the network and has not come back. Rendered as the
   *  last thing in the log, because that is where it is: the conversation so
   *  far, and then the answer being waited on. */
  thinking?: boolean;
  /** Let go of that question — the way out of a wait that runs to four minutes.
   *  Passed straight to the waiting line, which is the only thing that has
   *  anything to let go of, and which hands back how long it was held: the clock
   *  that measured the wait is in there, beside the button, and this is the last
   *  place that number can still be caught. */
  onStop: (waitedMs: number) => void;
}

export default function Transcript({ messages, thinking = false, onStop }: TranscriptProps) {
  return (
    // `role="log"` announces what is *added* and not what is there, which is
    // exactly a transcript's contract. A live region on each message would
    // re-read the whole conversation every time one line arrived.
    <div className="chat__log" role="log" aria-label="Conversation">
      {messages.map((message) => (
        <article
          key={message.id}
          className={`msg msg--${message.role}${message.failed ? " msg--failed" : ""}`}
        >
          {/* A container rather than a paragraph: what the model wrote may be a
              paragraph, or a list, or a display equation with a sentence around
              it, and only the renderer knows which. The prose face and the
              measure still come from `.msg__text`. */}
          <div
            className="msg__text"
            dangerouslySetInnerHTML={{ __html: renderMessage(message.text) }}
          />
          {/* Which machine answered, in the CLI's own words, above the clock.
              Only on the answers: it is a fact about a reply, and a question has
              no such fact yet. */}
          {message.servedBy && <p className="msg__served">{message.servedBy}</p>}
          <time className="msg__time" dateTime={message.at.toISOString()}>
            {formatTime(message.at)}
          </time>
        </article>
      ))}
      {thinking && <Thinking onStop={onStop} />}
    </div>
  );
}
