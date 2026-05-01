import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BridgeState } from '../src/state.js';

test('persists group binding and thread topic mappings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sync-state-'));
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

test('approval records are one-shot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sync-state-'));
  const state = await BridgeState.load(join(dir, 'state.json'));
  await state.rememberApproval('cb1', { requestId: 7, threadId: 't1' });

  const approval = await state.takeApproval('cb1');
  assert.equal(approval.requestId, 7);
  assert.equal(approval.threadId, 't1');
  assert.equal(typeof approval.createdAt, 'string');
  assert.equal(await state.takeApproval('cb1'), null);
});

test('persists ops metadata and mapping cleanup helpers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sync-state-'));
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
