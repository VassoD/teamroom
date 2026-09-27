# Setup

What `teamroom init` installs, how to connect agents it does not configure for you, and how to remove it.

## What `init` sets up

| Piece | Works with | What it does |
| --- | --- | --- |
| Git hooks | everything | After each commit, checkout, merge and rebase, shares the files this checkout changed compared with `main`, including uncommitted and untracked ones. Runs in the background and never fails a commit. |
| MCP server | any MCP agent | Runs for as long as the agent does. Shares the checkout's changes every few seconds without being asked, and puts a **heads-up** in front of the next tool result when another session starts changing a file this one is changing. Also gives the agent tools to announce a plan and check before editing. |
| `AGENTS.md` block | Codex, Cursor, and most agents | Tells the agent to announce its plan with `teamroom_post_note` and to call `teamroom_check_overlap` before editing. |
| Agent hooks | agents with a hook system (see below) | See the list below. |

### Agent hooks

MCP only answers when an agent asks, so it cannot stop an edit. An agent's own hooks can. For every agent that has them, teamroom adds the same three:

- **Session start:** briefs each new session on what the others are changing.
- **Before an edit:** pauses the edit once when another session is in that file, with who and why. The retry goes through.
- **After an edit:** shares the edited file the moment it changes.

Hooks are only written for agents the repo uses, with the same rule as the MCP config. New worktrees get them automatically.

| Agent | Hooks | Where | Notes |
| --- | --- | --- | --- |
| Claude Code | yes | `.claude/settings.local.json` (personal, not committed) | Always installed. teamroom's own tools are pre-approved so they run without a prompt. |
| Gemini CLI | yes | `.gemini/settings.json` (committed) | When the repo has a `.gemini` folder or with `--agents gemini`. Calls `teamroom` on your PATH and does nothing for a teammate who has not installed it. |
| Cursor, Codex, others | not yet | | Warned through the MCP heads-up, which reaches them the next time they call a teamroom tool. |

`teamroom doctor` shows which agents in the repo have hooks and which rely on MCP only.

## Connecting other agents

MCP config is written for Claude Code (`.mcp.json`) always, and for Cursor (`.cursor/mcp.json`), Gemini CLI (`.gemini/settings.json`) and Codex (`.codex/config.toml`) when the repo already has that folder. Force one with `teamroom init --agents codex,gemini`.

For anything else, add a stdio MCP server with command `teamroom` and args `["mcp"]`. Examples:

```toml
# Codex, ~/.codex/config.toml (a project .codex/config.toml only loads in trusted projects)
[mcp_servers.teamroom]
command = "teamroom"
args = ["mcp"]

# Mistral Vibe, ~/.vibe/config.toml
[[mcp_servers]]
name = "teamroom"
transport = "stdio"
command = "teamroom"
args = ["mcp"]
```

## MCP tools

| Tool | What it does |
| --- | --- |
| `teamroom_post_note` | Announce a plan and the files it will touch, before editing |
| `teamroom_check_overlap` | Who else is changing these files (default: everything this checkout changed) |
| `teamroom_report_work` | Share this checkout's changes now, with an optional one-line note |
| `teamroom_recent_activity` | What other sessions and agents did recently |

Activity is labeled with the agent that sent it, from the name it gives in the MCP handshake.

## Uninstall

```sh
teamroom leave              # team mode only: leave the room first
teamroom hooks uninstall    # removes the git hooks and every agent's hooks
```

Then remove what `init` wrote to tracked files: the `teamroom` entry in `.mcp.json` (and in `.cursor/mcp.json`, `.gemini/settings.json` or `.codex/config.toml` if it added one), and the block between `<!-- teamroom:start -->` and `<!-- teamroom:end -->` in `AGENTS.md`. Delete `.git/teamroom/` to drop the local room.
