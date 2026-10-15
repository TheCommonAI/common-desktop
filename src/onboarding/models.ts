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

/* -------------------------------- requirements -------------------------------- */

/**
 * What the catalogue asks of a machine before it will hand it these weights.
 *
 * The network's own three gates — `min_ram_gb`, `needs_gpu`, `min_vram_gb` — and
 * not this app's opinion of them. They are what `common join` fits a machine
 * against and what the gateway's `/assign` gates on, so a lane this app
 * recommends is a lane the network would also have given this machine. Anything
 * invented here would be a second, quieter policy that disagrees with the one
 * the machine is about to be held to.
 */
export interface ModelRequirement {
  /** The catalogue's `min_ram_gb`, in decimal GB as a model card is written —
   *  the same unit `gb()` and `tierFor` are in. This is a floor for the whole
   *  machine's memory, not a figure for the weights alone. */
  minRamGb: number;
  /** The catalogue's `needs_gpu`. Carried because the catalogue carries it, and
   *  read by nothing: see `fitsHere` for why this report cannot refuse a model
   *  over it. No model in this ladder asks for a GPU. */
  needsGpu: boolean;
  /** The catalogue's `min_vram_gb`. 0 means the catalogue asks for no graphics
   *  memory — the case for every model here. */
  minVramGb: number;
}

/** A set of requirements by model id, so a caller can pass the live catalogue's
 *  answer where it has one and let the table below stand where it does not. */
export type Requirements = Readonly<Record<string, ModelRequirement>>;

/**
 * The ladder's six, as the network's catalogue spells them.
 *
 * Read out of the live catalogue, the same way `LADDER_TAGS` in
 * `service.real.ts` reads the tags out of it, and kept for the same reason: the
 * fit has to be decidable before the gateway can be reached, and a `min_ram_gb`
 * that moved in the catalogue is a fit that moved with it. `service.real.ts`
 * asks the catalogue first and falls back to this table.
 *
 * `min_ram_gb` is the ladder's real shape, and it is not the 16 GB the app used
 * to demand: 10 GB for the two 7B–8B models at the top, 8 GB for Coder 7B, 4 GB
 * for Llama 3.2 3B and 3 GB for the two 1.5B models. The top of the ladder is
 * reachable on a 16 GB machine and, with the headroom `fitsHere` applies, on
 * anything from about 12.5 GB up.
 */
export const LADDER_REQUIREMENTS: Requirements = {
  "qwen2.5-math-7b": { minRamGb: 10, needsGpu: false, minVramGb: 0 },
  "qwen2.5-math-1.5b": { minRamGb: 3, needsGpu: false, minVramGb: 0 },
  "qwen2.5-coder-7b": { minRamGb: 8, needsGpu: false, minVramGb: 0 },
  "qwen2.5-coder-1.5b": { minRamGb: 3, needsGpu: false, minVramGb: 0 },
  "qwen3-8b": { minRamGb: 10, needsGpu: false, minVramGb: 0 },
  "llama3.2-3b": { minRamGb: 4, needsGpu: false, minVramGb: 0 },
};

/** What the catalogue asks for one model: the caller's answer when it has one,
 *  the table when it does not, and `null` for an id neither knows. */
export function requirementFor(
  modelId: string,
  requirements: Requirements = LADDER_REQUIREMENTS,
): ModelRequirement | null {
  return requirements[modelId] ?? LADDER_REQUIREMENTS[modelId] ?? null;
}

/**
 * How much of the machine's memory a model may claim.
 *
 * 0.8, and the figure is not this app's: `common join` gates on
 * `min_ram_gb <= memory * 0.8`, the gateway's `/assign` reads the same
 * `assignment_ram_headroom`, and the catalogue's own header gives the reason —
 * a tight model that swaps and times out is worth less to the network than a
 * smaller one that answers. Measuring *free* memory against it is what the CLI
 * calls its `fits_if_freed` rule; this app measures *total*, because the scan
 * does not read free memory, so a model is only refused here when closing
 * everything would not have saved it.
 */
const HEADROOM = 0.8;

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
 * The catalogue's terms, not this app's: a model fits when the machine can show
 * it meets each demand the catalogue makes of it, at the catalogue's figures and
 * at the catalogue's headroom. There is no 16 GB floor written here and no 4 GB
 * of graphics memory either, because the catalogue asks for neither — and that
 * is the whole of the fix. The old test asked for both unconditionally, so on
 * Windows, where the platform will not report graphics memory at all, every full
 * model failed and the recommendation sat on Math for every machine alike.
 *
 * Two rules keep the answer honest:
 *
 * — **A demand the catalogue does not make cannot be failed.** Every model here
 *   asks for no graphics memory (`minVramGb: 0`) and none for a GPU
 *   (`needsGpu: false`), so `fitsHere` can refuse nothing over graphics memory.
 *   The fields are still read in that order for the day a catalogued model asks
 *   for some, and `needsGpu` is carried and not read because this report cannot
 *   express the answer: `graphics: null` is a read that failed and says nothing
 *   about whether a card is present, so refusing over it would be inventing a
 *   fact. The Rust side is where a GPU's absence is known, not here.
 *
 * — **Unreadable is unknown, never zero.** `vramBytes: null` means the platform
 *   would not say how much graphics memory the card has, which is the ordinary
 *   case on Windows — the figure it does offer saturates just under 4 GiB, so
 *   `src-tauri/src/backend.rs` declines to guess at it — and on Apple silicon,
 *   where that memory is the machine's own and is already counted above. Reading
 *   it as 0 turned "I don't know" into "4 GB short" and is what made the app
 *   pick Math everywhere.
 *
 * It remains deliberately stricter than `tierFor`, and the gap between the two
 * is the point: the tier is what the machine *can* run and `fits` is what it can
 * run comfortably, so a 9.5 GB machine is on the full rung while none of the
 * full models fit it — the case the lane screen's caption describes as "will be
 * slow here, that's allowed", and the case `bestLaneFor` has to answer without
 * pretending a lane fits.
 *
 * The third parameter is how the live catalogue's figures reach this test. It
 * is optional so that a caller with no catalogue — the browser stub, a test —
 * still compiles and still answers from the table.
 */
export function fitsHere(
  modelId: string,
  hardware: HardwareReport,
  requirements: Requirements = LADDER_REQUIREMENTS,
): boolean {
  // An id this ladder does not carry has no requirement to fail, and neither has
  // a requirement nobody knows. Only ladder ids reach here.
  if (findModel(modelId) === null) return true;
  const need = requirementFor(modelId, requirements);
  if (need === null) return true;

  // The catalogue's memory floor, at the catalogue's headroom. Both sides are
  // decimal GB, which is the one place `gb()` exists for.
  const memory = hardware.memory?.totalBytes;
  // No memory figure cannot be shown to clear a floor of 3 GB or more, so it
  // does not clear one. Unreachable from the lane screen — `suggestLane` refuses
  // to run at all without this — and the conservative answer for anyone else.
  if (memory === undefined) return false;
  if (memory * HEADROOM < gb(need.minRamGb)) return false;

  const graphics = hardware.graphics;
  // A graphics read that failed, or memory that is the machine's own, is not
  // something to be short of: in the second case the floor above has already
  // counted this memory once, which is the only time it should be counted.
  if (graphics === null || graphics.unified) return true;
  if (need.minVramGb === 0) return true;
  const vram = graphics.vramBytes;
  // Unreadable, not zero: see the header.
  if (vram === null) return true;
  return vram >= gb(need.minVramGb);
}
