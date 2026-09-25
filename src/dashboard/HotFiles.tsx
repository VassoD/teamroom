import { Box, Text } from "ink";
import type { HotFile } from "./model.js";
import { COLORS } from "./theme.js";

const MAX_HOT_FILES_SHOWN = 5;

interface HotFilesProps {
  hotFiles: HotFile[];
}

export function HotFiles({ hotFiles }: HotFilesProps): React.JSX.Element | null {
  if (hotFiles.length === 0) return null;
  const shown = hotFiles.slice(0, MAX_HOT_FILES_SHOWN);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.overlap} paddingX={1}>
      <Text bold color={COLORS.overlap}>
        {hotFiles.length} file{hotFiles.length === 1 ? "" : "s"} being changed in more than one place
      </Text>
      {shown.map((hotFile) => (
        <Text key={hotFile.file} wrap="truncate-end">
          <Text color={COLORS.overlap}>{hotFile.file}</Text>
          <Text dimColor>
            {"  "}
            {hotFile.members.join(", ")}
          </Text>
          {hotFile.members.length < hotFile.sessions.length && (
            <Text dimColor> ({hotFile.sessions.length} sessions)</Text>
          )}
        </Text>
      ))}
      {hotFiles.length > shown.length && <Text dimColor>and {hotFiles.length - shown.length} more</Text>}
    </Box>
  );
}
