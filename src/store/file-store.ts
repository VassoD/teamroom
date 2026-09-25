import { promises as fs } from "node:fs";
import path from "node:path";
import { roomIdSchema } from "../core/schemas.js";
import type { Room } from "../core/types.js";
import { RoomAlreadyExistsError, RoomNotFoundError, StoreLockTimeoutError, type RoomStore } from "./store.js";

const LOCK_RETRY_DELAY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
/** A lock older than this is assumed to belong to a crashed process. */
const STALE_LOCK_MS = 30_000;

/**
 * Stores each room as a JSON file. Writes are atomic (temp file + rename) and
 * serialized per room with a lock directory, so several server processes can
 * share one data directory without losing writes. Rate limits are not shared
 * between those processes.
 */
export class FileRoomStore implements RoomStore {
  private readonly inProcessQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  async create(room: Room): Promise<void> {
    await this.withRoomLock(room.id, async () => {
      if (await this.readRoom(room.id)) throw new RoomAlreadyExistsError(room.id);
      await this.writeRoom(room);
    });
  }

  async get(roomId: string): Promise<Room | null> {
    return this.readRoom(roomId);
  }

  async update(roomId: string, mutate: (room: Room) => Room): Promise<Room> {
    return this.withRoomLock(roomId, async () => {
      const current = await this.readRoom(roomId);
      if (!current) throw new RoomNotFoundError(roomId);
      const next = mutate(current);
      await this.writeRoom(next);
      return next;
    });
  }

  private roomPath(roomId: string): string {
    // Room ids are validated before they reach the store, but a path built from
    // unvalidated input must never escape the data directory.
    if (!roomIdSchema.safeParse(roomId).success) throw new RoomNotFoundError(roomId);
    return path.join(this.dataDir, `${roomId}.json`);
  }

  private async readRoom(roomId: string): Promise<Room | null> {
    try {
      const raw = await fs.readFile(this.roomPath(roomId), "utf8");
      return JSON.parse(raw) as Room;
    } catch (error) {
      if (isNodeError(error, "ENOENT") || error instanceof RoomNotFoundError) return null;
      throw error;
    }
  }

  private async writeRoom(room: Room): Promise<void> {
    const target = this.roomPath(room.id);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(temp, JSON.stringify(room, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, target);
  }

  private async withRoomLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.inProcessQueues.get(roomId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.withFileLock(roomId, task));
    this.inProcessQueues.set(roomId, run);
    try {
      return await run;
    } finally {
      if (this.inProcessQueues.get(roomId) === run) this.inProcessQueues.delete(roomId);
    }
  }

  private async withFileLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const lockPath = `${this.roomPath(roomId)}.lock`;
    await fs.mkdir(this.dataDir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      try {
        await fs.mkdir(lockPath);
        break;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        await removeLockIfStale(lockPath);
        if (Date.now() > deadline) throw new StoreLockTimeoutError(roomId);
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }

    try {
      return await task();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function removeLockIfStale(lockPath: string): Promise<void> {
  try {
    const stats = await fs.stat(lockPath);
    if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
