import { invoke } from "@tauri-apps/api/core";
import { GREETING, type ChatMessage } from "./messages";

/**
 * The chats this machine has had, and how they outlive the window.
 *
 * Until now a conversation lived exactly as long as the window did: `Chat` held
 * an array and quitting was the end of it. That is the wrong shape for this app
 * — it is built to be left and come back to, and a question asked on Monday is
 * worth having the answer to on Friday.
 *
 * So the chats are written to a file in the app's own data folder. The writing is
 * Rust's, in `store.rs`, and not because it was tidier there: the webview has no
 * filesystem and the app carries no storage plugin, so it is the only door. Rust
 * takes the payload as one opaque string and never learns the schema below, which
 * is what keeps this module the single source of truth for it.
 *
 * Everything here fails soft to "no chats", in both directions. A file that
 * cannot be read is an empty list rather than a thrown error, and a write that
 * cannot happen is dropped. Losing a history is bad; a chat screen that will not
 * open because its history is unreadable is worse.
 */

/** One chat, in memory. */
export interface Conversation {
  /** Minted once and never shown. It is what a row in the rail points at, and
   *  what survives the chat being renamed by its own first question. */
  id: string;
  /** Unix milliseconds. `createdAt` fixes the chat's place in the rail, so the
   *  list does not reorder itself under the cursor while a reply arrives. */
  createdAt: number;
  /** Unix milliseconds, moved on every line added. Nothing draws it; it decides
   *  which chat is open when the app comes back. */
  updatedAt: number;
  messages: readonly ChatMessage[];
}

/**
 * The same chat as it sits in the file.
 *
 * Two differences from the interface above and both are JSON's: a chat is keyed
 * by an id that has to be a string, and `Date` has no representation, so the
 * clock is written as the ISO string the transcript already prints it from.
 * The narrowing below is the only place either is turned back.
 */
interface StoredConversation {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  at: string;
  failed?: boolean;
  stopped?: boolean;
  servedBy?: string;
}

/**
 * Narrow one line, rather than trusting it.
 *
 * The same shape `geo.asPlace` uses and for the same reason: what arrives has
 * been through `JSON.parse` and may have been written by a version of this app
 * that no longer exists. A line missing its clock cannot be drawn — the
 * transcript prints a time under every message — so it is dropped rather than
 * given a stand-in date, which would be inventing something the user said.
 */
function asMessage(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, role, text, at, failed, stopped, servedBy } = value as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  if (role !== "user" && role !== "assistant") return null;
  if (typeof text !== "string" || typeof at !== "string") return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;

  const message: ChatMessage = { id, role, text, at: when };
  if (failed === true) message.failed = true;
  if (stopped === true) message.stopped = true;
  if (typeof servedBy === "string") message.servedBy = servedBy;
  return message;
}

/** Narrow one chat. Applied to what comes off disk, and never to what we wrote
 *  this session — see `loadConversations`, which is the only caller. */
function asConversation(value: unknown): Conversation | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, createdAt, updatedAt, messages } = value as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof createdAt !== "number" || typeof updatedAt !== "number") return null;
  if (!Array.isArray(messages)) return null;

  const lines = messages
    .map(asMessage)
    .filter((message): message is ChatMessage => message !== null);
  return { id, createdAt, updatedAt, messages: lines };
}

/**
 * An id for a chat that has never been on disk.
 *
 * `crypto.randomUUID` is only there in a secure context. The app's own origin is
 * one (`tauri://localhost`) and so is the localhost preview, but a page served
 * over plain http is not — and a chat that cannot be created is a worse failure
 * than an id that is merely unlikely to repeat.
 */
function mintId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A chat that has not been spoken in, which is one greeting and nothing else.
 *
 * The greeting is the transcript's opening line rather than a message — see
 * `messages.GREETING` — and it is the reason a new chat is never an empty list
 * with nothing to draw in it.
 */
export function newConversation(): Conversation {
  const now = Date.now();
  return {
    id: mintId(),
    createdAt: now,
    updatedAt: now,
    messages: [{ id: 0, role: "assistant", text: GREETING, at: new Date(now) }],
  };
}

