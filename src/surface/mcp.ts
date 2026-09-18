import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { repoRoot, currentBranch, dirtyFileCount } from "../core/git.js";
import { loadConfig } from "../core/config.js";
import { createCheckpoint, listCheckpoints, currentSession } from "../core/checkpoint.js";
import { findBreakingChange } from "../core/bisect.js";
import { renderOutcome, renderCheckpoints } from "./render.js";
import { stepArgv } from "./self.js";

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

async function root(): Promise<string> {
  const found = await repoRoot(process.cwd());
  if (!found) throw new Error("not a git repository");
  return found;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "gait", version: "0.1.0" });

  // The headline tool. Its description is written as a trigger rather than a
  // summary: an agent only reaches for a tool when it can tell the tool applies to
  // the situation it is in, and the situation here is "something that used to work
  // now does not".
  server.registerTool(
    "gait_find_breaking_change",
    {
      title: "Find the edit that broke it",
      description:
        "Call this when something that used to work now fails AND the failure output does not " +
        "tell you which file is at fault -- a failing assertion, a wrong value, a behaviour " +
        "change, a test that passes alone but not in the suite. Do NOT re-read files to guess " +
        "what broke; gait snapshots the working tree after every edit and bisects those " +
        "snapshots to find the single edit that turned the command from passing to failing, " +
        "returning the files it changed and the patch. " +
        "Do NOT call this for compiler or linter errors: those already print the file and line, " +
        "so reading that line is faster and free. " +
        "Pass the exact failing command, as narrow as you can make it (one test file or one test " +
        "case, not the whole suite): a narrow command bisects faster and flakes far less.",
      inputSchema: {
        repro_command: z
          .string()
          .describe("The exact command that fails now and passed before, e.g. 'npx vitest run src/auth.test.ts'"),
        good: z
          .string()
          .optional()
          .describe("Checkpoint id or commit sha known to be good. Defaults to the oldest checkpoint in the session."),
        bad: z
          .string()
          .optional()
          .describe("Checkpoint id known to be bad. Defaults to the newest checkpoint."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repro_command, good, bad }) => {
      const dir = await root();
      const config = await loadConfig(dir);
      const outcome = await findBreakingChange(dir, {
        session: await currentSession(dir),
        reproCommand: repro_command,
        config,
        good,
        bad,
        stepArgv: stepArgv(repro_command, config.timeoutMs),
      });
      return text(renderOutcome(outcome, { reproCommand: repro_command, includePatch: true }));
    },
  );

  server.registerTool(
    "gait_checkpoint",
    {
      title: "Label a checkpoint",
      description:
        "Call this before starting a wide-reaching or risky change, so there is a labelled point " +
        "to bisect back to and restore from. Checkpoints are also taken automatically after every " +
        "file edit; this only adds a name, which makes a later bisect result readable.",
      inputSchema: {
        label: z.string().describe("What you are about to do, e.g. 'before refactoring the auth middleware'"),
      },
    },
    async ({ label }) => {
      const dir = await root();
      const result = await createCheckpoint(dir, { session: await currentSession(dir), label });
      return text(
        result.created
          ? `checkpoint ${result.checkpoint.short}: ${label}`
          : `no checkpoint taken: ${result.reason}`,
      );
    },
  );

  server.registerTool(
    "gait_checkpoint_log",
    {
      title: "List checkpoints",
      description:
        "List the checkpoints taken in this session, newest first. Useful for seeing how far back " +
        "the recoverable history goes before asking for a bisect.",
      inputSchema: { limit: z.number().int().positive().max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const dir = await root();
      const session = await currentSession(dir);
      const checkpoints = await listCheckpoints(dir, { session, limit: limit ?? 20 });
      return text(`session ${session}\n\n${renderCheckpoints(checkpoints)}`);
    },
  );

  server.registerTool(
    "gait_status",
    {
      title: "Repository and checkpoint status",
      description:
        "Branch, working tree size, current session, and how many checkpoints exist. Check this if " +
        "a bisect reports too few checkpoints, to confirm the auto-checkpoint hook is firing.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const dir = await root();
      const session = await currentSession(dir);
      const [branch, dirty, checkpoints, config] = await Promise.all([
        currentBranch(dir),
        dirtyFileCount(dir),
        listCheckpoints(dir, { session }),
        loadConfig(dir),
      ]);
      return text(
        [
          `branch: ${branch ?? "(detached)"}`,
          `working tree: ${dirty} files changed`,
          `session: ${session}`,
          `checkpoints: ${checkpoints.length}`,
          `fallback test command: ${config.testCommand ?? "(none)"}`,
        ].join("\n"),
      );
    },
  );

  // Deliberately not exposed: restore. It clobbers the working tree, which is a
  // decision for the developer, not for the agent that just broke something.
  await server.connect(new StdioServerTransport());
}
