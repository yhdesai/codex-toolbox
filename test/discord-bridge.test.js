import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CodexDiscordChannelBridge } from '../src/discord-bridge.js';

test('Discord /bind creates a project category without backfilling old threads', async () => {
  const state = memoryState();
  const discord = fakeDiscord();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: Date.now() - 10000 }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex bind', guild_id: 'guild-1', channel_id: 'general' }) });
  await tick();
  await bridge.stop();

  assert.equal(state.data.discord.guildId, 'guild-1');
  assert.equal(state.data.discord.projects['codex-toolbox'].categoryId, 'cat-1');
  assert.equal(state.getDiscordChannelForThread('old'), null);
});

test('new Codex threads create Discord channels under the project category', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('codex-toolbox', 'cat-1');
  const discord = fakeDiscord();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: now - 10000 }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  codex.threads = [
    { id: 'old', title: 'Old', createdAt: now - 10000 },
    { id: 'new', title: 'New Work', createdAt: Date.now() + 1000 },
  ];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getDiscordChannelForThread('new'), 'chan-1');
  assert.deepEqual(discord.channels, [{ guildId: 'guild-1', name: 'New Work', parentId: 'cat-1', id: 'chan-1' }]);
  assert.deepEqual(codex.resumed, ['new']);
});

test('Discord /new creates a Codex thread and channel', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('codex-toolbox', 'cat-1');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex new Investigate login', guild_id: 'guild-1', channel_id: 'general' }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.created, ['Investigate login']);
  assert.equal(state.getDiscordChannelForThread('new-thread'), 'chan-1');
  assert.equal(discord.sent.at(-1).channelId, 'chan-1');
});

test('Discord channel messages route to mapped Codex thread and suppress echoes', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('t1', 'chan-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: 'continue', guild_id: 'guild-1', channel_id: 'chan-1' }) });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'continue' }] } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'continue' }]);
  assert.deepEqual(discord.sent, []);
});

test('Discord mirrors assistant messages and approval buttons', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('t1', 'chan-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'agent-1', type: 'agentMessage', text: 'hello' } } },
  });
  await tick();
  codex.emit('serverRequest', { id: 7, method: 'server/approval', threadId: 't1', params: { command: 'rm file' } });
  await tick();
  const callbackData = discord.sent.at(-1).components[0].components[0].custom_id;
  discord.emit('dispatch', {
    type: 'INTERACTION_CREATE',
    data: { id: 'interaction-1', token: 'token', channel_id: 'chan-1', data: { custom_id: callbackData }, member: { user: { id: 'user-1' } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(discord.sent[0].text, 'Codex\nhello');
  assert.match(discord.sent[1].text, /Command approval requested/);
  assert.deepEqual(codex.answers, [{ id: 7, decision: 'accept', data: { threadId: 't1' } }]);
  assert.equal(discord.interactions.at(-1).payload.data.content, 'Sent accept.');
});

test('Discord commands from other servers cannot control bound bridge', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('t1', 'chan-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex delete_all_channels confirm', guild_id: 'guild-2', channel_id: 'other' }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(discord.deleted, []);
  assert.equal(state.getDiscordChannelForThread('t1'), 'chan-1');
  assert.match(discord.sent.at(-1).text, /bind in this Discord server first/);
});

function fakeCodex({ threads = [] } = {}) {
  const codex = new EventEmitter();
  codex.threads = threads;
  codex.resumed = [];
  codex.sent = [];
  codex.created = [];
  codex.interrupted = [];
  codex.answers = [];
  codex.start = async () => {};
  codex.stop = () => {};
  codex.listThreads = async () => codex.threads;
  codex.resumeThread = async (threadId) => codex.resumed.push(threadId);
  codex.sendToThread = async (threadId, text) => codex.sent.push({ threadId, text });
  codex.createThread = async (title) => {
    codex.created.push(title);
    return 'new-thread';
  };
  codex.interrupt = async (threadId) => codex.interrupted.push(threadId);
  codex.answerServerRequest = (id, decision, data) => codex.answers.push({ id, decision, data });
  return codex;
}

function fakeDiscord() {
  const discord = new EventEmitter();
  discord.categories = [];
  discord.channels = [];
  discord.sent = [];
  discord.deleted = [];
  discord.interactions = [];
  discord.startGateway = () => {};
  discord.stopGateway = () => {};
  discord.createGuildCategory = async (guildId, name) => {
    const category = { guildId, name, id: `cat-${discord.categories.length + 1}` };
    discord.categories.push(category);
    return category;
  };
  discord.createTextChannel = async (guildId, name, parentId) => {
    const channel = { guildId, name, parentId, id: `chan-${discord.channels.length + 1}` };
    discord.channels.push(channel);
    return channel;
  };
  discord.deleteChannel = async (channelId) => discord.deleted.push(channelId);
  discord.sendMessage = async (message) => discord.sent.push(message);
  discord.createInteractionResponse = async (id, token, payload) => discord.interactions.push({ id, token, payload });
  return discord;
}

function allowedMessage(message) {
  return { author: { id: 'user-1' }, ...message };
}

function memoryState() {
  return {
    data: { boundChatId: null, threads: {}, topics: {}, approvals: {}, paused: { mirroring: false }, deletedThreadBaselines: {}, lastErrors: [], discord: { guildId: null, projects: {}, threads: {}, channels: {} } },
    async save() {},
    async bindDiscordGuild(guildId) {
      this.data.discord.guildId = String(guildId);
    },
    async mapDiscordProject(projectName, categoryId) {
      this.data.discord.projects[String(projectName)] = { projectName: String(projectName), categoryId: String(categoryId) };
    },
    getDiscordChannelForThread(threadId) {
      return this.data.discord.threads[String(threadId)]?.channelId ?? null;
    },
    getDiscordThreadForChannel(channelId) {
      return this.data.discord.channels[String(channelId)]?.threadId ?? null;
    },
    async mapDiscordThread(threadId, channelId, categoryId, title = null) {
      this.data.discord.threads[String(threadId)] = { threadId: String(threadId), channelId: String(channelId), categoryId: String(categoryId), title };
      this.data.discord.channels[String(channelId)] = { channelId: String(channelId), threadId: String(threadId) };
    },
    async unmapDiscordThread(threadId) {
      const mapping = this.data.discord.threads[String(threadId)];
      if (!mapping) return null;
      delete this.data.discord.threads[String(threadId)];
      delete this.data.discord.channels[String(mapping.channelId)];
      return mapping;
    },
    async unmapDiscordChannel(channelId) {
      const mapping = this.data.discord.channels[String(channelId)];
      if (!mapping) return null;
      return this.unmapDiscordThread(mapping.threadId);
    },
    async rememberApproval(callbackId, approval) {
      this.data.approvals[callbackId] = approval;
    },
    async takeApproval(callbackId) {
      const approval = this.data.approvals[callbackId] ?? null;
      delete this.data.approvals[callbackId];
      return approval;
    },
    async recordError(message) {
      this.data.lastErrors.push({ message });
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
