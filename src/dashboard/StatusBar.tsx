import { Box, Text } from "ink";
import { formatAge } from "../client/workspace.js";
import { COLORS } from "./theme.js";

interface StatusBarProps {
  lastUpdated?: Date;
  error?: string;
  now: Date;
}

export function StatusBar({ lastUpdated, error, now }: StatusBarProps): React.JSX.Element {
  return (
    <Box justifyContent="space-between" paddingX={1} marginTop={1}>
      <Text dimColor>↑↓ select   r refresh   q quit</Text>
      {error ? (
        <Text color={COLORS.error} wrap="truncate-end">
          Can't reach the room: {error} Showing the last update{lastUpdated ? ` from ${formatAge(lastUpdated.toISOString(), now)}` : ""}.
        </Text>
      ) : (
        <Text dimColor>{lastUpdated ? `Updated ${formatAge(lastUpdated.toISOString(), now)}` : "Connecting…"}</Text>
      )}
    </Box>
  );
}
