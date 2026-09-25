import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/client/errors.js";
import type { Workspace } from "../src/client/workspace.js";
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/server.js";

function request(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const notJoined = async (): Promise<Workspace> => {
  throw new ConfigError("This repo is not in a teamroom yet.");
};

describe("MCP handler", () => {
  const handler = createMcpHandler(notJoined);

  it("should echo a supported protocol version on initialize", async () => {
    const response = await handler.handle(request(1, "initialize", { protocolVersion: "2025-03-26" }));

    expect(response).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "teamroom" } },
    });
  });

  it("should fall back to its latest version for an unknown one", async () => {
    const response = await handler.handle(request(1, "initialize", { protocolVersion: "1999-01-01" }));

    expect(response).toMatchObject({ result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] } });
  });

  it("should list the tools with JSON schemas", async () => {
    const response = await handler.handle(request(2, "tools/list"));
    const tools = (response as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }).result
      .tools;

    expect(tools.map((tool) => tool.name)).toEqual([
      "teamroom_check_overlap",
      "teamroom_report_work",
      "teamroom_post_note",
      "teamroom_recent_activity",
    ]);
    expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("should not answer notifications", async () => {
    expect(
      await handler.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))
    ).toBeUndefined();
  });

  it("should reject unknown methods and malformed messages", async () => {
    expect(await handler.handle(request(3, "resources/list"))).toMatchObject({ error: { code: -32601 } });
    expect(await handler.handle("{not json")).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await handler.handle(JSON.stringify({ id: 4 }))).toMatchObject({ error: { code: -32600 } });
  });

  it("should return setup problems as tool errors the agent can relay", async () => {
    const response = await handler.handle(request(5, "tools/call", { name: "teamroom_check_overlap", arguments: {} }));

    expect(response).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "This repo is not in a teamroom yet." }] },
    });
  });

  it("should validate tool arguments before running", async () => {
    const response = await handler.handle(
      request(6, "tools/call", { name: "teamroom_post_note", arguments: { text: "" } })
    );

    expect(response).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(response)).toContain("Invalid arguments");
  });

  it("should reject unknown tools", async () => {
    expect(await handler.handle(request(7, "tools/call", { name: "nope" }))).toMatchObject({ error: { code: -32602 } });
  });
});
