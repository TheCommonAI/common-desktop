export interface UsageStats {
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  conversationsStarted: number;
  questionsSent: number;
  answersReceived: number;
  answersFailed: number;
  questionsStopped: number;
  reconnectAttempts: number;
  reconnectsSucceeded: number;
  reconnectsFailed: number;
}

export type UsageMetric = Exclude<keyof UsageStats, "firstUsedAt" | "lastUsedAt">;

const STORAGE_KEY = "common.usage-stats.v1";

const EMPTY_STATS: UsageStats = {
  firstUsedAt: null,
  lastUsedAt: null,
  conversationsStarted: 0,
  questionsSent: 0,
  answersReceived: 0,
  answersFailed: 0,
  questionsStopped: 0,
  reconnectAttempts: 0,
  reconnectsSucceeded: 0,
  reconnectsFailed: 0,
};

function readStats(): UsageStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...EMPTY_STATS };
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { ...EMPTY_STATS };

    const stored = value as Record<string, unknown>;
    const count = (key: UsageMetric) => {
      const metric = stored[key];
      return typeof metric === "number" && Number.isSafeInteger(metric) && metric >= 0
        ? metric
        : 0;
    };
    return {
      firstUsedAt: typeof stored.firstUsedAt === "string" ? stored.firstUsedAt : null,
      lastUsedAt: typeof stored.lastUsedAt === "string" ? stored.lastUsedAt : null,
      conversationsStarted: count("conversationsStarted"),
      questionsSent: count("questionsSent"),
      answersReceived: count("answersReceived"),
      answersFailed: count("answersFailed"),
      questionsStopped: count("questionsStopped"),
      reconnectAttempts: count("reconnectAttempts"),
      reconnectsSucceeded: count("reconnectsSucceeded"),
      reconnectsFailed: count("reconnectsFailed"),
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

export function usageStats(): UsageStats {
  return readStats();
}

export function recordUsage(metric: UsageMetric): void {
  try {
    const current = readStats();
    const now = new Date().toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...current,
        [metric]: current[metric] + 1,
        firstUsedAt: current.firstUsedAt ?? now,
        lastUsedAt: now,
      }),
    );
  } catch {
    // Usage tracking is optional and must not interrupt the app.
  }
}
