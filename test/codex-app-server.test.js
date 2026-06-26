import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CodexAppServer } from '../src/codex-app-server.js';

test('treats already-initialized app-server responses as ready', async () => {
  const client = new EventEmitter();
  client.requests = [];
  client.notifications = [];
  client.start = () => {};
  client.stop = () => {};
  client.request = async (method, params) => {
    client.requests.push({ method, params });
    const error = new Error('Already initialized');
    error.code = -32600;
    throw error;
  };
  client.notify = (method, params) => client.notifications.push({ method, params });

  const server = new CodexAppServer({ client });
  let ready = null;
  server.on('ready', (event) => {
    ready = event;
  });

  await server.start();

  assert.equal(client.requests[0].method, 'initialize');
  assert.deepEqual(client.notifications, []);
  assert.deepEqual(ready, { reconnect: false });
});
