import path from "node:path";
import { normalizePath } from "../core/overlap.js";
import { MAX_FILES_PER_ACTIVITY, MAX_TEXT_LENGTH } from "../core/schemas.js";
import type { Activity, ActivitySource, FileOverlap } from "../core/types.js";
import { ApiClient } from "./api-client.js";
import { ENV, loadConfig, type TeamroomConfig } from "./config.js";
import { Git, sessionForRepoRoot } from "./git.js";

export interface Workspace {
  cwd: string;
  repoRoot: string;
  git: Git;
  session: string;
  config: TeamroomConfig;
  client: ApiClient;
}

export async function openWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Workspace> {
  const git = new Git(cwd);
  const [repoRoot, commonDir] = await Promise.all([git.repoRoot(), git.commonDir()]);
  const config = await loadConfig(commonDir, env);
  return {
    cwd,
    repoRoot,
    git: new Git(repoRoot),
    session: env[ENV.session] ?? sessionForRepoRoot(repoRoot),
    config,
    client: new ApiClient({ server: config.server, token: config.token }),
  };
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
  options: { source: ActivitySource; note?: string }
): Promise<ReportResult> {
  const state = await workspace.git.workingState();
  const files = state.files.slice(0, MAX_FILES_PER_ACTIVITY);
  const omittedFiles = state.files.length - files.length;
  const activity = await workspace.client.postActivity(workspace.config.roomId, {
    kind: "wip",
    source: options.source,
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
  options: { text: string; files?: string[]; source: ActivitySource }
): Promise<Activity> {
  const [branch, commit] = await Promise.all([workspace.git.currentBranch(), workspace.git.headCommit()]);
  return workspace.client.postActivity(workspace.config.roomId, {
    kind: "note",
    source: options.source,
    session: workspace.session,
    text: truncate(options.text.trim()),
    branch,
    commit,
    files: (options.files ?? []).map((file) => toRepoPath(workspace, file)).slice(0, MAX_FILES_PER_ACTIVITY),
  });
}

export interface OverlapCheck {
  files: string[];
  overlaps: FileOverlap[];
}

/**
 * Asks who else is touching `files` (default: everything this checkout has
 * changed). Commit entries already merged into the default branch are dropped,
 * since they can no longer conflict.
 */
export async function checkOverlap(
  workspace: Workspace,
  options: { files?: string[]; sinceHours?: number } = {}
): Promise<OverlapCheck> {
  const files =
    options.files && options.files.length > 0
      ? [...new Set(options.files.map((file) => toRepoPath(workspace, file)))]
      : (await workspace.git.workingState()).files;
  if (files.length === 0) return { files, overlaps: [] };

  const batches = chunk(files, MAX_FILES_PER_ACTIVITY);
  const results = await Promise.all(
    batches.map((batch) =>
      workspace.client.findOverlaps(workspace.config.roomId, {
        files: batch,
        session: workspace.session,
        sinceHours: options.sinceHours,
      })
    )
  );
  const overlaps = await dropMergedCommits(workspace.git, results.flat());
  return { files, overlaps };
}

async function dropMergedCommits(git: Git, overlaps: FileOverlap[]): Promise<FileOverlap[]> {
  const baseRef = await git.defaultBranchRef();
  if (!baseRef) return overlaps;

  const commits = new Set(
    overlaps.flatMap((overlap) =>
      overlap.touchedBy.filter((touch) => touch.kind === "commit" && touch.commit).map((touch) => touch.commit ?? "")
    )
  );
  const merged = new Set<string>();
  await Promise.all(
    [...commits].map(async (commit) => {
      if (await git.isMergedInto(commit, baseRef)) merged.add(commit);
    })
  );

  return overlaps
    .map((overlap) => ({
      ...overlap,
      touchedBy: overlap.touchedBy.filter(
        (touch) => !(touch.kind === "commit" && touch.commit && merged.has(touch.commit))
      ),
    }))
    .filter((overlap) => overlap.touchedBy.length > 0);
}

/** Accepts absolute paths or paths relative to the cwd, returns a path relative to the repo root. */
export function toRepoPath(workspace: Pick<Workspace, "cwd" | "repoRoot">, file: string): string {
  const absolute = path.resolve(workspace.cwd, file);
  return normalizePath(path.relative(workspace.repoRoot, absolute));
}

export function formatOverlaps(overlaps: FileOverlap[]): string {
  if (overlaps.length === 0) return "No one else is touching these files.";
  return overlaps
    .map((overlap) => {
      const touches = overlap.touchedBy.map((touch) => {
        const where = [touch.session, touch.branch].filter(Boolean).join(" on ");
        return `  - ${touch.member}${where ? ` (${where})` : ""}, ${touch.kind} ${formatAge(touch.at)}: ${touch.text}`;
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
