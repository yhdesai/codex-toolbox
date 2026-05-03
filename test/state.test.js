import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { BridgeState } from '../src/state.js';

test('persists group binding and thread topic mappings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-state-'));
  const file = join(dir, 'state.json');

  const state = await BridgeState.load(file);
  await state.bindChat(-100123);
  await state.mapThread('thread-a', 42, 'Thread A');

  const loaded = await BridgeState.load(file);
  assert.equal(loaded.boundChatId, '-100123');
  assert.equal(loaded.getTopicForThread('thread-a'), 42);
  assert.equal(loaded.getThreadForTopic(42), 'thread-a');

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.threads['thread-a'].title, 'Thread A');
});

test('keeps thread and topic mappings one-to-one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-state-'));
  const file = join(dir, 'state.json');

  const state = await BridgeState.load(file);
  await state.mapThread('thread-a', 41, 'Thread A');
  await state.mapThread('thread-a', 42, 'Thread A moved');
  await state.mapThread('thread-b', 42, 'Thread B');

  assert.equal(state.getTopicForThread('thread-a'), null);
  assert.equal(state.getTopicForThread('thread-b'), 42);
  assert.equal(state.getThreadForTopic(41), null);
  assert.equal(state.getThreadForTopic(42), 'thread-b');
});

test('normalizes stale topic aliases on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-state-'));
  const file = join(dir, 'state.json');
  await writeState(file, {
    threads: {
      'thread-a': { threadId: 'thread-a', messageThreadId: 42, title: 'Thread A' },
    },
    topics: {
      41: { messageThreadId: 41, threadId: 'thread-a' },
      42: { messageThreadId: 42, threadId: 'thread-a' },
    },
  });

  const loaded = await BridgeState.load(file);

  assert.equal(loaded.getTopicForThread('thread-a'), 42);
  assert.equal(loaded.getThreadForTopic(41), null);
  assert.equal(loaded.getThreadForTopic(42), 'thread-a');
});

test('approval records are one-shot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-state-'));
  const state = await BridgeState.load(join(dir, 'state.json'));
  await state.rememberApproval('cb1', { requestId: 7, threadId: 't1' });

  const approval = await state.takeApproval('cb1');
  assert.equal(approval.requestId, 7);
  assert.equal(approval.threadId, 't1');
  assert.equal(typeof approval.createdAt, 'string');
  assert.equal(await state.takeApproval('cb1'), null);
});

test('persists ops metadata and mapping cleanup helpers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-state-'));
  const file = join(dir, 'state.json');
  const state = await BridgeState.load(file);
  await state.mapThread('thread-a', 42, 'Thread A');
  await state.rememberApproval('cb1', { requestId: 7, threadId: 'thread-a' });
  await state.setMirroringPaused(true);
  await state.markDeletedThreadBaselines(['thread-a']);
  await state.recordError('first');
  await state.recordError('second');
  const unmapped = await state.unmapTopic(42);
  await state.clearApprovals();

  assert.equal(unmapped.threadId, 'thread-a');
  assert.equal(state.getTopicForThread('thread-a'), null);

  const loaded = await BridgeState.load(file);
  assert.equal(loaded.data.paused.mirroring, true);
  assert.ok(loaded.data.deletedThreadBaselines['thread-a']);
  assert.deepEqual(Object.keys(loaded.data.approvals), []);
  assert.equal(loaded.data.lastErrors.at(-1).message, 'second');
});

test('persists Discord guild, project, and channel mappings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-state-'));
  const file = join(dir, 'state.json');
  const state = await BridgeState.load(file);

  await state.bindDiscordGuild('guild-1');
  await state.mapDiscordProject('project-a', 'cat-1');
  await state.mapDiscordThread('thread-a', 'chan-1', 'cat-1', 'Thread A');

  assert.equal(state.getDiscordChannelForThread('thread-a'), 'chan-1');
  assert.equal(state.getDiscordThreadForChannel('chan-1'), 'thread-a');

  const loaded = await BridgeState.load(file);
  assert.equal(loaded.data.discord.guildId, 'guild-1');
  assert.equal(loaded.data.discord.projects['project-a'].categoryId, 'cat-1');
  assert.equal(loaded.getDiscordChannelForThread('thread-a'), 'chan-1');

  const unmapped = await loaded.unmapDiscordChannel('chan-1');
  assert.equal(unmapped.threadId, 'thread-a');
  assert.equal(loaded.getDiscordChannelForThread('thread-a'), null);
});

async function writeState(file, partial) {
  const state = {
    boundChatId: null,
    threads: {},
    topics: {},
    approvals: {},
    paused: { mirroring: false },
    deletedThreadBaselines: {},
    lastErrors: [],
    discord: { guildId: null, projects: {}, threads: {}, channels: {} },
    ...partial,
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
