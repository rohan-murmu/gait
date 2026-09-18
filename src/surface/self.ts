import { fileURLToPath } from "node:url";

/** Absolute path to the built CLI entry point. */
export const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

/**
 * The per-candidate oracle handed to `git bisect run`.
 *
 * Running our own binary rather than `sh -c "<command>"` buys three things git
 * cannot express on its own: a per-step timeout, 125 (skip) when a step times out
 * instead of a false "bad", and an abort when the command is missing rather than
 * blaming the first tree it happened to check out.
 */
export function stepArgv(reproCommand: string, timeoutMs: number): string[] {
  return [process.execPath, CLI_PATH, "_step", "--repro", reproCommand, "--timeout", String(timeoutMs)];
}