/**
 * Everything on disk, newest chat first.
 *
 * Fails to an empty list, and an empty list is a real answer: it is what a first
 * run gets and what a machine whose chats were never saved gets, and the caller
 * has a first-class answer for it. Outside the app there is no `invoke` at all,
 * which is the same empty list — the browser preview has no file to read and
 * should not pretend otherwise.
 */
export async function loadConversations(): Promise<readonly Conversation[]> {
  try {
    const raw = await invoke<string | null>("conversations_read");
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return ordered(
      parsed.map(asConversation).filter((chat): chat is Conversation => chat !== null),
    );
  } catch {
    return [];
  }
}

/**
 * Writes are chained, so a slow one cannot land on top of a fast one.
 *
 * Every save is the whole list, and two of them can be in flight at once — a reply
 * landing while a chat is being deleted, say. Both would write the same `.tmp`
 * sibling before renaming it, so without this the file can come to hold whichever
 * write happened to reach the disk last rather than whichever was made last, and a
 * chat created a moment ago vanishes on the next launch. `write` below never
 * rejects, so the chain cannot break.
 */
let writes: Promise<void> = Promise.resolve();

/** Write the whole list, replacing whatever was there.
 *
 *  Fire and forget at the call site, deliberately: the caller has already changed
 *  the screen and has nothing to say about a disk that would not take the write. */
export function saveConversations(list: readonly Conversation[]): Promise<void> {
  const next = writes.then(() => write(list));
  writes = next;
  return next;
}

async function write(list: readonly Conversation[]): Promise<void> {
  try {
    const stored: StoredConversation[] = list.map((chat) => ({
      id: chat.id,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messages: chat.messages.map((message) => {
        const line: StoredMessage = {
          id: message.id,
          role: message.role,
          text: message.text,
          at: message.at.toISOString(),
        };
        if (message.failed === true) line.failed = true;
        if (message.stopped === true) line.stopped = true;
        if (message.servedBy !== undefined) line.servedBy = message.servedBy;
        return line;
      }),
    }));
    await invoke("conversations_write", { json: JSON.stringify(stored) });
  } catch {
    // Dropped. The alternative is an error the user can do nothing about, about
    // a file they did not know was there.
  }
}

/** Newest chat first, by when it was started rather than by when it was last
 *  spoken in. Using `updatedAt` here would reorder the rail every time a reply
 *  landed, under the hand that is still holding the mouse. */
export function ordered(list: readonly Conversation[]): readonly Conversation[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/** The chat the app comes back to. The other question from `ordered`, and the
 *  only place `updatedAt` is read. */
export function mostRecentlyUsed(list: readonly Conversation[]): Conversation {
  return list.reduce((newest, chat) => (chat.updatedAt > newest.updatedAt ? chat : newest));
}

/**
 * The id the next message in this session should take.
 *
 * Ids are a per-session counter, so a loaded chat's ids are whatever the session
 * that wrote them got up to. React keys are these, and two messages sharing one
 * is one message that disappears — so the counter has to resume above the
 * highest of them rather than at the start.
 */
export function nextIdAbove(list: readonly Conversation[]): number {
  let highest = 0;
  for (const chat of list) {
    for (const message of chat.messages) {
      if (message.id > highest) highest = message.id;
    }
  }
  return highest + 1;
}

/**
 * What a chat is called in the rail: the user's own first question, quoted back.
 *
 * Derived rather than stored. A stored title is a second copy of a sentence that
 * is already in the chat, and the two would eventually disagree — there is no
 * rename in this app, so nothing would ever need the copy.
 */
const TITLE_CHARS = 40;

export function titleFor(conversation: Conversation): string {
  const asked = conversation.messages.find(
    (message) => message.role === "user" && message.text.trim() !== "",
  );
  if (asked === undefined) return "New chat";

  // Whitespace collapsed first: a question typed over three lines is one line in
  // a rail that has room for one line.
  const line = asked.text.replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_CHARS) return line;

  // Cut at a word where there is one near the edge. `TITLE_CHARS / 2` is the
  // floor: past that, a word break is further from where the text was cut than
  // the ellipsis is, and the title reads as a fragment either way.
  const cut = line.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}
