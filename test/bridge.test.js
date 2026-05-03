import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CodexTelegramTopicBridge } from '../src/bridge.js';

const execFileAsync = promisify(execFile);

test('/bind stores group without creating topics for existing discovered threads', async () => {
  const state = memoryState();
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 't1', title: 'One' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/bind', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.equal(state.boundChatId, '-100');
  assert.equal(state.getTopicForThread('t1'), null);
  assert.deepEqual(telegram.created, []);
  assert.deepEqual(codex.resumed, []);
});

test('newly discovered threads after startup get topics', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: now - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [{ id: 'old', title: 'Old', createdAt: now - 10000 }, { id: 'new', title: 'New', createdAt: Date.now() + 1000 }];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('old'), null);
  assert.equal(state.getTopicForThread('new'), 1001);
  assert.deepEqual(codex.resumed, ['new']);
});

test('older unseen threads after startup are not backfilled', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old-a', title: 'Old A', createdAt: now - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [
    { id: 'old-a', title: 'Old A', createdAt: now - 10000 },
    { id: 'old-b', title: 'Old B', createdAt: now - 9000 },
  ];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('old-a'), null);
  assert.equal(state.getTopicForThread('old-b'), null);
  assert.deepEqual(telegram.created, []);
});

test('unmapped old threads get topics when updated after startup', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: Date.now() - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [{ id: 'old', title: 'Old', updatedAt: Date.now() + 1000 }];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('old'), 1001);
  assert.deepEqual(codex.resumed, ['old']);
});

test('mapped threads are resumed on startup and events are mirrored', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: Date.now() - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'item/agentMessage/delta',
    threadId: 'old',
    raw: { params: { threadId: 'old', role: 'assistant', text: 'hello' } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.resumed, ['old']);
  assert.equal(telegram.sent.at(-1).messageThreadId, 44);
  assert.match(telegram.sent.at(-1).text, /hello/);
});

test('mapped CLI session files are tailed for new messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-cli-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, `${sessionLine('user_message', { message: 'old' })}\n`, 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('cli-thread', 44, 'CLI');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'cli-thread', title: 'CLI', source: 'cli', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  assert.deepEqual(telegram.sent, []);

  await appendFile(file, `${sessionLine('user_message', { message: 'from cli' })}\n${sessionLine('agent_message', { message: 'from assistant' })}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.map((message) => message.text), ['User\nfrom cli', 'Codex\nfrom assistant']);
});

test('CLI session tailing does not duplicate messages already mirrored from app-server events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-cli-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('cli-thread', 44, 'CLI');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'cli-thread', title: 'CLI', source: 'cli', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 'cli-thread',
    raw: { params: { threadId: 'cli-thread', item: { id: 'agent-1', type: 'agentMessage', text: 'same answer' } } },
  });
  await tick();
  await appendFile(file, `${sessionLine('agent_message', { message: 'same answer' })}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.map((message) => message.text), ['Codex\nsame answer']);
});

test('newly discovered CLI session files mirror existing first turn after topic creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-cli-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, `${sessionLine('user_message', { message: 'first prompt' })}\n${sessionLine('agent_message', { message: 'first answer' })}\n`, 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: now - 10000, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [
    { id: 'old', title: 'Old', createdAt: now - 10000, updatedAt: '1' },
    { id: 'cli-thread', title: 'CLI', source: 'cli', path: file, createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000 },
  ];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('cli-thread'), 1001);
  assert.deepEqual(telegram.sent.map((message) => message.text), [
    'Linked Codex thread cli-thread',
    'User\nfirst prompt',
    'Codex\nfirst answer',
  ]);
});

test('agent message deltas are buffered until item completion', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: Date.now() - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  for (const delta of ['Hi', '. ', 'What ', 'do ', 'you ', 'want?']) {
    codex.emit('event', {
      method: 'item/agentMessage/delta',
      threadId: 'old',
      raw: { params: { threadId: 'old', itemId: 'item-1', delta } },
    });
  }
  await tick();
  assert.deepEqual(telegram.sent, []);

  codex.emit('event', {
    method: 'item/completed',
    threadId: 'old',
    raw: { params: { threadId: 'old', item: { id: 'item-1', type: 'agentMessage', text: 'Hi. What do you want?' } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].text, 'Codex\nHi. What do you want?');
});

test('thread status changes are not mirrored', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'thread/status/changed',
    threadId: 'old',
    raw: { params: { threadId: 'old', status: { type: 'idle' } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(telegram.sent, []);
});

test('topic replies route to the mapped Codex thread', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: {
      text: 'continue',
      from: { id: 111111111 },
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'continue' }]);
});

