import { preview } from "../preview";
import type { ChatHandlers, PeerDiagnostics, PeerEntry, PeerStatus, PeerView } from "./types";

/**
 * A scripted peer, for a browser.
 *
 * A page opened in a browser has no Rust behind it and no CLI, and that is how
 * these screens get reviewed. So this plays the part of the peer, walking the same
 * states the real one writes: starting, downloading its share of the model,
 * loading it, then up with other peers around it and the chat part ready.
 *
 * `?peer=` picks the script, so every state can be looked at on purpose:
 *   (none)   the whole arrival, in about twenty seconds
 *   up       already up, with peers
 *   lonely   up, but only one stage is covered — chat answers 503
 *   crash    comes up, then the status goes stale and the process is gone
 *   old-cli  the installed command-line tool does not know the layer network
 *   error    the peer reports an error
 */

type Script = "arrival" | "up" | "lonely" | "crash" | "old-cli" | "error";

function script(): Script {
  try {
    const wanted = new URLSearchParams(window.location.search).get("peer");
    if (wanted === "up" || wanted === "lonely" || wanted === "crash" || wanted === "old-cli" || wanted === "error") {
      return wanted;
    }
  } catch {
    // A page with no location is the default script.
  }
  return "arrival";
}

const STAGES: readonly (readonly [number, number])[] = [
  [0, 9],
  [9, 18],
  [18, 27],
  [27, 36],
];

const OTHERS: readonly PeerEntry[] = [
  { peer: "a1f09c", window: [0, 9], backend: "mlx", state: "up", age_s: 4, me: false },
  { peer: "7be2d4", window: [9, 18], backend: "nf4", state: "up", age_s: 9, me: false },
  { peer: "c33a18", window: [9, 18], backend: "mlx", state: "up", age_s: 2, me: false },
  { peer: "05d6ee", window: [27, 36], backend: "nf4", state: "up", age_s: 12, me: false },
];

const TOTAL = 1_240_000_000;

// `?at=N` (see `preview.ts`) starts the script already N seconds into its arrival.
const jumpAt = preview().at;
let wanted = jumpAt !== null;
let startedAt = jumpAt !== null ? Date.now() - jumpAt * 1000 : 0;
let stoppedAt = 0;
const listeners = new Set<(view: PeerView) => void>();

function status(): PeerStatus | null {
  if (!wanted && stoppedAt === 0) return null;
  const mode = script();
  const base = { v: 1 as const, network: "common-main-8b-v1", model: "Qwen3-8B", peer: "e5c0ac", backend: "mlx", gib: 9.9 };
  if (!wanted) {
    return { ...base, state: "stopped", window: null, url: null, peers: [], ts: Date.now() / 1000 };
  }
  const t = (Date.now() - startedAt) / 1000;
  const me: PeerEntry = { peer: "e5c0ac", window: [18, 27], backend: "mlx", state: "up", age_s: 0, me: true };
  const upStatus = (covered: boolean[]): PeerStatus => ({
    ...base,
    state: "up",
    window: [18, 27],
    url: "https://tidy-example-fixture.trycloudflare.com",
    stages: STAGES,
    coverage: covered.map((c, i) => (c ? (i === 1 ? 2 : 1) : 0)),
    peers: covered[0] || covered[1] ? [me, ...OTHERS.filter((_, i) => covered.some(Boolean) && (mode !== "lonely" || i === 0))] : [me],
    api: { port: 11440, ready: true },
    pid: 4242,
    ts: Date.now() / 1000,
  });
  if (mode === "error") {
    return { ...base, state: "error", window: null, error: "There isn't enough memory free to serve any part of this model.", ts: Date.now() / 1000 };
  }
  if (mode === "up") return upStatus([true, true, true, true]);
  if (mode === "lonely") return upStatus([false, false, true, false]);
  if (mode === "crash" && t > 8) {
    // The file stops being written; the view marks it crashed below.
    return { ...upStatus([true, true, true, true]), ts: startedAt / 1000 + 8 };
  }
  if (t < 2) return { ...base, state: "starting", window: null, ts: Date.now() / 1000 };
  if (t < 10) {
    const done = Math.min(1, (t - 2) / 8);
    return { ...base, state: "downloading", window: [18, 27], download: { bytes: Math.round(TOTAL * done), total: TOTAL }, ts: Date.now() / 1000 };
  }
  if (t < 13) return { ...base, state: "loading", window: [18, 27], ts: Date.now() / 1000 };
  const ready = t > 16;
  const up = upStatus([true, true, true, t > 15]);
  return { ...up, api: { port: 11440, ready } };
}

function view(): PeerView {
  const s = status();
  const crashed = script() === "crash" && wanted && s !== null && Date.now() / 1000 - (s.ts ?? 0) > 15;
  return {
    wantRunning: wanted,
    running: wanted && s !== null && !crashed,
    status: s,
    crashed,
    statusAge: s?.ts === undefined ? null : Math.max(0, Date.now() / 1000 - s.ts),
    restarts: 0,
    lastExit: null,
    problem: null,
    logPath: "~/.common-network/net/peer.log",
    statusPath: "~/.common-network/net/status.json",
  };
}

function push() {
  const now = view();
  listeners.forEach((listener) => listener(now));
}

let timer: number | null = null;
function ensureTicking() {
  if (timer !== null || typeof window === "undefined") return;
  timer = window.setInterval(push, 1000);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const REPLY =
  "A decentralised network is one where no single machine is in charge. Each computer holds a small piece of the work, " +
  "and they find each other directly, so the whole keeps running when any one of them drops out.";

export const stub = {
  async start(): Promise<PeerView> {
    await wait(150);
    if (script() === "old-cli") {
      throw "Your copy of Common's command-line tool is older than this app. Run the installer again to update it, then switch this on.";
    }
    wanted = true;
    stoppedAt = 0;
    startedAt = Date.now();
    ensureTicking();
    push();
    return view();
  },
  async stop(): Promise<PeerView> {
    await wait(300);
    wanted = false;
    stoppedAt = Date.now();
    push();
    return view();
  },
  async status(): Promise<PeerView> {
    return view();
  },
  async logTail(): Promise<string> {
    return "peer e5c0ac: Apple silicon, offering 9.9 GiB on mlx\nserving layers 18-27 as e5c0ac\nup at https://tidy-example-fixture.trycloudflare.com";
  },
  async diagnostics(): Promise<PeerDiagnostics> {
    return {
      appVersion: "preview",
      cliPath: "common",
      cliVersion: "v0.4.0",
      cliKnowsLayerNetwork: script() !== "old-cli",
      os: "preview",
      view: view(),
      logTail: await stub.logTail(),
    };
  },
  subscribe(callback: (view: PeerView) => void): () => void {
    listeners.add(callback);
    ensureTicking();
    return () => listeners.delete(callback);
  },
  chat(_id: string, _messages: readonly { role: string; content: string }[], handlers: ChatHandlers): () => void {
    let stopped = false;
    (async () => {
      await wait(700);
      if (stopped) return;
      if (script() === "lonely") {
        handlers.onError(503, "Not enough peers are online to answer yet. Part of the model has nobody serving it.");
        return;
      }
      for (const word of REPLY.split(" ")) {
        if (stopped) return;
        handlers.onDelta(word + " ");
        await wait(45);
      }
      if (!stopped) handlers.onDone();
    })();
    return () => {
      stopped = true;
    };
  },
};
