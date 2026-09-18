import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface GaitConfig {
  /**
   * Fallback repro command. The agent should pass a narrower one -- a single
   * failing test is faster and less flaky than the whole suite -- but a human
   * running `gait why` with no arguments needs a default.
   */
  testCommand: string | null;
  /**
   * Ignored directories symlinked into the throwaway worktree. A fresh checkout
   * has no dependencies, and reinstalling per bisect step would dominate runtime
   * by orders of magnitude.
   */
  linkPaths: string[];
  /** Per-run timeout for the repro command. A hung test must not hang the bisect. */
  timeoutMs: number;
  /** Refuse to bisect below this many checkpoints; the answer would be too coarse to act on. */
  minCheckpoints: number;
  /** Lines of patch returned for the breaking step. */
  maxPatchLines: number;
}

export const DEFAULT_CONFIG: GaitConfig = {
  testCommand: null,
  linkPaths: ["node_modules", ".venv", "venv", "target", "vendor"],
  timeoutMs: 120_000,
  minCheckpoints: 3,
  maxPatchLines: 200,
};

export const CONFIG_FILENAME = "gait.json";

export async function loadConfig(root: string): Promise<GaitConfig> {
  try {
    const raw = await readFile(join(root, CONFIG_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<GaitConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(root: string, config: GaitConfig): Promise<void> {
  await writeFile(join(root, CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
