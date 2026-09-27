import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_HOOKS,
  adapterForCommand,
  adoptAgentHooks,
  agentHookStatus,
  installAgentHooks,
  uninstallAgentHooks,
} from "../src/client/agent-hooks.js";

describe("agent hooks registry", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-agent-hooks-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("should give every agent its own hook command", () => {
    const commands = AGENT_HOOKS.map((adapter) => adapter.command);

    expect(new Set(commands).size).toBe(commands.length);
    for (const command of commands) expect(adapterForCommand(command)?.command).toBe(command);
    expect(adapterForCommand("check")).toBeUndefined();
  });

  it("should only install hooks for agents the repo uses", async () => {
    const results = await installAgentHooks(repoRoot);

    expect(results.map((result) => result.agent)).toEqual(["claude"]);
  });

  it("should install hooks for an agent whose folder the repo has", async () => {
    await fs.mkdir(path.join(repoRoot, ".gemini"));

    const results = await installAgentHooks(repoRoot);

    expect(results.map((result) => [result.agent, result.change])).toEqual([
      ["claude", "installed"],
      ["gemini", "installed"],
    ]);
  });

  it("should install hooks for an agent it was told to set up", async () => {
    const results = await installAgentHooks(repoRoot, { forced: ["gemini"] });

    expect(results.map((result) => result.agent)).toEqual(["claude", "gemini"]);
  });

  it("should uninstall every agent's hooks and report only the ones it found", async () => {
    await installAgentHooks(repoRoot);

    const results = await uninstallAgentHooks(repoRoot);

    expect(results.map((result) => [result.agent, result.change])).toEqual([["claude", "removed"]]);
  });

  it("should say which agents only hear about overlap through MCP", async () => {
    await fs.mkdir(path.join(repoRoot, ".cursor"));
    await fs.mkdir(path.join(repoRoot, ".gemini"));
    await installAgentHooks(repoRoot);

    const status = await agentHookStatus(repoRoot);

    expect(status.withHooks).toEqual([
      { label: "Claude Code", missingEvents: [] },
      { label: "Gemini CLI", missingEvents: [] },
    ]);
    expect(status.mcpOnly).toEqual(["Cursor"]);
  });

  it("should install missing hooks in a checkout that lacks them, and do nothing when complete", async () => {
    expect(await adoptAgentHooks(repoRoot)).toBe(true);
    expect(await adoptAgentHooks(repoRoot)).toBe(false);
  });
});
