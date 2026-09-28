# Dogfooding

A week of real work with teamroom on, to learn whether its warnings help or get in the way. The results decide what to build next (see section 6 of [TODO.md](TODO.md)).

## Setup

- **Repo:** a real project with active work, not a test repo. Write it here: _____
- **Dates:** _____ to _____
- **Agents:** 2 or 3 in parallel, each in its own worktree. Mix agents with hooks (Claude Code, Gemini CLI) and without (Codex, Cursor) to compare them.
- **Tasks:** normal work. Do not arrange tasks to overlap on purpose, the point is to see how often it happens on its own.

Before starting:

```sh
npm install --global teamroom
cd <repo> && teamroom init
teamroom doctor          # everything green, or note what is not
```

## What to log

One line for every time teamroom tells you or an agent something:

| Where | What it is |
| --- | --- |
| `brief` | The session-start briefing listed other sessions' files |
| `pause` | An edit was paused before it happened |
| `heads-up` | A teamroom tool result started with "Heads up" |
| `check` | `teamroom check` or `teamroom_check_overlap` reported overlap |
| `missed` | A merge conflict or clash happened and teamroom said nothing |

And a verdict for each:

- **useful:** it changed what you or the agent did (waited, split the work, talked to someone, avoided a conflict)
- **noise:** irrelevant, and add why: `other part of the file`, `already merged`, `generated file`, `stale plan`, `other`
- **missed:** only for `missed` lines, add what teamroom should have seen

Also note when an agent **ignored** a warning it got, since that says something about how warnings reach agents, not about the overlap signal.

## Log

Format: `date  where  file  verdict  (agents involved, what happened)`

```text
2026-09-29  pause     src/auth.ts  useful  (Claude waited, Codex was mid-refactor of the same function)
2026-09-29  brief     README.md    noise   already merged
```

```text

```

## Results

Fill in at the end of the week.

| | Count |
| --- | --- |
| Warnings in total | |
| Useful | |
| Noise | |
| Missed conflicts | |
| Ignored by the agent | |

**Most common noise reason:** _____

**What this means for the TODO:**

- Mostly noise from `other part of the file`: build hunk-level detection (section 1)
- Plans (`teamroom note`) were the most useful warnings: invest in plans (section 4)
- Many warnings ignored by agents: work on how warnings reach agents before sharpening the signal
- Mostly `already merged` or `stale plan`: more clean-up work (section 2)
- Very few overlaps at all: the problem may be smaller than assumed; rethink before building more

**One line for the README** (only if the numbers are good): _____
