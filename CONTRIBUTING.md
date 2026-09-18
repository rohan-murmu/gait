# Contributing to gait

gait has one claim: it finds the edit that broke your tests. Changes that make that
claim truer, faster, or better evidenced are welcome. Changes that add a second claim
probably belong in a different tool — see [Scope](#scope).

## Getting set up

```bash
git clone https://github.com/rohan-murmu/gait.git
cd gait
npm install        # `prepare` builds automatically
npm test           # 11 end-to-end tests, ~11s
npm run bench      # 3 injected regressions, ~6s
```

`npm test` runs against `dist/`, not the TypeScript sources, so it exercises what users
actually install. `npm run bench` exits non-zero if any regression is localised
incorrectly — both run in CI on Node 20, 22 and 24, on Linux and macOS.

## Where things go

`src/core/` is the domain. It never prints, never reads `process.argv`, and never knows
which shell called it. Every operation returns a discriminated union describing what
happened.

`src/surface/` is the shells. `render.ts` turns a core outcome into text, and both the
CLI and the MCP server use it, so a human and an agent can never be shown different
answers to the same question.

If you find yourself writing `console.log` in `src/core/`, the logic belongs in a
returned value instead.

## Pull requests

- **Add a test.** `test/` covers the invariants the design rests on: checkpoints must
  not touch `HEAD`, the index, or `git status`; a bisect must leave no worktree behind;
  the search must stay within `2 + ceil(log2(n)) + 1` runs. If your change could break
  one of those, pin it.
- **Add a benchmark scenario** for anything that changes localisation behaviour. See
  `bench/configs/self.js`; a scenario is a name, an edit position, and an injector.
- **Keep refusals specific.** When gait cannot answer, it says which precondition failed
  and what to do instead. A generic error is a regression.
- **No new dependencies** without a reason in the PR description. The runtime dependency
  list is three packages and that is a feature.

## Especially wanted

1. **Adversarial benchmarks.** The measured results all assume a deterministic test. A
   flaky oracle breaks bisect's monotonicity assumption outright, and gait will give a
   confident wrong answer. Scenarios that quantify that — flake probability vs. wrong
   answer rate — are the most valuable contribution available right now.
2. **Non-monotonic regressions.** Edit 5 breaks it, edit 9 masks it, edit 14 unmasks it.
   Bisect assumes one transition. What should gait do when it detects more?
3. **Hooks for agents other than Claude Code.** `gait init` installs a `PostToolUse`
   hook. Any mechanism that reliably fires after a file edit works; the checkpoint
   command itself is agent-agnostic.
4. **Real-repo benchmark configs.** Point `bench/run.js` at a project with a real test
   suite and contribute the config.

## Scope

Out of scope, deliberately: risk scoring, automatic branching or committing, agent
interruption, and anything that decides *whether* a change is acceptable. Those are
quality judgements without ground truth to evaluate against. gait answers a question
with a verifiable answer, and keeps doing only that.

## Releasing

Tag `vX.Y.Z` and push. The release workflow prints the tarball's sha256; open a PR
against [`rohan-murmu/homebrew-gait`](https://github.com/rohan-murmu/homebrew-gait)
updating `url` and `sha256` in `Formula/gait.rb`.
