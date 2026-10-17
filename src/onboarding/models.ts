import type { HardwareReport, ModelSpec, Tier } from "./service";

/**
 * The model ladder.
 *
 * This is interface data, not service data: the only numbers in here that the
 * flow needs before a download starts are the sizes, and those are estimates
 * good enough for the disk check and for telling the user what they are about
 * to spend. The authoritative figure is whatever the download reports.
 *
 * ── What the ladder is now ───────────────────────────────────────────────────────
 *
 * One family at four sizes, and no lanes. The network used to carry a specialist
 * per lane — a math model, a coding model, a writing model — so this file was a
 * table of three columns and the flow asked the user which lane they were for.
 * The catalogue is now prism-ml's Ternary Bonsai 2 family: a single general
 * line, quantised to 1.58-bit ternary weights and packed as Q2_0, sized so that
 * every realistic donor machine holds a node. The 2B is the floor, the 4B the
 * default mid-tier, the 9B the ceiling.
 *
 * That leaves the ladder with one axis, which is memory. The lane screen went
 * with the lanes: with one family, every lane would have resolved to the same
 * weights, and a control that changes nothing is worse than no control. The
 * sentence that screen carried — what this machine will run — is now the whole
 * of what it says.
 */

/** Gigabytes as they are printed on the box — decimal, 10⁹. The whole interface
 *  is bytes; this exists so the catalogue can be written the way a person reads
 *  a model card, and so there is exactly one place the two units meet. */
export function gb(n: number): number {
  return Math.round(n * 1e9);
}

/** The four rungs, smallest first. Every loop over the ladder reads this rather
 *  than restating the order, so "step down to the next smaller one" cannot drift
 *  from "the order they are listed in". */
export const TIERS: readonly Tier[] = ["2b", "4b", "8b", "9b"];

/**
 * The four, at the ids the catalogue files them under.
 *
 * The ids are the network's and not this app's: `spawnJoin` sends one of these
 * straight to `common join --model`, which looks it up in the catalogue to find
 * the weights. An id that is not in the catalogue is not an error there — it is
 * read as an Ollama registry tag instead, which is how a retired id would quietly
 * provision the wrong model. These four are the catalogue's own, read out of
 * `catalogue/catalogue.seed.yaml` on `main`.
 *
 * `bytes` is the real `Content-Length` of the pinned file on Hugging Face, read
 * on 2026-10-17, and it is here rather than derived from the parameter count
 * because the two disagree by enough to matter to a disk check: the 9B is 9.0B
 * parameters in 2.56 GB, which is the ternary packing and not a rounding error.
 * The catalogue's own prose rounds these to 0.5, 1.2 and 2.4 GB.
 */
const LADDER: Record<Tier, ModelSpec> = {
  "2b": {
    id: "bonsai2-2b",
    label: "Bonsai 2 2B",
    tier: "2b",
    bytes: gb(0.55),
  },
  "4b": {
    id: "bonsai2-4b",
    label: "Bonsai 2 4B",
    tier: "4b",
    bytes: gb(1.21),
  },
  "8b": {
    id: "bonsai-8b",
    label: "Bonsai 8B",
    tier: "8b",
    bytes: gb(2.31),
  },
  "9b": {
    id: "bonsai2-9b",
    label: "Bonsai 2 9B",
    tier: "9b",
    bytes: gb(2.56),
  },
};

export const MODEL_LADDER: Readonly<Record<Tier, ModelSpec>> = LADDER;

export function modelFor(tier: Tier): ModelSpec {
  return MODEL_LADDER[tier];
}

export function findModel(id: string): ModelSpec | null {
  for (const tier of TIERS) {
    const model = MODEL_LADDER[tier];
    if (model.id === id) return model;
  }
  return null;
}

/* -------------------------------- requirements -------------------------------- */

/**
 * What the catalogue asks of a machine before it will hand it these weights.
 *
 * The network's own three gates — `min_ram_gb`, `needs_gpu`, `min_vram_gb` — and
 * not this app's opinion of them. They are what `common join` fits a machine
 * against and what the gateway's `/assign` gates on, so a rung this app
 * recommends is a rung the network would also have given this machine. Anything
 * invented here would be a second, quieter policy that disagrees with the one
 * the machine is about to be held to.
 */
