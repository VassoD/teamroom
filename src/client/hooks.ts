import { promises as fs } from "node:fs";
import path from "node:path";

/** Every point where a checkout's pending changes shift: new commit, branch switch, pull or merge. */
export const HOOK_NAMES = ["post-commit", "post-checkout", "post-merge", "post-rewrite"] as const;

const BLOCK_START = "# >>> teamroom >>>";
const BLOCK_END = "# <<< teamroom <<<";
const SHEBANG = "#!/bin/sh";
const EXECUTABLE_MODE = 0o755;

/** How the hook should launch teamroom when the CLI that installed it still exists on disk. */
export interface CliLocation {
  node: string;
  script: string;
}

/**
 * Runs in the background and never fails the git command: a teammate without
 * teamroom installed, or an unreachable server, must not block their commits.
 * Prefers the exact CLI that installed the hook, since a local or npx install
 * is not on PATH, and falls back to a global `teamroom`.
 */
export function hookBlock(cli?: CliLocation): string {
  const report = "report --source hook --quiet";
  const pinned = cli
    ? [
        `TEAMROOM_NODE=${shellQuote(cli.node)}`,
        `TEAMROOM_SCRIPT=${shellQuote(cli.script)}`,
        'if [ -x "$TEAMROOM_NODE" ] && [ -f "$TEAMROOM_SCRIPT" ]; then',
        `  ("$TEAMROOM_NODE" "$TEAMROOM_SCRIPT" ${report} >/dev/null 2>&1 &)`,
        "elif command -v teamroom >/dev/null 2>&1; then",
      ]
    : ["if command -v teamroom >/dev/null 2>&1; then"];
  return [BLOCK_START, ...pinned, `  (teamroom ${report} >/dev/null 2>&1 &)`, "fi", BLOCK_END].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type HookChange = "installed" | "updated" | "unchanged" | "removed" | "absent";

/** Appends a marked block, so hooks the repo already has keep working. Re-running refreshes the block. */
export async function installHooks(hooksDir: string, cli?: CliLocation): Promise<Record<string, HookChange>> {
  const block = hookBlock(cli);
  await fs.mkdir(hooksDir, { recursive: true });
  const changes: Record<string, HookChange> = {};
  for (const name of HOOK_NAMES) {
    const file = path.join(hooksDir, name);
    const existing = await readIfExists(file);
    const hadBlock = existing?.includes(BLOCK_START) ?? false;
    const base = existing === undefined ? SHEBANG : removeBlock(existing).trimEnd() || SHEBANG;
    const content = base === SHEBANG ? `${SHEBANG}\n${block}\n` : `${base}\n\n${block}\n`;
    if (content === existing) {
      changes[name] = "unchanged";
      continue;
    }
    await fs.writeFile(file, content, "utf8");
    await fs.chmod(file, EXECUTABLE_MODE);
    changes[name] = hadBlock ? "updated" : "installed";
  }
  return changes;
}

/** Removes only the teamroom block, and the file too when nothing else is left in it. */
export async function uninstallHooks(hooksDir: string): Promise<Record<string, HookChange>> {
  const changes: Record<string, HookChange> = {};
  for (const name of HOOK_NAMES) {
    const file = path.join(hooksDir, name);
    const existing = await readIfExists(file);
    if (existing === undefined || !existing.includes(BLOCK_START)) {
      changes[name] = "absent";
      continue;
    }
    const remaining = removeBlock(existing);
    if (remaining.trim() === "" || remaining.trim() === SHEBANG) {
      await fs.rm(file);
    } else {
      await fs.writeFile(file, remaining, "utf8");
    }
    changes[name] = "removed";
  }
  return changes;
}

export function removeBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) return content;
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + BLOCK_END.length).trim();
  return [before, after].filter(Boolean).join("\n\n") + "\n";
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
