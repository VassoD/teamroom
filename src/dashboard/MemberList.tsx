import { Box, Text } from "ink";
import { formatAge } from "../client/workspace.js";
import { type Dashboard, type MemberSummary, type SessionSummary, sessionAgentLabel } from "./model.js";
import { COLORS, SYMBOLS } from "./theme.js";

interface MemberListProps {
  dashboard: Dashboard;
  selectedKey?: string;
  hotSessionKeys: Set<string>;
  now: Date;
}

export function MemberList({ dashboard, selectedKey, hotSessionKeys, now }: MemberListProps): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {dashboard.members.map((member, index) => (
        <Box key={member.name} flexDirection="column" marginBottom={index === dashboard.members.length - 1 ? 0 : 1}>
          <Text>
            <Text bold>{member.name}</Text>
            {member.isMe && <Text dimColor> (you)</Text>}
            {member.role === "owner" && <Text dimColor> owner</Text>}
            {member.activeAgents > 0 && (
              <Text color={COLORS.agent}>
                {"  "}
                {describeMemberAgents(member)}
              </Text>
            )}
          </Text>
          {member.sessions.length === 0 ? (
            <Text dimColor>{"  No activity in the last 3 days."}</Text>
          ) : (
            member.sessions.map((session) => (
              <SessionRow
                key={session.key}
                session={session}
                selected={session.key === selectedKey}
                hot={hotSessionKeys.has(session.key)}
                now={now}
              />
            ))
          )}
        </Box>
      ))}
    </Box>
  );
}

/** "◆ 2 Claude Code  ◆ Codex": which agents this person is running right now. */
function describeMemberAgents(member: MemberSummary): string {
  const counts = new Map<string, number>();
  for (const agent of member.sessions.flatMap((session) => session.activeAgents)) {
    const label = sessionAgentLabel(agent);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => `${SYMBOLS.agent} ${count > 1 ? `${count} ` : ""}${label}`)
    .join("  ");
}

function describeSessionAgents(session: SessionSummary): string {
  const [latest, ...others] = session.agents;
  if (!latest) return "";
  return `${SYMBOLS.agent} ${sessionAgentLabel(latest)}${others.length > 0 ? ` +${others.length}` : ""}`;
}

interface SessionRowProps {
  session: SessionSummary;
  selected: boolean;
  hot: boolean;
  now: Date;
}

function SessionRow({ session, selected, hot, now }: SessionRowProps): React.JSX.Element {
  const isActive = session.state === "active";
  return (
    <Box>
      <Text color={COLORS.accent}>{selected ? `${SYMBOLS.selected} ` : "  "}</Text>
      <Box width={2} flexShrink={0}>
        <Text color={isActive ? COLORS.active : undefined} dimColor={!isActive}>
          {isActive ? SYMBOLS.active : SYMBOLS.idle}
        </Text>
      </Box>
      <Box width={20} flexShrink={0}>
        <Text wrap="truncate-end" inverse={selected}>
          {session.session ?? "no session"}
        </Text>
      </Box>
      <Box width={18} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {session.branch ?? ""}
        </Text>
      </Box>
      <Box width={16} flexShrink={0}>
        {session.hasAgent ? (
          <Text color={COLORS.agent} wrap="truncate-end">
            {describeSessionAgents(session)}
          </Text>
        ) : (
          <Text dimColor>person</Text>
        )}
      </Box>
      <Box width={10} flexShrink={0}>
        <Text dimColor>{formatAge(session.lastSeen, now)}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="truncate-end" color={hot ? COLORS.overlap : undefined}>
          {session.doing}
        </Text>
      </Box>
    </Box>
  );
}
