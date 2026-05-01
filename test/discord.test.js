import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { DiscordClient, approvalComponents, getDiscordCommand, getDiscordCommandArgs, sanitizeDiscordName } from '../src/discord.js';

test('creates Discord categories, channels, messages, and interactions', async () => {
  const calls = [];
  const client = new DiscordClient({
    token: 'token',
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, json: async () => ({ id: `id-${calls.length}` }) };
    },
  });

  await client.createGuildCategory('guild-1', 'My Project');
  await client.createTextChannel('guild-1', 'Investigate Bug!', 'cat-1');
  await client.sendMessage({ channelId: 'chan-1', text: 'hello', components: approvalComponents('cb1') });
  await client.createInteractionResponse('interaction-1', 'interaction-token', { type: 4, data: { content: 'ok' } });

  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/guilds\/guild-1\/channels$/);
  assert.equal(calls[0].body.type, 4);
  assert.equal(calls[0].body.name, 'My Project');
  assert.equal(calls[1].body.type, 0);
  assert.equal(calls[1].body.name, 'investigate-bug');
  assert.equal(calls[1].body.parent_id, 'cat-1');
  assert.equal(calls[2].body.allowed_mentions.parse.length, 0);
  assert.equal(calls[2].body.components[0].components[0].custom_id, 'approval:cb1:accept');
  assert.match(calls[3].url, /\/interactions\/interaction-1\/interaction-token\/callback$/);
});

test('parses Discord commands and sanitizes names', () => {
  assert.equal(getDiscordCommand({ content: '!codex new Fix bug' }), 'new');
  assert.equal(getDiscordCommandArgs({ content: '!codex new Fix bug' }), 'Fix bug');
  assert.equal(getDiscordCommand({ content: 'hello' }), null);
  assert.equal(sanitizeDiscordName('  Fix Login Bug!!  '), 'fix-login-bug');
  assert.equal(sanitizeDiscordName('Project Folder', { channel: false }), 'Project Folder');
});

test('Discord gateway identifies and emits dispatch events', async () => {
  const client = new DiscordClient({
    token: 'token',
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({ ok: true, status: 204, json: async () => null }),
  });
  let dispatch;
  client.on('dispatch', (event) => {
    dispatch = event;
  });

  client.startGateway();
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 10000 } }));
  assert.equal(JSON.parse(ws.sent.at(-1)).op, 2);
  ws.emit('message', JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { id: 'm1' } }));
  client.stopGateway();

  assert.deepEqual(dispatch, { type: 'MESSAGE_CREATE', data: { id: 'm1' } });
});

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.emit('close');
  }
}
