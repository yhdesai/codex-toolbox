import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chunkTelegramText } from './chunking.js';
import { approvalKeyboard, getCommand, isForumMessage } from './telegram.js';
import { approvalLabels, extractUserMessageText, renderApprovalPrompt, renderCodexEvent } from './mirror-policy.js';

const TELEGRAM_ECHO_SUPPRESSION_MS = 2 * 60 * 1000;
const MIRROR_DEDUPE_MS = 5 * 60 * 1000;
const TELEGRAM_STREAM_EDIT_INTERVAL_MS = 900;
const TELEGRAM_STREAM_TEXT_LIMIT = 3900;
const PM2_LOG_LINES = 40;
const PM2_LOG_TAIL_BYTES = 64 * 1024;
const DEBUG_NOTICE_THROTTLE_MS = 60 * 1000;
const GLOBAL_ECHO_SUPPRESSION_KEY = '*';
const DEFAULT_PROJECTS_ROOT = join(homedir(), 'projects-shiprdev');
const PROJECT_CONTAINER_SUFFIXES = ['.parent', '.erp'];
const NEW_THREAD_SELECTION_TTL_MS = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);
const TELEGRAM_COMMANDS = [
  { command: 'new', description: 'Create a Codex topic' },
  { command: 'topics', description: 'List mapped Codex topics' },
  { command: 'status', description: 'Show bridge status' },
  { command: 'interrupt', description: 'Interrupt the current Codex turn' },
  { command: 'rename', description: 'Rename this topic' },
  { command: 'pause', description: 'Pause Codex-to-Telegram mirroring' },
  { command: 'resume', description: 'Resume mirroring' },
  { command: 'help', description: 'Show commands and workflow' },
];

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
    this.pendingResumeThreads = new Set();
    this.topicCreationFailures = new Set();
    this.lastTopicCreationFailure = null;
    this.topicCreationPausedUntilMs = 0;
    this.lastTelegramError = null;
    this.didInitialDiscovery = false;
    this.knownThreadUpdatedAt = new Map();
    this.startedAtMs = Date.now();
    this.agentMessageBuffers = new Map();
    this.agentMessageStreams = new Map();
    this.telegramEchoSuppressions = new Map();
    this.recentMirroredMessages = new Map();
    this.lastDiscoveryStats = { seen: 0, created: 0, resumed: 0, skipped: 0 };
    this.sessionFilePaths = new Map();
    this.sessionFileOffsets = new Map();
    this.newThreadSelections = new Map();
    this.pendingWorktreeCreates = new Map();
    this.debugNotices = new Map();
  }

  async start() {
    this.telegram.on('update', (update) => this.#handleTelegramUpdate(update).catch((error) => this.#logError(error)));
    this.telegram.on('error', (error) => {
      this.lastTelegramError = error.message;
      this.#rememberError(`Telegram polling error: ${error.message}`);
      this.logger.error('Telegram polling error:', error.message);
    });
    this.telegram.on('rateLimit', (event) => {
      const seconds = Math.ceil((event.retryAfterMs ?? 0) / 1000);
      this.#rememberError(`Telegram rate limit on ${event.method}; retrying after ${seconds}s`);
      this.logger.warn(`Telegram rate limit on ${event.method}; retrying after ${seconds}s`);
    });
    this.codex.on('event', (event) => this.#mirrorCodexEvent(event).catch((error) => this.#logError(error)));
    this.codex.on('serverRequest', (request) => this.#mirrorApprovalRequest(request).catch((error) => this.#logError(error)));
    this.codex.on('disconnect', () => this.logger.warn('Codex app-server disconnected; reconnecting'));
    this.codex.on('ready', (info) => {
      if (info?.reconnect) this.discoverThreads().catch((error) => this.#logError(error));
    });

    await this.codex.start();
    await this.#installTelegramCommandMenu();
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
      const shouldPollSessionFile = Boolean(sessionPath);
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
        if (this.#queueResumeThreadForSubscription(threadId)) {
          stats.resumed += 1;
        } else {
          stats.skipped += 1;
        }
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
          if (this.#queueResumeThreadForSubscription(threadId)) {
            stats.resumed += 1;
          } else {
            stats.skipped += 1;
          }
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
    if (await this.#handlePendingWorktreeCreate(message)) {
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
      text: helpText(),
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
    if (!parsed.cwd) {
      await this.#showProjectPicker(message, parsed.title);
      return;
    }
    const cwd = await resolveExistingDirectory(parsed.cwd);
    if (parsed.cwd && !cwd) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: `Directory not found or not a directory: ${parsed.cwd}` });
      return;
    }
    await this.#createThreadAndTopic({ title: parsed.title || basename(cwd), cwd });
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
    const subscribed = await this.#resumeThreadForSubscription(threadId);
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: subscribed
        ? `Relinked this topic to Codex thread ${threadId}.`
        : `Relinked this topic to Codex thread ${threadId}, but subscribing to live updates timed out. Replies can still start a new turn.`,
    });
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
    if (data.startsWith('new:')) {
      await this.#handleNewThreadCallback(callback);
      return;
    }
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

  async #showProjectPicker(message, title) {
    const projects = await listProjects();
    if (!projects.length) {
      await this.telegram.sendMessage({
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id,
        text: `No projects found in ${projectsRoot()}.`,
      });
      return;
    }
    const selectionId = this.#rememberNewThreadSelection({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      title,
    });
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: 'Select a project for the new Codex session.',
      replyMarkup: inlineKeyboard([
        ...projects.map((project) => ({
          text: project.label,
          callback_data: `new:project:${selectionId}:${project.index}`,
        })),
        { text: 'Help', callback_data: `new:help:${selectionId}` },
      ], 1),
    });
  }

  async #showWorktreePicker(callback, selection, project) {
    selection.project = project.label;
    selection.projectPath = project.path;
    selection.projectIsContainer = Boolean(project.isContainer);
    const worktrees = project.isContainer ? [] : await listWorktrees(project.path);
    const buttons = [];
    if (project.isContainer) {
      buttons.push({
        text: `Use ${project.label} parent folder`,
        callback_data: `new:project-root:${selection.id}`,
      });
    }
    buttons.push(...worktrees.map((worktree) => ({
      text: worktree.name,
      callback_data: `new:worktree:${selection.id}:${worktree.index}`,
    })));
    if (!project.isContainer) {
      buttons.push({ text: 'Create new worktree', callback_data: `new:create-worktree:${selection.id}` });
    }
    buttons.push({ text: 'Help', callback_data: `new:help:${selection.id}` });
    await this.telegram.sendMessage({
      chatId: selection.chatId,
      messageThreadId: selection.messageThreadId,
      text: `Project: ${project.label}\n${project.isContainer ? 'Select where to start.' : 'Select a worktree.'}`,
      replyMarkup: inlineKeyboard(buttons, 1),
    });
    await this.telegram.answerCallbackQuery(callback.id, 'Project selected.');
  }

  async #handleNewThreadCallback(callback) {
    const parts = String(callback.data ?? '').split(':');
    const action = parts[1];
    const selectionId = parts[2];
    const selection = this.#getNewThreadSelection(selectionId);
    if (!selection) {
      await this.telegram.answerCallbackQuery(callback.id, 'This /new selection expired. Run /new again.');
      return;
    }
    if (action === 'project') {
      const projects = await listProjects();
      const project = projects[Number(parts[3])];
      if (!project) {
        await this.telegram.answerCallbackQuery(callback.id, 'Project was not found.');
        return;
      }
      await this.#showWorktreePicker(callback, selection, project);
      return;
    }
    if (action === 'project-root') {
      await this.telegram.answerCallbackQuery(callback.id, 'Creating Codex topic.');
      await this.#createThreadAndTopic({
        title: selection.title || selection.project,
        cwd: selection.projectPath,
      });
      this.newThreadSelections.delete(selection.id);
      return;
    }
    if (action === 'worktree') {
      const worktrees = await listWorktrees(selection.projectPath);
      const worktree = worktrees[Number(parts[3])];
      if (!worktree) {
        await this.telegram.answerCallbackQuery(callback.id, 'Worktree was not found.');
        return;
      }
      await this.telegram.answerCallbackQuery(callback.id, 'Creating Codex topic.');
      await this.#createThreadAndTopic({
        title: selection.title || `${selection.project}/${worktree.name}`,
        cwd: worktree.path,
      });
      this.newThreadSelections.delete(selection.id);
      return;
    }
    if (action === 'create-worktree') {
      const key = pendingWorktreeKey(callback.from, selection.chatId);
      this.pendingWorktreeCreates.set(key, { ...selection, createdAt: Date.now() });
      await this.telegram.answerCallbackQuery(callback.id, 'Send the new worktree name.');
      await this.telegram.sendMessage({
        chatId: selection.chatId,
        messageThreadId: selection.messageThreadId,
        text: `Send the new worktree folder name for ${selection.project}.`,
      });
      return;
    }
    if (action === 'help') {
      await this.telegram.answerCallbackQuery(callback.id, 'Help opened.');
      await this.telegram.sendMessage({
        chatId: selection.chatId,
        messageThreadId: selection.messageThreadId,
        text: helpText(),
      });
    }
  }

  async #installTelegramCommandMenu() {
    if (typeof this.telegram.setMyCommands !== 'function') return;
    try {
      await this.telegram.setMyCommands(TELEGRAM_COMMANDS);
    } catch (error) {
      await this.#rememberError(`set Telegram commands: ${error.message}`);
      this.logger.warn?.('Could not set Telegram command menu:', error.message);
    }
  }

  async #handlePendingWorktreeCreate(message) {
    const key = pendingWorktreeKey(message.from, message.chat.id);
    const pending = this.pendingWorktreeCreates.get(key);
    if (!pending) return false;
    if (Date.now() - pending.createdAt > NEW_THREAD_SELECTION_TTL_MS) {
      this.pendingWorktreeCreates.delete(key);
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: 'That worktree prompt expired. Run /new again.' });
      return true;
    }
    const name = sanitizeWorktreeName(message.text);
    if (!name) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: 'Use letters, numbers, dots, dashes, and underscores for the worktree folder name.' });
      return true;
    }
    const cwd = join(pending.projectPath, name);
    const existing = await resolveExistingDirectory(cwd);
    if (existing) {
      this.pendingWorktreeCreates.delete(key);
      await this.#createThreadAndTopic({ title: pending.title || `${pending.project}/${name}`, cwd: existing });
      return true;
    }
    try {
      await createGitWorktree(pending.projectPath, name);
    } catch (error) {
      await this.telegram.sendMessage({ chatId: message.chat.id, messageThreadId: message.message_thread_id, text: `Could not create worktree "${name}": ${error.message}` });
      return true;
    }
    this.pendingWorktreeCreates.delete(key);
    this.newThreadSelections.delete(pending.id);
    await this.telegram.sendMessage({
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      text: `Created worktree "${name}".\nDirectory: ${cwd}`,
    });
    await this.#createThreadAndTopic({ title: pending.title || `${pending.project}/${name}`, cwd });
    return true;
  }

  async #createThreadAndTopic({ title, cwd }) {
    title = title || basename(cwd) || 'Telegram thread';
    const threadId = await this.codex.createThread(title, { cwd });
    const topicId = await this.telegram.createForumTopic(this.state.boundChatId, title);
    await this.state.mapThread(threadId, topicId, title);
    await this.#resumeThreadForSubscription(threadId);
    await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId: topicId, text: `Created Codex thread ${threadId}\nDirectory: ${cwd}` });
  }

  async #resumeThreadForSubscription(threadId) {
    const threadKey = String(threadId);
    try {
      await this.codex.resumeThread(threadId);
      this.subscribedThreads.add(threadKey);
      return true;
    } catch (error) {
      await this.#rememberError(`resume Codex thread ${threadKey}: ${error.message}`);
      this.logger.warn?.(`Could not resume Codex thread ${threadKey}: ${error.message}`);
      return false;
    }
  }

  #queueResumeThreadForSubscription(threadId) {
    const threadKey = String(threadId);
    if (this.subscribedThreads.has(threadKey) || this.pendingResumeThreads.has(threadKey)) return false;
    this.pendingResumeThreads.add(threadKey);
    this.#resumeThreadForSubscription(threadId)
      .catch((error) => this.#logError(error))
      .finally(() => this.pendingResumeThreads.delete(threadKey));
    return true;
  }

  #rememberNewThreadSelection(selection) {
    this.#pruneNewThreadSelections();
    const id = randomUUID().slice(0, 8);
    this.newThreadSelections.set(id, { id, ...selection, createdAt: Date.now() });
    return id;
  }

  #getNewThreadSelection(id) {
    this.#pruneNewThreadSelections();
    return this.newThreadSelections.get(id) ?? null;
  }

  #pruneNewThreadSelections() {
    const now = Date.now();
    for (const [id, selection] of this.newThreadSelections.entries()) {
      if (now - selection.createdAt > NEW_THREAD_SELECTION_TTL_MS) this.newThreadSelections.delete(id);
    }
    for (const [key, pending] of this.pendingWorktreeCreates.entries()) {
      if (now - pending.createdAt > NEW_THREAD_SELECTION_TTL_MS) this.pendingWorktreeCreates.delete(key);
    }
  }

  async #mirrorCodexEvent(event) {
    if (!this.state.boundChatId || !event.threadId) return;
    if (this.#consumeTelegramEchoSuppression(event)) {
      return;
    }
    if (this.state.data.paused?.mirroring) {
      await this.#debugMirrorSkip(event.threadId, 'mirroring is paused', event.method);
      return;
    }
    if (isCompletionEvent(event)) {
      await this.#sendCompletionNotice(event.threadId, 'app-server turn completed');
      return;
    }
    if (await this.#streamAgentMessageDelta(event)) return;
    const completedAgentMessage = this.#takeCompletedAgentMessage(event);
    if (completedAgentMessage) {
      const messageThreadId = await this.#ensureTopicForThread(event.threadId);
      if (!messageThreadId) {
        await this.#debugMirrorSkip(event.threadId, 'no Telegram topic is mapped for this Codex thread', event.method);
        return;
      }
      await this.#finalizeAgentMessageStream(event.threadId, messageThreadId, completedAgentMessage);
      return;
    }
    const text = renderCodexEvent(event);
    if (!text) {
      if (isMessageLikeCodexEvent(event)) {
        await this.#debugMirrorSkip(event.threadId, 'app-server event had no mirrorable text', event.method);
      }
      return;
    }
    const messageThreadId = await this.#ensureTopicForThread(event.threadId);
    if (!messageThreadId) {
      await this.#debugMirrorSkip(event.threadId, 'no Telegram topic is mapped for this Codex thread', event.method);
      return;
    }
    await this.#sendMirroredMessage(event.threadId, messageThreadId, text);
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
    if (this.state.data.paused?.mirroring) {
      for (const threadId of this.sessionFilePaths.keys()) {
        await this.#debugMirrorSkip(threadId, 'session file polling skipped because mirroring is paused');
      }
      return;
    }
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
      const rendered = renderSessionLogLine(line);
      if (!rendered.text) {
        if (rendered.debugReason) await this.#debugMirrorSkip(threadId, rendered.debugReason);
        continue;
      }
      const text = rendered.text;
      if (text.startsWith('User\n') && this.#consumeTextEchoSuppression(threadId, text.slice('User\n'.length))) {
        continue;
      }
      const messageThreadId = this.state.getTopicForThread(threadId);
      if (!messageThreadId) {
        await this.#debugMirrorSkip(threadId, 'no Telegram topic is mapped for this Codex thread');
        return;
      }
      if (rendered.priority === 'high') {
        await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId, text, priority: 'high' });
      } else {
        await this.#sendMirroredMessage(threadId, messageThreadId, text);
      }
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
        const raw = await readFileTail(logPath, PM2_LOG_TAIL_BYTES);
        const tail = raw.split('\n').slice(-PM2_LOG_LINES).join('\n').trim();
        if (tail) sections.push(`${logPath}\n${redact(tail)}`);
      } catch {
        // Missing PM2 logs are fine; diagnostics still include in-memory state.
      }
    }
    return sections.join('\n\n');
  }

  async #streamAgentMessageDelta(event) {
    if (event.method !== 'item/agentMessage/delta') return false;
    const params = event.raw.params ?? {};
    const itemId = params.itemId ?? params.item_id ?? params.item?.id;
    const delta = params.delta;
    if (!itemId || typeof delta !== 'string') return false;
    const key = String(itemId);
    const current = this.agentMessageBuffers.get(key) ?? '';
    const next = current + delta;
    this.agentMessageBuffers.set(key, next);
    const messageThreadId = await this.#ensureTopicForThread(event.threadId);
    if (!messageThreadId) return true;
    await this.#updateAgentMessageStream(event.threadId, messageThreadId, key, next, false);
    return true;
  }

  #takeCompletedAgentMessage(event) {
    if (event.method !== 'item/completed') return null;
    const item = event.raw.params?.item;
    if (item?.type !== 'agentMessage' || !item.id) return null;
    const itemId = String(item.id);
    const buffered = this.agentMessageBuffers.get(itemId);
    this.agentMessageBuffers.delete(itemId);
    const text = (buffered || item.text || '').trim();
    return text ? { itemId, text: `Codex\n${text}` } : null;
  }

  async #updateAgentMessageStream(threadId, messageThreadId, itemId, text, force) {
    const renderedText = `Codex\n${text.trim()}`;
    if (!renderedText.trim()) {
      await this.#debugMirrorSkip(threadId, 'agent stream delta was empty');
      return;
    }
    if (this.#rememberMirroredMessage(threadId, renderedText, { dryRun: true })) {
      return;
    }
    if (renderedText.length > TELEGRAM_STREAM_TEXT_LIMIT) {
      await this.#debugMirrorSkip(threadId, `agent stream delta exceeded ${TELEGRAM_STREAM_TEXT_LIMIT} characters`);
      return;
    }

    const stream = this.agentMessageStreams.get(itemId);
    if (!stream) {
      const nextStream = {
        messageId: null,
        sentText: renderedText,
        pendingText: renderedText,
        lastEditedAt: Date.now(),
        creating: true,
      };
      this.agentMessageStreams.set(itemId, nextStream);
      const sent = await this.telegram.sendMessage({
        chatId: this.state.boundChatId,
        messageThreadId,
        text: renderedText,
      });
      const firstMessage = Array.isArray(sent) ? sent[0] : sent;
      nextStream.messageId = firstMessage?.message_id ?? null;
      nextStream.creating = false;
      nextStream.lastEditedAt = Date.now();
      if (nextStream.messageId && nextStream.pendingText !== nextStream.sentText) {
        await this.telegram.editMessageText({
          chatId: this.state.boundChatId,
          messageId: nextStream.messageId,
          text: nextStream.pendingText,
        });
        nextStream.sentText = nextStream.pendingText;
        nextStream.lastEditedAt = Date.now();
      }
      return;
    }

    if (stream.pendingText === renderedText) return;
    stream.pendingText = renderedText;
    if (stream.creating || !stream.messageId) return;
    const now = Date.now();
    if (!force && now - stream.lastEditedAt < TELEGRAM_STREAM_EDIT_INTERVAL_MS) return;
    await this.telegram.editMessageText({
      chatId: this.state.boundChatId,
      messageId: stream.messageId,
      text: renderedText,
    });
    stream.sentText = renderedText;
    stream.lastEditedAt = now;
  }

  async #finalizeAgentMessageStream(threadId, messageThreadId, message) {
    const stream = this.agentMessageStreams.get(message.itemId);
    this.agentMessageStreams.delete(message.itemId);
    if (this.#rememberMirroredMessage(threadId, message.text)) return;

    if (!stream?.messageId) {
      await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId, text: message.text });
      return;
    }
    const [firstChunk, ...remainingChunks] = chunkTelegramText(message.text);
    if (stream.sentText !== firstChunk) {
      await this.telegram.editMessageText({
        chatId: this.state.boundChatId,
        messageId: stream.messageId,
        text: firstChunk,
      });
    }
    for (const chunk of remainingChunks) {
      await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId, text: chunk });
    }
  }

  async #sendMirroredMessage(threadId, messageThreadId, text) {
    if (this.#rememberMirroredMessage(threadId, text)) {
      return;
    }
    await this.telegram.sendMessage({ chatId: this.state.boundChatId, messageThreadId, text });
  }

  async #debugMirrorSkip(threadId, reason, detail = null) {
    const messageThreadId = this.state.getTopicForThread(threadId);
    if (!this.state.boundChatId || !messageThreadId) return;
    const key = `${threadId}:${reason}:${detail ?? ''}`;
    const now = Date.now();
    const lastSentAt = this.debugNotices.get(key) ?? 0;
    if (now - lastSentAt < DEBUG_NOTICE_THROTTLE_MS) return;
    this.debugNotices.set(key, now);
    await this.telegram.sendMessage({
      chatId: this.state.boundChatId,
      messageThreadId,
      text: `Debug: Codex message not sent to Telegram.\nReason: ${reason}${detail ? `\nCheck: ${detail}` : ''}`,
    });
  }

  async #sendCompletionNotice(threadId, reason, detail = null) {
    const messageThreadId = this.state.getTopicForThread(threadId);
    if (!this.state.boundChatId || !messageThreadId) return;
    const pending = typeof this.telegram.pendingOutboundCount === 'function'
      ? this.telegram.pendingOutboundCount()
      : 0;
    const backlog = pending > 0 ? `\nTelegram backlog still sending: ${pending} queued item${pending === 1 ? '' : 's'}.` : '';
    await this.telegram.sendMessage({
      chatId: this.state.boundChatId,
      messageThreadId,
      text: `Status: Codex task complete.${detail ? `\n${detail}` : ''}${backlog}\nReason: ${reason}`,
      priority: 'high',
    });
  }

  #rememberMirroredMessage(threadId, text, options = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) return false;
    const key = String(threadId);
    const now = Date.now();
    const recent = (this.recentMirroredMessages.get(key) ?? [])
      .filter((entry) => now - entry.createdAt <= MIRROR_DEDUPE_MS);
    const duplicate = recent.some((entry) => entry.text === normalizedText);
    if (options.dryRun) return duplicate;
    if (!duplicate) recent.push({ text: normalizedText, createdAt: now });
    if (recent.length) this.recentMirroredMessages.set(key, recent);
    else this.recentMirroredMessages.delete(key);
    return duplicate;
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

