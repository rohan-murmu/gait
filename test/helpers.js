import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CLI = new URL("../dist/surface/cli.js", import.meta.url).pathname;

/** A git repo with a trivial node test that passes, plus gait initialised. */
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gait-test-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/math.js"),
    "export function add(a, b) { return a + b; }\n",
  );
  await writeFile(
    join(root, "test.js"),
    [
      'import { add } from "./src/math.js";',
      'import assert from "node:assert";',
      "assert.strictEqual(add(2, 3), 5);",
    ].join("\n") + "\n",
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');

  await git(root, ["init", "-q", "."]);
  await git(root, ["config", "user.email", "test@test"]);
  await git(root, ["config", "user.name", "test"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "initial"]);

  return {
    root,
    gait: (...args) => gait(root, args),
    git: (args) => git(root, args),
    write: (rel, body) => writeFile(join(root, rel), body),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function gait(cwd, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, out: (error.stdout ?? "") + (error.stderr ?? "") };
  }
}

export async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

/** Six checkpointed edits; the third breaks `node test.js`. */
export async function sessionWithBreakAtEditThree(fx) {
  await fx.gait("init", "--test", "node test.js");
  const edits = [
    ["edit 1: comment", "export function add(a, b) { return a + b; }\n// doc\n"],
    ["edit 2: constant", "export function add(a, b) { return a + b; }\n// doc\nexport const V = 1;\n"],
    ["edit 3: refactor add", "export function add(a, b) { return a - b; }\n// doc\nexport const V = 1;\n"],
    ["edit 4: unrelated", "export function add(a, b) { return a - b; }\n// doc\nexport const V = 1;\n// x\n"],
    ["edit 5: constant", "export function add(a, b) { return a - b; }\n// doc\nexport const V = 1;\n// x\nexport const W = 2;\n"],
  ];
  for (const [label, body] of edits) {
    await fx.write("src/math.js", body);
    await fx.gait("checkpoint", "-m", label);
  }
}