test('telegram-originated topic replies are not mirrored back as user echoes', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'hi' }]);
  assert.deepEqual(telegram.sent, []);
});

test('telegram-originated echoes are suppressed when Codex emits before send resolves', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  codex.sendToThread = async (threadId, text) => {
    codex.sent.push({ threadId, text });
    codex.emit('event', {
      method: 'item/completed',
      threadId,
      raw: { params: { threadId, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text }] } } },
    });
    await tick();
  };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'hi' }]);
  assert.deepEqual(telegram.sent, []);
});

test('telegram-originated echoes are suppressed even if Codex reports a different thread id', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('routed-thread', 44, 'Routed');
  await state.mapThread('event-thread', 45, 'Event');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 'event-thread',
    raw: { params: { threadId: 'event-thread', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 'routed-thread', text: 'hi' }]);
  assert.deepEqual(telegram.sent, []);
});

test('desktop-originated user messages still mirror with a user label', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'from desktop' }] } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].text, 'User\nfrom desktop');
});

test('topic replies in unmapped topics get a clear error', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 99,
    }),
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, []);
  assert.match(telegram.sent.at(-1).text, /not linked to a Codex thread/);
});

test('allowed messages outside forum topics get guidance', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
    }),
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, []);
  assert.match(telegram.sent.at(-1).text, /not inside a Telegram forum topic/);
});

test('/status reports bridge state', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: '/status',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  await bridge.stop();

  const status = telegram.sent.at(-1).text;
  assert.match(status, /Codex Toolbox status/);
  assert.match(status, /Bound group: -100/);
  assert.match(status, /Mapped threads: 1/);
  assert.match(status, /Mirroring paused: no/);
  assert.match(status, /Pending approvals: 0/);
  assert.match(status, /Allowed users: 111111111/);
});

test('/help returns command list', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/help', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /\/delete_all_topics confirm/);
  assert.match(telegram.sent.at(-1).text, /\/relink <threadId>/);
});

test('/topics lists mappings and handles empty state', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/topics', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  assert.match(telegram.sent.at(-1).text, /No Codex topics/);

  await state.mapThread('t1', 44, 'One');
  telegram.emit('update', { message: allowedMessage({ text: '/topics', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /t1 -> topic 44 -> One/);
});

test('/delete_all_topics requires confirm', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/delete_all_topics', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), 44);
  assert.match(telegram.sent.at(-1).text, /Run \/delete_all_topics confirm/);
});

test('/delete_all_topics confirm deletes mapped topics and prevents immediate recreation', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '10' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/delete_all_topics confirm', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.deleted, [{ chatId: '-100', messageThreadId: 44 }]);
  assert.equal(state.boundChatId, '-100');
  assert.equal(state.getTopicForThread('old'), null);
  assert.deepEqual(telegram.created, []);
  assert.ok(state.data.deletedThreadBaselines.old);
});

test('/delete_all_topics confirm keeps failed mappings', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  await state.mapThread('t2', 45, 'Two');
  const telegram = fakeTelegram();
  telegram.deleteForumTopic = async (chatId, messageThreadId) => {
    if (Number(messageThreadId) === 45) throw new Error('delete denied');
    telegram.deleted.push({ chatId, messageThreadId });
  };
  const codex = fakeCodex();
  const logger = { error() {}, warn() {} };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], logger });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/delete_all_topics confirm', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), null);
  assert.equal(state.getTopicForThread('t2'), 45);
  assert.match(telegram.sent.at(-1).text, /Failed topics: 1/);
});

test('/unlink removes the current topic mapping without deleting it', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/unlink', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), null);
  assert.deepEqual(telegram.deleted, []);
  assert.match(telegram.sent.at(-1).text, /Unlinked Codex thread t1/);
});

