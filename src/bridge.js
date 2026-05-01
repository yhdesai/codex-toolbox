import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { approvalKeyboard, getCommand, isForumMessage } from './telegram.js';
import { approvalLabels, extractUserMessageText, renderApprovalPrompt, renderCodexEvent } from './mirror-policy.js';

const TELEGRAM_ECHO_SUPPRESSION_MS = 2 * 60 * 1000;
const PM2_LOG_LINES = 40;
const GLOBAL_ECHO_SUPPRESSION_KEY = '*';

export class CodexTelegramTopicBridge {
  constructor({ codex, telegram, state, pollMs = 5000, logger = console, allowedUserIds = [] }) {
    this.codex = codex;
    this.telegram = telegram;
    this.state = state;
    this.pollMs = pollMs;
    this.logger = logger;
    this.allowedUserIds = new Set(allowedUserIds.map((id) => String(id)));
    this.discoveryTimer = null;
    this.subscribedThreads = new Set();
    this.topicCreationFailures = new Set();
    this.lastTopicCreationFailure = null;
    this.topicCreationPausedUntilMs = 0;
    this.lastTelegramError = null;
    this.didInitialDiscovery = false;
    this.knownThreadUpdatedAt = new Map();
    this.startedAtMs = Date.now();
    this.agentMessageBuffers = new Map();
    this.telegramEchoSuppressions = new Map();
    this.lastDiscoveryStats = { seen: 0, created: 0, resumed: 0, skipped: 0 };
    this.sessionFilePaths = new Map();
    this.sessionFileOffsets = new Map();
  }

