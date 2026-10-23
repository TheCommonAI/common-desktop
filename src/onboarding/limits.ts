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
 * There is no "how much" here. A peer in the layer network offers the slice of the
 * model that fits in its memory and either serves or does not, so there is nothing
 * to throttle and a percentage would be a promise nothing keeps. What the app can
 * truly hold itself to is *when*, because it decides whether the peer runs.
 */

export const CONTRIBUTE_CHOICES = [
  { value: "always" as const, label: "Always" },
  { value: "plugged-in" as const, label: "Only when plugged in" },
];

export const QUIET_CHOICES = [
  { value: "yes" as const, label: "Yes" },
  { value: "no" as const, label: "No, run all night" },
];

export const DEFAULT_QUIET = { start: "22:00", end: "07:00" };
