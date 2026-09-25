import { Box, Text } from "ink";
import type { Activity } from "../core/types.js";
import { agentLabel } from "../core/agents.js";
import { formatAge } from "../client/workspace.js";
import { COLORS, SYMBOLS } from "./theme.js";

interface RecentActivityProps {
  activity: Activity[];
  now: Date;
}

export function RecentActivity({ activity, now }: RecentActivityProps): React.JSX.Element | null {
  if (activity.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text dimColor>Recent</Text>
      {activity.map((entry) => (
        <Box key={entry.id}>
          <Box width={10} flexShrink={0}>
            <Text dimColor>{formatAge(entry.createdAt, now)}</Text>
          </Box>
          <Box width={28} flexShrink={0}>
            <Text wrap="truncate-end">
              {entry.source === "agent" ? <Text color={COLORS.agent}>{SYMBOLS.agent} </Text> : "  "}
              {entry.member}
              {entry.source === "agent" && <Text color={COLORS.agent}> {agentLabel(entry.agent)}</Text>}
            </Text>
          </Box>
          <Box width={8} flexShrink={0}>
            <Text dimColor>{entry.kind}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="truncate-end">{entry.text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
