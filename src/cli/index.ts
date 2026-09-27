#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { installAgentsMd } from "../client/agents-md.js";
import { ApiClient } from "../client/api-client.js";
import { localStoreDir } from "../client/backend.js";
import { handleClaudeHook, parseClaudeHookPayload } from "../client/claude-events.js";
import {
  CLAUDE_HOOK_EVENTS,
  claudeHooksInstalled,
  claudeHooksWanted,
  installClaudeHooks,
  rememberClaudeHooksWanted,
  uninstallClaudeHooks,
} from "../client/claude-hook.js";
import { ENV, removeConfig, saveConfig } from "../client/config.js";
import { formatDoctor, runDoctor } from "../client/doctor.js";
import { describeError, UsageError } from "../client/errors.js";
import {
  GEMINI_SETTINGS_FILE,
  handleGeminiHook,
  installGeminiHooks,
  parseGeminiHookPayload,
  uninstallGeminiHooks,
} from "../client/gemini-hook.js";
import { Git } from "../client/git.js";
import { type CliLocation, installHooks, uninstallHooks } from "../client/hooks.js";
import { formatInviteLink, normalizeServerUrl, parseInviteLink } from "../client/invite-link.js";
import {
  type AgentId,
  CODEX_SNIPPET,
  GENERIC_MCP_DESCRIPTION,
  installMcpConfigs,
  MCP_TARGETS,
  mcpConfigHasTeamroom,
  VIBE_SNIPPET,
} from "../client/mcp-config.js";
import {
  checkOverlap,
  defaultMemberName,
  formatAge,
  formatOverlaps,
  openWorkspace,
  postNote,
  reportWork,
  requireShared,
  type Workspace,
} from "../client/workspace.js";
import { runMcpServer } from "../mcp/server.js";
import {
  DEFAULT_DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  resolveServeOptions,
  SERVE_ENV,
  ServeConfigError,
  startServer,
} from "../server/serve.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
/** `teamroom check` exits with this when it finds overlap, so scripts can react to it. */
const EXIT_OVERLAP_FOUND = 3;
const DEFAULT_STATUS_LIMIT = 20;
const ACTIVITY_SOURCES = ["human", "hook", "agent"] as const;
const CLAUDE_HOOK_STDIN_TIMEOUT_MS = 2_000;
/** Claude Code waits for these hooks, so a slow or unreachable server must give up fast. */
const CLAUDE_HOOK_NETWORK_TIMEOUT_MS = 1_500;

const HELP = `teamroom: keep parallel coding agents out of each other's files.

Every worktree, clone and agent session shares what it is changing. Before an
agent edits a file, it learns whether another session is already in it. Works
with any MCP agent: Claude Code, Codex, Cursor, Gemini CLI, Mistral Vibe and others.

Start (one command, no server, no account)
  teamroom init [--agents codex,cursor,gemini]
                                    Git hooks, MCP config for the agents this repo uses,
                                    AGENTS.md instructions, and Claude Code and Gemini CLI hooks
  teamroom doctor                   Check the setup and say how to fix what is missing

Daily use
  teamroom watch [--interval 3]     Live dashboard: every session, its agent, and the files in more than one place
  teamroom check [files...]         Who else is changing these files (default: your pending changes)
  teamroom note <text> [--files a,b]   Announce a plan before acting on it
  teamroom report [--note <text>]   Share this checkout's changes now (hooks do it on commit and checkout)
  teamroom status [--limit ${DEFAULT_STATUS_LIMIT}]
  teamroom mcp                      Run the MCP server for coding agents (stdio)

Share with teammates (optional, needs a server)
  teamroom serve [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--data-dir ${DEFAULT_DATA_DIR}] [--trust-proxy]
  teamroom create --server <url> [--room-name <name>] [--name <you>] [--create-key <key>]
  teamroom join '<invite link>' [--name <you>]
  teamroom leave                    Back to local mode
  teamroom invite rotate            Owner only. The old invite link stops working
  teamroom member remove <name>     Owner only, or yourself
  teamroom token rotate             Replace your token, for example after a leak

Maintenance
  teamroom hooks install | uninstall   Git hooks, and Claude Code and Gemini CLI hooks only

Without a shared room, teamroom runs in local mode: the worktrees of this repo on
this machine see each other through a file in the git directory. Names default to
your git user.name. Lockfiles are ignored; add more patterns in .teamroomignore.

Environment: TEAMROOM_SESSION names this checkout (default: derived from its path).
TEAMROOM_SERVER, TEAMROOM_ROOM, TEAMROOM_MEMBER, TEAMROOM_TOKEN override the shared-room config.
Server: PORT, HOST, TEAMROOM_DATA_DIR, TEAMROOM_TRUST_PROXY, TEAMROOM_CREATE_KEY.`;

