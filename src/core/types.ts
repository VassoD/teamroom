/**
 * - `wip`: a snapshot of every file a session has changed but not merged yet. A newer
 *   snapshot from the same session replaces the older one.
 * - `commit`: files changed by one commit.
 * - `note`: free text, optionally about files ("about to refactor auth/").
 * - `edit`: files one coding agent just edited, reported by the agent's own hook.
 */
export type ActivityKind = "wip" | "commit" | "note" | "edit";

/** Who produced an activity entry: a person at the CLI, the git hook, or a coding agent via MCP. */
export type ActivitySource = "human" | "hook" | "agent";

export type MemberRole = "owner" | "member";

export interface Member {
  name: string;
  role: MemberRole;
  tokenHash: string;
  joinedAt: string;
}

export interface Activity {
  id: string;
  member: string;
  /** One member can run several sessions at once, typically one per worktree or agent. */
  session?: string;
  kind: ActivityKind;
  source: ActivitySource;
  /** Which coding agent posted it, such as `claude-code` or `codex`. Only set when `source` is `agent`. */
  agent?: string;
  text: string;
  branch?: string;
  commit?: string;
  files: string[];
  createdAt: string;
}

export interface Room {
  id: string;
  name: string;
  inviteHash: string;
  members: Member[];
  activity: Activity[];
  createdAt: string;
  updatedAt: string;
}

export interface MemberView {
  name: string;
  role: MemberRole;
  joinedAt: string;
}

/** Room shape safe to return to clients: no token or invite hashes. */
export interface RoomView {
  id: string;
  name: string;
  members: MemberView[];
  activity: Activity[];
  createdAt: string;
  updatedAt: string;
}

export interface OverlapTouch {
  member: string;
  session?: string;
  agent?: string;
  kind: ActivityKind;
  text: string;
  branch?: string;
  commit?: string;
  at: string;
}

export interface FileOverlap {
  file: string;
  touchedBy: OverlapTouch[];
}
