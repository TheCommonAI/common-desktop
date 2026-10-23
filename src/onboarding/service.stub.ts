import {
  OnboardingError,
  type HardwareReport,
  type OnboardingService,
  type ProgressOptions,
  type ResourceLimits,
  type ScanProgress,
  type Task,
} from "./service";

/**
 * A pretend machine, for a browser.
 *
 * A page opened in a browser has no Rust behind it, and that is how these screens
 * get reviewed. `?hardware=` picks the machine so each verdict can be looked at:
 *   (none)   an Apple silicon laptop with 16 GB
 *   small    the same, with 4 GB — too little to hold a share
 *   nvidia   a Windows PC with an 8 GB NVIDIA card
 *   none     a Linux machine with no supported GPU
 *   fail     a machine that refuses to be read
 */

type Machine = "apple" | "small" | "nvidia" | "none" | "fail";

function machine(): Machine {
  try {
    const wanted = new URLSearchParams(window.location.search).get("hardware");
    if (wanted === "small" || wanted === "nvidia" || wanted === "none" || wanted === "fail") return wanted;
  } catch {
    // The default machine.
  }
  return "apple";
}

const GB = 1_000_000_000;

function report(kind: Machine): HardwareReport {
  switch (kind) {
    case "small":
      return {
        memory: { totalBytes: 4 * GB },
        graphics: { vendor: "Apple", name: "Apple M1", vramBytes: null, unified: true },
        disk: { freeBytes: 60 * GB, totalBytes: 256 * GB, path: "/" },
        power: { source: "mains", batteryPercent: null },
        os: { platform: "macos", version: "15.0" },
      };
    case "nvidia":
      return {
        memory: { totalBytes: 32 * GB },
        graphics: { vendor: "NVIDIA", name: "NVIDIA GeForce RTX 4060", vramBytes: 8 * GB, unified: false },
        disk: { freeBytes: 410 * GB, totalBytes: 1000 * GB, path: "C:\\" },
        power: { source: "mains", batteryPercent: null },
        os: { platform: "windows", version: "11" },
      };
    case "none":
      return {
        memory: { totalBytes: 16 * GB },
        graphics: null,
        disk: { freeBytes: 200 * GB, totalBytes: 500 * GB, path: "/" },
        power: { source: "mains", batteryPercent: null },
        os: { platform: "linux", version: "6.8" },
      };
    default:
      return {
        memory: { totalBytes: 16 * GB },
        graphics: { vendor: "Apple", name: "Apple M3", vramBytes: null, unified: true },
        disk: { freeBytes: 92 * GB, totalBytes: 460 * GB, path: "/" },
        power: { source: "battery", batteryPercent: 81 },
        os: { platform: "macos", version: "15.0" },
      };
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function task<T>(work: (cancelled: () => boolean) => Promise<T>): Task<T> {
  let cancelled = false;
  let settled = false;
  let halt!: (error: OnboardingError) => void;
  const halted = new Promise<never>((_, reject) => {
    halt = reject;
  });
  const result = Promise.race([work(() => cancelled), halted]).finally(() => {
    settled = true;
  });
  return {
    result,
    cancel() {
      if (cancelled || settled) return;
      cancelled = true;
      halt(new OnboardingError("cancelled", "Stopped."));
    },
  };
}

function scanHardware(opts?: ProgressOptions<ScanProgress>): Task<HardwareReport> {
  return task(async (cancelled) => {
    const kind = machine();
    for (const field of ["memory", "graphics", "disk", "power"] as const) {
      if (cancelled()) throw new OnboardingError("cancelled", "Stopped.");
      opts?.onProgress?.({ field });
      await wait(260);
    }
    if (kind === "fail") {
      throw new OnboardingError("permission-denied", "The system refused that.", "preview: ?hardware=fail");
    }
    return report(kind);
  });
}

function setLimits(limits: ResourceLimits): Task<ResourceLimits> {
  return task(async () => ({ contribute: limits.contribute, quietHours: limits.quietHours }));
}

export function createStubService(): OnboardingService {
  return { scanHardware, setLimits };
}
