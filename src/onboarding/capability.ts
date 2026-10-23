import type { HardwareReport } from "./service";

/**
 * Can this machine serve part of the model?
 *
 * The layer network runs on Apple silicon Macs (MLX) and on NVIDIA GPUs (NF4).
 * Anything else is refused by the command-line tool, so the app says so up front
 * rather than letting someone sit through a join that cannot end well.
 *
 * Memory is the other half: the smallest slice of the model needs a few GB free,
 * and the network will not hand a machine more than it can hold. The numbers are
 * the tool's own lower bounds, rounded so the sentence stays true if they move a
 * little.
 */

export type Capability =
  | { can: true; kind: "apple" | "nvidia"; how: string; offeredBytes: number }
  | { can: false; reason: "no-gpu" | "too-small" | "unknown"; why: string };

/** The least memory worth offering: below this a machine cannot hold even one stage. */
const MINIMUM = 4_000_000_000;
/** What the CLI offers on Apple silicon: well under all the memory, leaving room for the system. */
const APPLE_SHARE = 0.62;
/** What it leaves free on an NVIDIA card. */
const NVIDIA_RESERVE = 1_500_000_000;

export function capabilityOf(report: HardwareReport | null, memoryOverride: number | null): Capability {
  if (report === null) return { can: false, reason: "unknown", why: "I couldn't tell yet." };
  const total = memoryOverride ?? report.memory?.totalBytes ?? null;
  const graphics = report.graphics;
  const apple = report.os.platform === "macos" && (graphics?.vendor ?? "").toLowerCase().includes("apple");
  const nvidia = (graphics?.vendor ?? "").toLowerCase().includes("nvidia");

  if (apple) {
    if (total === null) return { can: false, reason: "unknown", why: "I couldn't read how much memory it has." };
    const offered = Math.round(total * APPLE_SHARE);
    if (offered < MINIMUM) return { can: false, reason: "too-small", why: "It has too little memory to hold a share of the model." };
    return { can: true, kind: "apple", how: "Apple silicon", offeredBytes: offered };
  }
  if (nvidia) {
    const vram = graphics?.vramBytes ?? null;
    if (vram === null) return { can: false, reason: "unknown", why: "I couldn't read how much memory the graphics card has." };
    const offered = Math.max(0, vram - NVIDIA_RESERVE);
    if (offered < MINIMUM) return { can: false, reason: "too-small", why: "The graphics card has too little memory to hold a share of the model." };
    return { can: true, kind: "nvidia", how: "an NVIDIA graphics card", offeredBytes: offered };
  }
  return {
    can: false,
    reason: "no-gpu",
    why: "The network needs an Apple silicon Mac or an NVIDIA graphics card, and I didn't find either.",
  };
}

/** Decimal gigabytes, the way the rest of the flow counts them. */
export function gb(n: number): number {
  return n * 1_000_000_000;
}
