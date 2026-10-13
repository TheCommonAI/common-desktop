import { useEffect, useRef } from "react";

/**
 * A globe, drawn by hand.
 *
 * A Fibonacci sphere of dots — even over the whole surface by construction — with
 * the dots that land on a continent inked heavier than the ones that land on
 * water. The continents are therefore not drawn; they *emerge*, because the dot
 * field is denser where the world is. Over the top: a pencil graticule, a hatched
 * crescent where the light would not fall, and a rim sketched twice round in a
 * wobbly circle.
 *
 * Three things here are deliberate and would each be a bug if they were tidy:
 *
 * — **The lines boil.** The graticule, the hatching and the rim are re-seeded from
 *   a clock that steps a few times a second, so their wobble is redrawn rather
 *   than held. That is what a hand-drawn animation does, and it is the difference
 *   between this and a picture of a globe.
 *
 * — **The dots are nudged off the sphere.** Every dot is displaced a little and
 *   then pushed back onto the unit sphere, so no two sit on the same perfect
 *   lattice, and each takes its own radius, its own opacity and a small second
 *   mark laid over it. The marks are ellipses rotated to face outward from the
 *   centre, because a stroke drawn by hand shortens as it goes round the side.
 *
 * — **Reduced motion stops it dead.** Not slower — stopped, with the boiling
 *   frozen too, because a still frame that keeps flickering is not still.
 *
 * Colour comes from the stylesheet and only from the stylesheet: the ink is this
 * element's `color`, and the two quieter tones are the `--globe-*` opacities set
 * alongside it. Nothing here names a hex.
 */

export interface GlobeProps {
  /** CSS pixels. Square. The canvas is the rendered at this times the device pixel
   *  ratio so the drawing is crisp on a Retina display. */
  size: number;
  /** Whether to keep turning. A canvas animating behind a closed dialog is a fan
   *  spinning for nobody. */
  active: boolean;
  /** Where this machine is, as degrees, or null while it is unknown. Null is the
   *  common case and draws nothing: a marker at a guessed position would be a lie
   *  told in the one place the user is most inclined to believe it. */
  marker: { lat: number; lon: number } | null;
}

/** One revolution every ~18 s. A mood, but a live one. */
const TURN_RATE = 0.35;
/** The starting tilt, in radians. The Earth's own 23.4° is what stops a spinning
 *  sphere reading as a spinning disc. */
const TILT = 0.38;
/** Where the globe is looking when the card opens. A globe spends most of its time
 *  showing ocean — the Pacific is half the planet — so which meridian it starts on
 *  is the difference between a sphere with continents on it and a sphere with a few
 *  specks. This one puts the Atlantic at the centre: Africa to the left, South
 *  America low and right, Europe over the top. */
const BASE_YAW = -0.2;

/* ---------------------------------------------------------------- the world -- */
/* Rough continent outlines, as flat lon,lat pairs. Coarse on purpose: at this size
   the dot field is the picture and the outline is only there to decide which dots
   are land. */
