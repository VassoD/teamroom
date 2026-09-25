import type { Activity, FileOverlap, OverlapTouch } from "./types.js";

export const DEFAULT_OVERLAP_WINDOW_HOURS = 72;
const MS_PER_HOUR = 60 * 60 * 1000;

interface FindOverlapsInput {
  activity: Activity[];
  files: string[];
  member: string;
  /** When omitted, every session of `member` is treated as the caller. */
  session?: string;
  sinceHours?: number;
  now?: Date;
}

/**
 * For each requested file, lists the other sessions that touched it recently,
 * keeping only each session's latest touch so the answer stays short.
 *
 * A `wip` snapshot replaces the earlier snapshots of its session, so files a
 * session has since merged or reverted stop showing up as overlap.
 */
export function findOverlaps({
  activity,
  files,
  member,
  session,
  sinceHours = DEFAULT_OVERLAP_WINDOW_HOURS,
  now = new Date(),
}: FindOverlapsInput): FileOverlap[] {
  const cutoff = now.getTime() - sinceHours * MS_PER_HOUR;
  const wanted = new Set(files.map(normalizePath));
  const currentSnapshots = latestSnapshotIds(activity);
  const latestTouch = new Map<string, Map<string, OverlapTouch>>();

  for (const entry of activity) {
    if (isCaller(entry, member, session)) continue;
    if (entry.kind === "wip" && !currentSnapshots.has(entry.id)) continue;
    const at = Date.parse(entry.createdAt);
    if (Number.isNaN(at) || at < cutoff) continue;

    for (const rawFile of entry.files) {
      const file = normalizePath(rawFile);
      if (!wanted.has(file)) continue;

      const bySession = latestTouch.get(file) ?? new Map<string, OverlapTouch>();
      const key = sessionKey(entry);
      const previous = bySession.get(key);
      if (!previous || Date.parse(previous.at) < at) {
        bySession.set(key, {
          member: entry.member,
          session: entry.session,
          kind: entry.kind,
          text: entry.text,
          branch: entry.branch,
          commit: entry.commit,
          at: entry.createdAt,
        });
      }
      latestTouch.set(file, bySession);
    }
  }

  return [...latestTouch.entries()]
    .map(([file, bySession]) => ({
      file,
      touchedBy: [...bySession.values()].sort((first, second) => second.at.localeCompare(first.at)),
    }))
    .sort((first, second) => first.file.localeCompare(second.file));
}

export function normalizePath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isCaller(entry: Activity, member: string, session: string | undefined): boolean {
  if (entry.member !== member) return false;
  return session === undefined || entry.session === session;
}

function sessionKey(entry: Activity): string {
  return `${entry.member}\u0000${entry.session ?? ""}`;
}

function latestSnapshotIds(activity: Activity[]): Set<string> {
  const latestBySession = new Map<string, Activity>();
  for (const entry of activity) {
    if (entry.kind !== "wip") continue;
    const key = sessionKey(entry);
    const previous = latestBySession.get(key);
    if (!previous || previous.createdAt <= entry.createdAt) latestBySession.set(key, entry);
  }
  return new Set([...latestBySession.values()].map((entry) => entry.id));
}
