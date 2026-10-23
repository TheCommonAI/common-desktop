import { useCallback, useEffect, useRef, useState } from "react";
import { defaultLimits, patchStoredFlow, readStoredFlow, type FlowState } from "../onboarding/flow";
import { CONTRIBUTE_CHOICES, DEFAULT_QUIET, QUIET_CHOICES } from "../onboarding/limits";
import Choices from "../onboarding/parts/Choices";
import Control from "../onboarding/parts/Control";
import TimeField from "../onboarding/parts/TimeField";
import { onboardingService, type ResourceLimits } from "../onboarding/service";
import { layersLabel, otherPeers, peer, phaseOf, stagesCovered, startPeer, stopPeer, usePeer, writeEnabled } from "../peer/peer";
import { busy, type UpdateOffer } from "./updates";
import Globe from "./Globe";
import ShareLog from "./ShareLog";

/**
 * Settings, as a card over the conversation.
 *
 * It is a `<dialog>` opened with `showModal()`, which is the whole of the
 * construction: the top layer, the focus trap, Escape to close and the
 * `aria-modal` semantics all come from the platform.
 *
 * It reads and writes the *same* record the onboarding wrote, through `flow.ts`.
 * A second store for the same answers would mean two truths about when this
 * machine may be used.
 *
 * Two halves. What the user can change is theirs: when to contribute, whether to
 * rest overnight, and whether this machine is on the network at all. What is
 * shown as a fact is the peer's own account of itself — its state, its layers, its
 * address, who else is there — read from the status file and never inferred. The
 * card never states a fact it did not read.
 */

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  /** The version running. Always known, whether or not a check ever ran. */
  version: string;
  /** What is known about a newer version. Owned by the chat, because the bar in
   *  the rail reads the same value. */
  offer: UpdateOffer;
  onCheck: () => void;
  onInstall: () => void;
  onRestart: () => void;
}

/**
 * What the Updates row says, given what is known.
 *
 * A function rather than a nested ternary in the markup because there are six
 * cases and the sentence for each is the whole of the row's meaning. The version
 * is interpolated rather than written out, so it cannot drift from the bundle the
 * way a hardcoded number would — and so that a preview, which has no bundle to
 * read, shows what it actually is.
 */
function updateFact(offer: UpdateOffer, version: string): string {
  const running = version === "" ? "This version" : `Common ${version}`;
  switch (offer.kind) {
    case "unknown":
      return `${running}.`;
    case "checking":
      return "Looking for a newer version.";
    case "current":
      return `${running} — the newest version.`;
    case "available":
      return `Version ${offer.version} is available.`;
    case "downloading":
      return `Version ${offer.version} is downloading.`;
    case "staged":
      return `Version ${offer.version} is ready to install.`;
    case "restarting":
      return "Restarting.";
    case "failed":
      return "Couldn't reach the release feed.";
  }
}

