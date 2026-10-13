import { useEffect, useRef } from "react";

/**
 * Three dots that find each other, let go, and find each other again.
 *
 * This is what the app shows while the network has the question. It replaced a
 * row of pulsing dots that sat at the end of the waiting sentence — the same
 * three marks, but drawn rather than set in type, and about the thing that is
 * actually happening: the dots are machines, and the lines are the question
 * going out to one of them. It is drawn with the same pencil as the settings
 * globe, so the app has one hand rather than two.
 *
 * A canvas rather than SVG because the wobble is re-rolled every seventh of a
 * second, seeded from each dot's identity and the tick, so the line shakes like
 * a pencil while the dot it is drawn on stays exactly where it is. The jitter is
 * derived and not stored, which is the whole trick: a dot that wandered between
 * frames would shimmer instead of drift.
 *
 * `aria-hidden`: none of this is information. The sentence beneath it says what
 * is happening, and a reader is owed that sentence, not a description of a
 * drawing.
 *
 * It draws in `currentColor`, so it takes the ink of the line it belongs to —
 * which is the quiet ink, because nothing has been said yet. It has no colour of
 * its own.
 */

/** Points this far from every edge, so a dot is never clipped by the canvas and
 *  the mark never looks like it is running into the wall behind it. */
const PAD = 11;

/** The three machines. */
const DOTS = 3;

/** The pencil. Each pair of dots connects and disconnects on its own slow
 *  cycle: `[from, to, phase, rate]`, with the rate in radians per second — so
 *  these run at roughly six, five and a half, and seven seconds, and the three
 *  lines are never in step. `0` and `1` are the first pair to touch; the pairing
 *  that leaves the mark a triangle at its fullest is `0–1`, `1–2`, `0–2`. */
const PAIRS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 0, 1],
  [1, 2, 2.1, 1.15],
  [0, 2, 4, 0.85],
];

/** How fast a dot drifts, in CSS pixels per second: `5 + rnd * 5`, so the three
 *  do not travel at one speed and the mark has no visible period. */
const DRIFT_MIN = 5;
const DRIFT_SPAN = 5;

type Dot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius of the drawn disc. */
  r: number;
  /** Offset of the second, smaller disc — the two together are what make a dot
   *  read as inked rather than plotted. */
  ox: number;
  oy: number;
  /** Stable identity, so this dot's jitter and this dot's line-wobble are its
   *  own and do not become the frame's. */
  id: number;
};

/**
 * A small deterministic PRNG. `Math.random` cannot be used for the per-frame
 * jitter because the value has to be the *same* on every redraw of a given tick
 * — otherwise the wobble would be white noise instead of a line that holds
 * still and shakes. Seeded from a dot's identity, it gives that dot a consistent
 * shake; seeded from the tick as well, it advances.
 *
 * Mulberry32 — small, fast, and good enough for a line two pixels thick.
 */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How connected a pair is right now, as a smooth 0 → 1.
 *
 * A sine would spend most of its time in the middle and the line would almost
 * always be half-drawn, which reads as a permanent smear. Clamping the sine to
 * its top 90% and smoothing the ends means the line is fully there, or fully
 * gone, and the change between is one gesture rather than a fade.
 */
function connected(phase: number, rate: number, time: number): number {
  const v = Math.sin(time * rate + phase);
  const x = Math.max(0, Math.min(1, v / 0.9));
  return x * x * (3 - 2 * x);
}

