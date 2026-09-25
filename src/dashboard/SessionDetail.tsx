import { Box, Text } from "ink";
import { formatAge } from "../client/workspace.js";
import { sessionAgentLabel, type HotFile, type SessionSummary } from "./model.js";
import { COLORS, SYMBOLS } from "./theme.js";

const MAX_FILES_SHOWN = 8;

interface SessionDetailProps {
  session?: SessionSummary;
  hotFiles: HotFile[];
  now: Date;
}

export function SessionDetail({ session, hotFiles, now }: SessionDetailProps): React.JSX.Element {
  if (!session) {
    return (
      <Box borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>No one has reported work yet. Run `teamroom hooks install` so commits show up here.</Text>
      </Box>
    );
  }

  const hot = new Set(hotFiles.filter((file) => file.sessions.includes(session.key)).map((file) => file.file));
  const editedBy = new Map(session.edits.map((edit) => [edit.file, edit]));
  const shown = session.files.slice(0, MAX_FILES_SHOWN);
  const hidden = session.files.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text>
        <Text bold>{session.member}</Text>
        <Text dimColor> in {session.session ?? "no session"}{session.branch ? ` on ${session.branch}` : ""}</Text>
      </Text>
      <Text wrap="wrap">{session.doing}</Text>
      {session.files.length === 0 ? (
        <Text dimColor>No pending changes.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((file) => {
            const edit = editedBy.get(file);
            return (
              <Text key={file} wrap="truncate-end">
                <Text color={hot.has(file) ? COLORS.overlap : undefined}>
                  {hot.has(file) ? "! " : "  "}
                  {file}
                </Text>
                {edit && (
                  <Text color={COLORS.agent}>
                    {"  "}
                    {SYMBOLS.agent} {sessionAgentLabel(edit.agent)} edited {formatAge(edit.at, now)}
                  </Text>
                )}
              </Text>
            );
          })}
          {hidden > 0 && <Text dimColor>  and {hidden} more</Text>}
        </Box>
      )}
    </Box>
  );
}
