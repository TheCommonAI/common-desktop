import { useState } from "react";
import Control from "../onboarding/parts/Control";
import { peer } from "../peer/peer";
import type { PeerDiagnostics } from "../peer/types";
import { saveDiagnostics } from "./backend";
import { recentReportEvents } from "./reporting";
import { usageStats } from "./usage";

/**
 * How to hand somebody the evidence, for when it will not connect.
 *
 * The report is built here rather than in Rust for one reason: only this side
 * knows the reader's clock, and a person comparing it to their own memory of "it
 * was about half past two" needs local time.
 *
 * ── What is deliberately absent ───────────────────────────────────────────────
 *
 * No token and no key of any kind. The peer's status file never holds one, and
 * Rust removes anything credential-shaped from it anyway (`scrub` in `peer.rs`)
 * before it reaches the page. That matters because
 * of where this text goes: a diagnostics report is pasted into a chat window, or
 * attached to an email, and it is the one artifact this app produces that is
 * meant to leave the machine. It says so in its own first line, because an absent
 * field reads as an oversight unless the reader is told it is a decision.
 *
 * ── Why two controls rather than one ──────────────────────────────────────────
 *
 * Copy and save are not two spellings of the same thing: one is for pasting into
 * a conversation, the other for attaching to a message, and a person who wants
 * the second has no use for the first. Both are quiet lines of text, so offering
 * both costs a word rather than a toolbar.
 */

/** A Unix time in the reader's own timezone, or `null` if there is not one. */
function when(seconds: number | null): string | null {
  if (seconds === null) return null;
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The report, as plain text.
 *
 * Laid out as two labelled columns because a report is scanned by a person
 * looking for the one line that is wrong, not read top to bottom. Every value
 * that could be missing prints an em dash instead of nothing, so the columns
 * stay aligned and an absent fact is visibly absent rather than invisible.
 */
export function reportText(d: PeerDiagnostics): string {
  const out: string[] = [];
  const row = (label: string, value: string | number | boolean | null | undefined) => {
    const shown = value === null || value === undefined || value === "" ? "—" : String(value);
    out.push(`${label.padEnd(14)}${shown}`);
  };
  const status = d.view.status;

  out.push("Common. — a report from this machine");
  out.push("");
  out.push("This report carries no key or token. Anything credential-shaped is removed before it is built.");
  out.push("");

  row("Reported", when(Math.floor(Date.now() / 1000)));
  row("App", d.appVersion);
  row("System", d.os);
  row("CLI", d.cliVersion);
  row("CLI path", d.cliPath);
  row("Knows --network", d.cliKnowsLayerNetwork === null ? null : d.cliKnowsLayerNetwork ? "yes" : "no — it needs updating");

  out.push("");
  out.push("The peer");
  row("  switched on", d.view.wantRunning ? "yes" : "no");
  row("  running", d.view.running ? "yes" : "no");
  row("  crashed", d.view.crashed ? "yes — its status stopped updating" : "no");
  row("  restarts", d.view.restarts);
  row("  last exit", d.view.lastExit);
  row("  problem", d.view.problem);
  row("  status file", d.view.statusPath);
  row("  status age", d.view.statusAge === null ? null : `${Math.round(d.view.statusAge)} s`);
  if (status === null) {
    row("  state", "no status file yet");
  } else {
    row("  state", status.state);
    row("  network", status.network);
    row("  model", status.model);
    row("  peer id", status.peer);
    row("  layers", status.window ? `${status.window[0]} to ${status.window[1]}` : null);
    row("  backend", status.backend);
    row("  memory offered", status.gib === undefined ? null : `${status.gib} GiB`);
    row("  address", status.url);
    row("  chat", status.api ? `port ${status.api.port}, ${status.api.ready ? "ready" : "loading"}` : null);
    row("  coverage", status.coverage ? status.coverage.join(" ") : null);
    row("  others online", (status.peers ?? []).filter((p) => !p.me && p.state === "up").length);
    row("  error", status.error);
  }

  out.push("");
  const usage = usageStats();
  out.push("Usage statistics (aggregate counts stored on this device)");
  out.push("No conversation text or identifiers are included.");
  row("  first used", usage.firstUsedAt);
  row("  last used", usage.lastUsedAt);
  row("  new chats", String(usage.conversationsStarted));
  row("  questions", String(usage.questionsSent));
  row("  answered", String(usage.answersReceived));
  row("  failed", String(usage.answersFailed));
  row("  stopped", String(usage.questionsStopped));

  const events = recentReportEvents();
  if (events.length > 0) {
    out.push("");
    out.push("Recent automatically captured events (stored on this device)");
    out.push("These are included only when you choose to copy or save this report.");
    for (const event of events) {
      out.push("");
      out.push(`${event.occurredAt}  ${event.kind}`);
      out.push(event.message);
    }
  }

  out.push("");
  out.push("Peer log");
  row("  file", d.view.logPath);
  if (d.logTail.trim() !== "") {
    out.push("");
    out.push("End of the log");
    out.push("");
    out.push(d.logTail);
  }

  out.push("");
  return out.join("\n");
}

/** A name for the file: local time, and a shape that sorts. */
function reportName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    "common-report",
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}`,
  ].join("-");
}

/**
 * Put the text on the clipboard.
 *
 * `navigator.clipboard` is the modern path and is the one that can silently do
 * nothing in a webview — it wants a secure context and a live user gesture, and
 * the app is the former but a promise can lose the latter. So it is tried, and
 * then the old selection-based route is tried, and only if both refuse does the
 * caller hear about it. Rejecting with a reason rather than resolving false keeps
 * the failure and its explanation in one place.
 */
async function toClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection route.
    }
  }

  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  // Off-screen rather than hidden: `display: none` cannot be selected, and an
  // unselected element cannot be copied.
  scratch.style.position = "fixed";
  scratch.style.top = "-1000px";
  document.body.appendChild(scratch);
  try {
    scratch.select();
    if (!document.execCommand("copy")) throw new Error("the copy was refused");
  } finally {
    scratch.remove();
  }
}

export default function ShareLog() {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Gather, then do one thing with the result.
   *
   * The same two failure points exist for both controls — the report could not
   * be gathered, or the action on it failed — and they are reported in the
   * interface's own voice rather than as a raw error, because the person reading
   * it is already looking at something that went wrong and does not need a second
   * thing phrased like a stack trace.
   */
  const run = (act: (d: PeerDiagnostics) => Promise<string>) => {
    setBusy(true);
    setNote(null);
    peer
      .diagnostics()
      .then(act)
      .then(setNote, (why: unknown) => setNote(String(why)))
      .finally(() => setBusy(false));
  };

  const copy = () =>
    run(async (d) => {
      await toClipboard(reportText(d));
      return "Copied. Paste it into a message to whoever is helping.";
    });

  const save = () =>
    run(async (d) => {
      const path = await saveDiagnostics(reportName(), reportText(d));
      return `Saved to ${path}`;
    });

  return (
    <div className="share">
      <div className="share__controls">
        <Control quiet onClick={copy} disabled={busy}>
          Copy logs
        </Control>
        <Control quiet onClick={save} disabled={busy}>
          Save to a file
        </Control>
      </div>

      {/* Mounted from the start and filled later, which is the only shape a live
          region reliably announces: one that appears already holding its text is
          missed by most screen readers. */}
      <p className="share__note" role="status">
        {note}
      </p>
    </div>
  );
}
