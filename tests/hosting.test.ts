import { describe, expect, it, vi } from "vitest";
import { ApiClient, CREATE_KEY_HEADER } from "../src/client/api-client.js";
import { createApp, createKeyMatches } from "../src/server/app.js";
import {
  clientFromForwardedFor,
  DEFAULT_DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  resolveServeOptions,
  ServeConfigError,
} from "../src/server/serve.js";
import { MemoryRoomStore } from "../src/store/memory-store.js";

const CREATE_KEY = "a-long-enough-create-key";

describe("resolveServeOptions", () => {
  it("should use the defaults when nothing is set", () => {
    expect(resolveServeOptions({}, {})).toEqual({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      dataDir: DEFAULT_DATA_DIR,
      trustProxy: false,
      createKey: undefined,
    });
  });

  it("should read the environment variables hosting platforms set", () => {
    const options = resolveServeOptions(
      {},
      {
        PORT: "8080",
        HOST: "0.0.0.0",
        TEAMROOM_DATA_DIR: "/data",
        TEAMROOM_TRUST_PROXY: "true",
        TEAMROOM_CREATE_KEY: CREATE_KEY,
      }
    );
    expect(options).toEqual({ port: 8080, host: "0.0.0.0", dataDir: "/data", trustProxy: true, createKey: CREATE_KEY });
  });

  it("should let flags win over the environment", () => {
    const options = resolveServeOptions(
      { port: "9000", host: "127.0.0.1", dataDir: "./local", trustProxy: false },
      { PORT: "8080", HOST: "0.0.0.0", TEAMROOM_DATA_DIR: "/data", TEAMROOM_TRUST_PROXY: "1" }
    );
    expect(options).toMatchObject({ port: 9000, host: "127.0.0.1", dataDir: "./local", trustProxy: false });
  });

  it("should treat an empty variable as unset", () => {
    expect(resolveServeOptions({}, { HOST: "", TEAMROOM_CREATE_KEY: "  " })).toMatchObject({
      host: DEFAULT_HOST,
      createKey: undefined,
    });
  });

  it("should reject an invalid port", () => {
    expect(() => resolveServeOptions({}, { PORT: "http" })).toThrow(ServeConfigError);
    expect(() => resolveServeOptions({ port: "70000" }, {})).toThrow("Port must be 1 to 65535");
  });

  it("should reject a create key too short to be secret", () => {
    expect(() => resolveServeOptions({}, { TEAMROOM_CREATE_KEY: "short" })).toThrow("at least 16 characters");
  });
});

describe("createKeyMatches", () => {
  it("should accept only the exact key", () => {
    expect(createKeyMatches(CREATE_KEY, CREATE_KEY)).toBe(true);
    expect(createKeyMatches(CREATE_KEY, `${CREATE_KEY}x`)).toBe(false);
    expect(createKeyMatches(CREATE_KEY, "a-long-enough-create-kez")).toBe(false);
    expect(createKeyMatches(CREATE_KEY, undefined)).toBe(false);
  });
});

describe("room creation with a create key", () => {
  const createRequest = (headers: Record<string, string> = {}): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name: "Core", member: "ada" }),
  });

  it("should refuse to create a room without the key", async () => {
    const app = createApp({ store: new MemoryRoomStore(), createKey: CREATE_KEY });
    const response = await app.request("/v1/rooms", createRequest());
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CREATE_KEY_REQUIRED");
  });

  it("should refuse a wrong key", async () => {
    const app = createApp({ store: new MemoryRoomStore(), createKey: CREATE_KEY });
    const response = await app.request("/v1/rooms", createRequest({ [CREATE_KEY_HEADER]: "wrong" }));
    expect(response.status).toBe(403);
  });

  it("should create a room with the key, and still let teammates join with only the invite", async () => {
    const app = createApp({ store: new MemoryRoomStore(), createKey: CREATE_KEY });
    const created = await app.request("/v1/rooms", createRequest({ [CREATE_KEY_HEADER]: CREATE_KEY }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { room: { id: string }; inviteCode: string } };

    const joined = await app.request(`/v1/rooms/${data.room.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bo", inviteCode: data.inviteCode }),
    });
    expect(joined.status).toBe(201);
  });

  it("should leave room creation open when no key is configured", async () => {
    const app = createApp({ store: new MemoryRoomStore() });
    const response = await app.request("/v1/rooms", createRequest());
    expect(response.status).toBe(201);
  });
});

describe("ApiClient.createRoom", () => {
  it("should send the create key header only when a key is given", async () => {
    const room = {
      id: "room_AAAAAAAAAAAAAAAA",
      name: "Core",
      members: [],
      activity: [],
      createdAt: "x",
      updatedAt: "x",
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: { room, me: "ada", inviteCode: "tri_x", token: "trm_x" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    const client = new ApiClient({ server: "http://teamroom.test", fetchImpl });

    await client.createRoom("Core", "ada", CREATE_KEY);
    await client.createRoom("Core", "ada");

    const headersOf = (call: number): Record<string, string> =>
      (fetchImpl.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headersOf(0)[CREATE_KEY_HEADER]).toBe(CREATE_KEY);
    expect(headersOf(1)[CREATE_KEY_HEADER]).toBeUndefined();
  });
});

describe("clientFromForwardedFor", () => {
  it("should take the address the trusted proxy appended, not one the client sent", () => {
    expect(clientFromForwardedFor("6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
    expect(clientFromForwardedFor("203.0.113.7")).toBe("203.0.113.7");
  });

  it("should return undefined when the header is missing or empty", () => {
    expect(clientFromForwardedFor(undefined)).toBeUndefined();
    expect(clientFromForwardedFor(" , ")).toBeUndefined();
  });
});
