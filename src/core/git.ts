import { exec, type ExecOptions } from "./exec.js";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Run git and return trimmed stdout. Throws GitError on non-zero exit. */
export async function git(args: string[], opts: GitOptions): Promise<string> {
  const res = await exec("git", args, opts as ExecOptions);
  if (res.code !== 0) throw new GitError(args, res.code, res.stderr);
  return res.stdout.trim();
}

/** Run git, returning null instead of throwing. For existence checks. */
export async function gitMaybe(args: string[], opts: GitOptions): Promise<string | null> {
  const res = await exec("git", args, opts as ExecOptions);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Absolute path to the top of the working tree, or null if cwd is not in a repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  return gitMaybe(["rev-parse", "--show-toplevel"], { cwd });
}

/**
 * The common git directory -- shared by all worktrees. Checkpoint refs and gait
 * state live here so a linked worktree sees the same chain as the main one.
 */
export async function commonDir(root: string): Promise<string> {
  const dir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
  return dir;
}

export async function headCommit(root: string): Promise<string | null> {
  return gitMaybe(["rev-parse", "--verify", "HEAD"], { cwd: root });
}

export async function currentBranch(root: string): Promise<string | null> {
  const name = await gitMaybe(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root });
  return name || null;
}

export async function treeOf(commit: string, root: string): Promise<string> {
  return git(["rev-parse", `${commit}^{tree}`], { cwd: root });
}

export async function shortSha(commit: string, root: string): Promise<string> {
  return git(["rev-parse", "--short", commit], { cwd: root });
}

/** True if `ancestor` is reachable from `descendant`. Bisect requires this. */
export async function isAncestor(ancestor: string, descendant: string, root: string): Promise<boolean> {
  const res = await exec("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root });
  return res.code === 0;
}

export interface FileChange {
  status: string;
  path: string;
}

export async function changedFiles(from: string, to: string, root: string): Promise<FileChange[]> {
  const out = await git(["diff", "--name-status", "-M", from, to], { cwd: root });
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [status = "?", ...rest] = line.split("\t");
    return { status, path: rest[rest.length - 1] ?? "" };
  });
}

export async function diffStat(from: string, to: string, root: string): Promise<string> {
  return git(["diff", "--stat", "-M", from, to], { cwd: root });
}

export async function diffPatch(from: string, to: string, root: string, paths: string[] = []): Promise<string> {
  const args = ["diff", "-M", "--no-color", from, to];
  if (paths.length > 0) args.push("--", ...paths);
  return git(args, { cwd: root });
}

/** Number of entries reported by `status --porcelain`. */
export async function dirtyFileCount(root: string): Promise<number> {
  const out = await git(["status", "--porcelain"], { cwd: root });
  return out ? out.split("\n").filter(Boolean).length : 0;
}