async function listProjects() {
  const root = projectsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const entry of entries) {
    if (!isProjectDirectoryEntry(entry)) continue;
    const projectPath = join(root, entry.name);
    if (isProjectContainer(entry.name)) {
      projects.push({
        name: entry.name,
        label: entry.name,
        path: projectPath,
        isContainer: true,
      });
      const childEntries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
      for (const child of childEntries) {
        if (!isProjectDirectoryEntry(child)) continue;
        const childPath = join(projectPath, child.name);
        if (await hasSelectableWorktree(childPath)) {
          projects.push({
            name: `${entry.name}/${child.name}`,
            label: `${entry.name}/${child.name}`,
            path: childPath,
          });
        }
      }
      continue;
    }
    if (await hasSelectableWorktree(projectPath)) projects.push({ name: entry.name, label: entry.name, path: projectPath });
  }
  return projects
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project, index) => ({ ...project, index }));
}

function projectsRoot() {
  return process.env.CODEX_PROJECTS_ROOT || DEFAULT_PROJECTS_ROOT;
}

async function listWorktrees(projectPath) {
  const entries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
  const worktrees = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const worktreePath = join(projectPath, entry.name);
    if (await isGitWorktree(worktreePath)) worktrees.push({ name: entry.name, path: worktreePath });
  }
  if (!worktrees.length && await isGitWorktree(projectPath)) {
    worktrees.push({ name: await currentGitBranch(projectPath), path: projectPath });
  }
  return worktrees
    .sort((a, b) => {
      if (a.name === 'main') return -1;
      if (b.name === 'main') return 1;
      if (a.name === 'dev') return -1;
      if (b.name === 'dev') return 1;
      return a.name.localeCompare(b.name);
    })
    .map((worktree, index) => ({ ...worktree, index }));
}

