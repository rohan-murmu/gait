import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { git, gitMaybe, headCommit, treeOf, currentBranch, commonDir } from "./git.js";

export const CHECKPOINT_NS = "refs/gait/checkpoints";
export const SAFETY_SESSION = "restore-safety";

/** Separators chosen to never occur in a commit body. */
const FIELD = "\u001f";
const RECORD = "\u001e";

export interface Checkpoint {
  /** Full sha of the checkpoint commit object. */
  id: string;
  short: string;
  session: string;
  label: string | null;
  /** Unix seconds. */
  ts: number;
  /** Branch HEAD was on when this was taken. */
  branch: string | null;
  /** Commit HEAD pointed at, so a checkpoint can be located in real history. */
  head: string | null;
  parent: string | null;
}

interface CheckpointMeta {
  session: string;
  label: string | null;
  branch: string | null;
  head: string | null;
}

export type CreateResult =
  | { created: true; checkpoint: Checkpoint }
  | { created: false; reason: string };

/**
 * A checkpoint is a real commit object under refs/gait/checkpoints/<session>,
 * never on the user's branch.
 *
 * It is built through a throwaway index (GIT_INDEX_FILE), so HEAD, the index and
 * the working tree are never touched. Three consequences that matter:
 *
 *  - nothing appears in `git log`, `git status` or on any branch;
 *  - checkpointing cannot race with git commands the agent is running itself;
 *  - the objects are ref-reachable, so `gc` will not collect them.
 */
export async function createCheckpoint(
  root: string,
  opts: { session: string; label?: string | null },
): Promise<CreateResult> {
  const session = sanitizeSession(opts.session);
  const ref = `${CHECKPOINT_NS}/${session}`;
  const head = await headCommit(root);
  const branch = await currentBranch(root);

  const tmp = await mkdtemp(join(tmpdir(), "gait-index-"));
  const indexFile = join(tmp, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    if (head) await git(["read-tree", head], { cwd: root, env });
    // Respects .gitignore, so build output and dependencies stay out of the snapshot.
    await git(["add", "-A", "--", "."], { cwd: root, env });
    const tree = await git(["write-tree"], { cwd: root, env });

    const tip = await gitMaybe(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root });
    const parent = tip ?? head;

    if (parent) {
      const parentTree = await treeOf(parent, root);
      if (parentTree === tree) {
        return { created: false, reason: "no changes since last checkpoint" };
      }
    }

    const meta: CheckpointMeta = { session, label: opts.label ?? null, branch, head };
    const message = `${opts.label ?? "checkpoint"}\n\ngait-meta: ${JSON.stringify(meta)}\n`;
    const args = ["commit-tree", tree, "-m", message];
    if (parent) args.push("-p", parent);

    const id = await git(args, {
      cwd: root,
      env: {
        GIT_AUTHOR_NAME: "gait",
        GIT_AUTHOR_EMAIL: "gait@local",
        GIT_COMMITTER_NAME: "gait",
        GIT_COMMITTER_EMAIL: "gait@local",
      },
    });
    await git(["update-ref", ref, id], { cwd: root });

    return {
      created: true,
      checkpoint: {
        id,
        short: id.slice(0, 7),
        session,
        label: opts.label ?? null,
        ts: Math.floor(Date.now() / 1000),
        branch,
        head,
        parent,
      },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Checkpoints in a session, newest first. The chain is linear, so this is also
 * the range `git bisect` will search.
 */
export async function listCheckpoints(
  root: string,
  opts: { session: string; limit?: number },
): Promise<Checkpoint[]> {
  const ref = `${CHECKPOINT_NS}/${sanitizeSession(opts.session)}`;
  const exists = await gitMaybe(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: root });
  if (!exists) return [];

  const format = ["%H", "%h", "%ct", "%P", "%s", "%b"].join(FIELD) + RECORD;
  const args = ["log", `--format=${format}`, ref];
  if (opts.limit) args.push(`--max-count=${opts.limit}`);

  const out = await git(args, { cwd: root });
  const checkpoints: Checkpoint[] = [];

  for (const record of out.split(RECORD)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [id = "", short = "", ts = "0", parents = "", subject = "", body = ""] =
      trimmed.split(FIELD);
    const meta = parseMeta(body);
    // The chain is rooted at a real HEAD commit; stop before walking real history.
    if (!meta) break;
    checkpoints.push({
      id,
      short,
      session: meta.session,
      label: meta.label,
      ts: Number(ts),
      branch: meta.branch,
      head: meta.head,
      parent: parents.split(" ")[0] || null,
    });
  }
  return checkpoints;
}

function parseMeta(body: string): CheckpointMeta | null {
  const line = body.split("\n").find((l) => l.startsWith("gait-meta: "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("gait-meta: ".length)) as CheckpointMeta;
  } catch {
    return null;
  }
}

/** Resolve a short id, full sha, or "latest" against a session's chain. */
export async function resolveCheckpoint(
  root: string,
  session: string,
  idOrAlias: string,
): Promise<Checkpoint | null> {
  const all = await listCheckpoints(root, { session });
  if (idOrAlias === "latest" || idOrAlias === "tip") return all[0] ?? null;
  if (idOrAlias === "first" || idOrAlias === "start") return all[all.length - 1] ?? null;
  return all.find((c) => c.id === idOrAlias || c.id.startsWith(idOrAlias)) ?? null;
}

// --- session state -------------------------------------------------------
// Sessions live in the common git dir, so every linked worktree agrees on which
// chain is current.

async function stateDir(root: string): Promise<string> {
  const dir = join(await commonDir(root), "gait");
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function currentSession(root: string): Promise<string> {
  const file = join(await stateDir(root), "session");
  try {
    const value = (await readFile(file, "utf8")).trim();
    if (value) return value;
  } catch {
    /* fall through to creating one */
  }
  return newSession(root);
}

export async function newSession(root: string, label?: string): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = randomBytes(3).toString("hex");
  const session = sanitizeSession(label ? `${stamp}-${label}-${suffix}` : `${stamp}-${suffix}`);
  await writeFile(join(await stateDir(root), "session"), `${session}\n`, "utf8");
  return session;
}

export function sanitizeSession(session: string): string {
  const clean = session.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return clean || "default";
}

/**
 * Roll the working tree back to a checkpoint. The one destructive command, so it
 * snapshots current state under a safety session before touching anything.
 *
 * Materialised through a throwaway index so the user's staged state survives, and
 * files created after the checkpoint are removed -- a plain `checkout -- .` would
 * leave them behind and produce a tree that never existed.
 */
export async function restore(
  root: string,
  checkpoint: Checkpoint,
): Promise<{ safety: string | null; written: number; removed: string[] }> {
  const safetyResult = await createCheckpoint(root, {
    session: SAFETY_SESSION,
    label: `before restore to ${checkpoint.short}`,
  });

  const target = new Set(
    (await git(["ls-tree", "-r", "--name-only", checkpoint.id], { cwd: root }))
      .split("\n")
      .filter(Boolean),
  );
  const present = (
    await git(["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root })
  )
    .split("\n")
    .filter(Boolean);

  const tmp = await mkdtemp(join(tmpdir(), "gait-restore-"));
  const removed: string[] = [];
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    await git(["read-tree", checkpoint.id], { cwd: root, env });
    await git(["checkout-index", "-a", "-f"], { cwd: root, env });

    for (const file of present) {
      if (target.has(file)) continue;
      await rm(join(root, file), { force: true });
      removed.push(file);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  return {
    safety: safetyResult.created ? safetyResult.checkpoint.short : null,
    written: target.size,
    removed,
  };
}
