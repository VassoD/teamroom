import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { agentHookStatus } from "./agent-hooks.js";
import { agentsMdHasTeamroom } from "./agents-md.js";
import { ApiClient } from "./api-client.js";
import { localStoreDir } from "./backend.js";
import { loadConfig } from "./config.js";
import { describeError } from "./errors.js";
import { Git } from "./git.js";
import { HOOK_NAMES, installedHooks } from "./hooks.js";
import { mcpConfigHasTeamroom } from "./mcp-config.js";

const execFileAsync = promisify(execFile);
const COMMAND_LOOKUP_TIMEOUT_MS = 2_000;

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to run or change to fix it. */
  fix?: string;
}

interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  commandOnPath?: (command: string) => Promise<boolean>;
}

/**
 * Runs every check it can instead of stopping at the first failure, so one
 * run shows the whole picture. Later checks are skipped only when they
 * cannot mean anything, such as token checks without a config.
 */
export async function runDoctor(cwd: string, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const env = options.env ?? process.env;
  const commandOnPath = options.commandOnPath ?? isCommandOnPath;
  const checks: DoctorCheck[] = [];
  const git = new Git(cwd);

  let repoRoot: string;
  let commonDir: string;
  try {
    [repoRoot, commonDir] = await Promise.all([git.repoRoot(), git.commonDir()]);
    checks.push({ name: "Git repository", status: "ok", detail: repoRoot });
  } catch (error) {
    checks.push({ name: "Git repository", status: "fail", detail: describeError(error), fix: "cd into your repo" });
    return checks;
  }

  const onPath = await commandOnPath("teamroom");
  checks.push(
    onPath
      ? { name: "teamroom on PATH", status: "ok", detail: "Agents and hooks can launch it." }
      : {
          name: "teamroom on PATH",
          status: "warn",
          detail: "MCP configs and teammates' hooks call `teamroom` by name.",
          fix: "npm install --global teamroom",
        }
  );

  const hooksPath = await git.hooksPathSetting();
  const huskyDir = hooksPath && HUSKY_HOOKS_DIR.test(hooksPath) ? huskyRoot(repoRoot, hooksPath) : undefined;
  const viaHusky = huskyDir ? await hooksCallingTeamroom(huskyDir) : [];
  const hooks = new Set([...(await installedHooks(await git.hooksDir())), ...viaHusky]);
  const missingHooks = HOOK_NAMES.filter((name) => !hooks.has(name));
  checks.push(
    missingHooks.length === 0
      ? { name: "Git hooks", status: "ok", detail: "Commits, checkouts, merges and rebases are reported." }
      : {
          name: "Git hooks",
          status: "warn",
          detail: `Missing: ${missingHooks.join(", ")}. Your work is only shared when you run \`teamroom report\`.`,
          fix: huskyDir ? "see Git hooks folder below" : "teamroom init",
        }
  );
  if (hooksPath) {
    const huskyDone = huskyDir !== undefined && viaHusky.length === HOOK_NAMES.length;
    checks.push(
      huskyDone
        ? { name: "Git hooks folder", status: "ok", detail: "husky runs teamroom from its own hook files." }
        : describeHooksPath(hooksPath)
    );
  }

  const { withHooks, mcpOnly } = await agentHookStatus(repoRoot).catch(() => ({ withHooks: [], mcpOnly: [] }));
  const incomplete = withHooks.filter((status) => status.missingEvents.length > 0);
  const mcpOnlyNote =
    mcpOnly.length > 0
      ? ` ${mcpOnly.join(", ")} ${mcpOnly.length === 1 ? "has" : "have"} no hooks yet and hear about overlap through MCP only.`
      : "";
  checks.push(
    incomplete.length === 0
      ? {
          name: "Agent hooks",
          status: "ok",
          detail: `On for ${withHooks.map((status) => status.label).join(", ")}: sessions are briefed and edits are checked before they happen.${mcpOnlyNote}`,
        }
      : {
          name: "Agent hooks",
          status: "warn",
          detail: `Missing for ${incomplete.map((status) => `${status.label} (${status.missingEvents.join(", ")})`).join(", ")}. Those agents then check overlap only when they think to.${mcpOnlyNote}`,
          fix: "teamroom init",
        }
  );

  const hasMcp = await mcpConfigHasTeamroom(repoRoot).catch(() => false);
  checks.push(
    hasMcp
      ? { name: "Agent setup", status: "ok", detail: "The teamroom MCP server is configured for this repo." }
      : {
          name: "Agent setup",
          status: "warn",
          detail: "Agents will not see the teamroom tools in this repo.",
          fix: "teamroom init",
        }
  );

  const hasAgentsMd = await agentsMdHasTeamroom(repoRoot).catch(() => false);
  checks.push(
    hasAgentsMd
      ? {
          name: "Agent instructions",
          status: "ok",
          detail: "AGENTS.md tells agents to announce plans and check overlap.",
        }
      : {
          name: "Agent instructions",
          status: "warn",
          detail: "Agents without teamroom hooks will not know to check before editing.",
          fix: "teamroom init",
        }
  );

  const baseRef = await git.defaultBranchRef();
  checks.push(
    baseRef
      ? { name: "Default branch", status: "ok", detail: `Pending changes are measured against ${baseRef}.` }
      : {
          name: "Default branch",
          status: "warn",
          detail: "No origin/main, origin/master, main or master. Only uncommitted changes are shared.",
          fix: "git fetch origin",
        }
  );

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(commonDir, env);
  } catch (error) {
    checks.push({
      name: "Mode",
      status: "fail",
      detail: describeError(error),
      fix: "teamroom leave (back to local mode), or teamroom join '<invite link>'",
    });
    return checks;
  }

  if (!config) {
    checks.push({
      name: "Mode",
      status: "ok",
      detail: "Local: every worktree of this repo on this machine sees the others. No server involved.",
    });
    const storeDir = localStoreDir(commonDir);
    try {
      await fs.mkdir(storeDir, { recursive: true });
      await fs.access(storeDir, fs.constants.W_OK);
      checks.push({ name: "Local store", status: "ok", detail: storeDir });
    } catch (error) {
      checks.push({
        name: "Local store",
        status: "fail",
        detail: describeError(error),
        fix: `Make ${storeDir} writable by you.`,
      });
    }
    return checks;
  }
  checks.push({ name: "Mode", status: "ok", detail: `Shared: ${config.member} in ${config.roomId}` });

  const client = new ApiClient({ server: config.server, token: config.token, maxAttempts: 1 });
  try {
    await client.health();
    checks.push({ name: "Server", status: "ok", detail: `${config.server} is up.` });
  } catch (error) {
    checks.push({
      name: "Server",
      status: "fail",
      detail: describeError(error),
      fix: "Check the URL, your network, or ask whoever runs the server.",
    });
    return checks;
  }

  try {
    const { room } = await client.getRoom(config.roomId, 1);
    checks.push({ name: "Token", status: "ok", detail: `Accepted by "${room.name}".` });
  } catch (error) {
    checks.push({
      name: "Token",
      status: "fail",
      detail: describeError(error),
      fix: "You may have been removed or your token rotated. Ask for a new invite link and join again.",
    });
  }
  return checks;
}