function isProjectDirectoryEntry(entry) {
  return entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'codex-sync' && entry.name !== 'node_modules';
}

function isProjectContainer(name) {
  return PROJECT_CONTAINER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function hasSelectableWorktree(projectPath) {
  return (await listWorktrees(projectPath)).length > 0;
}

async function isGitWorktree(dir) {
  try {
    await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function currentGitBranch(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : basename(dir);
  } catch {
    return basename(dir);
  }
}

async function createGitWorktree(projectPath, name) {
  const source = await findWorktreeSource(projectPath);
  if (!source) throw new Error(`No existing git worktree found in ${projectPath}`);
  const branch = name;
  try {
    await execFileAsync('git', ['-C', source, 'worktree', 'add', '-b', branch, join('..', name)], { timeout: 120000 });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(detail || error.message);
  }
}

async function findWorktreeSource(projectPath) {
  const worktrees = await listWorktrees(projectPath);
  return (worktrees.find((worktree) => worktree.name === 'main') ?? worktrees[0])?.path ?? null;
}

function inlineKeyboard(buttons, columns = 2) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += columns) {
    rows.push(buttons.slice(index, index + columns));
  }
  return { inline_keyboard: rows };
}

function pendingWorktreeKey(user, chatId) {
  return `${chatId}:${user?.id ?? 'unknown'}`;
}