export default function Settings({ open, onClose, version, offer, onCheck, onInstall, onRestart }: SettingsProps) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const view = usePeer();
  const phase = phaseOf(view);
  const status = view?.status ?? null;

  // The answers, seeded from the record the flow wrote.
  const [flow] = useState<FlowState | null>(() => readStoredFlow());
  const [contribute, setContribute] = useState<ResourceLimits["contribute"]>(
    () => (flow?.limits ?? defaultLimits(flow?.hardware ?? null)).contribute,
  );
  const [quiet, setQuiet] = useState<ResourceLimits["quietHours"]>(
    () => (flow?.limits ?? defaultLimits(flow?.hardware ?? null)).quietHours,
  );
  const [log, setLog] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /* ------------------------------- the dialog ------------------------------- */

  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // `showModal` twice throws, so the state is read off the element rather than tracked twice.
    if (open && !element.open) {
      element.showModal();
      heading.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  // The log is read when the card opens and not before: it is a file on disk and
  // nobody is looking at it until then.
  useEffect(() => {
    if (!open) return;
    let live = true;
    peer.logTail(12).then(
      (text) => live && setLog(text),
      () => live && setLog(null),
    );
    return () => {
      live = false;
    };
  }, [open, phase]);

  /* ----------------------------- writing it back ---------------------------- */

  const writing = useRef(0);
  const commit = useCallback((limits: ResourceLimits) => {
    // Local first, so the setting is never lost to a backend that is not there.
    patchStoredFlow({ limits });
    const generation = ++writing.current;
    onboardingService.setLimits(limits).result.then(
      (stored) => {
        if (writing.current !== generation) return;
        setContribute(stored.contribute);
        setQuiet(stored.quietHours);
      },
      () => undefined,
    );
  }, []);

  const setLimits = (next: Partial<ResourceLimits>) => {
    const limits: ResourceLimits = {
      contribute: next.contribute ?? contribute,
      quietHours: next.quietHours === undefined ? quiet : next.quietHours,
    };
    setContribute(limits.contribute);
    setQuiet(limits.quietHours);
    commit(limits);
  };

  /* -------------------------------- the peer -------------------------------- */

  const on = view?.wantRunning === true || view?.running === true;
  const others = otherPeers(status);
  const covered = stagesCovered(status);
  const share = layersLabel(status);

  const fact: string = (() => {
    switch (phase) {
      case "unknown":
        return "Checking on this machine…";
      case "off":
        return "This machine is not on the network";
      case "problem":
        return view?.problem ?? "This machine can't join";
      case "crashed":
        return "It stopped on its own";
      case "starting":
        return "Getting ready";
      case "downloading":
        return "Getting its share of the model";
      case "loading":
        return "Loading its share into memory";
      case "moving":
        return "Moving to where it's needed";
      case "leaving":
        return "Leaving the network";
      case "error":
        return status?.error ?? "It hit a problem";
      case "up":
        return share === null ? "On the network" : `On the network, serving ${share}`;
    }
  })();

  const toggle = () => {
    setProblem(null);
    if (on) {
      writeEnabled(false);
      stopPeer().catch(() => undefined);
    } else {
      writeEnabled(true);
      startPeer().catch((error: unknown) => {
        writeEnabled(false);
        setProblem(typeof error === "string" ? error : "I couldn't start it.");
      });
    }
  };

  const copyAddress = () => {
    if (!status?.url) return;
    const line = `common join --network ${status.url}`;
    navigator.clipboard?.writeText(line).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-labelledby="settings-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="settings__globe-well">
        <Globe size={144} active={open} marker={null} />
      </div>

      <div className="settings__body">
        <h2 className="settings__title" id="settings-title" ref={heading} tabIndex={-1}>
          Settings
        </h2>

        <p className="settings__fact" role="status">
          {fact}
        </p>
        {status?.model && <p className="settings__fact">{status.model}{status.backend ? ` on ${status.backend}` : ""}</p>}
        {problem !== null && <p className="settings__fact">{problem}</p>}

        <div className="settings__row">
          <p className="settings__label">On the network</p>
          <div className="settings__controls">
            <Control onClick={toggle} quiet={on} arrow={!on} disabled={phase === "leaving" || phase === "unknown"}>
              {on ? "Leave the network" : phase === "crashed" ? "Start it again" : "Join the network"}
            </Control>
          </div>
          {on && (
            <p className="settings__note">
              Leaving tells the other machines you&apos;re going, so nobody sends you work. You can rejoin any
              time; your share is kept.
            </p>
          )}
        </div>

        {status !== null && phase !== "off" && (
          <div className="settings__row">
            <p className="settings__label">The others</p>
            <p className="settings__fact">
              {others.length === 0
                ? "No other machines online yet"
                : `${others.length} other ${others.length === 1 ? "machine" : "machines"} online`}
              {covered !== null ? ` · ${covered.covered} of ${covered.total} parts of the model covered` : ""}
            </p>
            {status.url && (
              <>
                <p className="settings__note">Friends can join through you with:</p>
                <p className="settings__fact">{`common join --network ${status.url}`}</p>
                <div className="settings__controls">
                  <Control onClick={copyAddress} quiet>
                    {copied ? "Copied" : "Copy"}
                  </Control>
                </div>
              </>
            )}
          </div>
        )}

        <div className="settings__row">
          <p className="settings__label">Contribute</p>
          <Choices
            label="Contribute"
            name="settings-contribute"
            value={contribute}
            choices={CONTRIBUTE_CHOICES}
            onChange={(value) => setLimits({ contribute: value })}
          />
        </div>

        <div className="settings__row">
          <p className="settings__label">Overnight</p>
          <Choices
            label="Overnight"
            name="settings-quiet"
            value={quiet === null ? "no" : "yes"}
            choices={QUIET_CHOICES}
            onChange={(value) =>
              setLimits({ quietHours: value === "yes" ? (quiet ?? DEFAULT_QUIET) : null })
            }
          />
          {quiet !== null && (
            <div className="settings__times">
              <TimeField
                label="Pause at"
                value={quiet.start}
                onChange={(start) => setLimits({ quietHours: { start, end: quiet.end } })}
              />
              <TimeField
                label="Pick up at"
                value={quiet.end}
                onChange={(end) => setLimits({ quietHours: { start: quiet.start, end } })}
              />
            </div>
          )}
        </div>

        <div className="settings__row">
          <p className="settings__label">If it won&apos;t connect</p>
          <p className="settings__fact">
            A report of this machine — the app, the command-line tool, the peer&apos;s state — and the end of its
            log. Nothing secret goes in it.
          </p>
          {log !== null && log.trim() !== "" && (
            <p className="settings__note" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {log}
            </p>
          )}
          {view?.logPath ? <p className="settings__note">{`Log: ${view.logPath}`}</p> : null}
          <ShareLog />
        </div>

        <div className="settings__row">
          <p className="settings__label">Updates</p>
          <p className="settings__fact">{updateFact(offer, version)}</p>
          <div className="settings__controls">
            {offer.kind === "available" ? (
              <Control onClick={onInstall} arrow>
                Install
              </Control>
            ) : offer.kind === "staged" || offer.kind === "restarting" ? (
              <Control onClick={onRestart} arrow disabled={offer.kind === "restarting"}>
                Restart to update
              </Control>
            ) : (
              <Control onClick={onCheck} quiet disabled={busy(offer)}>
                Check for updates
              </Control>
            )}
          </div>
        </div>

        <div className="settings__controls settings__controls--last">
          <Control onClick={onClose} arrow>
            Done
          </Control>
        </div>
      </div>
    </dialog>
  );
}
