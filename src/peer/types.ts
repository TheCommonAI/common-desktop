/**
 * What the peer says about itself.
 *
 * The peer is the layer-network node this app runs (`common join --network --api`).
 * It writes a small JSON status file every couple of seconds and Rust hands that
 * file to the page, validated and with anything credential-shaped removed. These
 * are the fields of the contract; every one that can be absent in a given state is
 * optional, and the screens treat a missing field as "not known yet" and never as
 * a reason to claim a state.
 */

export type PeerState =
  | "starting"
  | "downloading"
  | "loading"
  | "up"
  | "moving"
  | "leaving"
  | "stopped"
  | "error";

export interface PeerEntry {
  peer: string;
  window: readonly [number, number] | null;
  backend: string;
  state: string;
  /** Seconds since this peer last announced itself. */
  age_s: number;
  /** This machine. */
  me: boolean;
}

export interface PeerStatus {
  v: 1;
  state: PeerState;
  network?: string;
  /** The model the network serves, by name. */
  model?: string;
  peer?: string;
  /** The layers this machine serves, `[from, to)`. */
  window?: readonly [number, number] | null;
  backend?: string;
  /** How much memory this machine offered, in GiB. */
  gib?: number;
  /** The address others can join through. */
  url?: string | null;
  download?: { bytes: number; total: number } | null;
  /** The network's stages, as layer ranges. */
  stages?: readonly (readonly [number, number])[];
  /** How many live peers cover each stage. */
  coverage?: readonly number[];
  peers?: readonly PeerEntry[];
  /** A sentence for the user, when `state` is `error`. */
  error?: string | null;
  /** The chat API on this machine, and whether the chat part has loaded. */
  api?: { port: number; ready: boolean } | null;
  pid?: number;
  ts?: number;
}

/** What Rust tells the page, on every tick and on request. */
export interface PeerView {
  /** The user has the peer switched on. */
  wantRunning: boolean;
  /** A process is alive that is, or is handing off to, our peer. */
  running: boolean;
  status: PeerStatus | null;
  /** The status stopped updating and its process is gone. */
  crashed: boolean;
  statusAge: number | null;
  restarts: number;
  lastExit: string | null;
  /** Why it cannot start, as a sentence for the user. */
  problem: string | null;
  logPath: string;
  statusPath: string;
}

export interface PeerDiagnostics {
  appVersion: string;
  cliPath: string;
  cliVersion: string | null;
  cliKnowsLayerNetwork: boolean | null;
  os: string;
  view: PeerView;
  logTail: string;
}

/** An event from a chat in flight. */
export type ChatEvent =
  | { id: string; kind: "delta"; text: string }
  | { id: string; kind: "finish"; reason: string }
  | { id: string; kind: "done" }
  | { id: string; kind: "error"; status: number; message: string };

export interface ChatHandlers {
  onDelta: (text: string) => void;
  /** The stream ended normally. */
  onDone: () => void;
  /** `status` is the HTTP status, `0` when nothing answered, 503 for "not enough
   *  peers yet". The message is already a sentence for the user. */
  onError: (status: number, message: string) => void;
}
