import { useEffect, useSyncExternalStore } from "react";
import { real } from "./real";
import { stub } from "./stub";
import type { PeerStatus, PeerView } from "./types";
import { provisionNow, startProvisioning } from "../provision";

/**
 * The one peer, as the screens see it.
 *
 * In the app it is the real one, through Rust; in a browser it is a script that
 * plays the same states. The choice is made once, here, and nothing downstream
 * knows which it was handed — the same arrangement the onboarding service uses,
 * for the same reason: a page opened in a browser is how these screens get
 * reviewed.
 */

function insideApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const peer = insideApp() ? real : stub;

/* ---------------------------------- the store --------------------------------- */

let latest: PeerView | null = null;
const watchers = new Set<() => void>();
let off: (() => void) | null = null;

function publish(view: PeerView) {
  latest = view;
  watchers.forEach((watcher) => watcher());
}

function attach() {
  if (off !== null) return;
  off = peer.subscribe(publish);
  peer.status().then(publish, () => {});
}

function detach() {
  if (watchers.size > 0) return;
  off?.();
  off = null;
}

function subscribe(callback: () => void): () => void {
  watchers.add(callback);
  attach();
  return () => {
    watchers.delete(callback);
    detach();
  };
}

/** The latest view, or `null` until the first answer. Every component that uses it shares one subscription. */
export function usePeer(): PeerView | null {
  return useSyncExternalStore(subscribe, () => latest);
}

/**
 * Python and the tunnel come before the CLI can run at all. On a machine with neither, the first call
 * to the CLI fails with a misleading "not installed", so the peer waits for the one install the app
 * runs at launch (see `provision.ts`). Already-ready machines pay one comparison. `failed` is not
 * waited on: there is nothing left to wait for, and the start reports its own, better sentence.
 */
async function provisioned(): Promise<void> {
  const now = provisionNow().kind;
  if (now !== "ready" && now !== "failed") await startProvisioning();
}

/** Start the peer if the user has it switched on. For launch. */
export function useAutostart(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    peer.status().then(
      (view) => {
        if (!view.running && !view.wantRunning) provisioned().then(() => peer.start()).catch(() => {});
      },
      () => {},
    );
  }, [enabled]);
}

/** Wrap a start/stop so the store updates at once rather than on the next tick. */
export async function startPeer(network?: string): Promise<PeerView> {
  await provisioned();
  const view = await peer.start(network);
  publish(view);
  return view;
}

export async function stopPeer(): Promise<PeerView> {
  const view = await peer.stop();
  publish(view);
  return view;
}

/* --------------------------------- the meaning --------------------------------- */

/** The "is the user's choice on" flag, remembered across launches. */
const ENABLED = "common.peer.enabled";

export function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED) === "1";
  } catch {
    return false;
  }
}

export function writeEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED, on ? "1" : "0");
  } catch {
    // Nothing to do: it simply asks again next launch.
  }
}

/**
 * Where this machine is in joining, as one word the screens switch on.
 *
 * `off` and `problem` are the two states in which nothing is running; `crashed`
 * is a peer that was running and went quiet. The rest follow the status file.
 */
export type Phase =
  | "unknown"
  | "off"
  | "problem"
  | "crashed"
  | "starting"
  | "downloading"
  | "loading"
  | "up"
  | "moving"
  | "leaving"
  | "error";

export function phaseOf(view: PeerView | null): Phase {
  if (view === null) return "unknown";
  if (view.problem !== null && !view.running) return "problem";
  if (view.crashed) return "crashed";
  const status = view.status;
  if (!view.wantRunning && !view.running) return "off";
  if (status === null) return view.running || view.wantRunning ? "starting" : "off";
  switch (status.state) {
    case "stopped":
      return view.wantRunning ? "starting" : "off";
    case "error":
      return "error";
    case "leaving":
      return "leaving";
    default:
      return status.state;
  }
}

/** Whether chat can be asked right now. */
export function chatReady(view: PeerView | null): boolean {
  const status = view?.status;
  return phaseOf(view) === "up" && status?.api?.ready === true;
}

/** "layers 18 to 27" for a window, or `null` when there is none yet. */
export function layersLabel(status: PeerStatus | null | undefined): string | null {
  const window = status?.window;
  if (!window) return null;
  return `layers ${window[0]} to ${window[1]}`;
}

/** How many stages have at least one peer, and how many there are. */
export function stagesCovered(status: PeerStatus | null | undefined): { covered: number; total: number } | null {
  const coverage = status?.coverage;
  if (!coverage || coverage.length === 0) return null;
  return { covered: coverage.filter((n) => n > 0).length, total: coverage.length };
}

/** Peers other than this machine that are up. */
export function otherPeers(status: PeerStatus | null | undefined) {
  return (status?.peers ?? []).filter((p) => !p.me && p.state === "up");
}
