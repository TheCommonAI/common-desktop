import { useMemo, useState } from "react";
import type { Conversation } from "./conversations";
import Transcript from "./Transcript";
import Composer from "./Composer";

export type OverlayMode = "quick" | "conversation" | "history" | "full";

interface Props {
  mode: OverlayMode;
  chats: readonly Conversation[];
  active: Conversation;
  busy: boolean;
  thinking: boolean;
  unavailable?: string;
  onMode: (mode: OverlayMode) => void;
  onSend: (text: string) => boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onStop: (ms: number) => void;
  onSettings: () => void;
}

function titleFor(chat: Conversation) {
  const first = chat.messages.find((message) => message.role === "user");
  return first?.text.trim().slice(0, 72) || "New conversation";
}

function snippetFor(chat: Conversation) {
  return chat.messages[chat.messages.length - 1]?.text.slice(0, 90) || "Start a conversation";
}

function groupFor(chat: Conversation) {
  const day = new Date(chat.updatedAt);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Three deliberately small presentations of one persistent conversation store. */
export default function OverlayChat({
  mode, chats, active, busy, thinking, unavailable,
  onMode, onSend, onSelect, onNew, onDelete, onStop, onSettings,
}: Props) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = [...chats]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((chat) =>
        (titleFor(chat) + " " + chat.messages.map((m) => m.text).join(" "))
          .toLowerCase().includes(query),
      );
    const grouped = new Map<string, Conversation[]>();
    for (const chat of matches) {
      const key = groupFor(chat);
      grouped.set(key, [...(grouped.get(key) ?? []), chat]);
    }
    return [...grouped];
  }, [chats, search]);

  if (mode === "quick") {
    return (
      <div className="common-overlay common-overlay--quick">
        <div className="common-overlay__quickbar">
          <Composer
            onSend={(text) => {
              const sent = onSend(text);
              if (sent) onMode("conversation");
              return sent;
            }}
            busy={busy}
            unavailable={unavailable}
          />
        </div>
        <span className="common-overlay__hint">Option + Space · Quick chat</span>
        <button className="common-overlay__quiet-link" type="button" onClick={() => onMode("history")}>
          Past chats
        </button>
      </div>
    );
  }

  return (
    <section className={"common-overlay common-overlay--" + mode} aria-label={mode === "history" ? "Past chats" : "Conversation"}>
      <header className="common-overlay__header">
        <button className="common-overlay__brand" type="button" onClick={() => onMode("quick")} aria-label="Back to quick chat">COMMON.</button>
        <div className="common-overlay__actions">
          {mode === "conversation" && (
            <button type="button" onClick={() => onMode("history")} aria-label="Past chats" title="Past chats">☷</button>
          )}
          <button type="button" onClick={() => { onNew(); onMode("quick"); }} aria-label="New chat" title="New chat">+</button>
          <button type="button" onClick={() => onMode("full")} aria-label="Expand to full chat" title="Expand">↗</button>
          <button type="button" onClick={() => onMode("quick")} aria-label="Minimise conversation" title="Minimise">×</button>
        </div>
      </header>
      {mode === "history" ? (
        <div className="common-overlay__history">
          <h2>Your chats</h2>
          <input
            aria-label="Search past chats"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search past chats..."
            className="common-overlay__search"
          />
          <div className="common-overlay__groups">
            {groups.length === 0 && <p className="common-overlay__empty">No conversations found.</p>}
            {groups.map(([group, entries]) => (
              <div className="common-overlay__group" key={group}>
                <h3>{group}</h3>
                {entries.map((chat) => (
                  <div className={"common-overlay__chatrow" + (chat.id === active.id ? " is-active" : "")} key={chat.id}>
                    <button type="button" className="common-overlay__chatpick" onClick={() => { onSelect(chat.id); onMode("conversation"); }}>
                      <span className="common-overlay__chatmark">▢</span>
                      <span className="common-overlay__chattext">
                        <strong>{titleFor(chat)}</strong>
                        <small>{snippetFor(chat)}</small>
                      </span>
                      <span className="common-overlay__time">{new Date(chat.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    </button>
                    <button className="common-overlay__delete" type="button" onClick={() => onDelete(chat.id)} aria-label={"Delete " + titleFor(chat)}>×</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <button type="button" className="common-overlay__settings" onClick={onSettings}>Settings</button>
        </div>
      ) : (
        <>
          <div className="common-overlay__transcript">
            <Transcript messages={active.messages} thinking={thinking} onStop={onStop} />
          </div>
          <div className="common-overlay__composer">
            <Composer onSend={onSend} busy={busy} unavailable={unavailable} />
          </div>
        </>
      )}
    </section>
  );
}
