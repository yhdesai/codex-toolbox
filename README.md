# Codex Toolbox

Mirror Codex app-server sessions into Telegram forum topics or Discord project channels.

Each Codex thread gets one Telegram forum topic or one Discord text channel. Messages from Codex are mirrored into that destination, and replies from allowed chat users are routed back into the same Codex thread. The bridge also supports chat approval buttons for Codex permission requests.

This project is intended for Codex users only right now. The easiest setup path is to open this repository in Codex and ask Codex to read `LLMs.txt`; that file is written as an agent setup guide.

## Features

- Telegram: one forum topic per Codex thread.
- Discord: one text channel per Codex thread, grouped under a project category named after the workspace folder.
- Chat replies route back to the matching Codex thread.
- `/new` or `!codex new` creates a new Codex thread and chat destination.
- CLI-created Codex sessions are detected and mirrored.
- Allowlist-based Telegram and Discord control.
- Inline approve, decline, and cancel buttons for Codex approval requests.
- Operational commands for status, resync, pause/resume, relink, rename, unlink, logs, and topic cleanup.
- Local JSON state file; no hardcoded Telegram group id or Discord guild id.

## Requirements

- Node.js 20 or newer.
- Codex CLI installed and authenticated on the machine running the bridge.
- A Telegram bot token from BotFather.
- A Telegram supergroup with forum topics enabled.
- The bot added to that group as an admin with permission to create/manage topics and send messages.
- Your Telegram numeric user id for `TELEGRAM_ALLOWED_USER_IDS`.
- Or a Discord bot token, a Discord server, and your Discord numeric user id for `DISCORD_ALLOWED_USER_IDS`.
- For Discord, enable Message Content Intent in the Discord Developer Portal and grant the bot `Manage Channels`, `View Channels`, `Send Messages`, and `Read Message History`.

## Quick Start

### Let Codex Set It Up

Open Codex and paste this prompt:

```text
Clone https://github.com/yhdesai/codex-toolbox, read LLMs.txt, and set up Codex Toolbox in this Codex instance. Install dependencies, run tests, configure the required environment variables using the values I provide, start the Telegram or Discord bridge, and tell me what to do in chat.
```

Codex should then follow `LLMs.txt` to install, test, configure, and run the bridge. You will still need to provide either Telegram or Discord bot credentials, your numeric chat user id, and a server/group where the bot has the required permissions.

### Manual Setup

Clone and install:

```sh
git clone https://github.com/yhdesai/codex-toolbox.git
cd codex-toolbox
npm install
```

Set runtime environment for Telegram:

```sh
export TELEGRAM_BOT_TOKEN=replace-me
export TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id>
```

Or for Discord:

```sh
export CODEX_SYNC_PROVIDER=discord
export DISCORD_BOT_TOKEN=replace-me
export DISCORD_ALLOWED_USER_IDS=<discord-user-id>
export DISCORD_PROJECT_NAME=codex-toolbox
```

Start the bridge:

```sh
npm start
```

In your forum-enabled Telegram group, send:

```text
/bind
```

Then either start a new Codex session normally, or create one from Telegram:

```text
/new Investigate bug
```

For Discord, invite the bot to your server, then run:

```text
!codex bind
!codex new Investigate bug
```

## Configuration

Environment variables:

```sh
TELEGRAM_BOT_TOKEN=replace-me
TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id>[,<telegram-user-id>]
DISCORD_BOT_TOKEN=replace-me
DISCORD_ALLOWED_USER_IDS=<discord-user-id>[,<discord-user-id>]
CODEX_SYNC_PROVIDER=telegram|discord
DISCORD_PROJECT_NAME=workspace-folder-name
DISCORD_COMMAND_PREFIX=!codex
CODEX_APP_SERVER_COMMAND=codex
CODEX_APP_SERVER_ARGS="app-server proxy"
CODEX_APP_SERVER_CWD=/path/to/workspace
CODEX_TOOLBOX_STATE=~/.codex-toolbox.json
CODEX_TELEGRAM_POLL_MS=5000
```

Defaults:

