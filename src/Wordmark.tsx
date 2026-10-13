import { useEffect, useRef } from "react";

/**
 * Opening wordmark.
 *
 * The pointer is a focal plane: the word is crisp under it and softens with
 * distance. Two copies do that. The lower one is blurred once, at a fixed depth,
 * and is never masked, so there is no position the focus can reach from which the
 * word can go missing. The upper one is the crisp copy, and it wears the effect's
 * only mask — a single radial gradient, opaque under the pointer, fading out over
 * the reach.
 *
 * One soft gradient, and not the flight of hard-edged bands this used to be.
 * Tiling five bands of rising blur across the reach looked like the cheaper way to
 * ramp, but a hard stop in a radial mask is a circle, and where one crosses a
 * letter the blur steps under it — concentric rings, drawn over the word. Bands
 * also have to overlap in order to cross-fade, and two white copies each
 * part-masked compose to less than full opacity, which is the dark ring the tiling
 * existed to avoid. A soft gradient has neither fault, and it costs one blur
 * instead of five.
 *
 * The mask is a fixed-size image and the focus is moved by sliding it
 * (`mask-position`, in the stylesheet) rather than by rewriting the gradient: a
 * gradient that mentions the pointer has to be re-evaluated every frame, and the
 * blurred copy re-rasterised along with it.
 */

const WORD = "Common.";

// Tuning knobs.
const BLUR = 5; // Depth: blur in px of the soft copy.
const REACH = 0.55; // Reach: distance from the pointer at which the crisp copy is wholly gone, as a share of the word's width.
const CORE = 0.35; // Core: share of the reach the crisp copy holds at full strength before it starts to fade.
const FOLLOW = 0.16; // How quickly the focus follows the pointer.
const SETTLED = 0.25; // px of remaining travel below which the easing stops.

export default function Wordmark() {
  const wordRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const word = wordRef.current;
    if (!word) return;

    const focus = word.querySelector<HTMLElement>(".layer--focus");
    if (!focus) return;

    // The mask image is the gradient's box and its centre is the gradient's
    // centre, so the focus is moved by centring the image on it — backing the
    // image off by half its own size. The image must cover the word with the
    // focus anywhere inside the word, and half of `w + 2 * reach` clears the far
    // edge from the near one with a little over 2w to spare.
    //
    // Backing it off by the reach instead — which is what this did — leaves the
    // gradient's centre only a reach from the image's left edge, so the image
    // stops covering the word as soon as the focus travels past a reach. Past the
    // image, `no-repeat` is not a soft edge but a cut, and the word is
    // guillotined: at a screen corner, `COMM` went entirely.
    const buildMask = () => {
      const w = word.offsetWidth;
      const h = word.offsetHeight;
      const reach = w * REACH;
      const core = reach * CORE;
      const mw = w + 2 * reach;
      const mh = h + 2 * reach;
      const stops = `#000 0px, #000 ${core.toFixed(2)}px, transparent ${reach.toFixed(2)}px`;
      const gradient = `radial-gradient(circle at ${(mw / 2).toFixed(2)}px ${(mh / 2).toFixed(2)}px, ${stops})`;
      // Prefixed and unprefixed both set; property names go through setProperty,
      // so the vendor prefix needs no special-casing in the types.
      focus.style.setProperty("-webkit-mask-image", gradient);
      focus.style.setProperty("mask-image", gradient);
      // Read by the stylesheet to place that image.
      word.style.setProperty("--mask-size", `${mw.toFixed(2)}px ${mh.toFixed(2)}px`);
      word.style.setProperty("--mask-x", `${(mw / 2).toFixed(2)}px`);
      word.style.setProperty("--mask-y", `${(mh / 2).toFixed(2)}px`);
      return { w, h };
    };

    let box = { w: 0, h: 0 };
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;
    let havePointer = false;
    let raf = 0;

    // The word's box, kept rather than measured. Reading it forces layout, and
    // the pointer reports far more often than the word can possibly move — it
    // only moves when the viewport changes, which `layout` already watches.
    let rect = word.getBoundingClientRect();

    const center = () => {
      tx = box.w / 2;
      ty = box.h / 2;
    };

    const paint = () => {
      word.style.setProperty("--x", `${cx.toFixed(2)}px`);
      word.style.setProperty("--y", `${cy.toFixed(2)}px`);
    };

    // Ease toward the pointer so the focus glides rather than snapping.
    const tick = () => {
      cx += (tx - cx) * FOLLOW;
      cy += (ty - cy) * FOLLOW;
      paint();
      if (Math.abs(tx - cx) > SETTLED || Math.abs(ty - cy) > SETTLED) {
        raf = requestAnimationFrame(tick);
      } else {
        cx = tx;
        cy = ty;
        paint();
        raf = 0;
      }
    };

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    // The focus is held inside the word. The mask covers the word from any focus
    // in its box, so a pointer that wanders off the word — to a screen corner, say
    // — leaves the focus resting on the nearest edge instead of dragging the image
    // away and taking the word with it.
    const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);

    const aim = (e: PointerEvent) => {
      havePointer = true;
      tx = clamp(e.clientX - rect.left, box.w);
      ty = clamp(e.clientY - rect.top, box.h);
      kick();
    };

    // Pointer gone from the window: drift back to centre rather than leaving the
    // focus parked wherever it was last seen.
    const onLeave = () => {
      havePointer = false;
      center();
      kick();
    };

    // The word scales with the viewport and the webfont lands late, so the mask has
    // to be rebuilt whenever either changes the word's size.
    const layout = () => {
      rect = word.getBoundingClientRect();
      box = buildMask();
      if (!havePointer) {
        center();
        cx = tx;
        cy = ty;
      }
      paint();
    };

    layout();

    const observer = new ResizeObserver(layout);
    observer.observe(word);
    window.addEventListener("pointermove", aim);
    window.addEventListener("pointerdown", aim);
    window.addEventListener("resize", layout);
    document.documentElement.addEventListener("mouseleave", onLeave);
    if (document.fonts?.ready) document.fonts.ready.then(layout);

    return () => {
      observer.disconnect();
      window.removeEventListener("pointermove", aim);
      window.removeEventListener("pointerdown", aim);
      window.removeEventListener("resize", layout);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <h1 className="word" ref={wordRef}>
      {/* The soft copy: in flow, and unmasked, so that it sets the box and so that
          nothing the pointer does can crop it. */}
      <span className="layer">
        <span className="layer__ink layer__ink--soft" style={{ filter: `blur(${BLUR}px)` }}>
          {WORD}
        </span>
      </span>
      {/* The crisp copy, stacked over it, wearing the effect's only mask. */}
      <span className="layer layer--focus" aria-hidden="true">
        <span className="layer__ink">{WORD}</span>
      </span>
    </h1>
  );
}
