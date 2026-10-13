import katex from "katex";
import MarkdownIt from "markdown-it";
import "katex/dist/katex.min.css";

/**
 * The model's words, set as the model wrote them.
 *
 * Two things arrive in an answer that have to be read back rather than read:
 * markdown, because a list of steps is a list and a bolded term is the one thing
 * in the sentence, and TeX, because a model chosen for mathematics answers in it
 * — `\(a_n \to a\)`, `\[\frac{|a_n - a|}{\sqrt{a_n} + \sqrt{a}}\]`, `\boxed{\sqrt{a}}`.
 * Until this existed both were passed through as source, so a proof arrived as a
 * wall of backslashes and was, quite correctly, reported as not working.
 *
 * ── Why the math is lifted out before the markdown is run ─────────────────────
 *
 * markdown-it escapes backslash punctuation, and TeX is made of backslash
 * punctuation. `\(` becomes `(`, `\,` becomes `,`, `\!` becomes `!` — the
 * delimiters go first and the spacing commands follow, and what is left is
 * neither TeX nor prose. No option turns that off. So every math span is lifted
 * out of the text whole, replaced by an inert token, and put back after the
 * markdown has run. Lifting the spans rather than escaping the delimiters is what
 * protects `\;` and `\,` as well, which are as ordinary inside TeX as the
 * delimiters are and would each be eaten on their own.
 *
 * ── Why the result is safe to inject ──────────────────────────────────────────
 *
 * This is the one place in the app where a string becomes HTML, and each guard
 * below is load-bearing:
 *
 * — `html: false`, so markdown-it emits no tag the model wrote. Raw HTML in an
 *   answer comes out escaped, as the text it is.
 * — `validateLink` (markdown-it's own, left on), so a link to `javascript:` or
 *   another executable scheme is not a link. Raw HTML is not the only way to
 *   smuggle a script into a document.
 * — `trust: false` in KaTeX, so `\href`, `\url`, `\includegraphics` and the rest
 *   of the commands that reach outside the page are refused rather than emitted.
 *
 * The only tags that can survive all three are the ones markdown-it generates
 * from markup and the ones KaTeX generates from TeX.
 */

const md = new MarkdownIt({
  html: false,
  // The model writes its steps on separate lines and means them as separate
  // lines. Markdown's own rule folds a single newline into the paragraph around
  // it, which would set a proof as one paragraph of arithmetic.
  breaks: true,
  linkify: true,
});

/** The four ways TeX is bracketed, in the order they have to be tried.
 *
 *  Longest first, in both directions: `$$…$$` before `$…$` and `\[…\]` before
 *  `\(…\)`, because the display form of each is a prefix of the inline one and a
 *  single left-to-right pass takes the first alternative that matches. Display
 *  before inline is the same rule read the other way — `$$` and `\[` are the
 *  display forms.
 *
 *  The `$` form refuses a space just inside either delimiter, which is what
 *  keeps it off a sentence about money: "$5 and $10" has a space after the first
 *  `$` and a digit before the second, so neither is TeX and both stay as typed. */
const MATH =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$/g;

/** A math span, and the token standing in for it while the markdown runs. */
interface Span {
  token: string;
  tex: string;
  display: boolean;
}

/** Inert to markdown — `%` is not punctuation in any of its rules — and legible
 *  if one ever escapes into a render, which is the only reason it is not a
 *  control character. */
const tokenFor = (index: number) => `%%MATHTEX${index}%%`;

/**
 * Results, kept by the text that produced them.
 *
 * Rendering is pure, so the same answer always renders to the same HTML — and in
 * a conversation the same message is rendered again every time anything changes,
 * which includes every time a new line arrives. Without this, appending one
 * short reply re-typesets the mathematics of every answer above it.
 *
 * Capped because this is a cache and not a store: past a few hundred entries the
 * oldest are dropped, and a message far enough back to be evicted is one nobody
 * is looking at.
 */
const CACHE_LIMIT = 256;
const cache = new Map<string, string>();

/**
 * One answer, as HTML.
 *
 * Synchronous and, after the first time, free — the transcript re-renders every
 * message whenever the conversation grows, and this is what keeps that from
 * meaning anything.
 */
export function renderMessage(text: string): string {
  const kept = cache.get(text);
  if (kept !== undefined) return kept;

  const html = render(text);

  // `Map` iterates in insertion order, so the first key is the oldest.
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(text, html);
  return html;
}

/** The renderer proper: lift the math, run the markdown, put the math back. */
function render(text: string): string {
  const spans: Span[] = [];

  const lifted = text.replace(
    MATH,
    (match: string, dollars?: string, brackets?: string, parens?: string, singles?: string) => {
      const tex = dollars ?? brackets ?? parens ?? singles;
      if (tex === undefined) return match;
      const token = tokenFor(spans.length);
      // `$$` and `\[` are the display forms; `$` and `\(` are inline.
      spans.push({ token, tex, display: dollars !== undefined || brackets !== undefined });
      return token;
    },
  );

  let html = md.render(lifted);

  for (const span of spans) {
    // `split`/`join` and not `replace`: a replacement string reads `$&`, `$1`
    // and friends as patterns, and the output being substituted here is TeX,
    // which is made of `$`.
    html = html.split(span.token).join(renderTex(span.tex, span.display));
  }

  return html;
}

/** `--ink-quiet`, read from the stylesheet so the palette keeps one owner.
 *  Memoised: the read forces a style resolution, and it is the same value for
 *  the life of the document. */
let quietInk: string | null = null;

function quiet(): string {
  if (quietInk === null) {
    quietInk = getComputedStyle(document.documentElement).getPropertyValue("--ink-quiet").trim();
    // The variable wins; the literal is the floor for the moment before the
    // stylesheet has landed, when a formula that failed to parse would otherwise
    // be marked in KaTeX's own red.
    if (quietInk === "") quietInk = "#9a988f";
  }
  return quietInk;
}

/**
 * One formula, typeset.
 *
 * `throwOnError: false` is the important one, and it is not a fallback: a model
 * that writes one command KaTeX does not know should not cost the sentence
 * around it. KaTeX sets what it understood and marks the rest, which is a truer
 * answer than an exception. `strict: false` is the same judgement a level down —
 * unicode straight into math mode, which this model does freely, is a warning
 * rather than an error.
 *
 * The colour it uses to mark that is `--ink-quiet` rather than KaTeX's red. This
 * app has no warning hue, deliberately — attention is earned by absence and by
 * full ink, not by a colour — so a formula that did not parse is drawn in the
 * same ink as everything else that could not be read, and the mark itself is the
 * message.
 */
function renderTex(tex: string, display: boolean): string {
  const source = tex.trim();
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      errorColor: quiet(),
      strict: false,
      trust: false,
    });
  } catch {
    // `renderToString` can still refuse a string it cannot so much as begin to
    // parse. The source is a truer thing to show than a hole where an answer was.
    return `<code>${md.utils.escapeHtml(source)}</code>`;
  }
}
