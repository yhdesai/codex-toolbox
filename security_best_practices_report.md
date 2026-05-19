# Codex Toolbox Security Review

Review date: 2026-05-02

## Executive Summary

The repository is clean of committed real Telegram bot tokens and the default allowlist is empty, which is a good baseline. The main security issues are runtime authorization boundaries: the bridge authorizes Telegram actions by user id, but it does not consistently verify that commands, topic replies, or approval callbacks came from the bound Telegram group and mapped topic. The second major risk is `/logs`, which can send local PM2 logs into Telegram after only narrow token-shaped redaction.

## High Severity

### H-1: Telegram actions are not scoped to the bound chat

Impact: An allowlisted Telegram account can trigger bridge commands or route messages from any chat where the bot receives updates, and topic id collisions across forum groups can route messages into Codex threads.

Evidence:

- `src/bridge.js:115-188` accepts any message from an allowlisted user and dispatches commands before checking whether the message chat is the bound group.
- `src/bridge.js:429-456` routes topic replies based on `message_thread_id` only.
- `src/bridge.js:550-552` resolves a Codex thread from only `message.message_thread_id`; it does not include `message.chat.id`.
- `src/state.js:59-62` stores topic mappings by `messageThreadId` only.

Why this matters:

- Telegram `message_thread_id` values are only meaningful within a chat, not globally.
- `/new`, `/delete_all_topics confirm`, `/pause`, `/resume`, `/logs`, `/relink`, and `/rename` can be invoked outside the bound group by an allowlisted user.
- A mistaken or compromised allowlisted user account in another group with the bot can affect the bound group's Codex bridge.

Recommended fix:

- Store mappings with both `chatId` and `messageThreadId`.
- Reject non-`/bind` commands unless `String(message.chat.id) === String(state.boundChatId)`.
- Route topic replies only when both chat id and topic id match the mapping.
- Add tests for commands and topic replies from a different chat with the same `message_thread_id`.

### H-2: `/logs` can leak sensitive local diagnostics into Telegram

Impact: Any allowlisted user can send recent PM2 log contents to the Telegram group, and the current redactor only catches Telegram-token-shaped values.

Evidence:

- `src/bridge.js:414-417` exposes `/logs`.
- `src/bridge.js:622-644` reads PM2 stdout/stderr logs and sends their tails to Telegram.
- `src/bridge.js:758-762` only redacts Telegram bot token patterns.
- `README.md:192` documents that `/logs` posts diagnostics to Telegram and warns users to avoid sensitive logs.

Why this matters:

- PM2 logs can contain local paths, command stderr, API keys, auth headers, stack traces, user prompts, repository names, and other sensitive operational data.
- Telegram forum groups may include more people than the local machine's trusted user boundary.

Recommended fix:

- Disable PM2 log tailing by default. Require an explicit env flag such as `CODEX_TOOLBOX_ENABLE_LOG_TAILS=1`.
- Keep `/logs` to in-memory redacted bridge errors by default.
- Extend redaction for common secret patterns: `*_TOKEN`, `*_KEY`, `*_SECRET`, `Authorization: Bearer`, GitHub tokens, OpenAI keys, SSH private key headers, and absolute home paths.
- Consider sending logs only as a private bot DM to the allowlisted user, not into the group topic.

## Medium Severity

### M-1: Approval callback decisions are not validated or context-bound

Impact: An allowlisted user can send a modified callback payload with an arbitrary decision string, and callbacks are accepted without verifying the callback's chat/topic matches the approval's thread topic.

Evidence:

- `src/telegram.js:119-128` generates callback data in the form `approval:<callbackId>:<decision>`.
- `src/bridge.js:458-469` splits the callback payload and forwards `decision` directly to Codex without checking it is one of `accept`, `decline`, or `cancel`.
- `src/state.js:127-140` stores only `{ requestId, threadId, createdAt }` for approvals, so callback handling cannot verify expected chat/topic context.

Recommended fix:

- Reject callback decisions outside `accept`, `decline`, and `cancel`.
- Store `chatId`, `messageThreadId`, and an expiry timestamp with each approval.
- In `#handleCallback`, verify `callback.message.chat.id` and `callback.message.message_thread_id` match the stored approval context.
- Expire approvals after a short TTL and clear pending approvals on app-server reconnect.

### M-2: Persistent state file permissions depend on the process umask

Impact: A permissive system umask can create `~/.codex-toolbox.json` readable by other local users.

Evidence:

- `src/state.js:143-148` writes the state file with `writeFile` and `rename`, but does not set file mode or chmod the temp/final file.
- The state file stores group ids, topic ids, thread mappings, pending approvals, and diagnostic errors.

Recommended fix:

- Write temp state files with mode `0o600`.
- `chmod(0o600)` the final state file after `rename`.
- Add a state persistence test that checks mode bits on POSIX platforms.

### M-3: Approval requests persist indefinitely

Impact: Old approval callbacks can remain actionable until clicked, even after the app-server request is stale or the process has restarted.

Evidence:

- `src/state.js:127-140` stores approvals persistently and removes them only when a callback is clicked.
- `src/bridge.js:490-501` creates approvals without TTL.
- `src/bridge.js:458-469` sends the stored approval decision without checking age.

Recommended fix:

- Add approval TTL enforcement, for example 10-30 minutes.
- Clear approvals on startup and app-server reconnect unless the app-server protocol provides a way to rehydrate active requests.

## Low Severity

### L-1: `/status` exposes operational identifiers into the group

Evidence:

- `src/bridge.js:237-264` includes bound group id, mapped topic counts, allowed user ids, and recent errors.

Recommended fix:

- Keep `/status` allowlisted, but consider redacting allowed user ids or only showing the count unless a verbose flag is set.

### L-2: CLI session JSONL tailing trusts app-server-provided paths

Evidence:

- `src/bridge.js:70-72` stores `thread.path` / rollout path from app-server.
- `src/bridge.js:516-538` reads that path and mirrors selected JSONL events.

Recommended fix:

- Optionally restrict tailed files to known Codex session directories under the user's home directory.
- Add a max file read size per poll to avoid large-file memory spikes; currently the whole file is read before slicing from the offset.

## Positive Findings

- No real Telegram bot tokens or user ids were found in the repository scan.
- `TELEGRAM_ALLOWED_USER_IDS` defaults to empty, so no Telegram user can control the bridge until explicitly configured.
- Child processes use `spawn(command, args)` without a shell, which avoids shell injection for `CODEX_APP_SERVER_ARGS` and the CLI fallback.
- Unauthorized normal Telegram messages are ignored silently, and unauthorized approval callbacks receive a denial response.
- Assistant deltas are buffered and lifecycle-only events are mostly suppressed, reducing accidental noisy/raw mirroring.

## Verification Notes

- `npm audit --audit-level=low` could not run because the repository has no lockfile.
- The project currently has no runtime dependencies in `package.json`, reducing third-party dependency risk.
