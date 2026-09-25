import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { GitError } from "./errors.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SESSION_HASH_LENGTH = 6;
const SESSION_PREFIX_MAX_LENGTH = 60;
const DEFAULT_BRANCH_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

export interface GitResult {
  stdout: string;
  exitCode: number;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const runGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: unknown; stdout?: string };
    if (failure.code === "ENOENT") throw new GitError("git is not installed or not on PATH.", { cause: error });
    if (typeof failure.code === "number") return { stdout: failure.stdout ?? "", exitCode: failure.code };
    throw new GitError(`git ${args[0] ?? ""} failed: ${failure.message}`, { cause: error });
  }
};

export interface WorkingState {
  branch?: string;
  commit?: string;
  /** The ref the changes are measured against, such as origin/main. */
  baseRef?: string;
  /** Files changed on this branch plus uncommitted and untracked files, relative to the repo root. */
  files: string[];
}

export class Git {
  constructor(
    private readonly cwd: string,
    private readonly run: GitRunner = runGit
  ) {}

  async repoRoot(): Promise<string> {
    return this.required(["rev-parse", "--show-toplevel"], "This is not a git repository.");
  }

  /** Shared by every worktree of the repo, so one config serves them all. */
  async commonDir(): Promise<string> {
    const dir = await this.required(["rev-parse", "--git-common-dir"], "This is not a git repository.");
    return path.resolve(this.cwd, dir);
  }

  async hooksDir(): Promise<string> {
    const dir = await this.required(["rev-parse", "--git-path", "hooks"], "This is not a git repository.");
    return path.resolve(this.cwd, dir);
  }

  async currentBranch(): Promise<string | undefined> {
    const branch = await this.optional(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return branch || undefined;
  }

  async headCommit(): Promise<string | undefined> {
    return (await this.optional(["rev-parse", "--verify", "--quiet", "HEAD"])) || undefined;
  }

  async defaultBranchRef(): Promise<string | undefined> {
    const originHead = await this.optional(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const candidates = originHead ? [originHead, ...DEFAULT_BRANCH_CANDIDATES] : DEFAULT_BRANCH_CANDIDATES;
    for (const candidate of candidates) {
      const exists = await this.run(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], this.cwd);
      if (exists.exitCode === 0) return candidate;
    }
    return undefined;
  }

  /**
   * Everything this checkout would bring to the default branch: commits since
   * the merge-base, staged and unstaged edits, and untracked files.
   */
  async workingState(): Promise<WorkingState> {
    const [branch, commit, baseRef] = await Promise.all([
      this.currentBranch(),
      this.headCommit(),
      this.defaultBranchRef(),
    ]);
    const mergeBase = baseRef && commit ? await this.optional(["merge-base", "HEAD", baseRef]) : "";
    // Paths must be relative to the repo root whatever the cwd or diff.relative setting.
    const diffBase = ["diff", "--name-only", "--no-relative", "-z"];

    const [changed, staged, untracked] = await Promise.all([
      commit ? this.lines([...diffBase, mergeBase || "HEAD"]) : Promise.resolve([]),
      this.lines([...diffBase, "--cached"]),
      this.lines(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]),
    ]);
    const files = [...new Set([...changed, ...staged, ...untracked])].sort();
    return { branch, commit, baseRef: mergeBase ? baseRef : undefined, files };
  }

  /** True when `commit` is already part of `ref`. Unknown commits count as not merged. */
  async isMergedInto(commit: string, ref: string): Promise<boolean> {
    const result = await this.run(["merge-base", "--is-ancestor", commit, ref], this.cwd);
    return result.exitCode === 0;
  }

  private async lines(args: string[]): Promise<string[]> {
    const result = await this.run(args, this.cwd);
    if (result.exitCode !== 0) return [];
    return result.stdout.split("\0").filter((line) => line.length > 0);
  }

  private async optional(args: string[]): Promise<string> {
    const result = await this.run(args, this.cwd);
    return result.exitCode === 0 ? result.stdout.trim() : "";
  }

  private async required(args: string[], message: string): Promise<string> {
    const result = await this.run(args, this.cwd);
    const value = result.stdout.trim();
    if (result.exitCode !== 0 || !value) throw new GitError(message);
    return value;
  }
}

/**
 * Identifies one checkout of one member, so two agents in two worktrees of the
 * same person still warn each other. Readable prefix, hashed suffix for uniqueness.
 */
export function sessionForRepoRoot(repoRoot: string): string {
  const readable =
    path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, SESSION_PREFIX_MAX_LENGTH) || "repo";
  const suffix = createHash("sha256").update(repoRoot).digest("hex").slice(0, SESSION_HASH_LENGTH);
  return `${readable}-${suffix}`;
}
