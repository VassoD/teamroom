# TODO

Checklist from the project review (2026-09-27). Goal: sharpen the overlap signal and position teamroom on what competitors do not do (plans and cross-machine coordination).

## 0. What makes teamroom better than the alternatives

| Alternative | What it does better today | What teamroom needs to win |
| --- | --- | --- |
| [Clash](https://github.com/clash-sh/clash) | Detects real merge conflicts between local worktrees (`git merge-tree`), fewer false alarms | Match its signal (section 1), then win on plans, cross-machine and non-hook agents |
| Orchestrators (Conductor, Vibe Kanban, Nimbalyst, Warp) | Own the whole flow: create worktrees, assign tasks, review, merge | Stay tool-agnostic and work inside any of them; be the coordination layer they lack |
| Claim protocols (Foremerge, agent-claim-mcp) | Reason about intent and symbols, not just files | Combine declared plans with observed changes, so it works even when agents forget to declare |
| GitLive | Polished real-time view for humans in the editor | Be agent-first: pause edits, brief sessions, speak MCP |
| Doing nothing (split tasks, rebase often, `git rerere`) | Zero setup, good enough for 2 or 3 agents | Near-zero setup and warnings that are almost never noise |

Must-haves to be clearly better:

- [ ] Real conflict detection, not just "same file" (parity with Clash)
- [ ] Plans before code that other agents actually see and respect (nobody else does this well)
- [ ] Works across machines and teammates (Clash and orchestrators are local only)
- [ ] Works with any agent, hooks or not (Claude Code, Codex, Cursor, Gemini CLI)
  - [x] Claude Code and Gemini CLI: briefed at session start, edits paused before they happen
  - [x] Agent hooks behind one adapter registry (`src/client/agent-hooks.ts`), so commands and docs name no agent
  - [ ] Cursor: check in a real install whether its imported Claude hooks show the pause reason to the model; if not, add a native `.cursor/hooks.json` adapter (`preToolUse`, `agent_message`)
  - [ ] Codex: only the MCP heads-up, which lands on its next teamroom tool call
- [ ] Almost no false alarms, measured through dogfooding (section 6)
- [ ] Setup stays one command

## 1. Sharper conflict signal

- [ ] Add hunk-level overlap: for files flagged by `findOverlaps`, compare changed line ranges between sessions
- [ ] Try `git merge-tree` between branches to report "will conflict" vs "same file, merges cleanly"
- [ ] Show the severity in warnings (plan only / same file / overlapping hunks / real conflict)
- [ ] Only pause Claude Code edits (PreToolUse hook) for overlapping hunks or real conflicts, not every shared file
- [ ] Add tests for same-file-different-functions (should not pause) and real conflict (should pause)

## 2. Less noise

- [ ] Shorten the default overlap window from 72 hours (try 24h or less) in `src/core/overlap.ts`
- [x] Drop sessions whose worktree no longer exists (check `git worktree list` in local mode)
- [x] Stop reporting files of a squash-merged branch (compare against the default branch, not only the merge-base)
- [x] Keep only each session's latest snapshot, so snapshot churn does not push notes out of the 1000-entry log
- [ ] Expire sessions with no activity for N hours, even without a new snapshot
- [ ] Consider a built-in default ignore list for common hub/generated files beyond lockfiles

## 3. Positioning and docs

- [x] Add [Clash](https://github.com/clash-sh/clash) to "How it compares" in the README, honestly: it detects real merge conflicts between local worktrees
- [ ] Reframe the pitch around what Clash cannot do: plans before code (`teamroom note`), cross-machine team mode, any MCP agent
- [ ] Mention orchestrators (Conductor, Vibe Kanban, Nimbalyst, Warp) and how teamroom fits alongside them
- [ ] Update the landing page (`site/index.html`) to match the new positioning

## 4. Plans and intent (main differentiator)

- [ ] Make notes more visible: surface other sessions' plans at session start and in `teamroom watch`
- [x] Let notes expire: a plan ends once its session had changes and now has none
- [ ] Let notes be closed explicitly (`teamroom note --done`)
- [ ] Explore symbol-level plans ("renaming User to Account" matched against files that reference `User`)
- [ ] Help split tasks up front: a command that shows which planned files overlap before agents start

## 5. Team mode adoption

- [ ] Reduce setup friction: one-click deploy (Fly.io template) or a hosted demo server
- [ ] Decide whether team mode is worth the maintenance; gather feedback from at least one real team first

## 6. Validate with real use

- [ ] Dogfood for a week with 3 parallel agents on a real repo
- [ ] Log every warning and mark whether it changed a decision (useful / noise)
- [ ] Use the results to decide priorities: if file warnings are mostly noise, invest in sections 1 and 4
- [ ] Clean up version mismatch: local `package.json` says 0.1.0, npm has 0.2.0

## 7. Security

- [x] Quote other sessions' notes, branch and member names before agents read them, so a note cannot pose as instructions
- [x] Detect `core.hooksPath` (husky and similar) in `teamroom doctor`: git hooks land in files husky regenerates
