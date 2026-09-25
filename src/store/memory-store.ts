import type { Room } from "../core/types.js";
import { RoomAlreadyExistsError, RoomNotFoundError, type RoomStore } from "./store.js";

/** In-process store for tests and throwaway local servers. Data is lost on restart. */
export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Room>();

  async create(room: Room): Promise<void> {
    if (this.rooms.has(room.id)) throw new RoomAlreadyExistsError(room.id);
    this.rooms.set(room.id, structuredClone(room));
  }

  async get(roomId: string): Promise<Room | null> {
    const room = this.rooms.get(roomId);
    return room ? structuredClone(room) : null;
  }

  async update(roomId: string, mutate: (room: Room) => Room): Promise<Room> {
    const current = this.rooms.get(roomId);
    if (!current) throw new RoomNotFoundError(roomId);
    const next = mutate(structuredClone(current));
    this.rooms.set(roomId, structuredClone(next));
    return structuredClone(next);
  }
}
