#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ApiClient } from "../client/api-client.js";
import { saveConfig } from "../client/config.js";
import { UsageError, describeError } from "../client/errors.js";
import { Git } from "../client/git.js";
import { installHooks, uninstallHooks, type CliLocation } from "../client/hooks.js";
import {
  checkOverlap,
  formatAge,
  formatOverlaps,
  openWorkspace,
  postNote,
  reportWork,
} from "../client/workspace.js";
import { runMcpServer } from "../mcp/server.js";
import { DEFAULT_DATA_DIR, DEFAULT_HOST, DEFAULT_PORT, startServer } from "../server/serve.js";

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
  teamroom create --server <url> --room-name <name> --name <you>
  teamroom join --server <url> --room <room id> --invite <code> --name <you>
  teamroom hooks install | uninstall

Daily use
  teamroom check [files...]         Who else is touching these files (default: your pending changes)
  teamroom report [--note <text>]   Share the files this checkout is changing
  teamroom note <text> [--files a,b]
  teamroom status [--limit ${DEFAULT_STATUS_LIMIT}]
  teamroom mcp                      Run the MCP server for coding agents (stdio)

Room admin
  teamroom invite rotate            Owner only. The old invite code stops working
  teamroom member remove <name>     Owner only, or yourself
  teamroom token rotate             Replace your token, for example after a leak

Environment: TEAMROOM_SERVER, TEAMROOM_ROOM, TEAMROOM_MEMBER, TEAMROOM_TOKEN override the
repo config. TEAMROOM_SESSION names this checkout (default: derived from its path).`;

type Command = (args: string[]) => Promise<number>;

const commands: Record<string, Command> = {
  serve: async (args) => {
    const { values } = parseArgs({ args, options: {
      port: { type: "string", default: String(DEFAULT_PORT) },
      host: { type: "string", default: DEFAULT_HOST },
      "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
      "trust-proxy": { type: "boolean", default: false },
    } });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new UsageError("--port must be 1 to 65535.");
    startServer({ port, host: values.host, dataDir: values["data-dir"], trustProxy: values["trust-proxy"] });
    // Keep the process alive until the server shuts itself down on a signal.
    await new Promise<never>(() => undefined);
    return EXIT_OK;
  },

  create: async (args) => {
    const { values } = parseArgs({ args, options: {
      server: { type: "string" },
      "room-name": { type: "string" },
      name: { type: "string" },
    } });
    const server = requireOption(values.server, "--server");
    const roomName = requireOption(values["room-name"], "--room-name");
    const name = requireOption(values.name, "--name");
    const commonDir = await new Git(process.cwd()).commonDir();

    const created = await new ApiClient({ server }).createRoom(roomName, name);
    const file = await saveConfig(commonDir, { server, roomId: created.room.id, member: created.me, token: created.token });
    print(`Created room "${created.room.name}" and saved your membership to ${file}.`);
    print("\nShare this with teammates (it lets anyone who has it join):");
    print(`  teamroom join --server ${server} --room ${created.room.id} --invite ${created.inviteCode} --name <their name>`);
    print("\nNext: `teamroom hooks install` so your commits and checkouts are reported automatically.");
    return EXIT_OK;
  },

  join: async (args) => {
    const { values } = parseArgs({ args, options: {
      server: { type: "string" },
      room: { type: "string" },
      invite: { type: "string" },
      name: { type: "string" },
    } });
    const server = requireOption(values.server, "--server");
    const roomId = requireOption(values.room, "--room");
    const invite = requireOption(values.invite, "--invite");
    const name = requireOption(values.name, "--name");
    const commonDir = await new Git(process.cwd()).commonDir();

    const joined = await new ApiClient({ server }).joinRoom(roomId, name, invite);
    const file = await saveConfig(commonDir, { server, roomId: joined.room.id, member: joined.me, token: joined.token });
    print(`Joined "${joined.room.name}" as ${joined.me}. Membership saved to ${file}.`);
    print("Next: `teamroom hooks install` so your commits and checkouts are reported automatically.");
    return EXIT_OK;
  },

  hooks: async (args) => {
    const [action] = args;
    if (action !== "install" && action !== "uninstall") throw new UsageError("Use `teamroom hooks install` or `uninstall`.");
    const hooksDir = await new Git(process.cwd()).hooksDir();
    const changes = action === "install" ? await installHooks(hooksDir, await currentCli()) : await uninstallHooks(hooksDir);
    for (const [hook, change] of Object.entries(changes)) print(`${hook}: ${change}`);
    return EXIT_OK;
  },

  check: async (args) => {
    const { values, positionals } = parseArgs({ args, options: { "since-hours": { type: "string" } }, allowPositionals: true });
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
    const { values } = parseArgs({ args, options: {
      note: { type: "string" },
      source: { type: "string", default: "human" },
      quiet: { type: "boolean", default: false },
    } });
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
    print(`Members: ${room.members.map((member) => (member.role === "owner" ? `${member.name} (owner)` : member.name)).join(", ")}`);
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

  mcp: async () => {
    await runMcpServer(() => openWorkspace(process.cwd()));
    return EXIT_OK;
  },

  invite: async (args) => {
    if (args[0] !== "rotate") throw new UsageError("Use `teamroom invite rotate`.");
    const workspace = await openWorkspace(process.cwd());
    const inviteCode = await workspace.client.rotateInvite(workspace.config.roomId);
    print("The old invite code no longer works. New join command:");
    print(
      `  teamroom join --server ${workspace.config.server} --room ${workspace.config.roomId} --invite ${inviteCode} --name <their name>`
    );
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
