import { promises as fs } from "node:fs";
import path from "node:path";

/** Read by Codex, Cursor, Gemini CLI (when configured), and most other coding agents. */
export const AGENTS_MD_FILE = "AGENTS.md";

const BLOCK_START = "<!-- teamroom:start -->";
const BLOCK_END = "<!-- teamroom:end -->";

/**
 * Agents without hooks only learn about teamroom from their instructions, so
 * this spells out the whole loop: announce, check, and speak up on overlap.
 */
export const AGENT_INSTRUCTIONS = `## Parallel agents (teamroom)

Other agents may be working in this repo at the same time, in other worktrees or on teammates' machines. The \`teamroom\` MCP server shows what they are changing.

- When you start a task, call \`teamroom_post_note\` with your plan and the files you expect to change.
- Before editing a file, call \`teamroom_check_overlap\` with it. If another session is changing it, tell the user who and why before you continue.
- If a teamroom tool result starts with "Heads up", read it: another session just started changing a file you are working on.
- Without MCP, the same works from the shell: \`teamroom note "<plan>" --files a.ts,b.ts\` and \`teamroom check <files>\`.`;

export type AgentsMdChange = "created" | "added" | "updated" | "unchanged";

/** Adds or refreshes a marked block, leaving the rest of AGENTS.md exactly as it was. */
export async function installAgentsMd(repoRoot: string): Promise<{ file: string; change: AgentsMdChange }> {
  const file = path.join(repoRoot, AGENTS_MD_FILE);
  const block = `${BLOCK_START}\n${AGENT_INSTRUCTIONS}\n${BLOCK_END}`;
  const existing = await readIfExists(file);

  if (existing === undefined) {
    await fs.writeFile(file, `${block}\n`, "utf8");
    return { file, change: "created" };
  }
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) {
    const next = `${existing.slice(0, start)}${block}${existing.slice(end + BLOCK_END.length)}`;
    if (next === existing) return { file, change: "unchanged" };
    await fs.writeFile(file, next, "utf8");
    return { file, change: "updated" };
  }
  await fs.writeFile(file, `${existing.trimEnd()}\n\n${block}\n`, "utf8");
  return { file, change: "added" };
}

export async function agentsMdHasTeamroom(repoRoot: string): Promise<boolean> {
  return (await readIfExists(path.join(repoRoot, AGENTS_MD_FILE)))?.includes(BLOCK_START) ?? false;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
