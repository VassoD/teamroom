import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizePath } from "../core/overlap.js";

/** Optional, committed at the repo root. Same idea as .gitignore: one pattern per line, `#` comments, `!` to re-include. */
export const IGNORE_FILE = ".teamroomignore";

/**
 * Generated files that every branch touches. Overlap on them is almost never
 * a real conflict, and warnings that always fire teach people and agents to
 * skip them. Re-include one with `!package-lock.json` in .teamroomignore.
 */
export const DEFAULT_IGNORED_PATTERNS = [
  // Each person's own Claude Code settings, which teamroom's own setup writes in every worktree.
  ".claude/settings.local.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Podfile.lock",
  "pubspec.lock",
  "flake.lock",
];

export type IgnoreMatcher = (file: string) => boolean;

interface CompiledPattern {
  negated: boolean;
  regex: RegExp;
}

/** Builds a matcher from gitignore-style patterns. The last pattern that matches decides. */
export function compileIgnore(patterns: string[]): IgnoreMatcher {
  const compiled = patterns.map(compilePattern).filter((pattern): pattern is CompiledPattern => pattern !== undefined);
  return (file) => {
    const target = normalizePath(file);
    let ignored = false;
    for (const pattern of compiled) {
      if (pattern.regex.test(target)) ignored = !pattern.negated;
    }
    return ignored;
  };
}

export async function loadIgnore(repoRoot: string): Promise<IgnoreMatcher> {
  let custom: string[] = [];
  try {
    custom = (await fs.readFile(path.join(repoRoot, IGNORE_FILE), "utf8")).split(/\r?\n/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return compileIgnore([...DEFAULT_IGNORED_PATTERNS, ...custom]);
}

function compilePattern(line: string): CompiledPattern | undefined {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#")) return undefined;
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);

  const directoryOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  // Like git: a slash anywhere but the end ties the pattern to the repo root.
  const anchored = pattern.includes("/");
  pattern = pattern.replace(/^\/+/, "");
  if (!pattern) return undefined;

  const body = globToRegex(pattern);
  const prefix = anchored ? "^" : "(?:^|/)";
  const suffix = directoryOnly ? "/.*$" : "(?:/.*)?$";
  return { negated, regex: new RegExp(`${prefix}${body}${suffix}`) };
}

function globToRegex(glob: string): string {
  let regex = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*" && glob[index + 1] === "*") {
      const followedBySlash = glob[index + 2] === "/";
      regex += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return regex;
}
