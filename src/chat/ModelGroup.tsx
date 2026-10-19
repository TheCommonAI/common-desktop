import { useCallback, useEffect, useRef, useState } from "react";
import Control from "../onboarding/parts/Control";
import {
  DRAFT_TOKENS_MAX,
  DRAFT_TOKENS_MIN,
  GROUP_POLL_MS,
  MAX_GROUP_PORT,
  MIN_GROUP_PORT,
  clampDraftTokens,
  groupFact,
  healthLabel,
  isGroupPort,
  startBlock,
  type GroupSettings,
  type GroupStatus,
} from "./group-config";
import {
  groupStatus,
  readStoredSettings,
  setDraftTokens,
  startGroup,
  stopGroup,
  writeStoredSettings,
} from "./group";

export interface ModelGroupProps {
  /** Whether the settings card is open. The status is asked for only while it is,
   *  so a closed card leaves the coordinator alone. */
  open: boolean;
}

/** What an error from the seam says, as one line. */
function reason(from: unknown): string {
  const text =
    typeof from === "string" ? from : from instanceof Error ? from.message : String(from);
  return text.trim().split("\n")[0] ?? "";
}

/**
 * The model group, as a panel of facts and three controls.
 *
 * The facts are read, not set: whether the file names a group, what that group is,
 * and what the coordinator answers on its health endpoint. The controls are the
 * panel's own. The group file and the port are typed in and kept. The draft length
 * is written into the group's file, where the coordinator will read it at its next
 * start. Start and Stop run the coordinator through the CLI.
 *
 * The draft length is written when the control is released rather than on every
 * step, so a drag is one write. The panel holds the value it is moving through until
 * the write is read back, so the control does not jump back to the old number while
 * the file catches up.
 */
export default function ModelGroup({ open }: ModelGroupProps) {
  // The app's seam is only there inside the app. In a browser the panel says so and
  // asks for nothing, rather than failing on a missing bridge each time it polls.
  const inApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const [settings, setSettings] = useState<GroupSettings>(() => readStoredSettings());
  const [pathText, setPathText] = useState(settings.configPath);
  const [portText, setPortText] = useState(String(settings.port));
  const [status, setStatus] = useState<GroupStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The draft length while the control is being moved, before it is written.
  const [moving, setMoving] = useState<number | null>(null);

  // Only the newest answer may land, so a slow reply cannot overwrite a fresh one.
  const latest = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++latest.current;
    try {
      const next = await groupStatus(settings);
      if (mine !== latest.current) return;
      setStatus(next);
      setPollError(null);
    } catch (error) {
      if (mine === latest.current) setPollError(reason(error));
    }
  }, [settings]);

  useEffect(() => {
    if (!open || !inApp) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), GROUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, inApp, refresh]);

  /* ------------------------------ the settings ------------------------------ */

  const keep = (next: GroupSettings) => {
    writeStoredSettings(next);
    setSettings(next);
    setActionError(null);
  };

  const commitPath = () => {
    const configPath = pathText.trim();
    setPathText(configPath);
    if (configPath !== settings.configPath) keep({ ...settings, configPath });
  };

  const commitPort = () => {
    const value = Number(portText.trim());
    if (!isGroupPort(value)) {
      setPortText(String(settings.port));
      setActionError(`The port must be a whole number from ${MIN_GROUP_PORT} to ${MAX_GROUP_PORT}.`);
      return;
    }
    setPortText(String(value));
    if (value !== settings.port) keep({ ...settings, port: value });
  };

  /* -------------------------------- the actions ----------------------------- */

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    work()
      .catch((error: unknown) => setActionError(reason(error)))
      .then(() => refresh())
      .finally(() => setBusy(false));
  };

  const writeDraft = (raw: number) => {
    const value = clampDraftTokens(raw);
    if (value === null || status === null || !status.configured || value === status.draftTokens) {
      setMoving(null);
      return;
    }
    setBusy(true);
    setActionError(null);
    setDraftTokens(settings.configPath, value)
      .catch((error: unknown) => setActionError(reason(error)))
      .then(() => refresh())
      .finally(() => {
        setMoving(null);
        setBusy(false);
      });
  };

  /* ---------------------------------- the view ------------------------------ */

  if (!inApp) {
    return <p className="settings__fact">The model group is only available in the app.</p>;
  }

  const running = status?.coordinator.state === "running";
  const blocked = status === null ? null : startBlock(status, settings.port);
  const canEditDraft = status !== null && status.configured && !busy;
  const draftShown = moving ?? status?.draftTokens ?? DRAFT_TOKENS_MIN;

  return (
    <div className="group">
      <p className="settings__fact" role="status">
        {status === null ? (pollError ?? "Reading the group…") : groupFact(status)}
      </p>

      {status !== null && (
        <p className="settings__fact">
          Coordinator {healthLabel(status.health).toLowerCase()} on port {settings.port}.
          {status.health === "ready" && !running
            ? " It answers, but this app did not start it."
            : ""}
        </p>
      )}

      <div className="group__field">
        <label className="group__label" htmlFor="group-path">
          Group file
        </label>
        <input
          id="group-path"
          className="group__input"
          type="text"
          value={pathText}
          placeholder="~/networks/network.json"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setPathText(event.target.value)}
          onBlur={commitPath}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitPath();
          }}
        />
      </div>

      <div className="group__field">
        <label className="group__label" htmlFor="group-port">
          Port
        </label>
        <input
          id="group-port"
          className="group__input group__input--narrow"
          type="number"
          inputMode="numeric"
          min={MIN_GROUP_PORT}
          max={MAX_GROUP_PORT}
          step={1}
          value={portText}
          onChange={(event) => setPortText(event.target.value)}
          onBlur={commitPort}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitPort();
          }}
        />
      </div>

      <div className="group__field">
        <label className="group__label" htmlFor="group-draft">
          Draft length
        </label>
        <div className="group__draft">
          <input
            id="group-draft"
            type="range"
            min={DRAFT_TOKENS_MIN}
            max={DRAFT_TOKENS_MAX}
            step={1}
            value={draftShown}
            disabled={!canEditDraft}
            onChange={(event) => setMoving(Number(event.target.value))}
            onPointerUp={(event) => writeDraft(Number(event.currentTarget.value))}
            onKeyUp={(event) => writeDraft(Number(event.currentTarget.value))}
          />
          <output htmlFor="group-draft">{draftShown}</output>
        </div>
        <p className="settings__note">Takes effect the next time the coordinator starts.</p>
      </div>

      <div className="settings__controls">
        <Control onClick={() => run(() => startGroup(settings))} disabled={busy || blocked !== null}>
          Start
        </Control>
        <Control quiet onClick={() => run(() => stopGroup())} disabled={busy || !running}>
          Stop
        </Control>
      </div>

      {blocked !== null && !running && <p className="settings__note">{blocked}</p>}

      {status?.coordinator.state === "ended" && (
        <p className="settings__note">
          The coordinator stopped ({status.coordinator.code}). Its log is at
          ~/.common-network/coordinator.log.
        </p>
      )}

      <p className="settings__said" role="status">
        {actionError ?? pollError ?? ""}
      </p>
    </div>
  );
}