  async start() {
    this.telegram.on('update', (update) => this.#handleTelegramUpdate(update).catch((error) => this.#logError(error)));
    this.telegram.on('error', (error) => {
      this.lastTelegramError = error.message;
      this.#rememberError(`Telegram polling error: ${error.message}`);
      this.logger.error('Telegram polling error:', error.message);
    });
    this.codex.on('event', (event) => this.#mirrorCodexEvent(event).catch((error) => this.#logError(error)));
    this.codex.on('serverRequest', (request) => this.#mirrorApprovalRequest(request).catch((error) => this.#logError(error)));
    this.codex.on('disconnect', () => this.logger.warn('Codex app-server disconnected; reconnecting'));
    this.codex.on('ready', (info) => {
      if (info?.reconnect) this.discoverThreads().catch((error) => this.#logError(error));
    });

    await this.codex.start();
    await this.discoverThreads();
    this.discoveryTimer = setInterval(() => this.discoverThreads().catch((error) => this.#logError(error)), this.pollMs);
    this.telegram.startPolling().catch((error) => this.#logError(error));
  }

  async stop() {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.telegram.stopPolling();
    this.codex.stop();
  }

  async discoverThreads() {
    const threads = await this.codex.listThreads();
    const stats = { seen: 0, created: 0, resumed: 0, skipped: 0 };
    for (const thread of threads) {
      const threadId = thread.id ?? thread.threadId ?? thread.thread_id;
      if (!threadId) continue;
      stats.seen += 1;
      const threadKey = String(threadId);
      const sessionPath = thread.path ?? thread.rolloutPath ?? thread.rollout_path ?? null;
      const shouldPollSessionFile = sessionPath && (thread.source === 'cli' || thread.originator === 'codex-tui');
      if (shouldPollSessionFile) this.sessionFilePaths.set(threadKey, sessionPath);
      const updatedAt = String(thread.updatedAt ?? thread.updated_at ?? thread.modifiedAt ?? '');
      const createdAtMs = normalizeTimestampMs(thread.createdAt ?? thread.created_at);
      const wasKnown = this.knownThreadUpdatedAt.has(threadKey);
      const previousUpdatedAt = this.knownThreadUpdatedAt.get(threadKey);
      const hasMappedTopic = Boolean(this.state.getTopicForThread(threadId));
      const isNewlyDiscovered = this.didInitialDiscovery && !wasKnown && createdAtMs >= this.startedAtMs;
      const isOldThreadWithNewActivity = this.didInitialDiscovery && wasKnown && !hasMappedTopic && isAfterStartup(updatedAt, this.startedAtMs) && previousUpdatedAt && updatedAt !== previousUpdatedAt;

      this.knownThreadUpdatedAt.set(threadKey, updatedAt);

      if (hasMappedTopic && !this.subscribedThreads.has(threadKey)) {
        await this.codex.resumeThread(threadId);
        this.subscribedThreads.add(threadKey);
        stats.resumed += 1;
      }
      if (hasMappedTopic && shouldPollSessionFile && !this.sessionFileOffsets.has(threadKey)) {
        await this.#initializeSessionFileOffset(threadKey, sessionPath, 'end');
      }

      if (isNewlyDiscovered || isOldThreadWithNewActivity) {
        const topicId = await this.#ensureTopicForThread(threadId, thread);
        if (topicId && shouldPollSessionFile && !this.sessionFileOffsets.has(threadKey)) {
          await this.#initializeSessionFileOffset(threadKey, sessionPath, 'start');
        }
        if (topicId && !this.subscribedThreads.has(threadKey)) {
          await this.codex.resumeThread(threadId);
          this.subscribedThreads.add(threadKey);
          stats.resumed += 1;
        }
        if (topicId) {
          stats.created += 1;
        } else {
          stats.skipped += 1;
        }
      }
    }
    this.didInitialDiscovery = true;
    this.lastDiscoveryStats = stats;
    await this.#pollSessionFiles();
    return stats;
  }

  async #handleTelegramUpdate(update) {
    if (update.callback_query) {
      if (!this.#isAllowedUser(update.callback_query.from)) {
        await this.telegram.answerCallbackQuery(update.callback_query.id, 'You are not allowed to control this Codex bridge.');
        return;
      }
      await this.#handleCallback(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message?.text) return;
    if (!this.#isAllowedUser(message.from)) {
      return;
    }
    const command = getCommand(message);
    if (command === '/bind') {
      await this.#bind(message);
      return;
    }
    if (command === '/help') {
      await this.#help(message);
      return;
    }
    if (command === '/new') {
      await this.#newThread(message);
      return;
    }
    if (command === '/topics') {
      await this.#topics(message);
      return;
    }
    if (command === '/delete_all_topics') {
      await this.#deleteAllTopics(message);
      return;
    }
    if (command === '/unlink') {
      await this.#unlink(message);
      return;
    }
    if (command === '/relink') {
      await this.#relink(message);
      return;
    }
    if (command === '/resync') {
      await this.#resync(message);
      return;
    }
    if (command === '/pause') {
      await this.#pause(message);
      return;
    }
    if (command === '/resume') {
      await this.#resume(message);
      return;
    }
    if (command === '/rename') {
      await this.#rename(message);
      return;
    }
    if (command === '/logs') {
      await this.#logs(message);
      return;
    }
    if (command === '/status') {
      await this.#status(message);
      return;
    }
    if (command === '/interrupt') {
      await this.#interrupt(message);
      return;
    }
    await this.#routeTopicReply(message);
  }

  async #bind(message) {
    if (message.chat?.type !== 'supergroup') {
      await this.telegram.sendMessage({ chatId: message.chat.id, text: '/bind must be used in a forum-enabled supergroup.' });
      return;
    }
    await this.state.bindChat(message.chat.id);
    await this.telegram.sendMessage({ chatId: message.chat.id, text: 'Bound this Telegram forum group to Codex topic sync.' });
    await this.discoverThreads();
  }

  async #help(message) {
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: [
        'Codex Toolbox commands',
        '/bind - bind this forum group',
        '/new [--cwd /path] Optional title - create a Codex thread and topic',
        '/topics - list mapped Codex topics',
        '/delete_all_topics confirm - delete all Codex-mapped topics',
        '/unlink - remove mapping for this topic',
        '/relink <threadId> - link this topic to a Codex thread',
        '/resync - run discovery now',
        '/pause - pause Codex-to-Telegram mirroring',
        '/resume - resume mirroring',
        '/rename <title> - rename this topic and Codex thread',
        '/interrupt - interrupt this Codex thread',
        '/status - show bridge status',
        '/logs - show redacted diagnostics',
      ].join('\n'),
    });
  }

  async #newThread(message) {
    if (!this.state.boundChatId) {
      await this.telegram.sendMessage({ chatId: message.chat.id, text: 'Use /bind in the forum group before creating Codex threads.' });
      return;
    }
    const parsed = parseNewThreadArgs(message);
    if (parsed.error) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: parsed.error });
      return;
    }
    const cwd = parsed.cwd ? await resolveExistingDirectory(parsed.cwd) : null;
    if (parsed.cwd && !cwd) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: `Directory not found or not a directory: ${parsed.cwd}` });
      return;
    }
    const title = parsed.title || (cwd ? cwd.split('/').filter(Boolean).at(-1) : null) || 'Telegram thread';
    const threadId = await this.codex.createThread(title, { cwd });
    const topicId = await this.telegram.createForumTopic(this.state.boundChatId, title);
    await this.state.mapThread(threadId, topicId, title);
    await this.codex.resumeThread(threadId);
    this.subscribedThreads.add(String(threadId));
    await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId: topicId, text: `Created Codex thread ${threadId}${cwd ? `\nDirectory: ${cwd}` : ''}` });
  }

  async #status(message) {
    const stats = await this.discoverThreads();
    const mappedThreadCount = Object.keys(this.state.data?.threads ?? {}).length;
    const mappedTopicCount = Object.keys(this.state.data?.topics ?? {}).length;
    const pendingApprovalCount = Object.keys(this.state.data?.approvals ?? {}).length;
    const cooldownMs = Math.max(0, this.topicCreationPausedUntilMs - Date.now());
    const recentErrors = this.#recentErrors().slice(-3);
    const lines = [
      'Codex Toolbox status',
      `Bound group: ${this.state.boundChatId ?? 'not bound'}`,
      `Mirroring paused: ${this.state.data.paused?.mirroring ? 'yes' : 'no'}`,
      `Mapped threads: ${mappedThreadCount}`,
      `Mapped topics: ${mappedTopicCount}`,
      `Pending approvals: ${pendingApprovalCount}`,
      `Known Codex threads: ${this.knownThreadUpdatedAt.size}`,
      `Subscribed threads: ${this.subscribedThreads.size}`,
      `Allowed users: ${[...this.allowedUserIds].join(', ') || 'none'}`,
      `Topic creation cooldown: ${cooldownMs ? `${Math.ceil(cooldownMs / 1000)}s` : 'none'}`,
      `Last discovery: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}`,
      `Last topic error: ${this.lastTopicCreationFailure ?? 'none'}`,
      `Last Telegram polling error: ${this.lastTelegramError ?? 'none'}`,
      `Recent errors: ${recentErrors.length ? recentErrors.join(' | ') : 'none'}`,
    ];
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: lines.join('\n'),
    });
  }

  async #topics(message) {
    const threads = Object.values(this.state.data?.threads ?? {});
    const text = threads.length
      ? [
          'Mapped Codex topics',
          ...threads.map((thread) => `${thread.threadId} -> topic ${thread.messageThreadId}${thread.title ? ` -> ${thread.title}` : ''}`),
        ].join('\n')
      : 'No Codex topics are currently mapped.';
    await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text });
  }

  async #deleteAllTopics(message) {
    const args = commandArgs(message, '/delete_all_topics');
    if (args !== 'confirm') {
      await this.telegram.sendMessage({
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id,
        text: 'This deletes every Telegram topic mapped by the Codex bridge. Run /delete_all_topics confirm to continue.',
      });
      return;
    }
    if (!this.state.boundChatId) {
      await this.telegram.sendMessage({ chatId: message.chat.id, text: 'No Telegram forum group is bound.' });
      return;
    }
    const mappings = Object.values(this.state.data?.threads ?? {});
    const successes = [];
    const failures = [];
    for (const mapping of mappings) {
      try {
        await this.telegram.deleteForumTopic(this.state.boundChatId, mapping.messageThreadId);
        await this.state.unmapThread(mapping.threadId);
        successes.push(mapping);
      } catch (error) {
        failures.push({ mapping, error });
        await this.#rememberError(`delete topic ${mapping.messageThreadId}: ${error.message}`);
      }
    }
    await this.state.clearApprovals();
    await this.state.markDeletedThreadBaselines([...this.knownThreadUpdatedAt.keys()]);
    for (const threadId of this.knownThreadUpdatedAt.keys()) {
      const current = this.knownThreadUpdatedAt.get(threadId);
      this.knownThreadUpdatedAt.set(threadId, current || new Date().toISOString());
    }
    const lines = [
      'Delete all Codex topics complete.',
      `Deleted topics: ${successes.length}`,
      `Failed topics: ${failures.length}`,
      `Remaining mappings: ${Object.keys(this.state.data?.threads ?? {}).length}`,
    ];
    if (failures.length) {
      lines.push('Failures:');
      for (const failure of failures.slice(0, 10)) {
        lines.push(`topic ${failure.mapping.messageThreadId}: ${failure.error.message}`);
      }
    }
    await this.telegram.sendMessage({ chatId: message.chat.id, text: lines.join('\n') });
  }

  async #unlink(message) {
    const threadId = this.#threadIdForMessage(message);
    if (!threadId) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: '/unlink must be used inside a mapped Codex topic.' });
      return;
    }
    const unmapped = await this.state.unmapThread(threadId);
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: unmapped ? `Unlinked Codex thread ${threadId} from this topic.` : 'This topic was not mapped.',
    });
  }

  async #relink(message) {
    if (!isForumMessage(message)) {
      await this.telegram.sendMessage({ chatId: message.chat.id, text: '/relink must be used inside a Telegram forum topic.' });
      return;
    }
    const threadId = commandArgs(message, '/relink');
    if (!threadId) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: 'Usage: /relink <threadId>' });
      return;
    }
    const threads = await this.codex.listThreads();
    const thread = threads.find((candidate) => String(candidate.id ?? candidate.threadId ?? candidate.thread_id) === threadId);
    if (!thread) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: `Codex thread ${threadId} was not found.` });
      return;
    }
    await this.state.unmapTopic(message.message_thread_id);
    await this.state.unmapThread(threadId);
    await this.state.mapThread(threadId, message.message_thread_id, thread.title ?? thread.name ?? null);
    await this.codex.resumeThread(threadId);
    this.subscribedThreads.add(String(threadId));
    await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: `Relinked this topic to Codex thread ${threadId}.` });
  }

  async #resync(message) {
    const stats = await this.discoverThreads();
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: `Resync complete: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}.`,
    });
  }

  async #pause(message) {
    await this.state.setMirroringPaused(true);
    await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: 'Codex-to-Telegram mirroring paused. Telegram replies and admin commands still work.' });
  }

  async #resume(message) {
    await this.state.setMirroringPaused(false);
    const stats = await this.discoverThreads();
    await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: `Mirroring resumed. Resync: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}.` });
  }

  async #rename(message) {
    const threadId = this.#threadIdForMessage(message);
    if (!threadId) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: '/rename must be used inside a mapped Codex topic.' });
      return;
    }
    const title = commandArgs(message, '/rename');
    if (!title) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: 'Usage: /rename <title>' });
      return;
    }
    const topicId = this.state.getTopicForThread(threadId);
    await this.telegram.editForumTopic(this.state.boundChatId, topicId, title);
    await this.state.updateThreadTitle(threadId, title);
    let codexRenamed = true;
    if (typeof this.codex.renameThread === 'function') {
      try {
        await this.codex.renameThread(threadId, title);
      } catch (error) {
        codexRenamed = false;
        await this.#rememberError(`rename Codex thread ${threadId}: ${error.message}`);
      }
    }
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: codexRenamed ? `Renamed this topic to "${title}".` : `Renamed this Telegram topic to "${title}", but Codex thread rename failed.`,
    });
  }

  async #logs(message) {
    const text = await this.#readDiagnostics();
    await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text });
  }

  async #interrupt(message) {
    const threadId = this.#threadIdForMessage(message);
    if (!threadId) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: '/interrupt must be used inside a mapped Codex topic.' });
      return;
    }
    await this.codex.interrupt(threadId);
    await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: 'Interrupt requested.' });
  }

  async #routeTopicReply(message) {
    const threadId = this.#threadIdForMessage(message);
    if (!isForumMessage(message)) {
      await this.telegram.sendMessage({
        chatId: message.chat.id,
        text: 'This message is not inside a Telegram forum topic. Send messages inside a mapped Codex topic, or use /new to create a Codex thread topic.',
      });
      return;
    }
    if (!threadId) {
      await this.telegram.sendMessage({
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id,
        text: 'This Telegram topic is not linked to a Codex thread. Use /new to create a new Codex topic, or wait for a new/active Codex session to create one automatically.',
      });
      return;
    }
    try {
      this.#rememberTelegramEchoSuppression(threadId, message.text);
      await this.codex.sendToThread(threadId, message.text);
    } catch (error) {
      this.#forgetTelegramEchoSuppression(threadId, message.text);
      const text = error.steerRejected
        ? `Codex rejected steering this active turn: ${error.message}`
        : `Could not send message to Codex: ${error.message}`;
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text });
    }
  }

  async #handleCallback(callback) {
    const data = callback.data ?? '';
    if (!data.startsWith('approval:')) return;
    const [, callbackId, decision] = data.split(':');
    const approval = await this.state.takeApproval(callbackId);
    if (!approval) {
      await this.telegram.answerCallbackQuery(callback.id, 'Approval request expired.');
      return;
    }
    this.codex.answerServerRequest(approval.requestId, decision, { threadId: approval.threadId });
    await this.telegram.answerCallbackQuery(callback.id, `Sent ${decision}.`);
  }

  async #mirrorCodexEvent(event) {
    if (!this.state.boundChatId || !event.threadId) return;
    if (this.#consumeTelegramEchoSuppression(event)) return;
    if (this.state.data.paused?.mirroring) return;
    if (this.#bufferAgentMessageDelta(event)) return;
    const completedBufferedText = this.#takeCompletedAgentMessage(event);
    if (completedBufferedText) {
      const messageThreadId = await this.#ensureTopicForThread(event.threadId);
      if (!messageThreadId) return;
      await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId, text: completedBufferedText });
      return;
    }
    const text = renderCodexEvent(event);
    if (!text) return;
    const messageThreadId = await this.#ensureTopicForThread(event.threadId);
    if (!messageThreadId) return;
    await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId, text });
  }

  async #mirrorApprovalRequest(request) {
    if (!this.state.boundChatId) return;
    const messageThreadId = request.threadId ? this.state.getTopicForThread(request.threadId) : null;
    if (!messageThreadId) return;
    const callbackId = randomUUID();
    await this.state.rememberApproval(callbackId, { requestId: request.id, threadId: request.threadId });
    await this.telegram.sendMessage({
      chatId: this.state.boundChatId,
      messageThreadId,
      text: renderApprovalPrompt(request),
      replyMarkup: approvalKeyboard(callbackId, approvalLabels(request)),
    });
  }

  async #pollSessionFiles() {
    if (this.state.data.paused?.mirroring) return;
    for (const [threadId, sessionPath] of this.sessionFilePaths.entries()) {
      if (!this.state.getTopicForThread(threadId)) continue;
      try {
        await this.#pollSessionFile(threadId, sessionPath);
      } catch (error) {
        await this.#rememberError(`poll session ${threadId}: ${error.message}`);
      }
    }
  }

  async #pollSessionFile(threadId, sessionPath) {
    if (!this.sessionFileOffsets.has(threadId)) {
      await this.#initializeSessionFileOffset(threadId, sessionPath, 'end');
      return;
    }
    const info = await stat(sessionPath);
    const currentOffset = this.sessionFileOffsets.get(threadId) ?? 0;
    if (info.size <= currentOffset) {
      if (info.size < currentOffset) this.sessionFileOffsets.set(threadId, info.size);
      return;
    }
    const raw = await readFile(sessionPath);
    const chunk = raw.subarray(currentOffset).toString('utf8');
    this.sessionFileOffsets.set(threadId, raw.length);
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      const text = renderSessionLogLine(line);
      if (!text) continue;
      if (text.startsWith('User\n') && this.#consumeTextEchoSuppression(threadId, text.slice('User\n'.length))) continue;
      const messageThreadId = this.state.getTopicForThread(threadId);
      if (!messageThreadId) return;
      await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId, text });
    }
  }

  async #initializeSessionFileOffset(threadId, sessionPath, position) {
    try {
      const info = await stat(sessionPath);
      this.sessionFileOffsets.set(threadId, position === 'start' ? 0 : info.size);
    } catch {
      this.sessionFileOffsets.set(threadId, 0);
    }
  }

  #threadIdForMessage(message) {
    if (!message.message_thread_id) return null;
    return this.state.getThreadForTopic(message.message_thread_id);
  }

  #isAllowedUser(user) {
    if (this.allowedUserIds.size === 0) return false;
    return user?.id != null && this.allowedUserIds.has(String(user.id));
  }

  async #ensureTopicForThread(threadId, thread = null) {
    if (!this.state.boundChatId) return null;
    const existingTopicId = this.state.getTopicForThread(threadId);
    if (existingTopicId) return existingTopicId;
    if (Date.now() < this.topicCreationPausedUntilMs) return null;

    const title = thread?.title ?? thread?.name ?? `Codex ${String(threadId).slice(0, 8)}`;
    try {
      const topicId = await this.telegram.createForumTopic(this.state.boundChatId, title);
      this.topicCreationFailures.delete(String(threadId));
      await this.state.mapThread(threadId, topicId, title);
      await this.telegram.sendMessage({
        chatId: this.state.boundChatId,
        messageThreadId: topicId,
        text: `Linked Codex thread ${threadId}`,
      });
      return topicId;
    } catch (error) {
      this.#pauseTopicCreationIfRateLimited(error);
      await this.#notifyTopicCreationFailure(threadId, title, error);
      return null;
    }
  }

  async #notifyTopicCreationFailure(threadId, title, error) {
    const key = String(threadId);
    this.logger.error(error);
    this.lastTopicCreationFailure = `${title}: ${error.message}`;
    if (isRateLimited(error)) return;
    if (this.topicCreationFailures.has(key)) return;
    this.topicCreationFailures.add(key);
    try {
      await this.telegram.sendMessage({
        chatId: this.state.boundChatId,
        text: `Could not create Telegram topic for Codex thread "${title}": ${error.message}. Make the bot an admin with permission to create/manage topics, then run /bind again.`,
      });
    } catch (notifyError) {
      this.logger.error(notifyError);
    }
  }

  #pauseTopicCreationIfRateLimited(error) {
    if (!isRateLimited(error)) return;
    const retryAfterMs = Math.max(1, Number(error.retryAfter)) * 1000;
    this.topicCreationPausedUntilMs = Math.max(this.topicCreationPausedUntilMs, Date.now() + retryAfterMs);
  }

  async #rememberError(message) {
    if (typeof this.state.recordError === 'function') {
      await this.state.recordError(redact(String(message)));
    }
  }

  #logError(error) {
    this.#rememberError(error?.message ?? error).catch(() => {});
    this.logger.error(error);
  }

  #recentErrors() {
    return (this.state.data?.lastErrors ?? []).map((entry) => redact(entry.message ?? entry)).filter(Boolean);
  }

  async #readDiagnostics() {
    const sections = [
      'Codex Toolbox diagnostics',
      `Mirroring paused: ${this.state.data.paused?.mirroring ? 'yes' : 'no'}`,
      `Mapped topics: ${Object.keys(this.state.data?.topics ?? {}).length}`,
      `Recent errors: ${this.#recentErrors().slice(-5).join(' | ') || 'none'}`,
    ];
    const logPaths = [
      join(homedir(), '.pm2/logs/codex-toolbox-out.log'),
      join(homedir(), '.pm2/logs/codex-toolbox-error.log'),
      join(homedir(), '.pm2/logs/codex-telegram-topic-sync-out.log'),
      join(homedir(), '.pm2/logs/codex-telegram-topic-sync-error.log'),
    ];
    for (const logPath of logPaths) {
      try {
        const raw = await readFile(logPath, 'utf8');
        const tail = raw.split('\n').slice(-PM2_LOG_LINES).join('\n').trim();
        if (tail) sections.push(`${logPath}\n${redact(tail)}`);
      } catch {
        // Missing PM2 logs are fine; diagnostics still include in-memory state.
      }
    }
    return sections.join('\n\n');
  }

  #bufferAgentMessageDelta(event) {
    if (event.method !== 'item/agentMessage/delta') return false;
    const params = event.raw.params ?? {};
    const itemId = params.itemId ?? params.item_id ?? params.item?.id;
    const delta = params.delta;
    if (!itemId || typeof delta !== 'string') return false;
    const key = String(itemId);
    const current = this.agentMessageBuffers.get(key) ?? '';
    this.agentMessageBuffers.set(key, current + delta);
    return true;
  }

  #takeCompletedAgentMessage(event) {
    if (event.method !== 'item/completed') return null;
    const item = event.raw.params?.item;
    if (item?.type !== 'agentMessage' || !item.id) return null;
    const buffered = this.agentMessageBuffers.get(String(item.id));
    this.agentMessageBuffers.delete(String(item.id));
    const text = (buffered || item.text || '').trim();
    return text ? `Codex\n${text}` : null;
  }

  #rememberTelegramEchoSuppression(threadId, text) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) return;
    this.#pushTelegramEchoSuppression(String(threadId), normalizedText);
    this.#pushTelegramEchoSuppression(GLOBAL_ECHO_SUPPRESSION_KEY, normalizedText);
  }

  #pushTelegramEchoSuppression(key, normalizedText) {
    const now = Date.now();
    const suppressions = (this.telegramEchoSuppressions.get(key) ?? [])
      .filter((entry) => now - entry.createdAt <= TELEGRAM_ECHO_SUPPRESSION_MS);
    suppressions.push({ text: normalizedText, createdAt: now });
    this.telegramEchoSuppressions.set(key, suppressions);
  }

  #forgetTelegramEchoSuppression(threadId, text) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) return;
    this.#removeTelegramEchoSuppression(String(threadId), normalizedText);
    this.#removeTelegramEchoSuppression(GLOBAL_ECHO_SUPPRESSION_KEY, normalizedText);
  }

  #removeTelegramEchoSuppression(key, normalizedText) {
    const suppressions = this.telegramEchoSuppressions.get(key) ?? [];
    const index = suppressions.findIndex((entry) => entry.text === normalizedText);
    if (index >= 0) suppressions.splice(index, 1);
    if (suppressions.length) this.telegramEchoSuppressions.set(key, suppressions);
    else this.telegramEchoSuppressions.delete(key);
  }

  #consumeTelegramEchoSuppression(event) {
    const text = normalizeText(extractUserMessageText(event));
    if (!text) return false;
    return this.#consumeTextEchoSuppression(String(event.threadId), text);
  }

  #consumeTextEchoSuppression(threadId, text) {
    text = normalizeText(text);
    if (!text) return false;
    return this.#consumeTelegramEchoSuppressionForKey(String(threadId), text)
      || this.#consumeTelegramEchoSuppressionForKey(GLOBAL_ECHO_SUPPRESSION_KEY, text);
  }

  #consumeTelegramEchoSuppressionForKey(key, text) {
    const now = Date.now();
    const suppressions = this.telegramEchoSuppressions.get(key) ?? [];
    let matched = false;
    const remaining = [];
    for (const entry of suppressions) {
      if (now - entry.createdAt > TELEGRAM_ECHO_SUPPRESSION_MS) continue;
      if (!matched && entry.text === text) {
        matched = true;
        continue;
      }
      remaining.push(entry);
    }
    if (remaining.length) this.telegramEchoSuppressions.set(key, remaining);
    else this.telegramEchoSuppressions.delete(key);
    return matched;
  }
}

function normalizeTimestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
  if (/^\d+$/.test(String(value))) {
    const numeric = Number(value);
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isAfterStartup(value, startedAtMs) {
  return normalizeTimestampMs(value) >= startedAtMs;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isRateLimited(error) {
  return Number(error?.retryAfter) > 0 || error?.response?.error_code === 429;
}

function commandArgs(message, command) {
  return String(message.text ?? '').replace(new RegExp(`^${command}(?:@\\w+)?`, 'i'), '').trim();
}

function parseNewThreadArgs(message) {
  const args = commandArgs(message, '/new');
  const tokens = splitCommandTokens(args);
  if (tokens.error) return { error: tokens.error };
  let cwd = null;
  const titleParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--cwd' || token === '--dir') {
      const value = tokens[index + 1];
      if (!value) return { error: `Usage: /new --cwd /absolute/path Optional title` };
      cwd = expandHome(value);
      index += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = expandHome(token.slice('--cwd='.length));
      continue;
    }
    if (token.startsWith('--dir=')) {
      cwd = expandHome(token.slice('--dir='.length));
      continue;
    }
    titleParts.push(token);
  }
  if (cwd && !isAbsolute(cwd)) return { error: `Use an absolute directory path for --cwd. Got: ${cwd}` };
  return { cwd, title: titleParts.join(' ').trim() };
}

function splitCommandTokens(value) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) return { error: 'Unclosed quote in /new command.' };
  if (current) tokens.push(current);
  return tokens;
}

function expandHome(value) {
  const text = String(value ?? '').trim();
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

async function resolveExistingDirectory(value) {
  try {
    const resolved = await realpath(resolve(value));
    const info = await stat(resolved);
    return info.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function redact(value) {
  return String(value)
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[redacted-token]');
}

function renderSessionLogLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = entry.payload ?? {};
  if (entry.type !== 'event_msg') return null;
  if (payload.type === 'user_message' && payload.message) return `User\n${payload.message}`;
  if (payload.type === 'agent_message' && payload.message) return `Codex\n${payload.message}`;
  if (payload.type === 'plan_update' && payload.explanation) return `Plan\n${payload.explanation}`;
  if (payload.type === 'stream_error' || payload.type === 'error') return `Error\n${payload.message ?? payload.error ?? 'Unknown error'}`;
  if (payload.type === 'exec_command_begin') return `Tool: ${payload.command ?? 'command'}`;
  if (payload.type === 'exec_command_end') return `Tool: ${payload.command ?? 'command'}${payload.exit_code == null ? '' : ` (${payload.exit_code})`}`;
  return null;
}
