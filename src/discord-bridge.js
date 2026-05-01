import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { approvalComponents, getDiscordCommand, getDiscordCommandArgs } from './discord.js';
import { approvalLabels, extractUserMessageText, renderApprovalPrompt, renderCodexEvent } from './mirror-policy.js';

const ECHO_SUPPRESSION_MS = 2 * 60 * 1000;

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
  }) {
    this.codex = codex;
    this.discord = discord;
    this.state = state;
    this.pollMs = pollMs;
    this.logger = logger;
    this.allowedUserIds = new Set(allowedUserIds.map((id) => String(id)));
    this.projectName = projectName || 'Codex Project';
    this.commandPrefix = commandPrefix;
    this.discoveryTimer = null;
    this.didInitialDiscovery = false;
    this.knownThreadUpdatedAt = new Map();
    this.startedAtMs = Date.now();
    this.subscribedThreads = new Set();
    this.agentMessageBuffers = new Map();
    this.echoSuppressions = new Map();
    this.lastDiscoveryStats = { seen: 0, created: 0, resumed: 0, skipped: 0 };
  }

  async start() {
    this.discord.on('dispatch', (event) => this.#handleDiscordDispatch(event).catch((error) => this.#logError(error)));
    this.discord.on('error', (error) => this.#logError(error));
    this.codex.on('event', (event) => this.#mirrorCodexEvent(event).catch((error) => this.#logError(error)));
    this.codex.on('serverRequest', (request) => this.#mirrorApprovalRequest(request).catch((error) => this.#logError(error)));
    this.codex.on('ready', (info) => {
      if (info?.reconnect) this.discoverThreads().catch((error) => this.#logError(error));
    });
    await this.codex.start();
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
      const updatedAt = String(thread.updatedAt ?? thread.updated_at ?? thread.modifiedAt ?? '');
      const createdAtMs = normalizeTimestampMs(thread.createdAt ?? thread.created_at);
      const wasKnown = this.knownThreadUpdatedAt.has(threadKey);
      const previousUpdatedAt = this.knownThreadUpdatedAt.get(threadKey);
      const hasMappedChannel = Boolean(this.state.getDiscordChannelForThread(threadId));
      const isNewlyDiscovered = this.didInitialDiscovery && !wasKnown && createdAtMs >= this.startedAtMs;
      const isOldThreadWithNewActivity = this.didInitialDiscovery && wasKnown && !hasMappedChannel && isAfterStartup(updatedAt, this.startedAtMs) && previousUpdatedAt && updatedAt !== previousUpdatedAt;

      this.knownThreadUpdatedAt.set(threadKey, updatedAt);

      if (hasMappedChannel && !this.subscribedThreads.has(threadKey)) {
        await this.codex.resumeThread(threadId);
        this.subscribedThreads.add(threadKey);
        stats.resumed += 1;
      }

      if (isNewlyDiscovered || isOldThreadWithNewActivity) {
        const channelId = await this.#ensureChannelForThread(threadId, thread);
        if (channelId && !this.subscribedThreads.has(threadKey)) {
          await this.codex.resumeThread(threadId);
          this.subscribedThreads.add(threadKey);
          stats.resumed += 1;
        }
        if (channelId) stats.created += 1;
        else stats.skipped += 1;
      }
    }
    this.didInitialDiscovery = true;
    this.lastDiscoveryStats = stats;
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
    if (!message?.content || message.author?.bot) return;
    if (!this.#isAllowedUser(message.author)) return;
    const command = getDiscordCommand(message, this.commandPrefix);
    if (command === 'bind') return this.#bind(message);
    if (command === 'help') return this.#help(message);
    if (command && !this.#isBoundGuildMessage(message)) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Run ${this.commandPrefix} bind in this Discord server first.` });
      return;
    }
    if (command === 'new') return this.#newThread(message);
    if (command === 'status') return this.#status(message);
    if (command === 'resync') return this.#resync(message);
    if (command === 'interrupt') return this.#interrupt(message);
    if (command === 'unlink') return this.#unlink(message);
    if (command === 'relink') return this.#relink(message);
    if (command === 'delete_all_channels') return this.#deleteAllChannels(message);
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
    const categoryId = await this.#ensureProjectCategory(message.guild_id);
    await this.discord.sendMessage({ channelId: message.channel_id, text: `Bound this Discord server. Project category: <#${categoryId}>` });
    await this.discoverThreads();
  }

  async #help(message) {
    await this.discord.sendMessage({
      channelId: message.channel_id,
      text: [
        'Codex Toolbox Discord commands',
        `${this.commandPrefix} bind - bind this server`,
        `${this.commandPrefix} new Optional title - create a Codex thread channel`,
        `${this.commandPrefix} status - show bridge status`,
        `${this.commandPrefix} resync - run discovery now`,
        `${this.commandPrefix} interrupt - interrupt this Codex thread`,
        `${this.commandPrefix} unlink - unlink this channel`,
        `${this.commandPrefix} relink <threadId> - link this channel to an existing Codex thread`,
        `${this.commandPrefix} delete_all_channels confirm - delete mapped Codex channels`,
      ].join('\n'),
    });
  }

  async #newThread(message) {
    if (!this.#isBoundGuildMessage(message)) {
      await this.discord.sendMessage({ channelId: message.channel_id, text: `Run ${this.commandPrefix} bind in the Discord server first.` });
      return;
    }
    const title = getDiscordCommandArgs(message, this.commandPrefix) || 'Discord thread';
    const threadId = await this.codex.createThread(title);
    const categoryId = await this.#ensureProjectCategory(message.guild_id);
    const channel = await this.discord.createTextChannel(message.guild_id, title, categoryId);
    await this.state.mapDiscordThread(threadId, channel.id, categoryId, title);
    await this.codex.resumeThread(threadId);
    this.subscribedThreads.add(String(threadId));
    await this.discord.sendMessage({ channelId: channel.id, text: `Created Codex thread ${threadId}` });
  }

  async #status(message) {
    const stats = await this.discoverThreads();
    await this.discord.sendMessage({
      channelId: message.channel_id,
      text: [
        'Codex Toolbox Discord status',
        `Bound guild: ${this.state.data.discord?.guildId ?? 'not bound'}`,
        `Project: ${this.projectName}`,
        `Category: ${this.state.data.discord?.projects?.[this.projectName]?.categoryId ?? 'not created'}`,
        `Mapped channels: ${Object.keys(this.state.data.discord?.threads ?? {}).length}`,
        `Allowed users: ${[...this.allowedUserIds].join(', ') || 'none'}`,
        `Last discovery: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}`,
      ].join('\n'),
    });
  }

  async #resync(message) {
    const stats = await this.discoverThreads();
    await this.discord.sendMessage({ channelId: message.channel_id, text: `Resync complete: seen ${stats.seen}, created ${stats.created}, resumed ${stats.resumed}, skipped ${stats.skipped}.` });
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
    const categoryId = await this.#ensureProjectCategory(message.guild_id);
    await this.state.unmapDiscordChannel(message.channel_id);
    await this.state.unmapDiscordThread(threadId);
    await this.state.mapDiscordThread(threadId, message.channel_id, categoryId, thread.title ?? thread.name ?? null);
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
    await this.discord.sendMessage({ channelId: message.channel_id, text: `Delete complete. Deleted channels: ${deleted}. Failed channels: ${failed}.` });
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

  async #handleInteraction(interaction) {
    const data = interaction.data?.custom_id ?? '';
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

  async #mirrorCodexEvent(event) {
    if (!this.state.data.discord?.guildId || !event.threadId) return;
    if (this.#consumeEchoSuppression(event)) return;
    if (this.#bufferAgentMessageDelta(event)) return;
    const completedBufferedText = this.#takeCompletedAgentMessage(event);
    if (completedBufferedText) {
      const channelId = await this.#ensureChannelForThread(event.threadId);
      if (channelId) await this.discord.sendMessage({ channelId, text: completedBufferedText });
      return;
    }
    const text = renderCodexEvent(event);
    if (!text) return;
    const channelId = await this.#ensureChannelForThread(event.threadId);
    if (channelId) await this.discord.sendMessage({ channelId, text });
  }

  async #mirrorApprovalRequest(request) {
    const channelId = request.threadId ? this.state.getDiscordChannelForThread(request.threadId) : null;
    if (!channelId) return;
    const callbackId = randomUUID();
    await this.state.rememberApproval(callbackId, { requestId: request.id, threadId: request.threadId });
    await this.discord.sendMessage({
      channelId,
      text: renderApprovalPrompt(request),
      components: approvalComponents(callbackId, approvalLabels(request)),
    });
  }

  async #ensureProjectCategory(guildId) {
    const existing = this.state.data.discord?.projects?.[this.projectName]?.categoryId;
    if (existing) return existing;
    const category = await this.discord.createGuildCategory(guildId, this.projectName);
    await this.state.mapDiscordProject(this.projectName, category.id);
    return category.id;
  }

  async #ensureChannelForThread(threadId, thread = null) {
    const existing = this.state.getDiscordChannelForThread(threadId);
    if (existing) return existing;
    const guildId = this.state.data.discord?.guildId;
    if (!guildId) return null;
    const categoryId = await this.#ensureProjectCategory(guildId);
    const title = thread?.title ?? thread?.name ?? `Codex ${String(threadId).slice(0, 8)}`;
    const channel = await this.discord.createTextChannel(guildId, title, categoryId);
    await this.state.mapDiscordThread(threadId, channel.id, categoryId, title);
    await this.discord.sendMessage({ channelId: channel.id, text: `Linked Codex thread ${threadId}` });
    return channel.id;
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
    return text ? `Codex\n${text}` : null;
  }

  #rememberEchoSuppression(threadId, text) {
    const normalized = normalizeText(text);
    if (!normalized) return;
    const key = String(threadId);
    const now = Date.now();
    const entries = (this.echoSuppressions.get(key) ?? []).filter((entry) => now - entry.createdAt <= ECHO_SUPPRESSION_MS);
    entries.push({ text: normalized, createdAt: now });
    this.echoSuppressions.set(key, entries);
  }

  #forgetEchoSuppression(threadId, text) {
    const normalized = normalizeText(text);
    const key = String(threadId);
    const entries = (this.echoSuppressions.get(key) ?? []).filter((entry) => entry.text !== normalized);
    if (entries.length) this.echoSuppressions.set(key, entries);
    else this.echoSuppressions.delete(key);
  }

  #consumeEchoSuppression(event) {
    const text = normalizeText(extractUserMessageText(event));
    if (!text) return false;
    const key = String(event.threadId);
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

  async #rememberError(message) {
    if (typeof this.state.recordError === 'function') await this.state.recordError(String(message));
  }

  #logError(error) {
    this.#rememberError(error?.message ?? error).catch(() => {});
    this.logger.error(error);
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
