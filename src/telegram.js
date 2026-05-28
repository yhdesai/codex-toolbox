import { EventEmitter } from 'node:events';
import https from 'node:https';
import { chunkTelegramText } from './chunking.js';

export class TelegramClient extends EventEmitter {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    pollTimeoutSeconds = 25,
    minPrivateIntervalMs = 0,
    minGroupIntervalMs = 0,
    minGlobalIntervalMs = 0,
    retryBufferMs = 250,
  }) {
    super();
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
    if (!fetchImpl) throw new Error('fetch is required');
    this.token = token;
    this.fetch = fetchImpl;
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.offset = 0;
    this.running = false;
    this.minPrivateIntervalMs = Math.max(0, Number(minPrivateIntervalMs) || 0);
    this.minGroupIntervalMs = Math.max(0, Number(minGroupIntervalMs) || 0);
    this.minGlobalIntervalMs = Math.max(0, Number(minGlobalIntervalMs) || 0);
    this.retryBufferMs = Math.max(0, Number(retryBufferMs) || 0);
    this.queue = Promise.resolve();
    this.nextGlobalSendAt = 0;
    this.nextChatSendAt = new Map();
  }

  async startPolling() {
    this.running = true;
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', {
          offset: this.offset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          this.emit('update', update);
        }
      } catch (error) {
        this.emit('error', error);
        await delay(1500);
      }
    }
  }

  stopPolling() {
    this.running = false;
  }

  async api(method, payload) {
    const response = this.fetch === globalThis.fetch
      ? await postTelegramJson(this.token, method, payload)
      : await fetchTelegramJson(this.fetch, this.token, method, payload);

    if (!response.ok || !response.body?.ok) {
      const message = response.body?.description || `${method} failed with HTTP ${response.status}`;
      const error = new Error(message);
      error.response = response.body;
      error.retryAfter = response.body?.parameters?.retry_after;
      throw error;
    }
    return response.body.result;
  }

  async createForumTopic(chatId, name) {
    const result = await this.queuedApi('createForumTopic', {
      chat_id: chatId,
      name: sanitizeTopicName(name),
    }, { chatId });
    return result.message_thread_id;
  }

  async deleteForumTopic(chatId, messageThreadId) {
    return this.queuedApi('deleteForumTopic', {
      chat_id: chatId,
      message_thread_id: Number(messageThreadId),
    }, { chatId });
  }

  async editForumTopic(chatId, messageThreadId, name) {
    return this.queuedApi('editForumTopic', {
      chat_id: chatId,
      message_thread_id: Number(messageThreadId),
      name: sanitizeTopicName(name),
    }, { chatId });
  }

  async sendMessage({ chatId, messageThreadId = null, text, replyMarkup = null }) {
    const results = [];
    for (const chunk of chunkTelegramText(text)) {
      results.push(await this.sendMessageChunk({ chatId, messageThreadId, text: chunk, replyMarkup }));
      replyMarkup = null;
    }
    return results;
  }

  async sendMessageChunk({ chatId, messageThreadId = null, text, replyMarkup = null }) {
    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (messageThreadId != null) payload.message_thread_id = Number(messageThreadId);
    if (replyMarkup) payload.reply_markup = replyMarkup;
    return this.queuedApi('sendMessage', payload, { chatId });
  }

  async editMessageText({ chatId, messageId, text, replyMarkup = null }) {
    const payload = {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    return this.queuedApi('editMessageText', payload, { chatId });
  }

  async answerCallbackQuery(callbackQueryId, text = null) {
    return this.api('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async setMyCommands(commands) {
    return this.api('setMyCommands', { commands });
  }

  async queuedApi(method, payload, { chatId = null } = {}) {
    const run = () => this.#sendQueuedApi(method, payload, chatId);
    const promise = this.queue.then(run, run);
    this.queue = promise.catch(() => {});
    return promise;
  }

  async #sendQueuedApi(method, payload, chatId) {
    while (true) {
      await this.#waitForSendSlot(chatId);
      try {
        const result = await this.api(method, payload);
        this.#reserveNextSlot(chatId);
        return result;
      } catch (error) {
        if (!isRetryableRateLimit(error)) throw error;
        const retryAfterMs = Math.max(0, Number(error.retryAfter) || 0) * 1000 + this.retryBufferMs;
        this.#reserveNextSlot(chatId, retryAfterMs);
        this.emit('rateLimit', { method, chatId, retryAfterMs, error });
      }
    }
  }

  async #waitForSendSlot(chatId) {
    const now = Date.now();
    const chatKey = chatId == null ? null : String(chatId);
    const chatReadyAt = chatKey ? (this.nextChatSendAt.get(chatKey) ?? 0) : 0;
    const delayMs = Math.max(0, this.nextGlobalSendAt - now, chatReadyAt - now);
    if (delayMs > 0) await delay(delayMs);
  }

  #reserveNextSlot(chatId, overrideDelayMs = null) {
    const now = Date.now();
    const globalDelay = overrideDelayMs ?? this.minGlobalIntervalMs;
    this.nextGlobalSendAt = Math.max(this.nextGlobalSendAt, now + globalDelay);
    if (chatId == null) return;
    const chatKey = String(chatId);
    const chatDelay = overrideDelayMs ?? this.#chatIntervalMs(chatId);
    this.nextChatSendAt.set(chatKey, Math.max(this.nextChatSendAt.get(chatKey) ?? 0, now + chatDelay));
  }

  #chatIntervalMs(chatId) {
    return isGroupChatId(chatId) ? this.minGroupIntervalMs : this.minPrivateIntervalMs;
  }
}

export function isForumMessage(message) {
  return message?.chat?.type === 'supergroup' && message.is_topic_message === true;
}

export function getCommand(message) {
  const text = message?.text?.trim();
  if (!text?.startsWith('/')) return null;
  const [command] = text.split(/\s+/, 1);
  return command.replace(/@\w+$/, '').toLowerCase();
}

export function approvalKeyboard(callbackId, labels = {}) {
  return {
    inline_keyboard: [
      [
        { text: labels.accept ?? 'Approve', callback_data: `approval:${callbackId}:accept` },
        { text: labels.decline ?? 'Decline', callback_data: `approval:${callbackId}:decline` },
      ],
      [{ text: labels.cancel ?? 'Cancel request', callback_data: `approval:${callbackId}:cancel` }],
    ],
  };
}

export function sanitizeTopicName(name) {
  const normalized = String(name || 'Codex Thread')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return normalized || 'Codex Thread';
}

async function fetchTelegramJson(fetchImpl, token, method, payload) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function postTelegramJson(token, method, payload) {
  const requestBody = JSON.stringify(payload || {});

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        family: 4,
        timeout: 30000,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = rawBody ? JSON.parse(rawBody) : null;
          } catch (_) {
            body = { rawBody };
          }
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode || 0, body });
        });
      },
    );

    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Telegram ${method} request timed out`)));
    request.write(requestBody);
    request.end();
  });
}

function isRetryableRateLimit(error) {
  return Number(error?.retryAfter) > 0 || error?.response?.error_code === 429;
}

function isGroupChatId(chatId) {
  return String(chatId).startsWith('-');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
