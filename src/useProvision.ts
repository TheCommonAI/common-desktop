import { useEffect, useState } from "react";
import { provisionNow, watchProvision, type Provision } from "./provision";

/**
 * The React binding for the fetch. The decisions it draws are in `provision.ts`.
 *
 * Split from that file for the reason `useRejoin.ts` is split from `rejoin.ts`:
 * what a payload's absence means and what the wait says are the parts worth
 * testing, and a module with a hook in it cannot be loaded by
 * `tests/provision.test.mjs` without also mocking React. Nothing here decides
 * anything. It subscribes, and it holds one piece of state.
 *
 * It does not start the fetch. `App` starts it, and the ordering matters: this
 * hook is mounted by a screen that may come and go, while the fetch is the
 * machine's and outlives any screen the user walks away from.
 */
export function useProvision(): Provision {
  // The module's current value rather than `{ kind: "idle" }`, so a screen
  // mounted halfway through a transfer draws where the transfer actually is
  // instead of redrawing from the beginning.
  const [value, setValue] = useState<Provision>(provisionNow);
  useEffect(() => watchProvision(setValue), []);
  return value;
}
