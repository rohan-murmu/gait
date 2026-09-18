import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fixture, sessionWithBreakAtEditThree } from "./helpers.js";

test("finds the exact edit that broke the command", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await sessionWithBreakAtEditThree(fx);

  const result = await fx.gait("why", "--repro", "node test.js", "--patch");
  assert.equal(result.code, 0);
  assert.match(result.out, /first bad checkpoint: [0-9a-f]{7}  edit 3: refactor add/);
  assert.match(result.out, /last good checkpoint: [0-9a-f]{7}/);
  assert.match(result.out, /M  src\/math\.js/);
  assert.match(result.out, /-export function add\(a, b\) \{ return a \+ b; \}/);
  assert.match(result.out, /\+export function add\(a, b\) \{ return a - b; \}/);
});

test("the search is logarithmic, not linear", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await fx.gait("init", "--test", "node test.js");

  // 16 edits, the break at #12.
  for (let i = 1; i <= 16; i++) {
    const op = i >= 12 ? "-" : "+";
    await fx.write(
      "src/math.js",
      `export function add(a, b) { return a ${op} b; }\n${"// pad\n".repeat(i)}`,
    );
    await fx.gait("checkpoint", "-m", `edit ${i}`);
  }

  const result = await fx.gait("why", "--repro", "node test.js");
  assert.match(result.out, /first bad checkpoint: [0-9a-f]{7}  edit 12/);

  const runs = Number(result.out.match(/(\d+) test runs over (\d+) checkpoints/)[1]);
  const candidates = Number(result.out.match(/(\d+) test runs over (\d+) checkpoints/)[2]);
  assert.ok(candidates >= 17, `expected the full chain, got ${candidates}`);
  // 2 pre-flight runs + ceil(log2(n)) steps, with headroom.
  assert.ok(runs <= 2 + Math.ceil(Math.log2(candidates)) + 1, `${runs} runs over ${candidates} is not logarithmic`);
});

test("refuses when the chain is too short to be actionable", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await fx.gait("init", "--test", "node test.js");

  const result = await fx.gait("why", "--repro", "node test.js");
  assert.equal(result.code, 2);
  assert.match(result.out, /Not enough checkpoints to bisect: 1 \(need 3\)/);
});

test("refuses when the command already passes at the tip", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await sessionWithBreakAtEditThree(fx);

  const result = await fx.gait("why", "--repro", "node -e 'process.exit(0)'");
  assert.equal(result.code, 2);
  assert.match(result.out, /passes at the latest checkpoint/);
});

test("refuses when the break predates the session", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await sessionWithBreakAtEditThree(fx);

  const result = await fx.gait("why", "--repro", "node -e 'process.exit(1)'");
  assert.equal(result.code, 2);
  assert.match(result.out, /already fails at the oldest checkpoint/);
  assert.match(result.out, /gait why --good/);
});

test("aborts on a missing command instead of blaming a commit", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await sessionWithBreakAtEditThree(fx);

  const result = await fx.gait("why", "--repro", "definitely-not-a-real-command");
  assert.equal(result.code, 2);
  assert.match(result.out, /could not be run/);
  assert.equal(/first bad checkpoint/.test(result.out), false, "blamed a commit anyway");
});

test("leaves the working tree and worktree list untouched", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await sessionWithBreakAtEditThree(fx);

  const statusBefore = await fx.git(["status", "--porcelain"]);
  const headBefore = await fx.git(["rev-parse", "HEAD"]);
  const tmpBefore = (await readdir(tmpdir())).filter((n) => n.startsWith("gait-wt-")).length;

  await fx.gait("why", "--repro", "node test.js");

  assert.equal(await fx.git(["status", "--porcelain"]), statusBefore);
  assert.equal(await fx.git(["rev-parse", "HEAD"]), headBefore);
  assert.equal((await fx.git(["worktree", "list"])).split("\n").length, 1, "left a worktree behind");
  const tmpAfter = (await readdir(tmpdir())).filter((n) => n.startsWith("gait-wt-")).length;
  assert.equal(tmpAfter, tmpBefore, "leaked a temp directory");
});
