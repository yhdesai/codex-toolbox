import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WatchApiServer, parseWatchProjects } from '../src/watch-api.js';

test('Watch API creates a Codex session and exposes progress', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-watch-api-'));
  const codex = fakeCodex();
  const api = new WatchApiServer({ codex, port: 0, projects: [{ name: 'app', path: cwd }] });
  const created = await ok(api.inject({
    method: 'POST',
    path: '/watch/sessions',
    body: { prompt: 'Fix login crash and open a PR', cwd: 'app' },
  }));

  assert.equal(created.session.threadId, 'thread-1');
  assert.equal(created.session.cwd, cwd);
  assert.equal(created.session.status, 'working');
  assert.deepEqual(codex.created, [{ title: 'Fix login crash and open', options: { cwd } }]);
  assert.deepEqual(codex.sent, [{ threadId: 'thread-1', text: 'Fix login crash and open a PR' }]);

  codex.emit('event', {
    method: 'item/completed',
    threadId: 'thread-1',
    raw: { params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'I changed the auth guard.' } } },
  });

  const listed = await ok(api.inject({ path: '/watch/sessions' }));
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].latest, 'Codex I changed the auth guard.');
  assert.equal(listed.sessions[0].status, 'working');
});

test('Watch API routes replies and interrupts to Codex', async () => {
  const codex = fakeCodex();
  const api = new WatchApiServer({ codex, port: 0 });
  await ok(api.inject({ method: 'POST', path: '/watch/sessions', body: { prompt: 'Investigate checkout' } }));
  await ok(api.inject({ method: 'POST', path: '/watch/sessions/thread-1/reply', body: { text: 'Try the smaller fix first' } }));
  await ok(api.inject({ method: 'POST', path: '/watch/sessions/thread-1/interrupt' }));

  assert.deepEqual(codex.sent, [
    { threadId: 'thread-1', text: 'Investigate checkout' },
    { threadId: 'thread-1', text: 'Try the smaller fix first' },
  ]);
  assert.deepEqual(codex.interrupted, ['thread-1']);
});

test('Watch API enforces bearer token when configured', async () => {
  const codex = fakeCodex();
  const api = new WatchApiServer({ codex, port: 0, token: 'secret' });
  const unauthorized = await api.inject({ path: '/watch/sessions' });
  assert.equal(unauthorized.status, 401);

  const authorized = await api.inject({
    path: '/watch/sessions',
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(authorized.status, 200);
});

test('parseWatchProjects supports named paths and cwd fallback', () => {
  assert.deepEqual(parseWatchProjects('web=/tmp/web,api=/tmp/api'), [
    { name: 'web', path: '/tmp/web' },
    { name: 'api', path: '/tmp/api' },
  ]);
  assert.deepEqual(parseWatchProjects('', '/tmp/project'), [{ name: 'project', path: '/tmp/project' }]);
});

function fakeCodex() {
  const codex = new EventEmitter();
  codex.created = [];
  codex.sent = [];
  codex.resumed = [];
  codex.interrupted = [];
  codex.createThread = async (title, options = {}) => {
    codex.created.push({ title, options });
    return `thread-${codex.created.length}`;
  };
  codex.resumeThread = async (threadId) => {
    codex.resumed.push(threadId);
  };
  codex.sendToThread = async (threadId, text) => {
    codex.sent.push({ threadId, text });
  };
  codex.interrupt = async (threadId) => {
    codex.interrupted.push(threadId);
  };
  return codex;
}

async function ok(resultPromise) {
  const result = await resultPromise;
  assert.ok(result.status >= 200 && result.status < 300, `${result.status}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}
