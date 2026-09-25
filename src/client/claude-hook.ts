import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Claude Code runs PostToolUse hooks after each tool call and writes a JSON
 * payload to the hook's stdin. teamroom only reads the fields it needs.
 * https://code.claude.com/docs/en/hooks
 */
export const CLAUDE_EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;
export const CLAUDE_HOOK_MATCHER = CLAUDE_EDIT_TOOLS.join("|");
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

const payloadSchema = z.object({
  cwd: z.string().optional(),
  tool_name: z.string(),
  tool_input: z
    .object({
      file_path: z.string().optional(),
      notebook_path: z.string().optional(),
    })
    .loose()
    .optional(),
});

export interface ClaudeEdit {
  cwd?: string;
  tool: string;
  file: string;
}

/** Returns the edited file from a PostToolUse payload, or null when the payload is not a file edit. */
export function parseClaudeEdit(rawPayload: string): ClaudeEdit | null {
  let json: unknown;
  try {
    json = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const { cwd, tool_name: tool, tool_input: input } = parsed.data;
  if (!(CLAUDE_EDIT_TOOLS as readonly string[]).includes(tool)) return null;
  const file = input?.file_path ?? input?.notebook_path;
  return file ? { cwd, tool, file } : null;
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
  hooks?: Record<string, MatcherGroup[] | undefined> & { PostToolUse?: MatcherGroup[] };
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

/**
 * Adds the PostToolUse hook to `.claude/settings.local.json`, which Claude Code
 * treats as personal and does not commit. Other settings and hooks are kept.
 */
export async function installClaudeHook(
  repoRoot: string,
  cli?: { node: string; script: string }
): Promise<{ change: ClaudeHookChange; file: string }> {
  const file = path.join(repoRoot, CLAUDE_SETTINGS_FILE);
  const settings = await readSettings(file);
  const groups = settings.hooks?.PostToolUse ?? [];
  const wanted: MatcherGroup = {
    matcher: CLAUDE_HOOK_MATCHER,
    hooks: [{ type: "command", command: claudeHookCommand(cli), timeout: CLAUDE_HOOK_TIMEOUT_SECONDS }],
  };

  const existing = groups.find(isTeamroomGroup);
  if (existing && JSON.stringify(existing) === JSON.stringify(wanted)) return { change: "unchanged", file };

  settings.hooks = { ...settings.hooks, PostToolUse: [...groups.filter((group) => !isTeamroomGroup(group)), wanted] };
  await writeSettings(file, settings);
  return { change: "installed", file };
}

export async function uninstallClaudeHook(repoRoot: string): Promise<{ change: ClaudeHookChange; file: string }> {
  const file = path.join(repoRoot, CLAUDE_SETTINGS_FILE);
  const settings = await readSettings(file);
  const groups = settings.hooks?.PostToolUse ?? [];
  if (!groups.some(isTeamroomGroup)) return { change: "absent", file };

  const remaining = groups.filter((group) => !isTeamroomGroup(group));
  const { PostToolUse: _removed, ...otherEvents } = settings.hooks ?? {};
  const hooks = remaining.length > 0 ? { ...otherEvents, PostToolUse: remaining } : otherEvents;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  await writeSettings(file, settings);
  return { change: "removed", file };
}
