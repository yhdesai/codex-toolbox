import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { WatchSessionStore } from './watch-session-store.js';

const DEFAULT_HOST = '127.0.0.1';

export class WatchApiServer {
  constructor({
    bridge,
    codex = bridge?.codex,
    host = DEFAULT_HOST,
    port = 0,
    token = '',
    projects = [],
    logger = console,
    store = new WatchSessionStore(),
  } = {}) {
    if (!codex) throw new Error('WatchApiServer requires a Codex bridge or codex client.');
    this.bridge = bridge;
    this.codex = codex;
    this.host = host || DEFAULT_HOST;
    this.port = Number(port || 0);
    this.token = String(token || '');
    this.projects = normalizeProjects(projects);
    this.logger = logger;
    this.store = store;
    this.server = createServer((request, response) => this.#handle(request, response).catch((error) => this.#sendError(response, error)));
    this.#attachCodexListeners();
  }

  async start() {
    if (!this.token && !isLoopbackHost(this.host)) {
      throw new Error('CODEX_WATCH_API_TOKEN is required when CODEX_WATCH_API_HOST is not loopback.');
    }
    await new Promise((resolve) => this.server.listen(this.port, this.host, resolve));
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.port;
    this.url = `http://${this.host}:${port}`;
    return this.url;
  }

  async stop() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  async inject({ method = 'GET', path = '/', headers = {}, body = {} } = {}) {
    return this.#dispatch({ method, path, headers, body });
  }

  #attachCodexListeners() {
    this.codex.on?.('event', (event) => this.store.recordEvent(event));
    this.codex.on?.('serverRequest', (request) => this.store.recordApprovalRequest(request));
  }

  async #handle(request, response) {
    const body = request.method === 'POST' ? await readJson(request) : {};
    const result = await this.#dispatch({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body,
    });
    this.#json(response, result.status, result.payload);
  }

  async #dispatch({ method, path, headers, body }) {
    if (!this.#isAuthorized(headers)) return { status: 401, payload: { error: 'Unauthorized' } };
    const url = new URL(path, 'http://localhost');
    if (method === 'GET' && url.pathname === '/watch/health') {
      return { status: 200, payload: { ok: true } };
    }
    if (method === 'GET' && url.pathname === '/watch/projects') {
      return { status: 200, payload: { projects: this.projects } };
    }
    if (method === 'GET' && url.pathname === '/watch/sessions') {
      return { status: 200, payload: { sessions: this.store.listSessions() } };
    }
    if (method === 'POST' && url.pathname === '/watch/sessions') {
      const session = await this.#createSession(body);
      return { status: 201, payload: { session } };
    }
    const match = url.pathname.match(/^\/watch\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const threadId = decodeURIComponent(match[1]);
      const action = match[2] ?? '';
      if (method === 'GET' && !action) {
        const session = this.store.getSession(threadId);
        return { status: session ? 200 : 404, payload: session ? { session } : { error: 'Session not found' } };
      }
      if (method === 'POST' && action === 'reply') {
        await this.#reply(threadId, body);
        return { status: 202, payload: { session: this.store.getSession(threadId) } };
      }
      if (method === 'POST' && action === 'interrupt') {
        await this.codex.interrupt(threadId);
        const session = this.store.recordEvent({
          method: 'turn/interrupted',
          threadId,
          raw: { params: { threadId, message: 'Interrupt requested' } },
        });
        return { status: 202, payload: { session } };
      }
    }
    return { status: 404, payload: { error: 'Not found' } };
  }

  async #createSession(body) {
    const prompt = requiredString(body.prompt, 'prompt');
    const cwd = resolveCwd(body.cwd, this.projects);
    const title = optionalString(body.title) || inferTitle(prompt, cwd);
    const threadId = await this.codex.createThread(title, cwd ? { cwd } : {});
    await this.codex.resumeThread(threadId);
    this.bridge?.subscribedThreads?.add?.(String(threadId));
    this.store.startSession({ threadId, title, cwd, prompt });
    await this.codex.sendToThread(threadId, prompt);
    return this.store.promptSent(threadId);
  }

  async #reply(threadId, body) {
    const text = requiredString(body.text, 'text');
    await this.codex.sendToThread(threadId, text);
    this.store.clearPendingApproval(threadId);
    this.store.recordEvent({
      method: 'item/completed',
      threadId,
      raw: { params: { threadId, item: { type: 'userMessage', text } } },
    });
  }

  #isAuthorized(headers) {
    if (!this.token) return true;
    const header = headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return bearer === this.token || headers['x-codex-watch-token'] === this.token;
  }

  #json(response, status, payload) {
    const body = `${JSON.stringify(payload)}\n`;
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  #sendError(response, error) {
    const status = error.statusCode || 500;
    if (status >= 500) this.logger.error?.('Watch API error:', error);
    this.#json(response, status, { error: error.message || 'Internal server error' });
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        reject(error);
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function requiredString(value, name) {
  const text = optionalString(value);
  if (text) return text;
  const error = new Error(`${name} is required`);
  error.statusCode = 400;
  throw error;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function resolveCwd(value, projects) {
  const raw = optionalString(value);
  if (!raw) return projects[0]?.path ?? null;
  const project = projects.find((candidate) => candidate.name === raw);
  return project ? project.path : resolve(raw);
}

function inferTitle(prompt, cwd) {
  const firstWords = prompt.split(/\s+/).slice(0, 5).join(' ');
  return firstWords || basename(cwd || process.cwd()) || 'Watch session';
}

function normalizeProjects(projects) {
  return projects
    .map((project) => {
      if (typeof project === 'string') {
        const path = resolve(project);
        return { name: basename(path), path };
      }
      if (!project?.path) return null;
      const path = resolve(String(project.path));
      return { name: String(project.name || basename(path)), path };
    })
    .filter(Boolean);
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host));
}

export function parseWatchProjects(value, fallbackCwd = process.cwd()) {
  const raw = String(value || '').trim();
  if (!raw) return [{ name: basename(resolve(fallbackCwd)), path: resolve(fallbackCwd) }];
  return raw.split(',').map((entry) => {
    const [name, ...rest] = entry.split('=');
    if (!rest.length) return resolve(name.trim());
    return { name: name.trim(), path: rest.join('=').trim() };
  });
}
