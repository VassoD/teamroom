import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { overlapSignature } from "../core/overlap.js";
import { buildDashboard, type SessionSummary } from "../dashboard/model.js";
import { localStoreDir } from "./backend.js";
import {
  checkOverlap,
  formatAge,
  formatOverlaps,
  isOutsideRepo,
  oneLine,
  quoted,
  reportEdit,
  toRepoPath,
  UNTRUSTED_TEXT_NOTICE,
  type Workspace,
} from "./workspace.js";

const HOUR_MS = 60 * 60 * 1000;
/** Sessions quieter than this are old news, not something a new session needs to hear about. */
const BRIEFING_WINDOW_MS = 24 * HOUR_MS;
const BRIEFING_MAX_SESSIONS = 8;
const BRIEFING_MAX_FILES = 8;
const BRIEFING_ACTIVITY_LIMIT = 300;
const WARNING_STATE_DIR = "claude-warnings";
/** Warning state is per agent session. Files older than this belong to sessions long gone. */
const WARNING_STATE_MAX_AGE_MS = 7 * 24 * HOUR_MS;

/**
 * The same three moments exist in every agent that has hooks, whatever each
 * calls them: a session starts, an edit is about to happen, an edit happened.
 * Each agent's adapter translates its own payload into this and back.
 */
export interface AgentHookEvent {
  event: "SessionStart" | "PreToolUse" | "PostToolUse";
  sessionId?: string;
  cwd?: string;
  file?: string;
  /** The agent id recorded on shared edits, such as `claude-code`. */
  agent: string;
}

/** What teamroom wants from any agent's hook, before it is put in that agent's output format. */
export type HookDecision = { type: "none" } | { type: "context"; text: string } | { type: "deny"; reason: string };

export async function decideHook(event: AgentHookEvent, workspace: Workspace): Promise<HookDecision> {
  if (event.event === "SessionStart") return { type: "context", text: await sessionBriefing(workspace) };
  if (!event.file) return { type: "none" };
  if (event.event === "PreToolUse") return guardEdit(workspace, event.file, event.sessionId);
  await reportEdit(workspace, { file: event.file, agent: event.agent });
  return { type: "none" };
}

/**
 * Tells a new agent session who else is working in the repo and on what, so
 * it can plan around them before it touches anything.
 */
async function sessionBriefing(workspace: Workspace): Promise<string> {
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
      "Avoid these files unless the task needs them. If it does, tell the user who else is in them before editing.",
      UNTRUSTED_TEXT_NOTICE
    );
  }
  return lines.join("\n");
}

function describeSession(session: SessionSummary): string {
  const where = [session.session, session.branch && `on ${oneLine(session.branch)}`].filter(Boolean).join(" ");
  const shown = session.files.slice(0, BRIEFING_MAX_FILES).map(oneLine).join(", ");
  const more = session.files.length > BRIEFING_MAX_FILES ? ` (+${session.files.length - BRIEFING_MAX_FILES} more)` : "";
  return `- ${oneLine(session.member)} in ${where}, ${formatAge(session.lastSeen)}: ${quoted(session.doing)}\n  files: ${shown}${more}`;
}

/**
 * Pauses an edit once when another session is changing the same file, with
 * the details, so the agent can tell the user or adjust. Retrying the same edit
 * goes through: teamroom informs, it never blocks work for good. Someone new
 * in the file, or a new plan for it, pauses again; more edits from the same
 * session do not.
 */
async function guardEdit(
  workspace: Workspace,
  file: string,
  agentSessionId: string | undefined
): Promise<HookDecision> {
  const repoPath = toRepoPath(workspace, file);
  if (isOutsideRepo(repoPath) || workspace.isIgnored(repoPath)) return { type: "none" };

  const { overlaps } = await checkOverlap(workspace, { files: [repoPath] });
  if (overlaps.length === 0) return { type: "none" };

  const signature = overlapSignature(overlaps.flatMap((overlap) => overlap.touchedBy));
  const state = new WarningState(workspace.commonDir, agentSessionId);
  if ((await state.lastWarned(repoPath)) === signature) return { type: "none" };
  await state.remember(repoPath, signature);

  const reason = [
    `teamroom: ${repoPath} is also being changed in another checkout:`,
    formatOverlaps(overlaps),
    "",
    "This edit was paused once so you can decide. If it is still the right move, retry the same edit and it will go through.",
    "Otherwise tell the user who else is in this file, or do other parts of the task first.",
  ].join("\n");
  return { type: "deny", reason };
}

/** Which overlaps an agent session was already told about, one small file per session. */
class WarningState {
  private readonly file: string | undefined;

  constructor(gitCommonDir: string, agentSessionId: string | undefined) {
    const dir = path.join(localStoreDir(gitCommonDir), WARNING_STATE_DIR);
    // Without a session id there is nothing to remember against, so every overlap pauses.
    this.file = agentSessionId
      ? path.join(dir, `${createHash("sha256").update(agentSessionId).digest("hex").slice(0, 32)}.json`)
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