const HUSKY_HOOKS_DIR = /(^|\/)\.husky(\/_)?\/?$/;
const HUSKY_GENERATED_DIR = /(^|\/)\.husky\/_\/?$/;
/** Committed by the repo, so it only names `teamroom` on PATH and does nothing where it is not installed. */
const HUSKY_REPORT_COMMAND = "teamroom report --source hook";
const HUSKY_REPORT_LINE = `command -v teamroom >/dev/null 2>&1 && (${HUSKY_REPORT_COMMAND} --quiet >/dev/null 2>&1 &)`;
const HUSKY_HOOK_FILES = HOOK_NAMES.map((name) => `.husky/${name}`).join(", ");

/** husky 9 points git at the generated `.husky/_` and runs the hook files one folder up. */
function huskyRoot(repoRoot: string, hooksPath: string): string {
  const resolved = path.resolve(repoRoot, hooksPath);
  return path.basename(resolved) === "_" ? path.dirname(resolved) : resolved;
}

/** Hooks whose husky file already runs `teamroom report`, as the fix below suggests. */
async function hooksCallingTeamroom(huskyDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of HOOK_NAMES) {
    const content = await fs.readFile(path.join(huskyDir, name), "utf8").catch(() => "");
    if (content.includes(HUSKY_REPORT_COMMAND)) found.push(name);
  }
  return found;
}

/**
 * teamroom installs its git hooks wherever git runs hooks from. When a tool
 * owns that folder, the hooks can vanish on the tool's next install, or end
 * up in committed files with this machine's paths in them.
 */
function describeHooksPath(hooksPath: string): DoctorCheck {
  if (!HUSKY_HOOKS_DIR.test(hooksPath)) {
    return {
      name: "Git hooks folder",
      status: "ok",
      detail: `core.hooksPath is ${hooksPath}. If a tool regenerates that folder, run \`teamroom doctor\` afterwards to check teamroom's hooks are still there.`,
    };
  }
  const problem = HUSKY_GENERATED_DIR.test(hooksPath)
    ? "husky rewrites that folder on every install, which silently removes teamroom's git hooks"
    : "husky's hook files are committed, so teamroom's hooks there carry this machine's paths to everyone";
  return {
    name: "Git hooks folder",
    status: "warn",
    detail: `core.hooksPath is ${hooksPath}, managed by husky: ${problem}.`,
    fix: `add \`${HUSKY_REPORT_LINE}\` to ${HUSKY_HOOK_FILES} (remove any teamroom block there) and commit them`,
  };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const symbols: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
  return checks
    .map((check) => {
      const line = `${symbols[check.status]} ${check.name}: ${check.detail}`;
      return check.fix && check.status !== "ok" ? `${line}\n    fix: ${check.fix}` : line;
    })
    .join("\n");
}

async function isCommandOnPath(command: string): Promise<boolean> {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(lookup, [command], { timeout: COMMAND_LOOKUP_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
