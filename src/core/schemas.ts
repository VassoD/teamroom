import { z } from "zod";
import { AGENT_ID_PATTERN, MAX_AGENT_ID_LENGTH } from "./agents.js";

export const MAX_TEXT_LENGTH = 500;
export const MAX_FILES_PER_ACTIVITY = 200;
export const MAX_FILE_PATH_LENGTH = 300;
export const MAX_NAME_LENGTH = 40;
export const MAX_ROOM_NAME_LENGTH = 80;
export const MAX_SESSION_LENGTH = 80;
export const MAX_OVERLAP_WINDOW_HOURS = 24 * 90;

export const ROOM_ID_PATTERN = /^room_[A-Za-z0-9_-]{16}$/;

const activityKindSchema = z.enum(["wip", "commit", "note", "edit"]);
const activitySourceSchema = z.enum(["human", "hook", "agent"]);
const memberRoleSchema = z.enum(["owner", "member"]);

export const roomIdSchema = z.string().regex(ROOM_ID_PATTERN, "Room id must look like room_xxxxxxxxxxxxxxxx.");

export const memberNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .regex(/^[^\s@][^@]*$/, "Name cannot start with whitespace or contain @.");

export const roomNameSchema = z.string().trim().min(1).max(MAX_ROOM_NAME_LENGTH);

export const sessionSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SESSION_LENGTH)
  .regex(/^[A-Za-z0-9._:/-]+$/, "Session may only contain letters, digits and . _ : / -");

export const agentIdSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_ID_LENGTH)
  .regex(AGENT_ID_PATTERN, "Agent may only contain lowercase letters, digits and . _ -");

export const activityTextSchema = z.string().trim().min(1).max(MAX_TEXT_LENGTH);

export const filePathSchema = z.string().trim().min(1).max(MAX_FILE_PATH_LENGTH);

export const activitySchema = z.object({
  id: z.string(),
  member: z.string(),
  session: z.string().optional(),
  kind: activityKindSchema,
  source: activitySourceSchema,
  agent: z.string().optional(),
  text: z.string(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  files: z.array(z.string()),
  createdAt: z.string(),
});

export const memberViewSchema = z.object({ name: z.string(), role: memberRoleSchema, joinedAt: z.string() });

export const roomViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(memberViewSchema),
  activity: z.array(activitySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const fileOverlapSchema = z.object({
  file: z.string(),
  touchedBy: z.array(
    z.object({
      member: z.string(),
      session: z.string().optional(),
      agent: z.string().optional(),
      kind: activityKindSchema,
      text: z.string(),
      branch: z.string().optional(),
      commit: z.string().optional(),
      at: z.string(),
      plan: z.string().optional(),
    })
  ),
});

export const createRoomRequestSchema = z.object({
  name: roomNameSchema,
  member: memberNameSchema,
});

export const joinRoomRequestSchema = z.object({
  name: memberNameSchema,
  inviteCode: z.string().min(1).max(200),
});

export const postActivityRequestSchema = z.object({
  kind: activityKindSchema.default("note"),
  source: activitySourceSchema.default("human"),
  agent: agentIdSchema.optional(),
  session: sessionSchema.optional(),
  text: activityTextSchema,
  branch: z.string().trim().min(1).max(200).optional(),
  commit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{4,40}$/i, "Commit must be a hex sha.")
    .optional(),
  files: z.array(filePathSchema).max(MAX_FILES_PER_ACTIVITY).default([]),
});

export const overlapRequestSchema = z.object({
  files: z.array(filePathSchema).min(1).max(MAX_FILES_PER_ACTIVITY),
  /** The caller's own session. Other sessions of the same member still count as overlap. */
  session: sessionSchema.optional(),
  sinceHours: z.number().int().positive().max(MAX_OVERLAP_WINDOW_HOURS).optional(),
});

export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export type JoinRoomRequest = z.infer<typeof joinRoomRequestSchema>;
export type PostActivityRequest = z.input<typeof postActivityRequestSchema>;
export type OverlapRequest = z.infer<typeof overlapRequestSchema>;
