import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAgentHook } from "../src/client/agent-hooks.js";
import {
  GEMINI_HOOK_COMMAND,
  GEMINI_SETTINGS_FILE,
  geminiHooks,
  installGeminiHooks,
  parseGeminiHookPayload,
  uninstallGeminiHooks,
} from "../src/client/gemini-hook.js";
import { checkOverlap, openWorkspace, reportWork, type Workspace } from "../src/client/workspace.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd }
  );
  return stdout.trim();
}

const ENV: NodeJS.ProcessEnv = { TEAMROOM_MEMBER: "ada" };

describe("parseGeminiHookPayload", () => {
  const payload = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      session_id: "gem-1",
      cwd: "/repo",
      hook_event_name: "BeforeTool",
      tool_name: "write_file",
      tool_input: { file_path: "/repo/src/theme.ts", content: "x" },
      ...overrides,
    });

  it("should read the file a write is about to change", () => {
    expect(parseGeminiHookPayload(payload({}))).toEqual({
      event: "PreToolUse",
      sessionId: "gem-1",
      cwd: "/repo",
      file: "/repo/src/theme.ts",
      agent: "gemini-cli",
    });
  });

  it("should read a replace that already happened as a shared edit", () => {
    expect(parseGeminiHookPayload(payload({ hook_event_name: "AfterTool", tool_name: "replace" }))).toMatchObject({
      event: "PostToolUse",
      file: "/repo/src/theme.ts",
    });
  });

  it("should read a session start", () => {
    expect(parseGeminiHookPayload(payload({ hook_event_name: "SessionStart", source: "startup" }))).toEqual({
      event: "SessionStart",
      sessionId: "gem-1",
      cwd: "/repo",
      agent: "gemini-cli",
    });
  });

  it("should ignore tools that do not write files", () => {
    expect(parseGeminiHookPayload(payload({ tool_name: "run_shell_command", tool_input: { command: "ls" } }))).toBe(
      null
    );
  });

  it("should ignore events and input it does not understand", () => {
    expect(parseGeminiHookPayload(payload({ hook_event_name: "BeforeModel" }))).toBe(null);
    expect(parseGeminiHookPayload("not json")).toBe(null);
  });
});

describe("installGeminiHooks", () => {
  let repoRoot: string;
  const settingsFile = (): string => path.join(repoRoot, GEMINI_SETTINGS_FILE);
  const readSettings = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(settingsFile(), "utf8")) as Record<string, unknown>;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-gemini-"));
    await fs.mkdir(path.join(repoRoot, ".gemini"));
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({
        mcpServers: { teamroom: { command: "teamroom", args: ["mcp"] } },
        hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "./guard.sh" }] }] },
      })
    );
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("should add the three hooks and keep the MCP server and other hooks", async () => {
    expect((await installGeminiHooks(repoRoot)).change).toBe("installed");

    const settings = (await readSettings()) as {
      mcpServers: Record<string, unknown>;
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
    };
    expect(settings.mcpServers.teamroom).toBeDefined();
    expect(Object.keys(settings.hooks).sort()).toEqual(["AfterTool", "BeforeTool", "SessionStart"]);
    expect(settings.hooks.BeforeTool?.map((group) => group.matcher)).toEqual([
      "run_shell_command",
      "write_file|replace",
    ]);
    expect(settings.hooks.SessionStart?.[0]?.matcher).toBeUndefined();
    expect(settings.hooks.AfterTool?.[0]?.hooks[0]).toMatchObject({ command: GEMINI_HOOK_COMMAND, timeout: 10_000 });
  });

  it("should only name teamroom on PATH, since the file is committed", async () => {
    await installGeminiHooks(repoRoot);

    expect(await fs.readFile(settingsFile(), "utf8")).not.toContain(process.execPath);
  });

  it("should leave the file alone when run again", async () => {
    await installGeminiHooks(repoRoot);

    expect((await installGeminiHooks(repoRoot)).change).toBe("unchanged");
  });

  it("should remove only its own hooks", async () => {
    await installGeminiHooks(repoRoot);

    expect((await uninstallGeminiHooks(repoRoot)).change).toBe("removed");

    const settings = (await readSettings()) as { mcpServers: unknown; hooks: Record<string, unknown> };
    expect(settings.mcpServers).toBeDefined();
    expect(Object.keys(settings.hooks)).toEqual(["BeforeTool"]);
  });

  it("should refuse to overwrite a settings file it cannot parse", async () => {
    await fs.writeFile(settingsFile(), "{ not json");

    await expect(installGeminiHooks(repoRoot)).rejects.toThrow("not a JSON object");
    expect(await fs.readFile(settingsFile(), "utf8")).toBe("{ not json");
  });
});

describe("handleGeminiHook in two worktrees", () => {
  let tempDir: string;
  let worktreeA: Workspace;
  let worktreeB: Workspace;

  beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-gemini-local-")));
    const mainRepo = path.join(tempDir, "repo");
    await fs.mkdir(path.join(mainRepo, "src"), { recursive: true });
    await git(mainRepo, "init", "--quiet", "-b", "main");
    await fs.writeFile(path.join(mainRepo, "src", "auth.ts"), "export const auth = 1;\n");
    await git(mainRepo, "add", ".");
    await git(mainRepo, "commit", "--quiet", "-m", "initial");
    await git(mainRepo, "worktree", "add", "--quiet", "-b", "feature-a", path.join(tempDir, "a"));
    await git(mainRepo, "worktree", "add", "--quiet", "-b", "feature-b", path.join(tempDir, "b"));
    worktreeA = await openWorkspace(path.join(tempDir, "a"), { env: ENV });
    worktreeB = await openWorkspace(path.join(tempDir, "b"), { env: ENV });

    await fs.writeFile(path.join(worktreeA.repoRoot, "src", "auth.ts"), "export const auth = 2;\n");
    await reportWork(worktreeA, { source: "hook" });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should deny a write once with a reason for the model, then let the retry through", async () => {
    const pre = {
      event: "PreToolUse",
      sessionId: "gem-1",
      file: path.join(worktreeB.repoRoot, "src", "auth.ts"),
      agent: "gemini-cli",
    } as const;

    const first = JSON.parse(await handleAgentHook(geminiHooks, pre, worktreeB)) as {
      decision: string;
      reason: string;
    };
    const retry = await handleAgentHook(geminiHooks, pre, worktreeB);

    expect(first.decision).toBe("deny");
    expect(first.reason).toContain("src/auth.ts");
    expect(first.reason).toContain(worktreeA.session);
    expect(retry).toBe("");
  });

  it("should brief a new session on what the other worktree is changing", async () => {
    const output = JSON.parse(
      await handleAgentHook(geminiHooks, { event: "SessionStart", sessionId: "gem-2", agent: "gemini-cli" }, worktreeB)
    ) as { hookSpecificOutput: { additionalContext: string } };

    expect(output.hookSpecificOutput.additionalContext).toContain("src/auth.ts");
  });

  it("should share each Gemini write as a Gemini CLI edit", async () => {
    await handleAgentHook(
      geminiHooks,
      { event: "PostToolUse", file: path.join(worktreeB.repoRoot, "src", "billing.ts"), agent: "gemini-cli" },
      worktreeB
    );

    const { overlaps } = await checkOverlap(worktreeA, { files: ["src/billing.ts"] });
    expect(overlaps[0]?.touchedBy).toEqual([expect.objectContaining({ kind: "edit", agent: "gemini-cli" })]);
  });
});