type Command = (args: string[]) => Promise<number>;

interface SetupSteps {
  gitHooks: boolean;
  claudeHooks: boolean;
  mcp: boolean;
  agentsMd: boolean;
  /** Agents to configure even when the repo has no folder for them yet. */
  agents?: AgentId[];
}

const CONFIGURABLE_AGENTS = MCP_TARGETS.map((target) => target.agent);

const commands: Record<string, Command> = {
  init: async (args) => {
    const { values } = parseArgs({
      args,
      options: {
        agents: { type: "string" },
        "skip-hooks": { type: "boolean", default: false },
        "skip-claude": { type: "boolean", default: false },
        "skip-mcp": { type: "boolean", default: false },
        "skip-agents-md": { type: "boolean", default: false },
      },
    });
    const workspace = await openWorkspace(process.cwd());
    await setUp(workspace.git, workspace.repoRoot, {
      gitHooks: !values["skip-hooks"],
      claudeHooks: !values["skip-claude"],
      mcp: !values["skip-mcp"],
      agentsMd: !values["skip-agents-md"],
      agents: parseAgents(values.agents),
    });
    print(
      workspace.mode === "local"
        ? "\nLocal mode: every worktree of this repo on this machine now sees the others. Nothing leaves this machine."
        : `\nShared mode: you are ${workspace.member} in a room on ${workspace.config?.server}.`
    );
    print("Try it: open two worktrees with an agent in each, then run `teamroom watch`.");
    if (workspace.mode === "local")
      print("To include teammates on other machines, see `teamroom --help` (Share with teammates).");
    return EXIT_OK;
  },

  serve: async (args) => {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        "data-dir": { type: "string" },
        "trust-proxy": { type: "boolean" },
      },
    });
    let options: ReturnType<typeof resolveServeOptions>;
    try {
      options = resolveServeOptions({
        port: values.port,
        host: values.host,
        dataDir: values["data-dir"],
        trustProxy: values["trust-proxy"],
      });
    } catch (error) {
      if (error instanceof ServeConfigError) throw new UsageError(error.message);
      throw error;
    }
    startServer(options);
    // Keep the process alive until the server shuts itself down on a signal.
    await new Promise<never>(() => undefined);
    return EXIT_OK;
  },

  create: async (args) => {
    const { values } = parseArgs({
      args,
      options: {
        server: { type: "string" },
        "room-name": { type: "string" },
        name: { type: "string" },
        "skip-hooks": { type: "boolean", default: false },
        "skip-agents": { type: "boolean", default: false },
        "create-key": { type: "string" },
      },
    });
    const serverInput = values.server ?? process.env[ENV.server];
    if (!serverInput) {
      throw new UsageError(
        `--server is required. A shared room lives on a teamroom server (see \`teamroom serve\`). For worktrees on this machine only, \`teamroom init\` is enough.`
      );
    }
    const server = normalizeServerUrl(serverInput);
    const git = new Git(process.cwd());
    const [repoRoot, commonDir] = await Promise.all([git.repoRoot(), git.commonDir()]);
    const name = await defaultMemberName(git, values.name);
    const roomName = values["room-name"]?.trim() || path.basename(repoRoot);

    const createKey = values["create-key"] ?? process.env[SERVE_ENV.createKey];
    const created = await new ApiClient({ server }).createRoom(roomName, name, createKey);
    await saveConfig(commonDir, { server, roomId: created.room.id, member: created.me, token: created.token });
    print(`Created room "${created.room.name}". You are ${created.me}, the owner.`);
    await setUp(git, repoRoot, {
      gitHooks: !values["skip-hooks"],
      claudeHooks: !values["skip-agents"],
      mcp: !values["skip-agents"],
      agentsMd: !values["skip-agents"],
    });

    const link = formatInviteLink({ server, roomId: created.room.id, inviteCode: created.inviteCode });
    print("\nInvite teammates with this link. Anyone who has it can join, so share it privately:");
    print(`  ${link}`);
    print("\nThey run, inside their clone of this repo:");
    print(`  teamroom join '${link}'`);
    return EXIT_OK;
  },

  join: async (args) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        server: { type: "string" },
        room: { type: "string" },
        invite: { type: "string" },
        name: { type: "string" },
        "skip-hooks": { type: "boolean", default: false },
      },
    });
    const [link] = positionals;
    const invite = link
      ? parseInviteLink(link)
      : {
          server: normalizeServerUrl(requireOption(values.server, "--server (or pass the invite link)")),
          roomId: requireOption(values.room, "--room"),
          inviteCode: requireOption(values.invite, "--invite"),
        };
    const git = new Git(process.cwd());
    const [repoRoot, commonDir] = await Promise.all([git.repoRoot(), git.commonDir()]);
    const name = await defaultMemberName(git, values.name);

    const joined = await new ApiClient({ server: invite.server }).joinRoom(invite.roomId, name, invite.inviteCode);
    await saveConfig(commonDir, {
      server: invite.server,
      roomId: joined.room.id,
      member: joined.me,
      token: joined.token,
    });
    print(`Joined "${joined.room.name}" as ${joined.me}.`);
    // MCP configs and AGENTS.md are committed by whoever created the room, so joiners normally get them with the repo.
    const hasMcp = await mcpConfigHasTeamroom(repoRoot).catch(() => false);
    await setUp(git, repoRoot, {
      gitHooks: !values["skip-hooks"],
      claudeHooks: !values["skip-hooks"],
      mcp: !hasMcp,
      agentsMd: false,
    });
    return EXIT_OK;
  },

  leave: async () => {
    const workspace = await openWorkspace(process.cwd());
    const config = requireShared(workspace);
    try {
      await new ApiClient({ server: config.server, token: config.token, maxAttempts: 1 }).removeMember(
        config.roomId,
        config.member
      );
    } catch (error) {
      print(`Could not remove you from the room on the server (${describeError(error)}). Leaving locally anyway.`);
    }
    await removeConfig(workspace.commonDir);
    print("Left the shared room. This repo is back in local mode.");
    return EXIT_OK;
  },

  doctor: async () => {
    const checks = await runDoctor(process.cwd());
    print(formatDoctor(checks));
    return checks.some((check) => check.status === "fail") ? EXIT_FAILURE : EXIT_OK;
  },

  hooks: async (args) => {
    const [action] = args;
    if (action !== "install" && action !== "uninstall")
      throw new UsageError("Use `teamroom hooks install` or `uninstall`.");
    const git = new Git(process.cwd());
    const [hooksDir, repoRoot, commonDir] = await Promise.all([git.hooksDir(), git.repoRoot(), git.commonDir()]);
    const cli = await currentCli();
    const changes = action === "install" ? await installHooks(hooksDir, cli) : await uninstallHooks(hooksDir);
    for (const [hook, change] of Object.entries(changes)) print(`git ${hook}: ${change}`);
    const claude =
      action === "install" ? await installClaudeHooks(repoRoot, cli) : await uninstallClaudeHooks(repoRoot);
    await rememberClaudeHooksWanted(localStoreDir(commonDir), action === "install");
    print(`Claude Code hooks: ${claude.change} (${path.relative(repoRoot, claude.file)})`);
    if (action === "install" && claude.change === "installed") {
      print("Restart Claude Code sessions in this repo to pick them up.");
    }
    if (action === "uninstall" || (await usesGemini(repoRoot, []))) {
      const gemini = action === "install" ? await installGeminiHooks(repoRoot) : await uninstallGeminiHooks(repoRoot);
      print(`Gemini CLI hooks: ${gemini.change} (${path.relative(repoRoot, gemini.file)})`);
    }
    return EXIT_OK;
  },

  // Called by Claude Code at session start and around each file edit. Always exits 0: it must never get in Claude's way.
  "claude-hook": async () => {
    try {
      const payload = parseClaudeHookPayload(await readStdin(CLAUDE_HOOK_STDIN_TIMEOUT_MS));
      if (!payload) return EXIT_OK;
      const workspace = await openWorkspace(payload.cwd ?? process.cwd(), {
        timeoutMs: CLAUDE_HOOK_NETWORK_TIMEOUT_MS,
        maxAttempts: 1,
      });
      const output = await handleClaudeHook(payload, workspace);
      if (output) print(output);
    } catch {
      // Not a git repo, server down, or a file outside the repo: nothing to say.
    }
    return EXIT_OK;
  },

  // Called by Gemini CLI at session start and around each file write. Always exits 0, like `claude-hook`.
  "gemini-hook": async () => {
    try {
      const payload = parseGeminiHookPayload(await readStdin(CLAUDE_HOOK_STDIN_TIMEOUT_MS));
      if (!payload) return EXIT_OK;
      const workspace = await openWorkspace(payload.cwd ?? process.cwd(), {
        timeoutMs: CLAUDE_HOOK_NETWORK_TIMEOUT_MS,
        maxAttempts: 1,
      });
      const output = await handleGeminiHook(payload, workspace);
      if (output) print(output);
    } catch {
      // Not a git repo, server down, or a file outside the repo: nothing to say.
    }
    return EXIT_OK;
  },

  check: async (args) => {
    const { values, positionals } = parseArgs({
      args,
      options: { "since-hours": { type: "string" } },
      allowPositionals: true,
    });
    const workspace = await openWorkspace(process.cwd());
    const check = await checkOverlap(workspace, {
      files: positionals,
      sinceHours: parseOptionalInt(values["since-hours"], "--since-hours"),
    });
    if (check.files.length === 0) {
      print("Nothing to check: no files given and no pending changes.");
      return EXIT_OK;
    }
    print(formatOverlaps(check.overlaps));
    return check.overlaps.length > 0 ? EXIT_OVERLAP_FOUND : EXIT_OK;
  },

  report: async (args) => {
    const { values } = parseArgs({
      args,
      options: {
        note: { type: "string" },
        source: { type: "string", default: "human" },
        quiet: { type: "boolean", default: false },
      },
    });
    const source = ACTIVITY_SOURCES.find((candidate) => candidate === values.source);
    if (!source) throw new UsageError(`--source must be one of ${ACTIVITY_SOURCES.join(", ")}.`);
    const workspace = await openWorkspace(process.cwd());
    if (source === "hook") await adoptClaudeHooks(workspace);
    const { activity, omittedFiles } = await reportWork(workspace, { source, note: values.note });
    if (!values.quiet) {
      const omitted = omittedFiles > 0 ? `, ${omittedFiles} left out (over the limit)` : "";
      print(`Reported ${activity.files.length} file(s)${omitted} as session ${workspace.session}.`);
    }
    return EXIT_OK;
  },

  note: async (args) => {
    const { values, positionals } = parseArgs({ args, options: { files: { type: "string" } }, allowPositionals: true });
    const text = positionals.join(" ").trim();
    if (!text) throw new UsageError('Usage: teamroom note "about to refactor auth" [--files src/auth.ts,src/user.ts]');
    const files = values.files
      ?.split(",")
      .map((file) => file.trim())
      .filter(Boolean);
    const workspace = await openWorkspace(process.cwd());
    await postNote(workspace, { text, files, source: "human" });
    print("Note posted.");
    return EXIT_OK;
  },

  status: async (args) => {
    const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
    const limit = parseOptionalInt(values.limit, "--limit") ?? DEFAULT_STATUS_LIMIT;
    const workspace = await openWorkspace(process.cwd());
    const { room, me } = await workspace.backend.getRoom(limit);
    const where = workspace.mode === "local" ? "local mode" : `shared room ${room.id}`;
    print(`${room.name} (${where}), you are ${me}, session ${workspace.session}`);
    if (workspace.mode === "shared") {
      print(
        `Members: ${room.members.map((member) => (member.role === "owner" ? `${member.name} (owner)` : member.name)).join(", ")}`
      );
    }
    const shown = room.activity.filter((entry) => entry.kind !== "presence");
    if (shown.length === 0) {
      print("\nNo activity yet.");
      return EXIT_OK;
    }
    print("");
    for (const entry of [...shown].reverse()) {
      const files = entry.files.length > 0 ? ` [${entry.files.length} file(s)]` : "";
      const session = entry.session ? ` (${entry.session})` : "";
      print(`${formatAge(entry.createdAt).padEnd(9)} ${entry.member}${session} ${entry.kind}: ${entry.text}${files}`);
    }
    return EXIT_OK;
  },

  watch: async (args) => {
    const { values } = parseArgs({ args, options: { interval: { type: "string" } } });
    const intervalSeconds = parseOptionalInt(values.interval, "--interval");
    const workspace = await openWorkspace(process.cwd());
    // Loaded on demand so hooks and scripts never pay for React and Ink.
    const { runDashboard } = await import("../dashboard/run.js");
    await runDashboard(workspace, intervalSeconds === undefined ? undefined : intervalSeconds * 1000);
    return EXIT_OK;
  },

  mcp: async () => {
    await runMcpServer(() => openWorkspace(process.cwd()), { autoReport: process.env[ENV.autoReport] !== "0" });
    return EXIT_OK;
  },

  invite: async (args) => {
    if (args[0] !== "rotate") throw new UsageError("Use `teamroom invite rotate`.");
    const config = requireShared(await openWorkspace(process.cwd()));
    const client = new ApiClient({ server: config.server, token: config.token });
    const inviteCode = await client.rotateInvite(config.roomId);
    const link = formatInviteLink({ server: config.server, roomId: config.roomId, inviteCode });
    print("The old invite link no longer works. New one:");
    print(`  ${link}`);
    return EXIT_OK;
  },

  member: async (args) => {
    const [action, name] = args;
    if (action !== "remove" || !name) throw new UsageError("Use `teamroom member remove <name>`.");
    const config = requireShared(await openWorkspace(process.cwd()));
    await new ApiClient({ server: config.server, token: config.token }).removeMember(config.roomId, name);
    print(`${name} was removed and their token revoked.`);
    return EXIT_OK;
  },

  token: async (args) => {
    if (args[0] !== "rotate") throw new UsageError("Use `teamroom token rotate`.");
    const workspace = await openWorkspace(process.cwd());
    const config = requireShared(workspace);
    const token = await new ApiClient({ server: config.server, token: config.token }).rotateToken(config.roomId);
    const file = await saveConfig(workspace.commonDir, { ...config, token });
    print(`Token replaced and saved to ${file}. Update TEAMROOM_TOKEN anywhere you set it by hand.`);
    return EXIT_OK;
  },
};