test('/relink maps a topic to an existing thread and rejects missing thread ids', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 't1', title: 'One' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/relink missing', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  assert.match(telegram.sent.at(-1).text, /was not found/);

  telegram.emit('update', { message: allowedMessage({ text: '/relink t1', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), 44);
  assert.deepEqual(codex.resumed, ['t1']);
});

test('/pause suppresses mirroring but still allows topic replies, and /resume re-enables mirroring', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/pause', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  const sentAfterPause = telegram.sent.length;
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'agent-1', type: 'agentMessage', text: 'hidden' } } },
  });
  await tick();
  telegram.emit('update', { message: allowedMessage({ text: 'continue', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  telegram.emit('update', { message: allowedMessage({ text: '/resume', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'agent-2', type: 'agentMessage', text: 'visible' } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(telegram.sent.length >= sentAfterPause, true);
  assert.equal(telegram.sent.some((message) => message.text === 'Codex\nhidden'), false);
  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'continue' }]);
  assert.equal(telegram.sent.at(-1).text, 'Codex\nvisible');
});

test('/rename updates Telegram, state, and Codex when possible', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/rename Better Name', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(telegram.edited, [{ chatId: '-100', messageThreadId: 44, title: 'Better Name' }]);
  assert.equal(state.data.threads.t1.title, 'Better Name');
  assert.deepEqual(codex.renamed, [{ threadId: 't1', title: 'Better Name' }]);
});

test('/logs returns redacted diagnostics', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const fakeToken = `123456789:${'abcdefghijklmnopqrstuvwxyz'}`;
  await state.recordError(`token ${fakeToken}`);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/logs', chat: { id: -100, type: 'supergroup' } }) });
  await delay(10);
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /diagnostics/);
  assert.match(telegram.sent.at(-1).text, /\[redacted-token\]/);
  assert.equal(telegram.sent.at(-1).text.includes(fakeToken), false);
});

test('topic creation permission failures are reported to Telegram', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  telegram.createForumTopic = async () => {
    throw new Error('Bad Request: not enough rights to create a topic');
  };
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '1' }] });
  const logger = { error() {}, warn() {} };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], logger });

  await bridge.start();
  codex.threads = [
    { id: 'old', title: 'Old', updatedAt: Date.now() - 10000 },
    { id: 't1', title: 'One', createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000 },
  ];
  await bridge.discoverThreads();
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), null);
  assert.match(telegram.sent.at(-1).text, /Could not create Telegram topic/);
});

test('topic creation rate limits pause repeated topic creation attempts', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  let attempts = 0;
  telegram.createForumTopic = async () => {
    attempts += 1;
    const error = new Error('Too Many Requests: retry after 60');
    error.retryAfter = 60;
    error.response = { error_code: 429 };
    throw error;
  };
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '1' }] });
  const logger = { error() {}, warn() {} };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], logger });

  await bridge.start();
  codex.threads = [{ id: 'old', title: 'Old', updatedAt: Date.now() + 1000 }];
  await bridge.discoverThreads();
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(attempts, 1);
  assert.equal(state.getTopicForThread('old'), null);
});

test('/new without --cwd opens the project selector', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/new Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
  await delay(100);
  await bridge.stop();

  assert.deepEqual(codex.created, []);
  assert.match(telegram.sent.at(-1).text, /Select a project/);
  assert.ok(telegram.sent.at(-1).replyMarkup);
  assert.equal(telegram.sent.at(-1).replyMarkup.inline_keyboard.at(-1)[0].text, 'Help');
});

test('/new accepts --cwd to start a Codex thread in a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-new-cwd-'));
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: `/new --cwd "${dir}" Investigate bug`, chat: { id: -100, type: 'supergroup' } }) });
  await delay(50);
  await bridge.stop();

  assert.deepEqual(codex.created[0], { title: 'Investigate bug', options: { cwd: dir } });
  assert.equal(state.getTopicForThread('new-thread'), 1001);
  assert.match(telegram.sent.at(-1).text, new RegExp(`Directory: ${escapeRegex(dir)}`));
});

