import { agentLabel } from "../core/agents.js";
import { normalizePath } from "../core/overlap.js";
import type { Activity, MemberRole, RoomView } from "../core/types.js";

const MINUTE_MS = 60_000;
/** A session that posted within this window counts as working right now. */
export const ACTIVE_WINDOW_MS = 15 * MINUTE_MS;
/** Sessions silent for longer than this are left off the dashboard. */
export const VISIBLE_WINDOW_MS = 72 * 60 * MINUTE_MS;
export const RECENT_ACTIVITY_SHOWN = 6;

export type SessionState = "active" | "idle";

export interface AgentEdit {
  file: string;
  agent: string;
  at: string;
}

export interface SessionSummary {
  key: string;
  member: string;
  /** Checkout name, such as `web-3f2a1c`. Missing for entries posted without one. */
  session?: string;
  state: SessionState;
  /** True when a coding agent posted from this session. */
  hasAgent: boolean;
  /** Agent ids seen in this session, most recent first, such as `claude-code`. */
  agents: string[];
  /** Agent ids that posted within the active window. */
  activeAgents: string[];
  /** Files an agent's own hook reported editing, newest first, one entry per file. */
  edits: AgentEdit[];
  branch?: string;
  /** Files in the latest snapshot, plus files agents edited since then. */
  files: string[];
  /** What the session last said or did, in one line. */
  doing: string;
  lastSeen: string;
}

export interface MemberSummary {
  name: string;
  role: MemberRole;
  isMe: boolean;
  sessions: SessionSummary[];
  activeAgents: number;
}

export interface HotFile {
  file: string;
  /** Session keys currently changing this file. Always two or more. */
  sessions: string[];
  members: string[];
}

export interface Dashboard {
  roomName: string;
  me: string;
  members: MemberSummary[];
  totals: {
    members: number;
    activeSessions: number;
    activeAgents: number;
    /** Active agents by display name, such as { "Claude Code": 2, Codex: 1 }. */
    activeAgentsByLabel: Record<string, number>;
  };
  hotFiles: HotFile[];
  recent: Activity[];
}

export function sessionKey(member: string, session: string | undefined): string {
  return `${member}/${session ?? "default"}`;
}

/**
 * Turns the raw activity log into who is doing what, per member and per
 * session. Ignored files (lockfiles and the like) are left out of the picture.
 */
