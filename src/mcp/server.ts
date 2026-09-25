import { createInterface } from "node:readline";
import { z } from "zod";
import { describeError } from "../client/errors.js";
import { checkOverlap, formatAge, formatOverlaps, postNote, reportWork, type Workspace } from "../client/workspace.js";
import { agentLabel, normalizeAgentId } from "../core/agents.js";
import { MAX_ACTIVITY_KEPT } from "../core/room.js";
import { MAX_OVERLAP_WINDOW_HOURS, MAX_TEXT_LENGTH } from "../core/schemas.js";

/**
 * A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). Teamroom
 * only needs `tools`, which is small enough that the official SDK and its
 * dependency tree are not worth adding.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "teamroom", version: "0.1.0" };
const DEFAULT_RECENT_LIMIT = 20;

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const toolCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Who is calling, learned from the MCP `initialize` handshake. */
export interface ClientContext {
  agent?: string;
}

interface ToolDefinition<Schema extends z.ZodObject> {
  name: string;
  description: string;
  input: Schema;
  run: (workspace: Workspace, input: z.output<Schema>, client: ClientContext) => Promise<string>;
}

const initializeParamsSchema = z.object({
  clientInfo: z.object({ name: z.string() }).optional(),
});

function defineTool<Schema extends z.ZodObject>(tool: ToolDefinition<Schema>): ToolDefinition<z.ZodObject> {
  return tool as unknown as ToolDefinition<z.ZodObject>;
}

const TOOLS = [
  defineTool({
    name: "teamroom_check_overlap",
    description:
      "Before editing files, ask whether teammates or other agents are changing them right now. " +
      "Leave `files` empty to check everything this checkout has changed.",
    input: z.object({
      files: z.array(z.string()).optional().describe("Paths relative to the repo root, or absolute."),
      sinceHours: z.number().int().positive().max(MAX_OVERLAP_WINDOW_HOURS).optional(),
    }),
    run: async (workspace, input) => {
      const check = await checkOverlap(workspace, input);
      if (check.files.length === 0) return "Nothing to check: no files given and no pending changes.";
      return formatOverlaps(check.overlaps);
    },
  }),
  defineTool({
    name: "teamroom_report_work",
    description:
      "Share which files this checkout is changing, so teammates and their agents see it. " +
      "Call after starting or finishing a chunk of edits. Replaces this session's previous report.",
    input: z.object({
      note: z.string().max(MAX_TEXT_LENGTH).optional().describe("One line on what you are doing and why."),
    }),
    run: async (workspace, input, client) => {
      const { activity, omittedFiles } = await reportWork(workspace, {
        source: "agent",
        agent: client.agent,
        note: input.note,
      });
      const omitted = omittedFiles > 0 ? ` (${omittedFiles} more left out, over the limit)` : "";
      return `Reported ${activity.files.length} file(s)${omitted} as session ${workspace.session}.`;
    },
  }),
  defineTool({
    name: "teamroom_post_note",
    description:
      "Announce an intent before acting on it, such as 'about to rename the User model'. " +
      "Mention the files it will affect so overlap checks pick it up.",
    input: z.object({
      text: z.string().min(1).max(MAX_TEXT_LENGTH),
      files: z.array(z.string()).optional(),
    }),
    run: async (workspace, input, client) => {
      await postNote(workspace, { text: input.text, files: input.files, source: "agent", agent: client.agent });
      return "Note posted to the room.";
    },
  }),
  defineTool({
    name: "teamroom_recent_activity",
    description: "List what the team has been doing recently, newest first.",
    input: z.object({
      limit: z.number().int().min(1).max(MAX_ACTIVITY_KEPT).optional(),
    }),
    run: async (workspace, input) => {
      const { room } = await workspace.client.getRoom(workspace.config.roomId, input.limit ?? DEFAULT_RECENT_LIMIT);
      if (room.activity.length === 0) return "No activity yet.";
      return [...room.activity]
        .reverse()
        .map((entry) => {
          const files = entry.files.length > 0 ? ` [${entry.files.length} file(s)]` : "";
          const via = entry.agent ? ` via ${agentLabel(entry.agent)}` : "";
          return `- ${entry.member}${via} (${entry.kind}, ${formatAge(entry.createdAt)}): ${entry.text}${files}`;
        })
        .join("\n");
    },
  }),
];

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export interface McpHandler {
  handle(message: string): Promise<JsonRpcResponse | undefined>;
}

/**
 * The workspace is opened lazily so the server still starts, and can explain
 * the problem through a tool result, when the repo has not joined a room yet.
 */
export function createMcpHandler(getWorkspace: () => Promise<Workspace>): McpHandler {
  const client: ClientContext = {};
  return {
    async handle(message) {
      let raw: unknown;
      try {
        raw = JSON.parse(message);
      } catch {
        return errorResponse(null, JSON_RPC_PARSE_ERROR, "Message is not valid JSON.");
      }
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) return errorResponse(null, JSON_RPC_INVALID_REQUEST, "Not a JSON-RPC 2.0 request.");

      const { id, method, params } = parsed.data;
      // Requests without an id are notifications and never get a response.
      if (id === undefined) return undefined;

      switch (method) {
        case "initialize": {
          const init = initializeParamsSchema.safeParse(params);
          client.agent = normalizeAgentId(init.success ? init.data.clientInfo?.name : undefined);
          return result(id, {
            protocolVersion: negotiateVersion(params),
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
        }
        case "ping":
          return result(id, {});
        case "tools/list":
          return result(id, {
            tools: TOOLS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: z.toJSONSchema(tool.input),
            })),
          });
        case "tools/call":
          return callTool(id, params, getWorkspace, client);
        default:
          return errorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method ${method} is not supported.`);
      }
    },
  };
}

async function callTool(
  id: string | number,
  params: unknown,
  getWorkspace: () => Promise<Workspace>,
  client: ClientContext
): Promise<JsonRpcResponse> {
  const call = toolCallParamsSchema.safeParse(params);
  if (!call.success) return errorResponse(id, JSON_RPC_INVALID_PARAMS, "tools/call needs a tool name.");
  const tool = TOOLS.find((candidate) => candidate.name === call.data.name);
  if (!tool) return errorResponse(id, JSON_RPC_INVALID_PARAMS, `Unknown tool ${call.data.name}.`);

  const input = tool.input.safeParse(call.data.arguments ?? {});
  if (!input.success) {
    const problems = input.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
    return result(id, toolError(`Invalid arguments. ${problems.join("; ")}`));
  }

  try {
    const workspace = await getWorkspace();
    const text = await tool.run(workspace, input.data, client);
    return result(id, { content: [{ type: "text", text }] } satisfies ToolResult);
  } catch (error) {
    // Tool failures go back to the model as results, so it can tell the user or carry on.
    return result(id, toolError(describeError(error)));
  }
}

function negotiateVersion(params: unknown): string {
  const requested = z.object({ protocolVersion: z.string() }).safeParse(params);
  if (requested.success && SUPPORTED_PROTOCOL_VERSIONS.includes(requested.data.protocolVersion)) {
    return requested.data.protocolVersion;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0] ?? "2025-06-18";
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function result(id: string | number, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Stdout carries protocol messages only, so diagnostics go to stderr. */
export async function runMcpServer(getWorkspace: () => Promise<Workspace>): Promise<void> {
  let cached: Promise<Workspace> | undefined;
  const handler = createMcpHandler(() => {
    cached ??= getWorkspace().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const response = await handler.handle(line);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stderr.write(`teamroom mcp: ${describeError(error)}\n`);
    }
  }
}
