<p align="center">
  <img src="assets/logo.svg" alt="" width="132" height="132">
</p>

<h1 align="center">gait</h1>

<p align="center">
  <strong>Finds the exact AI-agent edit that broke your tests.</strong><br>
  Checkpoints every edit off to the side. Bisects them when something breaks.
</p>

<p align="center">
  <a href="https://github.com/rohan-murmu/gait/actions"><img alt="ci" src="https://github.com/rohan-murmu/gait/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <a href="https://gait-tool.vercel.app/"><b>gait-tool.vercel.app</b></a>
  &nbsp;·&nbsp;
  <a href="#install">Install</a>
  &nbsp;·&nbsp;
  <a href="#analysis">Benchmarks</a>
</p>

```
$ gait why --repro "node gait-eval/check.ts"
  PASS  976805f  edit 10: comment Landing
  FAIL  0fdc969  edit 15: button cursor
  PASS  01c723b  edit 12: comment Room
  FAIL  89218f5  edit 13: replace deprecated substr with slice

first bad checkpoint: 89218f5  edit 13: replace deprecated substr with slice
last good checkpoint: 01c723b

files changed by that step (1):
  M  src/utils/index.ts

-  return Math.random().toString(36).substr(2, 9);
+  return Math.random().toString(36).slice(2, 9);

7 test runs over 21 checkpoints in 1.4s
```

---

## The problem

A coding agent edits forty files in twenty minutes. Then a test fails.

The agent's recovery strategy is to re-read files and guess. It is the most expensive
thing it does — and for a regression the error message does not localise, it is mostly
guesswork. You watch it open files it has no reason to suspect, burning context on each
one, sometimes "fixing" things that were never broken.

**Git already solved this.** `git bisect run` is an excellent binary search. But it
searches *commits*, and an agent produces *edits*:

- a 20-minute session typically makes **zero commits** — the whole thing is one dirty
  working tree, and bisect has nothing to search;
- `git bisect` rewrites the working tree on every step, so running it while an agent is
  working corrupts the agent's world;
- a repro command that fails everywhere, passes everywhere, or is not installed will
  still make `git bisect` print a confident, wrong answer.

Agent harnesses ship their own checkpoints, and they are useful. But they live inside one
vendor's session state, they disappear when the session does, and they are not something
you can bisect, script, or inspect with tools you already trust.

## The solution

gait snapshots the working tree after **every edit**, as real git commit objects stored
outside your branches. When something breaks, it bisects those snapshots in a throwaway
worktree and hands back the single edit that turned the command from passing to failing —
with the files it touched and the patch.

The agent calls one tool. It gets one file and one hunk instead of a forty-file diff.

**gait does not reimplement binary search.** The checkpoint chain is ordinary commits with
ordinary parents, so `git bisect run` walks it natively. gait supplies the three things
git cannot do alone:

| | |
| --- | --- |
| **The states to search** | Commits that exist per edit, without polluting your history |
| **Somewhere safe to search them** | A throwaway worktree; bisect state is per-worktree, so your checkout never learns it happened |
| **An honest answer to a bad question** | Pre-flight checks at both ends, and a refusal with a reason instead of a wrong sha |

That is the whole contribution. It is deliberately small.

## Website

