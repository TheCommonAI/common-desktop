/**
 * One line in the transcript.
 *
 * Deliberately not the onboarding's `Progress` shape. That one is a state
 * machine — a download that pauses, a join that advances through phases — and
 * every field on it exists to be driven. This is a record of something that has
 * already happened, and the only thing that ever changes about it is nothing.
 */

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  at: Date;
  /**
   * The network did not answer. Marked on the message rather than replacing it,
   * so the question the user asked stays on screen above the line saying nothing
   * came back — an answer that failed is not the same as a question that was
   * never asked.
   */
  failed?: boolean;
  /**
   * The user stopped waiting, so this line is the app's and not the network's —
   * see `stoppedAfter`.
   *
   * A flag rather than a match on the sentence above, because the sentence is
   * read by people and this is read by `context.ts`, and the day the wording
   * changes the second reader must not quietly start replaying "Stopped waiting
   * after 40s." to a node as though it had said it.
   */
  stopped?: boolean;
  /**
   * Who answered — "answered across 4 parts of the model · 6 machines online".
   *
   * Set on the answers and not on the questions or the greeting, because it is
   * a fact about a reply. It is here rather than in a log because on this
   * network it is not an implementation detail: the machines are people's
   * laptops, and a chat that hides that is the opacity this network was built
   * against. It is read from the peer's own view of the network at the moment
   * the answer finished, and left off when that view is not known.
   */
  servedBy?: string;
}

/** "10:42 AM", which is the whole of what a timestamp is for. The locale does
 *  the formatting; the app does not own the shape of a clock. */
export function formatTime(at: Date): string {
  return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * What the assistant opens with.
 *
 * A chat that opens on an empty field asks the user to invent the first move. But
 * the greeting is also the only chance to say the one thing that is true of *this*
 * product and not of a chat app: no single machine holds the model. Each holds a
 * slice, the activations pass from one to the next, and the answer is the whole
 * network's.
 */
export const GREETING = "Hello. Your question is answered by the network, a piece at a time, by machines like yours.";

/** And what the assistant says when it could not answer. One clause, no hue:
 *  the register withdraws the ink and names the thing, and leaves the fixing to
 *  the screen that can do it. */
export const NO_ANSWER = "The network didn't answer.";

/**
 * What is left behind when the user lets go of a question before the network
 * answers it — and how long they held on.
 *
 * Not `failed`: nothing went wrong, the answer was slow and the user stopped
 * waiting for it. A transcript that ends on a bare question would read, later, as
 * a bug — every other question in it has a line under it. The seconds are the
 * point of the line, rounded the way the waiting clock rounds, so the number here
 * and the number the user was watching agree.
 */
export function stoppedAfter(waitedMs: number): string {
  return `Stopped waiting after ${Math.round(waitedMs / 1000)}s.`;
}
