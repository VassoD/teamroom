import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ROOM_ID_BYTES = 12;
const SECRET_BYTES = 32;
const MEMBER_TOKEN_PREFIX = "trm_";
const INVITE_CODE_PREFIX = "tri_";

export function newRoomId(): string {
  return `room_${randomBytes(ROOM_ID_BYTES).toString("base64url")}`;
}

export function newMemberToken(): string {
  return `${MEMBER_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export function newInviteCode(): string {
  return `${INVITE_CODE_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretMatchesHash(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