test('/new project and worktree callbacks create a Codex thread in the selected worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-projects-'));
  const root = join(dir, 'projects-shiprdev');
  const worktree = join(root, 'omniflow', 'main');
  await mkdir(worktree, { recursive: true });
  await execGit(['init'], worktree);
  const previousRoot = process.env.CODEX_PROJECTS_ROOT;
  process.env.CODEX_PROJECTS_ROOT = root;
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  try {
    await bridge.start();
    telegram.emit('update', { message: allowedMessage({ text: '/new Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
    await delay(20);
    const projectCallback = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
    telegram.emit('update', { callback_query: { id: 'project-cb', from: { id: 111111111 }, data: projectCallback } });
    await delay(20);
    const worktreeCallback = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
    telegram.emit('update', { callback_query: { id: 'worktree-cb', from: { id: 111111111 }, data: worktreeCallback } });
    await delay(20);
    await bridge.stop();
  } finally {
    if (previousRoot == null) delete process.env.CODEX_PROJECTS_ROOT;
    else process.env.CODEX_PROJECTS_ROOT = previousRoot;
  }

  assert.deepEqual(codex.created[0], { title: 'Investigate bug', options: { cwd: worktree } });
  assert.equal(state.getTopicForThread('new-thread'), 1001);
});

test('startup registers Telegram command menu when supported', async () => {
  const state = memoryState();
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  await bridge.stop();

  assert.deepEqual(telegram.commands.map((command) => command.command), ['new', 'topics', 'status', 'interrupt', 'rename', 'pause', 'resume', 'help']);
});

test('/new inline help callback sends help text', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/new', chat: { id: -100, type: 'supergroup' } }) });
  await delay(100);
  const helpCallback = telegram.sent.at(-1).replyMarkup.inline_keyboard.at(-1)[0].callback_data;
  telegram.emit('update', { callback_query: { id: 'help-cb', from: { id: 111111111 }, data: helpCallback } });
  await delay(20);
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /Codex Toolbox commands/);
  assert.match(telegram.sent.at(-1).text, /\/new Optional title/);
});

test('/new rejects missing or relative cwd values', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/new --cwd relative-path Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
  await delay(10);
  telegram.emit('update', { message: allowedMessage({ text: '/new --cwd /definitely/not/a/real/path Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
  await delay(10);
  await bridge.stop();

  assert.deepEqual(codex.created, []);
  assert.match(telegram.sent.at(-2).text, /Use an absolute directory path/);
  assert.match(telegram.sent.at(-1).text, /Directory not found/);
});

test('/interrupt inside topic calls Codex interrupt', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/interrupt', chat: { id: -100, type: 'supergroup' }, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.interrupted, ['t1']);
});

test('approval callbacks answer server requests with decisions', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('serverRequest', { id: 8, method: 'server/approval', threadId: 't1', params: { command: 'ls' } });
  await tick();
  const callbackData = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
  telegram.emit('update', { callback_query: { id: 'cbq', from: { id: 111111111 }, data: callbackData } });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.answers, [{ id: 8, decision: 'accept', data: { threadId: 't1' } }]);
});

test('unauthorized users cannot route topic replies', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: {
      text: 'continue',
      from: { id: 123 },
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, []);
  assert.deepEqual(telegram.sent, []);
});

test('unauthorized users cannot answer approval callbacks', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('serverRequest', { id: 8, method: 'server/approval', threadId: 't1', params: { command: 'ls' } });
  await tick();
  const callbackData = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
  telegram.emit('update', { callback_query: { id: 'cbq', from: { id: 123 }, data: callbackData } });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.answers, []);
  assert.equal(telegram.callbackAnswers.at(-1).text, 'You are not allowed to control this Codex bridge.');
});

