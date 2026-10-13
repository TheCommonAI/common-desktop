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
   * Which machine answered — "served by alder-7", "composed by 3 machines".
   *
   * Set on the answers and not on the questions or the greeting, because it is
   * a fact about a reply. It is here rather than in a log because on this
   * network it is not an implementation detail: the machines are people's
   * laptops, the routing is the product, and a chat that hides which one
   * answered is exactly the opacity this network was built against.
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
 * The mock this screen follows opens on a greeting, and a chat that opens on an
 * empty field asks the user to invent the first move. But the greeting is also
 * the only chance to say the one thing that is true of *this* product and not of
 * a chat app: the question does not go to a data centre, it goes to the network,
 * and a person's machine answers it. A generic "How can I help?" would be the
 * same sentence a hundred other products open with, and it would leave the
 * interesting fact unsaid.
 *
 * It used to say the opposite — that the model ran here and nothing left the
 * machine. That was true of `common ask --local`, and it was the wrong product:
 * a machine that contributes one specialist cannot answer everything, and this
 * one answered "hey" with mathematics. The question does leave now. Saying so is
 * the price of the routing, and it is the more interesting sentence anyway.
 */
export const GREETING = "Hello. Your question goes out to the network, and a machine answers it.";

/** And what the assistant says when it could not answer. One clause, no hue:
 *  the register withdraws the ink and names the thing, and leaves the fixing to
 *  the screen that can do it. It is deliberately the same sentence the CLI fails
 *  with, so that the app and the terminal are describing one event. */
export const NO_ANSWER = "The network didn't answer.";

/**
 * What is left behind when the user lets go of a question before the network
 * answers it — and how long they held on.
 *
 * Not `failed`, and the difference is the whole of the sentence: nothing went
 * wrong, the node was simply taking a long time and the user stopped waiting for
 * it. A transcript that ends on a bare question would read, later, as a bug —
 * every other question in it has a line under it.
 *
 * The seconds are the point of the line. They are the one measurement of this
 * network's slowness that exists anywhere: the gateway already times every
 * request it routes and reports `routing_ms`, `ttft_ms` and `total_ms` back, so a
 * slow answer is not news to it. A user giving up is. That number is currently
 * written down nowhere the network can read, which is why it is written here,
 * where at least the person who waited can see it.
 *
 * Rounded the way the waiting clock rounds, so the number on this line and the
 * number the user was staring at agree.
 */
export function stoppedAfter(waitedMs: number): string {
  return `Stopped waiting after ${Math.round(waitedMs / 1000)}s.`;
}
