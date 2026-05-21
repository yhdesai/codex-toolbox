import { renderCodexEvent } from './mirror-policy.js';

const MAX_EVENTS_PER_SESSION = 20;

export class WatchSessionStore {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.sessions = new Map();
  }

  startSession({ threadId, title, cwd = null, prompt = null }) {
    const session = this.#ensure(threadId);
    session.title = title || session.title || `Codex ${String(threadId).slice(0, 8)}`;
    session.cwd = cwd ?? session.cwd ?? null;
    session.prompt = prompt ?? session.prompt ?? null;
    session.status = 'starting';
    session.latest = 'Starting Codex session';
    session.updatedAt = this.#isoNow();
    this.#appendEvent(session, 'status', session.latest);
    return this.getSession(threadId);
  }

  promptSent(threadId) {
    const session = this.#ensure(threadId);
    session.status = 'working';
    session.latest = 'Prompt sent';
    session.updatedAt = this.#isoNow();
    this.#appendEvent(session, 'status', session.latest);
    return this.getSession(threadId);
  }

  recordEvent(event) {
    if (!event?.threadId) return null;
    const session = this.#ensure(event.threadId);
    const text = renderCodexEvent(event);
    const status = classifyEvent(event, text);
    const previousStatus = session.status;
    if (status) session.status = status;
    if (text) {
      session.latest = compactText(text);
      this.#appendEvent(session, 'event', session.latest);
    } else if (status && status !== previousStatus) {
      this.#appendEvent(session, 'status', status);
    }
    if (/turn\/completed/i.test(event.method)) {
      session.status = 'done';
      session.latest = session.latest || 'Done';
      this.#appendEvent(session, 'status', 'Done');
    }
    if (/failed|error/i.test(event.method)) {
      session.status = 'error';
      session.latest = session.latest || 'Error';
    }
    if (/interrupted|cancelled|canceled/i.test(event.method)) {
      session.status = 'interrupted';
      session.latest = 'Interrupted';
      this.#appendEvent(session, 'status', session.latest);
    }
    session.updatedAt = this.#isoNow();
    return this.getSession(event.threadId);
  }

  recordApprovalRequest(request) {
    if (!request?.threadId) return null;
    const session = this.#ensure(request.threadId);
    session.status = 'waiting';
    session.latest = compactText(approvalSummary(request));
    session.pendingApproval = {
      id: String(request.id),
      method: request.method,
      summary: session.latest,
      createdAt: this.#isoNow(),
    };
    session.updatedAt = this.#isoNow();
    this.#appendEvent(session, 'approval', session.latest);
    return this.getSession(request.threadId);
  }

  clearPendingApproval(threadId) {
    const session = this.sessions.get(String(threadId));
    if (!session) return null;
    delete session.pendingApproval;
    session.status = session.status === 'waiting' ? 'working' : session.status;
    session.updatedAt = this.#isoNow();
    return this.getSession(threadId);
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((session) => cloneSession(session));
  }

  getSession(threadId) {
    const session = this.sessions.get(String(threadId));
    return session ? cloneSession(session) : null;
  }

  #ensure(threadId) {
    const key = String(threadId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const now = this.#isoNow();
    const session = {
      threadId: key,
      title: `Codex ${key.slice(0, 8)}`,
      cwd: null,
      prompt: null,
      status: 'unknown',
      latest: '',
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.sessions.set(key, session);
    return session;
  }

  #appendEvent(session, type, text) {
    const trimmed = compactText(text);
    if (!trimmed) return;
    session.events.push({ type, text: trimmed, createdAt: this.#isoNow() });
    session.events = session.events.slice(-MAX_EVENTS_PER_SESSION);
  }

  #isoNow() {
    return this.now().toISOString();
  }
}

function classifyEvent(event, text) {
  const method = String(event.method ?? '');
  const lowered = `${method} ${text ?? ''}`.toLowerCase();
  if (/approval|permission/.test(lowered)) return 'waiting';
  if (/test|jest|vitest|node --test|npm test/.test(lowered)) return 'testing';
  if (/exec|command|tool/.test(lowered)) return 'running_command';
  if (/edit|patch|write|file/.test(lowered)) return 'editing';
  if (/turn\/started/.test(method)) return 'working';
  if (/turn\/completed/.test(method)) return 'done';
  if (/failed|error/.test(lowered)) return 'error';
  return null;
}

function approvalSummary(request) {
  const params = request.params ?? {};
  return params.command ?? params.cmd ?? params.file ?? params.path ?? params.message ?? 'Codex needs approval';
}

function compactText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function cloneSession(session) {
  return JSON.parse(JSON.stringify(session));
}