export function buildDashboard(
  room: RoomView,
  me: string,
  now = new Date(),
  isIgnored: (file: string) => boolean = () => false
): Dashboard {
  const nowMs = now.getTime();
  const byKey = new Map<string, Activity[]>();
  for (const entry of room.activity) {
    const key = sessionKey(entry.member, entry.session);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }

  const sessions: SessionSummary[] = [];
  for (const [key, entries] of byKey) {
    const ordered = [...entries].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
    const latest = ordered.at(-1);
    if (!latest) continue;
    const age = nowMs - Date.parse(latest.createdAt);
    if (Number.isNaN(age) || age > VISIBLE_WINDOW_MS) continue;

    const latestSnapshot = ordered.filter((entry) => entry.kind === "wip").at(-1);
    const snapshotAt = latestSnapshot?.createdAt ?? "";
    const latestSaid = ordered.filter((entry) => entry.kind === "note" || entry.kind === "edit").at(-1);
    const describing = latestSaid && latestSaid.createdAt >= snapshotAt ? latestSaid : latest;

    const agentLastSeen = new Map<string, number>();
    for (const entry of ordered) {
      if (entry.source !== "agent") continue;
      agentLastSeen.set(entry.agent ?? UNKNOWN_AGENT, Date.parse(entry.createdAt));
    }
    const agents = [...agentLastSeen.entries()].sort((first, second) => second[1] - first[1]).map(([agent]) => agent);

    const edits = latestEditPerFile(ordered);
    const editedSinceSnapshot = edits.filter((edit) => edit.at >= snapshotAt).map((edit) => edit.file);

    sessions.push({
      key,
      member: latest.member,
      session: latest.session,
      state: age <= ACTIVE_WINDOW_MS ? "active" : "idle",
      hasAgent: agents.length > 0,
      agents,
      activeAgents: agents.filter((agent) => nowMs - (agentLastSeen.get(agent) ?? 0) <= ACTIVE_WINDOW_MS),
      edits,
      branch: latest.branch ?? latestSnapshot?.branch,
      files: [...new Set([...(latestSnapshot?.files ?? []).map(normalizePath), ...editedSinceSnapshot])].filter(
        (file) => !isIgnored(file)
      ),
      doing: describing.text,
      lastSeen: latest.createdAt,
    });
  }

  const newestFirst = (first: SessionSummary, second: SessionSummary): number =>
    second.lastSeen.localeCompare(first.lastSeen);

  const members: MemberSummary[] = room.members
    .map((member) => {
      const own = sessions.filter((session) => session.member === member.name).sort(newestFirst);
      return {
        name: member.name,
        role: member.role,
        isMe: member.name === me,
        sessions: own,
        activeAgents: own.reduce((count, session) => count + session.activeAgents.length, 0),
      };
    })
    // Me first, then whoever was active most recently, then members with no activity.
    .sort((first, second) => {
      if (first.isMe !== second.isMe) return first.isMe ? -1 : 1;
      const firstSeen = first.sessions[0]?.lastSeen ?? "";
      const secondSeen = second.sessions[0]?.lastSeen ?? "";
      return secondSeen.localeCompare(firstSeen) || first.name.localeCompare(second.name);
    });

  const activeAgentsByLabel: Record<string, number> = {};
  for (const agent of sessions.flatMap((session) => session.activeAgents)) {
    const label = agentLabel(agent === UNKNOWN_AGENT ? undefined : agent);
    activeAgentsByLabel[label] = (activeAgentsByLabel[label] ?? 0) + 1;
  }

  return {
    roomName: room.name,
    me,
    members,
    totals: {
      members: room.members.length,
      activeSessions: sessions.filter((session) => session.state === "active").length,
      activeAgents: sessions.reduce((count, session) => count + session.activeAgents.length, 0),
      activeAgentsByLabel,
    },
    hotFiles: findHotFiles(sessions),
    recent: [...room.activity]
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
      .slice(0, RECENT_ACTIVITY_SHOWN),
  };
}

/** Stands in for agents that connected without sending a client name. */
export const UNKNOWN_AGENT = "agent";

/** Display name for an agent id as stored on a session. */
export function sessionAgentLabel(agent: string): string {
  return agentLabel(agent === UNKNOWN_AGENT ? undefined : agent);
}

function latestEditPerFile(ordered: Activity[]): AgentEdit[] {
  const byFile = new Map<string, AgentEdit>();
  for (const entry of ordered) {
    if (entry.kind !== "edit") continue;
    for (const rawFile of entry.files) {
      const file = normalizePath(rawFile);
      byFile.set(file, { file, agent: entry.agent ?? UNKNOWN_AGENT, at: entry.createdAt });
    }
  }
  return [...byFile.values()].sort((first, second) => second.at.localeCompare(first.at));
}

/** Files that two or more sessions are changing at once: the merge conflicts waiting to happen. */
function findHotFiles(sessions: SessionSummary[]): HotFile[] {
  const byFile = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    for (const file of session.files) byFile.set(file, [...(byFile.get(file) ?? []), session]);
  }
  return [...byFile.entries()]
    .filter(([, touching]) => touching.length > 1)
    .map(([file, touching]) => ({
      file,
      sessions: touching.map((session) => session.key),
      members: [...new Set(touching.map((session) => session.member))],
    }))
    .sort((first, second) => second.sessions.length - first.sessions.length || first.file.localeCompare(second.file));
}

/** Every session in display order, which is also the order arrow keys move through. */
export function flattenSessions(dashboard: Dashboard): SessionSummary[] {
  return dashboard.members.flatMap((member) => member.sessions);
}