function helpText() {
  return [
    'Codex Toolbox commands',
    '/bind - bind this forum group',
    '/new Optional title - choose a project and worktree for a new Codex topic',
    '/new --cwd /path Optional title - create a Codex thread from an exact directory',
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
  ].join('\n');
}

function sanitizeWorktreeName(value) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(text)) return null;
  if (text === '.' || text === '..' || text.includes('..')) return null;
  return text;
}

function redact(value) {
  return String(value)
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[redacted-token]');
}

async function readFileTail(path, maxBytes) {
  const info = await stat(path);
  const start = Math.max(0, info.size - maxBytes);
  const length = info.size - start;
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function renderSessionLogLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { text: null, debugReason: 'session log line was not valid JSON' };
  }
  const payload = entry.payload ?? {};
  if (entry.type === 'response_item') return renderResponseItem(payload);
  if (entry.type !== 'event_msg') return { text: null };
  if (payload.type === 'user_message') {
    return payload.message
      ? { text: `User\n${payload.message}` }
      : { text: null, debugReason: 'session user_message had no message text' };
  }
  if (payload.type === 'agent_message') {
    return payload.message
      ? { text: `Codex\n${payload.message}` }
      : { text: null, debugReason: 'session agent_message had no message text' };
  }
  if (payload.type === 'plan_update' && payload.explanation) return { text: `Plan\n${payload.explanation}` };
  if (payload.type === 'stream_error' || payload.type === 'error') return { text: `Error\n${payload.message ?? payload.error ?? 'Unknown error'}` };
  if (payload.type === 'exec_command_begin') return { text: `Tool: ${payload.command ?? 'command'}` };
  if (payload.type === 'exec_command_end') return { text: `Tool: ${payload.command ?? 'command'}${payload.exit_code == null ? '' : ` (${payload.exit_code})`}` };
  if (payload.type === 'task_complete') {
    const duration = formatDuration(payload.duration_ms);
    const detail = duration ? `\nDuration: ${duration}` : '';
    return { text: `Status: Codex task complete.${detail}`, priority: 'high' };
  }
  return { text: null };
}

function renderResponseItem(payload) {
  if (payload.type !== 'message') return { text: null };
  const role = payload.role === 'user' ? 'User' : payload.role === 'assistant' ? 'Codex' : null;
  if (!role) return { text: null, debugReason: `response_item message had unsupported role: ${payload.role ?? 'missing'}` };
  const text = extractResponseItemText(payload.content);
  return text ? { text: `${role}\n${text}` } : { text: null, debugReason: `response_item ${payload.role} message had no text content` };
}

function extractResponseItemText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      return part?.text ?? part?.output_text ?? part?.input_text ?? '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function isMessageLikeCodexEvent(event) {
  const params = event.raw?.params ?? {};
  const type = params.type ?? params.item?.type ?? '';
  const role = params.role ?? params.item?.role ?? '';
  return type === 'userMessage'
    || type === 'agentMessage'
    || role === 'user'
    || role === 'assistant'
    || typeof params.text === 'string'
    || typeof params.message === 'string'
    || typeof params.item?.text === 'string'
    || Array.isArray(params.content)
    || Array.isArray(params.item?.content);
}

function isCompletionEvent(event) {
  return /turn\/(completed|done)$/i.test(event.method);
}

function formatDuration(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
