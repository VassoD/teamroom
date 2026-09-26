import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { Header } from "./Header.js";
import { HotFiles } from "./HotFiles.js";
import { MemberList } from "./MemberList.js";
import { buildDashboard, flattenSessions } from "./model.js";
import { RecentActivity } from "./RecentActivity.js";
import { SessionDetail } from "./SessionDetail.js";
import { StatusBar } from "./StatusBar.js";
import { type FetchRoom, useRoomPolling } from "./useRoomPolling.js";

const CLOCK_TICK_MS = 1_000;

interface DashboardProps {
  fetchRoom: FetchRoom;
  pollIntervalMs?: number;
  /** Frozen time for tests and screenshots. */
  fixedNow?: Date;
  isIgnored?: (file: string) => boolean;
}

export function DashboardApp({ fetchRoom, pollIntervalMs, fixedNow, isIgnored }: DashboardProps): React.JSX.Element {
  const { exit } = useApp();
  const { snapshot, error, lastUpdated, refresh } = useRoomPolling(fetchRoom, pollIntervalMs);
  const [selectedKey, setSelectedKey] = useState<string>();
  const now = useClock(fixedNow);
  // Rebuilt on every clock tick too, so sessions turn idle on time between polls.
  const dashboard = useMemo(
    () => (snapshot ? buildDashboard(snapshot.room, snapshot.me, now, isIgnored) : undefined),
    [snapshot, now, isIgnored]
  );

  const sessions = useMemo(() => (dashboard ? flattenSessions(dashboard) : []), [dashboard]);
  const hotSessionKeys = useMemo(
    () => new Set(dashboard?.hotFiles.flatMap((hotFile) => hotFile.sessions) ?? []),
    [dashboard]
  );
  const selectedIndex = Math.max(
    0,
    sessions.findIndex((session) => session.key === selectedKey)
  );
  const selected = sessions[selectedIndex];

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
    if (input === "r") refresh();
    if (sessions.length === 0) return;
    if (key.downArrow || input === "j") setSelectedKey(sessions[(selectedIndex + 1) % sessions.length]?.key);
    if (key.upArrow || input === "k") {
      setSelectedKey(sessions[(selectedIndex - 1 + sessions.length) % sessions.length]?.key);
    }
  });

  if (!dashboard) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>{error ? `Can't read the room: ${error}` : "Loading the room…"}</Text>
        <Text dimColor>q quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header dashboard={dashboard} />
      <HotFiles hotFiles={dashboard.hotFiles} />
      <MemberList dashboard={dashboard} selectedKey={selected?.key} hotSessionKeys={hotSessionKeys} now={now} />
      <SessionDetail session={selected} hotFiles={dashboard.hotFiles} now={now} />
      <RecentActivity activity={dashboard.recent} now={now} />
      <StatusBar lastUpdated={lastUpdated} error={error} now={now} />
    </Box>
  );
}

/** Re-renders every second so "2m ago" labels stay true between polls. */
function useClock(fixedNow?: Date): Date {
  const [now, setNow] = useState(() => fixedNow ?? new Date());
  useEffect(() => {
    if (fixedNow) return;
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [fixedNow]);
  return now;
}
