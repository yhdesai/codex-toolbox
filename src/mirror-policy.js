export function renderCodexEvent(event, options = {}) {
  const { method, raw } = event;
  const params = raw.params ?? {};
  const includeMessageType = Boolean(options.includeMessageType);

  if (isReasoning(method, params)) return null;
  if (method === 'thread/status/changed') return null;
  if (method === 'turn/started' || method === 'turn/completed') return null;
  if (isToolEvent(method, params)) return conciseToolSummary(method, params, { includeMessageType });

  const text = extractText(params);
  if (/item|message|turn/.test(method) && text) {
    const role = params.role ?? params.item?.role ?? inferRole(method, params);
    return renderWithType(messageType(method, params), `${labelRole(role)}\n${text}`, includeMessageType);
  }

  if (/plan/i.test(method) && text) return renderWithType(messageType(method, params), `Plan\n${text}`, includeMessageType);
  if (/error|failed/i.test(method)) return renderWithType(messageType(method, params), `Error\n${text || params.message || method}`, includeMessageType);
  if (/interrupted|cancelled|canceled/i.test(method)) return renderWithType(messageType(method, params), `Status: ${humanize(method)}`, includeMessageType);
  return null;
}

export function extractUserMessageText(event) {
  const params = event.raw?.params ?? {};
  const item = params.item;
  const type = item?.type ?? params.type ?? '';
  const role = params.role ?? item?.role ?? inferRole(event.method, params);
  if (type !== 'userMessage' && role !== 'user') return null;
  return extractText(params);
}

export function renderApprovalPrompt(request, options = {}) {
  const params = request.params ?? {};
  const includeMessageType = Boolean(options.includeMessageType);
  const command = params.command ?? params.cmd ?? params.arguments?.command;
  const file = params.file ?? params.path ?? params.arguments?.path;
  const permission = params.permission ?? params.sandbox_permissions ?? params.arguments?.permission;
  const title = command ? 'Command approval requested' : file ? 'File approval requested' : 'Approval requested';
  const detail = command || file || permission || params.message || request.method;
  return renderWithType(request.method ?? 'approval_request', `${title}\n${detail}\n\nUse the buttons below to approve, decline, or cancel. Destructive or broad approvals should only be accepted after checking the details.`, includeMessageType);
}

export function approvalLabels(request) {
  const params = request.params ?? {};
  const command = String(params.command ?? params.cmd ?? '');
  const destructive = /\b(rm|reset|clean|checkout|drop|delete|truncate)\b/i.test(command);
  const broad = params.sandbox_permissions === 'require_escalated' || params.permission === 'require_escalated';
  return {
    accept: destructive ? 'Approve destructive' : broad ? 'Approve broad access' : 'Approve',
    decline: 'Decline',
    cancel: 'Cancel',
  };
}

function isReasoning(method, params) {
  const type = params.type ?? params.item?.type ?? '';
  return /reasoning|thought|chain/i.test(`${method} ${type}`);
}

function isToolEvent(method, params) {
  const type = params.type ?? params.item?.type ?? '';
  return /exec|command|tool/i.test(`${method} ${type}`);
}

function extractText(params) {
  const candidates = [
    params.text,
    params.message,
    params.delta,
    params.item?.text,
    params.item?.content?.text,
    params.item?.message,
    params.item?.output,
    params.item?.content,
    params.content,
    params.output,
    params.stdout,
    params.stderr,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) {
      const joined = candidate.map((part) => part?.text ?? '').filter(Boolean).join('\n').trim();
      if (joined) return joined;
    }
  }
  return null;
}

function inferRole(method, params = {}) {
  const itemType = params.item?.type ?? params.type ?? '';
  if (itemType === 'userMessage') return 'user';
  if (itemType === 'agentMessage') return 'assistant';
  if (/user/i.test(method)) return 'user';
  if (/assistant/i.test(method)) return 'assistant';
  return 'codex';
}

function labelRole(role) {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Codex';
  return 'Codex';
}

function conciseToolSummary(method, params, { includeMessageType = false } = {}) {
  const name = params.name ?? params.item?.name ?? params.tool ?? params.command ?? method;
  const statusValue = params.status ?? params.item?.status;
  const status = statusValue ? ` (${statusValue})` : '';
  const output = truncateText(params.output ?? params.stdout ?? params.stderr ?? params.item?.output);
  return renderWithType(messageType(method, params), [`Tool: ${name}${status}`, output ? `Output:\n${output}` : ''].filter(Boolean).join('\n'), includeMessageType);
}

function humanize(method) {
  return method.replaceAll('/', ' ');
}

function messageType(method, params = {}) {
  return params.item?.type ?? params.type ?? method;
}

function withMessageType(type, text) {
  const normalizedType = String(type || 'message').trim() || 'message';
  return `${normalizedType}\n${text}`;
}

function renderWithType(type, text, includeMessageType) {
  return includeMessageType ? withMessageType(type, text) : text;
}

function truncateText(value, maxLength = 1800) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 20).trimEnd()}\n... truncated ...`;
}
