/**
 * Drive the whole setup flow in the packaged Windows app and photograph each step.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 *
 * A Windows machine reached the network, sat in `/peers`, and was told "It took
 * too long to answer." That is a bug about *reading* a join, and no unit test can
 * see it: the evidence is a screen, and the failure is a screen that says the
 * wrong thing. There is no way back into the flow from the UI and no frontend
 * test runner in this repo, so this file is the only way to watch the setup run
 * end to end.
 *
 * ── How it talks to the app ────────────────────────────────────────────────────
 *
 * The app is Tauri, so on Windows it is a WebView2 window — a Chromium. The
 * workflow builds it with `--remote-debugging-port` injected through
 * `additionalBrowserArgs`, so there is a CDP endpoint on 127.0.0.1 and this
 * speaks raw CDP over it. Node 24 has `WebSocket` and `fetch` built in, so this
 * adds no dependency to a repo that has no JS test dependencies at all.
 *
 * The alternative — `tauri-driver`, or pywinauto clicking pixels — is worse in
 * both directions: `tauri-driver` needs an `msedgedriver.exe` matched to an
 * evergreen WebView2 runtime, and its `screenshot()` goes through the same
 * `Page.captureScreenshot` this does.
 *
 * ── The two rules that make it work ────────────────────────────────────────────
 *
 * **Never click a disabled control.** Every advancing button in the flow goes
 * `disabled` while its task runs, and a click on a disabled button dispatches
 * nothing at all — silently. A driver that ignores this photographs a screen
 * that never moved and calls it a pass.
 *
 * **Click where the control is, not in the DOM.** The primary path dispatches
 * real mouse events at the element's centre, which hit-tests the way a pointer
 * does. `HTMLElement.click()` is the fallback for the nodes that are deliberately
 * clipped to nothing — the wordmark's button and the radios are 1×1 and
 * `clip-path`'d, so they have no centre to hit and must be called.
 *
 * ── The trap this is built around ──────────────────────────────────────────────
 *
 * On a fresh profile the app opens on a wordmark, and its only two exits are the
 * `animationend` of its leave animation and `prefers-reduced-motion`. On a
 * runner whose compositor may never be exposed, `animationend` can simply never
 * arrive: the process is alive, CDP answers, `readyState` is `complete`, and the
 * app sits on the wordmark forever with nothing on screen to say why. So the very
 * first thing this does, before any screenshot, is emulate reduced motion.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/* ------------------------------- configuration ------------------------------- */

const DEVTOOLS = process.env.TRIAL_DEVTOOLS ?? "http://127.0.0.1:9222";
const SHOTS = path.resolve(process.env.TRIAL_SHOTS ?? "trial-shots");
const APP_LOG = process.env.TRIAL_APP_LOG ?? null;
const APP_PID = process.env.TRIAL_PID ? Number(process.env.TRIAL_PID) : null;

/** Seconds allowed in each state. They differ because the things being waited on
 *  do. The download is gigabytes over the runner's link and then a checksum; the
 *  join pulls a model, waits for a tunnel, asks the model a question on a
 *  CPU-only machine and then waits up to ninety seconds for the gateway to list
 *  it. Everything else is a local read or a click. */
const WAIT = {
  attach: 60,
  screen: 120,
  download: 1800,
  join: 900,
};

const SCAN_STATEMENTS = [
  "Having a look.",
  "Here's what this machine has.",
  "How much memory does it have?",
  "I couldn't read this machine.",
];

