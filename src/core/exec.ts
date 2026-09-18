import { spawn } from "node:child_process";

export interface ExecResult {
  /** Exit code, or null if the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Wall-clock duration in milliseconds. */
  ms: number;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Cap on captured output per stream; the middle is elided beyond this. */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 512 * 1024;

/**
 * Spawn a process and capture its output. Never throws on a non-zero exit --
 * callers decide what an exit code means, because for the oracle a non-zero
 * exit is a legitimate answer rather than an error.
 */
export function exec(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return run(file, args, false, opts);
}

/** Run a command line through the user's shell. Used only for the repro command. */
export function execShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return run(command, [], true, opts);
}

function run(file: string, args: string[], shell: boolean, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      shell,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const capture = (stream: NodeJS.ReadableStream, onChunk: (s: string) => void) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => onChunk(chunk));
    };
    capture(child.stdout, (c) => {
      if (stdout.length < limit) stdout += c;
    });
    capture(child.stderr, (c) => {
      if (stderr.length < limit) stderr += c;
    });

    let hardKill: NodeJS.Timeout | undefined;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // A test runner that ignores SIGTERM must not hang the bisect.
          hardKill = setTimeout(() => child.kill("SIGKILL"), 3000);
        }, opts.timeoutMs)
      : undefined;

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };

    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
}

/** Keep the head and tail of long output; agents pay for the middle and rarely need it. */
export function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [...head, `... ${lines.length - maxLines} lines elided ...`, ...tail].join("\n");
}
