import { describe, expect, it } from "vitest";
import { findOverlaps } from "../src/core/overlap.js";
import type { ActivityInput } from "../src/core/room.js";
import { appendActivity, createRoom, MAX_ACTIVITY_KEPT } from "../src/core/room.js";

function heartbeat(instance: string): ActivityInput {
  return { kind: "presence", source: "agent", agent: "claude-code", instance, text: "running", files: [] };
}

function snapshot(session: string, files: string[]): ActivityInput {
  return { kind: "wip", source: "hook", session, text: "snapshot", files };
}

describe("appendActivity", () => {
  it("should keep only the latest snapshot per session", () => {
    let { room } = createRoom("Dark mode", "ada");
    for (const files of [["a.ts"], ["a.ts", "b.ts"], ["b.ts"]]) {
      room = appendActivity(room, "ada", snapshot("wt-a", files)).room;
    }
    room = appendActivity(room, "ada", snapshot("wt-b", ["c.ts"])).room;

    expect(room.activity.map((entry) => [entry.session, entry.files])).toEqual([
      ["wt-a", ["b.ts"]],
      ["wt-b", ["c.ts"]],
    ]);
  });

  it("should keep the newest snapshot with files when the session goes quiet, so its plans can end", () => {
    let { room } = createRoom("Dark mode", "ada");
    for (const files of [["a.ts"], ["b.ts"], [], []]) {
      room = appendActivity(room, "ada", snapshot("wt-a", files)).room;
    }

    expect(room.activity.map((entry) => entry.files)).toEqual([["b.ts"], []]);
  });

  it("should keep only the latest heartbeat per agent instance", () => {
    let { room } = createRoom("Dark mode", "ada");
    for (const instance of ["tab-one", "tab-two", "tab-one", "tab-one"]) {
      room = appendActivity(room, "ada", heartbeat(instance)).room;
    }
    expect(room.activity.map((entry) => entry.instance)).toEqual(["tab-two", "tab-one"]);
  });

  it("should drop the instance on activity that does not come from an agent", () => {
    const { room } = createRoom("Dark mode", "ada");
    const { entry } = appendActivity(room, "ada", { ...heartbeat("tab-one"), kind: "note", source: "human" });
    expect(entry.instance).toBeUndefined();
  });

  it("should keep a quiet session's latest snapshot when busy sessions fill the log", () => {
    let { room } = createRoom("Dark mode", "ada");
    const start = Date.parse("2026-09-27T10:00:00.000Z");
    let seconds = 0;
    const tick = (): Date => {
      seconds += 1;
      return new Date(start + seconds * 1000);
    };
    room = appendActivity(
      room,
      "bo",
      { kind: "wip", source: "hook", session: "bo-wt", text: "Changing 1 file.", files: ["src/auth.ts"] },
      tick()
    ).room;

    for (let index = 0; index < MAX_ACTIVITY_KEPT + 50; index += 1) {
      const edit: ActivityInput = {
        kind: "edit",
        source: "agent",
        session: "cy-wt",
        text: "edit",
        files: ["src/ui.ts"],
      };
      room = appendActivity(room, "cy", edit, tick()).room;
    }

    expect(room.activity).toHaveLength(MAX_ACTIVITY_KEPT);
    const overlaps = findOverlaps({
      activity: room.activity,
      files: ["src/auth.ts"],
      member: "ada",
      now: tick(),
    });
    expect(overlaps.map((overlap) => overlap.file)).toEqual(["src/auth.ts"]);
  });

  it("should drop the oldest entries first when trimming", () => {
    let { room } = createRoom("Dark mode", "ada");
    for (let index = 0; index < MAX_ACTIVITY_KEPT + 1; index += 1) {
      room = appendActivity(room, "ada", { kind: "note", source: "human", text: `note ${index}`, files: [] }).room;
    }

    expect(room.activity).toHaveLength(MAX_ACTIVITY_KEPT);
    expect(room.activity[0]?.text).toBe("note 1");
  });
});
