# gait

**Finds the exact agent edit that broke your tests.**

When a coding agent breaks something, its recovery strategy is to re-read files and
guess. That is the most expensive thing it does, and it is usually wrong.

`gait` snapshots the working tree after every edit, off to the side where nothing can
see it. When something breaks, the agent calls one tool and gets back the single edit
that turned the command from passing to failing — with the files and the patch.

```
$ gait why --repro "node test.js"
  FAIL  354a65f  edit 3: refactor add
  PASS  de8dfc9  edit 2: add constant

first bad checkpoint: 354a65f  edit 3: refactor add
last good checkpoint: de8dfc9

files changed by that step (1):
  M  src/math.js

 src/math.js | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

4 test runs over 7 checkpoints in 0.5s
```

O(log n) test runs instead of O(n) file reads.

## What git already does, and what it doesn't

`git bisect run` is an excellent binary search and gait does not reimplement it. The
checkpoint chain is ordinary commits with ordinary parents, so git's own halving walks
it natively.

What git cannot do alone is the other three things:

1. **The states to search.** `git bisect` searches commits. An agent produces *edits*.
   A 40-minute session with one commit — or a dirty tree and no commit — gives bisect
   nothing to bisect. gait manufactures the commits.
2. **A worktree the agent is not standing in.** `git bisect` rewrites the working tree
   on every step. Doing that while an agent is running corrupts its world. gait bisects
   in a throwaway worktree; bisect state is per-worktree, so the main checkout never
   learns it happened.
3. **An honest answer to a bad question.** A repro command that fails everywhere, passes
   everywhere, or isn't installed will still make `git bisect` produce a confident sha.
   gait pre-flights both ends and refuses instead.

That is the whole contribution. It is deliberately small.

## Install

```bash
npm install && npm run build && npm link
cd your-repo
gait init --test "npm test"
```

`init` writes `gait.json`, registers the MCP server in `.mcp.json`, documents the tool
in `CLAUDE.md`, and installs a Claude Code `PostToolUse` hook that checkpoints after
every file edit. The hook is the load-bearing piece: it makes the data exist without
anyone remembering to ask for it.

## Commands

```
gait why --repro "<cmd>"     find the edit that broke it        (alias: bisect)
gait checkpoint -m "label"   snapshot now
gait log                     checkpoints in this session
gait status                  branch, tree, session, chain length
gait restore <id>            roll back (current state saved first)
gait session new [label]     start a fresh chain
gait mcp                     run the MCP server on stdio
```

## Checkpoints

A checkpoint is a real commit object under `refs/gait/checkpoints/<session>` — **not**
on your branch.

It is built through a throwaway index (`GIT_INDEX_FILE`), so `HEAD`, the index and the
working tree are never touched. Three consequences that matter:

- nothing appears in `git log`, `git status`, or on any branch;
- checkpointing cannot race with git commands the agent is running itself;
- the objects are ref-reachable, so `gc` will not collect them.

`git add -A` respects `.gitignore`, so dependencies and build output stay out. Identical
trees are skipped, so a hook firing on every edit does not produce duplicates.

`restore` is the one destructive command. It checkpoints current state under a
`restore-safety` session first, materialises the target through a throwaway index so
your staged state survives, and removes files created after the checkpoint — a plain
`git checkout -- .` would leave those behind and produce a tree that never existed.

## Why it refuses

Three things have to be true before a bisect result means anything, so gait checks all
three before searching and returns a specific explanation when one fails:

| Condition | Why it matters |
| --- | --- |
| At least 3 checkpoints | Below that the answer is a range too coarse to act on. |
| Command **fails** at the newest checkpoint | Otherwise there is no failure to find. |
| Command **passes** at the oldest checkpoint | Otherwise the break predates the session and the answer is not in this chain. |

A missing command is caught separately. Plain `git bisect run` reads exit 127 as a
failing test and blames whichever commit it tried first; gait exits ≥128 to abort the
bisection instead.

Each candidate is tested by `gait _step`, not by `sh -c`, which is what buys the
per-step timeout and lets a hung test map to git's "skip" (125) rather than a false
"bad".

## MCP

```json
{ "mcpServers": { "gait": { "command": "gait", "args": ["mcp"] } } }
```

| tool | |
| --- | --- |
| `gait_find_breaking_change` | the headline; takes the exact failing command |
| `gait_checkpoint` | label a point before a risky change |
| `gait_checkpoint_log` | how far back recovery goes |
| `gait_status` | is the hook actually firing? |

Descriptions are written as triggers ("call this the moment a test that was passing
starts failing"), because an agent only reaches for a tool when it can tell the tool
applies to the situation it is in.

**`restore` is not exposed over MCP.** MCP is the knowledge surface; the control
surface stays with the developer. Rolling back the working tree is a decision for the
person, not for the agent that just broke something.

## Config

`gait.json`:

```json
{
  "testCommand": "npm test",
  "linkPaths": ["node_modules", ".venv", "venv", "target", "vendor"],
  "timeoutMs": 120000,
  "minCheckpoints": 3,
  "maxPatchLines": 200
}
```

`linkPaths` are symlinked into the throwaway worktree. A fresh checkout has no
dependencies, and reinstalling per bisect step would dominate the runtime by orders of
magnitude. `testCommand` is only a fallback — the agent should pass the exact failing
command, since one test file bisects faster and flakes less than a whole suite.

## Architecture

```
src/core/      domain, surface-agnostic, returns structured results
  exec         process spawning with timeouts and output caps
  git          plumbing wrappers
  checkpoint   the chain: create, list, resolve, restore
  worktree     throwaway sandbox + dependency linking
  oracle       verdict for one tree
  bisect       orchestration; the search itself is `git bisect run`
  config, init

src/surface/   two shells over one core
  render       one renderer, so the agent and the human never see different answers
  cli, mcp, self
```

Core never prints and never knows which shell called it. Every outcome is a
discriminated union, so a new surface renders the same facts without new logic.

## Not in v0.1

Deliberately cut: risk scoring, automatic branching or committing, interruption,
co-change analysis, multi-agent coordination. The one claim this version makes is that
it finds the breaking edit, and everything in the repo exists to serve that claim.
