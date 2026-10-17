import { useCallback, useEffect, useRef, useState } from "react";
import { defaultLimits, patchStoredFlow, readStoredFlow, type FlowState } from "../onboarding/flow";
import { CAP_CHOICES, CONTRIBUTE_CHOICES, DEFAULT_QUIET, QUIET_CHOICES, capChoiceOf } from "../onboarding/limits";
import { MODEL_LADDER, TIERS, findModel, modelFor } from "../onboarding/models";
import Choices from "../onboarding/parts/Choices";
import Control from "../onboarding/parts/Control";
import TimeField from "../onboarding/parts/TimeField";
import { onboardingService, type ResourceLimits, type Tier } from "../onboarding/service";
import { contrib, leaveNetwork, whoami, type Contrib, type Whoami } from "./backend";
import { networkFact, type Rejoin } from "./rejoin";
import { busy, type UpdateOffer } from "./updates";
import { findPlace, readPlace, type Place } from "./geo";
import Globe from "./Globe";
import ShareLog from "./ShareLog";

/**
 * Settings, as a card over the conversation.
 *
 * It is a `<dialog>` opened with `showModal()`, which is the whole of the
 * construction: the top layer, the focus trap, Escape to close and the
 * `aria-modal` semantics all come from the platform, and `::backdrop` is the dim
 * that pushes the chat back. Hand-rolling an overlay would be a hundred lines
 * and a worse version of what the browser already does.
 *
 * It reads and writes the *same* record the onboarding wrote, through `flow.ts`
 * — the same key, the same validation. A second store for the same three
 * answers would mean two truths about how much of this machine the network may
 * use, and there is no version of that which is fine.
 *
 * Two halves, and the split is deliberate. Everything under the globe that the
 * user can change is theirs: when to contribute, how much, whether to rest, and
 * — behind a hatch — the model. Everything shown as a fact is the network's and
 * is not editable here: the name it knows this machine by, how many questions it
 * has answered, whether the gateway can currently reach it. The card never
 * states a fact it did not read.
 *
 * One row is neither, and it is the last thing before leaving: a way to take a
 * description of this machine away with you — see `ShareLog`. It is here as well
 * as on the join screen because a machine can be joined, look fine, and quietly
 * stop being reachable later, and this is where somebody goes when they have a
 * symptom and no error message to go with it.
 */

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  /** Whether the gateway can see this machine, as the rail already read it.
   *  Passed in rather than asked again, so the card and the rail cannot
   *  disagree. */
  seen: boolean | null;
  /** What this app has done about it. Passed in for the same reason: one answer
   *  to "can the gateway reach us" and one to "what did we do about it". */
  rejoin: Rejoin;
  /** Put this machine back on the network, because the user asked it to. Not the
   *  automatic pass — see `mayRejoinNow` for why the two differ. */
  onReconnect: () => void;
  /** The version running. Always known, whether or not a check ever ran. */
  version: string;
  /** What is known about a newer version. Owned by the chat, because the bar in
   *  the rail reads the same value — the card and the rail cannot then disagree
   *  about whether an update is waiting. */
  offer: UpdateOffer;
  onCheck: () => void;
  onInstall: () => void;
  onRestart: () => void;
}

/** How long the model sentence has to be held before the lanes appear. Long
 *  enough not to fire on a click, short enough not to feel broken. */
const HOLD_MS = 600;

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

