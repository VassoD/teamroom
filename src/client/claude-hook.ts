import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Claude Code runs hooks at fixed points and writes a JSON payload to the
 * hook's stdin. teamroom registers one command for three of them:
 * - SessionStart: tell the new session what other sessions are changing.
 * - PreToolUse on edits: pause an edit once when someone else is in that file.
 * - PostToolUse on edits: share the edited file right away.
 * https://code.claude.com/docs/en/hooks
 */
export const CLAUDE_EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;
export const CLAUDE_HOOK_MATCHER = CLAUDE_EDIT_TOOLS.join("|");
export const CLAUDE_HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse"] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
export const CLAUDE_SETTINGS_FILE = path.join(".claude", "settings.local.json");
const CLAUDE_HOOK_TIMEOUT_SECONDS = 10;
const HOOK_MARKER = "teamroom claude-hook";

const PATH_FALLBACK = `command -v teamroom >/dev/null 2>&1 && ${HOOK_MARKER}`;

/**
 * Prefers the exact CLI that installed the hook, since an npx or local install
 * is not on PATH, then a global `teamroom`. Always exits 0, so a missing
 * install or a down server never shows up as an error in Claude Code.
 */
export function claudeHookCommand(cli?: { node: string; script: string }): string {
  if (!cli) return `${PATH_FALLBACK} || true`;
  const node = shellQuote(cli.node);
  const script = shellQuote(cli.script);
  return `{ [ -f ${script} ] && ${node} ${script} claude-hook; } || { ${PATH_FALLBACK}; } || true`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, MatcherGroup[] | undefined>;
  [key: string]: unknown;
}

export type ClaudeHookChange = "installed" | "unchanged" | "removed" | "absent";

function isTeamroomGroup(group: MatcherGroup): boolean {
  return group.hooks?.some((hook) => hook.command?.includes(HOOK_MARKER)) ?? false;
}

async function readSettings(file: string): Promise<ClaudeSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ClaudeSettings;
  } catch {
    // Fall through: never overwrite a settings file we cannot parse.
  }
  throw new Error(`${file} is not a JSON object. Fix it by hand, then run the command again.`);
}

async function writeSettings(file: string, settings: ClaudeSettings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function wantedGroup(event: ClaudeHookEvent, command: string): MatcherGroup {
  const hooks = [{ type: "command", command, timeout: CLAUDE_HOOK_TIMEOUT_SECONDS }];
  // SessionStart has no tool to match, so it runs for every session start.
  return event === "SessionStart" ? { hooks } : { matcher: CLAUDE_HOOK_MATCHER, hooks };
}

/**
 * Adds the teamroom hooks to `.claude/settings.local.json`, which Claude Code
 * treats as personal and does not commit. Other settings and hooks are kept.
 */
export async function installClaudeHooks(
  repoRoot: string,
  cli?: { node: string; script: string }
): Promise<{ change: ClaudeHookChange; file: string }> {
  const file = path.join(repoRoot, CLAUDE_SETTINGS_FILE);
  const settings = await readSettings(file);
  const command = claudeHookCommand(cli);
  const hooks = { ...settings.hooks };
  let changed = false;

  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    const wanted = wantedGroup(event, command);
    const existing = groups.filter(isTeamroomGroup);
    if (existing.length === 1 && JSON.stringify(existing[0]) === JSON.stringify(wanted)) continue;
    hooks[event] = [...groups.filter((group) => !isTeamroomGroup(group)), wanted];
    changed = true;
  }

  if (!changed) return { change: "unchanged", file };
  settings.hooks = hooks;
  await writeSettings(file, settings);
  return { change: "installed", file };
}

export async function claudeHooksInstalled(repoRoot: string): Promise<ClaudeHookEvent[]> {
  const settings = await readSettings(path.join(repoRoot, CLAUDE_SETTINGS_FILE)).catch(() => ({}) as ClaudeSettings);
  return CLAUDE_HOOK_EVENTS.filter((event) => settings.hooks?.[event]?.some(isTeamroomGroup));
}

export async function uninstallClaudeHooks(repoRoot: string): Promise<{ change: ClaudeHookChange; file: string }> {
  const file = path.join(repoRoot, CLAUDE_SETTINGS_FILE);
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
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  await writeSettings(file, settings);
  return { change: "removed", file };
}
