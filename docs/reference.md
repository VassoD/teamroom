# Reference

## Commands

```sh
teamroom watch                    # live dashboard
teamroom check                    # who else is changing the files you changed
teamroom check src/auth.ts        # or specific files
teamroom note "renaming User to Account" --files src/user.ts,src/db/schema.ts
teamroom report                   # share your changes now (hooks do this on commit and checkout)
teamroom status                   # recent activity
teamroom doctor                   # check the setup and print a fix for each problem
```

`teamroom check` exits `3` when someone else is changing one of the files, so scripts and CI can act on it:

```sh
teamroom check || echo "someone else is in these files"
```

## Ignoring files

Lockfiles never count as overlap. Add your own patterns (generated code, snapshots) to a `.teamroomignore` at the repo root, gitignore style, with `!` to re-include.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TEAMROOM_SESSION` | Name this checkout's session (default: folder name plus a short hash of its path) |
| `TEAMROOM_MEMBER` | Your name (default: git `user.name`) |
| `TEAMROOM_AUTO_REPORT=0` | Stop `teamroom mcp` from sharing changes in the background |
| `TEAMROOM_SERVER`, `TEAMROOM_ROOM`, `TEAMROOM_TOKEN` | Override `.git/teamroom.json`, for CI or shared agent machines |

Server settings are in [hosting.md](hosting.md).

## Limits

- The room keeps the latest 1000 entries, and only each session's latest snapshot. Overlap looks back 72 hours by default (`--since-hours`, up to 90 days).
- A plan posted with `teamroom note` stops counting once its session has had changes and then has none left, for example after a merge.
- A changed file counts only while it still differs from the default branch, so a squash-merged branch stops warning once main has its changes.
- In local mode, a worktree removed with `git worktree remove` (or whose directory was deleted) stops warning right away.
- A snapshot holds up to 200 files. Larger change sets are truncated and the CLI says so.
- On a server, rate limits are kept in memory per process, and rooms are stored as one JSON file each. That is fine for teams, not for thousands of active rooms.
