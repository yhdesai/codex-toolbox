# Codex Toolbox Project Document

## Purpose

Codex Toolbox mirrors Codex sessions into chat so Codex can be controlled remotely from Telegram or Discord. Each Codex thread is mapped to one Telegram forum topic or one Discord text channel. Messages from Codex are mirrored into chat, and replies from allowlisted users are routed back into the matching Codex thread.

The project is intended for Codex users who want a persistent remote control surface for active Codex work, approval requests, operational status, and compact mobile/watch clients.

## Core Capabilities

- Mirror Codex app-server sessions into Telegram forum topics.
- Mirror Codex app-server sessions into Discord session channels.
- Route Telegram or Discord replies back into the mapped Codex thread.
- Start new Codex threads from chat with project/worktree selection or an explicit `--cwd`.
- Mirror CLI-created Codex sessions by tailing mapped session JSONL files.
- Prefix mirrored chat messages with the Codex message type.
- Format Discord bot messages with a header and fenced code block, such as `Codex - agentMessage` above the message body.
- Surface tool calls, tool outputs, task completion, user messages, assistant messages, and approval prompts.
- Pause and resume mirroring without disabling chat commands.
- Rename, unlink, relink, interrupt, resync, and inspect mapped sessions.
- Expose an optional Watch API for iPhone/watchOS clients.

## Repository Layout

- `bin/codex-toolbox.js`: primary executable.
- `bin/codex-telegram-topic-sync.js`: legacy executable alias.
- `src/bridge.js`: Telegram orchestration, forum-topic mapping, commands, and session tailing.
- `src/discord-bridge.js`: Discord orchestration, category/channel mapping, commands, interactions, and session tailing.
- `src/codex-app-server.js`: Codex app-server client wrapper.
- `src/discord.js`: Discord REST and Gateway client.
- `src/telegram.js`: Telegram Bot API client.
- `src/mirror-policy.js`: event rendering and mirror-policy helpers.
- `src/watch-api.js`: optional HTTP API for iPhone/watchOS clients.
- `apps/apple`: native SwiftUI iPhone and watchOS client.
- `test`: Node test suite for bridge behavior, clients, state, and Watch API.
- `README.md`: user setup and operations guide.
- `LLMs.txt`: agent setup guide for fresh Codex instances.

## Runtime Model

Codex Toolbox starts a Codex app-server process, discovers Codex threads, and maps active/new threads into the configured chat provider.

For Telegram, the bridge binds to a forum-enabled supergroup and creates one topic per Codex thread.

For Discord, the bridge treats the server as a Codex Toolbox workspace. Categories are named after project/worktree roots, such as `erp/main` or `omniflow/ISO`. Each Codex session becomes a text channel inside the matching category.

Discord messages are rendered as code snippets. The actor and message type are shown above the code block, for example:

```text
Codex - agentMessage
```

```text
Implemented the requested change.
```

Runtime mappings, approvals, bindings, pause state, and metadata are stored in a local JSON state file. By default this is `~/.codex-toolbox.json`.

## Configuration

Required base runtime:

- Node.js 20 or newer.
- Codex CLI installed and authenticated.
- `CODEX_APP_SERVER_ARGS="app-server proxy"` unless direct stdio is needed.

