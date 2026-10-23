/**
 * How a number becomes a word.
 *
 * Captions in this flow are uppercase fragments, so every one of these returns
 * something that survives being shouted: no full stops, no trailing unit
 * repeated, no four significant figures. A caption that reads
 * `2.24 OF 4.20 GB` is a caption nobody reads.
 *
 * Sizes are decimal — 10⁹ to the gigabyte — because that is how a download
 * reports a file and how a disk is sold, and because the service speaks bytes
 * and something has to decide. One decision, here.
 */

interface Scaled {
  value: number;
  /** What to divide any other byte count by to speak in this unit. */
  divisor: number;
  unit: string;
  digits: number;
}

function scale(bytes: number): Scaled {
  if (bytes >= 1e9) return { value: bytes / 1e9, divisor: 1e9, unit: "GB", digits: 1 };
  if (bytes >= 1e6) return { value: bytes / 1e6, divisor: 1e6, unit: "MB", digits: 0 };
  return { value: bytes / 1e3, divisor: 1e3, unit: "KB", digits: 0 };
}

/** "118 GB", not "118.0 GB" — a trailing zero is a digit the reader has to
 *  decide to ignore. */
function trim(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

export function formatBytes(bytes: number): string {
  const s = scale(bytes);
  return `${trim(s.value, s.digits)} ${s.unit}`;
}

/** "2.2 of 4.2 GB" — the unit is stated once, at the end, because repeating it
 *  is noise in a caption with no room for noise. */
export function formatTransfer(receivedBytes: number, totalBytes: number): string {
  const total = scale(totalBytes);
  return `${trim(receivedBytes / total.divisor, total.digits)} of ${trim(total.value, total.digits)} ${total.unit}`;
}

/** "22:00" → "10pm", "07:30" → "7:30am". Local wall clock, as the user set it. */
export function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  const hours = Number(h);
  const minutes = Number(m);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return hhmm;
  const suffix = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? `${twelve}${suffix}` : `${twelve}:${String(minutes).padStart(2, "0")}${suffix}`;
}

/** "1.4 s" — the model's answer time, which is the point of showing it. */
export function formatLatency(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/** The same clauses as one line of text. The stylesheet draws the middots
 *  between caption parts so that nothing extra lands in the accessible name,
 *  but the gauge and a reader both need the line as a string, and one place
 *  that knows the separator is better than several that guess it. */
export function captionText(...parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string").join(" · ");
}