- `CODEX_APP_SERVER_COMMAND`: `codex`
- `CODEX_APP_SERVER_ARGS`: `app-server proxy`
- `CODEX_SYNC_PROVIDER`: `discord` if `DISCORD_BOT_TOKEN` is set, otherwise `telegram`
- `DISCORD_PROJECT_NAME`: workspace folder name
- `DISCORD_COMMAND_PREFIX`: `!codex`
- `CODEX_TOOLBOX_STATE`: `~/.codex-toolbox.json`
- `CODEX_TELEGRAM_POLL_MS`: `5000`
- `TELEGRAM_ALLOWED_USER_IDS`: empty, which means nobody can control the bridge
- `DISCORD_ALLOWED_USER_IDS`: empty, which means nobody can control the Discord bridge

`CODEX_TELEGRAM_STATE` and the `codex-telegram-topic-sync` binary name are still accepted as legacy aliases for existing installs.

If `codex app-server proxy` does not initialize on your host, use direct stdio:

```sh
export CODEX_APP_SERVER_ARGS="app-server"
```

## Running With PM2

```sh
npm install -g pm2

TELEGRAM_BOT_TOKEN=replace-me \
TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id> \
CODEX_APP_SERVER_ARGS="app-server proxy" \
pm2 start bin/codex-toolbox.js --name codex-toolbox --update-env

pm2 save
```

Restart with updated environment:

```sh
TELEGRAM_BOT_TOKEN=replace-me \
TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id> \
CODEX_APP_SERVER_ARGS="app-server proxy" \
pm2 restart codex-toolbox --update-env

pm2 save
```

For Discord, use:

```sh
DISCORD_BOT_TOKEN=replace-me \
DISCORD_ALLOWED_USER_IDS=<discord-user-id> \
CODEX_SYNC_PROVIDER=discord \
DISCORD_PROJECT_NAME=codex-toolbox \
CODEX_APP_SERVER_ARGS="app-server proxy" \
pm2 start bin/codex-toolbox.js --name codex-toolbox-discord --update-env

pm2 save
```

## Telegram Commands

- `/bind`: bind the current forum group.
- `/help`: list available commands.
- `/new Optional title`: create a Codex thread and Telegram topic.
- `/topics`: list current `threadId -> message_thread_id -> title` mappings.
- `/delete_all_topics confirm`: delete all Codex-mapped Telegram topics, clear mappings and approvals, and keep the group binding.
- `/unlink`: remove this topic's Codex mapping without deleting the Telegram topic.
- `/relink <threadId>`: map this Telegram topic to an existing Codex thread.
- `/resync`: run thread discovery immediately.
- `/pause`: pause Codex-to-Telegram mirroring; Telegram replies and admin commands still work.
- `/resume`: resume mirroring and run discovery.
- `/rename <title>`: rename this Telegram topic and attempt to rename the Codex thread.
- `/interrupt`: interrupt the mapped Codex thread.
- `/status`: show binding, pause state, mapped topics, known threads, approvals, cooldowns, allowed users, and recent errors.
- `/logs`: show short redacted diagnostics from in-memory errors and PM2 log tails when readable.

Plain text inside a mapped topic is sent to the matching Codex thread. Plain text from an allowed user outside a mapped topic gets a guidance reply. Unauthorized text is ignored silently.

## Discord Commands

- `!codex bind`: bind the current Discord server and create/reuse the project category.
- `!codex help`: list available commands.
- `!codex new Optional title`: create a Codex thread and Discord text channel under the project category.
- `!codex status`: show binding, project category, mapped channels, allowed users, and discovery stats.
- `!codex resync`: run thread discovery immediately.
- `!codex interrupt`: interrupt the mapped Codex thread.
- `!codex unlink`: remove this channel's Codex mapping without deleting the Discord channel.
- `!codex relink <threadId>`: map this Discord channel to an existing Codex thread.
- `!codex delete_all_channels confirm`: delete all Codex-mapped Discord channels and clear their mappings.

Plain text inside a mapped Discord channel is sent to the matching Codex thread. Plain text from an allowed user in an unmapped channel gets guidance. Unauthorized text is ignored silently.

Discord creates one category for the current project, using `DISCORD_PROJECT_NAME` or the workspace folder name. Each Codex thread becomes a text channel inside that category.

