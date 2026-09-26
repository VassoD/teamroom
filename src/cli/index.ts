#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ApiClient } from "../client/api-client.js";
import { installClaudeHook, parseClaudeEdit, uninstallClaudeHook } from "../client/claude-hook.js";
import { ENV, saveConfig } from "../client/config.js";
import { formatDoctor, runDoctor } from "../client/doctor.js";
import { describeError, UsageError } from "../client/errors.js";
import { Git } from "../client/git.js";
import { type CliLocation, installHooks, uninstallHooks } from "../client/hooks.js";
import { formatInviteLink, normalizeServerUrl, parseInviteLink } from "../client/invite-link.js";
import { AGENT_INSTRUCTION, CODEX_SNIPPET, installMcpConfig, mcpConfigHasTeamroom } from "../client/mcp-config.js";
import {
  checkOverlap,
  formatAge,
  formatOverlaps,
  openWorkspace,
  postNote,
  reportEdit,
  reportWork,
} from "../client/workspace.js";
import { MAX_NAME_LENGTH } from "../core/schemas.js";
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

const HELP = `teamroom: know what your teammates (and their agents) are touching before the merge conflict does.

Setup
  teamroom serve [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--data-dir ${DEFAULT_DATA_DIR}] [--trust-proxy]
  teamroom create --server <url> [--room-name <name>] [--name <you>] [--create-key <key>]
  teamroom join '<invite link>' [--name <you>]
  teamroom agents install           Let Claude Code and Codex use teamroom in this repo
  teamroom hooks install | uninstall [--claude]   --claude also reports each file Claude Code edits
  teamroom doctor                   Check the setup and say how to fix what is missing

Daily use
  teamroom check [files...]         Who else is touching these files (default: your pending changes)
  teamroom report [--note <text>]   Share the files this checkout is changing
  teamroom note <text> [--files a,b]
  teamroom status [--limit ${DEFAULT_STATUS_LIMIT}]
  teamroom watch [--interval 3]     Live dashboard: teammates, their agents, and what each is doing
  teamroom mcp                      Run the MCP server for coding agents (stdio)

Room admin
  teamroom invite rotate            Owner only. The old invite code stops working
  teamroom member remove <name>     Owner only, or yourself
  teamroom token rotate             Replace your token, for example after a leak

Names default to your git user.name, the room name to the repo folder. create and join
install the git hooks unless you pass --skip-hooks.

Server environment: PORT, HOST, TEAMROOM_DATA_DIR, TEAMROOM_TRUST_PROXY, and TEAMROOM_CREATE_KEY
(when set, creating a room needs that key; joining with an invite link does not).

Environment: TEAMROOM_SERVER, TEAMROOM_ROOM, TEAMROOM_MEMBER, TEAMROOM_TOKEN override the
repo config. TEAMROOM_SESSION names this checkout (default: derived from its path).`;

type Command = (args: string[]) => Promise<number>;