const TERMINAL = [
  { kind: "live", match: /^You're live in the .+ lane\.$/ },
  { kind: "registered", match: /^You're registered\.$/ },
  { kind: "error", match: /^The network didn't answer\.$/ },
  { kind: "error", match: /^Common isn't fully installed\.$/ },
  { kind: "error", match: /^The join stopped on this machine\.$/ },
];

/* ---------------------------------- logging ---------------------------------- */

const started = Date.now();

function note(message) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1).padStart(7);
  process.stdout.write(`[${seconds}s] ${message}\n`);
}

function fatal(message) {
  const error = new Error(message);
  error.expected = true;
  throw error;
}

/** Whatever the app printed on its way up. `lib.rs` panics out of `.build()` if the
 *  tray fails, and that message is the only account of why there is no window. */
function appLogTail(lines = 40) {
  if (APP_LOG === null) return "(no app log configured)";
  try {
    const all = fs.readFileSync(APP_LOG, "utf8").split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  } catch {
    return "(no app log written)";
  }
}

/* There is deliberately no liveness probe here. `process.kill(pid, 0)` is the
 * only one Node has, and on Windows it is not the POSIX call: the signal
 * argument is not honoured the same way, and it can fail for reasons that have
 * nothing to do with the process being gone. The first run of this workflow
 * declared a live app dead at 0.0s with 0-byte logs, and that probe is the
 * suspect — either it answered wrongly, or it did what Node does with an
 * unrecognised signal on Windows and ended the process outright. Neither can be
 * settled from a Mac, so the probe is gone rather than fixed.
 *
 * The question it was asking is now answered before the driver starts: the
 * workflow's launch step waits ten seconds, checks the Process object, and
 * fails with the exit code if the app is not there, then waits for the devtools
 * port itself. By the time `attach()` runs, the app is known to be alive and the
 * port is known to answer. If the port stops answering, the timeout below says
 * so, with the app's PID and whatever it printed. */


/* -------------------------------- the CDP client -------------------------------- */

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(wsUrl) {
    const client = new Cdp();
    client.#socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener("open", resolve, { once: true });
      client.#socket.addEventListener("error", () => reject(new Error("the devtools socket refused the connection")), {
        once: true,
      });
    });
    client.#socket.addEventListener("message", (event) => client.#receive(event.data));
    return client;
  }

  #receive(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    // Events carry no id and nothing here subscribes to any, so they are dropped.
    if (message.id === undefined) return;
    const waiting = this.#pending.get(message.id);
    if (waiting === undefined) return;
    this.#pending.delete(message.id);
    if (message.error) waiting.reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
    else waiting.resolve(message.result);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      // Nothing to do; the process is about to end anyway.
    }
  }

  /** Evaluate in the page and hand back the value.
   *
   *  `awaitPromise` so a page-side promise resolves rather than serialising to
   *  `{}`, and `returnByValue` so the answer arrives as data rather than as a
   *  remote object to be fetched a second time. */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const thrown = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`the page threw while evaluating: ${thrown}`);
    }
    return result.result.value;
  }
}

/* ------------------------------- page-side helpers ------------------------------- */

const STATEMENT = `(document.querySelector("h1.statement")?.textContent ?? "").trim()`;
const BODY_TEXT = `(document.body.innerText ?? "").trim()`;

function findByLabel(label) {
  return `(() => {
    const button = [...document.querySelectorAll("button.control")]
      .find((el) => (el.textContent || "").trim() === ${JSON.stringify(label)});
    if (button === undefined) return { state: "absent" };
    if (button.disabled) return { state: "disabled" };
    const r = button.getBoundingClientRect();
    return { state: "ready", x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`;
}

function findRadio(name, value) {
  return `(() => {
    const input = document.querySelector('input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]');
    if (input === null) return { state: "absent" };
    if (input.disabled) return { state: "disabled" };
    return { state: "ready", checked: input.checked };
  })()`;
}

/* ---------------------------------- the session ---------------------------------- */

class Trial {
  constructor(cdp) {
    this.cdp = cdp;
    this.shotCount = 0;
  }

  /** Every wait in this file goes through here. On timeout the page's own text is
   *  in the message, because the failure worth debugging is never "CDP stopped
   *  answering" — it is "the app was on a different screen than the driver
   *  assumed", and the text is what says which. */
  async waitFor(expression, seconds, description) {
    const deadline = Date.now() + seconds * 1000;
    let last;
    for (;;) {
      last = await this.cdp.eval(expression);
      if (last === true || (last !== null && typeof last === "object" && last.state === "ready")) return last;
      if (Date.now() > deadline) {
        const text = await this.cdp.eval(BODY_TEXT).catch(() => "(page unreachable)");
        const detail =
          last !== null && typeof last === "object" && last.state === "disabled"
            ? " (the control is present but disabled)"
            : "";
        fatal(`waited ${seconds}s for ${description}${detail}.\n  On screen:\n${indent(text)}`);
      }
      await sleep(250);
    }
  }

