import { serve, type ServerType } from "@hono/node-server";
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
}

export function startServer(options: ServeOptions): ServerType {
  const getClientAddress = (context: Context): string => {
    if (options.trustProxy) {
      const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return getConnInfo(context).remote.address ?? "unknown";
  };

  const app = createApp({ store: new FileRoomStore(options.dataDir), logger: jsonLogger, getClientAddress });
  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host }, (info) => {
    jsonLogger("info", "teamroom server listening", {
      url: `http://${info.address}:${info.port}`,
      dataDir: options.dataDir,
    });
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
