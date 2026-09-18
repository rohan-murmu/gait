import type { BisectOutcome } from "../core/bisect.js";
import type { Checkpoint } from "../core/checkpoint.js";

export interface RenderOptions {
  reproCommand: string;
  /** Include the patch of the breaking step. Agents want it; terminals usually do not. */
  includePatch: boolean;
}

/**
 * One renderer for both shells. The CLI and the MCP server format the same
 * structured outcome, so the answer an agent reads and the answer a human reads
 * can never drift apart.
 */
export function renderOutcome(outcome: BisectOutcome, opts: RenderOptions): string {
  switch (outcome.kind) {
    case "found": {
      const lines: string[] = [];
      const label = outcome.firstBad.label ? `  ${outcome.firstBad.label}` : "";
      lines.push(`first bad checkpoint: ${outcome.firstBad.short}${label}`);
      lines.push(`last good checkpoint: ${outcome.lastGood.short}`);
      lines.push("");
      lines.push(`files changed by that step (${outcome.files.length}):`);
      for (const f of outcome.files) lines.push(`  ${f.status}  ${f.path}`);
      if (outcome.diffstat) {
        lines.push("");
        lines.push(outcome.diffstat);
      }
      if (opts.includePatch && outcome.patch) {
        lines.push("");
        lines.push("```diff");
        lines.push(outcome.patch);
        lines.push("```");
      }
      lines.push("");
      lines.push(
        `${outcome.runs} test runs over ${outcome.candidates} checkpoints in ${(outcome.ms / 1000).toFixed(1)}s`,
      );
      return lines.join("\n");
    }

    case "insufficient_checkpoints":
      return [
        `Not enough checkpoints to bisect: ${outcome.count} (need ${outcome.minimum}).`,
        "",
        "A bisect over this chain would resolve to a range too coarse to act on, so",
        "gait is not guessing. Either the session just started, or the auto-checkpoint",
        "hook is not installed -- check `gait status` and re-run `gait init`.",
      ].join("\n");

    case "not_reproducible":
      return [
        `The repro command passes at the latest checkpoint (${outcome.at}), so there is`,
        "nothing to bisect.",
        "",
        `  command: ${opts.reproCommand}`,
        "",
        "Either the failure is already fixed, the command does not exercise it, or the",
        "failure depends on state outside the working tree (a database, a server, an",
        "environment variable) that a fresh worktree does not have.",
        "",
        outcome.oracle.output && `--- output ---\n${outcome.oracle.output}`,
      ]
        .filter(Boolean)
        .join("\n");

    case "broken_from_start":
      return [
        `The repro command already fails at the oldest checkpoint (${outcome.at}).`,
        "",
        "The break predates this session, so no agent edit in this chain caused it.",
        "Re-run with an explicitly good commit from real history:",
        "",
        "  gait why --good <sha-you-know-was-fine>",
        "",
        outcome.oracle.output && `--- output ---\n${outcome.oracle.output}`,
      ]
        .filter(Boolean)
        .join("\n");

    case "unrunnable":
      return [
        `The repro command could not be run at ${outcome.at} (${outcome.oracle.verdict}).`,
        "",
        `  command: ${opts.reproCommand}`,
        "",
        "git bisect would have read this as a failing test and blamed the first commit",
        "it tried, so gait stopped instead. Common causes: the command needs a build or",
        "install step the fresh worktree lacks, or a path in `linkPaths` is missing.",
        "",
        outcome.oracle.output && `--- output ---\n${outcome.oracle.output}`,
      ]
        .filter(Boolean)
        .join("\n");

    case "bad_range":
      return [
        `Cannot bisect ${outcome.good.slice(0, 7)}..${outcome.bad.slice(0, 7)}: the good end is`,
        "not an ancestor of the bad end. They are probably from different sessions.",
      ].join("\n");

    case "aborted":
      return `Bisect aborted before reaching an answer.\n\n${outcome.reason}`;
  }
}

export function renderTrace(outcome: BisectOutcome): string {
  if (outcome.kind !== "found") return "";
  return outcome.steps
    .map((s) => {
      const verdict = s.verdict === "bad" ? "FAIL" : s.verdict === "good" ? "PASS" : "SKIP";
      return `  ${verdict}  ${s.short}  ${s.label ?? ""}`.trimEnd();
    })
    .join("\n");
}

export function renderCheckpoints(checkpoints: Checkpoint[]): string {
  if (checkpoints.length === 0) return "no checkpoints yet";
  return checkpoints
    .map((c) => {
      const when = new Date(c.ts * 1000).toISOString().slice(0, 19).replace("T", " ");
      return `  ${c.short}  ${when}  ${c.label ?? "checkpoint"}`;
    })
    .join("\n");
}