**[gait-tool.vercel.app](https://gait-tool.vercel.app/)**

The same argument as this README, laid out to be read rather than scanned: why `git bisect`
cannot help with an agent session, the three things gait adds, a 3D view of the checkpoint
chain with the breaking edit lit up, and the benchmark numbers — including the section on
what those numbers do not show, which is on the landing page rather than buried here.

It is one static file in [`web/`](web/index.html) with no build step and no framework.
Open it straight from the filesystem if you want to read it offline.

## Install

### Homebrew

```bash
brew install rohan-murmu/gait/gait
```

<details>
<summary>Before the first tagged release, or to track <code>main</code></summary>

```bash
brew install --HEAD rohan-murmu/gait/gait
```
</details>

### npm

```bash
npm install -g gait
```

The npm package ships prebuilt, so this needs no toolchain beyond Node.

### From source

```bash
git clone https://github.com/rohan-murmu/gait.git
cd gait && npm install && npm link
```

Requires **Node ≥ 20** and a modern **git** with per-worktree bisect state (tested on 2.43).

## Use

```bash
cd your-repo
gait init --test "npm test"
```

`init` writes `gait.json`, registers the MCP server in `.mcp.json`, documents the tool in
`CLAUDE.md`, and installs a Claude Code `PostToolUse` hook that checkpoints after every
file edit. **The hook is the load-bearing piece** — it makes the data exist without anyone
remembering to ask for it.

Then work as normal. When something breaks:

```bash
gait why --repro "npx vitest run src/auth.test.ts"
```

Or let the agent do it — that is the point. With the MCP server registered, an agent that
hits a failing test calls `gait_find_breaking_change` itself.

### Commands

| | |
| --- | --- |
| `gait why --repro "<cmd>"` | find the edit that broke it (alias: `bisect`) |
| `gait checkpoint -m "label"` | snapshot now, with a name |
| `gait log` | checkpoints in this session |
| `gait status` | branch, tree, session, chain length |
| `gait restore <id>` | roll back; current state is saved first |
| `gait session new [label]` | start a fresh chain |
| `gait mcp` | run the MCP server on stdio |

### Config

`gait.json`, written by `init`:

```json
{
  "testCommand": "npm test",
  "linkPaths": ["node_modules", ".venv", "venv", "target", "vendor"],
  "timeoutMs": 120000,
  "minCheckpoints": 3,
  "maxPatchLines": 200
}
```

`linkPaths` are symlinked into the throwaway worktree, because a fresh checkout has no
dependencies and reinstalling per bisect step would dominate the runtime. Go, Rust and
other languages with a global module cache need nothing here.

`testCommand` is only a fallback. The agent should pass the exact failing command: one
test file bisects faster and flakes far less than a whole suite.

## How it works

### Checkpoints are invisible

A checkpoint is a real commit object under `refs/gait/checkpoints/<session>` — not on any
branch. It is built through a throwaway index:

```
GIT_INDEX_FILE=$(mktemp)  git read-tree HEAD
                          git add -A          # respects .gitignore
                          git write-tree
                          git commit-tree <tree> -p <previous>
                          git update-ref refs/gait/checkpoints/<session> <commit>
```

`HEAD`, your index and your working tree are never touched. Three consequences that
matter:

- nothing appears in `git log`, `git status`, or on any branch;
- checkpointing **cannot race** with git commands the agent is running itself;
- the objects are ref-reachable, so `gc` will not collect them.

Identical trees are skipped, so a hook firing on every keystroke-sized edit does not
produce duplicates.

### The search runs somewhere else

```
your working tree              throwaway worktree (/tmp)
  agent keeps editing    →       git bisect start <bad> <good>
  nothing changes                git bisect run gait _step
                                 ↓
                          refs/bisect/bad → the breaking edit
```

Dependencies are symlinked in before checkout, so the first test run does not pay for an
install. The worktree and its bisect state are torn down afterwards.

### Each step is our own oracle, not `sh -c`

`git bisect run` maps exit codes: 0 good, non-zero bad, 125 skip, ≥128 abort. Handing it
`sh -c "<your command>"` directly loses three things, so gait runs `gait _step` instead:

| situation | `sh -c` | `gait _step` |
| --- | --- | --- |
| test hangs | bisect hangs forever | per-step timeout → **125 (skip)** |
| command not found (127) | read as a failing test, **blames the first commit tried** | **≥128, aborts** |
| output | unbounded | capped, head and tail kept |

### It refuses rather than guess

Three things must be true before a bisect result means anything. gait checks all three
first, and names the one that failed:

| condition | why |
| --- | --- |
| ≥ 3 checkpoints | below that the answer is a range too coarse to act on |
| command **fails** at the newest checkpoint | otherwise there is no failure to find |
| command **passes** at the oldest checkpoint | otherwise the break predates the session and the answer is not in this chain |

```
$ gait why --repro "npm test"
The repro command already fails at the oldest checkpoint (cc90b19).

The break predates this session, so no agent edit in this chain caused it.
Re-run with an explicitly good commit from real history:

  gait why --good <sha-you-know-was-fine>
```

## Architecture

```
                         ┌──────────────┐
      agent ──── MCP ───▶│              │
                         │  src/core/   │──▶ git plumbing
      you  ──── CLI ────▶│              │
                         └──────────────┘
                                │
                         one renderer
```

```
src/core/                      domain — never prints, never reads argv
  exec.ts        process spawning: timeouts, output caps, SIGTERM→SIGKILL
  git.ts         plumbing wrappers; GitError carries argv, code, stderr
  checkpoint.ts  the chain: create, list, resolve, restore
  worktree.ts    throwaway sandbox + dependency linking
  oracle.ts      one tree → pass | fail | timeout | unrunnable
  bisect.ts      orchestration; the search itself is `git bisect run`
  config.ts, init.ts

src/surface/                   two shells over one core
  render.ts      outcome → text, shared by both shells
  cli.ts         commander; also hosts the hidden `_step` oracle
  mcp.ts         four tools over stdio
  self.ts        resolves the step-oracle argv

test/          end-to-end, against dist/ rather than the sources
bench/         injection harness + a self-contained fixture
web/           the landing page; one static file, deployed by Actions
assets/        logo, in SVG and PNG
```

### System design decisions

**Core returns values, shells render them.** Every operation returns a discriminated
union — `found | insufficient_checkpoints | not_reproducible | broken_from_start |
unrunnable | bad_range | aborted`. Adding a surface (an LSP server, a web UI, a GitHub
Action) means rendering those cases, not reimplementing logic.

**One renderer for both shells.** The answer an agent reads and the answer you read come
from the same function, so they cannot drift apart. This is why the CLI output above and
the MCP tool response are byte-identical.

**Observation never blocks.** The checkpoint hook sits on the agent's critical path after
every edit, with a 10-second timeout. A slow or failing gait must degrade to no gait, not
to a stalled agent.

**MCP is the knowledge surface; the CLI is the control surface.** The MCP server exposes
`gait_find_breaking_change`, `gait_checkpoint`, `gait_checkpoint_log`, `gait_status`.
**`restore` is deliberately not exposed.** Rolling back the working tree is a decision for
the developer, not for the agent that just broke something.

**Session state lives in the common git dir**, so every linked worktree agrees on which
chain is current.

**`restore` is the one destructive command**, and it is careful: it checkpoints current
state under a `restore-safety` session first, materialises the target through a throwaway
index so your staged state survives, and removes files created after the checkpoint — a
plain `git checkout -- .` would leave those behind and produce a tree that never existed.

### Tool descriptions are triggers, not summaries

An agent only reaches for a tool when it can tell the tool applies to the situation it is
in. So the description names the situation, and — more importantly — names when *not* to
call it:

> Call this when something that used to work now fails **and the failure output does not
> tell you which file is at fault**. […] **Do NOT call this for compiler or linter
> errors**: those already print the file and line, so reading that line is faster and
> free.

That second sentence exists because of a measurement. See below.

<a id="analysis"></a>

## Analysis

These are my own numbers from my own benchmarks. Reproduce them with `npm run bench`, or
point `bench/run.js` at your own repo.

### Real project, real test suite

A Go project: 48 source files, 13 test files, `go test ./...`. A 20-edit agent session
with one regression injected mid-session, each a plausible "cleanup" of code whose comment
explains why it is written the way it is.

| scenario | found | files to inspect | lines to read | test runs vs linear |
| --- | --- | --- | --- | --- |
| subtle — 1 file, 3 packages fail | yes | 20 → 1, **95% fewer** | 223 → 15, **93% fewer** | 20 → 6, **70% fewer** |
| moderate — 1 file, 3 packages fail | yes | 20 → 1, **95% fewer** | 223 → 15, **93% fewer** | 20 → 7, **65% fewer** |
| major — **2 files**, 7 packages fail | yes | 20 → 2, **90% fewer** | 241 → 37, **85% fewer** | 20 → 6, **70% fewer** |
| **mean** | **3/3** | **93% fewer** | **90% fewer** | **68% fewer** |

Mean wall clock 5.4s. "Lines to read" compares gait's patch against the *whole session
diff* — the strongest baseline available to an agent without gait. Against the more
realistic baseline of opening each changed file, it is 99%.

The third row is the one worth looking at: a two-file edit broke seven packages at once,
and gait named both files. That is the case where an agent goes most wrong, because seven
failing packages look like seven problems.

### A regression the compiler cannot see

A TypeScript project, 50 files. Edit 13 of 20 replaced a deprecated `substr(2, 9)` with
`slice(2, 9)` — a real mistake, since `substr` takes a length and `slice` takes an end
index. It type-checks, it builds, and every generated user id silently loses two
characters.

| | without gait | with gait |
| --- | --- | --- |
| `tsc -b` catches it | no, build is clean | — |
| failure names the file | no, only the assertion site | yes, `src/utils/index.ts` |
| `git bisect` available | **no — 0 commits during the session** | — |
| search space | 16 files, 1,722 lines, 40 KB | 1 file, 1 line |
| cost | read the diff and reason about it | 7 runs, 1.4s, 858 bytes |

That `git bisect` row is the point of the tool. Bisect was not slower; it had nothing to
search.

### Where it does not help

The same session with a type error instead:

```
$ npx tsc -b
src/utils/contants.ts(8,14): error TS2322: Type 'string' is not assignable to type 'number'.

$ gait why --repro "npx tsc -b"
   M  src/utils/contants.ts
   5 test runs over 10 checkpoints in 16.0s
```

**gait spent 16 seconds arriving at the file the compiler named instantly, for free, and at
worse resolution** — tsc gave a line and a column.

This is why the tool description tells the agent not to call it for compiler and linter
errors. A tool that cannot say when not to use it is not worth installing.

### What is not proven

Being explicit about the limits of the above:

- **Flaky tests are unmeasured and are the main risk.** Binary search assumes a
  deterministic oracle. A test that fails 10% of the time breaks monotonicity, and gait
  will give a confident wrong answer with no indication anything went wrong. Quantifying
  flake rate against wrong-answer rate is the most valuable open contribution.
- **Non-monotonic regressions are unhandled.** If edit 5 breaks it, edit 9 accidentally
  masks it and edit 14 unmasks it, there are three transitions and bisect assumes one.
- **The regressions are injected, not harvested.** They are modelled on real mistakes, but
  a benchmark built from real bug corpora (Defects4J, BugsInPy) replayed as sessions would
  be stronger evidence.
- **Two projects, four regressions.** Enough to demonstrate; not enough to generalise.
- **Binary search correctness was never in doubt.** Given a deterministic oracle and a
  monotonic failure, bisect is correct by construction. The benchmark measures the *cost
  reduction* and guards against regressions in it — it is not evidence that the algorithm
  works, because that was never the question.
- **Hook coverage is untested in the wild.** `init` matches Claude Code's
  `Edit|Write|MultiEdit|NotebookEdit`. An agent that writes files another way produces a
  sparser chain and a coarser answer.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Most wanted, in order: adversarial benchmarks for
flaky oracles, non-monotonic regression handling, hooks for agents other than Claude Code,
and benchmark configs pointed at real repositories.

Out of scope, deliberately: risk scoring, automatic branching or committing, and agent
interruption. Those are quality judgements without ground truth to evaluate against. gait
answers a question that has a verifiable answer, and keeps doing only that.

## License

[MIT](LICENSE)
