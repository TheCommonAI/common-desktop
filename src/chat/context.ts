import { GREETING, type ChatMessage } from "./messages";

/**
 * Carrying the conversation back to wherever the next question goes.
 *
 * ── The problem ────────────────────────────────────────────────────────────────
 *
 * This app sends one string. `askNetwork` takes a question, Rust runs
 * `common … ask "<that string>"`, and the CLI puts it into a one-element `messages`
 * array — `common/common.py`, where the array is built. The gateway on the other
 * side is OpenAI-compatible and would happily forward a whole conversation, but
 * there is no `--messages` on `common ask` and no session id anywhere on the wire,
 * so a follow-up like "and why?" arrives at the node with nothing in front of it.
 *
 * So the history is rendered into the one string, here, on this side. It is a
 * transcript inside a message rather than a real multi-turn request, and that is
 * a real difference — but it is the difference between a follow-up landing on
 * something and a follow-up landing on nothing, and only one of those is a
 * conversation.
 *
 * ── The budget ─────────────────────────────────────────────────────────────────
 *
 * The node that answers is somebody's laptop, running whatever context window its
 * Ollama happens to be configured with. Nothing in this app sets `num_ctx` and
 * nothing can read it, so the window is opaque from here: a long history replayed
 * in full would silently overflow it and the answer would come back worse, not
 * longer — and worse in a way that would look like the model had got confused
 * rather than like the client had sent too much.
 *
 * Hence a character budget, oldest turns dropped first. It is a guess, and it is
 * named so that finding the real number is one edit rather than a rewrite.
 *
 * The faithful fix is a `--messages` flag on `common ask`, after which the body of
 * this file becomes an array and nothing else changes. That belongs in
 * `common-network` and is not worth blocking a release on a second repository.
 */

/**
 * How much of the history may be replayed, in characters.
 *
 * Roughly a thousand tokens. Deliberately conservative: the failure on the other
 * side of it — an answer that is merely less informed than it could have been —
 * is much cheaper than the failure on this side, which is a node spending a
 * laptop-minute and its context on a prompt that no longer fits.
 */
export const CONTEXT_BUDGET_CHARS = 4000;

/**
 * What the extra text costs before any turn is written — the part that tells the
 * node it is in the middle of something. Written out here so the budget can be
 * counted against the whole prompt and not just its tail.
 */
const PREAMBLE =
  "The user is continuing an earlier conversation with you. What has been said " +
  "so far follows, oldest first. Reply only to the final message.";

/**
 * The line the app sends, given what has been said and the question being asked.
 *
 * Returns the question on its own when there is nothing behind it — which is the
 * first question in every chat, and is what this app sent before any of this
 * existed. A preamble on a question with no history would be telling the node
 * about a conversation that has not happened.
 */
export function promptFor(history: readonly ChatMessage[], question: string): string {
  const turns = history.filter(isTurn);
  if (turns.length === 0) return question;

  const room = CONTEXT_BUDGET_CHARS - question.length - PREAMBLE.length;
  const kept = tailWithin(turns, room);

  const lines = kept.map(
    (turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.trim()}`,
  );
  return `${PREAMBLE}\n\n${lines.join("\n\n")}\n\nUser: ${question}`;
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
    const cost = turns[i].text.length + 12;
    if (kept.length > 0 && used + cost > room) break;
    kept.unshift(turns[i]);
    used += cost;
  }
  return kept;
}