  async waitForStatement(allowed, seconds, description) {
    const list = Array.isArray(allowed) ? allowed : [allowed];
    const test = `(() => { const s = ${STATEMENT}; return ${JSON.stringify(list)}.includes(s) ? s : null; })()`;
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const found = await this.cdp.eval(test);
      if (found !== null) return found;
      if (Date.now() > deadline) {
        const text = await this.cdp.eval(BODY_TEXT).catch(() => "(page unreachable)");
        fatal(`waited ${seconds}s for ${description}.\n  On screen:\n${indent(text)}`);
      }
      await sleep(250);
    }
  }

  /** Wait for the statement to become one this file recognises as terminal, and
   *  keep a picture of every distinct sentence along the way. The join spends
   *  minutes in states the driver does not steer — registering, loading a model,
   *  asking it something, confirming — and a run that only photographed the end
   *  would lose the record of which of them it got stuck in. */
  async waitForTerminal(seconds) {
    const deadline = Date.now() + seconds * 1000;
    const seen = new Set();
    for (;;) {
      const statement = await this.cdp.eval(STATEMENT);
      const known = TERMINAL.find((entry) => entry.match.test(statement));
      if (known !== undefined) return { kind: known.kind, statement };
      if (!seen.has(statement)) {
        seen.add(statement);
        if (statement !== "") await this.shot(`06-join-${slug(statement)}`);
        note(`  join: ${JSON.stringify(statement)}`);
      }
      if (Date.now() > deadline) {
        const text = await this.cdp.eval(BODY_TEXT).catch(() => "(page unreachable)");
        fatal(`waited ${seconds}s for the join to reach an end, and it never did.\n  On screen:\n${indent(text)}`);
      }
      await sleep(500);
    }
  }

  /* ---------------------------------- clicking ---------------------------------- */

  async clickControl(label, { timeout = WAIT.screen } = {}) {
    const found = await this.waitFor(findByLabel(label), timeout, `the "${label}" control to become clickable`);
    if (found.w < 1 || found.h < 1) {
      // Clipped to nothing — the wordmark's button is the only one, and it is
      // handled before this is ever reached.
      await this.cdp.eval(
        `[...document.querySelectorAll("button.control")].find((el) => (el.textContent||"").trim() === ${JSON.stringify(label)}).click()`,
      );
    } else {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y });
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: found.x, y: found.y, button: "left", buttons: 1, clickCount: 1,
      });
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: found.x, y: found.y, button: "left", buttons: 0, clickCount: 1,
      });
    }
    note(`clicked "${label}"`);
  }

  async chooseRadio(name, value) {
    await this.waitFor(findRadio(name, value), WAIT.screen, `the "${name}" choice "${value}"`);
    // A real radio clipped to 1×1: there is no centre to click, and `.click()` on
    // an input runs its activation behaviour — the change event and the React
    // handler — exactly as a pointer would.
    await this.cdp.eval(
      `document.querySelector('input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]').click()`,
    );
    const checked = await this.cdp.eval(
      `document.querySelector('input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]').checked`,
    );
    if (checked !== true) fatal(`clicked the "${value}" choice and it did not take.`);
    note(`chose ${name} = ${value}`);
  }

  /* --------------------------------- screenshots --------------------------------- */

  async shot(name) {
    const result = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const png = Buffer.from(result.data, "base64");
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), png);

    const text = await this.cdp.eval(BODY_TEXT).catch(() => "");
    fs.writeFileSync(path.join(SHOTS, `${name}.txt`), `${await this.cdp.eval(STATEMENT).catch(() => "")}\n\n${text}\n`);

    this.shotCount += 1;

    // A frame that is one flat colour is a renderer that never composited, and it
    // would otherwise be indistinguishable from a run that went perfectly. Worth
    // asserting rather than hoping: `windows-latest` is not reliably an
    // interactive desktop.
    const stats = pngColours(png);
    if (stats.checked) {
      if (stats.colours <= 1) {
        fatal(
          `${name}.png is a single flat colour (${stats.width}×${stats.height}) — the renderer never drew the window. ` +
            `CDP answered and the DOM was there, so this is compositing, not the app.`,
        );
      }
      if (stats.colours <= 4) note(`  (${name}.png holds only ${stats.colours} colours)`);
    }

    note(`photographed ${name}`);
    return stats;
  }

  /* ------------------------------------ steps ------------------------------------ */

  /** The wordmark, and the one thing that has to happen before touching it. */
  async begin() {
    await this.cdp.send("Emulation.setEmulatedMedia", {
      media: "",
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    const state = await this.cdp.eval(`({
      intro: document.querySelector(".intro") !== null,
      onboarding: document.querySelector(".onboarding") !== null,
    })`);

    if (state.intro) {
      note("the wordmark is up; reducing motion so its exit does not depend on an animation");
      // 1×1 and clipped, so this one genuinely has to be called rather than
      // pointed at.
      await this.cdp.eval(`document.querySelector(".intro__begin").click()`);
    } else if (!state.onboarding) {
      const text = await this.cdp.eval(BODY_TEXT).catch(() => "(page unreachable)");
      fatal(`neither the wordmark nor the flow is on screen.\n  On screen:\n${indent(text)}`);
    }

    await this.waitFor(`document.querySelector(".onboarding") !== null`, WAIT.screen, "the setup flow to take over");
  }

  async welcome() {
    const statement = await this.waitForStatement("Let's put this machine to work.", WAIT.screen, "the welcome screen");
    await this.shot("01-welcome");
    await this.clickControl("Scan this machine");
    return statement;
  }

  async scan() {
    const statement = await this.waitForStatement(SCAN_STATEMENTS, WAIT.screen, "the hardware scan");
    if (statement === "I couldn't read this machine.") {
      await this.shot("02-scan-error");
      fatal("the hardware scan failed on this machine.");
    }
    if (statement === "How much memory does it have?") {
      await this.shot("02-scan-memory");
      // The one read the flow cannot do without, and the one screen that offers
      // hand-entry. A runner reports its memory, so this is not expected — but
      // it is a real branch of the flow and driving it beats hanging on it.
      await this.chooseRadio("memory", String(16 * 1024 ** 3));
    }
    if (statement === "Having a look.") {
      await this.waitForStatement("Here's what this machine has.", WAIT.screen, "the scan to finish");
    }
    await this.shot("02-scan");
    await this.clickControl("Continue");
  }

  async lane() {
    await this.waitForStatement("One moment.", WAIT.screen, "the lane recommendation to start");
    // A gateway that cannot be reached is not an error here — the screen
    // recommends from the machine alone and says as much — so the only failure
    // this waits on is the one where memory could not be read at all.
    await this.waitForStatement(
      ["Your machine can run the Math lane.", "Your machine can run the Code lane.", "Your machine can run the Writing lane."],
      WAIT.screen,
      "a lane recommendation",
    );
    await this.shot("03-lane");
    await this.clickControl("Continue");
  }

  async download() {
    const ready = await this.waitForStatement(
      ["Ready when you are.", "There isn't room for this one."],
      WAIT.screen,
      "the download screen",
    );
    await this.shot("04-download-offer");
    if (ready === "There isn't room for this one.") {
      fatal("the runner's free disk is too small for the model the network assigned.");
    }

    await this.clickControl("Download");

    // Photograph the middle occasionally. The download is the longest thing here
    // and a screenshot of it is what says whether "Waiting for Ollama." was the
    // state it spent its time in.
    const progress = setInterval(() => {
      this.cdp
        .eval(STATEMENT)
        .then((s) => (s === "" ? null : this.shot(`04-download-${slug(s)}`)))
        .catch(() => {});
    }, 60_000);

    try {
      await this.waitForStatement("That's the model.", WAIT.download, "the model to finish downloading");
    } finally {
      clearInterval(progress);
    }
    await this.shot("04-download-done");
    await this.clickControl("Continue");
  }

  async limits() {
    await this.waitForStatement("When should this machine help?", WAIT.screen, "the first limit question");
    await this.chooseRadio("contribute", "idle");
    await this.shot("05-limits-when");
    await this.clickControl("Next");

    await this.waitForStatement("How much may it take?", WAIT.screen, "the second limit question");
    await this.chooseRadio("cap", "some");
    await this.shot("05-limits-how-much");
    await this.clickControl("Next");

    await this.waitForStatement("Should it rest overnight?", WAIT.screen, "the third limit question");
    await this.chooseRadio("quiet", "no");
    await this.shot("05-limits-overnight");
    await this.clickControl("Finish");
  }

  async join() {
    await this.waitForStatement("One last thing.", WAIT.screen, "the join screen");
    await this.shot("06-join-offer");
    await this.clickControl("Join the network");

    const ending = await this.waitForTerminal(WAIT.join);
    await this.shot("07-join-final");

    const caption = await this.cdp.eval(`(document.querySelector(".caption")?.innerText ?? "").trim()`);
    return { ...ending, caption };
  }
}

/* ------------------------------------ helpers ------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const indent = (text) => text.split("\n").map((line) => `    | ${line}`).join("\n");

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * How many distinct colours are in this PNG.
 *
 * Written out rather than pulled in because the repo has no JS dependencies and
 * this is the one question being asked of the bytes. Chrome emits 8-bit RGB or
 * RGBA, not interlaced; anything else reports `checked: false` and the caller
 * treats the frame as unverified rather than as bad.
 */
function pngColours(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return { checked: false };
  const idat = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (bitDepth !== 8 || interlace !== 0 || channels === 0 || width === 0 || height === 0) {
    return { checked: false };
  }

  let pixels;
  try {
    pixels = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, channels);
  } catch {
    return { checked: false };
  }

  const total = width * height;
  const step = Math.max(1, Math.floor(total / 200_000));
  const seen = new Set();
  for (let index = 0; index < total; index += step) {
    const at = index * channels;
    seen.add((pixels[at] << 16) | (pixels[at + 1] << 8) | pixels[at + 2]);
    if (seen.size > 64) break;
  }
  return { checked: true, width, height, colours: seen.size };
}

