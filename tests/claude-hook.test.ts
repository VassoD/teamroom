import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaudeHookPayload } from "../src/client/claude-events.js";
import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_SETTINGS_FILE,
  claudeHookCommand,
  claudeHooksInstalled,
  claudeHooksWanted,
  installClaudeHooks,
  rememberClaudeHooksWanted,
  uninstallClaudeHooks,
} from "../src/client/claude-hook.js";

describe("parseClaudeHookPayload", () => {
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
    expect(parseClaudeHookPayload(payload({}))).toEqual({
      event: "PostToolUse",
      sessionId: "abc",
      cwd: "/repo",
      tool: "Edit",
      file: "/repo/src/theme.ts",
    });
  });

  it("should read the file an edit is about to change", () => {
    expect(parseClaudeHookPayload(payload({ hook_event_name: "PreToolUse" }))).toMatchObject({
      event: "PreToolUse",
      file: "/repo/src/theme.ts",
    });
  });

  it("should read session starts", () => {
    expect(parseClaudeHookPayload(payload({ hook_event_name: "SessionStart", tool_name: undefined }))).toEqual({
      event: "SessionStart",
      sessionId: "abc",
      cwd: "/repo",
    });
  });

  it("should treat payloads without an event name as PostToolUse, like older installs sent", () => {
    expect(parseClaudeHookPayload(payload({ hook_event_name: undefined }))?.event).toBe("PostToolUse");
  });

  it("should read notebook edits", () => {
    const edit = parseClaudeHookPayload(
      payload({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/a.ipynb" } })
    );
    expect(edit).toMatchObject({ file: "/repo/a.ipynb" });
  });

  it("should ignore tools that do not edit files, and events it does not handle", () => {
    expect(parseClaudeHookPayload(payload({ tool_name: "Bash", tool_input: { command: "ls" } }))).toBeNull();
    expect(parseClaudeHookPayload(payload({ hook_event_name: "Stop" }))).toBeNull();
  });

  it("should ignore malformed input", () => {
    expect(parseClaudeHookPayload("not json")).toBeNull();
    expect(parseClaudeHookPayload(JSON.stringify({ tool_input: {} }))).toBeNull();
  });
});

describe("Claude Code hook install", () => {
  let repo: string;
  const settingsPath = (): string => path.join(repo, CLAUDE_SETTINGS_FILE);
  const readSettings = async (): Promise<
    Record<string, unknown> & { hooks: { PostToolUse: unknown[]; PreToolUse: unknown[]; SessionStart: unknown[] } }
  > => JSON.parse(await readFile(settingsPath(), "utf8"));

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "teamroom-claude-hook-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("should create settings.local.json with the session, pre-edit and post-edit hooks", async () => {
    expect((await installClaudeHooks(repo)).change).toBe("installed");
    const settings = await readSettings();
    const hooks = [{ type: "command", command: claudeHookCommand(), timeout: 10 }];
    const onEdits = [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks }];
    expect(settings.hooks).toEqual({ SessionStart: [{ hooks }], PreToolUse: onEdits, PostToolUse: onEdits });
    expect(await claudeHooksInstalled(repo)).toEqual(["SessionStart", "PreToolUse", "PostToolUse"]);
  });

  it("should add the new hooks to an install that only had PostToolUse", async () => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    const onlyPost = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [{ type: "command", command: claudeHookCommand(), timeout: 10 }],
          },
        ],
      },
    };
    await writeFile(settingsPath(), JSON.stringify(onlyPost));

    expect((await installClaudeHooks(repo)).change).toBe("installed");
    expect(await claudeHooksInstalled(repo)).toEqual(["SessionStart", "PreToolUse", "PostToolUse"]);
    expect((await readSettings()).hooks.PostToolUse).toHaveLength(1);
  });

  it("should be idempotent", async () => {
    await installClaudeHooks(repo);
    expect((await installClaudeHooks(repo)).change).toBe("unchanged");
    expect((await readSettings()).hooks.PostToolUse).toHaveLength(1);
  });

  it("should keep existing settings and other hooks", async () => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    const existing = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    await writeFile(settingsPath(), JSON.stringify(existing));

    await installClaudeHooks(repo);
    const settings = await readSettings();
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)", ...CLAUDE_ALLOWED_TOOLS] });
    expect(settings.hooks.PostToolUse).toHaveLength(2);

    await uninstallClaudeHooks(repo);
    expect(await readSettings()).toEqual(existing);
  });

  it("should pre-approve teamroom's own tools, once", async () => {
    await installClaudeHooks(repo);
    await installClaudeHooks(repo);

    expect((await readSettings()).permissions).toEqual({ allow: CLAUDE_ALLOWED_TOOLS });
  });

  it("should remember across worktrees whether the repo wants Claude Code hooks", async () => {
    const storeDir = path.join(repo, ".git", "teamroom");
    expect(await claudeHooksWanted(storeDir)).toBe(false);

    await rememberClaudeHooksWanted(storeDir, true);
    expect(await claudeHooksWanted(storeDir)).toBe(true);

    await rememberClaudeHooksWanted(storeDir, false);
    expect(await claudeHooksWanted(storeDir)).toBe(false);
  });

  it("should refuse to overwrite a settings file it cannot parse", async () => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), "{ not json");
    await expect(installClaudeHooks(repo)).rejects.toThrow("not a JSON object");
    expect(await readFile(settingsPath(), "utf8")).toBe("{ not json");
  });

  it("should remove the hooks key entirely when teamroom was the only hook", async () => {
    await installClaudeHooks(repo);
    expect((await uninstallClaudeHooks(repo)).change).toBe("removed");
    expect(await readSettings()).toEqual({});
  });
});

describe("claudeHookCommand", () => {
  it("should fall back to teamroom on PATH and always succeed", () => {
    expect(claudeHookCommand()).toBe("command -v teamroom >/dev/null 2>&1 && teamroom claude-hook || true");
  });

  it("should prefer the CLI that installed it, quoting paths with spaces and quotes", () => {
    const command = claudeHookCommand({
      node: "/usr/bin/node",
      script: "/Users/o'neil/my apps/teamroom/dist/cli/index.js",
    });
    expect(command).toContain("'/Users/o'\\''neil/my apps/teamroom/dist/cli/index.js' claude-hook");
    expect(command.endsWith("|| true")).toBe(true);
  });
});
