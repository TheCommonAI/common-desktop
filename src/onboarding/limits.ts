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

/** The hour the quiet window ends, if `now` is inside it — `null` when it is not.
 *
 *  `end` earlier than `start` means the window crosses midnight, which the
 *  contract calls the normal case, and reading it as two windows would leave the
 *  evening half uncovered and the morning half missing. So the comparison is one
 *  of two, chosen by which way round the ends are.
 *
 *  A window whose ends are equal covers nothing. It is a window of zero minutes,
 *  and the other reading — "always quiet" — would turn a pair of times the user
 *  dragged onto each other into a machine that never serves again, silently, with
 *  the setting still on screen looking like a schedule.
 *
 *  Local wall clock, because that is what the stored value is: the contract says
 *  "local wall-clock HH:MM", and quiet hours are a claim about the user's night
 *  rather than about UTC. `Date`'s own getters are already local, so this needs no
 *  timezone arithmetic — which is the point, since there is none here to get
 *  wrong.
 *
 *  Returns the *stored* end rather than a formatted one, so a sentence built from
 *  it shows the user the clock they set. */
export function quietUntil(quiet: ResourceLimits["quietHours"], now: Date): string | null {
  if (quiet === null) return null;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return null;
  const at = now.getHours() * 60 + now.getMinutes();
  const inside = start < end ? at >= start && at < end : at >= start || at < end;
  return inside ? quiet.end : null;
}

/** "HH:MM" as minutes past midnight, or `null` for anything that is not a time.
 *
 *  Bounded as well as shaped: `flow.readLimits` accepts `25:99`, which matches
 *  the pattern and is not a time, and a window built from it would compare
 *  against a minute count that cannot occur. `null` here means the window is not
 *  one this app can reason about, and `quietUntil` reads that as "no window"
 *  rather than as "quiet forever" — the failure that leaves a machine serving. */
function minutesOf(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
