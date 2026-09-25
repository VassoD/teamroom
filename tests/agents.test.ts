import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMcpConfig, MCP_CONFIG_FILE, mcpConfigHasTeamroom } from "../src/client/agents.js";
import { ConfigError } from "../src/client/errors.js";

describe(".mcp.json setup", () => {
  let repoRoot: string;
  let file: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-agents-"));
    file = path.join(repoRoot, MCP_CONFIG_FILE);
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("should create the file with the teamroom server", async () => {
    const result = await installMcpConfig(repoRoot);

    expect(result.change).toBe("created");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      mcpServers: { teamroom: { command: "teamroom", args: ["mcp"] } },
    });
    expect(await mcpConfigHasTeamroom(repoRoot)).toBe(true);
  });

  it("should keep other servers and settings", async () => {
    await fs.writeFile(file, JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } }, other: true }));

    const result = await installMcpConfig(repoRoot);
    const config = JSON.parse(await fs.readFile(file, "utf8"));

    expect(result.change).toBe("added");
    expect(config.other).toBe(true);
    expect(Object.keys(config.mcpServers)).toEqual(["github", "teamroom"]);
  });

  it("should leave a customized teamroom entry alone", async () => {
    const custom = { mcpServers: { teamroom: { command: "npx", args: ["teamroom", "mcp"] } } };
    await fs.writeFile(file, JSON.stringify(custom));

    const result = await installMcpConfig(repoRoot);

    expect(result.change).toBe("unchanged");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(custom);
  });

  it("should refuse to overwrite a file it cannot parse", async () => {
    await fs.writeFile(file, "{ broken");

    await expect(installMcpConfig(repoRoot)).rejects.toBeInstanceOf(ConfigError);
    expect(await fs.readFile(file, "utf8")).toBe("{ broken");
  });
});