Telegram configuration:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_IDS`

Discord configuration:

- `CODEX_SYNC_PROVIDER=discord`
- `DISCORD_BOT_TOKEN`
- `DISCORD_ALLOWED_USER_IDS`
- `DISCORD_GUILD_ID` if pre-binding the server at startup.
- `DISCORD_PROJECT_NAME` if overriding the default workspace folder name.
- `DISCORD_COMMAND_PREFIX`, default `!codex`.
- `CODEX_MESSAGE_SCOPE`, optional default for both providers.
- `CODEX_TELEGRAM_MESSAGE_SCOPE`, default `conversation`.
- `CODEX_DISCORD_MESSAGE_SCOPE`, default `all`.

Optional shared configuration:

- `CODEX_TOOLBOX_STATE`
- `CODEX_PROJECTS_ROOT`
- `CODEX_WATCH_API_PORT`
- `CODEX_WATCH_API_HOST`
- `CODEX_WATCH_API_TOKEN`
- `CODEX_WATCH_PROJECTS`

Message scope values:

- `all`: mirror every supported Codex event, tool output, approval, and status notice.
- `conversation`: mirror only user and agent/assistant messages.
- `none`: send no mirrored Codex transcript messages while keeping commands and replies usable.

## Common Commands

Telegram:

- `/bind`
- `/new Optional title`
- `/new --cwd /absolute/path Optional title`
- `/topics`
- `/status`
- `/resync`
- `/pause`
- `/resume`
- `/rename <title>`
- `/interrupt`
- `/unlink`
- `/relink <threadId>`
- `/delete_all_topics confirm`
- `/logs`

Discord:

- `!codex bind`
- `!codex new Optional title`
- `!codex new --cwd /absolute/path Optional title`
- `!codex topics`
- `!codex status`
- `!codex resync`
- `!codex pause`
- `!codex resume`
- `!codex rename <title>`
- `!codex interrupt`
- `!codex unlink`
- `!codex relink <threadId>`
- `!codex delete_all_channels confirm`
- `!codex delete_unlinked_channels confirm`
- `!codex delete_unlinked_channels project confirm`
- `!codex logs`

Plain text inside a mapped topic or channel is sent to the linked Codex thread.

`!codex delete_unlinked_channels confirm` deletes unlinked text channels across the whole Discord server. This is intended for dedicated Codex Toolbox Discord servers. The `project confirm` variant limits cleanup to known Codex categories.

## PM2 Operation

Telegram example:

```sh
TELEGRAM_BOT_TOKEN=replace-me \
TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id> \
CODEX_APP_SERVER_ARGS="app-server proxy" \
pm2 start bin/codex-toolbox.js --name codex-toolbox --update-env
```

Discord example:

```sh
DISCORD_BOT_TOKEN=replace-me \
DISCORD_ALLOWED_USER_IDS=<discord-user-id> \
DISCORD_GUILD_ID=<discord-server-id> \
CODEX_SYNC_PROVIDER=discord \
DISCORD_PROJECT_NAME=codex-toolbox \
CODEX_APP_SERVER_ARGS="app-server proxy" \
CODEX_TOOLBOX_STATE="$HOME/.codex-toolbox-discord.json" \
pm2 start bin/codex-toolbox.js --name codex-toolbox-discord --update-env
```

After start or restart:

```sh
pm2 save
```

## Security Notes

- Do not commit bot tokens, user IDs, server IDs, PM2 logs, or runtime state.
- `TELEGRAM_ALLOWED_USER_IDS` and `DISCORD_ALLOWED_USER_IDS` default to empty, meaning nobody can control the bridge.
- The Watch API should use `CODEX_WATCH_API_TOKEN`, especially when exposed outside loopback.
- Discord bots need Message Content Intent and permissions for channel management and messaging.
- Telegram bots need admin permissions to create/manage forum topics.
- `/logs` redacts token-shaped strings, but logs should still be treated as sensitive.
- Use separate state files when Telegram and Discord run as separate PM2 processes, for example `~/.codex-toolbox.json` for Telegram and `~/.codex-toolbox-discord.json` for Discord. Sharing one state file between live processes can clobber provider-specific mappings.

## Verification

Run the test suite:

```sh
npm test
```

Run syntax checks for specific files when changing bridge logic:

```sh
node --check src/bridge.js
node --check src/discord-bridge.js
```

Check PM2 health:

```sh
pm2 list
pm2 logs codex-toolbox --lines 120 --nostream
pm2 logs codex-toolbox-discord --lines 120 --nostream
```

## Current Project Status

Codex Toolbox supports both Telegram and Discord. Discord behavior is intended to match Telegram for message typing, session tailing, tool output mirroring, project/worktree selection, pause/resume, status, rename, logs, and approval handling.

Current Discord organization:

- Server: dedicated to Codex Toolbox.
- Category: project/worktree, for example `erp/main`.
- Channel: individual Codex session.
- Message header: actor and message type.
- Message body: fenced code block.
