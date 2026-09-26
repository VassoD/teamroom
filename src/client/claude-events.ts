import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { overlapSignature } from "../core/overlap.js";
import { buildDashboard, type SessionSummary } from "../dashboard/model.js";
import { localStoreDir } from "./backend.js";
import { CLAUDE_EDIT_TOOLS } from "./claude-hook.js";
import {
  checkOverlap,
  formatAge,
  formatOverlaps,
  isOutsideRepo,
  reportEdit,
  toRepoPath,
  type Workspace,
} from "./workspace.js";

export const CLAUDE_AGENT_ID = "claude-code";

const HOUR_MS = 60 * 60 * 1000;
/** Sessions quieter than this are old news, not something a new session needs to hear about. */
const BRIEFING_WINDOW_MS = 24 * HOUR_MS;
const BRIEFING_MAX_SESSIONS = 8;
const BRIEFING_MAX_FILES = 8;
const BRIEFING_ACTIVITY_LIMIT = 300;
const WARNING_STATE_DIR = "claude-warnings";
/** Warning state is per Claude session. Files older than this belong to sessions long gone. */
const WARNING_STATE_MAX_AGE_MS = 7 * 24 * HOUR_MS;

const payloadSchema = z.object({
  // Older installs only registered PostToolUse, whose payloads are handled the same way.
  hook_event_name: z.string().default("PostToolUse"),
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z
    .object({
      file_path: z.string().optional(),
      notebook_path: z.string().optional(),
    })
    .loose()
    .optional(),
});

export type ClaudeHookPayload =
  | { event: "SessionStart"; sessionId?: string; cwd?: string }
  | { event: "PreToolUse" | "PostToolUse"; sessionId?: string; cwd?: string; tool: string; file: string };

/** Returns what teamroom cares about in a hook payload, or null when it is none of its business. */
export function parseClaudeHookPayload(rawPayload: string): ClaudeHookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const { hook_event_name: event, session_id: sessionId, cwd, tool_name: tool, tool_input: input } = parsed.data;

  if (event === "SessionStart") return { event, sessionId, cwd };
  if (event !== "PreToolUse" && event !== "PostToolUse") return null;
  if (!tool || !(CLAUDE_EDIT_TOOLS as readonly string[]).includes(tool)) return null;
  const file = input?.file_path ?? input?.notebook_path;
  return file ? { event, sessionId, cwd, tool, file } : null;
}

/** What the hook prints on stdout. Claude Code reads it as JSON; an empty string means "carry on". */
export type HookOutput = string;

export async function handleClaudeHook(payload: ClaudeHookPayload, workspace: Workspace): Promise<HookOutput> {
  switch (payload.event) {
    case "SessionStart":
      return sessionBriefing(workspace);
    case "PreToolUse":
      return guardEdit(workspace, payload.file, payload.sessionId);
    case "PostToolUse":
      await reportEdit(workspace, { file: payload.file, agent: CLAUDE_AGENT_ID });
      return "";
  }
}

/**
 * Tells a new Claude session who else is working in the repo and on what, so
 * it can plan around them before it touches anything.
 */
async function sessionBriefing(workspace: Workspace): Promise<HookOutput> {
  const { room, me } = await workspace.backend.getRoom(BRIEFING_ACTIVITY_LIMIT);
  const now = new Date();
  const others = buildDashboard(room, me, now, workspace.isIgnored)
    .members.flatMap((member) => member.sessions)
    .filter((session) => !(session.member === workspace.member && session.session === workspace.session))
    .filter((session) => now.getTime() - Date.parse(session.lastSeen) <= BRIEFING_WINDOW_MS)
    .filter((session) => session.files.length > 0)
    .slice(0, BRIEFING_MAX_SESSIONS);

  const lines = [
    "teamroom is on in this repo: other checkouts and their agents share what they are changing.",
    'When you start a task, announce your plan and the files you expect to touch with the `teamroom_post_note` tool (or `teamroom note "<plan>" --files a.ts,b.ts`).',
  ];
  if (others.length === 0) {
    lines.push("No other session is changing files right now.");
  } else {
    lines.push("", `Other sessions changing files right now (${others.length}):`, ...others.map(describeSession));
    lines.push(
      "",
      "Avoid these files unless the task needs them. If it does, tell the user who else is in them before editing."
    );
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
}

function describeSession(session: SessionSummary): string {
  const where = [session.session, session.branch && `on ${session.branch}`].filter(Boolean).join(" ");
  const shown = session.files.slice(0, BRIEFING_MAX_FILES).join(", ");
  const more = session.files.length > BRIEFING_MAX_FILES ? ` (+${session.files.length - BRIEFING_MAX_FILES} more)` : "";
  return `- ${session.member} in ${where}, ${formatAge(session.lastSeen)}: ${session.doing}\n  files: ${shown}${more}`;
}

/**
 * Pauses an edit once when another session is changing the same file, with
 * the details, so Claude can tell the user or adjust. Retrying the same edit
 * goes through: teamroom informs, it never blocks work for good. Someone new
 * in the file, or a new plan for it, pauses again; more edits from the same
 * session do not.
 */
async function guardEdit(workspace: Workspace, file: string, claudeSessionId: string | undefined): Promise<HookOutput> {
  const repoPath = toRepoPath(workspace, file);
  if (isOutsideRepo(repoPath) || workspace.isIgnored(repoPath)) return "";

  const { overlaps } = await checkOverlap(workspace, { files: [repoPath] });
  if (overlaps.length === 0) return "";

  const signature = overlapSignature(overlaps.flatMap((overlap) => overlap.touchedBy));
  const state = new WarningState(workspace.commonDir, claudeSessionId);
  if ((await state.lastWarned(repoPath)) === signature) return "";
  await state.remember(repoPath, signature);

  const reason = [
    `teamroom: ${repoPath} is also being changed in another checkout:`,
    formatOverlaps(overlaps),
    "",
    "This edit was paused once so you can decide. If it is still the right move, retry the same edit and it will go through.",
    "Otherwise tell the user who else is in this file, or do other parts of the task first.",
  ].join("\n");
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

/** Which overlaps a Claude session was already told about, one small file per session. */
class WarningState {
  private readonly file: string | undefined;

  constructor(gitCommonDir: string, claudeSessionId: string | undefined) {
    const dir = path.join(localStoreDir(gitCommonDir), WARNING_STATE_DIR);
    // Without a session id there is nothing to remember against, so every overlap pauses.
    this.file = claudeSessionId
      ? path.join(dir, `${createHash("sha256").update(claudeSessionId).digest("hex").slice(0, 32)}.json`)
      : undefined;
  }

  async lastWarned(repoPath: string): Promise<string | undefined> {
    return (await this.read())[repoPath];
  }

  async remember(repoPath: string, signature: string): Promise<void> {
    if (!this.file) return;
    const next = { ...(await this.read()), [repoPath]: signature };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    await pruneOldStates(path.dirname(this.file));
  }

  private async read(): Promise<Record<string, string>> {
    if (!this.file) return {};
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, "utf8"));
      return z.record(z.string(), z.string()).parse(parsed);
    } catch {
      return {};
    }
  }
}

async function pruneOldStates(dir: string): Promise<void> {
  const cutoff = Date.now() - WARNING_STATE_MAX_AGE_MS;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      const stats = await fs.stat(file).catch(() => undefined);
      if (stats && stats.mtimeMs < cutoff) await fs.rm(file, { force: true });
    })
  );
}
