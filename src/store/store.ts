import type { Room } from "../core/types.js";

export class RoomNotFoundError extends Error {
  constructor(public readonly roomId: string) {
    super(`Room ${roomId} does not exist.`);
    this.name = "RoomNotFoundError";
  }
}

export class RoomAlreadyExistsError extends Error {
  constructor(public readonly roomId: string) {
    super(`Room ${roomId} already exists.`);
    this.name = "RoomAlreadyExistsError";
  }
}

export class StoreLockTimeoutError extends Error {
  constructor(public readonly roomId: string) {
    super(`Timed out waiting for the write lock on room ${roomId}.`);
    this.name = "StoreLockTimeoutError";
  }
}

/**
 * Persistence for rooms. Implementations must make `update` atomic per room:
 * the mutator sees the latest state and no concurrent write is lost.
 */
export interface RoomStore {
  create(room: Room): Promise<void>;
  get(roomId: string): Promise<Room | null>;
  update(roomId: string, mutate: (room: Room) => Room): Promise<Room>;
}
