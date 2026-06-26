import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CodexDiscordChannelBridge } from '../src/discord-bridge.js';

const execFileAsync = promisify(execFile);

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
  assert.deepEqual(state.data.discord.projects, {});
  assert.equal(state.getDiscordChannelForThread('old'), null);
});

test('Discord bridge can pre-bind a guild from env config without creating a category', async () => {
  const state = memoryState();
  const discord = fakeDiscord();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: Date.now() - 10000 }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox', guildId: 'guild-1' });

  await bridge.start();
  await bridge.stop();

  assert.equal(state.data.discord.guildId, 'guild-1');
  assert.deepEqual(state.data.discord.projects, {});
  assert.deepEqual(discord.categories, []);
  assert.equal(state.getDiscordChannelForThread('old'), null);
});

test('new Codex threads create Discord channels under the worktree category', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  const discord = fakeDiscord();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: now - 10000 }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  codex.threads = [
    { id: 'old', title: 'Old', createdAt: now - 10000 },
    { id: 'new', title: 'New Work', cwd: '/home/yash/projects-shiprdev/erp/main', createdAt: Date.now() + 1000 },
  ];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getDiscordChannelForThread('new'), 'chan-1');
  assert.equal(state.data.discord.projects['erp/main'].categoryId, 'cat-1');
  assert.deepEqual(discord.channels, [{ guildId: 'guild-1', name: 'New Work', parentId: 'cat-1', id: 'chan-1' }]);
  assert.deepEqual(discord.categories, [{ guildId: 'guild-1', name: 'erp/main', id: 'cat-1' }]);
  assert.deepEqual(codex.resumed, ['new']);
});

test('Discord /new opens a project and worktree picker like Telegram', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-toolbox-discord-projects-'));
  const projectDir = join(root, 'sample-app');
  await mkdir(projectDir);
  await execFileAsync('git', ['init'], { cwd: projectDir });
  const oldProjectsRoot = process.env.CODEX_PROJECTS_ROOT;
  process.env.CODEX_PROJECTS_ROOT = root;
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('codex-toolbox', 'cat-1');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  try {
    await bridge.start();
    discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex new Investigate login', guild_id: 'guild-1', channel_id: 'general' }) });
    await delay(20);
    assert.match(discord.sent.at(-1).text, /Select a project/);
    const projectCustomId = discord.sent.at(-1).components[0].components[0].custom_id;
    discord.emit('dispatch', {
      type: 'INTERACTION_CREATE',
      data: { id: 'interaction-project', token: 'token', guild_id: 'guild-1', channel_id: 'general', data: { custom_id: projectCustomId }, member: { user: { id: 'user-1' } } },
    });
    await delay(20);
    assert.match(discord.interactions.at(-1).payload.data.content, /Select a worktree/);
    const worktreeCustomId = discord.interactions.at(-1).payload.data.components[0].components[0].custom_id;
    discord.emit('dispatch', {
      type: 'INTERACTION_CREATE',
      data: { id: 'interaction-worktree', token: 'token', guild_id: 'guild-1', channel_id: 'general', data: { custom_id: worktreeCustomId }, member: { user: { id: 'user-1' } } },
    });
    await delay(20);
    await bridge.stop();
  } finally {
    if (oldProjectsRoot == null) delete process.env.CODEX_PROJECTS_ROOT;
    else process.env.CODEX_PROJECTS_ROOT = oldProjectsRoot;
  }

  assert.deepEqual(codex.created, [{ title: 'Investigate login', options: { cwd: projectDir } }]);
  assert.equal(state.getDiscordChannelForThread('new-thread'), 'chan-1');
  assert.equal(state.data.discord.threads['new-thread'].categoryName, 'sample-app');
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

test('Discord agent channels route unmapped messages to AI Control before Codex thread warning', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, action: 'agent_chat', discordDelivered: true }),
    };
  };
  const bridge = new CodexDiscordChannelBridge({
    codex,
    discord,
    state,
    allowedUserIds: ['user-1'],
    projectName: 'codex-toolbox',
    aiControlBaseUrl: 'http://ai-control.local',
    aiControlDiscordSecret: 'shared-secret',
    aiControlTenantId: 'naiom',
  });

  try {
    await bridge.start();
    discord.emit('dispatch', {
      type: 'MESSAGE_CREATE',
      data: allowedMessage({
        id: 'message-1',
        content: 'status?',
        guild_id: 'guild-1',
        channel_id: 'agent-ea',
        author: { id: 'user-1', username: 'Owner' },
      }),
    });
    await tick();
    await bridge.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://ai-control.local/api/ai-control/discord');
  assert.equal(fetchCalls[0].options.headers['x-ai-control-discord-secret'], 'shared-secret');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    action: 'agent_message',
    tenantId: 'naiom',
    guildId: 'guild-1',
    channelId: 'agent-ea',
    messageId: 'message-1',
    authorId: 'user-1',
    authorName: 'Owner',
    text: 'status?',
    attachments: [],
  });
  assert.equal(discord.sent.length, 0);
  assert.deepEqual(codex.sent, []);
});

