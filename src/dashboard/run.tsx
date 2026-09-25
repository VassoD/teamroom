import { render } from "ink";
import { UsageError } from "../client/errors.js";
import type { Workspace } from "../client/workspace.js";
import { DashboardApp } from "./Dashboard.js";
import type { FetchRoom } from "./useRoomPolling.js";

/** Enough history to find every session active in the last few days without a heavy poll. */
const DASHBOARD_ACTIVITY_LIMIT = 300;

export async function runDashboard(workspace: Workspace, pollIntervalMs?: number): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new UsageError("`teamroom watch` needs an interactive terminal. Use `teamroom status` in scripts.");
  }
  const fetchRoom: FetchRoom = () => workspace.client.getRoom(workspace.config.roomId, DASHBOARD_ACTIVITY_LIMIT);
  const app = render(<DashboardApp fetchRoom={fetchRoom} pollIntervalMs={pollIntervalMs} />);
  await app.waitUntilExit();
}
