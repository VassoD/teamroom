import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS_MD_FILE, agentsMdHasTeamroom, installAgentsMd } from "../src/client/agents-md.js";

describe("AGENTS.md setup", () => {
  let repoRoot: string;
  let file: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-agents-md-"));
    file = path.join(repoRoot, AGENTS_MD_FILE);
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("should create AGENTS.md with the teamroom block", async () => {
    expect((await installAgentsMd(repoRoot)).change).toBe("created");
    expect(await fs.readFile(file, "utf8")).toContain("teamroom_check_overlap");
    expect(await agentsMdHasTeamroom(repoRoot)).toBe(true);
  });

  it("should append to an existing file and leave its content alone", async () => {
    await fs.writeFile(file, "# Project rules\n\nUse tabs.\n");

    expect((await installAgentsMd(repoRoot)).change).toBe("added");
    const content = await fs.readFile(file, "utf8");
    expect(content.startsWith("# Project rules\n\nUse tabs.\n\n<!-- teamroom:start -->")).toBe(true);
  });

  it("should refresh an outdated block in place and be idempotent", async () => {
    await fs.writeFile(file, "before\n\n<!-- teamroom:start -->\nold text\n<!-- teamroom:end -->\n\nafter\n");

    expect((await installAgentsMd(repoRoot)).change).toBe("updated");
    expect((await installAgentsMd(repoRoot)).change).toBe("unchanged");
    const content = await fs.readFile(file, "utf8");
    expect(content).not.toContain("old text");
    expect(content.startsWith("before\n\n")).toBe(true);
    expect(content.endsWith("\n\nafter\n")).toBe(true);
  });
});
