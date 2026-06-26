import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WatchSessionStore } from './watch-session-store.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MODULE_ROOT = join(homedir(), 'projects-shiprdev', 'parent.erp');
const DEFAULT_MODULE_PROCESS_PREFIX = 'modular-';
const DEFAULT_MODULE_STATUS_MODE = 'pm2';
const DEFAULT_MODULE_HEALTH_PATH = '/api/health';
const DEFAULT_MODULE_HTTP_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

export class WatchApiServer {
  constructor({
    bridge,
    codex = bridge?.codex,
    host = DEFAULT_HOST,
    port = 0,
    token = '',
    projects = [],
    moduleRoot = DEFAULT_MODULE_ROOT,
    moduleStatusMode = DEFAULT_MODULE_STATUS_MODE,
    moduleTargets = [],
    moduleHealthPath = DEFAULT_MODULE_HEALTH_PATH,
    moduleHttpTimeoutMs = DEFAULT_MODULE_HTTP_TIMEOUT_MS,
    moduleProcessPrefix = DEFAULT_MODULE_PROCESS_PREFIX,
    moduleProcessList = defaultPm2ProcessList,
    fetchImpl = globalThis.fetch,
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
    this.moduleRoot = resolve(String(moduleRoot || DEFAULT_MODULE_ROOT));
    this.moduleStatusMode = normalizeModuleStatusMode(moduleStatusMode);
    this.moduleTargets = normalizeModuleTargets(moduleTargets);
    this.moduleHealthPath = String(moduleHealthPath || DEFAULT_MODULE_HEALTH_PATH);
    this.moduleHttpTimeoutMs = Number(moduleHttpTimeoutMs || DEFAULT_MODULE_HTTP_TIMEOUT_MS);
    this.moduleProcessPrefix = String(moduleProcessPrefix || DEFAULT_MODULE_PROCESS_PREFIX);
    this.moduleProcessList = moduleProcessList;
    this.fetchImpl = fetchImpl;
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
    if (result.contentType) {
      this.#send(response, result.status, result.payload, result.contentType);
      return;
    }
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
    if (method === 'GET' && url.pathname === '/modules/status.json') {
      return {
        status: 200,
        payload: await this.#moduleStatusFor(url),
      };
    }
    if (method === 'GET' && (url.pathname === '/modules/status' || url.pathname === '/status')) {
      const status = await this.#moduleStatusFor(url);
      return { status: 200, payload: renderModuleStatusPage(status), contentType: 'text/html; charset=utf-8' };
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

  async #moduleStatusFor(url) {
    return collectModuleStatus({
      mode: normalizeModuleStatusMode(url.searchParams.get('mode') || this.moduleStatusMode),
      root: this.moduleRoot,
      targets: this.moduleTargets,
      healthPath: this.moduleHealthPath,
      httpTimeoutMs: this.moduleHttpTimeoutMs,
      fetchImpl: this.fetchImpl,
      processPrefix: this.moduleProcessPrefix,
      processList: this.moduleProcessList,
    });
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

  #send(response, status, payload, contentType) {
    const body = String(payload);
    response.writeHead(status, {
      'content-type': contentType,
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

export async function collectModuleStatus({
  mode = DEFAULT_MODULE_STATUS_MODE,
  root = DEFAULT_MODULE_ROOT,
  targets = [],
  healthPath = DEFAULT_MODULE_HEALTH_PATH,
  httpTimeoutMs = DEFAULT_MODULE_HTTP_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  processPrefix = DEFAULT_MODULE_PROCESS_PREFIX,
  processList = defaultPm2ProcessList,
} = {}) {
  const normalizedMode = normalizeModuleStatusMode(mode);
  if (normalizedMode === 'http') {
    return collectHttpModuleStatus({ root, targets, healthPath, httpTimeoutMs, fetchImpl });
  }
  return collectPm2ModuleStatus({ root, processPrefix, processList });
}

async function collectHttpModuleStatus({
  root = DEFAULT_MODULE_ROOT,
  targets = [],
  healthPath = DEFAULT_MODULE_HEALTH_PATH,
  httpTimeoutMs = DEFAULT_MODULE_HTTP_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('HTTP module status requires fetch.');
  const normalizedRoot = resolve(String(root || DEFAULT_MODULE_ROOT));
  const normalizedTargets = normalizeModuleTargets(targets);
  const targetByName = new Map(normalizedTargets.map((target) => [target.name, target]));
  const repos = await discoverModuleRepos(normalizedRoot);
  const moduleNames = new Set([
    ...repos.map((repo) => repo.name),
    ...normalizedTargets.map((target) => target.name),
  ]);
  const repoByName = new Map(repos.map((repo) => [repo.name, repo]));
  const modules = await Promise.all([...moduleNames].sort().map(async (name) => {
    const repo = repoByName.get(name);
    const target = targetByName.get(name);
    if (!target?.url) {
      return {
        name,
        path: repo?.path ?? null,
        repoFound: Boolean(repo),
        online: false,
        status: 'unconfigured',
        target: null,
        responseMs: null,
        statusCode: null,
        error: 'No health URL configured',
      };
    }
    const url = withDefaultHealthPath(target.url, healthPath);
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: target.method || 'GET',
        signal: AbortSignal.timeout(Math.max(1, Number(httpTimeoutMs) || DEFAULT_MODULE_HTTP_TIMEOUT_MS)),
      });
      const responseMs = Date.now() - startedAt;
      return {
        name,
        path: repo?.path ?? null,
        repoFound: Boolean(repo),
        online: response.ok,
        status: response.ok ? 'online' : `http_${response.status}`,
        target: url,
        responseMs,
        statusCode: response.status,
        error: response.ok ? null : response.statusText || `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        name,
        path: repo?.path ?? null,
        repoFound: Boolean(repo),
        online: false,
        status: error.name === 'TimeoutError' ? 'timeout' : 'error',
        target: url,
        responseMs: Date.now() - startedAt,
        statusCode: null,
        error: error.message,
      };
    }
  }));
  const expected = modules.filter((item) => item.repoFound);
  const online = expected.filter((item) => item.online).length;
  return {
    ok: expected.length > 0 && online === expected.length,
    mode: 'http',
    checkedAt: new Date().toISOString(),
    root: normalizedRoot,
    summary: {
      expected: expected.length,
      online,
      offline: Math.max(0, expected.length - online),
      unconfigured: expected.filter((item) => item.status === 'unconfigured').length,
      extraTargets: modules.filter((item) => !item.repoFound && item.target).length,
    },
    modules,
  };
}

async function collectPm2ModuleStatus({
  root = DEFAULT_MODULE_ROOT,
  processPrefix = DEFAULT_MODULE_PROCESS_PREFIX,
  processList = defaultPm2ProcessList,
} = {}) {
  const normalizedRoot = resolve(String(root || DEFAULT_MODULE_ROOT));
  const normalizedPrefix = String(processPrefix || DEFAULT_MODULE_PROCESS_PREFIX);
  const [repos, processes] = await Promise.all([
    discoverModuleRepos(normalizedRoot),
    processList(),
  ]);
  const modules = new Map();
  for (const repo of repos) {
    const processName = `${normalizedPrefix}${repo.name}`;
    modules.set(repo.name, {
      name: repo.name,
      path: repo.path,
      processName,
      target: processName,
      repoFound: true,
      processFound: false,
      online: false,
      status: 'missing',
      pid: null,
      restarts: null,
      uptimeMs: null,
      cpu: null,
      memoryBytes: null,
    });
  }

  for (const process of processes) {
    const name = String(process.name || process.pm2_env?.name || '');
    if (!name.startsWith(normalizedPrefix)) continue;
    const moduleName = name.slice(normalizedPrefix.length);
    const existing = modules.get(moduleName) ?? {
      name: moduleName,
      path: null,
      processName: name,
      target: name,
      repoFound: false,
      processFound: false,
      online: false,
      status: 'missing',
      pid: null,
      restarts: null,
      uptimeMs: null,
      cpu: null,
      memoryBytes: null,
    };
    const pm2 = process.pm2_env ?? {};
    const status = String(pm2.status || 'unknown');
    const startedAt = Number(pm2.pm_uptime || 0);
    modules.set(moduleName, {
      ...existing,
      processName: name,
      target: name,
      processFound: true,
      online: status === 'online',
      status,
      pid: process.pid ?? null,
      restarts: Number(pm2.restart_time ?? 0),
      uptimeMs: startedAt > 0 ? Math.max(0, Date.now() - startedAt) : null,
      cpu: Number(process.monit?.cpu ?? 0),
      memoryBytes: Number(process.monit?.memory ?? 0),
    });
  }

  const items = [...modules.values()].sort((a, b) => a.name.localeCompare(b.name));
  const expected = items.filter((item) => item.repoFound);
  const online = expected.filter((item) => item.online).length;
  return {
    ok: expected.length > 0 && online === expected.length,
    mode: 'pm2',
    checkedAt: new Date().toISOString(),
    root: normalizedRoot,
    processPrefix: normalizedPrefix,
    summary: {
      expected: expected.length,
      online,
      offline: Math.max(0, expected.length - online),
      unconfigured: 0,
      extraProcesses: items.filter((item) => !item.repoFound && item.processFound).length,
    },
    modules: items,
  };
}

async function discoverModuleRepos(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
}

async function defaultPm2ProcessList() {
  const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 10000 });
  return JSON.parse(stdout);
}

function renderModuleStatusPage(status) {
  const title = status.ok ? 'All Modules Online' : 'Module Outage';
  const switchMode = status.mode === 'pm2' ? 'http' : 'pm2';
  const rows = status.modules.map((module) => `
    <tr class="${module.online ? 'online' : 'offline'}">
      <td><span class="dot"></span>${escapeHtml(module.name)}</td>
      <td>${escapeHtml(module.status)}</td>
      <td>${escapeHtml(module.target ?? module.processName ?? '-')}</td>
      <td>${module.statusCode ?? '-'}</td>
      <td>${formatResponseMs(module.responseMs)}</td>
      <td>${module.pid ?? '-'}</td>
      <td>${formatUptime(module.uptimeMs)}</td>
      <td>${escapeHtml(module.error ?? '')}</td>
      <td>${module.repoFound ? 'yes' : 'no'}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --ok: #16803c; --bad: #b42318; --line: #d0d7de; --muted: #667085; }
    body { margin: 0; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 40px; }
    h1 { margin: 0 0 6px; font-size: clamp(28px, 4vw, 44px); letter-spacing: 0; }
    .meta { color: var(--muted); margin-bottom: 22px; }
    .actions { margin: 0 0 22px; display: flex; gap: 10px; flex-wrap: wrap; }
    a.button { color: CanvasText; text-decoration: none; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 22px; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 28px; line-height: 1; margin-bottom: 6px; }
    .state { color: ${status.ok ? 'var(--ok)' : 'var(--bad)'}; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    tr:last-child td { border-bottom: 0; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; background: var(--bad); }
    tr.online .dot { background: var(--ok); }
    tr.offline td:first-child { color: var(--bad); font-weight: 600; }
    .table-wrap { overflow-x: auto; }
    @media (max-width: 760px) { .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <main>
    <h1 class="state">${escapeHtml(title)}</h1>
    <div class="meta">Mode ${escapeHtml(status.mode)} · Checked ${escapeHtml(status.checkedAt)} · Root ${escapeHtml(status.root)} · Auto-refreshes every 15s</div>
    <div class="actions">
      <a class="button" href="?mode=${escapeHtml(switchMode)}">Switch to ${escapeHtml(switchMode)}</a>
      <a class="button" href="/modules/status.json?mode=${escapeHtml(status.mode)}">JSON</a>
    </div>
    <section class="summary" aria-label="Summary">
      <div class="metric"><strong>${status.summary.expected}</strong>Expected modules</div>
      <div class="metric"><strong>${status.summary.online}</strong>Online</div>
      <div class="metric"><strong>${status.summary.offline}</strong>Offline</div>
      <div class="metric"><strong>${status.summary.unconfigured ?? status.summary.extraProcesses ?? 0}</strong>${status.mode === 'http' ? 'Unconfigured' : 'Extra PM2 processes'}</div>
    </section>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Module</th><th>Status</th><th>Target</th><th>Code</th><th>Latency</th><th>PID</th><th>Uptime</th><th>Error</th><th>Repo</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </main>
</body>
</html>`;
}

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatResponseMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  return `${Math.max(0, Math.round(ms))}ms`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function normalizeModuleStatusMode(value) {
  const mode = String(value || DEFAULT_MODULE_STATUS_MODE).toLowerCase();
  return mode === 'http' ? 'http' : 'pm2';
}

export function parseModuleStatusTargets(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    return normalizeModuleTargets(parsed);
  }
  return normalizeModuleTargets(raw.split(',').map((entry) => {
    const [name, ...rest] = entry.split('=');
    return { name: name?.trim(), url: rest.join('=').trim() };
  }));
}

function normalizeModuleTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target) => {
      if (typeof target === 'string') {
        const [name, ...rest] = target.split('=');
        return { name: name?.trim(), url: rest.join('=').trim() };
      }
      return {
        name: String(target?.name || '').trim(),
        url: String(target?.url || '').trim(),
        method: String(target?.method || 'GET').trim().toUpperCase(),
      };
    })
    .filter((target) => target.name && target.url);
}

function withDefaultHealthPath(value, healthPath) {
  const url = String(value || '').trim();
  if (!url) return url;
  const parsed = new URL(url);
  if (parsed.pathname === '/' || !parsed.pathname) {
    parsed.pathname = String(healthPath || DEFAULT_MODULE_HEALTH_PATH);
  }
  return parsed.toString();
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
