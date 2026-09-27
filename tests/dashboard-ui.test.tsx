import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { Activity, RoomView } from "../src/core/types.js";
import { DashboardApp } from "../src/dashboard/Dashboard.js";
import type { FetchRoom } from "../src/dashboard/useRoomPolling.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const ARROW_DOWN = "\u001B[B";

function entry(overrides: Partial<Activity>): Activity {
  return {
    id: crypto.randomUUID(),
    member: "alice",
    session: "web-aaaaaa",
    kind: "wip",
    source: "hook",
    text: "Changing 2 files on feat/theme.",
    branch: "feat/theme",
    files: ["src/theme.ts", "src/tokens.css"],
    createdAt: minutesAgo(2),
    ...overrides,
  };
}

const ROOM: RoomView = {
  id: "room_AAAAAAAAAAAAAAAA",
  name: "Dark mode",
  members: [
    { name: "alice", role: "owner", joinedAt: minutesAgo(500) },
    { name: "bob", role: "member", joinedAt: minutesAgo(400) },
  ],
  activity: [
    entry({}),
    entry({
      member: "bob",
      session: "app-bbbbbb",
      source: "agent",
      kind: "note",
      branch: "main",
      text: "Restyling the header only.",
      files: [],
      createdAt: minutesAgo(1),
    }),
    entry({ member: "bob", session: "app-bbbbbb", branch: "main", files: ["src/theme.ts"], createdAt: minutesAgo(3) }),
  ],
  createdAt: minutesAgo(500),
  updatedAt: minutesAgo(1),
};

const waitForRender = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("DashboardApp", () => {
  it("should show members, their agents, and the file both are changing", async () => {
    const fetchRoom: FetchRoom = async () => ({ room: ROOM, me: "alice" });
    const app = render(<DashboardApp fetchRoom={fetchRoom} fixedNow={NOW} pollIntervalMs={60_000} />);
    cleanup = app.unmount;
    await waitForRender();

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Dark mode");
    expect(frame).toContain("2 people");
    expect(frame).toContain("1 agent open");
    expect(frame).toContain("1 file being changed in more than one place");
    expect(frame).toContain("src/theme.ts  alice, bob");
    expect(frame).toContain("Restyling the header only.");
  });

  it("should move the selection with the arrow keys and show that session's files", async () => {
    const fetchRoom: FetchRoom = async () => ({ room: ROOM, me: "alice" });
    const app = render(<DashboardApp fetchRoom={fetchRoom} fixedNow={NOW} pollIntervalMs={60_000} />);
    cleanup = app.unmount;
    await waitForRender();
    expect(app.lastFrame()).toContain("alice in web-aaaaaa on feat/theme");

    app.stdin.write(ARROW_DOWN);
    await waitForRender();
    expect(app.lastFrame()).toContain("bob in app-bbbbbb on main");
  });

  it("should explain the problem when the room can't be read", async () => {
    const fetchRoom: FetchRoom = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const app = render(<DashboardApp fetchRoom={fetchRoom} fixedNow={NOW} pollIntervalMs={60_000} />);
    cleanup = app.unmount;
    await waitForRender();
    expect(app.lastFrame()).toContain("Can't read the room: connect ECONNREFUSED");
  });
});