test('Discord agent channels forward attachment-only voice messages to AI Control', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, action: 'agent_chat', discordDelivered: true }),
    };
  };
  const bridge = new CodexDiscordChannelBridge({
    codex,
    discord,
    state,
    allowedUserIds: ['user-1'],
    projectName: 'codex-toolbox',
    aiControlBaseUrl: 'http://ai-control.local',
    aiControlDiscordSecret: 'shared-secret',
    aiControlTenantId: 'naiom',
  });

  try {
    await bridge.start();
    discord.emit('dispatch', {
      type: 'MESSAGE_CREATE',
      data: allowedMessage({
        id: 'message-voice-1',
        content: '',
        guild_id: 'guild-1',
        channel_id: 'agent-ea',
        author: { id: 'user-1', username: 'Owner' },
        attachments: [{
          id: 'attachment-1',
          filename: 'voice-message.ogg',
          url: 'https://cdn.discordapp.com/attachments/voice-message.ogg',
          proxy_url: 'https://media.discordapp.net/attachments/voice-message.ogg',
          content_type: 'audio/ogg',
          size: 2048,
          duration_secs: 4.2,
        }],
      }),
    });
    await tick();
    await bridge.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    action: 'agent_message',
    tenantId: 'naiom',
    guildId: 'guild-1',
    channelId: 'agent-ea',
    messageId: 'message-voice-1',
    authorId: 'user-1',
    authorName: 'Owner',
    text: '',
    attachments: [{
      id: 'attachment-1',
      filename: 'voice-message.ogg',
      url: 'https://cdn.discordapp.com/attachments/voice-message.ogg',
      proxyUrl: 'https://media.discordapp.net/attachments/voice-message.ogg',
      contentType: 'audio/ogg',
      size: 2048,
      durationSecs: 4.2,
    }],
  });
  assert.equal(discord.sent.length, 0);
  assert.deepEqual(codex.sent, []);
});

test('Discord agent-channel input does not suppress workspace user-message mirror', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('workspace-thread', 'workspace-chan', 'cat-1', 'Workspace');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, action: 'agent_chat', discordDelivered: true }),
  });
  const bridge = new CodexDiscordChannelBridge({
    codex,
    discord,
    state,
    allowedUserIds: ['user-1'],
    projectName: 'codex-toolbox',
    aiControlBaseUrl: 'http://ai-control.local',
    aiControlDiscordSecret: 'shared-secret',
    aiControlTenantId: 'naiom',
  });

  try {
    await bridge.start();
    discord.emit('dispatch', {
      type: 'MESSAGE_CREATE',
      data: allowedMessage({
        id: 'message-1',
        content: 'raw workspace visible',
        guild_id: 'guild-1',
        channel_id: 'agent-ea',
        author: { id: 'user-1', username: 'Owner' },
      }),
    });
    await tick();
    codex.emit('event', {
      method: 'item/completed',
      threadId: 'workspace-thread',
      raw: { params: { threadId: 'workspace-thread', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'raw workspace visible' }] } } },
    });
    await tick();
    await bridge.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(discord.sent.map((message) => message.text), ['userMessage\nUser\nraw workspace visible']);
});

