import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/client/errors.js";
import {
  CODEX_SNIPPET,
  installMcpConfigs,
  MCP_CONFIG_FILE,
  type McpTargetResult,
  mcpConfigHasTeamroom,
} from "../src/client/mcp-config.js";

async function installClaudeOnly(repoRoot: string): Promise<McpTargetResult> {
  const [claude] = await installMcpConfigs(repoRoot);
  if (!claude) throw new Error("Claude Code config was not written.");
  return claude;
}

describe(".mcp.json setup", () => {
  let repoRoot: string;
  let file: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-mcp-config-"));
    file = path.join(repoRoot, MCP_CONFIG_FILE);
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("should create the file with the teamroom server", async () => {
    const result = await installClaudeOnly(repoRoot);

    expect(result.change).toBe("created");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      mcpServers: { teamroom: { command: "teamroom", args: ["mcp"] } },
    });
    expect(await mcpConfigHasTeamroom(repoRoot)).toBe(true);
  });

  it("should keep other servers and settings", async () => {
    await fs.writeFile(file, JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } }, other: true }));

    const result = await installClaudeOnly(repoRoot);
    const config = JSON.parse(await fs.readFile(file, "utf8"));

    expect(result.change).toBe("added");
    expect(config.other).toBe(true);
    expect(Object.keys(config.mcpServers)).toEqual(["github", "teamroom"]);
  });

  it("should leave a customized teamroom entry alone", async () => {
    const custom = { mcpServers: { teamroom: { command: "npx", args: ["teamroom", "mcp"] } } };
    await fs.writeFile(file, JSON.stringify(custom));

    const result = await installClaudeOnly(repoRoot);

    expect(result.change).toBe("unchanged");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(custom);
  });

  it("should refuse to overwrite a file it cannot parse", async () => {
    await fs.writeFile(file, "{ broken");

    await expect(installClaudeOnly(repoRoot)).rejects.toBeInstanceOf(ConfigError);
    expect(await fs.readFile(file, "utf8")).toBe("{ broken");
  });
});

describe("MCP setup for other agents", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-agents-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("should only configure Claude Code when the repo has no other agent folders", async () => {
    const results = await installMcpConfigs(repoRoot);

    expect(results.map((result) => result.agent)).toEqual(["claude"]);
  });

  it("should configure Cursor and Gemini CLI when their folders exist, keeping their other settings", async () => {
    await fs.mkdir(path.join(repoRoot, ".cursor"));
    await fs.mkdir(path.join(repoRoot, ".gemini"));
    await fs.writeFile(path.join(repoRoot, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));

    const results = await installMcpConfigs(repoRoot);
    const gemini = JSON.parse(await fs.readFile(path.join(repoRoot, ".gemini", "settings.json"), "utf8"));
    const cursor = JSON.parse(await fs.readFile(path.join(repoRoot, ".cursor", "mcp.json"), "utf8"));

    expect(results.map((result) => result.agent)).toEqual(["claude", "cursor", "gemini"]);
    expect(gemini).toEqual({ theme: "dark", mcpServers: { teamroom: { command: "teamroom", args: ["mcp"] } } });
    expect(cursor.mcpServers.teamroom).toEqual({ command: "teamroom", args: ["mcp"] });
  });

  it("should append a Codex table to an existing config.toml once", async () => {
    await fs.mkdir(path.join(repoRoot, ".codex"));
    const file = path.join(repoRoot, ".codex", "config.toml");
    await fs.writeFile(file, 'model = "gpt-5"\n');

    await installMcpConfigs(repoRoot);
    const second = await installMcpConfigs(repoRoot);

    expect(await fs.readFile(file, "utf8")).toBe(`model = "gpt-5"\n\n${CODEX_SNIPPET}\n`);
    expect(second.find((result) => result.agent === "codex")?.change).toBe("unchanged");
  });

  it("should configure an agent on request even without its folder", async () => {
    const results = await installMcpConfigs(repoRoot, ["codex"]);

    expect(results.map((result) => result.agent)).toEqual(["claude", "codex"]);
  });
});
