import type { HardwareReport, Lane, ModelSpec, Tier } from "./service";

/**
 * The model ladder.
 *
 * This is interface data, not service data: the only numbers in here that the
 * flow needs before a download starts are the sizes, and those are estimates
 * good enough for the disk check and for telling the user what they are about
 * to spend. The authoritative figure is whatever the download reports.
 */

/** Gigabytes as they are printed on the box — decimal, 10⁹. The whole interface
 *  is bytes; this exists so the catalogue can be written the way a person reads
 *  a model card, and so there is exactly one place the two units meet. */
export function gb(n: number): number {
  return Math.round(n * 1e9);
}

/** The three lanes in the order the interface lists them. */
export const LANES: readonly Lane[] = ["math", "code", "writing"];

/** The lane's name as it appears mid-sentence: "You're live in the Math lane." */
export const LANE_LABEL: Record<Lane, string> = {
  math: "Math",
  code: "Code",
  writing: "Writing",
};

const FULL: Record<Lane, ModelSpec> = {
  math: {
    id: "qwen2.5-math-7b",
    label: "Qwen2.5 Math 7B",
    lane: "math",
    tier: "full",
    bytes: gb(4.4),
  },
  code: {
    id: "qwen2.5-coder-7b",
    label: "Qwen2.5 Coder 7B",
    lane: "code",
    tier: "full",
    bytes: gb(4.2),
  },
  writing: {
    id: "qwen3-8b",
    label: "Qwen3 8B",
    lane: "writing",
    tier: "full",
    bytes: gb(5.2),
  },
};

const LIGHT: Record<Lane, ModelSpec> = {
  math: {
    id: "qwen2.5-math-1.5b",
    label: "Qwen2.5 Math 1.5B",
    lane: "math",
    tier: "light",
    bytes: gb(1.1),
  },
  code: {
    id: "qwen2.5-coder-1.5b",
    label: "Qwen2.5 Coder 1.5B",
    lane: "code",
    tier: "light",
    bytes: gb(1.1),
  },
  writing: {
    id: "llama3.2-3b",
    label: "Llama 3.2 3B",
    lane: "writing",
    tier: "light",
    bytes: gb(2.0),
  },
};

export const MODEL_CATALOG: Readonly<Record<Tier, Readonly<Record<Lane, ModelSpec>>>> = {
  full: FULL,
  light: LIGHT,
};

export function modelFor(lane: Lane, tier: Tier): ModelSpec {
  return MODEL_CATALOG[tier][lane];
}

export function findModel(id: string): ModelSpec | null {
  for (const tier of ["full", "light"] as const) {
    for (const lane of LANES) {
      const model = MODEL_CATALOG[tier][lane];
      if (model.id === id) return model;
    }
  }
  return null;
}

/**
 * The rung of the ladder this much memory gets.
 *
 * Only the low end changes the answer. At 8 GB or below the machine takes the
 * light models; everything above takes the full ones — a 7B model at four bits
 * fits comfortably in 12 GB — and where the memory is tight for them the lane
 * screen says so plainly rather than quietly downgrading the user's choice.
 * The threshold carries about 12% of tolerance because 8 GB is reported both as
 * 8×10⁹ and as 8 GiB depending on the reader.
 */
export function tierFor(totalMemoryBytes: number): Tier {
  return totalMemoryBytes <= gb(9) ? "light" : "full";
}

/**
 * Whether this machine carries the model with headroom.
 *
 * A policy about what counts as carrying something, not a size comparison. The
 * light rung always fits; the full rung wants 16 GB of memory and, on a machine
 * whose graphics memory is its own, 4 GB of it.
 *
 * It is deliberately stricter than `tierFor`, and the gap between the two is the
 * point: the tier is what the machine *can* run and `fits` is what it can run
 * comfortably, so a 12 GB machine is on the full rung with models that do not
 * fit it. That is the case the lane screen's third caption branch describes —
 * the network wants the full model, this machine would run it badly, so the
 * recommendation falls back to the machine's own better lane.
 */
export function fitsHere(modelId: string, hardware: HardwareReport): boolean {
  const model = findModel(modelId);
  if (!model || model.tier === "light") return true;
  if ((hardware.memory?.totalBytes ?? 0) < gb(16)) return false;
  const graphics = hardware.graphics;
  if (graphics && !graphics.unified) return (graphics.vramBytes ?? 0) >= gb(4);
  return true;
}
