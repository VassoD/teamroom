import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { MemoryRoomStore } from "../src/store/memory-store.js";

type App = ReturnType<typeof createApp>;

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code: string; message: string; requestId: string };
}

async function call(
  app: App,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ status: number; json: Envelope }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await app.request(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: (await response.json()) as Envelope };
}

interface Setup {
  app: App;
  roomId: string;
  inviteCode: string;
  ownerToken: string;
  memberToken: string;
}

async function setUpRoom(): Promise<Setup> {
  const app = createApp({ store: new MemoryRoomStore() });
  const created = await call(app, "POST", "/v1/rooms", { body: { name: "Core", member: "ada" } });
  const data = created.json.data as { room: { id: string }; inviteCode: string; token: string };
  const joined = await call(app, "POST", `/v1/rooms/${data.room.id}/members`, {
    body: { name: "bo", inviteCode: data.inviteCode },
  });
  return {
    app,
    roomId: data.room.id,
    inviteCode: data.inviteCode,
    ownerToken: data.token,
    memberToken: (joined.json.data as { token: string }).token,
  };
}

describe("teamroom HTTP API", () => {
  let setup: Setup;

  beforeEach(async () => {
    setup = await setUpRoom();
  });

  it("should make the room creator the owner", async () => {
    const { json } = await call(setup.app, "GET", `/v1/rooms/${setup.roomId}`, { token: setup.ownerToken });

    expect((json.data as { room: { members: unknown[] } }).room.members).toEqual([
      expect.objectContaining({ name: "ada", role: "owner" }),
      expect.objectContaining({ name: "bo", role: "member" }),
    ]);
  });

  it("should warn a member about another member's wip snapshot", async () => {
    await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/activity`, {
      token: setup.memberToken,
      body: { kind: "wip", source: "hook", session: "bo-laptop", text: "auth work", files: ["src/auth.ts"] },
    });

    const { status, json } = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/overlap`, {
      token: setup.ownerToken,
      body: { files: ["src/auth.ts", "src/other.ts"], session: "ada-laptop" },
    });

    expect(status).toBe(200);
    expect(json.data?.overlaps).toEqual([
      {
        file: "src/auth.ts",
        touchedBy: [expect.objectContaining({ member: "bo", session: "bo-laptop", kind: "wip" })],
      },
    ]);
  });

  it("should reject requests without a token", async () => {
    const { status, json } = await call(setup.app, "GET", `/v1/rooms/${setup.roomId}`);

    expect(status).toBe(401);
    expect(json.error?.code).toBe("AUTH_REQUIRED");
  });

  it("should answer the same way for an unknown room and a wrong token", async () => {
    const unknownRoom = await call(setup.app, "GET", "/v1/rooms/room_AAAAAAAAAAAAAAAA", { token: setup.ownerToken });
    const wrongToken = await call(setup.app, "GET", `/v1/rooms/${setup.roomId}`, { token: "trm_nope" });

    expect(unknownRoom.status).toBe(401);
    expect(wrongToken.json.error?.code).toBe(unknownRoom.json.error?.code);
  });

  it("should reject invalid activity with field details", async () => {
    const { status, json } = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/activity`, {
      token: setup.ownerToken,
      body: { text: "", session: "has spaces" },
    });

    expect(status).toBe(400);
    expect(json.error?.code).toBe("INVALID_INPUT");
  });

  describe("member management", () => {
    it("should let the owner remove a member and revoke their token", async () => {
      const removed = await call(setup.app, "DELETE", `/v1/rooms/${setup.roomId}/members/bo`, {
        token: setup.ownerToken,
      });
      const afterwards = await call(setup.app, "GET", `/v1/rooms/${setup.roomId}`, { token: setup.memberToken });

      expect(removed.status).toBe(200);
      expect(afterwards.status).toBe(401);
    });

    it("should let a member remove themselves", async () => {
      const { status } = await call(setup.app, "DELETE", `/v1/rooms/${setup.roomId}/members/bo`, {
        token: setup.memberToken,
      });

      expect(status).toBe(200);
    });

    it("should forbid a member from removing someone else", async () => {
      const joined = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/members`, {
        body: { name: "cy", inviteCode: setup.inviteCode },
      });
      expect(joined.status).toBe(201);

      const { status, json } = await call(setup.app, "DELETE", `/v1/rooms/${setup.roomId}/members/cy`, {
        token: setup.memberToken,
      });

      expect(status).toBe(403);
      expect(json.error?.code).toBe("FORBIDDEN");
    });

    it("should never remove the owner", async () => {
      const { status } = await call(setup.app, "DELETE", `/v1/rooms/${setup.roomId}/members/ada`, {
        token: setup.ownerToken,
      });

      expect(status).toBe(403);
    });

    it("should return MEMBER_NOT_FOUND for an unknown name", async () => {
      const { status, json } = await call(setup.app, "DELETE", `/v1/rooms/${setup.roomId}/members/zed`, {
        token: setup.ownerToken,
      });

      expect(status).toBe(404);
      expect(json.error?.code).toBe("MEMBER_NOT_FOUND");
    });
  });

  describe("invite rotation", () => {
    it("should invalidate the old invite code", async () => {
      const rotated = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/invite`, { token: setup.ownerToken });
      const newCode = (rotated.json.data as { inviteCode: string }).inviteCode;

      const withOld = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/members`, {
        body: { name: "cy", inviteCode: setup.inviteCode },
      });
      const withNew = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/members`, {
        body: { name: "cy", inviteCode: newCode },
      });

      expect(withOld.status).toBe(403);
      expect(withNew.status).toBe(201);
    });

    it("should be owner only", async () => {
      const { status } = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/invite`, {
        token: setup.memberToken,
      });

      expect(status).toBe(403);
    });
  });

  describe("token rotation", () => {
    it("should issue a working token and revoke the old one", async () => {
      const rotated = await call(setup.app, "POST", `/v1/rooms/${setup.roomId}/members/me/token`, {
        token: setup.memberToken,
      });
      const newToken = (rotated.json.data as { token: string }).token;

      const withOld = await call(setup.app, "GET", `/v1/rooms/${setup.roomId}`, { token: setup.memberToken });
      const withNew = await call(setup.app, "GET", `/v1/rooms/${setup.roomId}`, { token: newToken });

      expect(withOld.status).toBe(401);
      expect(withNew.status).toBe(200);
    });
  });

  it("should answer an opened invite link with join instructions and no room data", async () => {
    const response = await setup.app.request(`/join/${setup.roomId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("teamroom join");
    expect(body).not.toContain("Core");
  });

  it("should rate limit room creation per client", async () => {
    const app = createApp({ store: new MemoryRoomStore(), rateLimits: { createRoom: { limit: 1, windowMs: 60_000 } } });

    const first = await call(app, "POST", "/v1/rooms", { body: { name: "One", member: "ada" } });
    const second = await call(app, "POST", "/v1/rooms", { body: { name: "Two", member: "ada" } });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.json.error?.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

describe("request body limit", () => {
  it("should reject an oversized body sent without Content-Length before reading all of it", async () => {
    const app = createApp({ store: new MemoryRoomStore() });
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let chunksPulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        if (chunksPulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });

    const response = await app.request("/v1/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
    expect(((await response.json()) as Envelope).error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(chunksPulled).toBeLessThan(100);
  });
});
