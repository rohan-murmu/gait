// A small path-matching dialect: ** spans separators, * does not.
export function translate(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:[^/]*/)*"; // "**/" swallows the separator so a/**/b matches a/b
        i += 2;
      } else if (i + 1 === pattern.length - 1 && out.endsWith("/")) {
        out = out.slice(0, -1) + "(?:/.*)?"; // trailing "/**" also matches the dir itself
        i++;
      } else {
        out += ".*";
        i++;
      }
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+()|^$[]{}\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

export function match(pattern, path) {
  return new RegExp("^" + translate(pattern) + "$").test(path);
}

// An empty list matches nothing, the safe default for `except` lists.
export function matchAny(patterns, path) {
  for (const p of patterns) if (match(p, path)) return true;
  return false;
}
