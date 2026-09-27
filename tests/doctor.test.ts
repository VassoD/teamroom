import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installAgentsMd } from "../src/client/agents-md.js";
import { ApiClient } from "../src/client/api-client.js";
import { installClaudeHooks } from "../src/client/claude-hook.js";
import { saveConfig } from "../src/client/config.js";
import { type DoctorCheck, formatDoctor, runDoctor } from "../src/client/doctor.js";
import { Git } from "../src/client/git.js";
import { installHooks } from "../src/client/hooks.js";
import { installMcpConfigs } from "../src/client/mcp-config.js";
import { createApp } from "../src/server/app.js";
import { MemoryRoomStore } from "../src/store/memory-store.js";

const execFileAsync = promisify(execFile);
const CLEAN_ENV: NodeJS.ProcessEnv = {};
const onPath = async (): Promise<boolean> => true;

function statusOf(checks: DoctorCheck[], name: string): string | undefined {
  return checks.find((check) => check.name === name)?.status;
}

describe("teamroom doctor", () => {
  let tempDir: string;
  let repo: string;
  let server: ServerType;
  let serverUrl: string;

  beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-doctor-")));
    repo = path.join(tempDir, "repo");
    await fs.mkdir(repo);
    await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    server = await new Promise<ServerType>((resolve) => {
      const started = serve(
        { fetch: createApp({ store: new MemoryRoomStore() }).fetch, port: 0, hostname: "127.0.0.1" },
        () => resolve(started)
      );
    });
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should stop after the git check outside a repo", async () => {
    const checks = await runDoctor(tempDir, { env: CLEAN_ENV, commandOnPath: onPath });

    expect(checks).toEqual([expect.objectContaining({ name: "Git repository", status: "fail" })]);
  });

  it("should treat a fresh repo as local mode and point every warning at init", async () => {
    const checks = await runDoctor(repo, { env: CLEAN_ENV, commandOnPath: async () => false });

    expect(statusOf(checks, "Mode")).toBe("ok");
    expect(statusOf(checks, "Local store")).toBe("ok");
    expect(statusOf(checks, "teamroom on PATH")).toBe("warn");
    expect(statusOf(checks, "Git hooks")).toBe("warn");
    expect(statusOf(checks, "Agent hooks")).toBe("warn");
    expect(statusOf(checks, "Agent setup")).toBe("warn");
    expect(statusOf(checks, "Agent instructions")).toBe("warn");
    expect(formatDoctor(checks)).toContain("fix: teamroom init");
    expect(checks.some((check) => check.name === "Server")).toBe(false);
  });

  it("should pass everything once set up", async () => {
    const created = await new ApiClient({ server: serverUrl }).createRoom("Core", "ada");
    const git = new Git(repo);
    await saveConfig(await git.commonDir(), {
      server: serverUrl,
      roomId: created.room.id,
      member: "ada",
      token: created.token,
    });
    await installHooks(await git.hooksDir());
    await installClaudeHooks(repo);
    await installMcpConfigs(repo);
    await installAgentsMd(repo);
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      ],
      { cwd: repo }
    );

    const checks = await runDoctor(repo, { env: CLEAN_ENV, commandOnPath: onPath });

    expect(checks.filter((check) => check.status !== "ok")).toEqual([]);
    expect(statusOf(checks, "Token")).toBe("ok");
  });

  it("should flag a revoked token", async () => {
    const checks = await runDoctor(repo, {
      env: { TEAMROOM_TOKEN: "trm_revoked" },
      commandOnPath: onPath,
    });

    expect(statusOf(checks, "Server")).toBe("ok");
    expect(statusOf(checks, "Token")).toBe("fail");
  });

  it("should flag an unreachable server without checking the token", async () => {
    const checks = await runDoctor(repo, {
      env: { TEAMROOM_SERVER: "http://127.0.0.1:9" },
      commandOnPath: onPath,
    });

    expect(statusOf(checks, "Server")).toBe("fail");
    expect(checks.some((check) => check.name === "Token")).toBe(false);
  });
});

describe("teamroom doctor with a custom git hooks folder", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-doctor-hookspath-")));
    await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
  });

  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  async function hooksFolderCheck(hooksPath: string | undefined): Promise<DoctorCheck | undefined> {
    if (hooksPath) await execFileAsync("git", ["config", "core.hooksPath", hooksPath], { cwd: repo });
    else await execFileAsync("git", ["config", "--unset-all", "core.hooksPath"], { cwd: repo }).catch(() => undefined);
    const checks = await runDoctor(repo, { env: CLEAN_ENV, commandOnPath: onPath });
    return checks.find((check) => check.name === "Git hooks folder");
  }

  it("should warn that husky 9 rewrites its hooks folder and say where teamroom belongs instead", async () => {
    const check = await hooksFolderCheck(".husky/_");

    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("rewrites that folder");
    const checks = await runDoctor(repo, { env: CLEAN_ENV, commandOnPath: onPath });
    expect(checks.find((candidate) => candidate.name === "Git hooks")?.fix).toBe("see Git hooks folder below");
    expect(check?.fix).toContain(".husky/post-commit");
    expect(check?.fix).toContain("teamroom report --source hook --quiet");
  });

  it("should count hooks husky runs teamroom from, once the fix is applied", async () => {
    await fs.mkdir(path.join(repo, ".husky"), { recursive: true });
    const fix = (await hooksFolderCheck(".husky/_"))?.fix ?? "";
    const line = fix.slice(fix.indexOf("`") + 1, fix.indexOf("`", fix.indexOf("`") + 1));
    for (const hook of ["post-commit", "post-checkout", "post-merge", "post-rewrite"]) {
      await fs.writeFile(path.join(repo, ".husky", hook), `npx lint-staged\n${line}\n`);
    }

    const checks = await runDoctor(repo, { env: CLEAN_ENV, commandOnPath: onPath });

    expect(statusOf(checks, "Git hooks")).toBe("ok");
    expect(statusOf(checks, "Git hooks folder")).toBe("ok");
    await fs.rm(path.join(repo, ".husky"), { recursive: true, force: true });
  });

  it("should warn that older husky commits the hook files teamroom would write its paths into", async () => {
    const check = await hooksFolderCheck(".husky");

    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("committed");
  });

  it("should only mention other hooks folders", async () => {
    const check = await hooksFolderCheck("tools/git-hooks");

    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("tools/git-hooks");
  });

  it("should say nothing when git uses its default hooks folder", async () => {
    expect(await hooksFolderCheck(undefined)).toBeUndefined();
  });
});
