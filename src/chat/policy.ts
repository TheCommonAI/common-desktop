import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { readStoredFlow } from "../onboarding/flow";
import type { ResourceLimits } from "../onboarding/service";
import { peer, phaseOf, readEnabled, startPeer, stopPeer, usePeer } from "../peer/peer";

/**
 * Holding the app to when it said it would help.
 *
 * The layer network has no throttle, so the only limits that mean anything are
 * the ones about *when* — and those the app can keep, because it decides whether
 * the peer is running. Two rules: not on battery, if the user said "only when
 * plugged in"; and not inside quiet hours.
 *
 * Pausing is a real stop: the peer tells the others it is leaving, so nobody
 * keeps sending it work, and it comes back when the rule lifts. A pause the user
 * did not choose is remembered as such, so lifting the rule restarts only what the
 * rule stopped — never something the user switched off themselves.
 */

/** Minutes since midnight for "HH:MM", or `null` if it is not one. */
function minutes(clock: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(clock);
  if (m === null) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
}

/** Is `now` inside the window? `end` earlier than `start` crosses midnight, which is the normal case. */
export function inQuietHours(now: Date, window: { start: string; end: string } | null): boolean {
  if (window === null) return false;
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === null || end === null || start === end) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** Why the policy says no right now, or `null` when it says yes. */
export function pauseReason(
  limits: ResourceLimits | null,
  onBattery: boolean | null,
  now: Date,
): string | null {
  if (limits === null) return null;
  if (inQuietHours(now, limits.quietHours)) return `Resting until ${limits.quietHours?.end}`;
  if (limits.contribute === "plugged-in" && onBattery === true) return "Waiting for you to plug in";
  return null;
}

async function onBattery(): Promise<boolean | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  try {
    const power = await invoke<{ source: string }>("read_power");
    return power.source === "battery" ? true : power.source === "mains" ? false : null;
  } catch {
    return null;
  }
}

const EVERY_MS = 30_000;

/** Keeps the peer on or off according to the user's limits. Returns the reason it is paused, if it is. */
export function useContributionPolicy(): string | null {
  const view = usePeer();
  const phase = phaseOf(view);
  const [reason, setReason] = useState<string | null>(null);
  const pausedByPolicy = useRef(false);
  const latest = useRef(phase);
  latest.current = phase;

  useEffect(() => {
    let live = true;
    const check = async () => {
      if (!readEnabled() && !pausedByPolicy.current) {
        if (live) setReason(null);
        return;
      }
      const limits = readStoredFlow()?.limits ?? null;
      const battery = limits?.contribute === "plugged-in" ? await onBattery() : null;
      const why = pauseReason(limits, battery, new Date());
      if (!live) return;
      setReason(why);
      const running = latest.current !== "off" && latest.current !== "unknown" && latest.current !== "problem";
      if (why !== null && running && !pausedByPolicy.current) {
        pausedByPolicy.current = true;
        stopPeer().catch(() => undefined);
      } else if (why === null && pausedByPolicy.current) {
        pausedByPolicy.current = false;
        startPeer().catch(() => undefined);
      }
    };
    void check();
    const timer = window.setInterval(check, EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  // `peer` is imported so a browser preview and the app go through the same
  // module; nothing here calls it directly.
  void peer;
  return reason;
}