## Mirroring Behavior

The bridge mirrors human-readable events:

- User messages.
- Assistant messages.
- Plans.
- Errors.
- Approval prompts.
- Concise command and tool summaries.

The bridge does not mirror raw reasoning text or full command output chunks by default. Noisy lifecycle-only events such as `thread/status/changed`, `turn/started`, and `turn/completed` are suppressed.

Assistant streaming deltas are buffered and sent once when the assistant message completes. Messages that originated in Telegram are de-duplicated so the bot does not echo the same text back into the topic.

For Codex CLI sessions that do not emit live app-server item events to this bridge process, the bridge polls the mapped Codex session JSONL file and mirrors new `user_message` and `agent_message` entries.

## Discovery And State

The Telegram group is bound at runtime with `/bind`; no group id is hardcoded. The Discord server is bound at runtime with `!codex bind`; no guild id is hardcoded.

The local state file stores:

- Bound Telegram group id.
- Bound Discord guild id and project category id.
- Codex thread to Telegram topic mappings.
- Telegram topic to Codex thread mappings.
- Codex thread to Discord channel mappings.
- Discord channel to Codex thread mappings.
- Pending approval callbacks.
- Pause state.
- Recent redacted errors.

Startup discovery does not backfill historical Codex sessions into Telegram topics. Existing sessions are recorded as a baseline. A topic is created when:

- A new Codex thread appears after startup.
- `/new` creates a thread.
- An old unmapped thread shows fresh activity after startup.

`/delete_all_topics confirm` only deletes topics known in the bridge state file. Telegram bots cannot enumerate every arbitrary topic in a forum group.

## Security Notes

- Do not commit real Telegram bot tokens.
- Do not commit real Discord bot tokens.
- Do not commit `~/.codex-toolbox.json`; it contains group and topic ids. Existing installs may also have the legacy `~/.codex-telegram-topic-sync.json` state file.
- Keep `TELEGRAM_ALLOWED_USER_IDS` narrow. Allowed users can send messages to Codex and answer approval prompts.
- Keep `DISCORD_ALLOWED_USER_IDS` narrow. Allowed users can send messages to Codex and answer approval prompts.
- `/logs` redacts token-shaped strings before sending diagnostics to Telegram, but avoid posting sensitive logs in shared groups.
- The bot must be an admin to create, rename, and delete topics.

## Troubleshooting

Check PM2 and logs:

```sh
pm2 list
pm2 logs codex-toolbox --lines 120 --nostream
```

Inspect local bridge state:

```sh
sed -n '1,220p' ~/.codex-toolbox.json
```

Common issues:

- `Bad Request: not enough rights to create a topic`: make the bot an admin with forum topic permissions, then run `/bind` again.
- `Too Many Requests: retry after N`: Telegram is rate-limiting topic or message creation. The bridge backs off automatically.
- No Telegram response from a user: check that the user's numeric Telegram id is included in `TELEGRAM_ALLOWED_USER_IDS`.
- Message in group gets guidance instead of routing: send it inside a mapped forum topic, not the general group.
- CLI session topic appears but messages do not: run `/status` or `/resync`; the bridge tails mapped CLI session files on the discovery poll interval.

## Development

Run tests:

```sh
npm test
```

Covered areas include:

- JSON-RPC request/response matching and reconnect.
- Persistent state.
- Telegram topic payloads, chunking, command parsing, and approval buttons.
- Topic commands: `/bind`, `/new`, `/topics`, `/delete_all_topics`, `/unlink`, `/relink`, `/resync`, `/pause`, `/resume`, `/rename`, `/interrupt`, `/status`, and `/logs`.
- Telegram-originated echo suppression.
- CLI session JSONL tailing.

## Public Repo Checklist

Before publishing changes:

```sh
rg -n "TELEGRAM_BOT_TOKEN='|DISCORD_BOT_TOKEN='|[0-9]{6,}:[A-Za-z0-9_-]{20,}|/home/|boundChatId|-100[0-9]+" .
npm test
```

The repository should contain source, tests, and docs only. Runtime state, logs, and secrets should stay local.
