import { test } from "node:test";
import assert from "node:assert/strict";
import { match, matchAny } from "./src/glob.js";
import { select, labelFor } from "./src/select.js";

test("* does not cross separators", () => {
  assert.equal(match("src/*.ts", "src/a.ts"), true);
  assert.equal(match("src/*.ts", "src/deep/a.ts"), false);
});

test("**/ spans zero or more segments", () => {
  assert.equal(match("src/**/a.ts", "src/a.ts"), true);
  assert.equal(match("src/**/a.ts", "src/x/y/a.ts"), true);
});

test("a trailing /** covers the directory itself", () => {
  assert.equal(match("src/db/**", "src/db"), true);
  assert.equal(match("src/db/**", "src/db/pool.ts"), true);
});

test("? matches exactly one non-separator", () => {
  assert.equal(match("a?c", "abc"), true);
  assert.equal(match("a?c", "a/c"), false);
});

test("an empty pattern list matches nothing", () => {
  assert.equal(matchAny([], "anything"), false);
});

test("select honours include and exclude", () => {
  const paths = ["src/a.ts", "src/b.test.ts", "docs/c.md"];
  assert.deepEqual(select(paths, { include: ["src/**"], exclude: ["**/*.test.ts"] }), ["src/a.ts"]);
});

test("labelFor returns the first matching rule", () => {
  const rules = [{ pattern: "src/**", label: "code" }, { pattern: "docs/**", label: "docs" }];
  assert.equal(labelFor("src/a.ts", rules), "code");
  assert.equal(labelFor("README.md", rules), null);
});
