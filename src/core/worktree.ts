import { mkdtemp, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitMaybe } from "./git.js";

export interface Sandbox {
  /** Absolute path to the throwaway worktree. */
  path: string;
  /** Link paths that were requested but not found in the main working tree. */
  missingLinks: string[];
  dispose(): Promise<void>;
}

/**
 * A detached worktree at `commit`, isolated from the user's working tree.
 *
 * This is what makes bisecting safe while an agent is still running: `git bisect`
 * rewrites the working tree on every step, and doing that to the tree the agent is
 * editing would corrupt its world. Bisect state is per-worktree, so the main
 * checkout never even learns a bisect happened.
 */
export async function createSandbox(
  root: string,
  commit: string,
  linkPaths: string[],
): Promise<Sandbox> {
  const container = await mkdtemp(join(tmpdir(), "gait-wt-"));
  const path = join(container, "tree");

  await git(["worktree", "add", "--detach", "--no-checkout", path, commit], { cwd: root });

  // Link dependencies before checkout so the first test run does not pay for an install.
  const missingLinks: string[] = [];
  for (const rel of linkPaths) {
    const source = join(root, rel);
    try {
      await access(source);
    } catch {
      missingLinks.push(rel);
      continue;
    }
    try {
      await symlink(source, join(path, rel), "dir");
    } catch {
      // A link path that is tracked in the tree will be written by checkout; skip it.
      missingLinks.push(rel);
    }
  }

  await git(["checkout", "--force", commit, "--", "."], { cwd: path }).catch(async () => {
    await git(["checkout", "--force", commit], { cwd: path });
  });

  return {
    path,
    missingLinks,
    async dispose() {
      await gitMaybe(["bisect", "reset"], { cwd: path });
      await gitMaybe(["worktree", "remove", "--force", path], { cwd: root });
      await rm(container, { recursive: true, force: true });
      await gitMaybe(["worktree", "prune"], { cwd: root });
    },
  };
}

/**
 * Move the sandbox to a different commit, discarding anything the previous run
 * wrote. `clean -fd` (without -x) drops test artifacts while leaving ignored
 * paths -- and therefore the dependency symlinks -- in place.
 */
export async function checkoutIn(sandbox: Sandbox, commit: string): Promise<void> {
  await git(["checkout", "--force", "--detach", commit], { cwd: sandbox.path });
  await gitMaybe(["clean", "-fdq"], { cwd: sandbox.path });
}
