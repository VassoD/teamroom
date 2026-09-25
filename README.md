# teamroom

Know what your teammates (and their coding agents) are touching before the merge conflict does.

Each checkout shares a snapshot of the files it is changing: commits on its branch that are not merged yet, uncommitted edits and untracked files. Before editing, you or your agent ask "is anyone else in these files?" and get an answer in milliseconds.

Pushed branches are only part of the picture. Teamroom also sees work that is still local, and intent that is not code yet ("about to rename the User model").

## How it works

- **Sessions, not people.** Every checkout (worktree, clone, agent box) is its own session. Two agents of the same developer in two worktrees warn each other.
- **Snapshots replace each other.** A session's newest `wip` snapshot replaces its previous one, so once you merge, revert or switch branches, the warnings go away.
- **Merged commits are ignored.** Commit entries already in the default branch are filtered out on your machine using your local git.
- **Nothing blocks git.** Hooks run in the background and never fail a commit, even when the server is down.

## Requirements

- Node.js 20 or newer
- git

## Setup

Run a server somewhere your team can reach:

```sh
npx teamroom serve --host 0.0.0.0 --port 8787 --data-dir /var/lib/teamroom
```

The server binds to `127.0.0.1` by default. Put it behind HTTPS (a reverse proxy) before exposing it, and pass `--trust-proxy` only when that proxy sets `X-Forwarded-For`.

In your repo, one person creates the room:

```sh
npm install --global teamroom
teamroom create --server https://teamroom.example.com --room-name "Core app" --name ada
teamroom hooks install
```

`create` prints a `teamroom join ...` command. Anyone who has it can join, so share it privately:

```sh
teamroom join --server https://teamroom.example.com --room room_... --invite tri_... --name bo
teamroom hooks install
```

Membership is saved to `.git/teamroom.json` (mode `600`, never committed). Every worktree of the repo shares it.

## Daily use

```sh
teamroom check                    # who else is touching the files you changed
teamroom check src/auth.ts        # or specific files; exits 3 when there is overlap
teamroom note "about to rename User" --files src/user.ts,src/db/schema.ts
teamroom report                   # share your snapshot now (hooks do this on commit, checkout, merge, rebase)
teamroom status                   # members and recent activity
```

## Coding agents (MCP)

`teamroom mcp` runs a stdio MCP server with four tools:

| Tool | What it does |
| --- | --- |
| `teamroom_check_overlap` | Who else is changing these files (default: everything this checkout changed) |
| `teamroom_report_work` | Share this checkout's snapshot, with an optional one-line note |
| `teamroom_post_note` | Announce an intent before acting on it |
| `teamroom_recent_activity` | Recent activity in the room |

Claude Code:

```sh
claude mcp add teamroom -- teamroom mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.teamroom]
command = "teamroom"
args = ["mcp"]
```

Git hooks only fire on commits and checkouts, so an agent's uncommitted edits are invisible until then. To share them as they happen in Claude Code, add a hook to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "teamroom report --source agent --quiet" }]
      }
    ]
  }
}
```

Tell agents to use it, for example in `AGENTS.md` or `CLAUDE.md`:

> Before editing files, call `teamroom_check_overlap` with the files you plan to change. If someone else is in them, tell me before continuing.

## Room admin

```sh
teamroom invite rotate            # owner only; the old invite stops working
teamroom member remove bo         # owner only, or yourself; revokes the token
teamroom token rotate             # replace your own token, for example after a leak
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TEAMROOM_SERVER`, `TEAMROOM_ROOM`, `TEAMROOM_MEMBER`, `TEAMROOM_TOKEN` | Override `.git/teamroom.json`, for CI or shared agent machines |
| `TEAMROOM_SESSION` | Name this checkout's session (default: folder name plus a short hash of its path) |

## Limits

- Activity is kept per room up to the latest 1000 entries. Overlap looks back 72 hours by default (`--since-hours`, up to 90 days).
- A snapshot holds up to 200 files. Larger change sets are truncated and the CLI says so.
- Rate limits are kept in memory per server process. If you run several processes over one data directory, each enforces its own limits.
- Rooms are stored as one JSON file each. That is fine for teams, not for thousands of active rooms.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