async function setUp(git: Git, repoRoot: string, steps: SetupSteps): Promise<void> {
  const cli = await currentCli();
  if (steps.gitHooks) {
    await installHooks(await git.hooksDir(), cli);
    print("Git hooks: commits, checkouts, merges and rebases are shared automatically.");
  }
  if (steps.mcp) await setUpMcp(repoRoot, steps.agents ?? []);
  if (steps.agentsMd) {
    const { file, change } = await installAgentsMd(repoRoot);
    print(
      `AGENTS.md (${change}): tells every agent to announce its plan and check before editing. ${relativeTo(file)}`
    );
  }
  if (steps.claudeHooks) {
    const { change } = await installClaudeHooks(repoRoot, cli);
    await rememberClaudeHooksWanted(localStoreDir(await git.commonDir()), true);
    print(
      `Claude Code hooks (${change}): sessions are briefed on the others, and an edit to a file another session is changing is paused once with the details.`
    );
    if (change === "installed") print("  Restart Claude Code sessions in this repo to pick them up.");
    if (await usesGemini(repoRoot, steps.agents ?? [])) {
      const gemini = await installGeminiHooks(repoRoot);
      print(
        `Gemini CLI hooks (${gemini.change}): the same briefing and pause, in ${relativeTo(gemini.file)}. Commit it with the MCP config.`
      );
    }
  }
}

