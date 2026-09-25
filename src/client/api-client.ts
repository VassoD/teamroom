import { z } from "zod";
import { activitySchema, fileOverlapSchema, roomViewSchema, type PostActivityRequest } from "../core/schemas.js";
import type { Activity, FileOverlap, RoomView } from "../core/types.js";
import { ApiError, NetworkError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 200;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }),
});

const successEnvelopeSchema = z.object({ data: z.unknown() });

const createdRoomSchema = z.object({ room: roomViewSchema, me: z.string(), inviteCode: z.string(), token: z.string() });
const joinedRoomSchema = z.object({ room: roomViewSchema, me: z.string(), token: z.string() });
const roomResponseSchema = z.object({ room: roomViewSchema, me: z.string() });
const activityResponseSchema = z.object({ activity: activitySchema });
const overlapResponseSchema = z.object({ overlaps: z.array(fileOverlapSchema) });
const tokenResponseSchema = z.object({ me: z.string(), token: z.string() });
const inviteResponseSchema = z.object({ inviteCode: z.string() });
const removedMemberSchema = z.object({ room: roomViewSchema });

export interface ApiClientOptions {
  server: string;
  token?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface RequestOptions<Schema extends z.ZodType> {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  schema: Schema;
  /** Only idempotent requests are retried, so a timed-out POST is never duplicated. */
  retry: boolean;
}

export class ApiClient {
  private readonly server: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: ApiClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async createRoom(name: string, member: string): Promise<z.infer<typeof createdRoomSchema>> {
    return this.request({
      method: "POST",
      path: "/v1/rooms",
      body: { name, member },
      schema: createdRoomSchema,
      retry: false,
    });
  }

  async joinRoom(roomId: string, name: string, inviteCode: string): Promise<z.infer<typeof joinedRoomSchema>> {
    return this.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(roomId)}/members`,
      body: { name, inviteCode },
      schema: joinedRoomSchema,
      retry: false,
    });
  }

  async getRoom(roomId: string, limit?: number): Promise<{ room: RoomView; me: string }> {
    const query = limit === undefined ? "" : `?limit=${limit}`;
    return this.request({
      method: "GET",
      path: `/v1/rooms/${encodeURIComponent(roomId)}${query}`,
      schema: roomResponseSchema,
      retry: true,
    });
  }

  async postActivity(roomId: string, input: PostActivityRequest): Promise<Activity> {
    const { activity } = await this.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(roomId)}/activity`,
      body: input,
      schema: activityResponseSchema,
      retry: false,
    });
    return activity;
  }

  async findOverlaps(
    roomId: string,
    input: { files: string[]; session?: string; sinceHours?: number }
  ): Promise<FileOverlap[]> {
    const { overlaps } = await this.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(roomId)}/overlap`,
      body: input,
      schema: overlapResponseSchema,
      // Overlap is a read that uses POST only to carry the file list.
      retry: true,
    });
    return overlaps;
  }

  async rotateToken(roomId: string): Promise<string> {
    const { token } = await this.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(roomId)}/members/me/token`,
      schema: tokenResponseSchema,
      retry: false,
    });
    return token;
  }

  async rotateInvite(roomId: string): Promise<string> {
    const { inviteCode } = await this.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(roomId)}/invite`,
      schema: inviteResponseSchema,
      retry: false,
    });
    return inviteCode;
  }

  async removeMember(roomId: string, name: string): Promise<RoomView> {
    const { room } = await this.request({
      method: "DELETE",
      path: `/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(name)}`,
      schema: removedMemberSchema,
      retry: false,
    });
    return room;
  }

  private async request<Schema extends z.ZodType>(request: RequestOptions<Schema>): Promise<z.output<Schema>> {
    const attempts = request.retry ? this.maxAttempts : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.send(request);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === attempts) throw error;
        await this.sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  private async send<Schema extends z.ZodType>(request: RequestOptions<Schema>): Promise<z.output<Schema>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.server}${request.path}`, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
      throw new NetworkError(`The teamroom server at ${this.server} ${reason}.`, { cause: error });
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const envelope = errorEnvelopeSchema.safeParse(payload);
      if (envelope.success) {
        const { code, message, requestId } = envelope.data.error;
        throw new ApiError(response.status, code, message, requestId);
      }
      throw new ApiError(response.status, "UNEXPECTED_RESPONSE", `The server answered with HTTP ${response.status}.`);
    }

    const envelope = successEnvelopeSchema.safeParse(payload);
    const parsed = envelope.success ? request.schema.safeParse(envelope.data.data) : undefined;
    if (!parsed?.success) {
      throw new NetworkError(`The server at ${this.server} did not answer like a teamroom server.`);
    }
    return parsed.data;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && RETRYABLE_STATUSES.has(error.status);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
