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
 * A `wip` snapshot replaces the earlier snapshots and agent edits of its
 * session, so files a session has since merged or reverted stop showing up as
 * overlap. Edits newer than the snapshot still count: the agent is mid-task.
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
  const latestSnapshots = latestSnapshotBySession(activity);
  const latestTouch = new Map<string, Map<string, OverlapTouch>>();
  const latestPlan = new Map<string, Map<string, { text: string; at: number }>>();

  for (const entry of activity) {
    if (isCaller(entry, member, session)) continue;
    if (isSuperseded(entry, latestSnapshots.get(sessionKey(entry)))) continue;
    const at = Date.parse(entry.createdAt);
    if (Number.isNaN(at) || at < cutoff) continue;

    for (const rawFile of entry.files) {
      const file = normalizePath(rawFile);
      if (!wanted.has(file)) continue;

      const key = sessionKey(entry);
      if (entry.kind === "note") {
        const plans = latestPlan.get(file) ?? new Map<string, { text: string; at: number }>();
        const previousPlan = plans.get(key);
        if (!previousPlan || previousPlan.at < at) plans.set(key, { text: entry.text, at });
        latestPlan.set(file, plans);
      }

      const bySession = latestTouch.get(file) ?? new Map<string, OverlapTouch>();
      const previous = bySession.get(key);
      if (!previous || Date.parse(previous.at) < at) {
        bySession.set(key, {
          member: entry.member,
          session: entry.session,
          agent: entry.agent,
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
      touchedBy: [...bySession.entries()]
        .map(([key, touch]) => withPlan(touch, latestPlan.get(file)?.get(key)?.text))
        .sort((first, second) => second.at.localeCompare(first.at)),
    }))
    .sort((first, second) => first.file.localeCompare(second.file));
}

/**
 * Identifies an overlap for "already warned about this" checks: who is in the
 * file and what they said they plan. Timestamps and snapshot text are left
 * out, since they change on every edit of a session that keeps working, which
 * is the overlap the reader already knows about.
 */
export function overlapSignature(touches: OverlapTouch[]): string {
  return touches
    .map((touch) => {
      const plan = touch.kind === "note" ? touch.text : (touch.plan ?? "");
      return `${touch.member}/${touch.session ?? ""}:${plan}`;
    })
    .sort()
    .join("\u0000");
}

export function normalizePath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * A later snapshot is the latest touch, but its text ("Changing 3 files") says
 * nothing about intent. The session's plan for the file is what the reader
 * needs to decide, so it rides along.
 */
function withPlan(touch: OverlapTouch, plan: string | undefined): OverlapTouch {
  return plan && touch.kind !== "note" ? { ...touch, plan } : touch;
}

function isCaller(entry: Activity, member: string, session: string | undefined): boolean {
  if (entry.member !== member) return false;
  return session === undefined || entry.session === session;
}

function sessionKey(entry: Activity): string {
  return `${entry.member}\u0000${entry.session ?? ""}`;
}

function isSuperseded(entry: Activity, latestSnapshot: Activity | undefined): boolean {
  if (!latestSnapshot) return false;
  if (entry.kind === "wip") return entry.id !== latestSnapshot.id;
  if (entry.kind === "edit") return entry.createdAt < latestSnapshot.createdAt;
  return false;
}

export function latestSnapshotBySession(activity: Activity[]): Map<string, Activity> {
  const latestBySession = new Map<string, Activity>();
  for (const entry of activity) {
    if (entry.kind !== "wip") continue;
    const key = sessionKey(entry);
    const previous = latestBySession.get(key);
    if (!previous || previous.createdAt <= entry.createdAt) latestBySession.set(key, entry);
  }
  return latestBySession;
}
