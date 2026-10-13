import { invoke } from "@tauri-apps/api/core";

/**
 * Where this machine is, for the single dot on the settings globe.
 *
 * A place, not a position. The lookup resolves to a city, and it is stored as
 * one number per axis with no precision to spare — the globe draws it as a
 * twelve-pixel glow on a sphere the size of a thumbnail, so a hundred metres and
 * a hundred kilometres are the same dot. Asking for more would be collecting
 * something we have no use for.
 *
 * The cost of finding out is a request to a third party that learns this
 * machine's address, which is very nearly the answer it gives back. That is why
 * the answer is kept: `findPlace` is the only thing here that goes to the
 * network, it is asked once, and every open after that reads from the cache and
 * touches nothing.
 */

export interface Place {
  lat: number;
  lon: number;
  /** "Adelaide, Australia". Nothing draws it; it exists so that a surprising
   *  dot can be explained without going back to the network to ask why. */
  label: string;
}

/** Where the answer is kept between runs, under the same `common.` prefix as the
 *  rest of this app's storage. */
const KEY = "common.place";

/**
 * Narrow the stored or returned value, rather than trusting it.
 *
 * Both callers hand over something that came from outside this process — one
 * from `localStorage`, one from a command that parsed JSON off the wire — and a
 * `NaN` latitude is not a place. A missing marker leaves the globe plain, which
 * is a fine thing for it to be; a marker at `NaN` would blank the canvas.
 */
function asPlace(value: unknown): Place | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lon, label } = value as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, label: typeof label === "string" ? label : "" };
}

/**
 * The place already known, if any — synchronously, so the globe can draw its
 * dot into the very first frame rather than have one appear a moment later on a
 * sphere the user is watching turn.
 *
 * `localStorage` throws rather than returns when storage is unavailable or full,
 * and a globe without a dot is not worth an exception, so this fails soft.
 */
export function readPlace(): Place | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : asPlace(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Ask, and remember. Fails to `null` and not to an error.
 *
 * Offline, no `curl`, a service with no record of this address, a card closed
 * before the answer lands — all of these end the same way, with a globe that has
 * no dot on it. That is the right failure for a decoration. A dot at a guessed
 * position would be worse than no dot, because the one place a user is most
 * inclined to believe a lie is a map of themselves.
 *
 * Outside the app there is no `invoke` and this returns the cache or nothing.
 * The preview draws what is in storage, which is also how a seeded place gets in
 * front of a screenshot.
 */
export async function findPlace(): Promise<Place | null> {
  const known = readPlace();
  if (known !== null) return known;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;

  try {
    const answer = asPlace(await invoke<unknown>("where_am_i"));
    if (answer === null) return null;
    window.localStorage.setItem(KEY, JSON.stringify(answer));
    return answer;
  } catch {
    return null;
  }
}
