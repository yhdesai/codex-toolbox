import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chunkTelegramText } from './chunking.js';
import { approvalComponents, getDiscordCommand, getDiscordCommandArgs } from './discord.js';
import { approvalLabels, extractUserMessageText, renderApprovalPrompt, renderCodexEvent } from './mirror-policy.js';

const ECHO_SUPPRESSION_MS = 2 * 60 * 1000;
const MIRROR_DEDUPE_MS = 5 * 60 * 1000;
const DEBUG_NOTICE_THROTTLE_MS = 60 * 1000;
const DISCORD_STREAM_TEXT_LIMIT = 1900;
const PM2_LOG_LINES = 40;
const PM2_LOG_TAIL_BYTES = 64 * 1024;
const GLOBAL_ECHO_SUPPRESSION_KEY = '*';
const DEFAULT_PROJECTS_ROOT = join(homedir(), 'projects-shiprdev');
const PROJECT_CONTAINER_SUFFIXES = ['.parent', '.erp'];
const NEW_THREAD_SELECTION_TTL_MS = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);

export class CodexDiscordChannelBridge {
  constructor({
    codex,
    discord,
    state,
    pollMs = 5000,
    logger = console,
    allowedUserIds = [],
    projectName = basename(resolve(process.cwd())),
    commandPrefix = '!codex',
    guildId = null,
    messageScope = 'all',
    aiControlBaseUrl = 'http://localhost:11024',
    aiControlDiscordSecret = '',
    aiControlTenantId = '',
  }) {
    this.codex = codex;
    this.discord = discord;
    this.state = state;
    this.pollMs = pollMs;
    this.logger = logger;
    this.allowedUserIds = new Set(allowedUserIds.map((id) => String(id)));
    this.projectName = projectName || 'Codex Project';
    this.commandPrefix = commandPrefix;
    this.guildId = guildId == null ? null : String(guildId);
    this.messageScope = normalizeMessageScope(messageScope);
    this.aiControlBaseUrl = String(aiControlBaseUrl || 'http://localhost:11024').replace(/\/+$/, '');
    this.aiControlDiscordSecret = aiControlDiscordSecret || '';
    this.aiControlTenantId = aiControlTenantId || '';
    this.discoveryTimer = null;
    this.didInitialDiscovery = false;
    this.knownThreadUpdatedAt = new Map();
    this.startedAtMs = Date.now();
    this.subscribedThreads = new Set();
    this.pendingResumeThreads = new Set();
    this.agentMessageBuffers = new Map();
    this.echoSuppressions = new Map();
    this.recentMirroredMessages = new Map();
    this.sessionFilePaths = new Map();
    this.sessionFileOffsets = new Map();
    this.debugNotices = new Map();
    this.newThreadSelections = new Map();
    this.lastDiscoveryStats = { seen: 0, created: 0, resumed: 0, skipped: 0 };
  }