/** Reverse PNG's per-scanline filters, which is what turns the deflated stream
 *  into pixels. Five cases, and the fifth is the one that needs the arithmetic. */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const start = y * (stride + 1) + 1;
    const line = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(line, 0, start, start + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    previous = line;
  }
  return out;
}

/* ------------------------------------- attach ------------------------------------- */

async function attach() {
  const deadline = Date.now() + WAIT.attach * 1000;
  let lastReason = "nothing answered on the devtools port";
  note(`attaching to the app (pid ${APP_PID ?? "unknown"}) on ${DEVTOOLS}`);
  for (;;) {
    try {
      const version = await (await fetch(`${DEVTOOLS}/json/version`)).json();
      note(`attached to ${version.Browser}`);
      return version;
    } catch (error) {
      lastReason = error.message;
    }
    if (Date.now() > deadline) {
      fatal(
        `waited ${WAIT.attach}s for the app's devtools port at ${DEVTOOLS} and it never opened (${lastReason}).\n` +
          `  The workflow verified this port answered before the driver started, so the app most\n` +
          `  likely exited during the walk. pid ${APP_PID ?? "unknown"}. The app printed:\n${indent(appLogTail())}`,
      );
    }
    await sleep(500);
  }
}

async function pickTarget() {
  const targets = await (await fetch(`${DEVTOOLS}/json/list`)).json();
  // The app's own page first. The fallback is for the day Tauri changes the origin
  // it serves from: a driver that refuses to attach because it does not recognise
  // the URL would report a broken harness about a working app.
  const page =
    targets.find((t) => t.type === "page" && String(t.url).startsWith("http://tauri.localhost")) ??
    targets.find((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
  if (page === undefined) {
    fatal(
      `no page target for the app. Targets seen:\n${indent(
        targets.map((t) => `${t.type} ${t.url}`).join("\n") || "(none)",
      )}`,
    );
  }
  return page;
}

/* -------------------------------------- main -------------------------------------- */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  await attach();
  const target = await pickTarget();

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const trial = new Trial(cdp);
  try {
    await trial.begin();
    await trial.welcome();
    await trial.scan();
    await trial.lane();
    await trial.download();
    await trial.limits();
    const ending = await trial.join();

    // One line the workflow can grep, so the outcome of a run is legible without
    // reading fifty lines of log.
    note("");
    if (ending.kind === "live") {
      note("TRIAL RESULT: live — the setup ran end to end and the network can see this machine.");
    } else if (ending.kind === "registered") {
      note("TRIAL RESULT: registered — the setup ran end to end and the gateway could not reach this machine.");
      note("  That is the app handling it correctly, not the app failing: the gateway's own probe");
      note("  could not cross into a runner's tunnel, and the screen says exactly that.");
    } else {
      note(`TRIAL RESULT: error — the flow ended on ${JSON.stringify(ending.statement)}`);
      note(`  caption: ${ending.caption.replace(/\n/g, " / ")}`);
    }
    note(`TRIAL SHOTS: ${trial.shotCount} in ${SHOTS}`);

    if (ending.kind === "error") process.exitCode = 1;
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  if (error.expected) {
    note("");
    note(`TRIAL FAILED: ${error.message}`);
  } else {
    note("");
    note(`TRIAL FAILED (unexpected): ${error.stack ?? error.message}`);
    note(`  The app printed:\n${indent(appLogTail())}`);
  }
  process.exitCode = 1;
});
