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

- Node.js 22 or newer (24 LTS recommended)
- git

## Setup

Run a server somewhere your team can reach:

```sh
npx teamroom serve --host 0.0.0.0 --port 8787 --data-dir /var/lib/teamroom
```

The server binds to `127.0.0.1` by default. Put it behind HTTPS (a reverse proxy) before exposing it, and pass `--trust-proxy` only when that proxy sets `X-Forwarded-For`.

To host it for a team (Fly.io, Docker, the environment variables it reads, and how to restrict who can create rooms), see [docs/hosting.md](docs/hosting.md).

In your repo, one person creates the room:

```sh
npm install --global teamroom
teamroom create --server https://teamroom.example.com
git add .mcp.json && git commit -m "chore: add teamroom for coding agents"
```

`create` names the room after the repo folder and you after your git `user.name` (override with `--room-name` and `--name`). It also installs the git hooks and writes `.mcp.json` so Claude Code picks up the tools. It prints an invite link:

```
https://teamroom.example.com/join/room_...#tri_...
```

Anyone who has the link can join, so share it privately. Teammates run, inside their clone:

```sh
teamroom join 'https://teamroom.example.com/join/room_...#tri_...'
```

That's it. If something doesn't work, `teamroom doctor` checks every piece (repo, hooks, agent config, server, token) and prints the command that fixes each problem.

Membership is saved to `.git/teamroom.json` (mode `600`, never committed). Every worktree of the repo shares it. The invite code sits after the `#`, which browsers never send, so it stays out of server logs even if someone opens the link.

To try it alone first, run `teamroom serve` in one terminal and `teamroom create --server localhost:8787` in your repo.

## Daily use

```sh
teamroom check                    # who else is touching the files you changed
teamroom check src/auth.ts        # or specific files; exits 3 when there is overlap
teamroom note "about to rename User" --files src/user.ts,src/db/schema.ts
teamroom report                   # share your snapshot now (hooks do this on commit, checkout, merge, rebase)
teamroom status                   # members and recent activity
teamroom watch                    # live dashboard: who is working, their agents, files in more than one place
```

## Coding agents (MCP)

`teamroom mcp` runs a stdio MCP server with four tools:

| Tool | What it does |
| --- | --- |
| `teamroom_check_overlap` | Who else is changing these files (default: everything this checkout changed) |
| `teamroom_report_work` | Share this checkout's snapshot, with an optional one-line note |
| `teamroom_post_note` | Announce an intent before acting on it |
| `teamroom_recent_activity` | Recent activity in the room |

`teamroom create` (or `teamroom agents install`) adds the server to `.mcp.json`, which Claude Code reads for the whole team. For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.teamroom]
command = "teamroom"
args = ["mcp"]
```

Git hooks only see changes when you commit or switch branches. To share each file Claude Code edits as it happens, run:

```sh
teamroom hooks install --claude
```

This adds a `PostToolUse` hook to `.claude/settings.local.json` (local to you, not committed). Activity from agents is labeled with the agent that posted it, such as Claude Code or Codex.

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

Requires Node 22+ (`nvm use` picks the version in `.nvmrc`).

```sh
npm install
npm run dev        # rebuild on change and restart a local server on :8787
npm run check      # typecheck, lint and tests, the same as CI
npm run format     # fix formatting and import order
```

Other scripts: `build`, `typecheck`, `lint`, `test`, `test:watch`. CI runs `check` and `build` on Node 22 and 24 for every pull request.

Tooling: TypeScript 7 for type checking and builds, Vitest for tests, and Biome for linting and formatting (one dependency instead of ESLint plus Prettier).

## Releasing

Publish a GitHub release with a tag like `v0.1.2` (Releases, then Draft a new release). The `Release` workflow sets the package version from the tag, runs the full check, and publishes to npm with provenance. npm trusts the workflow directly (trusted publishing), so no token or 2FA code is involved. The version in `package.json` is only a placeholder between releases.

## License

MIT