const NA = [-168, 66, -156, 71, -141, 70, -125, 70, -110, 73, -95, 72, -85, 70, -82, 66, -88, 64, -94, 59, -92, 57, -82, 55, -79, 52, -78, 58, -77, 62, -70, 61, -65, 60, -61, 56, -56, 52, -60, 47, -65, 44, -70, 43, -74, 40, -76, 35, -81, 31, -80, 26, -82, 27, -84, 30, -90, 30, -94, 29, -97, 26, -97, 21, -95, 19, -91, 19, -90, 21, -87, 21, -88, 16, -84, 15, -83, 11, -80, 9, -78, 8, -80, 7, -84, 8, -87, 13, -92, 15, -96, 16, -105, 20, -106, 23, -109, 26, -112, 29, -114, 31, -117, 32, -121, 35, -124, 40, -124, 47, -128, 51, -135, 57, -142, 60, -150, 61, -155, 58, -162, 55, -158, 58, -165, 62];
const GREEN = [-73, 78, -60, 82, -30, 83, -18, 78, -20, 70, -30, 68, -40, 65, -44, 60, -50, 62, -54, 67, -58, 75];
const SA = [-77, 8, -72, 12, -63, 10, -55, 6, -50, 1, -44, -2, -35, -6, -38, -13, -41, -22, -48, -26, -54, -34, -58, -38, -62, -40, -65, -45, -68, -50, -69, -54, -73, -52, -74, -45, -73, -37, -71, -30, -70, -18, -76, -14, -81, -6, -80, -1, -78, 3];
const AFR = [-17, 21, -13, 28, -6, 35, 10, 37, 11, 33, 20, 31, 32, 31, 34, 28, 38, 20, 43, 12, 51, 12, 47, 5, 40, -3, 40, -15, 35, -24, 32, -29, 27, -34, 20, -35, 17, -30, 12, -17, 13, -8, 9, -1, 9, 4, 4, 6, -5, 5, -12, 7, -17, 14];
const EUR = [-9, 37, -6, 36.5, 0, 38.5, 3, 42, 8, 44, 12, 42, 16, 38, 18, 40, 14, 45, 19, 42, 23, 37, 26, 40, 29, 41, 36, 36, 35, 32, 34, 30, 39, 22, 43, 13, 52, 16, 59, 22, 56, 26, 62, 25, 67, 25, 72, 21, 73, 16, 77, 8, 80, 13, 80, 16, 87, 21, 92, 22, 94, 17, 98, 16, 98, 8, 101, 3, 104, 1, 103, 10, 106, 9, 109, 12, 108, 17, 106, 20, 110, 21, 117, 23, 121, 29, 122, 32, 119, 35, 122, 37, 119, 39, 122, 40, 126, 38, 126, 35, 129, 35, 129, 38, 131, 43, 135, 44, 140, 49, 141, 53, 137, 54, 143, 59, 155, 59, 156, 51, 160, 54, 163, 60, 170, 60, 178, 63, 180, 66, 180, 69, 170, 70, 160, 70, 140, 72, 130, 71, 113, 74, 105, 78, 95, 76, 80, 73, 70, 73, 68, 68, 60, 69, 45, 68, 40, 66, 34, 69, 28, 71, 20, 70, 14, 67, 10, 63, 5, 60, 6, 58, 10, 59, 12, 56, 10, 57, 8, 57, 8, 54, 4, 52, 0, 51, -2, 48, -4, 48, -1, 46, -2, 43, -9, 43];
const BRIT = [-5, 50, 1, 51, 2, 53, -1, 56, -2, 58, -5, 58, -6, 56, -3, 54, -5, 52];
const IRE = [-10, 52, -6, 52, -6, 55, -10, 54];
const JAPAN = [130, 33, 135, 33, 140, 35, 142, 40, 140, 41, 139, 38, 136, 37, 131, 35];
const SUMA = [95, 5, 98, 4, 104, -2, 106, -6, 101, -3];
const BORNEO = [109, 2, 114, 5, 119, 5, 118, 1, 116, -3, 110, -3];
const JAVA = [105, -6, 114, -7, 114, -8.5, 106, -7];
const NGUI = [131, -1, 141, -3, 147, -6, 150, -10, 143, -9, 138, -8, 132, -3];
const PHIL = [120, 18, 122, 18, 124, 12, 126, 7, 122, 7, 120, 14];
const AUS = [114, -22, 122, -18, 129, -15, 136, -12, 137, -16, 141, -12, 143, -14, 146, -19, 153, -26, 151, -34, 146, -39, 141, -38, 136, -35, 131, -31, 124, -33, 116, -35, 115, -30];
const NZN = [172, -34, 178, -38, 175, -41, 172, -41];
const NZS = [172, -41, 174, -42, 170, -46, 167, -46];
const MADA = [49, -12, 50, -16, 47, -25, 44, -24, 44, -17];
const ANT = [-180, -72, -150, -77, -120, -74, -90, -72, -65, -68, -60, -75, -40, -78, -20, -72, 0, -70, 30, -69, 60, -67, 90, -66, 120, -66, 150, -68, 170, -72, 180, -72, 180, -90, -180, -90];
const BAFFIN = [-80, 73, -68, 70, -62, 66, -66, 62, -75, 64, -80, 70];
const VICT = [-118, 72, -105, 73, -101, 69, -115, 68];
const ICE = [-24, 65, -14, 66, -14, 64, -22, 63];
const CUBA = [-85, 22, -80, 23, -74, 20, -78, 20];
const NZEM = [52, 71, 58, 76, 68, 77, 56, 73];
const LAND = [NA, GREEN, SA, AFR, EUR, BRIT, IRE, JAPAN, SUMA, BORNEO, JAVA, NGUI, PHIL, AUS, NZN, NZS, MADA, ANT, BAFFIN, VICT, ICE, CUBA, NZEM];

