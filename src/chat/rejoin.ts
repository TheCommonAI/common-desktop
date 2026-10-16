import { defaultLimits, readStoredFlow } from "../onboarding/flow";
import { quietUntil } from "../onboarding/limits";
import { findModel } from "../onboarding/models";
import type { JoinRequest, OnboardingErrorCode, ResourceLimits } from "../onboarding/service";
import { whoami } from "./backend";

/**
 * Coming back to the network, after something took this machine off it.
 *
 * ── The problem this exists for ───────────────────────────────────────────────
 *
 * `common join` is a foreground process: it serves a model behind a tunnel and
 * stays up for as long as the machine is contributing. Rebooting the laptop kills
 * it. `identity.json` survives — which is what makes the node reclaimable — but
 * nothing on the machine ever starts the join again, and the app has no way to
 * ask. The user lands in the chat, which looks exactly like a working one, and is
 * silently not serving. There is no button, no retry and no notice.
 *
 * ── Why this is small ─────────────────────────────────────────────────────────
 *
 * Because the hard part already exists. `service.real.ts` treats re-running
 * `common join` as the sanctioned way to reconnect, and its reuse guard already
 * decides correctly whether to start a process or leave a serving one alone —
 * `join.py` sends the token in `identity.json` back on registration and reclaims
 * its own node rather than minting a second. So a reconnect is not new plumbing,
 * it is `ensureJoined` plus the four decisions below.
 *
 * ── What it deliberately does not do ──────────────────────────────────────────
 *
 * It does not keep the connection state. `Chat` owns `seen`, which the rail and
 * the Settings card both read, and this reports to it rather than opening a
 * second copy that could disagree. Two reads of "can the gateway reach us" is how
 * a screen ends up saying Connected over a machine nobody can route to.
 *
 * It is also not a React module, which is not a style choice: the decisions here
 * are the ones worth testing, and a file with a hook in it cannot be loaded by
 * `tests/rejoin.test.mjs` without also mocking React. The binding lives in
 * `useRejoin.ts`, beside it.
 */

/**
 * Where a reconnect has got to, from the user's side.
 *
 * A union rather than a flag and a message, because the five are genuinely
 * different screens: `waiting` is not a failure, `failed` is not a silence, and
 * the two sentences that matter most — "resting until 07:00" and "the gateway
 * never listed this machine" — must not be reachable from the same state.
 */
export type Rejoin =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "reached" }
  /** Gated off by the user's own quiet hours, and telling them so. `until` is the
   *  stored end of the window, so the sentence shows the clock they set. */
  | { kind: "waiting"; until: string }
  | { kind: "failed"; code: OnboardingErrorCode; detail: string | null };

/**
 * Whether an automatic reconnect may go ahead now, and if not, until when.
 *
 * Quiet hours are the one limit honoured here, and `contribute` is deliberately
 * not consulted. Two reasons, and they point the same way. Nothing in this app
 * enforces the contribution limits anywhere — `setLimits` says so itself, the CLI
 * has no verb that would take them — so a gate here would be the first and only
 * place they were ever honoured, which is a claim about the product rather than a
 * fix. And `defaultLimits` sets `"plugged-in"` on a machine that is on battery,
 * so gating on it would mean a rebooted laptop reporting "waiting for the mains"
 * instead of reconnecting: the exact case this feature was asked for. Serving for
 * a while on battery is the lesser cost than the reported bug surviving the fix.
 *
 * Quiet hours are different in kind. A machine that starts serving at 3am, after
 * the user set 22:00–07:00, is the app violating a setting the user set *in the
 * app* — and the whole point of the window is that nobody is there to notice.
 *
 * The manual path does not call this. A button the user pressed is an
 * instruction, not a suggestion.
 */
export function mayRejoinNow(
  limits: ResourceLimits,
  now: Date,
): { allowed: true } | { allowed: false; until: string } {
  const until = quietUntil(limits.quietHours, now);
  return until === null ? { allowed: true } : { allowed: false, until };
}

/**
 * The model id the node is registered as, or `""` when it cannot be asked.
 *
 * Caught rather than propagated, and that is the point of the helper. `whoami`
 * reaches the CLI through Rust, so it rejects when the tool is not on disk or
 * will not run, and `JSON.parse` throws on output that is not JSON — and the
 * question it is being asked here is narrow: *is there a registered id to fall
 * back on?* A machine that cannot answer has not got one to offer, which is the
 * same answer as `catalogue_id: null`, and `""` matches no catalogue entry so it
 * resolves to `null` above. Letting it throw instead would take a reconnect down
 * over a fallback nobody needed.
 */
