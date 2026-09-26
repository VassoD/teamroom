/**
 * Coding agents identify themselves in the MCP `initialize` request
 * (`clientInfo.name`). These are the names seen from the agents teamroom
 * knows about; anything else is kept, sanitized, and shown as sent.
 */
const KNOWN_CLIENTS: Record<string, { id: string; label: string }> = {
  "claude-code": { id: "claude-code", label: "Claude Code" },
  "codex-mcp-client": { id: "codex", label: "Codex" },
  codex: { id: "codex", label: "Codex" },
};

export const MAX_AGENT_ID_LENGTH = 40;
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_AGENT_INSTANCE_LENGTH = 64;
export const AGENT_INSTANCE_PATTERN = /^[A-Za-z0-9_-]+$/;

const MINUTE_MS = 60_000;
/** How often a running agent's MCP server says it is still there. */
export const AGENT_HEARTBEAT_INTERVAL_MS = MINUTE_MS;
/** An agent whose last heartbeat is older than this has most likely quit. Allows for a couple of missed beats. */
export const AGENT_PRESENCE_TTL_MS = 3 * MINUTE_MS;

/** Maps a raw MCP client name to the short id stored on activity. Returns undefined when nothing usable is left. */
export function normalizeAgentId(clientName: string | undefined): string | undefined {
  if (!clientName) return undefined;
  const raw = clientName.trim().toLowerCase();
  const known = KNOWN_CLIENTS[raw];
  if (known) return known.id;
  const sanitized = raw
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, MAX_AGENT_ID_LENGTH);
  return sanitized || undefined;
}

/** Human name for an agent id, for the CLI and the dashboard. */
export function agentLabel(agentId: string | undefined): string {
  if (!agentId) return "agent";
  const known = Object.values(KNOWN_CLIENTS).find((client) => client.id === agentId);
  return known?.label ?? agentId;
}