  async start() {
    this.discord.on('dispatch', (event) => this.#handleDiscordDispatch(event).catch((error) => this.#logError(error)));
    this.discord.on('error', (error) => this.#logError(error));
    this.discord.on('ready', (info) => {
      const user = info?.user;
      this.logger.error(`Discord gateway ready as ${user?.username || 'bot'}${user?.id ? ` (${user.id})` : ''}`);
    });
    this.codex.on('event', (event) => this.#mirrorCodexEvent(event).catch((error) => this.#logError(error)));
    this.codex.on('serverRequest', (request) => this.#mirrorApprovalRequest(request).catch((error) => this.#logError(error)));
    this.codex.on('ready', (info) => {
      if (info?.reconnect) this.discoverThreads().catch((error) => this.#logError(error));
    });
    await this.codex.start();
    if (this.guildId) {
      await this.state.bindDiscordGuild(this.guildId);
    }
    await this.discoverThreads();
    this.discoveryTimer = setInterval(() => this.discoverThreads().catch((error) => this.#logError(error)), this.pollMs);
    this.discord.startGateway();
  }

  async stop() {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discord.stopGateway();
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
      const hasMappedChannel = Boolean(this.state.getDiscordChannelForThread(threadId));
      const isNewlyDiscovered = this.didInitialDiscovery && !wasKnown && createdAtMs >= this.startedAtMs;
      const isOldThreadWithNewActivity = this.didInitialDiscovery && wasKnown && !hasMappedChannel && isAfterStartup(updatedAt, this.startedAtMs) && previousUpdatedAt && updatedAt !== previousUpdatedAt;

      this.knownThreadUpdatedAt.set(threadKey, updatedAt);

      if (hasMappedChannel && !this.subscribedThreads.has(threadKey)) {
        if (this.#queueResumeThreadForSubscription(threadId)) stats.resumed += 1;
        else stats.skipped += 1;
      }
      if (hasMappedChannel && shouldPollSessionFile && !this.sessionFileOffsets.has(threadKey)) {
        await this.#initializeSessionFileOffset(threadKey, sessionPath, 'end');
      }

      if (isNewlyDiscovered || isOldThreadWithNewActivity) {
        const channelId = await this.#ensureChannelForThread(threadId, thread);
        if (channelId && shouldPollSessionFile && !this.sessionFileOffsets.has(threadKey)) {
          await this.#initializeSessionFileOffset(threadKey, sessionPath, 'start');
        }
        if (channelId && !this.subscribedThreads.has(threadKey)) {
          if (this.#queueResumeThreadForSubscription(threadId)) stats.resumed += 1;
          else stats.skipped += 1;
        }
        if (channelId) stats.created += 1;
        else stats.skipped += 1;
      }
    }
    this.didInitialDiscovery = true;
    this.lastDiscoveryStats = stats;
    await this.#pollSessionFiles();
    return stats;
  }

  async #handleDiscordDispatch(event) {
    if (event.type === 'MESSAGE_CREATE') {
      await this.#handleMessage(event.data);
      return;
    }
    if (event.type === 'INTERACTION_CREATE') {
      await this.#handleInteraction(event.data);
    }
  }

  async #handleMessage(message) {
    const hasText = typeof message?.content === 'string' && message.content.trim().length > 0;
    const hasAttachments = Array.isArray(message?.attachments) && message.attachments.length > 0;
    if ((!hasText && !hasAttachments) || message.author?.bot) return;
    if (await this.#routeAiControlAgentChannelMessage(message)) return;
    this.#rememberInboundUserMessage(message);
    if (!this.#isAllowedUser(message.author)) return;
    const command = getDiscordCommand(message, this.commandPrefix);
    if (command === 'bind') return this.#bind(message);
    if (command === 'help') return this.#help(message);
    if (command && !this.#isBoundGuildMessage(message)) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Run ${this.commandPrefix} bind in this Discord server first.` });
      return;
    }
    if (command === 'new') return this.#newThread(message);
    if (command === 'topics') return this.#topics(message);
    if (command === 'status') return this.#status(message);
    if (command === 'resync') return this.#resync(message);
    if (command === 'pause') return this.#pause(message);
    if (command === 'resume') return this.#resume(message);
    if (command === 'rename') return this.#rename(message);
    if (command === 'logs') return this.#logs(message);
    if (command === 'interrupt') return this.#interrupt(message);
    if (command === 'unlink') return this.#unlink(message);
    if (command === 'relink') return this.#relink(message);
    if (command === 'delete_all_channels') return this.#deleteAllChannels(message);
    if (command === 'delete_unlinked_channels') return this.#deleteUnlinkedChannels(message);
    if (command) return this.#help(message);
    if (!this.#isBoundGuildMessage(message)) return;
    return this.#routeChannelMessage(message);
  }

  async #bind(message) {
    if (!message.guild_id) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: 'Use this command inside the Discord server to bind it.' });
      return;
    }
    await this.state.bindDiscordGuild(message.guild_id);
    await this.discord.sendMessage({ channelId: message.channel_id, text: 'Bound this Discord server. New Codex sessions will be grouped by project/worktree category.' });
    await this.discoverThreads();
  }

  async #help(message) {
    await this.discord.sendMessage({
      channelId: message.channel_id,
      text: discordHelpText(this.commandPrefix),
    });
  }

  async #newThread(message) {
    if (!this.#isBoundGuildMessage(message)) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Run ${this.commandPrefix} bind in the Discord server first.` });
      return;
    }
    const parsed = parseNewThreadArgs(message, this.commandPrefix);
    if (parsed.error) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: parsed.error });
      return;
    }
    if (!parsed.cwd) {
      await this.#showProjectPicker(message, parsed.title);
      return;
    }
    const cwd = await resolveExistingDirectory(parsed.cwd);
    if (parsed.cwd && !cwd) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Directory not found or not a directory: ${parsed.cwd}` });
      return;
    }
    const title = parsed.title || (cwd ? basename(cwd) : 'Discord thread');
    await this.#createThreadAndChannel({ title, cwd, guildId: message.guild_id });
  }

  async #status(message) {
    const stats = await this.discoverThreads();
    const recentErrors = this.#recentErrors().slice(-3);
    await this.discord.sendMessage({
      channelId: message.channel_id,
      text: [
        'Codex Toolbox Discord status',
        `Bound guild: ${this.state.data.discord?.guildId ?? 'not bound'}`,
        `Mirroring paused: ${this.state.data.paused?.mirroring ? 'yes' : 'no'}`,
        `Default project: ${this.projectName}`,
        `Categories: ${Object.keys(this.state.data.discord?.projects ?? {}).length}`,
        `Mapped channels: ${Object.keys(this.state.data.discord?.threads ?? {}).length}`,
        `Pending approvals: ${Object.keys(this.state.data.approvals ?? {}).length}`,
        `Known Codex threads: ${this.knownThreadUpdatedAt.size}`,
        `Subscribed threads: ${this.subscribedThreads.size}`,
        `Allowed users: ${[...this.allowedUserIds].join(', ') || 'none'}`,
        `Last discovery: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}`,
        `Recent errors: ${recentErrors.length ? recentErrors.join(' | ') : 'none'}`,
      ].join('\n'),
    });
  }

  async #topics(message) {
    const threads = Object.values(this.state.data.discord?.threads ?? {});
    const text = threads.length
      ? [
          'Mapped Codex channels',
          ...threads.map((thread) => `${thread.threadId} -> channel ${thread.channelId}${thread.title ? ` -> ${thread.title}` : ''}`),
        ].join('\n')
      : 'No Codex channels are currently mapped.';
    await this.discord.sendMessage({ channelId: message.channel_id, text });
  }

  async #resync(message) {
    const stats = await this.discoverThreads();
    await this.discord.sendMessage({ channelId: message.channel_id, text: `Resync complete: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}.` });
  }

  async #pause(message) {
    await this.state.setMirroringPaused(true);
    await this.discord.sendMessage({ channelId: message.channel_id, text: 'Codex-to-Discord mirroring paused. Discord replies and admin commands still work.' });
  }

  async #resume(message) {
    await this.state.setMirroringPaused(false);
    const stats = await this.discoverThreads();
    await this.discord.sendMessage({ channelId: message.channel_id, text: `Mirroring resumed. Resync: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}.` });
  }

  async #rename(message) {
    const threadId = this.state.getDiscordThreadForChannel(message.channel_id);
    if (!threadId) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: 'Use this inside a mapped Codex channel.' });
      return;
    }
    const title = getDiscordCommandArgs(message, this.commandPrefix);
    if (!title) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Usage: ${this.commandPrefix} rename <title>` });
      return;
    }
    const mapping = this.state.data.discord?.threads?.[String(threadId)];
    if (mapping) {
      mapping.title = title;
      mapping.updatedAt = new Date().toISOString();
      await this.state.save?.();
    }
    let channelRenamed = true;
    if (typeof this.discord.editChannelName === 'function') {
      try {
        await this.discord.editChannelName(message.channel_id, title);
      } catch (error) {
        channelRenamed = false;
        await this.#rememberError(`rename Discord channel ${message.channel_id}: ${error.message}`);
      }
    }
    let codexRenamed = true;
    if (typeof this.codex.renameThread === 'function') {
      try {
        await this.codex.renameThread(threadId, title);
      } catch (error) {
        codexRenamed = false;
        await this.#rememberError(`rename Codex thread ${threadId}: ${error.message}`);
      }
    }
    await this.discord.sendMessage({
      channelId: message.channel_id,
      text: codexRenamed && channelRenamed
        ? `Renamed this channel to "${title}".`
        : `Updated this Discord mapping to "${title}", but ${codexRenamed ? 'Discord channel' : 'Codex thread'} rename failed.`,
    });
  }

  async #logs(message) {
    await this.discord.sendMessage({ channelId: message.channel_id, text: await this.#readDiagnostics() });
  }

  async #interrupt(message) {
    const threadId = this.state.getDiscordThreadForChannel(message.channel_id);
    if (!threadId) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: 'Use this inside a mapped Codex channel.' });
      return;
    }
    await this.codex.interrupt(threadId);
    await this.discord.sendMessage({ channelId: message.channel_id, text: 'Interrupt requested.' });
  }

  async #unlink(message) {
    const unmapped = await this.state.unmapDiscordChannel(message.channel_id);
    await this.discord.sendMessage({ channelId: message.channel_id, text: unmapped ? `Unlinked Codex thread ${unmapped.threadId}.` : 'This channel was not mapped.' });
  }

  async #relink(message) {
    if (!this.#isBoundGuildMessage(message)) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Run ${this.commandPrefix} bind in this server first.` });
      return;
    }
    const threadId = getDiscordCommandArgs(message, this.commandPrefix);
    if (!threadId) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Usage: ${this.commandPrefix} relink <threadId>` });
      return;
    }
    const threads = await this.codex.listThreads();
    const thread = threads.find((candidate) => String(candidate.id ?? candidate.threadId ?? candidate.thread_id) === threadId);
    if (!thread) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Codex thread ${threadId} was not found.` });
      return;
    }
    const categoryName = categoryNameForThread(thread, this.projectName);
    const categoryId = await this.#ensureDiscordCategory(message.guild_id, categoryName);
    await this.state.unmapDiscordChannel(message.channel_id);
    await this.state.unmapDiscordThread(threadId);
    await this.state.mapDiscordThread(threadId, message.channel_id, categoryId, thread.title ?? thread.name ?? null, categoryName);
    await this.codex.resumeThread(threadId);
    this.subscribedThreads.add(String(threadId));
    await this.discord.sendMessage({ channelId: message.channel_id, text: `Relinked this channel to Codex thread ${threadId}.` });
  }

  async #deleteAllChannels(message) {
    if (getDiscordCommandArgs(message, this.commandPrefix) !== 'confirm') {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `This deletes every Discord channel mapped by Codex Toolbox. Run ${this.commandPrefix} delete_all_channels confirm to continue.` });
      return;
    }
    const mappings = Object.values(this.state.data.discord?.threads ?? {});
    let deleted = 0;
    let failed = 0;
    for (const mapping of mappings) {
      try {
        await this.discord.deleteChannel(mapping.channelId);
        await this.state.unmapDiscordThread(mapping.threadId);
        deleted += 1;
      } catch (error) {
        failed += 1;
        await this.#rememberError(`delete Discord channel ${mapping.channelId}: ${error.message}`);
      }
    }
    await this.state.clearApprovals?.();
    await this.discord.sendMessage({ channelId: message.channel_id, text: `Delete complete. Deleted channels: ${deleted}. Failed channels: ${failed}.` });
  }

  async #deleteUnlinkedChannels(message) {
    const args = getDiscordCommandArgs(message, this.commandPrefix);
    if (!['confirm', 'all confirm', 'project confirm'].includes(args)) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `This deletes Discord text channels that are not linked to Codex threads. Run ${this.commandPrefix} delete_unlinked_channels confirm for the whole Discord server, or ${this.commandPrefix} delete_unlinked_channels project confirm for only "${this.projectName}" categories.` });
      return;
    }
    const guildId = this.state.data.discord?.guildId;
    if (!guildId) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: 'Discord server is not bound. Bind the server first.' });
      return;
    }
    if (typeof this.discord.listGuildChannels !== 'function') {
      await this.discord.sendMessage({ channelId: message.channel_id, text: 'This Discord client cannot list guild channels.' });
      return;
    }
    const linkedChannelIds = new Set(Object.keys(this.state.data.discord?.channels ?? {}));
    const channels = await this.discord.listGuildChannels(guildId);
    const knownCategoryIds = new Set(Object.values(this.state.data.discord?.projects ?? {})
      .map((project) => project.categoryId)
      .filter(Boolean)
      .map(String));
    const wholeGuild = args !== 'project confirm';
    const unlinked = channels.filter((channel) => (
      (wholeGuild || knownCategoryIds.has(String(channel.parent_id ?? '')))
      && Number(channel.type) === 0
      && !linkedChannelIds.has(String(channel.id))
    ));
    const deletesCurrentChannel = unlinked.some((channel) => String(channel.id) === String(message.channel_id));
    const deletionOrder = unlinked
      .slice()
      .sort((a, b) => Number(String(a.id) === String(message.channel_id)) - Number(String(b.id) === String(message.channel_id)));
    if (deletesCurrentChannel) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Deleting ${unlinked.length} unlinked channel${unlinked.length === 1 ? '' : 's'}, including this channel.` });
    }
    let deleted = 0;
    let failed = 0;
    for (const channel of deletionOrder) {
      try {
        await this.discord.deleteChannel(channel.id);
        deleted += 1;
      } catch (error) {
        failed += 1;
        await this.#rememberError(`delete unlinked Discord channel ${channel.id}: ${error.message}`);
      }
    }
    if (!deletesCurrentChannel) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Unlinked channel cleanup complete. Scope: ${wholeGuild ? 'whole server' : 'known Codex categories'}. Deleted: ${deleted}. Failed: ${failed}. Kept linked channels: ${linkedChannelIds.size}.` });
    }
  }

  async #routeChannelMessage(message) {
    const threadId = this.state.getDiscordThreadForChannel(message.channel_id);
    if (!threadId) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `This Discord channel is not linked to a Codex thread. Use ${this.commandPrefix} new to create one or ${this.commandPrefix} relink <threadId>.` });
      return;
    }
    try {
      this.#rememberEchoSuppression(threadId, message.content);
      await this.codex.sendToThread(threadId, message.content);
    } catch (error) {
      this.#forgetEchoSuppression(threadId, message.content);
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Could not send message to Codex: ${error.message}` });
    }
  }

  #rememberInboundUserMessage(message) {
    const text = message?.content;
    if (!normalizeText(text)) return;
    const threadId = this.state.getDiscordThreadForChannel(message.channel_id);
    if (threadId) {
      this.#rememberEchoSuppression(threadId, text);
      return;
    }
    this.#rememberEchoSuppression(GLOBAL_ECHO_SUPPRESSION_KEY, text);
  }

  async #routeAiControlAgentChannelMessage(message) {
    if (!this.aiControlBaseUrl) return false;
    try {
      const attachments = Array.isArray(message.attachments)
        ? message.attachments
            .map((attachment) => ({
              id: attachment?.id,
              filename: attachment?.filename,
              url: attachment?.url,
              proxyUrl: attachment?.proxy_url,
              contentType: attachment?.content_type,
              size: attachment?.size,
              durationSecs: attachment?.duration_secs,
              waveform: attachment?.waveform,
            }))
            .filter((attachment) => attachment.filename || attachment.url)
        : [];
      const response = await fetch(`${this.aiControlBaseUrl}/api/ai-control/discord`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.aiControlDiscordSecret ? { 'x-ai-control-discord-secret': this.aiControlDiscordSecret } : {}),
        },
        body: JSON.stringify({
          action: 'agent_message',
          tenantId: this.aiControlTenantId || undefined,
          guildId: message.guild_id,
          channelId: message.channel_id,
          messageId: message.id,
          authorId: message.author?.id,
          authorName: message.author?.global_name || message.author?.username || message.author?.id || 'Discord owner',
          text: message.content,
          attachments,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (result?.skipped && String(result.skipped).includes('not mapped')) return false;
      if (response.ok && result?.ok !== false) return true;
      await this.discord.sendMessage({
        channelId: message.channel_id,
        text: `AI Control agent channel failed: ${result?.error || `HTTP ${response.status}`}`,
      });
      return true;
    } catch (error) {
      await this.#rememberError(`route Discord channel ${message.channel_id} to AI Control: ${error.message}`);
      return false;
    }
  }

  async #handleInteraction(interaction) {
    const data = interaction.data?.custom_id ?? '';
    if (data.startsWith('aiapproval:')) {
      await this.#handleAiControlApprovalInteraction(interaction);
      return;
    }
    if (data.startsWith('new:')) {
      if (!this.#isAllowedUser(interaction.member?.user ?? interaction.user)) {
        await this.discord.createInteractionResponse(interaction.id, interaction.token, {
          type: 4,
          data: { content: 'You are not allowed to control this Codex bridge.', flags: 64 },
        });
        return;
      }
      await this.#handleNewThreadInteraction(interaction);
      return;
    }
    if (!data.startsWith('approval:')) return;
    const approvalChannelId = interaction.channel_id ?? interaction.message?.channel_id;
    if (approvalChannelId && !this.state.getDiscordThreadForChannel(approvalChannelId)) {
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'This approval is not in a mapped Codex channel.', flags: 64 },
      });
      return;
    }
    if (!this.#isAllowedUser(interaction.member?.user ?? interaction.user)) {
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'You are not allowed to control this Codex bridge.', flags: 64 },
      });
      return;
    }
    const [, callbackId, decision] = data.split(':');
    if (!['accept', 'decline', 'cancel'].includes(decision)) return;
    const approval = await this.state.takeApproval(callbackId);
    if (!approval) {
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'Approval request expired.', flags: 64 },
      });
      return;
    }
    this.codex.answerServerRequest(approval.requestId, decision, { threadId: approval.threadId });
    await this.discord.createInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: { content: `Sent ${decision}.`, flags: 64 },
    });
  }

  async #handleAiControlApprovalInteraction(interaction) {
    const [, code, decision] = String(interaction.data?.custom_id ?? '').split(':');
    if (!code || !['accept', 'decline', 'cancel'].includes(decision)) return;
    const channelId = interaction.channel_id ?? interaction.message?.channel_id;
    try {
      const response = await fetch(`${this.aiControlBaseUrl}/api/ai-control/discord`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.aiControlDiscordSecret ? { 'x-ai-control-discord-secret': this.aiControlDiscordSecret } : {}),
        },
        body: JSON.stringify({
          action: 'approval_decision',
          tenantId: this.aiControlTenantId || undefined,
          channelId,
          authorId: interaction.member?.user?.id || interaction.user?.id,
          code,
          decision,
        }),
      });
      const result = await response.json().catch(() => ({}));
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: response.ok && result?.ok !== false ? `Sent ${decision}.` : `Approval failed: ${result?.error || `HTTP ${response.status}`}`, flags: 64 },
      });
    } catch (error) {
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: `Approval failed: ${error.message}`, flags: 64 },
      });
    }
  }

  async #mirrorCodexEvent(event) {
    if (!this.state.data.discord?.guildId || !event.threadId) return;
    if (this.#shouldMirrorNoMessages()) return;
    if (this.#consumeEchoSuppression(event)) return;
    if (this.state.data.paused?.mirroring) {
      if (this.#shouldMirrorAllMessages()) await this.#debugMirrorSkip(event.threadId, 'mirroring is paused', event.method);
      return;
    }
    if (isCompletionEvent(event)) {
      if (this.#shouldMirrorAllMessages()) await this.#sendCompletionNotice(event.threadId, 'app-server turn completed');
      return;
    }
    if (this.#bufferAgentMessageDelta(event)) return;
    const completedBufferedText = this.#takeCompletedAgentMessage(event);
    if (completedBufferedText) {
      const channelId = await this.#ensureChannelForThread(event.threadId);
      if (channelId) await this.#sendMirroredMessage(event.threadId, channelId, completedBufferedText);
      return;
    }
    if (!this.#shouldMirrorAllMessages() && !isUserOrAgentMessageEvent(event)) return;
    const text = renderCodexEvent(event, { includeMessageType: true });
    if (!text) {
      if (this.#shouldMirrorAllMessages() && isMessageLikeCodexEvent(event)) {
        await this.#debugMirrorSkip(event.threadId, 'app-server event had no mirrorable text', event.method);
      }
      return;
    }
    const channelId = await this.#ensureChannelForThread(event.threadId);
    if (channelId) await this.#sendMirroredMessage(event.threadId, channelId, text);
  }

  async #mirrorApprovalRequest(request) {
    if (!this.#shouldMirrorAllMessages()) return;
    const channelId = request.threadId ? this.state.getDiscordChannelForThread(request.threadId) : null;
    if (!channelId) return;
    const callbackId = randomUUID();
    await this.state.rememberApproval(callbackId, { requestId: request.id, threadId: request.threadId });
    await this.discord.sendMessage({
      channelId,
      text: renderApprovalPrompt(request, { includeMessageType: true }),
      components: approvalComponents(callbackId, approvalLabels(request)),
    });
  }

  async #pollSessionFiles() {
    if (this.#shouldMirrorNoMessages()) return;
    if (this.state.data.paused?.mirroring) {
      if (this.#shouldMirrorAllMessages()) {
        for (const threadId of this.sessionFilePaths.keys()) {
          await this.#debugMirrorSkip(threadId, 'session file polling skipped because mirroring is paused');
        }
      }
      return;
    }
    for (const [threadId, sessionPath] of this.sessionFilePaths.entries()) {
      if (!this.state.getDiscordChannelForThread(threadId)) continue;
      try {
        await this.#pollSessionFile(threadId, sessionPath);
      } catch (error) {
        await this.#rememberError(`poll Discord session ${threadId}: ${error.message}`);
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
      const rendered = renderSessionLogLine(line, this.messageScope);
      if (!rendered.text) {
        if (this.#shouldMirrorAllMessages() && rendered.debugReason) await this.#debugMirrorSkip(threadId, rendered.debugReason);
        continue;
      }
      const text = rendered.text;
      const mirroredUserText = mirroredRoleText(text, 'User');
      if (mirroredUserText && this.#consumeTextEchoSuppression(threadId, mirroredUserText)) continue;
      const channelId = this.state.getDiscordChannelForThread(threadId);
      if (!channelId) {
        if (this.#shouldMirrorAllMessages()) await this.#debugMirrorSkip(threadId, 'no Discord channel is mapped for this Codex thread');
        return;
      }
      await this.#sendMirroredMessage(threadId, channelId, text);
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

  async #ensureDiscordCategory(guildId, categoryName = this.projectName) {
    categoryName = categoryName || this.projectName;
    const existing = this.state.data.discord?.projects?.[categoryName]?.categoryId;
    if (existing && await this.#discordCategoryExists(guildId, existing)) return existing;
    const existingCategory = await this.#findDiscordCategory(guildId, categoryName);
    if (existingCategory?.id) {
      await this.state.mapDiscordProject(categoryName, existingCategory.id);
      return existingCategory.id;
    }
    const category = await this.discord.createGuildCategory(guildId, categoryName);
    await this.state.mapDiscordProject(categoryName, category.id);
    return category.id;
  }

  async #discordCategoryExists(guildId, categoryId) {
    if (typeof this.discord.listGuildChannels !== 'function') return true;
    try {
      const channels = await this.discord.listGuildChannels(guildId);
      return channels.some((channel) => Number(channel.type) === 4 && String(channel.id) === String(categoryId));
    } catch (error) {
      await this.#rememberError(`validate Discord category ${categoryId}: ${error.message}`);
      return true;
    }
  }

  async #findDiscordCategory(guildId, categoryName) {
    if (typeof this.discord.listGuildChannels !== 'function') return null;
    try {
      const channels = await this.discord.listGuildChannels(guildId);
      return channels.find((channel) => Number(channel.type) === 4 && String(channel.name) === String(categoryName)) ?? null;
    } catch (error) {
      await this.#rememberError(`list Discord categories for ${guildId}: ${error.message}`);
      return null;
    }
  }

  async #showProjectPicker(message, title) {
    const projects = await listProjects();
    if (!projects.length) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `No projects found in ${projectsRoot()}.` });
      return;
    }
    const selectionId = this.#rememberNewThreadSelection({
      guildId: message.guild_id,
      channelId: message.channel_id,
      title,
    });
    await this.discord.sendMessage({
      channelId: message.channel_id,
      text: 'Select a project for the new Codex session.',
      components: buttonRows([
        ...projects.map((project) => ({
          label: project.label,
          custom_id: `new:project:${selectionId}:${project.index}`,
        })),
        { label: 'Help', custom_id: `new:help:${selectionId}` },
      ]),
    });
  }

  async #showWorktreePicker(interaction, selection, project) {
    selection.project = project.label;
    selection.projectPath = project.path;
    selection.projectIsContainer = Boolean(project.isContainer);
    const worktrees = project.isContainer ? [] : await listWorktrees(project.path);
    const buttons = [];
    if (project.isContainer) {
      buttons.push({ label: `Use ${project.label} parent folder`, custom_id: `new:project-root:${selection.id}` });
    }
    buttons.push(...worktrees.map((worktree) => ({
      label: worktree.name,
      custom_id: `new:worktree:${selection.id}:${worktree.index}`,
    })));
    buttons.push({ label: 'Help', custom_id: `new:help:${selection.id}` });
    await this.discord.createInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: {
        content: `Project: ${project.label}\n${project.isContainer ? 'Select where to start.' : 'Select a worktree.'}`,
        components: buttonRows(buttons),
      },
    });
  }

  async #handleNewThreadInteraction(interaction) {
    const parts = String(interaction.data?.custom_id ?? '').split(':');
    const action = parts[1];
    const selectionId = parts[2];
    const selection = this.#getNewThreadSelection(selectionId);
    if (!selection) {
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'This new-session selection expired. Run the command again.', flags: 64 },
      });
      return;
    }
    if (action === 'project') {
      const projects = await listProjects();
      const project = projects[Number(parts[3])];
      if (!project) {
        await this.discord.createInteractionResponse(interaction.id, interaction.token, {
          type: 4,
          data: { content: 'Project was not found.', flags: 64 },
        });
        return;
      }
      await this.#showWorktreePicker(interaction, selection, project);
      return;
    }
    if (action === 'project-root') {
      await this.#createThreadAndChannel({ title: selection.title || selection.project, cwd: selection.projectPath, guildId: selection.guildId });
      this.newThreadSelections.delete(selection.id);
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'Creating Codex channel.', flags: 64 },
      });
      return;
    }
    if (action === 'worktree') {
      const worktrees = await listWorktrees(selection.projectPath);
      const worktree = worktrees[Number(parts[3])];
      if (!worktree) {
        await this.discord.createInteractionResponse(interaction.id, interaction.token, {
          type: 4,
          data: { content: 'Worktree was not found.', flags: 64 },
        });
        return;
      }
      await this.#createThreadAndChannel({
        title: selection.title || `${selection.project}/${worktree.name}`,
        cwd: worktree.path,
        guildId: selection.guildId,
      });
      this.newThreadSelections.delete(selection.id);
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'Creating Codex channel.', flags: 64 },
      });
      return;
    }
    if (action === 'help') {
      await this.discord.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: discordHelpText(this.commandPrefix) },
      });
    }
  }

  async #createThreadAndChannel({ title, cwd, guildId }) {
    title = title || basename(cwd) || 'Discord thread';
    const threadId = await this.codex.createThread(title, cwd ? { cwd } : {});
    const categoryName = categoryNameForCwd(cwd, this.projectName);
    const categoryId = await this.#ensureDiscordCategory(guildId, categoryName);
    const channel = await this.discord.createTextChannel(guildId, title, categoryId);
    await this.state.mapDiscordThread(threadId, channel.id, categoryId, title, categoryName);
    await this.#resumeThreadForSubscription(threadId);
    await this.discord.sendMessage({ channelId: channel.id, text: `Created Codex thread ${threadId}\nCategory: ${categoryName}${cwd ? `\nDirectory: ${cwd}` : ''}` });
    return channel;
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
  }

  async #ensureChannelForThread(threadId, thread = null) {
    const existing = this.state.getDiscordChannelForThread(threadId);
    if (existing) return existing;
    const guildId = this.state.data.discord?.guildId;
    if (!guildId) return null;
    const categoryName = categoryNameForThread(thread, this.projectName);
    const categoryId = await this.#ensureDiscordCategory(guildId, categoryName);
    const title = thread?.title ?? thread?.name ?? `Codex ${String(threadId).slice(0, 8)}`;
    const channel = await this.discord.createTextChannel(guildId, title, categoryId);
    await this.state.mapDiscordThread(threadId, channel.id, categoryId, title, categoryName);
    await this.discord.sendMessage({ channelId: channel.id, text: `Linked Codex thread ${threadId}\nCategory: ${categoryName}` });
    return channel.id;
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

  #isAllowedUser(user) {
    if (this.allowedUserIds.size === 0) return false;
    return user?.id != null && this.allowedUserIds.has(String(user.id));
  }

  #isBoundGuildMessage(message) {
    return message.guild_id && String(message.guild_id) === String(this.state.data.discord?.guildId);
  }

  #bufferAgentMessageDelta(event) {
    if (event.method !== 'item/agentMessage/delta') return false;
    const params = event.raw.params ?? {};
    const itemId = params.itemId ?? params.item_id ?? params.item?.id;
    const delta = params.delta;
    if (!itemId || typeof delta !== 'string') return false;
    const key = String(itemId);
    this.agentMessageBuffers.set(key, (this.agentMessageBuffers.get(key) ?? '') + delta);
    return true;
  }

  #takeCompletedAgentMessage(event) {
    if (event.method !== 'item/completed') return null;
    const item = event.raw.params?.item;
    if (item?.type !== 'agentMessage' || !item.id) return null;
    const buffered = this.agentMessageBuffers.get(String(item.id));
    this.agentMessageBuffers.delete(String(item.id));
    const text = (buffered || item.text || '').trim();
    return text ? withMessageType(item.type, `Codex\n${text}`) : null;
  }

  async #sendMirroredMessage(threadId, channelId, text) {
    if (this.#rememberMirroredMessage(threadId, text)) return;
    for (const chunk of chunkTelegramText(text, DISCORD_STREAM_TEXT_LIMIT)) {
      await this.discord.sendMessage({ channelId, text: chunk });
    }
  }

  async #debugMirrorSkip(threadId, reason, detail = null) {
    const channelId = this.state.getDiscordChannelForThread(threadId);
    if (!channelId) return;
    const key = `${threadId}:${reason}:${detail ?? ''}`;
    const now = Date.now();
    const lastSentAt = this.debugNotices.get(key) ?? 0;
    if (now - lastSentAt < DEBUG_NOTICE_THROTTLE_MS) return;
    this.debugNotices.set(key, now);
    await this.discord.sendMessage({
      channelId,
      text: withMessageType('debug', `Debug: Codex message not sent to Discord.\nReason: ${reason}${detail ? `\nCheck: ${detail}` : ''}`),
    });
  }

  async #sendCompletionNotice(threadId, reason, detail = null) {
    const channelId = this.state.getDiscordChannelForThread(threadId);
    if (!channelId) return;
    await this.discord.sendMessage({
      channelId,
      text: withMessageType('task_complete', `Status: Codex task complete.${detail ? `\n${detail}` : ''}\nReason: ${reason}`),
    });
  }

  #rememberMirroredMessage(threadId, text, options = {}) {
    const normalizedText = normalizeMirroredMessageText(text);
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

  #rememberEchoSuppression(threadId, text) {
    const normalized = normalizeText(text);
    if (!normalized) return;
    const key = String(threadId);
    const now = Date.now();
    const entries = (this.echoSuppressions.get(key) ?? []).filter((entry) => now - entry.createdAt <= ECHO_SUPPRESSION_MS);
    entries.push({ text: normalized, createdAt: now });
    this.echoSuppressions.set(key, entries);
    const globalEntries = (this.echoSuppressions.get(GLOBAL_ECHO_SUPPRESSION_KEY) ?? []).filter((entry) => now - entry.createdAt <= ECHO_SUPPRESSION_MS);
    globalEntries.push({ text: normalized, createdAt: now });
    this.echoSuppressions.set(GLOBAL_ECHO_SUPPRESSION_KEY, globalEntries);
  }

  #forgetEchoSuppression(threadId, text) {
    const normalized = normalizeText(text);
    this.#removeEchoSuppression(String(threadId), normalized);
    this.#removeEchoSuppression(GLOBAL_ECHO_SUPPRESSION_KEY, normalized);
  }

  #consumeEchoSuppression(event) {
    const text = normalizeText(extractUserMessageText(event));
    if (!text) return false;
    return this.#consumeTextEchoSuppression(String(event.threadId), text);
  }

  #consumeTextEchoSuppression(threadId, text) {
    text = normalizeText(text);
    if (!text) return false;
    return this.#consumeEchoSuppressionForKey(String(threadId), text)
      || this.#consumeEchoSuppressionForKey(GLOBAL_ECHO_SUPPRESSION_KEY, text);
  }

  #consumeEchoSuppressionForKey(key, text) {
    const now = Date.now();
    let matched = false;
    const entries = [];
    for (const entry of this.echoSuppressions.get(key) ?? []) {
      if (now - entry.createdAt > ECHO_SUPPRESSION_MS) continue;
      if (!matched && entry.text === text) {
        matched = true;
        continue;
      }
      entries.push(entry);
    }
    if (entries.length) this.echoSuppressions.set(key, entries);
    else this.echoSuppressions.delete(key);
    return matched;
  }

  #removeEchoSuppression(key, normalized) {
    const entries = (this.echoSuppressions.get(key) ?? []).filter((entry) => entry.text !== normalized);
    if (entries.length) this.echoSuppressions.set(key, entries);
    else this.echoSuppressions.delete(key);
  }

  async #rememberError(message) {
    if (typeof this.state.recordError === 'function') await this.state.recordError(String(message));
  }

  #logError(error) {
    this.#rememberError(error?.message ?? error).catch(() => {});
    this.logger.error(error);
  }

  #recentErrors() {
    return (this.state.data?.lastErrors ?? []).map((entry) => redact(entry.message ?? entry)).filter(Boolean);
  }

  #shouldMirrorAllMessages() {
    return this.messageScope === 'all';
  }

  #shouldMirrorNoMessages() {
    return this.messageScope === 'none';
  }

  async #readDiagnostics() {
    const sections = [
      'Codex Toolbox Discord diagnostics',
      `Mirroring paused: ${this.state.data.paused?.mirroring ? 'yes' : 'no'}`,
      `Mapped channels: ${Object.keys(this.state.data.discord?.threads ?? {}).length}`,
      `Recent errors: ${this.#recentErrors().slice(-5).join(' | ') || 'none'}`,
    ];
    const logPaths = [
      join(homedir(), '.pm2/logs/codex-toolbox-discord-out.log'),
      join(homedir(), '.pm2/logs/codex-toolbox-discord-error.log'),
      join(homedir(), '.pm2/logs/codex-toolbox-out.log'),
      join(homedir(), '.pm2/logs/codex-toolbox-error.log'),
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

function normalizeMirroredMessageText(value) {
  const text = typeof value === 'string' ? value : '';
  const lines = text.split('\n');
  if (lines.length > 1 && isMirrorBodyStart(lines[1])) {
    return normalizeText(lines.slice(1).join('\n'));
  }
  return normalizeText(text);
}

function isMirrorBodyStart(line) {
  return line === 'User'
    || line === 'Codex'
    || line === 'Plan'
    || line === 'Error'
    || line.startsWith('Tool')
    || line.startsWith('Status:')
    || line.startsWith('Debug:');
}

function withMessageType(type, text) {
  const normalizedType = String(type || 'message').trim() || 'message';
  return `${normalizedType}\n${text}`;
}

function mirroredRoleText(text, role) {
  const lines = String(text ?? '').split('\n');
  const roleIndex = lines[0] === role ? 0 : lines[1] === role ? 1 : -1;
  if (roleIndex < 0) return null;
  return lines.slice(roleIndex + 1).join('\n');
}

function isUserOrAgentMessageEvent(event) {
  const params = event.raw?.params ?? {};
  const item = params.item ?? {};
  const type = item.type ?? params.type ?? '';
  const role = item.role ?? params.role ?? '';
  return type === 'userMessage'
    || type === 'agentMessage'
    || role === 'user'
    || role === 'assistant';
}

function normalizeMessageScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['all', 'everything', '*'].includes(normalized)) return 'all';
  if (['none', 'off', 'disabled', 'false', '0'].includes(normalized)) return 'none';
  if (['conversation', 'conversation_only', 'conversation-only', 'user_agent', 'user-agent', 'users_agents', 'users-agents', 'messages'].includes(normalized)) return 'conversation';
  return 'conversation';
}

