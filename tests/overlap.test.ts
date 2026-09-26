import { describe, expect, it } from "vitest";
import { findOverlaps, normalizePath } from "../src/core/overlap.js";
import type { Activity } from "../src/core/types.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
let nextId = 0;

function entry(overrides: Partial<Activity> & Pick<Activity, "member" | "createdAt">): Activity {
  nextId += 1;
  return { id: `activity-${nextId}`, kind: "wip", source: "hook", text: "work", files: [], ...overrides };
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe("findOverlaps", () => {
  it("should report other members who touched a requested file", () => {
    const activity = [entry({ member: "bo", files: ["src/auth.ts"], createdAt: hoursAgo(1) })];

    const overlaps = findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", now: NOW });

    expect(overlaps).toEqual([{ file: "src/auth.ts", touchedBy: [expect.objectContaining({ member: "bo" })] }]);
  });

  it("should warn between two sessions of the same member", () => {
    const activity = [entry({ member: "ada", session: "worktree-a", files: ["src/auth.ts"], createdAt: hoursAgo(1) })];

    const overlaps = findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", session: "worktree-b", now: NOW });

    expect(overlaps[0]?.touchedBy).toEqual([expect.objectContaining({ member: "ada", session: "worktree-a" })]);
  });

  it("should ignore the caller's own session", () => {
    const activity = [entry({ member: "ada", session: "worktree-a", files: ["src/auth.ts"], createdAt: hoursAgo(1) })];

    expect(findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", session: "worktree-a", now: NOW })).toEqual(
      []
    );
  });

  it("should ignore every session of the member when no session is given", () => {
    const activity = [entry({ member: "ada", session: "worktree-a", files: ["src/auth.ts"], createdAt: hoursAgo(1) })];

    expect(findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", now: NOW })).toEqual([]);
  });

  it("should forget files that a newer wip snapshot of the same session no longer lists", () => {
    const activity = [
      entry({ member: "bo", session: "s1", files: ["src/auth.ts"], createdAt: hoursAgo(5) }),
      entry({ member: "bo", session: "s1", files: [], createdAt: hoursAgo(1) }),
    ];

    expect(findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", now: NOW })).toEqual([]);
  });

  it("should keep snapshots of different sessions independent", () => {
    const activity = [
      entry({ member: "bo", session: "s1", files: ["src/auth.ts"], createdAt: hoursAgo(5) }),
      entry({ member: "bo", session: "s2", files: [], createdAt: hoursAgo(1) }),
    ];

    const overlaps = findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", now: NOW });

    expect(overlaps[0]?.touchedBy).toEqual([expect.objectContaining({ session: "s1" })]);
  });

  it("should not let a wip snapshot hide notes about the same file", () => {
    const activity = [
      entry({
        member: "bo",
        session: "s1",
        kind: "note",
        text: "renaming User",
        files: ["src/user.ts"],
        createdAt: hoursAgo(3),
      }),
      entry({ member: "bo", session: "s1", files: [], createdAt: hoursAgo(1) }),
    ];

    const overlaps = findOverlaps({ activity, files: ["src/user.ts"], member: "ada", now: NOW });

    expect(overlaps[0]?.touchedBy).toEqual([expect.objectContaining({ kind: "note", text: "renaming User" })]);
  });

  it("should skip activity older than the window", () => {
    const activity = [entry({ member: "bo", files: ["src/auth.ts"], createdAt: hoursAgo(80) })];

    expect(findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", now: NOW })).toEqual([]);
    expect(findOverlaps({ activity, files: ["src/auth.ts"], member: "ada", sinceHours: 100, now: NOW })).toHaveLength(
      1
    );
  });

  it("should keep only the latest touch per session and sort newest first", () => {
    const activity = [
      entry({ member: "bo", kind: "commit", files: ["a.ts"], createdAt: hoursAgo(4) }),
      entry({ member: "bo", kind: "commit", files: ["a.ts"], createdAt: hoursAgo(2) }),
      entry({ member: "cy", kind: "note", files: ["a.ts"], createdAt: hoursAgo(1) }),
    ];

    const touches = findOverlaps({ activity, files: ["a.ts"], member: "ada", now: NOW })[0]?.touchedBy ?? [];

    expect(touches.map((touch) => [touch.member, touch.at])).toEqual([
      ["cy", hoursAgo(1)],
      ["bo", hoursAgo(2)],
    ]);
  });

  it("should drop an agent's edit once a newer snapshot from its session replaces it", () => {
    const activity = [
      entry({ member: "bo", session: "s1", kind: "edit", source: "agent", files: ["a.ts"], createdAt: hoursAgo(3) }),
      entry({ member: "bo", session: "s1", kind: "wip", files: [], createdAt: hoursAgo(2) }),
    ];

    expect(findOverlaps({ activity, files: ["a.ts"], member: "ada", now: NOW })).toEqual([]);
  });

  it("should keep an agent's edit that is newer than its session's snapshot", () => {
    const activity = [
      entry({ member: "bo", session: "s1", kind: "wip", files: [], createdAt: hoursAgo(2) }),
      entry({ member: "bo", session: "s1", kind: "edit", source: "agent", files: ["a.ts"], createdAt: hoursAgo(1) }),
    ];

    expect(findOverlaps({ activity, files: ["a.ts"], member: "ada", now: NOW })[0]?.touchedBy).toEqual([
      expect.objectContaining({ kind: "edit", session: "s1" }),
    ]);
  });

  it("should carry a session's plan for the file when a later snapshot is its latest touch", () => {
    const activity = [
      entry({
        member: "bo",
        session: "s1",
        kind: "note",
        files: ["a.ts"],
        text: "Dark palette",
        createdAt: hoursAgo(2),
      }),
      entry({
        member: "bo",
        session: "s1",
        kind: "wip",
        files: ["a.ts"],
        text: "Changing 1 file",
        createdAt: hoursAgo(1),
      }),
    ];

    const [touch] = findOverlaps({ activity, files: ["a.ts"], member: "ada", now: NOW })[0]?.touchedBy ?? [];

    expect(touch).toMatchObject({ kind: "wip", text: "Changing 1 file", plan: "Dark palette" });
  });

  it("should match paths regardless of ./ prefixes and backslashes", () => {
    const activity = [entry({ member: "bo", files: ["src\\auth.ts"], createdAt: hoursAgo(1) })];

    expect(findOverlaps({ activity, files: ["./src/auth.ts"], member: "ada", now: NOW })).toHaveLength(1);
  });
});

describe("normalizePath", () => {
  it("should trim, use forward slashes and drop a leading ./", () => {
    expect(normalizePath("  .\\src\\a.ts ")).toBe("src/a.ts");
  });
});
