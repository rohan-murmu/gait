import { matchAny } from "./glob.js";

export function select(paths, { include = [], exclude = [] }) {
  return paths.filter((p) => matchAny(include, p) && !matchAny(exclude, p));
}

export function labelFor(path, rules) {
  for (const { pattern, label } of rules) {
    if (matchAny([pattern], path)) return label;
  }
  return null;
}
