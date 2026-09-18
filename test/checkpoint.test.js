import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

test("checkpoints are invisible to the user's git", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);

  await fx.gait("init");
  await fx.write("src/math.js", "export function add(a, b) { return a + b; } // edited\n");

  // Captured after the edit: checkpointing must change nothing that git reports.
  const headBefore = await fx.git(["rev-parse", "HEAD"]);
  const statusBefore = await fx.git(["status", "--porcelain"]);

  const result = await fx.gait("checkpoint", "-m", "an edit");
  assert.match(result.out, /^checkpoint [0-9a-f]{7}  an edit/);

  assert.equal(await fx.git(["rev-parse", "HEAD"]), headBefore, "HEAD moved");
  assert.equal(await fx.git(["status", "--porcelain"]), statusBefore, "index or tree changed");
  assert.equal(await fx.git(["branch", "--list", "--all"]).then((s) => s.includes("gait")), false);

  const refs = await fx.git(["for-each-ref", "--format=%(refname)", "refs/gait"]);
  assert.match(refs, /^refs\/gait\/checkpoints\//m, "no checkpoint ref written");
});

test("an unchanged tree does not produce a duplicate checkpoint", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);

  await fx.gait("init");
  await fx.write("src/math.js", "export function add(a, b) { return a + b; } // once\n");
  await fx.gait("checkpoint", "-m", "first");
  const again = await fx.gait("checkpoint", "-m", "second");

  assert.match(again.out, /no checkpoint: no changes since last checkpoint/);
});

test("gitignored paths stay out of the snapshot", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);

  await fx.write(".gitignore", "junk/\n");
  await fx.gait("init");
  await mkdir(join(fx.root, "junk"), { recursive: true });
  await writeFile(join(fx.root, "junk/build.log"), "noise\n");
  await fx.write("src/math.js", "export function add(a, b) { return a + b; } // v2\n");
  await fx.gait("checkpoint", "-m", "with junk");

  const tip = await fx.git(["rev-parse", "refs/gait/checkpoints/" + (await fx.gait("session")).out.trim()]);
  const tree = await fx.git(["ls-tree", "-r", "--name-only", tip]);
  assert.equal(tree.includes("junk/"), false, "ignored path was snapshotted");
});

test("restore rolls back content, removes new files, and saves a safety checkpoint", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);

  await fx.gait("init");
  await fx.write("src/math.js", "export function add(a, b) { return a + b; } // good\n");
  const created = await fx.gait("checkpoint", "-m", "known good");
  const good = created.out.match(/checkpoint ([0-9a-f]{7})/)[1];

  await fx.write("src/math.js", "GARBAGE\n");
  await fx.write("src/stray.js", "export const x = 1;\n");
  await fx.gait("checkpoint", "-m", "agent broke it");

  const restored = await fx.gait("restore", good);
  assert.match(restored.out, /restored to/);
  assert.match(restored.out, /1 removed/);
  assert.match(restored.out, /saved as [0-9a-f]{7} in session restore-safety/);

  const body = await readFile(join(fx.root, "src/math.js"), "utf8");
  assert.equal(body.trim(), "export function add(a, b) { return a + b; } // good");
  await assert.rejects(readFile(join(fx.root, "src/stray.js"), "utf8"), /ENOENT/);
});
