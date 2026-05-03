import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkTelegramText } from '../src/chunking.js';
import { TelegramClient, approvalKeyboard, getCommand, isForumMessage, sanitizeTopicName } from '../src/telegram.js';

test('chunks long Telegram messages under the configured limit', () => {
  const chunks = chunkTelegramText(`hello\n${'x'.repeat(25)} ${'y'.repeat(25)}`, 20);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
});

test('sends messages to forum topics with inline keyboards', async () => {
  const calls = [];
  const client = new TelegramClient({
    token: 'token',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
    },
  });

  await client.sendMessage({
    chatId: -1001,
    messageThreadId: 22,
    text: 'Approve?',
    replyMarkup: approvalKeyboard('abc'),
  });

  assert.equal(calls[0].body.chat_id, -1001);
  assert.equal(calls[0].body.message_thread_id, 22);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'approval:abc:accept');
});

test('deletes and edits forum topics', async () => {
  const calls = [];
  const client = new TelegramClient({
    token: 'token',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    },
  });

  await client.deleteForumTopic(-1001, 22);
  await client.editForumTopic(-1001, 22, '  renamed   topic  ');

  assert.match(calls[0].url, /deleteForumTopic$/);
  assert.equal(calls[0].body.chat_id, -1001);
  assert.equal(calls[0].body.message_thread_id, 22);
  assert.match(calls[1].url, /editForumTopic$/);
  assert.equal(calls[1].body.name, 'renamed topic');
});

test('sets Telegram command menu', async () => {
  const calls = [];
  const client = new TelegramClient({
    token: 'token',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    },
  });

  await client.setMyCommands([{ command: 'new', description: 'Create a Codex topic' }]);

  assert.match(calls[0].url, /setMyCommands$/);
  assert.deepEqual(calls[0].body.commands, [{ command: 'new', description: 'Create a Codex topic' }]);
});

test('parses commands and forum messages', () => {
  assert.equal(getCommand({ text: '/bind@my_bot now' }), '/bind');
  assert.equal(isForumMessage({ chat: { type: 'supergroup' }, is_topic_message: true }), true);
  assert.equal(sanitizeTopicName('  a   b  '), 'a b');
});
