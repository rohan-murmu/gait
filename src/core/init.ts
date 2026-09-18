import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, CONFIG_FILENAME, loadConfig, saveConfig } from "./config.js";
import { createCheckpoint, currentSession } from "./checkpoint.js";

const HOOK_COMMAND = "gait checkpoint --quiet";
const HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

const CLAUDE_SECTION = `## gait

When a test or build that was passing starts failing, do not re-read files to guess
what broke. Call \`gait_find_breaking_change\` with the exact failing command. It
bisects the checkpoints taken after every edit and returns the one edit that broke
it, with the files and the patch.

Call \`gait_checkpoint\` before starting a risky or wide-reaching change so there is
a labelled point to bisect back to.
`;

export interface InitReport {
  config: string;
  hookInstalled: boolean;
  hookAlreadyPresent: boolean;
  mcpInstalled: boolean;
  claudeMdUpdated: boolean;
  session: string;
  firstCheckpoint: string | null;
}

export async function init(root: string, opts: { testCommand?: string }): Promise<InitReport> {
  const existing = await loadConfig(root);
  const config = { ...DEFAULT_CONFIG, ...existing };
  if (opts.testCommand) config.testCommand = opts.testCommand;
  await saveConfig(root, config);

  const hook = await installHook(root);
  const mcpInstalled = await installMcp(root);
  const claudeMdUpdated = await appendClaudeSection(root);

  const session = await currentSession(root);
  const first = await createCheckpoint(root, { session, label: "gait init" });

  return {
    config: CONFIG_FILENAME,
    hookInstalled: hook.installed,
    hookAlreadyPresent: hook.alreadyPresent,
    mcpInstalled,
    claudeMdUpdated,
    session,
    firstCheckpoint: first.created ? first.checkpoint.short : null,
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * The auto-checkpoint hook is the load-bearing piece of the whole tool: it makes
 * the checkpoint chain exist without anyone remembering to ask for it. Everything
 * else is only useful because this fires.
 */
async function installHook(root: string): Promise<{ installed: boolean; alreadyPresent: boolean }> {
  const dir = join(root, ".claude");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "settings.json");

  type Settings = {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type: string; command: string; timeout?: number }> }>>;
  };
  const settings = (await readJson<Settings>(path)) ?? {};
  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];

  const present = settings.hooks.PostToolUse.some((entry) =>
    entry.hooks?.some((h) => h.command === HOOK_COMMAND),
  );
  if (present) return { installed: false, alreadyPresent: true };

  settings.hooks.PostToolUse.push({
    matcher: HOOK_MATCHER,
    // A short timeout matters: this runs on the agent's critical path after every
    // edit, and a slow or hung checkpoint is worse than no checkpoint at all.
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 10 }],
  });

  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { installed: true, alreadyPresent: false };
}

async function installMcp(root: string): Promise<boolean> {
  const path = join(root, ".mcp.json");
  type McpConfig = { mcpServers?: Record<string, { command: string; args?: string[] }> };
  const config = (await readJson<McpConfig>(path)) ?? {};
  config.mcpServers ??= {};
  if (config.mcpServers.gait) return false;
  config.mcpServers.gait = { command: "gait", args: ["mcp"] };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

async function appendClaudeSection(root: string): Promise<boolean> {
  const path = join(root, "CLAUDE.md");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    /* file will be created */
  }
  if (current.includes("## gait")) return false;
  const separator = current && !current.endsWith("\n\n") ? (current.endsWith("\n") ? "\n" : "\n\n") : "";
  await writeFile(path, `${current}${separator}${CLAUDE_SECTION}`, "utf8");
  return true;
}
