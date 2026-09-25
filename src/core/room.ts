import { randomUUID } from "node:crypto";
import type { PostActivityRequest } from "./schemas.js";
import { hashSecret, newInviteCode, newMemberToken, newRoomId, secretMatchesHash } from "./secrets.js";
import type { Activity, Member, Room, RoomView } from "./types.js";

export const MAX_ACTIVITY_KEPT = 1000;
export const MAX_MEMBERS = 100;

export interface NewRoomResult {
  room: Room;
  inviteCode: string;
  token: string;
}

export type ActivityInput = Required<Pick<PostActivityRequest, "kind" | "source" | "text" | "files">> &
  Pick<PostActivityRequest, "session" | "branch" | "commit">;

export function createRoom(name: string, creatorName: string, now = new Date()): NewRoomResult {
  const inviteCode = newInviteCode();
  const token = newMemberToken();
  const timestamp = now.toISOString();
  return {
    room: {
      id: newRoomId(),
      name,
      inviteHash: hashSecret(inviteCode),
      members: [{ name: creatorName, role: "owner", tokenHash: hashSecret(token), joinedAt: timestamp }],
      activity: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    inviteCode,
    token,
  };
}

export function findMemberByToken(room: Room, token: string): Member | undefined {
  return room.members.find((member) => secretMatchesHash(token, member.tokenHash));
}

export function inviteCodeIsValid(room: Room, inviteCode: string): boolean {
  return secretMatchesHash(inviteCode, room.inviteHash);
}

export function addMember(room: Room, name: string, now = new Date()): { room: Room; token: string } {
  const token = newMemberToken();
  const timestamp = now.toISOString();
  return {
    room: {
      ...room,
      members: [...room.members, { name, role: "member", tokenHash: hashSecret(token), joinedAt: timestamp }],
      updatedAt: timestamp,
    },
    token,
  };
}

/** Removes the member and revokes their token. Their past activity stays for context. */
export function removeMember(room: Room, name: string, now = new Date()): Room {
  return {
    ...room,
    members: room.members.filter((member) => member.name !== name),
    updatedAt: now.toISOString(),
  };
}

/** Issues a new invite code. The old one stops working immediately. */
export function rotateInvite(room: Room, now = new Date()): { room: Room; inviteCode: string } {
  const inviteCode = newInviteCode();
  return {
    room: { ...room, inviteHash: hashSecret(inviteCode), updatedAt: now.toISOString() },
    inviteCode,
  };
}

/** Issues a new token for the member. The old one stops working immediately. */
export function rotateMemberToken(room: Room, name: string, now = new Date()): { room: Room; token: string } {
  const token = newMemberToken();
  return {
    room: {
      ...room,
      members: room.members.map((member) =>
        member.name === name ? { ...member, tokenHash: hashSecret(token) } : member
      ),
      updatedAt: now.toISOString(),
    },
    token,
  };
}

export function appendActivity(
  room: Room,
  memberName: string,
  input: ActivityInput,
  now = new Date()
): { room: Room; entry: Activity } {
  const timestamp = now.toISOString();
  const entry: Activity = {
    id: randomUUID(),
    member: memberName,
    session: input.session,
    kind: input.kind,
    source: input.source,
    text: input.text,
    branch: input.branch,
    commit: input.commit,
    files: input.files,
    createdAt: timestamp,
  };
  return {
    room: {
      ...room,
      activity: [...room.activity, entry].slice(-MAX_ACTIVITY_KEPT),
      updatedAt: timestamp,
    },
    entry,
  };
}

export function toRoomView(room: Room, activityLimit?: number): RoomView {
  const activity = activityLimit === undefined ? room.activity : room.activity.slice(-activityLimit);
  return {
    id: room.id,
    name: room.name,
    members: room.members.map(({ name, role, joinedAt }) => ({ name, role, joinedAt })),
    activity,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}
