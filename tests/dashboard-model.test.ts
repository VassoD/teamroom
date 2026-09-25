import { describe, expect, it } from "vitest";
import type { Activity, RoomView } from "../src/core/types.js";
import { buildDashboard, flattenSessions } from "../src/dashboard/model.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function entry(overrides: Partial<Activity>): Activity {
  return {
    id: crypto.randomUUID(),
    member: "alice",
    session: "web-aaaaaa",
    kind: "wip",
    source: "hook",
    text: "Changing files.",
    files: [],
    createdAt: minutesAgo(1),
    ...overrides,
  };
}

function room(activity: Activity[], members = ["alice", "bob", "carol"]): RoomView {
  return {
    id: "room_AAAAAAAAAAAAAAAA",
    name: "Dark mode",
    members: members.map((name, index) => ({
      name,
      role: index === 0 ? "owner" : "member",
      joinedAt: minutesAgo(1000),
    })),
    activity,
    createdAt: minutesAgo(1000),
    updatedAt: minutesAgo(1),
  };
}

describe("buildDashboard", () => {
  it("should group activity into one session per member and checkout", () => {
    const dashboard = buildDashboard(
      room([
        entry({ member: "alice", session: "web-aaaaaa" }),
        entry({ member: "alice", session: "api-bbbbbb" }),
        entry({ member: "alice", session: "web-aaaaaa", createdAt: minutesAgo(0) }),
      ]),
      "bob",
      NOW
    );
    const alice = dashboard.members.find((member) => member.name === "alice");
    expect(alice?.sessions.map((session) => session.session)).toEqual(["web-aaaaaa", "api-bbbbbb"]);
  });

  it("should count only active sessions where an agent posted", () => {
    const dashboard = buildDashboard(
      room([
        entry({ member: "bob", session: "one", source: "agent", kind: "note", createdAt: minutesAgo(2) }),
        entry({ member: "bob", session: "two", source: "agent", kind: "note", createdAt: minutesAgo(60) }),
        entry({ member: "bob", session: "three", source: "hook", createdAt: minutesAgo(1) }),
      ]),
      "alice",
      NOW
    );
    expect(dashboard.totals).toEqual({
      members: 3,
      activeSessions: 2,
      activeAgents: 1,
      activeAgentsByLabel: { agent: 1 },
    });
    expect(dashboard.members.find((member) => member.name === "bob")?.activeAgents).toBe(1);
  });

  it("should describe a session by its latest note when it is newer than the snapshot", () => {
    const dashboard = buildDashboard(
      room([
        entry({ kind: "wip", text: "Changing 2 files.", createdAt: minutesAgo(5) }),
        entry({ kind: "note", source: "agent", text: "Refactoring the theme provider.", createdAt: minutesAgo(3) }),
      ]),
      "alice",
      NOW
    );
    expect(flattenSessions(dashboard)[0]?.doing).toBe("Refactoring the theme provider.");
  });

  it("should use only the latest snapshot's files", () => {
    const dashboard = buildDashboard(
      room([
        entry({ files: ["old.ts"], createdAt: minutesAgo(10) }),
        entry({ files: ["new.ts"], createdAt: minutesAgo(1) }),
      ]),
      "alice",
      NOW
    );
    expect(flattenSessions(dashboard)[0]?.files).toEqual(["new.ts"]);
  });

  it("should flag files two sessions are changing at once, including one person's two checkouts", () => {
    const dashboard = buildDashboard(
      room([
        entry({ member: "alice", session: "web-aaaaaa", files: ["src/theme.ts", "a.ts"] }),
        entry({ member: "alice", session: "web-bbbbbb", files: ["src/theme.ts"] }),
        entry({ member: "bob", session: "web-cccccc", files: ["src/theme.ts", "b.ts"] }),
      ]),
      "alice",
      NOW
    );
    expect(dashboard.hotFiles).toEqual([
      {
        file: "src/theme.ts",
        sessions: ["alice/web-aaaaaa", "alice/web-bbbbbb", "bob/web-cccccc"],
        members: ["alice", "bob"],
      },
    ]);
  });

  it("should mark sessions idle after 15 minutes and hide them after 3 days", () => {
    const dashboard = buildDashboard(
      room([
        entry({ session: "idle", createdAt: minutesAgo(30) }),
        entry({ session: "gone", createdAt: minutesAgo(60 * 24 * 4) }),
      ]),
      "alice",
      NOW
    );
    expect(flattenSessions(dashboard).map((session) => [session.session, session.state])).toEqual([["idle", "idle"]]);
  });

  it("should list me first, then the most recently active, then silent members", () => {
    const dashboard = buildDashboard(
      room([
        entry({ member: "carol", createdAt: minutesAgo(1) }),
        entry({ member: "alice", createdAt: minutesAgo(9) }),
      ]),
      "bob",
      NOW
    );
    expect(dashboard.members.map((member) => member.name)).toEqual(["bob", "carol", "alice"]);
  });

  it("should name each agent and count Claude Code and Codex separately", () => {
    const dashboard = buildDashboard(
      room([
        entry({
          member: "bob",
          session: "web",
          source: "agent",
          agent: "claude-code",
          kind: "note",
          createdAt: minutesAgo(2),
        }),
        entry({
          member: "bob",
          session: "web",
          source: "agent",
          agent: "codex",
          kind: "note",
          createdAt: minutesAgo(1),
        }),
        entry({
          member: "carol",
          session: "api",
          source: "agent",
          agent: "claude-code",
          kind: "note",
          createdAt: minutesAgo(3),
        }),
      ]),
      "alice",
      NOW
    );
    expect(dashboard.totals.activeAgents).toBe(3);
    expect(dashboard.totals.activeAgentsByLabel).toEqual({ "Claude Code": 2, Codex: 1 });
    const bobWeb = flattenSessions(dashboard).find((session) => session.key === "bob/web");
    expect(bobWeb?.agents).toEqual(["codex", "claude-code"]);
    expect(dashboard.members.find((member) => member.name === "bob")?.activeAgents).toBe(2);
  });

  it("should attribute edited files to the agent that edited them", () => {
    const dashboard = buildDashboard(
      room([
        entry({ kind: "wip", files: ["README.md"], createdAt: minutesAgo(10) }),
        entry({
          kind: "edit",
          source: "agent",
          agent: "claude-code",
          text: "Claude Code edited src/a.ts",
          files: ["src/a.ts"],
          createdAt: minutesAgo(4),
        }),
        entry({
          kind: "edit",
          source: "agent",
          agent: "claude-code",
          text: "Claude Code edited src/b.ts",
          files: ["src/b.ts"],
          createdAt: minutesAgo(2),
        }),
      ]),
      "alice",
      NOW
    );
    const session = flattenSessions(dashboard)[0];
    expect(session?.edits.map((edit) => [edit.file, edit.agent])).toEqual([
      ["src/b.ts", "claude-code"],
      ["src/a.ts", "claude-code"],
    ]);
    expect(session?.files).toEqual(["README.md", "src/b.ts", "src/a.ts"]);
    expect(session?.doing).toBe("Claude Code edited src/b.ts");
  });

  it("should drop agent edits from pending files once a newer snapshot replaces them", () => {
    const dashboard = buildDashboard(
      room([
        entry({ kind: "edit", source: "agent", agent: "codex", files: ["src/a.ts"], createdAt: minutesAgo(5) }),
        entry({ kind: "wip", files: [], text: "No pending changes on main.", createdAt: minutesAgo(1) }),
      ]),
      "alice",
      NOW
    );
    expect(flattenSessions(dashboard)[0]?.files).toEqual([]);
  });

  it("should flag a file an agent edited while a teammate has it pending", () => {
    const dashboard = buildDashboard(
      room([
        entry({ member: "alice", session: "web", files: ["src/theme.ts"] }),
        entry({
          member: "bob",
          session: "app",
          kind: "edit",
          source: "agent",
          agent: "claude-code",
          files: ["src/theme.ts"],
        }),
      ]),
      "alice",
      NOW
    );
    expect(dashboard.hotFiles.map((hotFile) => hotFile.members)).toEqual([["alice", "bob"]]);
  });
});