function inPoly(lon: number, lat: number, p: number[]): boolean {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i];
    const yi = p[i + 1];
    const xj = p[j];
    const yj = p[j + 1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function isLand(lon: number, lat: number): boolean {
  for (let k = 0; k < LAND.length; k++) if (inPoly(lon, lat, LAND[k])) return true;
  return false;
}

/** A seeded generator, so the whole drawing is the same drawing every run. */
function mulberry(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ink {
  x: number;
  y: number;
  z: number;
  /** Dot radius, before the perspective shortening. */
  r: number;
  /** One of three opacities, so the ink is not flat. */
  a: number;
  /** A second, smaller mark laid over the first. */
  ox: number;
  oy: number;
  r2: number;
}

interface Speck {
  x: number;
  y: number;
  z: number;
}

interface Sphere {
  ink: Ink[];
  sea: Speck[];
  /** The dot size the lattice was built for, so a resize can keep the density. */
  k: number;
}

/** Built once, on the first open, and kept. See `N` for why the count is tied to
 *  the radius. */
let cached: Sphere | null = null;

/**
 * The dot field.
 *
 * @param radius the projected radius in CSS pixels
 *
 * Both constants are derived from the radius rather than fixed, because density is
 * the whole read here: seven thousand dots is right across a full screen and an
 * unreadable smear inside a card. A sphere holds its dots at a *surface* density,
 * so the count goes as the square of the radius while the dot goes as the radius
 * itself — which is why neither number here is the one in the mock. These two are
 * calibrated so that at the size the card actually gives it the continents are
 * still just legible, which takes about a hundred and thirty inked dots on the
 * near face. Fewer and it is a sprinkle; many more and it is a smudge.
 */
function build(radius: number): Sphere {
  const n = Math.round(radius * radius * 0.95);
  const k = radius / 165;

  const ink: Ink[] = [];
  const sea: Speck[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rnd = mulberry(42);

  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const lat = Math.asin(y);
    const lon = (i * golden) % (Math.PI * 2);
    const lonDeg = ((lon * 180) / Math.PI + 540) % 360 - 180;
    const c = Math.cos(lat);
    let x = c * Math.sin(lon);
    let z = c * Math.cos(lon);
    let yy = y;
    const land = isLand(lonDeg, (lat * 180) / Math.PI);

    // Nudged off the lattice and pushed back onto the sphere. The jitter is
    // larger on land, where it reads as ink, than on water, where it would read
    // as noise.
    const jit = land ? 0.016 : 0.01;
    x += (rnd() - 0.5) * jit;
    yy += (rnd() - 0.5) * jit;
    z += (rnd() - 0.5) * jit;
    const m = Math.sqrt(x * x + yy * yy + z * z);
    x /= m;
    yy /= m;
    z /= m;

    if (land) {
      ink.push({
        x,
        y: yy,
        z,
        r: (1.9 + rnd() * 0.9) * k,
        a: [0.78, 0.9, 1][Math.floor(rnd() * 3)],
        ox: (rnd() - 0.5) * 1.3 * k,
        oy: (rnd() - 0.5) * 1.3 * k,
        r2: 0.6 + rnd() * 0.5,
      });
    } else {
      sea.push({ x, y: yy, z });
    }
  }

  return { ink, sea, k };
}

export default function Globe({ size, active, marker }: GlobeProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // Where the globe is pointing. Deliberately outside the effect: see the note
  // on `spin` below, where it is picked up.
  const spinAt = useRef({ turn: 0, tilt: TILT, aimed: false });

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const context = element.getContext("2d");
    if (context === null) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = Math.round(size * ratio);
    element.height = Math.round(size * ratio);
    // Everything below is in CSS pixels; the transform carries the Retina
    // resolution rather than every coordinate having to.
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const w = size;
    const r = size * 0.4;
    const cx = w / 2;
    const cy = w / 2;
    const sphere = (cached ??= build(r));
    const k = sphere.k;

    const style = getComputedStyle(element);
    const pencilAlpha = Number(style.getPropertyValue("--globe-pencil")) || 0.2;
    const ghostAlpha = Number(style.getPropertyValue("--globe-ghost")) || 0.1;

    let ink = style.color;
    let pencil = ink;
    let ghost = ink;
    // The one colour on this canvas that is not the drawing's own. Same token the
    // CONNECTED bar uses, read rather than repeated, so the dot on the globe and the
    // bar in the rail can never drift apart.
    let beacon = style.getPropertyValue("--live").trim();

    const readColours = () => {
      const computed = getComputedStyle(element);
      const base = computed.color;
      const rgb = base.match(/\d+(\.\d+)?/g);
      if (rgb === null) return;
      ink = base;
      pencil = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${pencilAlpha})`;
      ghost = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${ghostAlpha})`;
      beacon = computed.getPropertyValue("--live").trim() || beacon;
    };
    readColours();

    // Rotation is two numbers: `turn` is longitude and is what the drag moves and
    // the clock advances, `tilt` is the axis and is only ever the drag's. The
    // starting longitude is arbitrary — it just happens to put the Atlantic in
    // view, which is a better first impression than the middle of the Pacific.
    //
    // They live in a ref rather than in this scope because this effect is torn
    // down and rebuilt whenever the marker arrives, and a globe that snapped back
    // to its opening meridian half a second after the card appeared would be the
    // only thing on screen moving that nobody asked to move. In a ref, the angle
    // is the globe's rather than the effect's: it survives the marker landing,
    // it survives the card closing and reopening, and the sphere the user spun
    // yesterday is the sphere they find today.
    const spin = spinAt.current;

    // Aim, once, when the marker first arrives.
    //
    // The opening meridian is chosen for its continents, which means it is
    // chosen for *most* of the world and against the rest: an Australian's
    // longitude is a fifth of a revolution behind it, and the dot would spend
    // its first fifteen seconds round the back where the whole point of having
    // it is being missed. So the first marker re-aims the globe onto itself.
    //
    // Only the first, and only ever once. After this the angle belongs to the
    // user — to their drag, and to the clock — and reopening the card must not
    // yank it back to wherever they happen to live.
    //
    // It is a jump rather than a turn, and that is deliberate. The lookup takes
    // a moment, so the aim lands after the first frame — but the answer is then
    // kept, so `readPlace` answers synchronously on every later mount and this
    // is the only frame it can ever be seen on. It happens once, on the first
    // open, underneath a card that is still fading up, on a globe the user has
    // never seen at rest. Sleighing it smooth would be six lines of easing for
    // the one jump nobody has an expectation to have violated.
    //
    // `spin.tilt` is left alone. The tilt is the Earth's axis and is the same
    // everywhere; sliding it to bring a far-north dot into view would tilt the
    // planet to flatter one address, and the graticule would say so.
    if (!spin.aimed && marker !== null) {
      spin.aimed = true;
      spin.turn = (-marker.lon * Math.PI) / 180 - BASE_YAW;
    }

    let cyaw = 0;
    let syaw = 0;
    let ctilt = 1;
    let stilt = 0;

    const rot = (x: number, y: number, z: number) => {
      const x1 = x * cyaw + z * syaw;
      const z1 = -x * syaw + z * cyaw;
      return { x: x1, y: y * ctilt - z1 * stilt, z: y * stilt + z1 * ctilt };
    };

    /** A pencil line: one path, wobbled, drawn only where it faces us. */
    const sketch = (pts: { x: number; y: number; z: number }[], rng: () => number, wob: number) => {
      context.beginPath();
      let open = false;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.z <= 0) {
          open = false;
          continue;
        }
        const px = cx + r * p.x + (rng() - 0.5) * wob;
        const py = cy - r * p.y + (rng() - 0.5) * wob;
        if (!open) {
          context.moveTo(px, py);
          open = true;
        } else context.lineTo(px, py);
      }
      context.stroke();
    };

    const graticule = (rng: () => number) => {
      context.strokeStyle = pencil;
      context.lineWidth = 1;
      const lats = [-60, -30, 0, 30, 60];
      for (const deg of lats) {
        const la = (deg * Math.PI) / 180;
        const pts: { x: number; y: number; z: number }[] = [];
        for (let lo = 0; lo <= 360; lo += 6) {
          const rl = (lo * Math.PI) / 180;
          pts.push(rot(Math.cos(la) * Math.sin(rl), Math.sin(la), Math.cos(la) * Math.cos(rl)));
        }
        sketch(pts, rng, 1.6);
      }
      for (let b = 0; b < 12; b++) {
        const rl = (b * 30 * Math.PI) / 180;
        const pts: { x: number; y: number; z: number }[] = [];
        for (let la = -90; la <= 90; la += 6) {
          const cl = (la * Math.PI) / 180;
          pts.push(rot(Math.cos(cl) * Math.sin(rl), Math.sin(cl), Math.cos(cl) * Math.cos(rl)));
        }
        sketch(pts, rng, 1.6);
      }
    };

    /** Pencil hatching across everything except a circle up and to the left of
     *  centre — a crescent of shade where the light is not. */
    const hatch = (rng: () => number) => {
      context.save();
      context.beginPath();
      context.arc(cx, cy, r, 0, Math.PI * 2);
      context.clip();
      context.beginPath();
      context.rect(0, 0, w, w);
      context.arc(cx - r * 0.32, cy - r * 0.3, r * 1.02, 0, Math.PI * 2);
      context.clip("evenodd");
      context.strokeStyle = pencil;
      context.lineWidth = 1;
      context.beginPath();
      for (let kk = -r * 2; kk <= r * 2; kk += 9) {
        context.moveTo(cx + kk - r + (rng() - 0.5) * 3, cy + r + (rng() - 0.5) * 3);
        context.lineTo(cx + kk + r + (rng() - 0.5) * 3, cy - r + (rng() - 0.5) * 3);
      }
      context.stroke();
      context.restore();
    };

    /** The rim, gone round twice without lifting the pencil and missing both
     *  times. Seeded from the clock, so it never settles.
     *
     *  Both passes sit well under full ink. On paper the rim is a darkening and can
     *  afford to be sure of itself; here it is the brightest thing on a dark ground
     *  and at full strength it stops being a drawn edge and becomes a boundary —
     *  the loudest mark on the card, belonging to the least important part of the
     *  drawing.
     *
     *  The wander is in pixels, not in a fraction of the radius. In the mock it was
     *  written as a percentage, which was right at the size the mock was drawn: 1.5%
     *  of a full-screen radius is four pixels and reads as a pencil. Here the same
     *  percentage is a third of a pixel, and a third of a pixel is a perfect circle
     *  — the one thing this drawing must not be. */
    const rim = (seed: number) => {
      const passes = [
        { w: 1.5, a: 0.48, wob: 0.5, wave: 0.3 },
        { w: 1, a: 0.26, wob: 0.85, wave: 0.45 },
      ];
      context.strokeStyle = ink;
      context.lineCap = "round";
      for (let p = 0; p < passes.length; p++) {
        const rng = mulberry(seed * 7919 + p * 131 + 5);
        const pass = passes[p];
        const start = rng() * Math.PI * 2;
        const phase = rng() * 6.28;
        context.lineWidth = pass.w;
        context.globalAlpha = pass.a;
        context.beginPath();
        for (let a = 0; a <= Math.PI * 2 * 1.04; a += 0.06) {
          const ang = start + a;
          const rr =
            r +
            (rng() - 0.5) * 2 * pass.wob +
            Math.sin(ang * 3 + phase) * pass.wave;
          const px = cx + Math.cos(ang) * rr;
          const py = cy + Math.sin(ang) * rr;
          if (a === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        }
        context.stroke();
      }
      context.globalAlpha = 1;
    };

    /** The far hemisphere's land, as one path and one fill. Each of these is a
     *  circle of the same size at the same opacity, which is exactly the case
     *  where batching stops being a micro-optimisation: it is one fill against
     *  several hundred, every frame. */
    const farLand = () => {
      const path = new Path2D();
      for (let i = 0; i < sphere.ink.length; i++) {
        const d = sphere.ink[i];
        const p = rot(d.x, d.y, d.z);
        if (p.z >= 0) continue;
        const px = cx + r * p.x;
        const py = cy - r * p.y;
        path.moveTo(px + 1.2 * k, py);
        path.arc(px, py, 1.2 * k, 0, 6.2832);
      }
      context.fillStyle = ghost;
      context.fill(path);
    };

    // Re-reading the palette is a forced style recalc, so it happens on a timer
    // rather than per frame. Nothing but a theme change moves these.
    let nextRead = 0;

    // Where this machine is, as a point on the unit sphere — the same construction
    // the graticule uses for its own points, so the marker and the grid agree about
    // where latitude 0 is.
    const beaconAt = (() => {
      if (marker === null) return null;
      const la = (marker.lat * Math.PI) / 180;
      const lo = (marker.lon * Math.PI) / 180;
      const c = Math.cos(la);
      return { x: c * Math.sin(lo), y: Math.sin(la), z: c * Math.cos(lo) };
    })();

    /**
     * The one mark on the globe that is not part of the drawing: where the user is.
     *
     * Three concentric discs rather than a dot with a ring, because at this size a
     * ring and a disc are the same two pixels. It is drawn last, over the rim, so it
     * is never buried under the line work — and it fades out as it turns towards the
     * limb, which is what stops it reading as a sticker on the glass instead of a
     * place on the ball.
     */
    const beaconMark = () => {
      if (beaconAt === null || beacon === "") return;
      const p = rot(beaconAt.x, beaconAt.y, beaconAt.z);
      if (p.z <= 0.02) return;
      const px = cx + r * p.x;
      const py = cy - r * p.y;
      const facing = Math.min(1, p.z * 1.6);
      context.fillStyle = beacon;
      // Sized against the land dots rather than against the globe: the core is
      // about twice a land dot, which is what makes it read as one of them
      // singled out — and the two haloes are what make it findable without
      // having to hunt along the coastlines for the one that is green.
      const discs = [
        { radius: 26 * k, alpha: 0.09 },
        { radius: 14 * k, alpha: 0.22 },
        { radius: 7 * k, alpha: 1 },
      ];
      for (let i = 0; i < discs.length; i++) {
        context.globalAlpha = discs[i].alpha * facing;
        context.beginPath();
        context.arc(px, py, discs[i].radius, 0, 6.2832);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    /**
     * @param seconds a clock for the line work, not for the rotation — the two are
     *   separate on purpose. The boiling has to keep its own tempo when the user is
     *   spinning the globe by hand; tying it to `turn` would make a fast drag strobe
     *   the graticule, which is the one thing the drag is not.
     */
    const render = (seconds: number) => {
      // The boiling line work is re-seeded a few times a second, not every frame.
      // Redrawing it sixty times a second would be a vibration, not a hand.
      const lineSeed = Math.floor(seconds * 6);
      const yaw = BASE_YAW + spin.turn;
      cyaw = Math.cos(yaw);
      syaw = Math.sin(yaw);
      ctilt = Math.cos(spin.tilt);
      stilt = Math.sin(spin.tilt);
      if (seconds >= nextRead) {
        readColours();
        nextRead = seconds + 0.15;
      }

      context.clearRect(0, 0, w, w);

      farLand();
      hatch(mulberry(lineSeed * 31 + 7));
      graticule(mulberry(lineSeed * 97 + 3));

      // Water, as square specks. Short of the poles and quiet, so the continents
      // have something to be dense against. Floored at half a CSS pixel, which on
      // any display this ships to is a whole device pixel — below that a speck
      // stops being a speck and becomes a smudge of antialiasing.
      context.fillStyle = pencil;
      for (let i = 0; i < sphere.sea.length; i++) {
        const d = sphere.sea[i];
        const p = rot(d.x, d.y, d.z);
        if (p.z <= 0) continue;
        const s = Math.max(0.5, 2.2 * k * (0.5 + 0.5 * p.z));
        context.fillRect(cx + r * p.x - s / 2, cy - r * p.y - s / 2, s, s);
      }

      // Land, inked dot by dot: a mark, a smaller mark over it, and an ellipse
      // turned to face outward, because a hand shortens its stroke as it goes
      // round the side of a ball.
      //
      // The opacity tops out around three quarters rather than at full ink. That is
      // the whole of the difference between paper and a dark ground: dark ink on
      // paper darkens, so it can be laid on at full strength and still read as a
      // continent; light ink on a dark ground does the opposite and glares, and at
      // full strength the dots stop massing into land and become confetti.
      context.fillStyle = ink;
      for (let i = 0; i < sphere.ink.length; i++) {
        const d = sphere.ink[i];
        const p = rot(d.x, d.y, d.z);
        if (p.z <= 0) continue;
        const px = cx + r * p.x;
        const py = cy - r * p.y;
        const rr = d.r * (0.5 + 0.5 * p.z);
        const rp = rr * Math.max(p.z, 0.3);
        const ang = Math.atan2(py - cy, px - cx);
        context.globalAlpha = (0.45 + 0.45 * p.z) * d.a;
        context.beginPath();
        context.ellipse(px, py, rp, rr, ang, 0, 6.2832);
        context.moveTo(px + d.ox + rp * d.r2 * 0.9, py + d.oy);
        context.ellipse(px + d.ox, py + d.oy, rp * d.r2, rr * d.r2, ang, 0, 6.2832);
        context.fill();
      }
      context.globalAlpha = 1;

      rim(lineSeed);
      beaconMark();
    };

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const now = () => performance.now() / 1000;
    const draw = () => render(now());

    /* ---------------------------- direct manipulation --------------------------- */

    // The globe is an ornament that happens to be a toy. There is no state in it
    // and nothing to announce, so it stays `aria-hidden` and out of the tab order
    // and the drag is a pointer flourish on a decoration — not a control that a
    // keyboard user is being denied.
    const clamp = (value: number, low: number, high: number) =>
      Math.min(high, Math.max(low, value));

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };

    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      spin.turn += (event.clientX - lastX) * 0.008;
      // Stopped short of the poles: past about 70° the graticule collapses onto
      // itself and the sphere reads as a flat grid.
      spin.tilt = clamp(spin.tilt + (event.clientY - lastY) * 0.008, -1.2, 1.2);
      lastX = event.clientX;
      lastY = event.clientY;
      // Under reduced motion there is no loop to catch this, so the drag draws for
      // itself. A globe that would not move when pushed would be the opposite of
      // what was asked for: reduced motion is about motion the user did not ask
      // for, and this is motion the user is making.
      if (still) draw();
    };

    const onUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
    };

    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);

    let frame = 0;
    // The first frame is drawn here rather than left to the loop's first callback,
    // for two reasons and the second is not hypothetical.
    //
    // It puts the globe on screen in the same frame the card fades up rather than
    // one frame behind it, which matters because the card is the thing being
    // watched. And a document that is not being painted is delivered no animation
    // frames at all: `requestAnimationFrame` is suspended in a hidden document,
    // which is exactly what this window is when it has been hidden to the menu bar
    // and brought back — and what it is to any offscreen capture. A globe that
    // waited for a callback would come back blank and stay blank until something
    // else forced a repaint.
    //
    // Held or turning, then: one frame now, and the loop only if there is a loop
    // to run. Reduced motion and the closed card both keep the frame and skip the
    // turning, which is what "a globe that is not turning is still a globe" means.
    draw();
    if (!still && active) {
      let last = performance.now();
      const step = (time: number) => {
        frame = requestAnimationFrame(step);
        const dt = Math.min((time - last) / 1000, 0.05);
        last = time;
        // The auto-turn yields to the hand. Without this the globe fights the
        // pointer and never goes where it is put.
        if (!dragging) spin.turn += dt * TURN_RATE;
        render(time / 1000);
      };
      frame = requestAnimationFrame(step);
    }

    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
    };
  }, [size, active, marker]);

  return (
    <canvas
      ref={canvas}
      className="settings__globe"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
