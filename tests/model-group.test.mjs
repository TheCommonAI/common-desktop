/**
 * The model group panel's rules, pinned.
 *
 * The panel is mostly a view over two answers: what the group's file says and what
 * the coordinator's health endpoint says. The decisions that could quietly mislead
 * are the ones pinned here: the draft length the control may write, the port the
 * panel will probe and start on, what the stored settings fall back to, and the
 * sentence that says whether Start may be pressed.
 *
 * `src/chat/group-config.ts` has no imports, so it is loaded as it is. Node strips
 * the types. The Rust side of the same rules is tested in `src-tauri/src/group.rs`.
 *
 * Run it with: node --test tests/model-group.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const config = await import(
  fileURLToPath(new URL("../src/chat/group-config.ts", import.meta.url))
);

const {
  DEFAULT_GROUP_PORT,
  DEFAULT_SETTINGS,
  DRAFT_TOKENS_MAX,
  DRAFT_TOKENS_MIN,
  clampDraftTokens,
  groupFact,
  healthLabel,
  isGroupPort,
  readSettings,
  startBlock,
} = config;

function status(overrides = {}) {
  return {
    configured: true,
    problem: null,
    modelName: "Qwen3-32B",
    devices: 2,
    draftTokens: 4,
    health: "stopped",
    coordinator: { state: "none" },
    port: DEFAULT_GROUP_PORT,
    ...overrides,
  };
}

test("a draft length is held inside the range the CLI states, and rounded", () => {
  assert.equal(DRAFT_TOKENS_MIN, 1);
  assert.equal(DRAFT_TOKENS_MAX, 32);
  assert.equal(clampDraftTokens(0), 1);
  assert.equal(clampDraftTokens(-7), 1);
  assert.equal(clampDraftTokens(1), 1);
  assert.equal(clampDraftTokens(4), 4);
  assert.equal(clampDraftTokens(32), 32);
  assert.equal(clampDraftTokens(33), 32);
  assert.equal(clampDraftTokens(4.4), 4);
  assert.equal(clampDraftTokens(4.6), 5);
});

test("a draft length that is not a number at all is refused rather than written", () => {
  assert.equal(clampDraftTokens(Number.NaN), null);
  assert.equal(clampDraftTokens(Number.POSITIVE_INFINITY), null);
  assert.equal(clampDraftTokens(Number.NEGATIVE_INFINITY), null);
});

test("a port is an integer from 1024 to 65535, and nothing else", () => {
  assert.equal(isGroupPort(1023), false);
  assert.equal(isGroupPort(1024), true);
  assert.equal(isGroupPort(DEFAULT_GROUP_PORT), true);
  assert.equal(isGroupPort(65535), true);
  assert.equal(isGroupPort(65536), false);
  assert.equal(isGroupPort(11436.5), false);
  assert.equal(isGroupPort(Number.NaN), false);
});

test("the default port is not the one a normal join's llama-server uses", () => {
  assert.equal(DEFAULT_GROUP_PORT, 11437);
  assert.notEqual(DEFAULT_GROUP_PORT, 11436);
});

test("stored settings fall back to the defaults, field by field", () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings("not json"), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings("null"), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings("42"), DEFAULT_SETTINGS);

  assert.deepEqual(
    readSettings(JSON.stringify({ configPath: "/networks/a.json", port: 11437 })),
    { configPath: "/networks/a.json", port: 11437 },
  );

  // A bad port does not discard a good path, and a bad path does not discard a port.
  assert.deepEqual(
    readSettings(JSON.stringify({ configPath: "/networks/a.json", port: 80 })),
    { configPath: "/networks/a.json", port: DEFAULT_GROUP_PORT },
  );
  assert.deepEqual(
    readSettings(JSON.stringify({ configPath: 7, port: 11500 })),
    { configPath: "", port: 11500 },
  );
});

test("health is named in the words the panel shows", () => {
  assert.equal(healthLabel("ready"), "Ready");
  assert.equal(healthLabel("loading"), "Loading");
  assert.equal(healthLabel("stopped"), "Stopped");
});

test("the group sentence names the model and counts the devices, singular or plural", () => {
  assert.equal(groupFact(status()), "Qwen3-32B, across 2 RPC devices.");
  assert.equal(groupFact(status({ devices: 1 })), "Qwen3-32B, across 1 RPC device.");
});

test("a group that is not configured says why, or that none is chosen", () => {
  assert.equal(groupFact(status({ configured: false, modelName: null, devices: null })), "No group is chosen.");
  assert.equal(
    groupFact(
      status({
        configured: false,
        modelName: null,
        devices: null,
        problem: "draft_tokens must be a whole number from 1 to 32",
      }),
    ),
    "draft_tokens must be a whole number from 1 to 32",
  );
});

test("Start is refused on a port that is not a usable coordinator port", () => {
  assert.equal(startBlock(status(), DEFAULT_GROUP_PORT), null);
  assert.match(startBlock(status(), 80), /1024/);
});

test("Start is refused with no group chosen, and while a coordinator is already running", () => {
  assert.match(
    startBlock(status({ configured: false, modelName: null, devices: null }), DEFAULT_GROUP_PORT),
    /network\.json/,
  );
  assert.match(
    startBlock(status({ coordinator: { state: "running" } }), DEFAULT_GROUP_PORT),
    /already running/,
  );
});
