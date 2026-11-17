---
name: swarm
description: Start or control a Codex Swarm for a concrete task. Use for $swarm, /swarm, $codex-swarm:swarm, explicit Swarm requests, Swarm board requests, and Swarm worker mentions selected in the composer.
---

# Codex Swarm

Use the Codex Swarm plugin's MCP tools. Each run has named Codex workers, a persistent board, and an independent verification phase.

- A new task uses `swarm_start` with the complete task and acceptance criteria, the absolute directory of the user's target project, and any explicit worker, model, or isolation preferences. Use the active project when the user did not name another directory. Preserve the user's intended file and action boundaries. Omit optional settings the user did not specify.
- `/swarm board` or a request to see the Swarm uses `swarm_board` for the named run, the run started in this chat, or the board's run picker. After starting a run, call `swarm_board` with its id to expose the live view. If the native panel is unavailable, give the returned local board link. In Codex desktop the link can open alongside the chat in the built-in browser.
- Use `swarm_snapshot` for progress and verification evidence. When the user asks you to finish or monitor in this chat, continue checking until verification finishes or a specific blocker needs attention. Use the board if the user wants to watch or steer without waiting in this chat.
- When the user addresses a worker (including a selected `codex-swarm://member/…` resource), use `swarm_post` with the run id, the recipient in `to`, and the requested message. A message sent directly by the human to a member is private unless the user asks to post it to the shared board. The scheduler delivers the message to a running worker or wakes an idle worker in its existing conversation.
- Use `swarm_control` for explicit pause, resume, stop, interrupt, or per-member model changes. Treat a reported conflict, failed check, or partial result as unfinished. Validate real diffs or test results before describing the task as completed.

The desktop entry in the slash picker is this Skill. Use `$codex-swarm:swarm` for the plugin Skill or `$swarm` if a standalone alias is installed. Bare `/swarm` sent as a prompt may also select it when the installed composer accepts the text.

If the current chat has not loaded the MCP tools, use `node <plugin root>/src/local.mjs`, or `node ~/.codex/skills/swarm/local.mjs` from the installed standalone Skill. Commands are `board [runId]`, `list`, `snapshot <runId>`, `start`, `post <runId>`, and `control <runId>`. The last three read the matching MCP arguments as JSON on stdin, with the run ID only on the command line. Return the board URL for the same run.
