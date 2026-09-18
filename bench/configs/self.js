// Self-contained benchmark: a small path-matching library with a real test suite.
// Three regressions of escalating blast radius, each a plausible "cleanup" of code
// whose comment says why it is written the way it is.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const fixture = resolve(import.meta.dirname, "../fixtures/sample");

const edit = async (dir, file, find, replace) => {
  const path = join(dir, file);
  const before = await readFile(path, "utf8");
  if (!before.includes(find)) throw new Error(`injection target not found in ${file}`);
  await writeFile(path, before.replace(find, replace));
};

const CHURN = ["src/glob.js", "src/select.js", "test.js"];

export default {
  name: "sample path-matching library (7 tests, 3 files)",
  repo: fixture,
  testCommand: 'node --test "test.js"',
  edits: 20,

  // Ordinary agent churn: comments and notes, nothing behavioural.
  churn: (dir, i) => appendFile(join(dir, CHURN[i % CHURN.length]), `\n// note ${i}\n`),

  scenarios: [
    {
      name: "subtle (1 file)",
      at: 7,
      // "* and ** are both wildcards, simplify" -- loses separator semantics.
      inject: (dir) => edit(dir, "src/glob.js", 'out += "[^/]*";', 'out += ".*";'),
    },
    {
      name: "moderate (1 file)",
      at: 13,
      // "this branch looks redundant" -- the comment above it says it is not.
      inject: (dir) =>
        edit(dir, "src/glob.js", 'out = out.slice(0, -1) + "(?:/.*)?";', 'out += "/.*";'),
    },
    {
      name: "major (2 files)",
      at: 16,
      // A two-file "refactor": empty lists flip meaning and ? widens.
      inject: async (dir) => {
        await edit(
          dir,
          "src/glob.js",
          "export function matchAny(patterns, path) {",
          "export function matchAny(patterns, path) {\n  if (patterns.length === 0) return true;",
        );
        await edit(dir, "src/glob.js", 'out += "[^/]";', 'out += ".";');
        await edit(
          dir,
          "src/select.js",
          "return paths.filter((p) => matchAny(include, p) && !matchAny(exclude, p));",
          "return paths.filter((p) => matchAny(include, p) || !matchAny(exclude, p));",
        );
      },
    },
  ],
};
