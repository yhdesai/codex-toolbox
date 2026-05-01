import { EventEmitter } from 'node:events';
import { JsonRpcClient } from './json-rpc-client.js';

export class CodexAppServer extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server', 'proxy'], cwd = process.cwd(), client = null } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.client = client ?? new JsonRpcClient({ command, args, cwd });
    this.activeTurns = new Map();
    this.started = false;
    this.#attachClient();
  }

  #attachClient() {
    this.client.on('notification', (message) => this.#handleNotification(message));
    this.client.on('serverRequest', (message) => this.emit('serverRequest', normalizeServerRequest(message)));
    this.client.on('connect', (info) => {
      this.emit('connect', info);
      if (info?.reconnect && this.started) {
        this.initialize()
          .then(() => this.emit('ready', { reconnect: true }))
          .catch((error) => this.emit('error', error));
      }
    });
    for (const event of ['disconnect', 'stderr', 'error']) {
      this.client.on(event, (...args) => this.emit(event, ...args));
    }
  }

  async start() {
    this.started = true;
    this.client.start();
    try {
      await this.initialize();
    } catch (error) {
      if (!this.#canFallbackToDirectAppServer(error)) throw error;
      this.emit('stderr', `codex app-server proxy did not initialize; falling back to direct codex app-server stdio\n`);
      this.client.stop();
      this.client = new JsonRpcClient({ command: this.command, args: ['app-server'], cwd: this.cwd });
      this.#attachClient();
      this.client.start();
      await this.initialize();
    }
    this.emit('ready', { reconnect: false });
  }

  stop() {
    this.started = false;
    this.client.stop();
  }

  async initialize() {
    await this.client.request('initialize', {
      clientInfo: { name: 'codex-telegram-topic-sync', title: null, version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.client.notify('initialized', {});
  }

  async listThreads() {
    const [threads, loaded] = await Promise.all([
      this.#optionalRequest('thread/list', {}),
      this.#optionalRequest('thread/loaded/list', {}),
    ]);
    return dedupeThreads([...(extractThreads(threads)), ...(extractThreads(loaded))]);
  }

  async resumeThread(threadId) {
    return this.client.request('thread/resume', { threadId });
  }

  async createThread(title = 'Telegram') {
    const result = await this.client.request('thread/start', {});
    const threadId = extractThreadId(result);
    if (threadId && title) {
      await this.renameThread(threadId, title);
    }
    return threadId;
  }

  async renameThread(threadId, title) {
    return this.#optionalRequest('thread/name/set', { threadId, name: title });
  }

  async sendToThread(threadId, text) {
    const input = [{ type: 'text', text }];
    const expectedTurnId = this.activeTurns.get(String(threadId));
    if (expectedTurnId) {
      try {
        return await this.client.request('turn/steer', { threadId, input, expectedTurnId });
      } catch (error) {
        error.steerRejected = true;
        throw error;
      }
    }
    return this.client.request('turn/start', { threadId, input });
  }

  async interrupt(threadId) {
    return this.client.request('turn/interrupt', { threadId });
  }

  answerServerRequest(id, decision, data = {}) {
    this.client.respond(id, { decision, ...data });
  }

  #handleNotification(message) {
    updateActiveTurns(this.activeTurns, message);
    this.emit('event', normalizeCodexEvent(message));
  }

  async #optionalRequest(method, params) {
    try {
      return await this.client.request(method, params);
    } catch {
      return null;
    }
  }

  #canFallbackToDirectAppServer(error) {
    return this.args.join(' ') === 'app-server proxy' && /timed out|not connected|exited/i.test(error?.message ?? '');
  }
}

function normalizeServerRequest(message) {
  return {
    id: message.id,
    method: message.method,
    params: message.params ?? {},
    threadId: findThreadId(message.params),
  };
}

export function normalizeCodexEvent(message) {
  const params = message.params ?? {};
  return {
    method: message.method,
    threadId: findThreadId(params),
    turnId: params.turnId ?? params.turn_id ?? params.turn?.id ?? params.id ?? null,
    raw: message,
  };
}

function updateActiveTurns(activeTurns, message) {
  const event = normalizeCodexEvent(message);
  if (!event.threadId || !event.turnId) return;
  if (/turn\/(started|start|delta|item|progress)/.test(event.method)) {
    activeTurns.set(String(event.threadId), String(event.turnId));
  }
  if (/turn\/(completed|failed|cancelled|canceled|interrupted|done)/.test(event.method)) {
    activeTurns.delete(String(event.threadId));
  }
}

function findThreadId(value) {
  return value?.threadId ?? value?.thread_id ?? value?.thread?.id ?? value?.sessionId ?? value?.session_id ?? null;
}

function extractThreads(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.threads)) return value.threads;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

function dedupeThreads(threads) {
  const byId = new Map();
  for (const thread of threads) {
    const id = extractThreadId(thread);
    if (id) byId.set(String(id), { ...thread, id: String(id) });
  }
  return [...byId.values()];
}

function extractThreadId(value) {
  return value?.threadId ?? value?.thread_id ?? value?.thread?.id ?? value?.id ?? null;
}
