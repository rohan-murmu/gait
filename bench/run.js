#!/usr/bin/env node
// Measures how much gait narrows the search for a regression introduced mid-session.
//
// For each scenario: copy the target repo to a scratch dir, replay an agent session of
// ordinary edits with one regression injected at a known position, then compare what an
// agent would have to read without gait against what gait returns.
//
//   node bench/run.js bench/configs/self.js
//   node bench/run.js path/to/your-config.js

import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const CLI = resolve(import.meta.dirname, "../dist/surface/cli.js");

const sh = async (cwd, cmd, args, ok = false) => {
  try {
    return (await run(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (ok) return (error.stdout ?? "") + (error.stderr ?? "");
    throw error;
  }
};
const git = (cwd, ...args) => sh(cwd, "git", args);
const gait = (cwd, ...args) => sh(cwd, process.execPath, [CLI, ...args], true);

async function measure(config, scenario) {
  const dir = await mkdtemp(join(tmpdir(), "gait-bench-"));
  try {
    await cp(config.repo, dir, {
      recursive: true,
      filter: (src) => !/(^|\/)(\.git|node_modules|dist|target)(\/|$)/.test(src),
    });
    await git(dir, "init", "-q", ".");
    await git(dir, "config", "user.email", "bench@bench");
    await git(dir, "config", "user.name", "bench");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "baseline");
    await gait(dir, "init", "--test", config.testCommand);

    for (let i = 1; i <= config.edits; i++) {
      if (i === scenario.at) {
        await scenario.inject(dir);
        await gait(dir, "checkpoint", "-m", `edit ${i}: ${scenario.name} change`);
      } else {
        await config.churn(dir, i);
        await gait(dir, "checkpoint", "-m", `edit ${i}: routine change`);
      }
    }

    // Baseline: everything an agent without gait has to consider.
    const changed = (await git(dir, "diff", "--name-only", "HEAD")).split("\n").filter(Boolean);
    const diffLines = (await git(dir, "diff", "HEAD")).split("\n").length;
    const fileLines = (
      await sh(dir, "sh", ["-c", `wc -l ${changed.map((f) => `'${f}'`).join(" ")} | tail -1`], true)
    ).trim().split(/\s+/)[0];

    // gait.
    const t0 = Date.now();
    const out = await gait(dir, "why", "--repro", config.testCommand, "--patch");
    const ms = Date.now() - t0;

    const identified = /first bad checkpoint: \S+\s+(.*)/.exec(out)?.[1]?.trim() ?? null;
    const correct = identified?.startsWith(`edit ${scenario.at}:`) ?? false;
    const gaitFiles = (out.match(/^  [A-Z]\s+\S+$/gm) ?? []).length;
    const runs = Number(/(\d+) test runs/.exec(out)?.[1] ?? 0);
    const candidates = Number(/test runs over (\d+)/.exec(out)?.[1] ?? 0);
    const patchLines = (out.match(/```diff\n([\s\S]*?)```/)?.[1] ?? "").split("\n").length;

    return {
      name: scenario.name,
      correct,
      identified,
      baseFiles: changed.length,
      baseFileLines: Number(fileLines) || 0,
      diffLines,
      gaitFiles,
      patchLines,
      runs,
      candidates,
      linear: Math.max(candidates - 1, 1),
      ms,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pct = (before, after) => (before <= 0 ? 0 : ((before - after) / before) * 100);
const cell = (before, after) => `${before} → ${after}, ${pct(before, after).toFixed(0)}% fewer`;

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node bench/run.js <config.js>");
  process.exit(1);
}
const config = (await import(pathToFileURL(resolve(configPath)).href)).default;

const results = [];
for (const scenario of config.scenarios) {
  process.stderr.write(`running ${scenario.name}... `);
  const result = await measure(config, scenario);
  process.stderr.write(`${result.correct ? "correct" : "WRONG"} (${(result.ms / 1000).toFixed(1)}s)\n`);
  results.push(result);
}

console.log(`\n### ${config.name}\n`);
console.log("| scenario | found | files to inspect | lines to read | test runs vs linear |");
console.log("| --- | --- | --- | --- | --- |");
for (const r of results) {
  console.log(
    `| ${r.name} | ${r.correct ? "yes" : "**NO**"} | ${cell(r.baseFiles, r.gaitFiles)} | ` +
      `${cell(r.diffLines, r.patchLines)} | ${cell(r.linear, r.runs)} |`,
  );
}
const mean = (f) => results.reduce((s, r) => s + f(r), 0) / results.length;
console.log(
  `| **mean** | **${results.filter((r) => r.correct).length}/${results.length}** | ` +
    `**${mean((r) => pct(r.baseFiles, r.gaitFiles)).toFixed(0)}% fewer** | ` +
    `**${mean((r) => pct(r.diffLines, r.patchLines)).toFixed(0)}% fewer** | ` +
    `**${mean((r) => pct(r.linear, r.runs)).toFixed(0)}% fewer** |`,
);
console.log(`\nMean wall clock ${(mean((r) => r.ms) / 1000).toFixed(1)}s.`);

process.exit(results.every((r) => r.correct) ? 0 : 1);