export interface ModelRequirement {
  /** The catalogue's `min_ram_gb`, in decimal GB as a model card is written —
   *  the same unit `gb()` and `tierFor` are in. This is a floor for the whole
   *  machine's memory, not a figure for the weights alone: the 9B's file is
   *  2.56 GB and the catalogue asks for 5 GB, because the weights sit alongside a
   *  KV cache and a runtime with its own opinion about how much room to leave. */
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
 * The ladder's four, as the network's catalogue spells them.
 *
 * Read out of the live catalogue, the same way `ladderRequirements` in
 * `service.real.ts` reads them, and kept for the same reason: the fit has to be
 * decidable before the gateway can be reached, and a `min_ram_gb` that moved in
 * the catalogue is a fit that moved with it. `service.real.ts` asks the catalogue
 * first and falls back to this table.
 *
 * Two of these are a real floor and two are nearly free: 5 GB for the 9B and 4 GB
 * for the 8B, which is where the ladder bites, against 3 GB and 2 GB for the two
 * smaller ones that almost any machine clears. That is the opposite shape to the
 * ladder this replaces, where the top of it was reachable only from about 12.5 GB
 * up — at these figures a machine with 8 GB of memory carries the ceiling.
 */
export const LADDER_REQUIREMENTS: Requirements = {
  "bonsai2-2b": { minRamGb: 2, needsGpu: false, minVramGb: 0 },
  "bonsai2-4b": { minRamGb: 3, needsGpu: false, minVramGb: 0 },
  "bonsai-8b": { minRamGb: 4, needsGpu: false, minVramGb: 0 },
  "bonsai2-9b": { minRamGb: 5, needsGpu: false, minVramGb: 0 },
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
 * The largest one the catalogue's floors allow at the catalogue's headroom, and
 * the smallest rung when even that does not clear — because this ladder has a
 * bottom, unlike the specialist one it replaces. A machine with less than 2.5 GB
 * of memory is a machine no catalogued model fits, and the honest answer there is
 * the 2B with `fits` false rather than no answer at all.
 *
 * This reads the table above and not the live catalogue, deliberately: the tier is
 * a fact about the machine and has to be available to a screen that has not
 * reached the network yet. `fitsHere` is where the network's own figures are
 * applied, and the gap between the two is what `suggestModel` exists to close.
 */
export function tierFor(totalMemoryBytes: number): Tier {
  let best: Tier = TIERS[0];
  for (const tier of TIERS) {
    const need = LADDER_REQUIREMENTS[modelFor(tier).id];
    if (need !== undefined && totalMemoryBytes * HEADROOM >= gb(need.minRamGb)) best = tier;
  }
  return best;
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
 * The third parameter is how the live catalogue's figures reach this test. It is
 * optional so that a caller with no catalogue — the browser stub, a test — still
 * compiles and still answers from the table.
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
  // No memory figure cannot be shown to clear a floor of 2 GB or more, so it does
  // not clear one. Unreachable from the model screen — `suggestModel` refuses to
  // run at all without this — and the conservative answer for anyone else.
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

/**
 * The biggest rung this machine carries comfortably, or `null` when it carries
 * none.
 *
 * Stepping down rather than computing a bound, because `fitsHere` is the one place
 * that decides what "fits" means and a second copy of that arithmetic here would
 * be a second answer. The rungs are in ascending order of what they ask — 2, 3, 4,
 * 5 GB — so the first one from the top that fits is also the largest that does.
 * `null` is the honest answer to "no model in this ladder fits", and returning it
 * rather than the floor is the point of the signature: the caller gets to tell
 * "the smallest one, at a squeeze" apart from "the biggest one that is
 * comfortable", and those are two different sentences on screen.
 */
export function largestFitting(
  hardware: HardwareReport,
  requirements: Requirements = LADDER_REQUIREMENTS,
): Tier | null {
  for (const tier of [...TIERS].reverse()) {
    if (fitsHere(modelFor(tier).id, hardware, requirements)) return tier;
  }
  return null;
}
