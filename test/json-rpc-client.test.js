import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { JsonRpcClient } from '../src/json-rpc-client.js';

test('matches JSON-RPC responses to pending requests', async () => {
  const spawned = [];
  const client = new JsonRpcClient({
    command: 'codex',
    args: ['app-server', 'proxy'],
    spawnImpl: () => {
      const child = fakeChild();
      spawned.push(child);
      return child;
    },
  });

  client.start();
  const promise = client.request('thread/list', {});
  const sent = JSON.parse(spawned[0].writes[0]);
  spawned[0].stdout.write(`${JSON.stringify({ id: sent.id, result: { threads: [{ id: 't1' }] } })}\n`);

  assert.deepEqual(await promise, { threads: [{ id: 't1' }] });
});

test('emits server requests and can respond', () => {
  const child = fakeChild();
  const client = new JsonRpcClient({ command: 'codex', spawnImpl: () => child });
  client.start();

  let request;
  client.on('serverRequest', (message) => {
    request = message;
    client.respond(message.id, { decision: 'accept' });
  });

  child.stdout.write(`${JSON.stringify({ id: 99, method: 'server/request', params: { threadId: 't1' } })}\n`);

  assert.equal(request.id, 99);
  assert.deepEqual(JSON.parse(child.writes[0]), { id: 99, result: { decision: 'accept' } });
});

test('reconnects after process exit', async () => {
  const spawned = [];
  const client = new JsonRpcClient({
    command: 'codex',
    reconnectMs: 5,
    spawnImpl: () => {
      const child = fakeChild();
      spawned.push(child);
      return child;
    },
  });

  client.start();
  spawned[0].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.stop();

  assert.equal(spawned.length, 2);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.writes = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.writes.push(chunk.toString('utf8').trim());
      callback();
    },
  });
  child.kill = () => {};
  return child;
}