function parseNewThreadArgs(message, prefix) {
  const args = getDiscordCommandArgs(message, prefix);
  const tokens = splitCommandTokens(args);
  if (tokens.error) return { error: tokens.error };
  let cwd = null;
  const titleParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--cwd' || token === '--dir') {
      const value = tokens[index + 1];
      if (!value) return { error: `Usage: ${prefix} new --cwd /absolute/path Optional title` };
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
      if (char === quote) quote = null;
      else current += char;
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
  if (quote) return { error: `Unclosed quote in command.` };
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

function categoryNameForThread(thread, fallback) {
  return categoryNameForCwd(thread?.cwd ?? thread?.worktree ?? thread?.workspace ?? null, thread?.name ?? fallback);
}

function categoryNameForCwd(cwd, fallback) {
  if (!cwd) return String(fallback || 'Codex').trim() || 'Codex';
  const root = resolve(projectsRoot()).replace(/\/+$/, '');
  const resolvedCwd = resolve(String(cwd)).replace(/\/+$/, '');
  if (resolvedCwd === root) return String(fallback || 'Codex').trim() || 'Codex';
  if (resolvedCwd.startsWith(`${root}/`)) {
    const parts = resolvedCwd.slice(root.length + 1).split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    if (parts.length === 1) return parts[0];
  }
  return basename(resolvedCwd) || String(fallback || 'Codex').trim() || 'Codex';
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
    .slice(0, 23)
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
    .slice(0, 23)
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

function buttonRows(buttons, columns = 2) {
  const rows = [];
  const limitedButtons = buttons.slice(0, 25);
  for (let index = 0; index < limitedButtons.length && rows.length < 5; index += columns) {
    rows.push({
      type: 1,
      components: limitedButtons.slice(index, index + columns).map((button) => ({
        type: 2,
        style: 2,
        label: String(button.label || 'Select').slice(0, 80),
        custom_id: String(button.custom_id),
      })),
    });
  }
  return rows;
}

function discordHelpText(prefix) {
  return [
    'Codex Toolbox Discord commands',
    `${prefix} bind - bind this server`,
    `${prefix} new Optional title - choose a project and worktree for a new Codex channel`,
    `${prefix} new --cwd /path Optional title - create a Codex thread from an exact directory`,
    `${prefix} topics - list mapped Codex channels`,
    `${prefix} status - show bridge status`,
    `${prefix} resync - run discovery now`,
    `${prefix} pause - pause Codex-to-Discord mirroring`,
    `${prefix} resume - resume mirroring`,
    `${prefix} rename <title> - rename the mapped Codex thread label`,
    `${prefix} interrupt - interrupt this Codex thread`,
    `${prefix} unlink - unlink this channel`,
    `${prefix} relink <threadId> - link this channel to an existing Codex thread`,
    `${prefix} delete_all_channels confirm - delete mapped Codex channels`,
    `${prefix} delete_unlinked_channels confirm - delete unlinked channels in the whole server`,
    `${prefix} delete_unlinked_channels project confirm - delete unlinked channels in known Codex categories`,
    `${prefix} logs - show redacted diagnostics`,
  ].join('\n');
}

function isCompletionEvent(event) {
  return /turn\/(completed|done)$/i.test(event.method);
}

function renderSessionLogLine(line, messageScope = 'all') {
  messageScope = normalizeMessageScope(messageScope);
  if (messageScope === 'none') return { text: null };
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { text: null, debugReason: 'session log line was not valid JSON' };
  }
  const payload = entry.payload ?? {};
  if (entry.type === 'response_item') return renderResponseItem(payload, messageScope);
  if (entry.type !== 'event_msg') return { text: null };
  if (payload.type === 'user_message') {
    return payload.message
      ? { text: withMessageType(payload.type, `User\n${payload.message}`) }
      : { text: null, debugReason: 'session user_message had no message text' };
  }
  if (payload.type === 'agent_message') {
    return payload.message
      ? { text: withMessageType(payload.type, `Codex\n${payload.message}`) }
      : { text: null, debugReason: 'session agent_message had no message text' };
  }
  if (messageScope !== 'all') return { text: null };
  if (payload.type === 'plan_update' && payload.explanation) return { text: withMessageType(payload.type, `Plan\n${payload.explanation}`) };
  if (payload.type === 'stream_error' || payload.type === 'error') return { text: withMessageType(payload.type, `Error\n${payload.message ?? payload.error ?? 'Unknown error'}`) };
  if (payload.type === 'exec_command_begin') return { text: withMessageType(payload.type, `Tool: ${payload.command ?? 'command'}`) };
  if (payload.type === 'exec_command_end') {
    return { text: withMessageType(payload.type, [`Tool: ${payload.command ?? 'command'}${payload.exit_code == null ? '' : ` (${payload.exit_code})`}`, formatToolOutput(payload)].filter(Boolean).join('\n')) };
  }
  if (payload.type === 'patch_apply_end') {
    return { text: withMessageType(payload.type, ['Tool output: apply_patch', formatToolOutput(payload)].filter(Boolean).join('\n')) };
  }
  if (payload.type === 'task_complete') return { text: withMessageType(payload.type, 'Status: Codex task complete.') };
  return { text: null };
}

function renderResponseItem(payload, messageScope = 'all') {
  messageScope = normalizeMessageScope(messageScope);
  if (messageScope === 'none') return { text: null };
  if (messageScope === 'all' && payload.type === 'custom_tool_call') {
    const status = payload.status ? ` (${payload.status})` : '';
    return { text: withMessageType(payload.type, `Tool call: ${payload.name ?? 'tool'}${status}`) };
  }
  if (messageScope === 'all' && payload.type === 'custom_tool_call_output') {
    return { text: withMessageType(payload.type, ['Tool output', truncateText(payload.output)].filter(Boolean).join('\n')) };
  }
  if (payload.type !== 'message') return { text: null };
  const role = payload.role === 'user' ? 'User' : payload.role === 'assistant' ? 'Codex' : null;
  if (!role) return { text: null, debugReason: `response_item message had unsupported role: ${payload.role ?? 'missing'}` };
  const text = extractResponseItemText(payload.content);
  return text ? { text: withMessageType(`response_item/${payload.type}`, `${role}\n${text}`) } : { text: null, debugReason: `response_item ${payload.role} message had no text content` };
}

function formatToolOutput(payload) {
  const stdout = truncateText(payload.stdout);
  const stderr = truncateText(payload.stderr);
  const output = truncateText(payload.output);
  return [
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
    output ? `output:\n${output}` : '',
  ].filter(Boolean).join('\n');
}

function truncateText(value, maxLength = 1800) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 20).trimEnd()}\n... truncated ...`;
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
