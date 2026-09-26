import { describe, expect, it } from "vitest";
import type { ActivityInput } from "../src/core/room.js";
import { appendActivity, createRoom } from "../src/core/room.js";

function heartbeat(instance: string): ActivityInput {
  return { kind: "presence", source: "agent", agent: "claude-code", instance, text: "running", files: [] };
}

describe("appendActivity", () => {
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
});
