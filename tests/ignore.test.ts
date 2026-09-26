import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileIgnore, IGNORE_FILE, loadIgnore } from "../src/client/ignore.js";

describe("compileIgnore", () => {
  it("should match a bare name at any depth", () => {
    const isIgnored = compileIgnore(["package-lock.json"]);

    expect(isIgnored("package-lock.json")).toBe(true);
    expect(isIgnored("apps/web/package-lock.json")).toBe(true);
    expect(isIgnored("package.json")).toBe(false);
  });

  it("should anchor patterns that contain a slash to the repo root", () => {
    const isIgnored = compileIgnore(["src/generated/*.ts"]);

    expect(isIgnored("src/generated/api.ts")).toBe(true);
    expect(isIgnored("lib/src/generated/api.ts")).toBe(false);
    expect(isIgnored("src/generated/deep/api.ts")).toBe(false);
  });

  it("should support ** and directory patterns", () => {
    const isIgnored = compileIgnore(["**/__snapshots__/**", "dist/"]);

    expect(isIgnored("src/a/__snapshots__/view.snap")).toBe(true);
    expect(isIgnored("dist/index.js")).toBe(true);
    expect(isIgnored("src/dist.ts")).toBe(false);
  });

  it("should let a later negation re-include a file", () => {
    const isIgnored = compileIgnore(["*.lock", "!Cargo.lock"]);

    expect(isIgnored("yarn.lock")).toBe(true);
    expect(isIgnored("Cargo.lock")).toBe(false);
  });

  it("should skip comments and blank lines", () => {
    const isIgnored = compileIgnore(["# lockfiles", "", "  "]);

    expect(isIgnored("anything.ts")).toBe(false);
  });
});

describe("loadIgnore", () => {
  it("should ignore lockfiles by default and read .teamroomignore on top", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-ignore-"));
    try {
      await fs.writeFile(path.join(repoRoot, IGNORE_FILE), "src/routes.gen.ts\n!pnpm-lock.yaml\n");

      const isIgnored = await loadIgnore(repoRoot);

      expect(isIgnored("package-lock.json")).toBe(true);
      expect(isIgnored("src/routes.gen.ts")).toBe(true);
      expect(isIgnored("pnpm-lock.yaml")).toBe(false);
      expect(isIgnored("src/app.ts")).toBe(false);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
