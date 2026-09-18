#!/usr/bin/env node
import { Command } from "commander";
import { repoRoot, dirtyFileCount, currentBranch } from "../core/git.js";
import { loadConfig } from "../core/config.js";
import {
  createCheckpoint,
  listCheckpoints,
  currentSession,
  newSession,
  resolveCheckpoint,
  restore,
} from "../core/checkpoint.js";
import { findBreakingChange, STEP_EXIT } from "../core/bisect.js";
import { runRepro } from "../core/oracle.js";
import { init } from "../core/init.js";
import { renderOutcome, renderTrace, renderCheckpoints } from "./render.js";
import { stepArgv } from "./self.js";

const program = new Command();
program
  .name("gait")
  .description("Finds the exact agent edit that broke your tests.")
  .version("0.1.0");

async function requireRoot(): Promise<string> {
  const root = await repoRoot(process.cwd());
  if (!root) {
    console.error("gait: not a git repository. gait requires git to already exist here.");
    process.exit(1);
  }
  return root;
}

program
  .command("init")
  .description("write gait.json, install the auto-checkpoint hook, register the MCP server")
  .option("--test <command>", "fallback repro command, e.g. \"npm test\"")
  .action(async (opts: { test?: string }) => {
    const root = await requireRoot();
    const report = await init(root, { testCommand: opts.test });
    console.log(`gait initialised in ${root}\n`);
    console.log(`  ${report.config}            config`);
    console.log(
      `  .claude/settings.json  auto-checkpoint hook ${report.hookAlreadyPresent ? "(already present)" : "installed"}`,
    );
    console.log(`  .mcp.json              ${report.mcpInstalled ? "gait MCP server registered" : "already registered"}`);
    console.log(`  CLAUDE.md              ${report.claudeMdUpdated ? "gait section added" : "already documented"}`);
    console.log(`\nsession ${report.session}${report.firstCheckpoint ? `, first checkpoint ${report.firstCheckpoint}` : ""}`);
    if (!opts.test) {
      console.log("\nNo fallback test command set. Pass --test \"<command>\", or let the agent");
      console.log("supply the exact failing command when it calls gait_find_breaking_change.");
    }
  });

program
  .command("checkpoint")
  .description("snapshot the working tree onto the session's checkpoint chain")
  .option("-m, --message <label>", "label for this checkpoint")
  .option("--quiet", "print nothing on success; for use from hooks")
  .action(async (opts: { message?: string; quiet?: boolean }) => {
    const root = await requireRoot();
    const session = await currentSession(root);
    const result = await createCheckpoint(root, { session, label: opts.message ?? null });
    if (opts.quiet) return;
    console.log(
      result.created
        ? `checkpoint ${result.checkpoint.short}  ${result.checkpoint.label ?? ""}`.trimEnd()
        : `no checkpoint: ${result.reason}`,
    );
  });

program
  .command("log")
  .description("list checkpoints in the current session")
  .option("-n, --number <count>", "how many to show", "20")
  .action(async (opts: { number: string }) => {
    const root = await requireRoot();
    const session = await currentSession(root);
    const checkpoints = await listCheckpoints(root, { session, limit: Number(opts.number) });
    console.log(`session ${session}\n`);
    console.log(renderCheckpoints(checkpoints));
  });

program
  .command("status")
  .description("branch, working tree, session, checkpoint count")
  .action(async () => {
    const root = await requireRoot();
    const session = await currentSession(root);
    const [branch, dirty, checkpoints, config] = await Promise.all([
      currentBranch(root),
      dirtyFileCount(root),
      listCheckpoints(root, { session }),
      loadConfig(root),
    ]);
    console.log(`branch       ${branch ?? "(detached)"}`);
    console.log(`working tree ${dirty} file${dirty === 1 ? "" : "s"} changed`);
    console.log(`session      ${session}`);
    console.log(`checkpoints  ${checkpoints.length}`);
    console.log(`test command ${config.testCommand ?? "(none configured)"}`);
    if (checkpoints.length < config.minCheckpoints) {
      console.log(
        `\nFewer than ${config.minCheckpoints} checkpoints: bisect is disabled until the chain is long`,
      );
      console.log("enough to give an actionable answer. Is the auto-checkpoint hook firing?");
    }
  });

program
  .command("why")
  .alias("bisect")
  .description("find the checkpoint that broke the repro command")
  .option("--repro <command>", "the exact failing command; narrower is faster and less flaky")
  .option("--good <id>", "checkpoint or commit known to be good (default: oldest checkpoint)")
  .option("--bad <id>", "checkpoint known to be bad (default: newest checkpoint)")
  .option("--patch", "include the patch of the breaking step")
  .action(async (opts: { repro?: string; good?: string; bad?: string; patch?: boolean }) => {
    const root = await requireRoot();
    const config = await loadConfig(root);
    const reproCommand = opts.repro ?? config.testCommand;
    if (!reproCommand) {
      console.error("gait: no repro command. Pass --repro \"<command>\" or set testCommand in gait.json.");
      process.exit(1);
    }
    const session = await currentSession(root);
    const outcome = await findBreakingChange(root, {
      session,
      reproCommand,
      config,
      good: opts.good,
      bad: opts.bad,
      stepArgv: stepArgv(reproCommand, config.timeoutMs),
    });
    const trace = renderTrace(outcome);
    if (trace) console.log(`${trace}\n`);
    console.log(renderOutcome(outcome, { reproCommand, includePatch: Boolean(opts.patch) }));
    if (outcome.kind !== "found") process.exit(2);
  });

program
  .command("restore <checkpoint>")
  .description("roll the working tree back to a checkpoint (current state is saved first)")
  .action(async (id: string) => {
    const root = await requireRoot();
    const session = await currentSession(root);
    const checkpoint = await resolveCheckpoint(root, session, id);
    if (!checkpoint) {
      console.error(`gait: no checkpoint matching "${id}" in session ${session}`);
      process.exit(1);
    }
    const result = await restore(root, checkpoint);
    console.log(`restored to ${checkpoint.short}  ${checkpoint.label ?? ""}`.trimEnd());
    console.log(`  ${result.written} files written, ${result.removed.length} removed`);
    if (result.safety) console.log(`  previous state saved as ${result.safety} in session restore-safety`);
  });

const session = program.command("session").description("manage checkpoint chains");
session
  .command("new [label]")
  .description("start a fresh checkpoint chain")
  .action(async (label?: string) => {
    const root = await requireRoot();
    console.log(`session ${await newSession(root, label)}`);
  });
session
  .command("show", { isDefault: true })
  .description("print the current session")
  .action(async () => {
    console.log(await currentSession(await requireRoot()));
  });

program
  .command("mcp")
  .description("run the MCP server on stdio")
  .action(async () => {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer();
  });

// Internal: one bisect step. Exit codes are the `git bisect run` contract.
program
  .command("_step", { hidden: true })
  .requiredOption("--repro <command>")
  .requiredOption("--timeout <ms>")
  .action(async (opts: { repro: string; timeout: string }) => {
    const result = await runRepro(process.cwd(), opts.repro, Number(opts.timeout), 10);
    switch (result.verdict) {
      case "pass":
        process.exit(STEP_EXIT.pass);
      case "fail":
        process.exit(STEP_EXIT.fail);
      case "timeout":
        process.exit(STEP_EXIT.skip);
      case "unrunnable":
        console.error(`gait: repro command could not be run: ${result.output}`);
        process.exit(STEP_EXIT.abort);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`gait: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
