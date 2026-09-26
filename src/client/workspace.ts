import os from "node:os";
import path from "node:path";
import { agentLabel } from "../core/agents.js";
import { normalizePath } from "../core/overlap.js";
import { MAX_FILES_PER_ACTIVITY, MAX_NAME_LENGTH, MAX_TEXT_LENGTH, memberNameSchema } from "../core/schemas.js";
import type { Activity, ActivitySource, FileOverlap } from "../core/types.js";
import { ApiClient } from "./api-client.js";
import { type BackendMode, LocalBackend, type RoomBackend, SharedBackend } from "./backend.js";
import { ENV, loadConfig, type TeamroomConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { Git, sessionForRepoRoot, type WorkingState } from "./git.js";
import { type IgnoreMatcher, loadIgnore } from "./ignore.js";

const FALLBACK_MEMBER_NAME = "me";

export interface Workspace {
  cwd: string;
  repoRoot: string;
  commonDir: string;
  git: Git;
  session: string;
  member: string;
  mode: BackendMode;
  backend: RoomBackend;
  /** Set only in shared mode. */
  config?: TeamroomConfig;
  /** Files whose overlap is noise, such as lockfiles. */
  isIgnored: IgnoreMatcher;
}

export interface OpenWorkspaceOptions {
  env?: NodeJS.ProcessEnv;
  /** Hooks that run inline with an agent keep this short, so a slow server never stalls an edit. */
  timeoutMs?: number;
  maxAttempts?: number;
}

/** Shared mode when the repo joined a room, local mode otherwise. Local mode needs no setup at all. */
export async function openWorkspace(cwd: string, options: OpenWorkspaceOptions = {}): Promise<Workspace> {
  const env = options.env ?? process.env;
  const git = new Git(cwd);
  const [repoRoot, commonDir] = await Promise.all([git.repoRoot(), git.commonDir()]);
  const [config, isIgnored] = await Promise.all([loadConfig(commonDir, env), loadIgnore(repoRoot)]);
  const rootGit = new Git(repoRoot);
  const member = config?.member ?? (await defaultMemberName(rootGit, env[ENV.member]));
  const backend: RoomBackend = config
    ? new SharedBackend(
        new ApiClient({
          server: config.server,
          token: config.token,
          timeoutMs: options.timeoutMs,
          maxAttempts: options.maxAttempts,
        }),
        config.roomId
      )
    : new LocalBackend(commonDir, member, path.basename(repoRoot));
  return {
    cwd,
    repoRoot,
    commonDir,
    git: rootGit,
    session: env[ENV.session] ?? sessionForRepoRoot(repoRoot),
    member,
    mode: backend.mode,
    backend,
    config,
    isIgnored,
  };
}

/** Room admin only makes sense for a shared room. */
export function requireShared(workspace: Workspace): TeamroomConfig {
  if (!workspace.config) {
    throw new ConfigError(
      "This repo is in local mode, which has no invites or members to manage. Share it with `teamroom create --server <url>` first."
    );
  }
  return workspace.config;
}

/** An explicit name, else git's user.name, else the OS user, cleaned up to be a valid member name. */
export async function defaultMemberName(git: Git, explicit?: string): Promise<string> {
  const candidates = [explicit, await git.userName(), safeOsUserName()];
  for (const candidate of candidates) {
    const cleaned = candidate?.replace(/@/g, "").trim().slice(0, MAX_NAME_LENGTH);
    if (cleaned && memberNameSchema.safeParse(cleaned).success) return cleaned;
  }
  return FALLBACK_MEMBER_NAME;
}

function safeOsUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

export interface ReportResult {
  activity: Activity;
  /** Files left out because the snapshot was over the per-entry limit. */
  omittedFiles: number;
}

/**
 * Publishes this checkout's current changes as a `wip` snapshot. An empty
 * snapshot is still sent: it clears what this session reported before.
 */
export async function reportWork(
  workspace: Workspace,
  options: { source: ActivitySource; note?: string; agent?: string; state?: WorkingState }
): Promise<ReportResult> {
  const state = options.state ?? (await workspace.git.workingState());
  const files = state.files.slice(0, MAX_FILES_PER_ACTIVITY);
  const omittedFiles = state.files.length - files.length;
  const activity = await workspace.backend.postActivity({
    kind: "wip",
    source: options.source,
    agent: options.agent,
    session: workspace.session,
    text: truncate(options.note?.trim() || describeSnapshot(state.files.length, state.branch)),
    branch: state.branch,
    commit: state.commit,
    files,
  });
  return { activity, omittedFiles };
}

export async function postNote(
  workspace: Workspace,
  options: { text: string; files?: string[]; source: ActivitySource; agent?: string }
): Promise<Activity> {
  const [branch, commit] = await Promise.all([workspace.git.currentBranch(), workspace.git.headCommit()]);
  return workspace.backend.postActivity({
    kind: "note",
    source: options.source,
    agent: options.agent,
    session: workspace.session,
    text: truncate(options.text.trim()),
    branch,
    commit,
    files: (options.files ?? []).map((file) => toRepoPath(workspace, file)).slice(0, MAX_FILES_PER_ACTIVITY),
  });
}

/**
 * Records that a coding agent edited one file. Returns null for files outside
 * the repo (scratch files, other projects), which the team has no reason to see.
 */
export async function reportEdit(
  workspace: Workspace,
  options: { file: string; agent: string }
): Promise<Activity | null> {
  const file = toRepoPath(workspace, options.file);
  if (isOutsideRepo(file)) return null;
  const [branch, commit] = await Promise.all([workspace.git.currentBranch(), workspace.git.headCommit()]);
  return workspace.backend.postActivity({
    kind: "edit",
    source: "agent",
    agent: options.agent,
    session: workspace.session,
    text: truncate(`${agentLabel(options.agent)} edited ${file}`),
    branch,
    commit,
    files: [file],
  });
}

export interface OverlapCheck {
  files: string[];
  overlaps: FileOverlap[];
}

/**
 * Asks who else is touching `files` (default: everything this checkout has
 * changed). Ignored files, such as lockfiles, are left out of the question.
 */
export async function checkOverlap(
  workspace: Workspace,
  options: { files?: string[]; sinceHours?: number; state?: WorkingState } = {}
): Promise<OverlapCheck> {
  const requested =
    options.files && options.files.length > 0
      ? [...new Set(options.files.map((file) => toRepoPath(workspace, file)))]
      : (options.state ?? (await workspace.git.workingState())).files;
  const files = requested.filter((file) => !isOutsideRepo(file) && !workspace.isIgnored(file));
  if (files.length === 0) return { files, overlaps: [] };

  const batches = chunk(files, MAX_FILES_PER_ACTIVITY);
  const results = await Promise.all(
    batches.map((batch) =>
      workspace.backend.findOverlaps({ files: batch, session: workspace.session, sinceHours: options.sinceHours })
    )
  );
  return { files, overlaps: results.flat() };
}

/** Accepts absolute paths or paths relative to the cwd, returns a path relative to the repo root. */
export function toRepoPath(workspace: Pick<Workspace, "cwd" | "repoRoot">, file: string): string {
  const absolute = path.resolve(workspace.cwd, file);
  return normalizePath(path.relative(workspace.repoRoot, absolute));
}

export function isOutsideRepo(repoPath: string): boolean {
  return repoPath === "" || repoPath === ".." || repoPath.startsWith("../") || path.isAbsolute(repoPath);
}

export function formatOverlaps(overlaps: FileOverlap[]): string {
  if (overlaps.length === 0) return "No one else is touching these files.";
  return overlaps
    .map((overlap) => {
      const touches = overlap.touchedBy.map((touch) => {
        const where = [touch.session, touch.branch].filter(Boolean).join(" on ");
        const via = touch.agent ? ` via ${agentLabel(touch.agent)}` : "";
        return `  - ${touch.member}${via}${where ? ` (${where})` : ""}, ${touch.kind} ${formatAge(touch.at)}: ${touch.text}`;
      });
      return [overlap.file, ...touches].join("\n");
    })
    .join("\n");
}

export function formatAge(isoTimestamp: string, now = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(isoTimestamp)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function describeSnapshot(fileCount: number, branch: string | undefined): string {
  const where = branch ? ` on ${branch}` : "";
  if (fileCount === 0) return `No pending changes${where}.`;
  return `Changing ${fileCount} file${fileCount === 1 ? "" : "s"}${where}.`;
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

function chunk<Item>(items: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