async function registeredId(): Promise<string> {
  try {
    return (await whoami())?.catalogueId ?? "";
  } catch {
    return "";
  }
}

/**
 * What a reconnect asks for, or `null` when this machine cannot say.
 *
 * Recovered rather than remembered, because a reconnect is reached from the chat,
 * where no onboarding state is in scope. The answers are all still on the machine
 * — the flow record the settings card writes, and the identity the CLI wrote — so
 * this reads them rather than asking the user to go through setup again.
 */
export async function joinInputs(): Promise<JoinRequest | null> {
  const flow = readStoredFlow();

  // Two sources, and the identity is only asked for when the stored id does not
  // resolve — so the ordinary reconnect, a machine whose flow is intact, never
  // touches the CLI for this. `whoami` is the fallback for the two cases a stored
  // flow cannot cover: a build whose storage was cleared under a surviving
  // `~/.common-network`, and a flow naming a model this version no longer ships.
  // In both the node token is still on disk, so the reconnect is still worth
  // making — and in the second, the identity is the better answer anyway, since
  // it is what the node is actually registered as.
  const model = findModel(flow?.modelId ?? "") ?? findModel(await registeredId());
  // The lane comes from the catalogue and never from `flow.lane` or a default. A
  // join started under the wrong lane files this node under a model it is not
  // serving, and the network routes to it on that basis — so an id no catalogue
  // entry matches is a reason to stop and say so, not to pick the nearest lane and
  // hope. `null` is that stop.
  if (model === null) return null;

  return {
    lane: model.lane,
    modelId: model.id,
    // The stored limits, or the same defaults the flow would have started from.
    // These travel in the request and reach nothing but this app — see `setLimits`
    // — so what they are for here is the gate above and the node's own record.
    limits: flow?.limits ?? defaultLimits(flow?.hardware ?? null),
  };
}

/**
 * The one sentence on the Settings row, from both the reading and the reconnect.
 *
 * Both, because neither alone is complete. `seen` is the gateway's answer as of
 * the last read and `rejoin` is what this app has done about it since, so a row
 * that read only one of them would say "the gateway can't reach this machine"
 * over a reconnect that just succeeded, or "the gateway can reach this machine"
 * over one that has just failed — and it would go on saying it until something
 * happened to refresh the reading.
 *
 * A function rather than a field on the state, so this row and the rail's foot
 * cannot come to different conclusions about the same machine. */
export function networkFact(seen: boolean | null, rejoin: Rejoin): string {
  switch (rejoin.kind) {
    case "working":
      return "Reconnecting this machine to the network.";
    case "waiting":
      return `Resting until ${rejoin.until}.`;
    case "failed":
      return failureSentence(rejoin.code);
    case "idle":
    case "reached":
      // Nothing newer than the reading, so the reading is the sentence — which is
      // also what this row said before there was a reconnect button on it.
      if (seen === null) return "Checking whether the gateway can see this machine";
      return seen
        ? "The gateway can reach this machine"
        : "The gateway can't reach this machine right now";
  }
}

/**
 * Why a reconnect did not get through.
 *
 * The codes are the join screen's own and mean the same things here, so the
 * distinction that screen is built around survives: `cli-missing` and
 * `join-stopped` are failures on *this* machine and must never be shown as
 * network ones. "The network didn't answer" about a file that is not on disk
 * sends the user to inspect a network this machine never used.
 *
 * `cancelled` is not reached from here. A user who stopped the wait got what they
 * asked for, and the caller drops it rather than reporting it as a failure —
 * reaching a sentence at all would be the rail announcing a stop as a fault.
 */
function failureSentence(code: OnboardingErrorCode): string {
  switch (code) {
    case "cli-missing":
      return "Common's command-line tool couldn't be started, so nothing was sent.";
    case "join-stopped":
      return "The join started and then stopped. The report below has the log.";
    case "network":
      return "The gateway never listed this machine.";
    case "permission-denied":
      return "The system refused that.";
    case "unsupported":
      return "This machine can't join the network.";
    case "insufficient-disk":
      return "There isn't enough room.";
    case "not-found":
      return "That model isn't available.";
    case "timeout":
      return "Reconnecting took too long.";
    case "cancelled":
    case "unknown":
      return "Couldn't reconnect.";
  }
}
