import { promises as fs } from "node:fs";
import path from "node:path";
import { type AgentHookEvent, decideHook, type HookDecision } from "./agent-events.js";
import { claudeHooks } from "./claude-hook.js";
import { geminiHooks } from "./gemini-hook.js";
import type { CliLocation } from "./hooks.js";
import { type AgentId, MCP_TARGETS } from "./mcp-config.js";
import type { Workspace } from "./workspace.js";

/**
 * MCP lets an agent ask teamroom things, but only the agent's own hooks let
 * teamroom step in before an edit. Every agent names and shapes those hooks
 * differently, so each one gets a small adapter, and everything else in
 * teamroom only talks to the list below. Supporting a new agent means adding
 * one adapter here.
 */
export interface AgentHookAdapter {
  agent: AgentId;
  label: string;
  /** The hidden `teamroom` subcommand the installed hook runs. */
  command: string;
  /** Whether this repo uses the agent, so hooks are only written for agents people run here. */
  usedIn(repoRoot: string, forced: readonly AgentId[]): Promise<boolean>;
  install(repoRoot: string, cli?: CliLocation): Promise<AgentHookChangeResult>;
  uninstall(repoRoot: string): Promise<AgentHookChangeResult>;
  /** Hook events this agent should have but does not. Empty when fully installed. */
  missingEvents(repoRoot: string): Promise<string[]>;
  /** Returns null for payloads that are none of teamroom's business. */
  parse(rawPayload: string): AgentHookEvent | null;
  /** What the hook prints on stdout. An empty string means "carry on". */
  format(decision: HookDecision): string;
}

export type AgentHookChange = "installed" | "unchanged" | "removed" | "absent";

export interface AgentHookChangeResult {
  change: AgentHookChange;
  file: string;
}

export interface AgentHookResult extends AgentHookChangeResult {
  agent: AgentId;
  label: string;
}

export const AGENT_HOOKS: readonly AgentHookAdapter[] = [claudeHooks, geminiHooks];

/**
 * Marks, in the shared git dir, that this repo wants agent hooks, so worktrees
 * created later get the ones that live in uncommitted files. Named after the
 * first agent that needed it, and kept so existing repos stay opted in.
 */
const HOOKS_WANTED_FILE = "claude-hooks-wanted";

/** Installs the hooks of every agent this repo uses. */
export async function installAgentHooks(
  repoRoot: string,
  options: { cli?: CliLocation; forced?: readonly AgentId[] } = {}
): Promise<AgentHookResult[]> {
  const results: AgentHookResult[] = [];
  for (const adapter of AGENT_HOOKS) {
    if (!(await adapter.usedIn(repoRoot, options.forced ?? []))) continue;
    results.push({ agent: adapter.agent, label: adapter.label, ...(await adapter.install(repoRoot, options.cli)) });
  }
  return results;
}

/** Removes teamroom's hooks from every agent, used or not, and reports only the ones it found. */
export async function uninstallAgentHooks(repoRoot: string): Promise<AgentHookResult[]> {
  const results: AgentHookResult[] = [];
  for (const adapter of AGENT_HOOKS) {
    const result = await adapter.uninstall(repoRoot);
    if (result.change !== "absent") results.push({ agent: adapter.agent, label: adapter.label, ...result });
  }
  return results;
}

export interface AgentHookStatus {
  label: string;
  missingEvents: string[];
}

/** For every agent this repo uses: whether teamroom can pause its edits, and what is missing. */
export async function agentHookStatus(repoRoot: string): Promise<{
  withHooks: AgentHookStatus[];
  /** Agents the repo is configured for that have no teamroom hooks, so they only hear about overlap through MCP. */
  mcpOnly: string[];
}> {
  const withHooks: AgentHookStatus[] = [];
  for (const adapter of AGENT_HOOKS) {
    if (!(await adapter.usedIn(repoRoot, []))) continue;
    withHooks.push({ label: adapter.label, missingEvents: await adapter.missingEvents(repoRoot) });
  }
  const covered = new Set(AGENT_HOOKS.map((adapter) => adapter.agent));
  const mcpOnly: string[] = [];
  for (const target of MCP_TARGETS) {
    if (covered.has(target.agent) || !target.marker) continue;
    if (await pathExists(path.join(repoRoot, target.marker))) mcpOnly.push(target.label);
  }
  return { withHooks, mcpOnly };
}

export async function rememberAgentHooksWanted(storeDir: string, wanted: boolean): Promise<void> {
  const file = path.join(storeDir, HOOKS_WANTED_FILE);
  if (!wanted) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(file, "", "utf8");
}

export async function agentHooksWanted(storeDir: string): Promise<boolean> {
  return pathExists(path.join(storeDir, HOOKS_WANTED_FILE));
}

/** Installs whatever hooks this checkout is missing, for the agents it uses. Returns whether it changed anything. */
export async function adoptAgentHooks(repoRoot: string, cli?: CliLocation): Promise<boolean> {
  let changed = false;
  for (const adapter of AGENT_HOOKS) {
    if (!(await adapter.usedIn(repoRoot, []))) continue;
    if ((await adapter.missingEvents(repoRoot)).length === 0) continue;
    await adapter.install(repoRoot, cli);
    changed = true;
  }
  return changed;
}

/** Decides what to do about one hook event and puts the answer in the agent's own output format. */
export async function handleAgentHook(
  adapter: AgentHookAdapter,
  event: AgentHookEvent,
  workspace: Workspace
): Promise<string> {
  return adapter.format(await decideHook(event, workspace));
}

/** The agent whose hook runs the given `teamroom` subcommand. */
export function adapterForCommand(command: string): AgentHookAdapter | undefined {
  return AGENT_HOOKS.find((adapter) => adapter.command === command);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
