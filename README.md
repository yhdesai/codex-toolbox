# Codex Telegram Topic Sync

Background bridge that mirrors Codex desktop app-server threads into a Telegram forum group.

## Run

```sh
export TELEGRAM_BOT_TOKEN=replace-me
npm start
```

Defaults:

- Codex command: `codex app-server proxy`
- State file: `~/.codex-telegram-topic-sync.json`
- Discovery poll: `5000ms`

Useful overrides:

```sh
export CODEX_APP_SERVER_COMMAND=codex
export CODEX_APP_SERVER_ARGS="app-server proxy"
export CODEX_TELEGRAM_STATE=/path/to/state.json
export CODEX_TELEGRAM_POLL_MS=5000
export TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id>
```

Use `/bind` in a forum-enabled Telegram supergroup where the bot is admin. The bot must be allowed to create/manage topics; otherwise the group can be bound but no Codex thread topics can be mapped. The bridge stores that group id and persists `{ threadId -> message_thread_id }` locally.
If Telegram returns a `retry after` rate limit while creating topics, automatic topic creation pauses until that retry window passes.

Startup discovery does not backfill historical Codex sessions into Telegram topics. Existing sessions are only subscribed as a baseline. A Telegram topic is created when a new Codex thread appears after startup, when `/new` creates a thread, or when an old unmapped thread emits a human-readable event.

CLI-created Codex sessions are also tailed from their Codex session JSONL file after they are mapped. Existing mapped CLI sessions start tailing at end-of-file to avoid backfill; newly discovered CLI sessions start at the beginning so their first prompt and response are mirrored into the new Telegram topic.

By default, no Telegram users can control the bridge until `TELEGRAM_ALLOWED_USER_IDS` is set. The allowlist applies to `/bind`, `/new`, `/interrupt`, topic replies, and approval buttons. Unauthorized text messages are ignored without a bot reply. To allow multiple users, set `TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list and restart the bridge.

## Telegram Commands

- `/bind` binds the current forum group.
- `/help` lists available commands.
- `/new Optional title` creates a new Codex thread and a new Telegram topic.
- `/topics` lists current `threadId -> message_thread_id -> title` mappings.
- `/delete_all_topics confirm` deletes all Codex-mapped Telegram topics, clears mappings and approvals, and keeps the group binding.
- `/unlink` inside a mapped topic removes that mapping without deleting the Telegram topic.
- `/relink <threadId>` inside a forum topic maps that topic to an existing Codex thread.
- `/resync` runs discovery immediately and reports seen/created/resumed/skipped counts.
- `/pause` pauses Codex-to-Telegram mirroring. Telegram replies and admin commands still work.
- `/resume` resumes mirroring and runs discovery.
- `/rename <title>` inside a mapped topic renames the Telegram topic and attempts to rename the Codex thread.
- `/interrupt` inside a mapped topic calls `turn/interrupt`.
- `/status` reports binding, pause state, mapped topics, known threads, subscribed threads, approvals, cooldowns, allowed users, and recent errors.
- `/logs` shows short redacted diagnostics from in-memory errors and PM2 log tails when readable.
- Plain text inside a mapped topic routes to that Codex thread with `turn/start` when idle or `turn/steer` when active.
- Plain text from an allowed user outside a mapped topic gets a guidance reply. Unauthorized users are still ignored silently.

`/delete_all_topics confirm` only deletes topics known in the bridge state file. Telegram bots cannot enumerate every arbitrary topic in a forum group. The command preserves the bound group and marks current known Codex threads as a baseline so deleted historical topics are not immediately recreated.

## Approval Flow

Codex server approval requests are posted into the mapped thread topic with inline buttons. Callback decisions are sent back to app-server as `accept`, `decline`, or `cancel`. Destructive command labels are made explicit before approval.

## Mirroring Policy

The bridge mirrors human-readable events only: user/assistant messages, plans, errors, status changes, approval prompts, and concise command/tool summaries. Reasoning/thought events and raw command output chunks are not mirrored by default.
Noisy lifecycle-only events such as `thread/status/changed`, `turn/started`, and `turn/completed` are suppressed.
Assistant streaming deltas are buffered and sent once when the assistant message completes.
Messages that originated in Telegram are de-duplicated when Codex emits the corresponding `userMessage`, so the bot does not echo `Codex\n<your text>` back into the same topic. User messages typed directly in Codex can still be mirrored as `User`.
For Codex CLI sessions that do not emit live app-server item events to this bridge process, the bridge polls the mapped session JSONL file and mirrors new `user_message` and `agent_message` entries.

## Fallback

The app-server proxy path is primary. A minimal CLI fallback wrapper is available for callers that explicitly set `CODEX_SYNC_MODE=cli`; it uses `codex exec` semantics and does not provide multi-topic app-server sync.

## Tests

```sh
npm test
```

Covered areas:

- JSON-RPC request/response matching, server requests, and reconnect.
- Persistent group/thread/topic/approval state.
- Telegram topic payloads, chunking, command parsing, and approval button payloads.
- `/bind`, `/new`, `/interrupt`, topic reply routing, and approval callbacks.
- Topic ops commands: `/help`, `/topics`, `/delete_all_topics`, `/unlink`, `/relink`, `/resync`, `/pause`, `/resume`, `/rename`, and `/logs`.
- Telegram-originated user message de-duplication.
- CLI session JSONL tailing for mapped CLI-created sessions.
