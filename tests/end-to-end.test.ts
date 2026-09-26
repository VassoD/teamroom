import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "../src/client/api-client.js";
import { saveConfig } from "../src/client/config.js";
import { Git } from "../src/client/git.js";
import { checkOverlap, openWorkspace, reportWork, type Workspace } from "../src/client/workspace.js";
import { createApp } from "../src/server/app.js";
import { MemoryRoomStore } from "../src/store/memory-store.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd }
  );
  return stdout.trim();
}

/** Keeps TEAMROOM_* variables from the developer's shell out of the test. */
const CLEAN_ENV: NodeJS.ProcessEnv = {};

describe("two worktrees of one member", () => {
  let tempDir: string;
  let server: ServerType;
  let worktreeA: Workspace;
  let worktreeB: Workspace;

  beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-e2e-")));
    const mainRepo = path.join(tempDir, "repo");
    await fs.mkdir(path.join(mainRepo, "src"), { recursive: true });
    await git(mainRepo, "init", "--quiet", "-b", "main");
    await fs.writeFile(path.join(mainRepo, "src", "auth.ts"), "export const auth = 1;\n");
    await fs.writeFile(path.join(mainRepo, "src", "user.ts"), "export const user = 1;\n");
    await git(mainRepo, "add", ".");
    await git(mainRepo, "commit", "--quiet", "-m", "initial");
    await git(mainRepo, "worktree", "add", "--quiet", "-b", "feature-a", path.join(tempDir, "a"));
    await git(mainRepo, "worktree", "add", "--quiet", "-b", "feature-b", path.join(tempDir, "b"));

    server = await new Promise<ServerType>((resolve) => {
      const started = serve(
        { fetch: createApp({ store: new MemoryRoomStore() }).fetch, port: 0, hostname: "127.0.0.1" },
        () => resolve(started)
      );
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await new ApiClient({ server: url }).createRoom("Core", "ada");
    await saveConfig(await new Git(mainRepo).commonDir(), {
      server: url,
      roomId: created.room.id,
      member: "ada",
      token: created.token,
    });

    worktreeA = await openWorkspace(path.join(tempDir, "a"), { env: CLEAN_ENV });
    worktreeB = await openWorkspace(path.join(tempDir, "b", "src"), { env: CLEAN_ENV });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should share one config across worktrees but give each its own session", () => {
    expect(worktreeA.mode).toBe("shared");
    expect(worktreeA.config?.roomId).toBe(worktreeB.config?.roomId);
    expect(worktreeA.session).not.toBe(worktreeB.session);
  });

  it("should report uncommitted and untracked files relative to the repo root", async () => {
    await fs.writeFile(path.join(worktreeA.repoRoot, "src", "auth.ts"), "export const auth = 2;\n");
    await fs.writeFile(path.join(worktreeA.repoRoot, "notes.md"), "draft\n");

    const { activity } = await reportWork(worktreeA, { source: "agent" });

    expect(activity.files).toEqual(["notes.md", "src/auth.ts"]);
    expect(activity.branch).toBe("feature-a");
    expect(activity.session).toBe(worktreeA.session);
  });

  it("should warn the other worktree, resolving paths from its cwd", async () => {
    const check = await checkOverlap(worktreeB, { files: ["auth.ts", "user.ts"] });

    expect(check.files).toEqual(["src/auth.ts", "src/user.ts"]);
    expect(check.overlaps).toEqual([
      { file: "src/auth.ts", touchedBy: [expect.objectContaining({ member: "ada", session: worktreeA.session })] },
    ]);
  });

  it("should include committed branch changes in the snapshot", async () => {
    await git(worktreeA.repoRoot, "add", ".");
    await git(worktreeA.repoRoot, "commit", "--quiet", "-m", "auth change");

    const { activity } = await reportWork(worktreeA, { source: "hook" });

    expect(activity.files).toEqual(["notes.md", "src/auth.ts"]);
  });

  it("should stop warning once the session's snapshot no longer lists the file", async () => {
    await git(worktreeA.repoRoot, "reset", "--quiet", "--hard", "main");
    await reportWork(worktreeA, { source: "hook" });

    const check = await checkOverlap(worktreeB, { files: ["auth.ts"] });

    expect(check.overlaps).toEqual([]);
  });

  it("should stop warning about an agent's edit once a newer snapshot leaves the file out", async () => {
    await worktreeA.backend.postActivity({
      kind: "edit",
      source: "agent",
      agent: "codex",
      session: worktreeA.session,
      text: "Codex edited src/user.ts",
      files: ["src/user.ts"],
    });
    expect((await checkOverlap(worktreeB, { files: ["user.ts"] })).overlaps).toHaveLength(1);

    await reportWork(worktreeA, { source: "hook" });

    expect((await checkOverlap(worktreeB, { files: ["user.ts"] })).overlaps).toEqual([]);
  });
});
