import { describeError } from "../client/errors.js";
import type { WorkingState } from "../client/git.js";
import { checkOverlap, formatOverlaps, reportWork, type Workspace } from "../client/workspace.js";
import type { FileOverlap } from "../core/types.js";

export const AUTO_REPORT_INTERVAL_MS = 10_000;

export interface AgentIdentity {
  agent?: string;
}

/**
 * Agents launch `teamroom mcp` once and keep it running for the whole session,
 * whatever the agent: Claude Code, Codex, Gemini CLI, Mistral Vibe, Cursor.
 * That makes the MCP server the one place that works for all of them without
 * agent-specific hooks. Every few seconds it:
 * - shares this checkout's changes when they differ from the last report, so
 *   other sessions see edits as they happen, not only at the next commit;
 * - notices when another session starts changing a file this checkout is
 *   changing, and queues a "Heads up" that the next tool result carries.
 */
export class AutoReporter {
  private lastReported: string | undefined;
  private readonly warned = new Map<string, string>();
  private pendingOverlaps: FileOverlap[] = [];
  private running = false;
  private failureLogged = false;

  constructor(
    private readonly getWorkspace: () => Promise<Workspace>,
    private readonly identity: AgentIdentity,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  start(intervalMs = AUTO_REPORT_INTERVAL_MS): () => void {
    const timer = setInterval(() => void this.tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const workspace = await this.getWorkspace();
      const state = await workspace.git.workingState();
      await this.reportIfChanged(workspace, state);
      await this.collectNewOverlaps(workspace, state);
      this.failureLogged = false;
    } catch (error) {
      // A down server or a repo mid-rebase is normal. Say so once, not every tick.
      if (!this.failureLogged) this.log(`auto-report paused: ${describeError(error)}`);
      this.failureLogged = true;
    } finally {
      this.running = false;
    }
  }

  /** Returns the queued warning once, then forgets it. */
  takeHeadsUp(): string | undefined {
    if (this.pendingOverlaps.length === 0) return undefined;
    const text = [
      "Heads up: another session just started changing files you are changing. Tell the user before you go further.",
      formatOverlaps(this.pendingOverlaps),
    ].join("\n");
    this.pendingOverlaps = [];
    return text;
  }

  private async reportIfChanged(workspace: Workspace, state: WorkingState): Promise<void> {
    const fingerprint = [state.branch ?? "", ...state.files].join("\u0000");
    if (fingerprint === this.lastReported) return;
    await reportWork(workspace, { source: "agent", agent: this.identity.agent, state });
    this.lastReported = fingerprint;
  }

  private async collectNewOverlaps(workspace: Workspace, state: WorkingState): Promise<void> {
    const { overlaps } = await checkOverlap(workspace, { state });
    for (const overlap of overlaps) {
      const signature = overlap.touchedBy.map((touch) => `${touch.member}/${touch.session ?? ""}@${touch.at}`).join();
      if (this.warned.get(overlap.file) === signature) continue;
      this.warned.set(overlap.file, signature);
      this.pendingOverlaps = [...this.pendingOverlaps.filter((queued) => queued.file !== overlap.file), overlap];
    }
  }
}
