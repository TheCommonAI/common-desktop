import type { ResourceLimits } from "./service";

/**
 * The vocabulary of resource limits, in one place.
 *
 * These tables started in the flow's step five and are now read in two places —
 * the flow, and the settings card that edits the same answers afterwards. Two
 * copies of "Most" would be two chances for the card to promise 75% while the
 * flow promised something else, and a settings screen that quietly disagrees
 * with the flow that set it is worse than no settings screen. So there is one
 * copy, and both read it.
 *
 * `CAP_CHOICES` is a table of names rather than a pair of sliders on purpose:
 * a percentage is a figure the user has to translate into a consequence, and
 * "Most" is the consequence. The numbers travel with the name so the caption can
 * disclose them, which is what makes the shorthand honest rather than vague.
 */

export const CONTRIBUTE_CHOICES = [
  { value: "always" as const, label: "Always" },
  { value: "plugged-in" as const, label: "Only when plugged in" },
  { value: "idle" as const, label: "Only when idle" },
];

export const CAP_CHOICES = [
  { value: "little" as const, label: "A little", cpuPercent: 25, gpuPercent: 20 },
  { value: "some" as const, label: "Some", cpuPercent: 50, gpuPercent: 40 },
  { value: "most" as const, label: "Most", cpuPercent: 75, gpuPercent: 60 },
];

export const QUIET_CHOICES = [
  { value: "yes" as const, label: "Yes" },
  { value: "no" as const, label: "No, run all night" },
];

export const DEFAULT_QUIET = { start: "22:00", end: "07:00" };

/** The named cap a stored pair of percentages corresponds to, or `null` for a
 *  pair that matches none of them — which a clamping implementation can
 *  legitimately return, and which the card must not pretend to have chosen. */
export function capChoiceOf(cap: ResourceLimits["cap"]): (typeof CAP_CHOICES)[number] | null {
  return (
    CAP_CHOICES.find(
      (choice) => choice.cpuPercent === cap.cpuPercent && choice.gpuPercent === cap.gpuPercent,
    ) ?? null
  );
}
