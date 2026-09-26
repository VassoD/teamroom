import { type ServerType, serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { FileRoomStore } from "../store/file-store.js";
import { createApp } from "./app.js";
import { jsonLogger } from "./logger.js";

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_DATA_DIR = ".teamroom-data";

export interface ServeOptions {
  port: number;
  host: string;
  dataDir: string;
  /** Read the client address from X-Forwarded-For. Only enable behind a proxy you control. */
  trustProxy: boolean;
  /** When set, creating a room requires this key. Joining with an invite link never does. */
  createKey?: string;
}

/** Environment variables `teamroom serve` reads, so hosting platforms can configure it without flags. */
export const SERVE_ENV = {
  port: "PORT",
  host: "HOST",
  dataDir: "TEAMROOM_DATA_DIR",
  trustProxy: "TEAMROOM_TRUST_PROXY",
  createKey: "TEAMROOM_CREATE_KEY",
} as const;

export interface ServeFlags {
  port?: string;
  host?: string;
  dataDir?: string;
  trustProxy?: boolean;
}

export class ServeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeConfigError";
  }
}

const MIN_PORT = 1;
const MAX_PORT = 65_535;
const MIN_CREATE_KEY_LENGTH = 16;
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Flags win over environment variables, which win over defaults. */
export function resolveServeOptions(flags: ServeFlags, env: NodeJS.ProcessEnv = process.env): ServeOptions {
  const rawPort = flags.port ?? env[SERVE_ENV.port] ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new ServeConfigError(`Port must be ${MIN_PORT} to ${MAX_PORT}, got "${rawPort}".`);
  }

  const createKey = env[SERVE_ENV.createKey]?.trim() || undefined;
  if (createKey && createKey.length < MIN_CREATE_KEY_LENGTH) {
    throw new ServeConfigError(`${SERVE_ENV.createKey} must be at least ${MIN_CREATE_KEY_LENGTH} characters.`);
  }

  return {
    port,
    host: flags.host ?? (env[SERVE_ENV.host] || DEFAULT_HOST),
    dataDir: flags.dataDir ?? (env[SERVE_ENV.dataDir] || DEFAULT_DATA_DIR),
    trustProxy: flags.trustProxy ?? TRUTHY.has((env[SERVE_ENV.trustProxy] ?? "").toLowerCase()),
    createKey,
  };
}

/**
 * Proxies append the address they saw to X-Forwarded-For, so with one trusted
 * proxy in front the last entry is the real client. Earlier entries come from
 * the client itself and can be forged to dodge rate limits.
 */
export function clientFromForwardedFor(header: string | undefined): string | undefined {
  const entries = (header ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.at(-1);
}

const EXIT_LISTEN_FAILED = 1;
const PRIVILEGED_PORT_LIMIT = 1024;

/**
 * Turns the errors people actually hit when starting a server into one line
 * that says what to do. Returns undefined for anything unexpected, which is
 * then reported as is.
 */
export function describeListenError(error: unknown, options: Pick<ServeOptions, "host" | "port">): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const address = `${options.host}:${options.port}`;
  if (code === "EADDRINUSE") {
    return `Port ${options.port} is already in use on ${options.host}. Another teamroom server may be running: check with \`curl http://${address}/health\`, or start this one with --port ${options.port + 1}.`;
  }
  if (code === "EACCES") {
    return options.port < PRIVILEGED_PORT_LIMIT
      ? `Port ${options.port} needs administrator rights. Use a port of ${PRIVILEGED_PORT_LIMIT} or higher, such as --port 8787, and put a reverse proxy in front for 80 or 443.`
      : `Not allowed to listen on ${address}. Check that nothing blocks this port, or try another one with --port.`;
  }
  if (code === "EADDRNOTAVAIL") {
    return `${options.host} is not an address of this machine. Use --host 127.0.0.1 for local use or --host 0.0.0.0 to accept connections from other machines.`;
  }
  return undefined;
}

export type ListenErrorHandler = (error: Error) => void;

/** Prints the problem without a stack trace and exits, since a server that cannot listen is useless. */
function exitOnListenError(options: ServeOptions): ListenErrorHandler {
  return (error) => {
    const explained = describeListenError(error, options);
    process.stderr.write(`teamroom: ${explained ?? `could not start the server: ${error.message}`}\n`);
    process.exit(EXIT_LISTEN_FAILED);
  };
}

export function startServer(
  options: ServeOptions,
  onListenError: ListenErrorHandler = exitOnListenError(options)
): ServerType {
  const getClientAddress = (context: Context): string => {
    if (options.trustProxy) {
      const forwarded = clientFromForwardedFor(context.req.header("x-forwarded-for"));
      if (forwarded) return forwarded;
    }
    return getConnInfo(context).remote.address ?? "unknown";
  };

  const app = createApp({
    store: new FileRoomStore(options.dataDir),
    logger: jsonLogger,
    getClientAddress,
    createKey: options.createKey,
  });
  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host }, (info) => {
    jsonLogger("info", "teamroom server listening", {
      url: `http://${info.address}:${info.port}`,
      dataDir: options.dataDir,
      roomCreation: options.createKey ? "requires create key" : "open",
    });
  });

  server.once("error", onListenError);

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
