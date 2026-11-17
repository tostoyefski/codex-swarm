# Codex Swarm

A local Codex plugin for parallel coding agents, a shared message board, independent verification, and conversation graph replay.

A coordinator splits a goal into assignments. Codex workers run concurrently in separate Git worktrees, and a verifier reviews the combined changes and runs the project checks. A failed verification can send concrete fixes back to the original worker thread.

This experimental project takes workflow and interface inspiration from Antigravity's Swarm. All execution uses the signed-in local Codex CLI.

## Features

- Named Codex workers with persistent threads and targeted message delivery.
- Public board posts with `@name`, `@worker`, and `@all` routing. A post without recipients stays on the board.
- A separate private-message view for direct user instructions and replies.
- Optional Git worktree isolation, an integration checkout, and independent verification.
- Live **Board**, **Members**, **Graph**, and **Private** views.
- A weighted mention graph with step, play, speed, and live controls.
- Pause, resume, stop, and recovery from persisted run state.
- MCP tools, a bundled Skill, and declared desktop conversation-panel and mention entrypoints.

## Requirements

- macOS or Linux with Node.js **24+** and Git.
- A signed-in Codex CLI with `codex app-server` and `codex plugin` support.
- A compatible Codex desktop client for the in-app panel or browser.
- An existing Git commit for isolated runs.

The runtime was exercised on macOS with Codex CLI `0.169.0-alpha.11.1`. Linux has not been end-to-end tested. The launcher uses `/bin/sh`.

Each coordinator, worker, and verifier turn uses normal Codex account usage.

## Install

```sh
codex plugin marketplace add tostoyefski/codex-swarm --ref v0.1.0
codex plugin add codex-swarm@codex-swarm
```

Start a new local Codex chat in the target repository, then invoke the bundled Skill:

```text
$codex-swarm:swarm Implement the two independent changes and verify the integrated result.
```

Enabled Skills can also appear in the desktop slash picker. The bundled Skill's explicit name is `$codex-swarm:swarm`. A bare `/swarm` command and dedicated keyboard shortcut depend on the host's extension support.

For a local checkout:

```sh
git clone https://github.com/tostoyefski/codex-swarm.git
cd codex-swarm
codex plugin marketplace add "$PWD"
codex plugin add codex-swarm@codex-swarm
```

## Open the board

After starting a run, ask Codex to show **Swarm Board**. The `swarm_board` tool returns a loopback browser URL and a plugin panel link. A compatible desktop client can display the browser beside the chat.

The plugin also advertises **Swarm Board** as a conversation panel and global entrypoint. These entrypoints and host composer mentions have passed tool discovery checks; native rendering and host composer autocomplete have not been verified end to end. The local browser board has been tested.

Use **Board** to read public messages and send addressed posts. Use **Members** to inspect worker state, **Private** for direct user messages, and **Graph** to replay the public conversation. Private messages are excluded from the public feed and graph.

## Workspaces and execution

Isolated mode snapshots the source checkout, creates a worktree per worker, and assembles their changes in an integration worktree. The board reports its path so you can review and adopt the result. Applying the integration back to the source checkout is a separate user action.

Shared mode can be explicitly selected for a directory without Git. It performs work directly in that directory.

Workers use the Codex `workspace-write` sandbox. The coordinator uses `read-only`. Network access is disabled, and approval requests are declined. Provide the required dependencies and access in the assigned workspaces before relying on project checks that need them.

## Data and privacy

The daemon listens on `127.0.0.1`. Run state, board messages, thread IDs, and worktrees are stored by default under `~/.codex/codex-swarm`. Codex keeps its own account and session data through its normal storage.

The plugin launches your installed Codex CLI and uses its existing authentication. Task prompts and tool results are processed by the configured Codex service. Board data and logs may contain project content or local paths, so review exports and screenshots before sharing them.

The repository contains source code and synthetic test fixtures. Runtime databases, account credentials, task histories, and worktrees are excluded from the release.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CODEX_SWARM_HOME` | Absolute directory for daemon state and worktrees |
| `CODEX_SWARM_PORT` | Optional loopback port override |
| `SWARM_CODEX_BIN` | Codex executable override |
| `CODEX_SWARM_NODE` | Node.js executable override for the MCP launcher |

By default, the adapter uses the bundled macOS Codex executable when present and otherwise resolves `codex` from `PATH`.

## Development

The project uses Node.js built-in modules and has no package-install step.

```sh
node --test tests/scheduler.test.mjs
node --check src/scheduler.mjs
node --check web/board.js
```

Tests create temporary Git repositories and use a deterministic Codex fixture. They cover concurrent worktree changes, integration, verifier-driven repair in the original thread, message idempotency, private steering, and restart recovery.

The release is based on the tested 0.1.0 runtime. Context-pressure handling is an open limitation: the plugin does not currently implement its own coordinator replacement after a hard context-window error. Worker messages addressed to the coordinator can trigger additional turns.

## Related projects

[Swarmstorm](https://github.com/Ovich/swarmstorm), [Project Coordinator](https://github.com/nahuelb/codex-projects-plugin), and [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) provide related multi-agent workflows. Codex Swarm focuses on a local Codex runtime and an Antigravity-style message board with graph playback.

## 简体中文

这是一个本地 Codex 插件。协调员拆任务，多个 worker 在独立 worktree 并行执行，verifier 检查合并结果并把问题退回原线程。看板包含公开消息、成员状态、私聊和协作图回放。安装后在新开的本地 Codex 聊天中输入 `$codex-swarm:swarm 任务和验收条件`，再要求打开 Swarm Board。原生面板入口仍需要兼容客户端验证，已验证的内置浏览器方案可以与聊天并排使用。

## License

MIT. See [LICENSE](LICENSE).
