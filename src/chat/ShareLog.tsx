import { useState } from "react";
import Control from "../onboarding/parts/Control";
import { diagnostics, saveDiagnostics, type Diagnostics } from "./backend";
import { recentReportEvents } from "./reporting";
import { usageStats } from "./usage";

/**
 * How to hand somebody the evidence, for when it will not connect.
 *
 * The report is built here rather than in Rust for one reason: only this side
 * knows the reader's clock. `joined_at` and the log's mtime arrive as Unix
 * seconds and become dates in the local timezone, which is the form a person
 * comparing them to their own memory of "it was about half past two" can use.
 *
 * ── What is deliberately absent ───────────────────────────────────────────────
 *
 * No node token, and no key of any kind — not filtered out here, but never read
 * in the first place; see `IdentitySummary` in `backend.rs`. That matters because
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
export function reportText(d: Diagnostics): string {
  const out: string[] = [];
  const row = (label: string, value: string | null | undefined) => {
    const shown = value === null || value === undefined || value === "" ? "—" : value;
    out.push(`${label.padEnd(12)}${shown}`);
  };

  out.push("Common. — a report from this machine");
  out.push("");
  out.push("This report carries no key or token for this machine.");
  out.push("");

  row("Reported", when(Math.floor(Date.now() / 1000)));
  row("App", `${d.appVersion} (${d.appIdentifier})`);
  row("System", d.osVersion === "" ? d.osPlatform : `${d.osPlatform} ${d.osVersion}`);
  row("CLI", d.cliVersion);
  row("CLI path", d.cliPath);
  row("Gateway", d.gateway);

  out.push("");
  out.push("Identity");
  row("  file", d.identityPath);
  if (d.identityError !== null) {
    // A read that failed, which is not the same fact as never having joined —
    // and is the one a report is usually being asked about.
    row("  state", `could not be read — ${d.identityError}`);
  } else if (d.joined === null) {
    row("  state", "not registered; this machine has never joined");
  } else {
    row("  name", d.joined.name);
    row("  node", d.joined.nodeId);
    row("  catalogue", d.joined.catalogueId);
    row("  tags", d.joined.domainTags.join(", "));
    row("  joined", when(d.joined.joinedAt));
    row("  gateway", d.joined.gateway);
  }

  out.push("");
  out.push("Join log");
  row("  file", d.logPath);
  row("  size", d.logBytes === null ? null : `${d.logBytes} bytes`);
  row("  modified", when(d.logModified));
  if (d.logError !== null) {
    row("  state", `could not be read — ${d.logError}`);
  }
  if (d.logTail !== null && d.logTail.trim() !== "") {
    out.push("");
    out.push("End of the log");
    out.push("");
    out.push(d.logTail);
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
  row("  reconnects", String(usage.reconnectAttempts));
  row("  reconnected", String(usage.reconnectsSucceeded));
  row("  reconnect fail", String(usage.reconnectsFailed));

  out.push("");
  const events = recentReportEvents();
  if (events.length > 0) {
    out.push("Recent automatically captured events (stored on this device)");
    out.push("These are included only when you choose to copy or save this report.");
    for (const event of events) {
      out.push("");
      out.push(`${event.occurredAt}  ${event.kind}`);
      out.push(event.message);
    }
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
  const run = (act: (d: Diagnostics) => Promise<string>) => {
    setBusy(true);
    setNote(null);
    diagnostics()
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