/** Same rule as the MCP config: only when the repo already has a `.gemini` folder, or init was told to. */
async function usesGemini(repoRoot: string, forced: AgentId[]): Promise<boolean> {
  if (forced.includes("gemini")) return true;
  try {
    await fs.access(path.join(repoRoot, path.dirname(GEMINI_SETTINGS_FILE)));
    return true;
  } catch {
    return false;
  }
}

/**
 * `.claude/settings.local.json` is not committed, so a worktree created after
 * `init` would start without the Claude Code hooks. `git worktree add` runs
 * the post-checkout hook in the new worktree, which lands here and installs
 * them, as long as the repo asked for them once. Never fails the report.
 */
async function adoptClaudeHooks(workspace: Workspace): Promise<void> {
  try {
    if (!(await claudeHooksWanted(localStoreDir(workspace.commonDir)))) return;
    if ((await claudeHooksInstalled(workspace.repoRoot)).length === CLAUDE_HOOK_EVENTS.length) return;
    await installClaudeHooks(workspace.repoRoot, await currentCli());
  } catch {
    // An unreadable settings file stays as it is; `teamroom doctor` points at it.
  }
}

async function setUpMcp(repoRoot: string, forced: AgentId[]): Promise<void> {
  const results = await installMcpConfigs(repoRoot, forced);
  for (const { label, file, change } of results) {
    print(`MCP for ${label} (${change}): ${relativeTo(file)}`);
  }
  if (results.length > 0) print("  Commit these so everyone's agents get teamroom.");
  const configured = new Set(results.map((result) => result.agent));
  print("\nOther agents: the MCP server shares their changes as they work.");
  if (!configured.has("codex"))
    print(`  Codex, in ~/.codex/config.toml (or run init with --agents codex):\n${indent(CODEX_SNIPPET, 4)}`);
  print(`  Mistral Vibe, in ~/.vibe/config.toml:\n${indent(VIBE_SNIPPET, 4)}`);
  print(`  ${GENERIC_MCP_DESCRIPTION}`);
}

