import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomView } from "../core/types.js";
import { describeError } from "../client/errors.js";

export const DEFAULT_POLL_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;

export type FetchRoom = (signal: AbortSignal) => Promise<RoomSnapshot>;

export interface RoomSnapshot {
  room: RoomView;
  me: string;
}

export interface RoomPollingState {
  snapshot?: RoomSnapshot;
  error?: string;
  lastUpdated?: Date;
  refresh: () => void;
}

/**
 * Polls the room. Failures keep the last good snapshot
 * on screen and back off exponentially, so a flaky server is not hammered.
 */
export function useRoomPolling(fetchRoom: FetchRoom, intervalMs = DEFAULT_POLL_INTERVAL_MS): RoomPollingState {
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [refreshCount, setRefreshCount] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await fetchRoom(controller.signal);
        if (controller.signal.aborted) return;
        failures.current = 0;
        setSnapshot(next);
        setLastUpdated(new Date());
        setError(undefined);
      } catch (caught) {
        if (controller.signal.aborted) return;
        failures.current += 1;
        setError(describeError(caught));
      }
      const delay = Math.min(intervalMs * 2 ** failures.current, MAX_BACKOFF_MS);
      timer = setTimeout(() => void poll(), delay);
    };

    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [fetchRoom, intervalMs, refreshCount]);

  const refresh = useCallback(() => setRefreshCount((count) => count + 1), []);
  return { snapshot, error, lastUpdated, refresh };
}
