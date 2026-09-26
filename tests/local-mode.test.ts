import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_ROOM_ID, localStoreDir } from "../src/client/backend.js";
import { handleClaudeHook } from "../src/client/claude-events.js";
import { checkOverlap, openWorkspace, reportWork, type Workspace } from "../src/client/workspace.js";
import { AutoReporter } from "../src/mcp/auto-report.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd }
  );
  return stdout.trim();
}

/** A fixed member name, and no TEAMROOM_* variables from the developer's shell. */
const ENV: NodeJS.ProcessEnv = { TEAMROOM_MEMBER: "ada" };

interface PreToolUseOutput {
  hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
}

interface SessionStartOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

describe("local mode: parallel agents in two worktrees, no server", () => {
  let tempDir: string;
  let worktreeA: Workspace;
  let worktreeB: Workspace;

  beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-local-")));
    const mainRepo = path.join(tempDir, "repo");
    await fs.mkdir(path.join(mainRepo, "src"), { recursive: true });
    await git(mainRepo, "init", "--quiet", "-b", "main");
    await fs.writeFile(path.join(mainRepo, "src", "auth.ts"), "export const auth = 1;\n");
    await fs.writeFile(path.join(mainRepo, "src", "user.ts"), "export const user = 1;\n");
    await fs.writeFile(path.join(mainRepo, "package-lock.json"), "{}\n");
    await git(mainRepo, "add", ".");
    await git(mainRepo, "commit", "--quiet", "-m", "initial");
    await git(mainRepo, "worktree", "add", "--quiet", "-b", "feature-a", path.join(tempDir, "a"));
    await git(mainRepo, "worktree", "add", "--quiet", "-b", "feature-b", path.join(tempDir, "b"));

    worktreeA = await openWorkspace(path.join(tempDir, "a"), { env: ENV });
    worktreeB = await openWorkspace(path.join(tempDir, "b"), { env: ENV });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should run in local mode with one store shared by both worktrees", () => {
    expect(worktreeA.mode).toBe("local");
    expect(worktreeA.commonDir).toBe(worktreeB.commonDir);
    expect(worktreeA.session).not.toBe(worktreeB.session);
  });

  it("should warn one worktree about uncommitted work in the other", async () => {
    await fs.writeFile(path.join(worktreeA.repoRoot, "src", "auth.ts"), "export const auth = 2;\n");
    await reportWork(worktreeA, { source: "agent", agent: "codex" });

    const check = await checkOverlap(worktreeB, { files: ["src/auth.ts"] });

    expect(check.overlaps).toEqual([
      {
        file: "src/auth.ts",
        touchedBy: [expect.objectContaining({ member: "ada", session: worktreeA.session, agent: "codex" })],
      },
    ]);
    const stored = path.join(localStoreDir(worktreeA.commonDir), `${LOCAL_ROOM_ID}.json`);
    await expect(fs.access(stored)).resolves.toBeUndefined();
  });

  it("should never report overlap on lockfiles", async () => {
    await fs.writeFile(path.join(worktreeA.repoRoot, "package-lock.json"), '{"changed":true}\n');
    await reportWork(worktreeA, { source: "hook" });

    const check = await checkOverlap(worktreeB, { files: ["package-lock.json"] });

    expect(check).toEqual({ files: [], overlaps: [] });
  });

  it("should pause a Claude edit once per overlap, then let the retry through", async () => {
    const file = path.join(worktreeB.repoRoot, "src", "auth.ts");
    const pre = { event: "PreToolUse", sessionId: "claude-1", tool: "Edit", file } as const;

    const first = JSON.parse(await handleClaudeHook(pre, worktreeB)) as PreToolUseOutput;
    const retry = await handleClaudeHook(pre, worktreeB);
    const otherSession = await handleClaudeHook({ ...pre, sessionId: "claude-2" }, worktreeB);

    expect(first.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain("src/auth.ts");
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain(worktreeA.session);
    expect(retry).toBe("");
    expect(otherSession).not.toBe("");
  });

  it("should let edits to files nobody else is changing through silently", async () => {
    const file = path.join(worktreeB.repoRoot, "src", "user.ts");

    expect(await handleClaudeHook({ event: "PreToolUse", sessionId: "claude-1", tool: "Edit", file }, worktreeB)).toBe(
      ""
    );
  });

  it("should brief a new Claude session on what the other worktree is changing", async () => {
    const output = JSON.parse(await handleClaudeHook({ event: "SessionStart", sessionId: "claude-3" }, worktreeB)) as
      | SessionStartOutput
      | undefined;
    const context = output?.hookSpecificOutput.additionalContext ?? "";

    expect(output?.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(context).toContain(worktreeA.session);
    expect(context).toContain("src/auth.ts");
    expect(context).not.toContain("package-lock.json");
    expect(context).toContain("teamroom_post_note");
  });

  it("should share each Claude edit as it happens", async () => {
    const file = path.join(worktreeB.repoRoot, "src", "user.ts");
    await handleClaudeHook({ event: "PostToolUse", sessionId: "claude-1", tool: "Edit", file }, worktreeB);

    const check = await checkOverlap(worktreeA, { files: ["src/user.ts"] });

    expect(check.overlaps[0]?.touchedBy).toEqual([
      expect.objectContaining({ kind: "edit", agent: "claude-code", session: worktreeB.session }),
    ]);
  });

  it("should let the MCP server of any agent report changes and raise one heads-up per new overlap", async () => {
    const reporter = new AutoReporter(async () => worktreeB, { agent: "mistral-vibe" });
    await fs.writeFile(path.join(worktreeB.repoRoot, "src", "auth.ts"), "export const auth = 3;\n");

    await reporter.tick();
    const headsUp = reporter.takeHeadsUp();
    await reporter.tick();

    expect(headsUp).toContain("Heads up");
    expect(headsUp).toContain("src/auth.ts");
    expect(reporter.takeHeadsUp()).toBeUndefined();
    const seenFromA = await checkOverlap(worktreeA, { files: ["src/auth.ts"] });
    expect(seenFromA.overlaps[0]?.touchedBy).toEqual([
      expect.objectContaining({ session: worktreeB.session, agent: "mistral-vibe", kind: "wip" }),
    ]);
  });

  it("should not lose writes when many hooks fire at once from both worktrees", async () => {
    const before = (await worktreeA.backend.getRoom(1000)).room.activity.length;
    const writes = Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? worktreeA : worktreeB).backend.postActivity({
        kind: "note",
        source: "agent",
        text: `note ${index}`,
      })
    );

    await Promise.all(writes);

    expect((await worktreeA.backend.getRoom(1000)).room.activity.length).toBe(before + 20);
  });
});
