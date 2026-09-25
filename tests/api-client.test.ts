import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/client/api-client.js";
import { ApiError, NetworkError } from "../src/client/errors.js";

const ROOM_ID = "room_AAAAAAAAAAAAAAAA";
const ROOM = {
  id: ROOM_ID,
  name: "Core",
  members: [{ name: "ada", role: "owner", joinedAt: "2026-09-25T00:00:00.000Z" }],
  activity: [],
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(fetchImpl: typeof fetch): ApiClient {
  return new ApiClient({ server: "http://teamroom.test/", token: "trm_test", fetchImpl, sleep: async () => undefined });
}

describe("ApiClient", () => {
  it("should send the bearer token and unwrap the data envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { data: { room: ROOM, me: "ada" } }));

    const result = await clientWith(fetchImpl).getRoom(ROOM_ID, 5);

    expect(result.me).toBe("ada");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`http://teamroom.test/v1/rooms/${ROOM_ID}?limit=5`);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer trm_test");
  });

  it("should turn an error envelope into an ApiError", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(401, { error: { code: "INVALID_TOKEN", message: "Bad token.", requestId: "req-1" } })
    );

    await expect(clientWith(fetchImpl).getRoom(ROOM_ID)).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "INVALID_TOKEN",
      requestId: "req-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should retry reads on 503 with backoff", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "STORE_BUSY", message: "Busy." } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { room: ROOM, me: "ada" } }));
    const sleep = vi.fn(async () => undefined);
    const client = new ApiClient({ server: "http://teamroom.test", fetchImpl, sleep });

    await expect(client.getRoom(ROOM_ID)).resolves.toMatchObject({ me: "ada" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("should never retry a write, so it cannot be applied twice", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(clientWith(fetchImpl).postActivity(ROOM_ID, { text: "hi" })).rejects.toBeInstanceOf(NetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should give up after the maximum number of attempts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(clientWith(fetchImpl).getRoom(ROOM_ID)).rejects.toBeInstanceOf(NetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("should reject a response that is not shaped like teamroom", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { hello: "world" }));

    await expect(clientWith(fetchImpl).getRoom(ROOM_ID)).rejects.toBeInstanceOf(NetworkError);
  });

  it("should report non-JSON errors with the HTTP status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("gateway down", { status: 404 }));

    const error = await clientWith(fetchImpl)
      .getRoom(ROOM_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("UNEXPECTED_RESPONSE");
  });
});