test('Discord AI Control approval buttons post approval decisions', async () => {
  const state = memoryState();
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, code: 'APP123', decision: 'accept' }),
    };
  };
  const bridge = new CodexDiscordChannelBridge({
    codex,
    discord,
    state,
    allowedUserIds: ['user-1'],
    projectName: 'codex-toolbox',
    aiControlBaseUrl: 'http://ai-control.local',
    aiControlDiscordSecret: 'shared-secret',
    aiControlTenantId: 'naiom',
  });

  try {
    await bridge.start();
    discord.emit('dispatch', {
      type: 'INTERACTION_CREATE',
      data: {
        id: 'interaction-approval',
        token: 'token',
        channel_id: 'agent-ea',
        data: { custom_id: 'aiapproval:APP123:accept' },
        member: { user: { id: 'discord-requester' } },
      },
    });
    await tick();
    await bridge.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://ai-control.local/api/ai-control/discord');
  assert.equal(fetchCalls[0].options.headers['x-ai-control-discord-secret'], 'shared-secret');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    action: 'approval_decision',
    tenantId: 'naiom',
    channelId: 'agent-ea',
    authorId: 'discord-requester',
    code: 'APP123',
    decision: 'accept',
  });
  assert.equal(discord.interactions.at(-1).payload.data.content, 'Sent accept.');
  assert.equal(discord.interactions.at(-1).payload.data.flags, 64);
});

test('Discord unmapped non-agent channels keep the Codex thread warning', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, skipped: 'Discord channel is not mapped to an AI Control agent' }),
  });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  try {
    await bridge.start();
    discord.emit('dispatch', {
      type: 'MESSAGE_CREATE',
      data: allowedMessage({ id: 'message-1', content: 'hello', guild_id: 'guild-1', channel_id: 'general' }),
    });
    await tick();
    await bridge.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(discord.sent.at(-1).text, /not linked to a Codex thread/);
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

  assert.equal(discord.sent[0].text, 'agentMessage\nCodex\nhello');
  assert.match(discord.sent[1].text, /^server\/approval\nCommand approval requested/);
  assert.deepEqual(codex.answers, [{ id: 7, decision: 'accept', data: { threadId: 't1' } }]);
  assert.equal(discord.interactions.at(-1).payload.data.content, 'Sent accept.');
});

