import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendActivity, createRoom } from "../src/core/room.js";
import { FileRoomStore } from "../src/store/file-store.js";
import { RoomAlreadyExistsError, RoomNotFoundError } from "../src/store/store.js";

const PARALLEL_WRITES = 25;

describe("FileRoomStore", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-store-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("should persist rooms across store instances", async () => {
    const { room } = createRoom("Core", "ada");
    await new FileRoomStore(dataDir).create(room);

    expect(await new FileRoomStore(dataDir).get(room.id)).toEqual(room);
  });

  it("should refuse to create the same room twice", async () => {
    const store = new FileRoomStore(dataDir);
    const { room } = createRoom("Core", "ada");
    await store.create(room);

    await expect(store.create(room)).rejects.toBeInstanceOf(RoomAlreadyExistsError);
  });

  it("should not lose writes made in parallel from two store instances", async () => {
    const { room } = createRoom("Core", "ada");
    const stores = [new FileRoomStore(dataDir), new FileRoomStore(dataDir)];
    await stores[0]?.create(room);

    await Promise.all(
      Array.from({ length: PARALLEL_WRITES }, (_, index) =>
        stores[index % stores.length]?.update(room.id, (current) =>
          appendActivity(current, "ada", { kind: "note", source: "human", text: `note ${index}`, files: [] }).room
        )
      )
    );

    expect((await stores[0]?.get(room.id))?.activity).toHaveLength(PARALLEL_WRITES);
  });

  it("should return null for unknown or malformed ids and throw when updating them", async () => {
    const store = new FileRoomStore(dataDir);

    expect(await store.get("room_AAAAAAAAAAAAAAAA")).toBeNull();
    expect(await store.get("../../etc/passwd")).toBeNull();
    await expect(store.update("room_AAAAAAAAAAAAAAAA", (current) => current)).rejects.toBeInstanceOf(RoomNotFoundError);
  });

  it("should store rooms readable by the owner only", async () => {
    const { room } = createRoom("Core", "ada");
    await new FileRoomStore(dataDir).create(room);

    const stats = await fs.stat(path.join(dataDir, `${room.id}.json`));

    expect(stats.mode & 0o077).toBe(0);
  });
});
