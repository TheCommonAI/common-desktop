import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatEvent, ChatHandlers, PeerDiagnostics, PeerView } from "./types";

/**
 * The peer, through Rust.
 *
 * Everything goes through commands rather than straight at the CLI or the peer's
 * API: the page cannot call loopback without CORS, and the status file is Rust's
 * to validate. Events carry the rest: `peer-status` on every supervisor tick, and
 * `chat` for each piece of a streaming answer.
 */

export const real = {
  start: (network?: string) => invoke<PeerView>("peer_start", { network: network ?? null }),
  stop: () => invoke<PeerView>("peer_stop"),
  status: () => invoke<PeerView>("peer_status"),
  logTail: (lines = 60) => invoke<string>("peer_log_tail", { lines }),
  diagnostics: () => invoke<PeerDiagnostics>("diagnostics"),

  /** Calls back with every status Rust sees. Returns the unsubscribe. */
  subscribe(callback: (view: PeerView) => void): () => void {
    let off: (() => void) | null = null;
    let live = true;
    listen<PeerView>("peer-status", (event) => callback(event.payload)).then((fn) => {
      if (live) off = fn;
      else fn();
    });
    return () => {
      live = false;
      off?.();
    };
  },

  /** Ask the peer's own chat API. Returns a function that stops the answer. */
  chat(id: string, messages: readonly { role: string; content: string }[], handlers: ChatHandlers): () => void {
    let off: (() => void) | null = null;
    let over = false;
    const finish = () => {
      over = true;
      off?.();
    };
    listen<ChatEvent>("chat", (event) => {
      const payload = event.payload;
      if (payload.id !== id || over) return;
      if (payload.kind === "delta") handlers.onDelta(payload.text);
      else if (payload.kind === "done") {
        finish();
        handlers.onDone();
      } else if (payload.kind === "error") {
        finish();
        handlers.onError(payload.status, payload.message);
      }
    }).then((fn) => {
      if (over) fn();
      else off = fn;
      // Start only once the listener is in place, or the first words would be
      // sent to nobody.
      if (!over) {
        invoke("chat_stream", { id, messages, maxTokens: 1024, temperature: 0.7 }).catch((error: unknown) => {
          if (over) return;
          finish();
          handlers.onError(0, typeof error === "string" ? error : "Chat couldn't start.");
        });
      }
    });
    return () => {
      if (over) return;
      finish();
      invoke("chat_stop", { id }).catch(() => {});
    };
  },
};
