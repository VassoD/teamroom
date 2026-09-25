import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mcpConfigHasTeamroom } from "./agents.js";
import { ApiClient } from "./api-client.js";
import { loadConfig } from "./config.js";
import { describeError } from "./errors.js";
import { Git } from "./git.js";
import { HOOK_NAMES, installedHooks } from "./hooks.js";

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

  const hooks = await installedHooks(await git.hooksDir());
  const missingHooks = HOOK_NAMES.filter((name) => !hooks.includes(name));
  checks.push(
    missingHooks.length === 0
      ? { name: "Git hooks", status: "ok", detail: "Commits, checkouts, merges and rebases are reported." }
      : {
          name: "Git hooks",
          status: "warn",
          detail: `Missing: ${missingHooks.join(", ")}. Your work is only shared when you run \`teamroom report\`.`,
          fix: "teamroom hooks install",
        }
  );

  const hasMcp = await mcpConfigHasTeamroom(repoRoot).catch(() => false);
  checks.push(
    hasMcp
      ? { name: "Agent setup", status: "ok", detail: ".mcp.json lists the teamroom server." }
      : {
          name: "Agent setup",
          status: "warn",
          detail: "Claude Code will not see the teamroom tools in this repo.",
          fix: "teamroom agents install",
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
    checks.push({ name: "Membership", status: "ok", detail: `${config.member} in ${config.roomId}` });
  } catch (error) {
    checks.push({
      name: "Membership",
      status: "fail",
      detail: describeError(error),
      fix: "teamroom join '<invite link>'",
    });
    return checks;
  }

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
