import { execShell, truncate } from "./exec.js";

export type Verdict = "pass" | "fail" | "timeout" | "unrunnable";

export interface OracleResult {
  verdict: Verdict;
  code: number | null;
  ms: number;
  output: string;
}

/**
 * The oracle decides whether a given tree is good or bad. Exit 0 is pass, anything
 * else is fail -- the same contract `git bisect run` uses, which is why the repro
 * command can be handed straight to it.
 *
 * 127 is called out separately: git bisect would read "command not found" as a
 * failing test and confidently blame the first commit it tried.
 */
export async function runRepro(
  cwd: string,
  command: string,
  timeoutMs: number,
  outputLines = 60,
): Promise<OracleResult> {
  const res = await execShell(command, { cwd, timeoutMs });
  const output = truncate([res.stdout, res.stderr].filter(Boolean).join("\n").trim(), outputLines);

  let verdict: Verdict;
  if (res.timedOut) verdict = "timeout";
  else if (res.code === 0) verdict = "pass";
  else if (res.code === 127 || res.code === null) verdict = "unrunnable";
  else verdict = "fail";

  return { verdict, code: res.code, ms: res.ms, output };
}
