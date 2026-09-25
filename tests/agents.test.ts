import { describe, expect, it } from "vitest";
import { agentLabel, normalizeAgentId } from "../src/core/agents.js";

describe("normalizeAgentId", () => {
  it("should map the names Claude Code and Codex send in the MCP handshake", () => {
    expect(normalizeAgentId("claude-code")).toBe("claude-code");
    expect(normalizeAgentId("codex-mcp-client")).toBe("codex");
  });

  it("should keep unknown clients, sanitized", () => {
    expect(normalizeAgentId("  Cursor Agent/1 ")).toBe("cursor-agent-1");
  });

  it("should return undefined when nothing usable is left", () => {
    expect(normalizeAgentId(undefined)).toBeUndefined();
    expect(normalizeAgentId("!!!")).toBeUndefined();
  });

  it("should cap the length", () => {
    expect(normalizeAgentId("a".repeat(100))).toHaveLength(40);
  });
});

describe("agentLabel", () => {
  it("should name known agents and fall back to the id", () => {
    expect(agentLabel("claude-code")).toBe("Claude Code");
    expect(agentLabel("codex")).toBe("Codex");
    expect(agentLabel("cursor-agent")).toBe("cursor-agent");
    expect(agentLabel(undefined)).toBe("agent");
  });
});
