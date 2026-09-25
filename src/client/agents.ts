import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors.js";

/** Project-scoped MCP config read by Claude Code. Meant to be committed so the whole team gets it. */
export const MCP_CONFIG_FILE = ".mcp.json";
export const MCP_SERVER_NAME = "teamroom";

const TEAMROOM_MCP_ENTRY = { command: "teamroom", args: ["mcp"] };

const mcpConfigSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export const CODEX_SNIPPET = `[mcp_servers.${MCP_SERVER_NAME}]
command = "teamroom"
args = ["mcp"]`;

export const AGENT_INSTRUCTION =
  "Before editing files, call `teamroom_check_overlap` with the files you plan to change. " +
  "If someone else is in them, tell me before continuing.";

export type McpConfigChange = "created" | "added" | "unchanged";

/** Adds the teamroom server to `.mcp.json`, keeping every other server and setting already there. */
export async function installMcpConfig(repoRoot: string): Promise<{ file: string; change: McpConfigChange }> {
  const file = path.join(repoRoot, MCP_CONFIG_FILE);
  const existing = await readMcpConfig(file);
  if (existing?.mcpServers?.[MCP_SERVER_NAME] !== undefined) return { file, change: "unchanged" };

  const next = {
    ...existing,
    mcpServers: { ...existing?.mcpServers, [MCP_SERVER_NAME]: TEAMROOM_MCP_ENTRY },
  };
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { file, change: existing ? "added" : "created" };
}

export async function mcpConfigHasTeamroom(repoRoot: string): Promise<boolean> {
  const config = await readMcpConfig(path.join(repoRoot, MCP_CONFIG_FILE));
  return config?.mcpServers?.[MCP_SERVER_NAME] !== undefined;
}

async function readMcpConfig(file: string): Promise<z.infer<typeof mcpConfigSchema> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`Could not read ${file}.`);
  }
  try {
    return mcpConfigSchema.parse(JSON.parse(raw));
  } catch {
    // Never overwrite a config we cannot parse: it may hold other servers' settings.
    throw new ConfigError(`${file} is not valid JSON. Fix it, then run \`teamroom agents install\` again.`);
  }
}