function parseAgents(raw: string | undefined): AgentId[] {
  const requested = (raw ?? "")
    .split(",")
    .map((agent) => agent.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((agent) => !CONFIGURABLE_AGENTS.includes(agent as AgentId));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown agent ${unknown.join(", ")}. Choose from ${CONFIGURABLE_AGENTS.join(", ")}.`);
  }
  return requested as AgentId[];
}

function relativeTo(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

function indent(text: string, spaces = 2): string {
  const padding = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${padding}${line}`)
    .join("\n");
}

/** Reads all of stdin, giving up after `timeoutMs` so a hook never hangs when nothing is piped in. */
async function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  const read = (async () => {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  })();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref());
  await Promise.race([read, timeout]);
  return Buffer.concat(chunks).toString("utf8");
}

/** npx runs from a throwaway cache, so pinning its path would break once the cache is cleared. */
async function currentCli(): Promise<CliLocation | undefined> {
  const script = process.argv[1];
  if (!script) return undefined;
  const resolved = await fs.realpath(script);
  return resolved.includes(`${path.sep}_npx${path.sep}`) ? undefined : { node: process.execPath, script: resolved };
}

function requireOption(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new UsageError(`${flag} is required.`);
  return value.trim();
}

function parseOptionalInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`${flag} must be a positive integer.`);
  return parsed;
}

function isParseArgsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    print(HELP);
    return name ? EXIT_OK : EXIT_USAGE;
  }
  const command = commands[name];
  if (!command) {
    process.stderr.write(`Unknown command "${name}". Run \`teamroom --help\`.\n`);
    return EXIT_USAGE;
  }
  try {
    return await command(rest);
  } catch (error) {
    process.stderr.write(`teamroom: ${describeError(error)}\n`);
    return error instanceof UsageError || isParseArgsError(error) ? EXIT_USAGE : EXIT_FAILURE;
  }
}

process.exitCode = await main(process.argv.slice(2));
