# teamroom

Run coding agents in parallel without them stepping on each other's files.

You have Claude Code refactoring auth in one worktree, Codex building a feature in another, and Gemini CLI fixing tests in a third. Nothing tells them they are about to change the same file, until you merge. teamroom does: every session shares what it is changing, and each agent learns who else is in a file before it edits it.

- **Any agent.** Claude Code, Codex, Cursor, Gemini CLI, Mistral Vibe, or anything else that speaks MCP.
- **One command, no server.** `teamroom init` and you are done. Worktrees on one machine share a file in `.git`.
- **Sees work that is not pushed yet.** Uncommitted edits, untracked files, and plans that are not code yet ("renaming User to Account").
- **Optional team mode.** Point the repo at a small server and teammates' agents join the same room.

## Quick start

Requires Node.js 22 or newer and git.

```sh
npm install --global teamroom
cd your-repo
teamroom init
git add .mcp.json AGENTS.md && git commit -m "chore: coordinate parallel agents with teamroom"
```

Then give each agent its own worktree and start them:

```sh
git worktree add ../app-auth -b feat/auth && (cd ../app-auth && claude)
git worktree add ../app-billing -b feat/billing && (cd ../app-billing && codex)
teamroom watch    # live view: every session, its agent, and files in more than one place
```

`teamroom doctor` checks every piece and prints the command that fixes each problem.

## What `init` sets up

| Piece | Works with | What it does |
| --- | --- | --- |
| Git hooks | everything | After each commit, checkout, merge and rebase, shares the files this checkout changed compared with `main`, including uncommitted and untracked ones. Runs in the background and never fails a commit. |
| MCP server | any MCP agent | Runs for as long as the agent does. Shares the checkout's changes every few seconds without being asked, and puts a **heads-up** in front of the next tool result when another session starts changing a file this one is changing. Also gives the agent tools to announce a plan and check before editing. |
| `AGENTS.md` block | Codex, Cursor, and most agents | Tells the agent to announce its plan with `teamroom_post_note` and to call `teamroom_check_overlap` before editing. |
| Claude Code hooks | Claude Code | Briefs each new session on what the others are changing. **Pauses an edit once** when another session is in that file, with who and why; the retry goes through. Shares every edit the moment it happens. Worktrees created later get these hooks automatically, and teamroom's own tools are pre-approved so they run without a prompt. |

MCP config is written for Claude Code (`.mcp.json`) always, and for Cursor (`.cursor/mcp.json`), Gemini CLI (`.gemini/settings.json`) and Codex (`.codex/config.toml`) when the repo already has that folder. Force one with `teamroom init --agents codex,gemini`. For anything else, add a stdio MCP server with command `teamroom` and args `["mcp"]`. Examples:

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

Hooks are enforced, tools are a request. The git hooks, the MCP server's background reports and the Claude Code hooks run whatever the model decides, so the room stays accurate even when an agent ignores its instructions.

## How it works

- **Sessions, not people.** Every checkout (worktree, clone, agent box) is its own session. Two agents of the same developer in two worktrees warn each other.
- **Snapshots replace each other.** A session's newest snapshot replaces its previous one and the agent edits before it, so once you merge, revert or switch branches, the warnings go away.
- **Noise stays out.** Lockfiles never count as overlap. Add your own patterns (generated code, snapshots) to a `.teamroomignore` at the repo root, gitignore style, with `!` to re-include.
- **Nothing blocks git, and nothing blocks an agent for good.** A paused Claude edit goes through on retry; hooks exit cleanly when the room cannot be read.

## MCP tools

| Tool | What it does |
| --- | --- |
| `teamroom_post_note` | Announce a plan and the files it will touch, before editing |
| `teamroom_check_overlap` | Who else is changing these files (default: everything this checkout changed) |
| `teamroom_report_work` | Share this checkout's changes now, with an optional one-line note |
| `teamroom_recent_activity` | What other sessions and agents did recently |

Activity is labeled with the agent that sent it, from the name it gives in the MCP handshake.

## Daily use

```sh
teamroom watch                    # live dashboard
teamroom check                    # who else is changing the files you changed
teamroom check src/auth.ts        # or specific files; exits 3 when there is overlap
teamroom note "renaming User to Account" --files src/user.ts,src/db/schema.ts
teamroom report                   # share your changes now (hooks do this on commit and checkout)
teamroom status                   # recent activity
```

## Team mode

Local mode covers every worktree on one machine. To include teammates and their agents on other machines, run a server somewhere your team can reach:

```sh
npx teamroom serve --host 0.0.0.0 --port 8787 --data-dir /var/lib/teamroom
```

Put it behind HTTPS, and pass `--trust-proxy` only when that proxy sets `X-Forwarded-For`. [docs/hosting.md](docs/hosting.md) covers Fly.io, Docker, the environment variables, and how to restrict who can create rooms.

In your repo, one person creates the room:

```sh
teamroom create --server https://teamroom.example.com
```

It names the room after the repo folder and you after your git `user.name` (override with `--room-name` and `--name`), sets up the repo like `init`, and prints an invite link. Anyone who has the link can join, so share it privately. Teammates run, inside their clone:

```sh
teamroom join 'https://teamroom.example.com/join/room_...#tri_...'
```

Membership is saved to `.git/teamroom.json` (mode `600`, never committed) and every worktree shares it. The invite code sits after the `#`, which browsers never send, so it stays out of server logs. Without a scheme, `--server` defaults to `https://` (and `http://` for localhost).

`teamroom leave` removes you from the room and returns the repo to local mode.

Room admin:

```sh
teamroom invite rotate            # owner only; the old invite stops working
teamroom member remove bo         # owner only, or yourself; revokes the token
teamroom token rotate             # replace your own token, for example after a leak
```

## What is shared

File paths, branch names, commit ids, short notes, member and agent names. Never file contents. In local mode nothing leaves your machine: the room is `.git/teamroom/`, readable only by you. On a server, tokens and invite codes are stored as SHA-256 hashes.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TEAMROOM_SESSION` | Name this checkout's session (default: folder name plus a short hash of its path) |
| `TEAMROOM_MEMBER` | Your name (default: git `user.name`) |
| `TEAMROOM_AUTO_REPORT=0` | Stop `teamroom mcp` from sharing changes in the background |
| `TEAMROOM_SERVER`, `TEAMROOM_ROOM`, `TEAMROOM_TOKEN` | Override `.git/teamroom.json`, for CI or shared agent machines |

## Limits

- The room keeps the latest 1000 entries. Overlap looks back 72 hours by default (`--since-hours`, up to 90 days).
- A snapshot holds up to 200 files. Larger change sets are truncated and the CLI says so.
- On a server, rate limits are kept in memory per process, and rooms are stored as one JSON file each. That is fine for teams, not for thousands of active rooms.

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