export default function ThinkingMark() {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const reduce =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let W = 0;
    let H = 0;
    let raf = 0;
    let stopped = false;
    let tick = -1;
    let clock = 0;
    let last = performance.now();
    let color = getComputedStyle(cv).color;

    const nodes: Dot[] = [];

    // Seeded once, so the three dots take up the same three positions for the
    // whole of the wait. A mark that re-rolled its own layout every frame would
    // shiver rather than drift.
    const rnd = mulberry(Math.floor(Math.random() * 1e6));

    function measure() {
      const box = cv!.getBoundingClientRect();
      W = box.width;
      H = box.height;
      // Capped at 2. A 5K panel would otherwise ask for four times the pixels of
      // a mark forty-eight pixels tall, for no one's benefit.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv!.width = Math.round(W * dpr);
      cv!.height = Math.round(H * dpr);
      // Re-set after the resize above, which resets the backing store and with it
      // every transform on this context.
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function place() {
      nodes.length = 0;
      for (let i = 0; i < DOTS; i++) {
        const angle = rnd() * 6.2832;
        const speed = DRIFT_MIN + rnd() * DRIFT_SPAN;
        nodes.push({
          x: PAD + rnd() * (W - 2 * PAD),
          y: PAD + rnd() * (H - 2 * PAD),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          r: 4.2 + rnd() * 1.2,
          ox: (rnd() - 0.5) * 1.6,
          oy: (rnd() - 0.5) * 1.6,
          id: Math.floor(rnd() * 1e6),
        });
      }
    }

    /**
     * One line, walked in short segments with each vertex nudged by `wob`.
     *
     * Drawn as a path rather than as a straight stroke because a straight stroke
     * is a graphic and this has to be a pencil. The `rng` is passed in so the two
     * passes over one line shake differently — one line with one wobble reads as
     * a curve, two read as drawn.
     */
    function pencil(
      ax: number,
      ay: number,
      bx: number,
      by: number,
      progress: number,
      rng: () => number,
      lineWidth: number,
      alpha: number,
      wob: number,
    ) {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const steps = Math.max(4, Math.round(len / 5));
      // Grown from the first dot outwards, so a pair that is connecting is drawn
      // travelling and not fading in.
      const upto = Math.max(1, Math.round(steps * progress));

      ctx!.lineWidth = lineWidth;
      ctx!.globalAlpha = alpha;
      ctx!.beginPath();
      for (let i = 0; i <= upto; i++) {
        const t = i / steps;
        const px = ax + dx * t + (rng() - 0.5) * wob;
        const py = ay + dy * t + (rng() - 0.5) * wob;
        if (i === 0) ctx!.moveTo(px, py);
        else ctx!.lineTo(px, py);
      }
      ctx!.stroke();
    }

    function paint(dt: number) {
      if (dt > 0) {
        for (const n of nodes) {
          n.x += n.vx * dt;
          n.y += n.vy * dt;
          // Bounced off the padding rather than wrapped, so a dot that reaches an
          // edge turns around in front of the viewer instead of vanishing.
          if (n.x < PAD) {
            n.x = PAD;
            n.vx = Math.abs(n.vx);
          } else if (n.x > W - PAD) {
            n.x = W - PAD;
            n.vx = -Math.abs(n.vx);
          }
          if (n.y < PAD) {
            n.y = PAD;
            n.vy = Math.abs(n.vy);
          } else if (n.y > H - PAD) {
            n.y = H - PAD;
            n.vy = -Math.abs(n.vy);
          }
        }
      }

      ctx!.clearRect(0, 0, W, H);
      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      ctx!.strokeStyle = color;
      ctx!.fillStyle = color;

      for (const [from, to, phase, rate] of PAIRS) {
        const amount = connected(phase, rate, clock);
        if (amount <= 0.02) continue;
        const a = nodes[from];
        const b = nodes[to];
        pencil(
          a.x, a.y, b.x, b.y, amount,
          mulberry(a.id * 31 + b.id + tick * 131),
          2.2, 1, 1.6,
        );
        pencil(
          a.x, a.y, b.x, b.y, amount,
          mulberry(a.id * 17 + b.id * 3 + tick * 211),
          1.2, 0.65, 2.2,
        );
      }

      // The dots last, over the lines. A dot is a filled disc with a smaller disc
      // set off-centre inside it, both from the same path so they never show a
      // seam — the same two-mark trick the globe's dots use.
      for (const n of nodes) {
        const rg = mulberry(n.id + tick * 53);
        const jx = (rg() - 0.5) * 0.8;
        const jy = (rg() - 0.5) * 0.8;
        ctx!.globalAlpha = 1;
        ctx!.beginPath();
        ctx!.arc(n.x + jx, n.y + jy, n.r, 0, 6.2832);
        ctx!.moveTo(n.x + n.ox + n.r * 0.7, n.y + n.oy);
        ctx!.arc(n.x + n.ox, n.y + n.oy, n.r * 0.7, 0, 6.2832);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    measure();
    place();
    // The mark's size is fixed in CSS, so `W` and `H` are already final here.

    if (reduce) {
      // One frame, held — the same thing the settings globe does with this
      // preference. Re-drawing a still image twice a second would be motion in
      // everything but appearance.
      paint(0);
    } else {
      const frame = (now: number) => {
        if (stopped) return;
        // Capped, so a frame lost to a stalled webview does not teleport every
        // dot across the canvas when it comes back.
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        clock += dt;

        // The wobble advances about seven times a second while the motion runs at
        // the display's rate: the pencil is steadier than the dots, which is what
        // a hand does. Re-reading the colour here rather than per frame keeps a
        // `getComputedStyle` off the hot path.
        const t = Math.floor(now / 150);
        if (t !== tick) {
          tick = t;
          color = getComputedStyle(cv).color;
        }

        paint(dt);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    // Nothing about the mark's box changes when the window resizes — it is fifty
    // six by forty eight whatever else happens — but dragging to a display with a
    // different pixel ratio changes what that means in device pixels, and this is
    // the only place that is noticed.
    const onResize = () => {
      measure();
      if (reduce) paint(0);
    };
    window.addEventListener("resize", onResize);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={canvas} className="thinking__mark" aria-hidden="true" />;
}
