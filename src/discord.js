import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { chunkTelegramText } from './chunking.js';

const API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const CHANNEL_TEXT = 0;
const CHANNEL_CATEGORY = 4;
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

export class DiscordClient extends EventEmitter {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket ?? WebSocket,
    gatewayUrl = GATEWAY_URL,
  }) {
    super();
    if (!token) throw new Error('DISCORD_BOT_TOKEN is required');
    if (!fetchImpl) throw new Error('fetch is required');
    if (!WebSocketImpl) throw new Error('WebSocket is required for Discord gateway');
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.gatewayUrl = gatewayUrl;
    this.ws = null;
    this.heartbeatTimer = null;
    this.sequence = null;
    this.running = false;
    this.userId = null;
  }

  startGateway() {
    this.running = true;
    this.#connect();
  }

  stopGateway() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close?.();
    this.ws = null;
  }

  async api(method, path, payload = null) {
    const response = await this.fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        'content-type': 'application/json',
      },
      ...(payload == null ? {} : { body: JSON.stringify(payload) }),
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status === 429 && body?.retry_after) {
      await delay(Math.ceil(Number(body.retry_after) * 1000));
      return this.api(method, path, payload);
    }
    if (!response.ok) {
      const error = new Error(body?.message || `${method} ${path} failed with HTTP ${response.status}`);
      error.response = body;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async createGuildCategory(guildId, name) {
    return this.api('POST', `/guilds/${guildId}/channels`, {
      name: sanitizeDiscordName(name, { channel: false }),
      type: CHANNEL_CATEGORY,
    });
  }

  async createTextChannel(guildId, name, parentId = null) {
    return this.api('POST', `/guilds/${guildId}/channels`, {
      name: sanitizeDiscordName(name),
      type: CHANNEL_TEXT,
      ...(parentId ? { parent_id: String(parentId) } : {}),
    });
  }

  async deleteChannel(channelId) {
    return this.api('DELETE', `/channels/${channelId}`);
  }

  async sendMessage({ channelId, text, components = null }) {
    const results = [];
    let remainingComponents = components;
    for (const chunk of chunkTelegramText(text, 1900)) {
      results.push(await this.api('POST', `/channels/${channelId}/messages`, {
        content: chunk,
        allowed_mentions: { parse: [] },
        ...(remainingComponents ? { components: remainingComponents } : {}),
      }));
      remainingComponents = null;
    }
    return results;
  }

  async createInteractionResponse(interactionId, token, payload) {
    return this.api('POST', `/interactions/${interactionId}/${token}/callback`, payload);
  }

  #connect() {
    const ws = new this.WebSocketImpl(this.gatewayUrl);
    this.ws = ws;
    addWsListener(ws, 'message', (event) => this.#handleMessage(event.data ?? event));
    addWsListener(ws, 'close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.emit('disconnect');
      if (this.running) setTimeout(() => this.#connect(), 1500);
    });
    addWsListener(ws, 'error', (error) => this.emit('error', error));
  }

  #handleMessage(raw) {
    const payload = JSON.parse(String(raw));
    if (payload.s != null) this.sequence = payload.s;
    if (payload.op === 10) {
      this.#startHeartbeat(payload.d.heartbeat_interval);
      this.#send({
        op: 2,
        d: {
          token: this.token,
          intents: INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT,
          properties: { os: process.platform, browser: 'codex-toolbox', device: 'codex-toolbox' },
        },
      });
      return;
    }
    if (payload.op !== 0) return;
    if (payload.t === 'READY') {
      this.userId = payload.d?.user?.id ?? null;
      this.emit('ready', payload.d);
      return;
    }
    this.emit('dispatch', { type: payload.t, data: payload.d });
  }

  #startHeartbeat(intervalMs) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.#send({ op: 1, d: this.sequence });
    }, intervalMs);
  }

  #send(payload) {
    this.ws?.send?.(JSON.stringify(payload));
  }
}

export function getDiscordCommand(message, prefix = '!codex') {
  const text = String(message?.content ?? '').trim();
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length).trim();
  const [command = 'help'] = rest.split(/\s+/, 1);
  return command.toLowerCase();
}

export function getDiscordCommandArgs(message, prefix = '!codex') {
  const text = String(message?.content ?? '').trim();
  if (!text.startsWith(prefix)) return '';
  return text.slice(prefix.length).trim().replace(/^\S+/, '').trim();
}

export function sanitizeDiscordName(name, { channel = true } = {}) {
  const value = String(name || 'Codex Thread').replace(/\s+/g, ' ').trim() || 'Codex Thread';
  if (!channel) return value.slice(0, 100);
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'codex-thread';
}

export function approvalComponents(callbackId, labels = {}) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: labels.accept ?? 'Approve', custom_id: `approval:${callbackId}:accept` },
        { type: 2, style: 4, label: labels.decline ?? 'Decline', custom_id: `approval:${callbackId}:decline` },
        { type: 2, style: 2, label: labels.cancel ?? 'Cancel request', custom_id: `approval:${callbackId}:cancel` },
      ],
    },
  ];
}

function addWsListener(ws, event, listener) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, listener);
  } else if (typeof ws.on === 'function') {
    ws.on(event, listener);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
