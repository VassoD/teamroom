import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors.js";

export const MCP_SERVER_NAME = "teamroom";
/** Claude Code's project MCP config. Meant to be committed so the whole team gets it. */
export const MCP_CONFIG_FILE = ".mcp.json";

const TEAMROOM_MCP_ENTRY = { command: "teamroom", args: ["mcp"] };

/**
 * Agents with a project-level MCP config teamroom can write safely. Claude
 * Code's is always written; the others only when the repo already has that
 * agent's folder, so init never litters a repo with configs for tools nobody uses.
 */
export type AgentId = "claude" | "cursor" | "gemini" | "codex";

interface JsonTarget {
  agent: AgentId;
  label: string;
  file: string;
  format: "json";
  /** The folder whose presence means the repo uses this agent. Undefined means always. */
  marker?: string;
}

interface TomlTarget {
  agent: AgentId;
  label: string;
  file: string;
  format: "toml";
  marker: string;
}

type McpTarget = JsonTarget | TomlTarget;

export const MCP_TARGETS: McpTarget[] = [
  { agent: "claude", label: "Claude Code", file: MCP_CONFIG_FILE, format: "json" },
  { agent: "cursor", label: "Cursor", file: path.join(".cursor", "mcp.json"), format: "json", marker: ".cursor" },
  {
    agent: "gemini",
    label: "Gemini CLI",
    file: path.join(".gemini", "settings.json"),
    format: "json",
    marker: ".gemini",
  },
  // Codex only loads a project config in trusted projects.
  { agent: "codex", label: "Codex", file: path.join(".codex", "config.toml"), format: "toml", marker: ".codex" },
];

export const CODEX_SNIPPET = `[mcp_servers.${MCP_SERVER_NAME}]
command = "teamroom"
args = ["mcp"]`;

/**
 * Mistral Vibe's project config replaces parts of the user's, so teamroom
 * never writes one. Add this to ~/.vibe/config.toml instead.
 */
export const VIBE_SNIPPET = `[[mcp_servers]]
name = "${MCP_SERVER_NAME}"
transport = "stdio"
command = "teamroom"
args = ["mcp"]`;

export const GENERIC_MCP_DESCRIPTION = 'Any other MCP client: a stdio server, command "teamroom", args ["mcp"].';

export type McpConfigChange = "created" | "added" | "unchanged";

export interface McpTargetResult {
  agent: AgentId;
  label: string;
  file: string;
  change: McpConfigChange;
}

/** Writes the teamroom server into every agent config that applies to this repo, keeping everything else there. */
export async function installMcpConfigs(repoRoot: string, forced: AgentId[] = []): Promise<McpTargetResult[]> {
  const results: McpTargetResult[] = [];
  for (const target of MCP_TARGETS) {
    const applies =
      !target.marker || forced.includes(target.agent) || (await exists(path.join(repoRoot, target.marker)));
    if (!applies) continue;
    const file = path.join(repoRoot, target.file);
    const change = target.format === "json" ? await installJson(file) : await installToml(file);
    results.push({ agent: target.agent, label: target.label, file, change });
  }
  return results;
}

/** Claude Code's config alone, for callers that only care whether agents in general are set up. */
export async function mcpConfigHasTeamroom(repoRoot: string): Promise<boolean> {
  const config = await readJsonConfig(path.join(repoRoot, MCP_CONFIG_FILE));
  return config?.mcpServers?.[MCP_SERVER_NAME] !== undefined;
}

const jsonConfigSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

async function installJson(file: string): Promise<McpConfigChange> {
  const existing = await readJsonConfig(file);
  if (existing?.mcpServers?.[MCP_SERVER_NAME] !== undefined) return "unchanged";
  const next = { ...existing, mcpServers: { ...existing?.mcpServers, [MCP_SERVER_NAME]: TEAMROOM_MCP_ENTRY } };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return existing ? "added" : "created";
}

/** TOML tables can come in any order, so appending one never disturbs what is already there. */
async function installToml(file: string): Promise<McpConfigChange> {
  const existing = await readIfExists(file);
  if (existing !== undefined && new RegExp(`^\\s*\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`, "m").test(existing)) {
    return "unchanged";
  }
  const base = existing?.trimEnd();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, base ? `${base}\n\n${CODEX_SNIPPET}\n` : `${CODEX_SNIPPET}\n`, "utf8");
  return existing === undefined ? "created" : "added";
}

async function readJsonConfig(file: string): Promise<z.infer<typeof jsonConfigSchema> | undefined> {
  const raw = await readIfExists(file);
  if (raw === undefined) return undefined;
  try {
    return jsonConfigSchema.parse(JSON.parse(raw));
  } catch {
    // Never overwrite a config we cannot parse: it may hold other servers' settings.
    throw new ConfigError(`${file} is not valid JSON. Fix it, then run \`teamroom init\` again.`);
  }
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`Could not read ${file}.`);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
