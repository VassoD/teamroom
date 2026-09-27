import { Box, Text } from "ink";
import { agentLabel } from "../core/agents.js";
import type { Dashboard } from "./model.js";
import { COLORS } from "./theme.js";

interface HeaderProps {
  dashboard: Dashboard;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A breakdown that only says "1 agent" adds nothing, so it shows once an agent has a real name. */
function hasNamedAgents(byLabel: Record<string, number>): boolean {
  return Object.keys(byLabel).some((label) => label !== agentLabel(undefined));
}

function describeBreakdown(byLabel: Record<string, number>): string {
  return Object.entries(byLabel)
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
}

export function Header({ dashboard }: HeaderProps): React.JSX.Element {
  const { totals } = dashboard;
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text bold color={COLORS.accent}>
          teamroom
        </Text>
        <Text dimColor>
          {"  "}
          {dashboard.roomName}
        </Text>
      </Text>
      <Text>
        <Text>
          {totals.members} {totals.members === 1 ? "person" : "people"}
        </Text>
        <Text dimColor>{"   "}</Text>
        <Text color={COLORS.active}>{totals.activeSessions} working</Text>
        <Text dimColor>{"   "}</Text>
        <Text color={COLORS.agent}>{plural(totals.activeAgents, "agent")} open</Text>
        {hasNamedAgents(totals.activeAgentsByLabel) && (
          <Text dimColor> ({describeBreakdown(totals.activeAgentsByLabel)})</Text>
        )}
      </Text>
    </Box>
  );
}
