import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_NAMES, installHooks, uninstallHooks } from "../src/client/hooks.js";

describe("git hooks", () => {
  let hooksDir: string;

  beforeEach(async () => {
    hooksDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-hooks-"));
  });

  afterEach(async () => {
    await fs.rm(hooksDir, { recursive: true, force: true });
  });

  it("should create executable hooks that run teamroom in the background", async () => {
    const changes = await installHooks(hooksDir);

    for (const name of HOOK_NAMES) {
      expect(changes[name]).toBe("installed");
      const file = path.join(hooksDir, name);
      const content = await fs.readFile(file, "utf8");
      expect(content.startsWith("#!/bin/sh\n")).toBe(true);
      expect(content).toContain("teamroom report --source hook --quiet");
      expect((await fs.stat(file)).mode & 0o111).not.toBe(0);
    }
  });

  it("should keep an existing hook and append to it", async () => {
    const existing = "#!/bin/sh\nnpm run lint\n";
    await fs.writeFile(path.join(hooksDir, "post-commit"), existing);

    await installHooks(hooksDir);
    const content = await fs.readFile(path.join(hooksDir, "post-commit"), "utf8");

    expect(content.startsWith(existing.trimEnd())).toBe(true);
    expect(content).toContain("teamroom report");
  });

  it("should not install twice", async () => {
    await installHooks(hooksDir);
    const changes = await installHooks(hooksDir);
    const content = await fs.readFile(path.join(hooksDir, "post-commit"), "utf8");

    expect(changes["post-commit"]).toBe("unchanged");
    expect(content.match(/>>> teamroom >>>/g)).toHaveLength(1);
  });

  it("should pin the installing CLI and refresh the pin on reinstall", async () => {
    await installHooks(hooksDir, { node: "/opt/node/bin/node", script: "/old/teamroom.js" });
    const changes = await installHooks(hooksDir, { node: "/opt/node/bin/node", script: "/it's new/teamroom.js" });
    const content = await fs.readFile(path.join(hooksDir, "post-commit"), "utf8");

    expect(changes["post-commit"]).toBe("updated");
    expect(content).not.toContain("/old/teamroom.js");
    expect(content).toContain("TEAMROOM_SCRIPT='/it'\\''s new/teamroom.js'");
    expect(content).toContain("command -v teamroom");
    expect(content.match(/>>> teamroom >>>/g)).toHaveLength(1);
  });

  it("should delete hooks it created and restore hooks it appended to", async () => {
    await fs.writeFile(path.join(hooksDir, "post-commit"), "#!/bin/sh\nnpm run lint\n");
    await installHooks(hooksDir);

    const changes = await uninstallHooks(hooksDir);

    expect(changes["post-commit"]).toBe("removed");
    expect(await fs.readFile(path.join(hooksDir, "post-commit"), "utf8")).toBe("#!/bin/sh\nnpm run lint\n");
    await expect(fs.stat(path.join(hooksDir, "post-merge"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("should report absent hooks when nothing was installed", async () => {
    const changes = await uninstallHooks(hooksDir);

    expect(Object.values(changes).every((change) => change === "absent")).toBe(true);
  });
});
