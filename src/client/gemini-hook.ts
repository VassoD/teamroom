import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { decideHook, type EditHookEvent, type HookOutput } from "./claude-events.js";
import type { Workspace } from "./workspace.js";

/**
 * Gemini CLI runs command hooks with a JSON payload on stdin, like Claude
 * Code, under its own event and tool names. teamroom registers one command for:
 * - SessionStart: tell the new session what other sessions are changing.
 * - BeforeTool on file writes: pause an edit once when someone else is in that file.
 * - AfterTool on file writes: share the edited file right away.
 * https://geminicli.com/docs/hooks/
 */
export const GEMINI_EDIT_TOOLS = ["write_file", "replace"] as const;
export const GEMINI_HOOK_EVENTS = ["SessionStart", "BeforeTool", "AfterTool"] as const;
export type GeminiHookEvent = (typeof GEMINI_HOOK_EVENTS)[number];
/** Also holds the MCP entry. Meant to be committed, so it only names `teamroom` on PATH, never a local install. */
export const GEMINI_SETTINGS_FILE = path.join(".gemini", "settings.json");
export const GEMINI_AGENT_ID = "gemini-cli";
const GEMINI_HOOK_NAME = "teamroom";
const HOOK_MARKER = "teamroom gemini-hook";
/** Gemini CLI takes hook timeouts in milliseconds. */
const GEMINI_HOOK_TIMEOUT_MS = 10_000;

/** A teammate without teamroom installed runs a no-op, never an error. */
export const GEMINI_HOOK_COMMAND = `command -v teamroom >/dev/null 2>&1 && ${HOOK_MARKER} || true`;

const TEAMROOM_EVENT: Record<GeminiHookEvent, EditHookEvent["event"]> = {
  SessionStart: "SessionStart",
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
};

const payloadSchema = z.object({
  hook_event_name: z.enum(GEMINI_HOOK_EVENTS),
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.object({ file_path: z.string().optional() }).loose().optional(),
});

export type GeminiHookPayload = EditHookEvent & { cwd?: string };

/** Returns what teamroom cares about in a Gemini CLI hook payload, or null when it is none of its business. */
export function parseGeminiHookPayload(rawPayload: string): GeminiHookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const { hook_event_name: geminiEvent, session_id: sessionId, cwd, tool_name: tool, tool_input: input } = parsed.data;

  const event = TEAMROOM_EVENT[geminiEvent];
  if (event === "SessionStart") return { event, sessionId, cwd, agent: GEMINI_AGENT_ID };
  if (!tool || !(GEMINI_EDIT_TOOLS as readonly string[]).includes(tool) || !input?.file_path) return null;
  return { event, sessionId, cwd, file: input.file_path, agent: GEMINI_AGENT_ID };
}

/** Gemini CLI reads `decision: "deny"` with a `reason` the model sees as the tool's error, and can retry after. */
export async function handleGeminiHook(payload: GeminiHookPayload, workspace: Workspace): Promise<HookOutput> {
  const decision = await decideHook(payload, workspace);
  switch (decision.type) {
    case "none":
      return "";
    case "context":
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: decision.text },
      });
    case "deny":
      return JSON.stringify({ decision: "deny", reason: decision.reason });
  }
}

interface HookEntry {
  name?: string;
  type?: string;
  command?: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

interface GeminiSettings {
  hooks?: Record<string, MatcherGroup[] | undefined>;
  [key: string]: unknown;
}

export type GeminiHookChange = "installed" | "unchanged" | "removed" | "absent";

function isTeamroomGroup(group: MatcherGroup): boolean {
  return group.hooks?.some((hook) => hook.command?.includes(HOOK_MARKER)) ?? false;
}

function wantedGroup(event: GeminiHookEvent): MatcherGroup {
  const hooks = [
    { name: GEMINI_HOOK_NAME, type: "command", command: GEMINI_HOOK_COMMAND, timeout: GEMINI_HOOK_TIMEOUT_MS },
  ];
  // SessionStart has no tool to match, so it runs for every session start.
  return event === "SessionStart" ? { hooks } : { matcher: GEMINI_EDIT_TOOLS.join("|"), hooks };
}

async function readSettings(file: string): Promise<GeminiSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as GeminiSettings;
  } catch {
    // Fall through: never overwrite a settings file we cannot parse.
  }
  throw new Error(`${file} is not a JSON object. Fix it by hand, then run the command again.`);
}

async function writeSettings(file: string, settings: GeminiSettings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** Adds the teamroom hooks to `.gemini/settings.json`, keeping every other setting and hook. */
export async function installGeminiHooks(repoRoot: string): Promise<{ change: GeminiHookChange; file: string }> {
  const file = path.join(repoRoot, GEMINI_SETTINGS_FILE);
  const settings = await readSettings(file);
  const hooks = { ...settings.hooks };
  let changed = false;

  for (const event of GEMINI_HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    const wanted = wantedGroup(event);
    const existing = groups.filter(isTeamroomGroup);
    if (existing.length === 1 && JSON.stringify(existing[0]) === JSON.stringify(wanted)) continue;
    hooks[event] = [...groups.filter((group) => !isTeamroomGroup(group)), wanted];
    changed = true;
  }

  if (!changed) return { change: "unchanged", file };
  await writeSettings(file, { ...settings, hooks });
  return { change: "installed", file };
}

export async function uninstallGeminiHooks(repoRoot: string): Promise<{ change: GeminiHookChange; file: string }> {
  const file = path.join(repoRoot, GEMINI_SETTINGS_FILE);
  const settings = await readSettings(file);
  const hooks: Record<string, MatcherGroup[] | undefined> = { ...settings.hooks };
  let removed = false;

  for (const [event, groups] of Object.entries(hooks)) {
    if (!groups?.some(isTeamroomGroup)) continue;
    removed = true;
    const remaining = groups.filter((group) => !isTeamroomGroup(group));
    if (remaining.length > 0) hooks[event] = remaining;
    else delete hooks[event];
  }

  if (!removed) return { change: "absent", file };
  const { hooks: _previous, ...rest } = settings;
  await writeSettings(file, Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest);
  return { change: "removed", file };
}
