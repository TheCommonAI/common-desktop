import { GREETING, type ChatMessage } from "./messages";

/**
 * Carrying the conversation back to wherever the next question goes.
 *
 * The peer's chat API takes a real list of turns, so the history is sent as turns
 * and the model sees a conversation. (The old network took one string and this file
 * had to render the history into it; that is gone.)
 *
 * What is still true is that the model has a finite window and this side cannot
 * read it. A long history replayed in full would overflow it and the answer would
 * come back worse rather than longer, in a way that looks like the model got
 * confused. Hence a character budget, oldest turns dropped first. It is a guess, and
 * it is named so that finding the real number is one edit.
 */

/**
 * How much of the history may be replayed, in characters. Roughly three thousand
 * tokens: conservative against a 32k window, because the failure on the far side
 * of it — a less informed answer — is much cheaper than the failure on this side,
 * which is a prompt that no longer fits.
 */
export const CONTEXT_BUDGET_CHARS = 12000;

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The turns to send, given what has been said and the question being asked: the
 * most recent turns that fit, oldest dropped first, then the question.
 */
export function messagesFor(history: readonly ChatMessage[], question: string): Turn[] {
  const turns = history.filter(isTurn);
  const room = CONTEXT_BUDGET_CHARS - question.length;
  const kept = tailWithin(turns, room);
  return [
    ...kept.map((turn): Turn => ({ role: turn.role, content: turn.text.trim() })),
    { role: "user", content: question },
  ];
}

/**
 * Whether a line in the transcript is something that was said.
 *
 * Three kinds are not, and each would be actively harmful to replay. The greeting
 * is the app talking to the user, not the network talking to them — and replayed,
 * it asks the node to be a chat window. A failure is the network saying nothing,
 * and replayed as an assistant turn it teaches the node that saying nothing is an
 * answer. A `stoppedAfter` line is a note about the *client*, which the node has
 * no way to have said and should not be told it did.
 */
function isTurn(message: ChatMessage): boolean {
  if (message.role === "assistant" && message.text === GREETING) return false;
  if (message.failed === true || message.stopped === true) return false;
  return message.text.trim() !== "";
}

/**
 * The most recent turns that fit, oldest dropped first.
 *
 * Walked from the end because the newest turn is the one the question is actually
 * a follow-up to: an answer from ten questions ago is worth less than the one
 * immediately before. The first turn is always kept whatever it costs, so a single
 * enormous answer cannot produce an empty history and a prompt with a preamble and
 * nothing under it.
 */
function tailWithin(turns: readonly ChatMessage[], room: number): readonly ChatMessage[] {
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    // The text plus the "Assistant: " in front of it and the blank line after.
    const cost = turns[i].text.length + 12; // the role and the framing around the text
    if (kept.length > 0 && used + cost > room) break;
    kept.unshift(turns[i]);
    used += cost;
  }
  return kept;
}
