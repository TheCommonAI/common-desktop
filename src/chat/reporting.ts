export interface ReportEvent {
  kind: "crash" | "connection";
  occurredAt: string;
  message: string;
}

const STORAGE_KEY = "common.report-events.v1";
const MAX_EVENTS = 10;
const MAX_MESSAGE_LENGTH = 2_000;

function readEvents(): ReportEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (event): event is ReportEvent =>
        typeof event === "object" &&
        event !== null &&
        "kind" in event &&
        (event.kind === "crash" || event.kind === "connection") &&
        "occurredAt" in event &&
        typeof event.occurredAt === "string" &&
        "message" in event &&
        typeof event.message === "string",
    );
  } catch {
    return [];
  }
}

export function recentReportEvents(): ReportEvent[] {
  return readEvents();
}

export function recordReportEvent(
  kind: ReportEvent["kind"],
  message: string,
  occurredAt = new Date().toISOString(),
): void {
  const event: ReportEvent = {
    kind,
    occurredAt,
    message: message.slice(0, MAX_MESSAGE_LENGTH),
  };
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...readEvents(), event].slice(-MAX_EVENTS)),
    );
  } catch {
    // A report must never make the app less usable when storage is unavailable.
  }
}

export function describeCrash(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}
