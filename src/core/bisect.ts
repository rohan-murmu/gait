import { exec, truncate } from "./exec.js";
import { git, gitMaybe, isAncestor, changedFiles, diffStat, diffPatch, type FileChange } from "./git.js";
import { listCheckpoints, resolveCheckpoint, type Checkpoint } from "./checkpoint.js";
import { createSandbox, checkoutIn } from "./worktree.js";
import { runRepro, type OracleResult } from "./oracle.js";
import type { GaitConfig } from "./config.js";

/** Exit codes the per-step oracle uses; `git bisect run` defines the contract. */
export const STEP_EXIT = {
  pass: 0,
  fail: 1,
  /** git treats 125 as "cannot test this commit" and skips it. */
  skip: 125,
  /** >=128 aborts the bisection rather than blaming an untestable tree. */
  abort: 128,
} as const;

export interface BisectOptions {
  session: string;
  reproCommand: string;
  config: GaitConfig;
  /** Checkpoint id or commit-ish known to be good. Defaults to the oldest checkpoint. */
  good?: string;
  /** Checkpoint id known to be bad. Defaults to the newest checkpoint. */
  bad?: string;
  /** argv run inside the sandbox for each candidate, per STEP_EXIT. */
  stepArgv: string[];
}

export interface BisectStep {
  sha: string;
  short: string;
  verdict: "good" | "bad" | "skip";
  label: string | null;
}

export type BisectOutcome =
  | {
      kind: "found";
      firstBad: Checkpoint | { id: string; short: string; label: string | null };
      lastGood: { id: string; short: string };
      files: FileChange[];
      diffstat: string;
      patch: string;
      steps: BisectStep[];
      /** Test runs, including the two pre-flight checks. */
      runs: number;
      candidates: number;
      ms: number;
    }
  | { kind: "insufficient_checkpoints"; count: number; minimum: number }
  | { kind: "not_reproducible"; at: string; oracle: OracleResult }
  | { kind: "broken_from_start"; at: string; oracle: OracleResult }
  | { kind: "unrunnable"; at: string; oracle: OracleResult }
  | { kind: "bad_range"; good: string; bad: string }
  | { kind: "aborted"; reason: string };

/**
 * Find the checkpoint that turned the repro command from passing to failing.
 *
 * The search itself is `git bisect run` -- the chain is linear commits with real
 * parents, so git's own halving walks it natively and there is no reason to write
 * another binary search. What this adds is the three things git cannot do alone:
 * the states to search, a worktree the agent is not standing in, and pre-flight
 * checks so a bad question gets an honest answer instead of a confident wrong sha.
 */
export async function findBreakingChange(
  root: string,
  opts: BisectOptions,
): Promise<BisectOutcome> {
  const started = Date.now();
  const { config } = opts;
  const chain = await listCheckpoints(root, { session: opts.session });

  if (chain.length < config.minCheckpoints) {
    return { kind: "insufficient_checkpoints", count: chain.length, minimum: config.minCheckpoints };
  }

  const bad = opts.bad
    ? (await resolveCheckpoint(root, opts.session, opts.bad))?.id ?? opts.bad
    : chain[0]!.id;
  const good = opts.good
    ? (await resolveCheckpoint(root, opts.session, opts.good))?.id ?? opts.good
    : chain[chain.length - 1]!.id;

  if (bad === good || !(await isAncestor(good, bad, root))) {
    return { kind: "bad_range", good, bad };
  }

  const byId = new Map(chain.map((c) => [c.id, c]));
  const sandbox = await createSandbox(root, bad, config.linkPaths);
  let runs = 0;

  try {
    // Pre-flight 1: the failure must actually reproduce at the bad end. Without
    // this, a stale or wrong repro command bisects to a meaningless commit.
    const atBad = await runRepro(sandbox.path, opts.reproCommand, config.timeoutMs);
    runs++;
    if (atBad.verdict === "unrunnable" || atBad.verdict === "timeout") {
      return { kind: "unrunnable", at: short(bad), oracle: atBad };
    }
    if (atBad.verdict === "pass") {
      return { kind: "not_reproducible", at: short(bad), oracle: atBad };
    }

    // Pre-flight 2: it must pass at the good end, or the bug predates the session
    // and the answer is not in this chain at all.
    await checkoutIn(sandbox, good);
    const atGood = await runRepro(sandbox.path, opts.reproCommand, config.timeoutMs);
    runs++;
    if (atGood.verdict !== "pass") {
      return { kind: "broken_from_start", at: short(good), oracle: atGood };
    }

    await checkoutIn(sandbox, bad);
    await git(["bisect", "start", bad, good], { cwd: sandbox.path });

    const budget = config.timeoutMs * (Math.ceil(Math.log2(chain.length + 1)) + 2) + 30_000;
    const run = await exec("git", ["bisect", "run", ...opts.stepArgv], {
      cwd: sandbox.path,
      timeoutMs: budget,
    });

    const firstBadSha = await gitMaybe(["rev-parse", "--verify", "-q", "refs/bisect/bad"], {
      cwd: sandbox.path,
    });
    if (!firstBadSha) {
      return {
        kind: "aborted",
        reason: truncate([run.stdout, run.stderr].filter(Boolean).join("\n").trim(), 40),
      };
    }

    const steps = await parseTrace(sandbox.path, byId);
    runs += steps.length;

    const lastGoodSha = await git(["rev-parse", `${firstBadSha}^`], { cwd: sandbox.path });
    const files = await changedFiles(lastGoodSha, firstBadSha, root);
    const record = byId.get(firstBadSha);

    return {
      kind: "found",
      firstBad: record ?? { id: firstBadSha, short: short(firstBadSha), label: null },
      lastGood: { id: lastGoodSha, short: short(lastGoodSha) },
      files,
      diffstat: await diffStat(lastGoodSha, firstBadSha, root),
      patch: truncate(await diffPatch(lastGoodSha, firstBadSha, root), config.maxPatchLines),
      steps,
      runs,
      candidates: chain.length,
      ms: Date.now() - started,
    };
  } finally {
    await sandbox.dispose();
  }
}

const TRACE_LINE = /^git bisect (good|bad|skip) ([0-9a-f]{40})$/;

/** Each verdict git recorded, in the order it tested them. */
async function parseTrace(
  sandboxPath: string,
  byId: Map<string, Checkpoint>,
): Promise<BisectStep[]> {
  const log = await gitMaybe(["bisect", "log"], { cwd: sandboxPath });
  if (!log) return [];
  const steps: BisectStep[] = [];
  for (const line of log.split("\n")) {
    const match = TRACE_LINE.exec(line.trim());
    if (!match) continue;
    const verdict = match[1] as BisectStep["verdict"];
    const sha = match[2]!;
    steps.push({ sha, short: short(sha), verdict, label: byId.get(sha)?.label ?? null });
  }
  return steps;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