test('Discord tails mapped session files like Telegram', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-discord-tail-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, `${sessionLine('user_message', { message: 'old' })}\n`, 'utf8');
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('cli-thread', 'chan-1', 'cat-1', 'CLI');
  const discord = fakeDiscord();
  const codex = fakeCodex({ threads: [{ id: 'cli-thread', title: 'CLI', path: file, updatedAt: '1' }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  await appendFile(file, `${sessionLine('user_message', { message: 'from cli' })}\n${sessionLine('agent_message', { message: 'from assistant' })}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(discord.sent.map((message) => message.text), ['user_message\nUser\nfrom cli', 'agent_message\nCodex\nfrom assistant']);
});

test('Discord tails response item tool calls and outputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-discord-tools-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('tool-thread', 'chan-1', 'cat-1', 'Tool');
  const discord = fakeDiscord();
  const codex = fakeCodex({ threads: [{ id: 'tool-thread', title: 'Tool', path: file, updatedAt: '1' }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  await appendFile(file, `${responseToolCallLine('apply_patch')}\n${responseToolOutputLine('Exit code: 0\nOutput:\nSuccess')}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(discord.sent.map((message) => message.text), [
    'custom_tool_call\nTool call: apply_patch (completed)',
    'custom_tool_call_output\nTool output\nExit code: 0\nOutput:\nSuccess',
  ]);
});

test('Discord messageScope=conversation mirrors only user and agent session records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-discord-conversation-scope-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('scope-thread', 'chan-1', 'cat-1', 'Scope');
  const discord = fakeDiscord();
  const codex = fakeCodex({ threads: [{ id: 'scope-thread', title: 'Scope', path: file, updatedAt: '1' }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox', messageScope: 'conversation' });

  await bridge.start();
  await appendFile(file, `${sessionLine('user_message', { message: 'from user' })}\n${responseToolCallLine('apply_patch')}\n${sessionLine('agent_message', { message: 'from assistant' })}\n${sessionLine('task_complete', {})}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(discord.sent.map((message) => message.text), ['user_message\nUser\nfrom user', 'agent_message\nCodex\nfrom assistant']);
});

test('Discord messageScope=none disables mirrored Codex transcript messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-discord-none-scope-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('none-thread', 'chan-1', 'cat-1', 'None');
  const discord = fakeDiscord();
  const codex = fakeCodex({ threads: [{ id: 'none-thread', title: 'None', path: file, updatedAt: '1' }] });
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox', messageScope: 'none' });

  await bridge.start();
  await appendFile(file, `${sessionLine('user_message', { message: 'from user' })}\n${sessionLine('agent_message', { message: 'from assistant' })}\n`, 'utf8');
  await bridge.discoverThreads();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 'none-thread',
    raw: { params: { threadId: 'none-thread', item: { id: 'agent-1', type: 'agentMessage', text: 'live assistant' } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(discord.sent, []);
});

test('Discord pause and resume mirror Telegram mirroring controls', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('t1', 'chan-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex pause', guild_id: 'guild-1', channel_id: 'chan-1' }) });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'agent-1', type: 'agentMessage', text: 'hidden' } } },
  });
  await tick();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex resume', guild_id: 'guild-1', channel_id: 'chan-1' }) });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'agent-2', type: 'agentMessage', text: 'visible' } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(discord.sent.some((message) => message.text === 'agentMessage\nCodex\nhidden'), false);
  assert.equal(discord.sent.at(-1).text, 'agentMessage\nCodex\nvisible');
});

test('Discord /topics lists mappings', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('t1', 'chan-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex topics', guild_id: 'guild-1', channel_id: 'general' }) });
  await tick();
  await bridge.stop();

  assert.match(discord.sent.at(-1).text, /t1 -> channel chan-1 -> One/);
});

test('Discord /rename updates channel, state, and Codex', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordThread('t1', 'chan-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex rename Better Name', guild_id: 'guild-1', channel_id: 'chan-1' }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(discord.edited, [{ channelId: 'chan-1', name: 'Better Name' }]);
  assert.equal(state.data.discord.threads.t1.title, 'Better Name');
  assert.deepEqual(codex.renamed, [{ threadId: 't1', title: 'Better Name' }]);
  assert.match(discord.sent.at(-1).text, /Renamed this channel/);
});

test('Discord /delete_unlinked_channels confirm cleans the whole guild', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('codex-toolbox', 'cat-1');
  await state.mapDiscordThread('t1', 'linked-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  discord.guildChannels = [
    { id: 'cat-1', type: 4, name: 'codex-toolbox' },
    { id: 'cat-duplicate', type: 4, name: 'codex-toolbox' },
    { id: 'cat-other', type: 4, name: 'other' },
    { id: 'linked-1', type: 0, parent_id: 'cat-1', name: 'linked' },
    { id: 'orphan-1', type: 0, parent_id: 'cat-1', name: 'orphan' },
    { id: 'orphan-2', type: 0, parent_id: 'cat-duplicate', name: 'orphan-duplicate' },
    { id: 'voice-1', type: 2, parent_id: 'cat-1', name: 'voice' },
    { id: 'outside-1', type: 0, parent_id: 'cat-other', name: 'outside' },
  ];
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex delete_unlinked_channels confirm', guild_id: 'guild-1', channel_id: 'general' }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(discord.deleted, ['orphan-1', 'orphan-2', 'outside-1']);
  assert.equal(state.getDiscordChannelForThread('t1'), 'linked-1');
  assert.match(discord.sent.at(-1).text, /Deleted: 3/);
});

test('Discord /delete_unlinked_channels project confirm cleans known Codex categories only', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('codex-toolbox', 'cat-1');
  await state.mapDiscordThread('t1', 'linked-1', 'cat-1', 'One');
  const discord = fakeDiscord();
  discord.guildChannels = [
    { id: 'linked-1', type: 0, parent_id: 'cat-1', name: 'linked' },
    { id: 'orphan-1', type: 0, parent_id: 'cat-1', name: 'orphan' },
    { id: 'outside-1', type: 0, parent_id: 'cat-other', name: 'outside' },
    { id: 'general', type: 0, parent_id: null, name: 'general' },
  ];
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex delete_unlinked_channels project confirm', guild_id: 'guild-1', channel_id: 'general' }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(discord.deleted, ['orphan-1']);
  assert.equal(state.getDiscordChannelForThread('t1'), 'linked-1');
  assert.match(discord.sent.at(-1).text, /Scope: known Codex categories/);
});

test('Discord /delete_unlinked_channels confirm can delete the command channel last', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  const discord = fakeDiscord();
  discord.guildChannels = [
    { id: 'general', type: 0, parent_id: null, name: 'general' },
  ];
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex delete_unlinked_channels confirm', guild_id: 'guild-1', channel_id: 'general' }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(discord.sent.map((message) => message.text), ['Deleting 1 unlinked channel, including this channel.']);
  assert.deepEqual(discord.deleted, ['general']);
});

test('Discord /new accepts --cwd like Telegram', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-discord-cwd-'));
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('codex-toolbox', 'cat-1');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: `!codex new --cwd "${dir}" Investigate login`, guild_id: 'guild-1', channel_id: 'general' }) });
  await delay(20);
  await bridge.stop();

  assert.deepEqual(codex.created[0], { title: 'Investigate login', options: { cwd: dir } });
});

test('Discord /new rejects missing cwd like Telegram', async () => {
  const state = memoryState();
  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('codex-toolbox', 'cat-1');
  const discord = fakeDiscord();
  const codex = fakeCodex();
  const bridge = new CodexDiscordChannelBridge({ codex, discord, state, allowedUserIds: ['user-1'], projectName: 'codex-toolbox' });

  await bridge.start();
  discord.emit('dispatch', { type: 'MESSAGE_CREATE', data: allowedMessage({ content: '!codex new --cwd /definitely/not/a/real/path Investigate login', guild_id: 'guild-1', channel_id: 'general' }) });
  await delay(20);
  await bridge.stop();

  assert.deepEqual(codex.created, []);
  assert.match(discord.sent.at(-1).text, /Directory not found/);
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
  codex.createThread = async (title, options = {}) => {
    codex.created.push({ title, options });
    return 'new-thread';
  };
  codex.renameThread = async (threadId, title) => {
    codex.renamed ??= [];
    codex.renamed.push({ threadId, title });
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
  discord.edited = [];
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
  discord.editChannelName = async (channelId, name) => discord.edited.push({ channelId, name });
  discord.listGuildChannels = async () => discord.guildChannels ?? discord.channels.map((channel) => ({
    id: channel.id,
    type: 0,
    parent_id: channel.parentId,
    name: channel.name,
  }));
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
    async mapDiscordThread(threadId, channelId, categoryId, title = null, categoryName = null) {
      this.data.discord.threads[String(threadId)] = { threadId: String(threadId), channelId: String(channelId), categoryId: String(categoryId), categoryName, title };
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
    async clearApprovals() {
      this.data.approvals = {};
    },
    async setMirroringPaused(paused) {
      this.data.paused.mirroring = Boolean(paused);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionLine(type, payload) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, ...payload },
  });
}

function responseToolCallLine(name) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call-1',
      name,
      input: '{}',
    },
  });
}

function responseToolOutputLine(output) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-1',
      output,
    },
  });
}