const commands: Record<string, Command> = {
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
        `--server is required. To try teamroom locally, run \`teamroom serve\` in another terminal and pass --server http://${DEFAULT_HOST}:${DEFAULT_PORT}.`
      );
    }
    const server = normalizeServerUrl(serverInput);
    const git = new Git(process.cwd());
    const [repoRoot, commonDir] = await Promise.all([git.repoRoot(), git.commonDir()]);
    const name = await memberName(values.name, git);
    const roomName = values["room-name"]?.trim() || path.basename(repoRoot);

    const createKey = values["create-key"] ?? process.env[SERVE_ENV.createKey];
    const created = await new ApiClient({ server }).createRoom(roomName, name, createKey);
    await saveConfig(commonDir, { server, roomId: created.room.id, member: created.me, token: created.token });
    print(`Created room "${created.room.name}". You are ${created.me}, the owner.`);
    await finishSetup(git, repoRoot, { hooks: !values["skip-hooks"], agents: !values["skip-agents"] });

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
    const name = await memberName(values.name, git);

    const joined = await new ApiClient({ server: invite.server }).joinRoom(invite.roomId, name, invite.inviteCode);
    await saveConfig(commonDir, {
      server: invite.server,
      roomId: joined.room.id,
      member: joined.me,
      token: joined.token,
    });
    print(`Joined "${joined.room.name}" as ${joined.me}.`);
    // .mcp.json is committed by whoever created the room, so joiners normally get it with the repo.
    await finishSetup(git, repoRoot, { hooks: !values["skip-hooks"], agents: false });
    if (!(await mcpConfigHasTeamroom(repoRoot).catch(() => false))) {
      print("Tip: `teamroom agents install` lets Claude Code and Codex check overlap before they edit.");
    }
    return EXIT_OK;
  },

  agents: async (args) => {
    if (args[0] !== "install") throw new UsageError("Use `teamroom agents install`.");
    const repoRoot = await new Git(process.cwd()).repoRoot();
    await setUpAgents(repoRoot);
    return EXIT_OK;
  },

  doctor: async () => {
    const checks = await runDoctor(process.cwd());
    print(formatDoctor(checks));
    return checks.some((check) => check.status === "fail") ? EXIT_FAILURE : EXIT_OK;
  },

  hooks: async (args) => {
    const { values, positionals } = parseArgs({
      args,
      options: { claude: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const [action] = positionals;
    if (action !== "install" && action !== "uninstall")
      throw new UsageError("Use `teamroom hooks install` or `uninstall`.");
    const git = new Git(process.cwd());
    const hooksDir = await git.hooksDir();
    const changes =
      action === "install" ? await installHooks(hooksDir, await currentCli()) : await uninstallHooks(hooksDir);
    for (const [hook, change] of Object.entries(changes)) print(`${hook}: ${change}`);
    if (values.claude) {
      const repoRoot = await git.repoRoot();
      const claude =
        action === "install"
          ? await installClaudeHook(repoRoot, await currentCli())
          : await uninstallClaudeHook(repoRoot);
      print(`Claude Code PostToolUse: ${claude.change} (${path.relative(repoRoot, claude.file)})`);
      if (action === "install" && claude.change === "installed")
        print("Restart Claude Code sessions in this repo to pick it up.");
    }
    return EXIT_OK;
  },

  // Called by Claude Code after each file edit. Silent and always succeeds: it must never get in Claude's way.
  "claude-hook": async () => {
    try {
      const edit = parseClaudeEdit(await readStdin(CLAUDE_HOOK_STDIN_TIMEOUT_MS));
      if (!edit) return EXIT_OK;
      const workspace = await openWorkspace(edit.cwd ?? process.cwd());
      await reportEdit(workspace, { file: edit.file, agent: "claude-code" });
    } catch {
      // Not in a room, server down, or a file outside the repo: nothing to report.
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
    const { room, me } = await workspace.client.getRoom(workspace.config.roomId, limit);
    print(`${room.name} (${room.id}), you are ${me}, session ${workspace.session}`);
    print(
      `Members: ${room.members.map((member) => (member.role === "owner" ? `${member.name} (owner)` : member.name)).join(", ")}`
    );
    if (room.activity.length === 0) {
      print("\nNo activity yet.");
      return EXIT_OK;
    }
    print("");
    for (const entry of [...room.activity].reverse()) {
      const files = entry.files.length > 0 ? ` [${entry.files.length} file(s)]` : "";
      print(`${formatAge(entry.createdAt).padEnd(9)} ${entry.member} ${entry.kind}: ${entry.text}${files}`);
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
    await runMcpServer(() => openWorkspace(process.cwd()));
    return EXIT_OK;
  },

  invite: async (args) => {
    if (args[0] !== "rotate") throw new UsageError("Use `teamroom invite rotate`.");
    const workspace = await openWorkspace(process.cwd());
    const inviteCode = await workspace.client.rotateInvite(workspace.config.roomId);
    const link = formatInviteLink({ server: workspace.config.server, roomId: workspace.config.roomId, inviteCode });
    print("The old invite link no longer works. New one:");
    print(`  ${link}`);
    return EXIT_OK;
  },

  member: async (args) => {
    const [action, name] = args;
    if (action !== "remove" || !name) throw new UsageError("Use `teamroom member remove <name>`.");
    const workspace = await openWorkspace(process.cwd());
    await workspace.client.removeMember(workspace.config.roomId, name);
    print(`${name} was removed and their token revoked.`);
    return EXIT_OK;
  },

  token: async (args) => {
    if (args[0] !== "rotate") throw new UsageError("Use `teamroom token rotate`.");
    const git = new Git(process.cwd());
    const [workspace, commonDir] = await Promise.all([openWorkspace(process.cwd()), git.commonDir()]);
    const token = await workspace.client.rotateToken(workspace.config.roomId);
    const file = await saveConfig(commonDir, { ...workspace.config, token });
    print(`Token replaced and saved to ${file}. Update TEAMROOM_TOKEN anywhere you set it by hand.`);
    return EXIT_OK;
  },
};

async function finishSetup(git: Git, repoRoot: string, steps: { hooks: boolean; agents: boolean }): Promise<void> {
  if (steps.hooks) {
    await installHooks(await git.hooksDir(), await currentCli());
    print("Installed git hooks: commits, checkouts, merges and rebases are now shared automatically.");
  }
  if (steps.agents) await setUpAgents(repoRoot);
}

async function setUpAgents(repoRoot: string): Promise<void> {
  const { file, change } = await installMcpConfig(repoRoot);
  const relative = path.relative(process.cwd(), file) || file;
  if (change === "unchanged") {
    print(`${relative} already lists the teamroom MCP server.`);
  } else {
    const verb = change === "created" ? "Created" : "Updated";
    print(`${verb} ${relative} for Claude Code. Commit it so teammates get it too.`);
  }
  print("\nCodex: add this to ~/.codex/config.toml");
  print(indent(CODEX_SNIPPET));
  print("\nTell your agents to use it, in AGENTS.md or CLAUDE.md:");
  print(indent(AGENT_INSTRUCTION));
}

/** Falls back to git's user.name, so most people never type --name. */
async function memberName(explicit: string | undefined, git: Git): Promise<string> {
  const fromGit = (await git.userName())?.replace(/@/g, "").trim().slice(0, MAX_NAME_LENGTH);
  const candidate = explicit?.trim() || fromGit;
  if (!candidate) throw new UsageError("--name is required (git has no user.name set).");
  return candidate;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** npx runs from a throwaway cache, so pinning its path would break once the cache is cleared. */
const CLAUDE_HOOK_STDIN_TIMEOUT_MS = 2_000;

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
