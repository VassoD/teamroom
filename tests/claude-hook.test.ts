import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeHookCommand,
  CLAUDE_SETTINGS_FILE,
  installClaudeHook,
  parseClaudeEdit,
  uninstallClaudeHook,
} from "../src/client/claude-hook.js";

describe("parseClaudeEdit", () => {
  const payload = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      session_id: "abc",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/src/theme.ts", old_string: "a", new_string: "b" },
      ...overrides,
    });

  it("should read the edited file from an Edit payload", () => {
    expect(parseClaudeEdit(payload({}))).toEqual({ cwd: "/repo", tool: "Edit", file: "/repo/src/theme.ts" });
  });

  it("should read notebook edits", () => {
    const edit = parseClaudeEdit(payload({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/a.ipynb" } }));
    expect(edit?.file).toBe("/repo/a.ipynb");
  });

  it("should ignore tools that do not edit files", () => {
    expect(parseClaudeEdit(payload({ tool_name: "Bash", tool_input: { command: "ls" } }))).toBeNull();
  });

  it("should ignore malformed input", () => {
    expect(parseClaudeEdit("not json")).toBeNull();
    expect(parseClaudeEdit(JSON.stringify({ tool_input: {} }))).toBeNull();
  });
});

describe("Claude Code hook install", () => {
  let repo: string;
  const settingsPath = (): string => path.join(repo, CLAUDE_SETTINGS_FILE);
  const readSettings = async (): Promise<Record<string, unknown> & { hooks: { PostToolUse: unknown[] } }> => JSON.parse(await readFile(settingsPath(), "utf8"));

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "teamroom-claude-hook-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("should create settings.local.json with the hook", async () => {
    expect((await installClaudeHook(repo)).change).toBe("installed");
    const settings = await readSettings();
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: claudeHookCommand(), timeout: 10 }] },
    ]);
  });

  it("should be idempotent", async () => {
    await installClaudeHook(repo);
    expect((await installClaudeHook(repo)).change).toBe("unchanged");
    expect((await readSettings()).hooks.PostToolUse).toHaveLength(1);
  });

  it("should keep existing settings and other hooks", async () => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    const existing = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    await writeFile(settingsPath(), JSON.stringify(existing));

    await installClaudeHook(repo);
    const settings = await readSettings();
    expect(settings.permissions).toEqual(existing.permissions);
    expect(settings.hooks.PostToolUse).toHaveLength(2);

    await uninstallClaudeHook(repo);
    expect(await readSettings()).toEqual(existing);
  });

  it("should refuse to overwrite a settings file it cannot parse", async () => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), "{ not json");
    await expect(installClaudeHook(repo)).rejects.toThrow("not a JSON object");
    expect(await readFile(settingsPath(), "utf8")).toBe("{ not json");
  });

  it("should remove the hooks key entirely when teamroom was the only hook", async () => {
    await installClaudeHook(repo);
    expect((await uninstallClaudeHook(repo)).change).toBe("removed");
    expect(await readSettings()).toEqual({});
  });
});

describe("claudeHookCommand", () => {
  it("should fall back to teamroom on PATH and always succeed", () => {
    expect(claudeHookCommand()).toBe("command -v teamroom >/dev/null 2>&1 && teamroom claude-hook || true");
  });

  it("should prefer the CLI that installed it, quoting paths with spaces and quotes", () => {
    const command = claudeHookCommand({ node: "/usr/bin/node", script: "/Users/o'neil/my apps/teamroom/dist/cli/index.js" });
    expect(command).toContain("'/Users/o'\\''neil/my apps/teamroom/dist/cli/index.js' claude-hook");
    expect(command.endsWith("|| true")).toBe(true);
  });
});