export default function Settings({
  open,
  onClose,
  seen,
  rejoin,
  onReconnect,
  version,
  offer,
  onCheck,
  onInstall,
  onRestart,
}: SettingsProps) {
  const dialog = useRef<HTMLDialogElement | null>(null);

  // The answers, seeded from the record the flow wrote. Read once, at mount:
  // the dialog mounts when the card opens and the state below is the source of
  // truth from then on.
  const [flow] = useState<FlowState | null>(() => readStoredFlow());
  const [contribute, setContribute] = useState<ResourceLimits["contribute"]>(
    () => (flow?.limits ?? defaultLimits(flow?.hardware ?? null)).contribute,
  );
  const [cap, setCap] = useState<ResourceLimits["cap"]>(
    () => (flow?.limits ?? defaultLimits(flow?.hardware ?? null)).cap,
  );
  const [quiet, setQuiet] = useState<ResourceLimits["quietHours"]>(
    () => (flow?.limits ?? defaultLimits(flow?.hardware ?? null)).quietHours,
  );
  const [modelId, setModelId] = useState<string | null>(() => flow?.modelId ?? null);

  const [hatched, setHatched] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);

  // What leaving actually did, in the network's own words, and what went wrong
  // when it could not be asked at all. Two states rather than one because they
  // are shown in different places: the outcome becomes the row's fact, while the
  // failure is announced beside the buttons — which stay put, so it can be tried
  // again.
  const [said, setSaid] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  const [identity, setIdentity] = useState<Whoami | null>(null);
  const [served, setServed] = useState<Contrib | null>(null);

  // Where the globe puts its dot. Seeded from storage so a machine that has
  // looked up once never looks up again, and so the marker is there on the first
  // frame rather than arriving under a globe already in motion.
  const [place, setPlace] = useState<Place | null>(() => readPlace());

  /* ------------------------------- the dialog ------------------------------- */

  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // `showModal` twice throws, and closing an already-closed dialog is a no-op
    // on some engines and not others — so the state is read off the element
    // rather than tracked twice.
    if (open && !element.open) {
      element.showModal();
      // `showModal` puts focus on the first focusable descendant, which here is
      // the model hatch — and a modal focus moved by script is treated as
      // `:focus-visible`, so the one control that must never look like a control
      // opened wearing an underline. Focus goes to the heading instead. Tab from
      // there still reaches the hatch, deliberately: a keyboard user who lands on
      // it *should* see where they are.
      heading.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  /* ------------------------------- the network ------------------------------ */

  useEffect(() => {
    if (!open || gone) return;
    let live = true;
    whoami().then(
      (answer) => live && setIdentity(answer),
      () => undefined,
    );
    contrib().then(
      (answer) => live && setServed(answer),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, gone]);

  /* -------------------------------- the place ------------------------------- */

  // Asked for on the first open and never again: `findPlace` reads the cache
  // first, so once it has stored an answer this effect is a no-op that never
  // leaves the machine. The `place !== null` guard is what stops the effect
  // re-running against a set state.
  useEffect(() => {
    if (!open || place !== null) return;
    let live = true;
    findPlace().then((answer) => {
      if (live && answer !== null) setPlace(answer);
    });
    return () => {
      live = false;
    };
  }, [open, place]);

  /* ----------------------------- writing it back ---------------------------- */

  // The service clamps, and what it says it stored is the truth — so a write
  // adopts the reply rather than the request. The counter is what keeps a slow
  // early reply from landing on top of a fast later one and undoing the user's
  // last change.
  const writing = useRef(0);
  const commit = useCallback((limits: ResourceLimits, patch?: Partial<FlowState>) => {
    // Local first, so the setting is never lost to a backend that is not there.
    patchStoredFlow(patch === undefined ? { limits } : { limits, ...patch });
    const generation = ++writing.current;
    onboardingService.setLimits(limits).result.then(
      (stored) => {
        if (writing.current !== generation) return;
        setContribute(stored.contribute);
        setCap(stored.cap);
        setQuiet(stored.quietHours);
      },
      () => undefined,
    );
  }, []);

  const setLimits = (next: Partial<ResourceLimits>) => {
    const limits: ResourceLimits = {
      contribute: next.contribute ?? contribute,
      cap: next.cap ?? cap,
      quietHours: next.quietHours === undefined ? quiet : next.quietHours,
    };
    setContribute(limits.contribute);
    setCap(limits.cap);
    setQuiet(limits.quietHours);
    commit(limits);
  };

  /* -------------------------------- the hatch ------------------------------- */

  const hold = useRef<number | null>(null);
  const clearHold = () => {
    if (hold.current !== null) {
      window.clearTimeout(hold.current);
      hold.current = null;
    }
  };
  useEffect(() => clearHold, []);

  const startHold = () => {
    clearHold();
    hold.current = window.setTimeout(() => {
      hold.current = null;
      setHatched(true);
    }, HOLD_MS);
  };

  const choose = (next: Tier) => {
    // The same four the flow offered, and picked by rung rather than by name: the
    // ladder has one axis, so a rung *is* a model and there is nothing here for the
    // user to get wrong. The record written is the one the flow wrote, so the next
    // reconnect serves what this row now says.
    const model = modelFor(next);
    setModelId(model.id);
    patchStoredFlow({ modelId: model.id });
  };

  /* -------------------------------- the facts ------------------------------- */

  const model = modelId === null ? null : findModel(modelId);
  const capChoice = capChoiceOf(cap);

  const nodeName = identity?.name ?? null;

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-labelledby="settings-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="settings__globe-well">
        <Globe size={144} active={open} marker={place} />
      </div>

      <div className="settings__body">
        <h2 className="settings__title" id="settings-title" ref={heading} tabIndex={-1}>
          Settings
        </h2>

        <p className="settings__fact">
          {nodeName === null
            ? "Not registered with the network"
            : model === null
              ? nodeName
              : `${nodeName} · serving ${model.label}`}
        </p>

        {/* The hatch. A button that looks exactly like the sentence around it —
            no underline, no colour, nothing that says press me — because the
            user is not meant to find it. A hold opens it; a click does nothing;
            a keyboard activation opens it too, so it is invisible to the eye and
            present to a reader. */}
        <p className="settings__fact">
          {model === null ? (
            "No model chosen yet"
          ) : (
            <>
              Running{" "}
              <button
                type="button"
                className="settings__hatch"
                aria-expanded={hatched}
                aria-label={`Running ${model.label}. Hold to choose a different model.`}
                onPointerDown={startHold}
                onPointerUp={clearHold}
                onPointerLeave={clearHold}
                onPointerCancel={clearHold}
                // A long press is a context menu on macOS, which would eat the
                // hold before it fired.
                onContextMenu={(event) => event.preventDefault()}
                // `detail === 0` is a keyboard or assistive activation. A mouse
                // click is detail 1 and is deliberately not a way in.
                onClick={(event) => event.detail === 0 && setHatched(true)}
              >
                {model.label}
              </button>
            </>
          )}
        </p>

        {hatched && (
          <div className="settings__hatch-open">
            <Choices
              label="Model"
              name="settings-model"
              value={model?.tier ?? null}
              choices={TIERS.map((tier) => ({
                value: tier,
                label: MODEL_LADDER[tier].label,
              }))}
              onChange={choose}
            />
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
          <p className="settings__label">How much it may take</p>
          <Choices
            label="How much it may take"
            name="settings-cap"
            value={capChoice?.value ?? null}
            choices={CAP_CHOICES.map(({ value, label }) => ({ value, label }))}
            onChange={(value) => {
              const choice = CAP_CHOICES.find((c) => c.value === value);
              if (choice !== undefined) {
                setLimits({ cap: { cpuPercent: choice.cpuPercent, gpuPercent: choice.gpuPercent } });
              }
            }}
          />
          {capChoice !== null && (
            <p className="settings__note">
              Up to {capChoice.cpuPercent}% of the processor · {capChoice.gpuPercent}% of the
              graphics
            </p>
          )}
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

        {/* The row the user came here for when something has gone wrong.
            `common join` is a foreground process, so anything that ends it — a
            reboot, a crash, a killed shell — leaves this machine with an identity
            on disk and nothing serving. Until now the card could only say so. The
            button is the way back: the app re-runs the join, and `join.py` sends
            the token in `identity.json` back on the registration, so this reclaims
            its own node rather than minting a second.

            Manual, and therefore ungated. The automatic pass at launch respects
            the user's quiet hours — see `mayRejoinNow` — but a button somebody
            pressed is an instruction rather than a suggestion, and a control that
            silently declined to act would be worse than no control. */}
        <div className="settings__row">
          <p className="settings__label">The network</p>
          <p className="settings__fact">{networkFact(seen, rejoin)}</p>
          {served !== null && (
            <p className="settings__fact">
              {served.requestsServed === 1
                ? "Answered 1 question"
                : `Answered ${served.requestsServed} questions`}
            </p>
          )}
          <div className="settings__controls">
            <Control onClick={onReconnect} quiet disabled={rejoin.kind === "working"}>
              {rejoin.kind === "working" ? "Reconnecting…" : "Reconnect"}
            </Control>
          </div>

          {/* Mounted from the start and filled later, like the leave row's below
              and `ShareLog`'s, and for the same reason: a live region that appears
              already holding its text is missed by most screen readers. What goes
              here is the evidence rather than the sentence — the detail the join
              carried, which is the half a user pastes into a report and the half
              the fact above has no room for.

              With the sentence as the fallback, because not every failure carries
              evidence: `network` and `timeout` arrive with no detail at all, and a
              region that held its breath for those would leave the card's whole
              answer to "why isn't it connecting" unread — visibly on screen and
              silent to a reader. `networkFact` is asked rather than a second
              sentence written here, so the two cannot come to different
              conclusions about one machine. */}
          <p className="settings__said" role="status">
            {rejoin.kind === "failed" ? (rejoin.detail ?? networkFact(seen, rejoin)) : ""}
          </p>
        </div>

        {/* The same report the join screen offers at the moment it fails, kept
            here as well because the failure is not always noticed then — a
            machine can be joined, appear fine, and quietly stop being reachable
            a week later, and Settings is where somebody goes when they have a
            symptom and no error. */}
        <div className="settings__row">
          <p className="settings__label">If it won't connect</p>
          <p className="settings__fact">
            A report of this machine — the app, the CLI, this node's identity — and the end of
            the join log.
          </p>
          <ShareLog />
        </div>

        {/* Last of the quiet rows, and the only one about the app rather than the
            machine. It is here because the alternative is a menu item, and the
            menu bar's own menu is three entries long on purpose.

            Three controls, and each one names what it does rather than what has
            happened — which is why none of them says "You're up to date". That
            belongs in the sentence above, and a button that changes its label to
            report a result is a button that has stopped being an instruction. The
            one exception is `Install`, where the label and the action are the same
            word in both places: the bar in the rail offers exactly this, and the
            two reaching the same state with different words would read as two
            different offers. */}
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

        <div className="settings__row">
          {gone ? (
            <p className="settings__fact">
              {`${said ?? "This machine has left the network."} Rejoining would give it a new name.`}
            </p>
          ) : leaving ? (
            <>
              <p className="settings__fact">
                Leaving forgets this machine's key. Rejoining would give it a new name.
              </p>
              <div className="settings__controls">
                <Control
                  // The reply is passed on rather than assumed. Leaving has more
                  // than one ending, and the card used to assert the happiest one
                  // over a call whose failure it threw away — see `leaveNetwork`.
                  onClick={() => {
                    setTrouble(null);
                    leaveNetwork().then(
                      (answer) => {
                        setSaid(answer);
                        setIdentity(null);
                        setGone(true);
                      },
                      (why: unknown) => setTrouble(String(why)),
                    );
                  }}
                  arrow
                >
                  Leave
                </Control>
                <Control
                  onClick={() => {
                    setLeaving(false);
                    setTrouble(null);
                  }}
                  quiet
                >
                  Stay
                </Control>
              </div>
            </>
          ) : (
            <div className="settings__controls">
              <Control onClick={() => setLeaving(true)} quiet>
                Leave the network
              </Control>
            </div>
          )}

          {/* Mounted from the start and filled later, like `ShareLog`'s, and for
              the same reason: a live region that appears already holding its text
              is missed by most screen readers. This is where a leave that could
              not be finished is said out loud — the one thing the card was
              previously unable to report, because the failure was discarded and
              the success was announced in its place. */}
          <p className="settings__said" role="status">
            {trouble}
          </p>
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
