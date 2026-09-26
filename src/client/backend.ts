import path from "node:path";
import { findOverlaps } from "../core/overlap.js";
import { addMember, appendActivity, createRoom, DEFAULT_ACTIVITY_LIMIT, toRoomView } from "../core/room.js";
import { overlapRequestSchema, type PostActivityRequest, postActivityRequestSchema } from "../core/schemas.js";
import type { Activity, FileOverlap, Room, RoomView } from "../core/types.js";
import { FileRoomStore } from "../store/file-store.js";
import { RoomAlreadyExistsError, RoomNotFoundError } from "../store/store.js";
import type { ApiClient } from "./api-client.js";

/**
 * - `local`: every checkout of this repo on this machine, through a file in the git common dir. No server.
 * - `shared`: a room on a teamroom server, so teammates on other machines are included.
 */
export type BackendMode = "local" | "shared";

export interface OverlapQuery {
  files: string[];
  session?: string;
  sinceHours?: number;
}

/** Where a workspace reads and writes activity. Commands never need to know which one they got. */
export interface RoomBackend {
  readonly mode: BackendMode;
  getRoom(limit?: number): Promise<{ room: RoomView; me: string }>;
  postActivity(input: PostActivityRequest): Promise<Activity>;
  findOverlaps(query: OverlapQuery): Promise<FileOverlap[]>;
}

export class SharedBackend implements RoomBackend {
  readonly mode = "shared";

  constructor(
    private readonly client: ApiClient,
    private readonly roomId: string
  ) {}

  async getRoom(limit?: number): Promise<{ room: RoomView; me: string }> {
    return this.client.getRoom(this.roomId, limit);
  }

  async postActivity(input: PostActivityRequest): Promise<Activity> {
    return this.client.postActivity(this.roomId, input);
  }

  async findOverlaps(query: OverlapQuery): Promise<FileOverlap[]> {
    return this.client.findOverlaps(this.roomId, query);
  }
}

/** Fixed, because a repo has exactly one local room. Matches the room id pattern the store validates. */
export const LOCAL_ROOM_ID = "room_worktrees-shared";
export const LOCAL_STORE_DIR = "teamroom";

export function localStoreDir(gitCommonDir: string): string {
  return path.join(gitCommonDir, LOCAL_STORE_DIR);
}

/**
 * Keeps the room in the git common dir, which every worktree of the repo
 * shares, so parallel agents on one machine see each other with no server,
 * account or network. The file store's lock makes concurrent hooks safe.
 */
export class LocalBackend implements RoomBackend {
  readonly mode = "local";
  private readonly store: FileRoomStore;

  constructor(
    gitCommonDir: string,
    private readonly member: string,
    private readonly roomName: string
  ) {
    this.store = new FileRoomStore(localStoreDir(gitCommonDir));
  }

  async getRoom(limit = DEFAULT_ACTIVITY_LIMIT): Promise<{ room: RoomView; me: string }> {
    const room = (await this.store.get(LOCAL_ROOM_ID)) ?? this.emptyRoom();
    return { room: toRoomView(withMember(room, this.member), limit), me: this.member };
  }

  async postActivity(input: PostActivityRequest): Promise<Activity> {
    const parsed = postActivityRequestSchema.parse(input);
    let created: Activity | undefined;
    await this.mutate((room) => {
      const result = appendActivity(withMember(room, this.member), this.member, parsed);
      created = result.entry;
      return result.room;
    });
    if (!created) throw new Error("The activity was not recorded.");
    return created;
  }

  async findOverlaps(query: OverlapQuery): Promise<FileOverlap[]> {
    const parsed = overlapRequestSchema.parse(query);
    const room = await this.store.get(LOCAL_ROOM_ID);
    if (!room) return [];
    return findOverlaps({
      activity: room.activity,
      files: parsed.files,
      member: this.member,
      session: parsed.session,
      sinceHours: parsed.sinceHours,
    });
  }

  private emptyRoom(): Room {
    return { ...createRoom(this.roomName, this.member).room, id: LOCAL_ROOM_ID };
  }

  /** Creates the room on first write. Two hooks racing to create it both end up updating the same one. */
  private async mutate(change: (room: Room) => Room): Promise<Room> {
    try {
      return await this.store.update(LOCAL_ROOM_ID, change);
    } catch (error) {
      if (!(error instanceof RoomNotFoundError)) throw error;
    }
    try {
      await this.store.create(this.emptyRoom());
    } catch (error) {
      if (!(error instanceof RoomAlreadyExistsError)) throw error;
    }
    return this.store.update(LOCAL_ROOM_ID, change);
  }
}

/** A local room has no invites: whoever writes from this machine is a member. */
function withMember(room: Room, member: string): Room {
  if (room.members.some((existing) => existing.name === member)) return room;
  return addMember(room, member).room;
}