function fakeCodex({ threads = [] } = {}) {
  const codex = new EventEmitter();
  codex.threads = threads;
  codex.resumed = [];
  codex.sent = [];
  codex.created = [];
  codex.interrupted = [];
  codex.answers = [];
  codex.renamed = [];
  codex.start = async () => {};
  codex.stop = () => {};
  codex.listThreads = async () => codex.threads;
  codex.resumeThread = async (threadId) => codex.resumed.push(threadId);
  codex.sendToThread = async (threadId, text) => codex.sent.push({ threadId, text });
  codex.createThread = async (title, options = {}) => {
    codex.created.push({ title, options });
    return 'new-thread';
  };
  codex.interrupt = async (threadId) => codex.interrupted.push(threadId);
  codex.renameThread = async (threadId, title) => codex.renamed.push({ threadId, title });
  codex.answerServerRequest = (id, decision, data) => codex.answers.push({ id, decision, data });
  return codex;
}

function fakeTelegram() {
  const telegram = new EventEmitter();
  telegram.sent = [];
  telegram.created = [];
  telegram.deleted = [];
  telegram.edited = [];
  telegram.callbackAnswers = [];
  telegram.commands = [];
  telegram.startPolling = async () => {};
  telegram.stopPolling = () => {};
  telegram.createForumTopic = async (chatId, title) => {
    telegram.created.push({ chatId, title });
    return 1000 + telegram.created.length;
  };
  telegram.deleteForumTopic = async (chatId, messageThreadId) => {
    telegram.deleted.push({ chatId, messageThreadId });
  };
  telegram.editForumTopic = async (chatId, messageThreadId, title) => {
    telegram.edited.push({ chatId, messageThreadId, title });
  };
  telegram.sendMessage = async (message) => {
    telegram.sent.push(message);
  };
  telegram.answerCallbackQuery = async (id, text) => {
    telegram.callbackAnswers.push({ id, text });
  };
  telegram.setMyCommands = async (commands) => {
    telegram.commands = commands;
  };
  return telegram;
}

function allowedMessage(message) {
  return { from: { id: 111111111 }, ...message };
}

function memoryState() {
  return {
    data: { boundChatId: null, threads: {}, topics: {}, approvals: {}, paused: { mirroring: false }, deletedThreadBaselines: {}, lastErrors: [] },
    get boundChatId() {
      return this.data.boundChatId;
    },
    async bindChat(chatId) {
      this.data.boundChatId = String(chatId);
    },
    getTopicForThread(threadId) {
      return this.data.threads[String(threadId)]?.messageThreadId ?? null;
    },
    getThreadForTopic(topicId) {
      return this.data.topics[String(topicId)]?.threadId ?? null;
    },
    async mapThread(threadId, messageThreadId, title) {
      this.data.threads[String(threadId)] = { threadId, messageThreadId, title };
      this.data.topics[String(messageThreadId)] = { messageThreadId, threadId };
    },
    async updateThreadTitle(threadId, title) {
      this.data.threads[String(threadId)].title = title;
      return true;
    },
    async unmapThread(threadId) {
      const thread = this.data.threads[String(threadId)] ?? null;
      if (!thread) return null;
      delete this.data.threads[String(threadId)];
      delete this.data.topics[String(thread.messageThreadId)];
      return thread;
    },
    async unmapTopic(topicId) {
      const topic = this.data.topics[String(topicId)] ?? null;
      if (!topic) return null;
      return this.unmapThread(topic.threadId);
    },
    async clearTopicMappings() {
      const threads = Object.values(this.data.threads);
      this.data.threads = {};
      this.data.topics = {};
      this.data.approvals = {};
      return threads;
    },
    async clearApprovals() {
      this.data.approvals = {};
    },
    async setMirroringPaused(paused) {
      this.data.paused.mirroring = Boolean(paused);
    },
    async markDeletedThreadBaselines(threadIds, timestamp = new Date().toISOString()) {
      for (const threadId of threadIds) this.data.deletedThreadBaselines[String(threadId)] = timestamp;
    },
    async recordError(message) {
      this.data.lastErrors.push({ message, createdAt: new Date().toISOString() });
      this.data.lastErrors = this.data.lastErrors.slice(-20);
    },
    async rememberApproval(callbackId, approval) {
      this.data.approvals[callbackId] = approval;
    },
    async takeApproval(callbackId) {
      const approval = this.data.approvals[callbackId] ?? null;
      delete this.data.approvals[callbackId];
      return approval;
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execGit(args, cwd) {
  await execFileAsync('git', args, { cwd });
}

function sessionLine(type, payload) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, ...payload },
  });
}
