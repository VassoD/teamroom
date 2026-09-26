import { randomUUID, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { findOverlaps } from "../core/overlap.js";
import {
  addMember,
  appendActivity,
  createRoom,
  findMemberByToken,
  inviteCodeIsValid,
  MAX_ACTIVITY_KEPT,
  MAX_MEMBERS,
  removeMember,
  rotateInvite,
  rotateMemberToken,
  toRoomView,
} from "../core/room.js";
import {
  createRoomRequestSchema,
  joinRoomRequestSchema,
  memberNameSchema,
  overlapRequestSchema,
  postActivityRequestSchema,
  roomIdSchema,
} from "../core/schemas.js";
import type { Member, Room } from "../core/types.js";
import { RoomNotFoundError, type RoomStore, StoreLockTimeoutError } from "../store/store.js";
import { type Logger, silentLogger } from "./logger.js";
import { RateLimiter, type RateLimitRule } from "./rate-limit.js";

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_BODY_BYTES = 128 * 1024;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DEFAULT_RATE_LIMITS = {
  createRoom: { limit: 20, windowMs: HOUR_MS },
  joinRoom: { limit: 60, windowMs: HOUR_MS },
  memberWrite: { limit: 240, windowMs: MINUTE_MS },
} satisfies Record<string, RateLimitRule>;

export interface AppOptions {
  store: RoomStore;
  logger?: Logger;
  rateLimits?: Partial<typeof DEFAULT_RATE_LIMITS>;
  /** Identifies the caller for anonymous rate limits (room creation, joining). */
  getClientAddress?: (context: Context) => string;
  /** When set, `POST /v1/rooms` requires it in the X-Teamroom-Create-Key header. */
  createKey?: string;
}

export const CREATE_KEY_HEADER = "x-teamroom-create-key";

/** Constant-time comparison, so response timing does not leak how much of a guessed key was right. */
export function createKeyMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

interface AppVariables {
  requestId: string;
}

type AppContext = Context<{ Variables: AppVariables }>;

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_TOKEN"
  | "FORBIDDEN"
  | "CREATE_KEY_REQUIRED"
  | "INVALID_INVITE"
  | "INVALID_INPUT"
  | "INVALID_JSON"
  | "PAYLOAD_TOO_LARGE"
  | "NAME_TAKEN"
  | "ROOM_FULL"
  | "ROOM_NOT_FOUND"
  | "MEMBER_NOT_FOUND"
  | "NOT_FOUND"
  | "RATE_LIMIT_EXCEEDED"
  | "STORE_BUSY"
  | "INTERNAL_ERROR";

class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function createApp({
  store,
  logger = silentLogger,
  rateLimits = {},
  getClientAddress = () => "anonymous",
  createKey,
}: AppOptions): Hono<{ Variables: AppVariables }> {
  const limits = { ...DEFAULT_RATE_LIMITS, ...rateLimits };
  const createLimiter = new RateLimiter(limits.createRoom);
  const joinLimiter = new RateLimiter(limits.joinRoom);
  const writeLimiter = new RateLimiter(limits.memberWrite);

  const app = new Hono<{ Variables: AppVariables }>();

  app.use(async (context, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    await next();
    logger("info", "request", {
      requestId,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    });
  });

  app.onError((error, context) => {
    const requestId = context.get("requestId");
    if (error instanceof HttpError) {
      return errorResponse(context, error.status, error.code, error.message, error.details);
    }
    if (error instanceof RoomNotFoundError) {
      return errorResponse(context, 404, "ROOM_NOT_FOUND", "No room exists with this id.");
    }
    if (error instanceof StoreLockTimeoutError) {
      return errorResponse(context, 503, "STORE_BUSY", "The room is busy. Retry in a moment.");
    }
    logger("error", "unhandled error", {
      requestId,
      path: context.req.path,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
    return errorResponse(context, 500, "INTERNAL_ERROR", "Something went wrong on the server.");
  });

  app.notFound((context) => errorResponse(context, 404, "NOT_FOUND", "No route matches this request."));

  app.get("/health", (context) => context.json({ data: { status: "ok" } }));

  // Invite links point here. The invite code is in the URL fragment, which
  // browsers never send, so this page cannot and does not reveal anything.
  app.get("/join/:roomId", (context) =>
    context.text(
      [
        "You were invited to a teamroom.",
        "",
        "In the git repo you work on, run:",
        "",
        "  npx teamroom join '<paste the full invite link here>'",
        "",
        "Paste the whole link, including the part after #.",
      ].join("\n")
    )
  );

  app.post("/v1/rooms", async (context) => {
    enforceRateLimit(createLimiter, `create:${getClientAddress(context)}`);
    if (createKey && !createKeyMatches(createKey, context.req.header(CREATE_KEY_HEADER))) {
      throw new HttpError(
        403,
        "CREATE_KEY_REQUIRED",
        "This server only lets people with its create key make rooms. Ask whoever runs it, or join a room with an invite link."
      );
    }
    const input = await parseBody(context, createRoomRequestSchema);
    const { room, inviteCode, token } = createRoom(input.name, input.member);
    await store.create(room);
    logger("info", "room created", { requestId: context.get("requestId"), roomId: room.id });
    return context.json({ data: { room: toRoomView(room), me: input.member, inviteCode, token } }, 201);
  });

  app.post("/v1/rooms/:roomId/members", async (context) => {
    const roomId = parseRoomId(context);
    enforceRateLimit(joinLimiter, `join:${getClientAddress(context)}`);
    const input = await parseBody(context, joinRoomRequestSchema);

    let issuedToken = "";
    const room = await store.update(roomId, (current) => {
      if (!inviteCodeIsValid(current, input.inviteCode)) {
        throw new HttpError(403, "INVALID_INVITE", "This invite code is not valid for the room.");
      }
      if (current.members.some((member) => member.name === input.name)) {
        throw new HttpError(409, "NAME_TAKEN", "Someone in this room already uses that name. Pick another.");
      }
      if (current.members.length >= MAX_MEMBERS) {
        throw new HttpError(409, "ROOM_FULL", `A room holds at most ${MAX_MEMBERS} members.`);
      }
      const joined = addMember(current, input.name);
      issuedToken = joined.token;
      return joined.room;
    });

    return context.json(
      { data: { room: toRoomView(room, DEFAULT_ACTIVITY_LIMIT), me: input.name, token: issuedToken } },
      201
    );
  });

  app.get("/v1/rooms/:roomId", async (context) => {
    const { room, member } = await authenticate(context);
    const limit = parseLimit(context.req.query("limit"));
    return context.json({ data: { room: toRoomView(room, limit), me: member.name } });
  });

  app.post("/v1/rooms/:roomId/activity", async (context) => {
    const { room: authenticatedRoom, member, token } = await authenticate(context);
    enforceRateLimit(writeLimiter, `write:${authenticatedRoom.id}:${member.name}`);
    const input = await parseBody(context, postActivityRequestSchema);

    let created: ReturnType<typeof appendActivity>["entry"] | undefined;
    await store.update(authenticatedRoom.id, (current) => {
      const writer = requireMemberInLatest(current, token);
      const result = appendActivity(current, writer.name, input);
      created = result.entry;
      return result.room;
    });
    return context.json({ data: { activity: created } }, 201);
  });

  app.post("/v1/rooms/:roomId/overlap", async (context) => {
    const { room, member } = await authenticate(context);
    const input = await parseBody(context, overlapRequestSchema);
    const overlaps = findOverlaps({
      activity: room.activity,
      files: input.files,
      member: member.name,
      session: input.session,
      sinceHours: input.sinceHours,
    });
    return context.json({ data: { overlaps } });
  });

  app.post("/v1/rooms/:roomId/members/me/token", async (context) => {
    const { room: authenticatedRoom, member, token } = await authenticate(context);
    enforceRateLimit(writeLimiter, `write:${authenticatedRoom.id}:${member.name}`);

    let issuedToken = "";
    await store.update(authenticatedRoom.id, (current) => {
      const caller = requireMemberInLatest(current, token);
      const rotated = rotateMemberToken(current, caller.name);
      issuedToken = rotated.token;
      return rotated.room;
    });
    return context.json({ data: { me: member.name, token: issuedToken } });
  });

  app.delete("/v1/rooms/:roomId/members/:memberName", async (context) => {
    const { room: authenticatedRoom, member, token } = await authenticate(context);
    enforceRateLimit(writeLimiter, `write:${authenticatedRoom.id}:${member.name}`);
    const parsedName = memberNameSchema.safeParse(context.req.param("memberName"));
    if (!parsedName.success) {
      throw new HttpError(404, "MEMBER_NOT_FOUND", "No member of this room has that name.");
    }
    const targetName = parsedName.data;

    const room = await store.update(authenticatedRoom.id, (current) => {
      const caller = requireMemberInLatest(current, token);
      const target = current.members.find((candidate) => candidate.name === targetName);
      if (!target) {
        throw new HttpError(404, "MEMBER_NOT_FOUND", "No member of this room has that name.");
      }
      if (target.role === "owner") {
        throw new HttpError(403, "FORBIDDEN", "The room owner cannot be removed.");
      }
      if (caller.role !== "owner" && caller.name !== target.name) {
        throw new HttpError(403, "FORBIDDEN", "Only the room owner can remove other members.");
      }
      return removeMember(current, target.name);
    });
    logger("info", "member removed", { requestId: context.get("requestId"), roomId: room.id });
    return context.json({ data: { room: toRoomView(room, DEFAULT_ACTIVITY_LIMIT) } });
  });

  app.post("/v1/rooms/:roomId/invite", async (context) => {
    const { room: authenticatedRoom, member, token } = await authenticate(context);
    enforceRateLimit(writeLimiter, `write:${authenticatedRoom.id}:${member.name}`);

    let inviteCode = "";
    await store.update(authenticatedRoom.id, (current) => {
      const caller = requireMemberInLatest(current, token);
      if (caller.role !== "owner") {
        throw new HttpError(403, "FORBIDDEN", "Only the room owner can rotate the invite code.");
      }
      const rotated = rotateInvite(current);
      inviteCode = rotated.inviteCode;
      return rotated.room;
    });
    return context.json({ data: { inviteCode } });
  });

  async function authenticate(context: AppContext): Promise<{ room: Room; member: Member; token: string }> {
    const roomId = parseRoomId(context);
    const header = context.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      throw new HttpError(401, "AUTH_REQUIRED", "Send your member token as `Authorization: Bearer <token>`.");
    }
    const room = await store.get(roomId);
    // Same answer for "no such room" and "wrong token" so room ids cannot be probed.
    const member = room ? findMemberByToken(room, token) : undefined;
    if (!room || !member) {
      throw invalidTokenError();
    }
    return { room, member, token };
  }

  return app;
}

/**
 * Writes re-check the token against the state inside the lock, so a member
 * removed or a token rotated between authentication and the write cannot slip through.
 */
function requireMemberInLatest(room: Room, token: string): Member {
  const member = findMemberByToken(room, token);
  if (!member) throw invalidTokenError();
  return member;
}

function invalidTokenError(): HttpError {
  return new HttpError(401, "INVALID_TOKEN", "This token does not belong to a member of the room.");
}

function parseRoomId(context: AppContext): string {
  const parsed = roomIdSchema.safeParse(context.req.param("roomId"));
  if (!parsed.success) {
    throw new HttpError(404, "ROOM_NOT_FOUND", "No room exists with this id.");
  }
  return parsed.data;
}

async function parseBody<Schema extends z.ZodType>(context: AppContext, schema: Schema): Promise<z.output<Schema>> {
  const declaredLength = Number(context.req.header("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`);
  }
  const raw = await context.req.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    throw new HttpError(400, "INVALID_INPUT", "Some fields are missing or invalid.", details);
  }
  return parsed.data;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ACTIVITY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ACTIVITY_KEPT) {
    throw new HttpError(400, "INVALID_INPUT", `limit must be an integer between 1 and ${MAX_ACTIVITY_KEPT}.`);
  }
  return parsed;
}

function enforceRateLimit(limiter: RateLimiter, key: string): void {
  const retryAfterSeconds = limiter.hit(key);
  if (retryAfterSeconds !== null) {
    throw new HttpError(429, "RATE_LIMIT_EXCEEDED", `Too many requests. Retry in ${retryAfterSeconds}s.`, {
      retryAfterSeconds,
    });
  }
}

function errorResponse(
  context: AppContext,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details?: unknown
): Response {
  const error = { code, message, requestId: context.get("requestId"), ...(details === undefined ? {} : { details }) };
  return context.json({ error }, status);
}
