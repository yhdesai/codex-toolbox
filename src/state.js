import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class BridgeState {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      boundChatId: null,
      threads: {},
      topics: {},
      approvals: {},
      paused: { mirroring: false },
      deletedThreadBaselines: {},
      lastErrors: [],
    };
  }

  static async load(filePath) {
    const state = new BridgeState(filePath);
    try {
      const raw = await readFile(filePath, 'utf8');
      state.data = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return state;
  }

  get boundChatId() {
    return this.data.boundChatId;
  }

  async bindChat(chatId) {
    this.data.boundChatId = String(chatId);
    await this.save();
  }

  getTopicForThread(threadId) {
    return this.data.threads[String(threadId)]?.messageThreadId ?? null;
  }

  getThreadForTopic(messageThreadId) {
    return this.data.topics[String(messageThreadId)]?.threadId ?? null;
  }

  getThread(threadId) {
    return this.data.threads[String(threadId)] ?? null;
  }

  async mapThread(threadId, messageThreadId, title = null) {
    const threadKey = String(threadId);
    const topicKey = String(messageThreadId);
    this.data.threads[threadKey] = {
      threadId: threadKey,
      messageThreadId: Number(messageThreadId),
      title,
      updatedAt: new Date().toISOString(),
    };
    this.data.topics[topicKey] = {
      messageThreadId: Number(messageThreadId),
      threadId: threadKey,
    };
    await this.save();
  }

  async updateThreadTitle(threadId, title) {
    const threadKey = String(threadId);
    const thread = this.data.threads[threadKey];
    if (!thread) return false;
    thread.title = title;
    thread.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async unmapThread(threadId) {
    const threadKey = String(threadId);
    const thread = this.data.threads[threadKey];
    if (!thread) return null;
    delete this.data.threads[threadKey];
    delete this.data.topics[String(thread.messageThreadId)];
    await this.save();
    return thread;
  }

  async unmapTopic(messageThreadId) {
    const topicKey = String(messageThreadId);
    const topic = this.data.topics[topicKey];
    if (!topic) return null;
    return this.unmapThread(topic.threadId);
  }

  async clearTopicMappings() {
    const threads = Object.values(this.data.threads);
    this.data.threads = {};
    this.data.topics = {};
    this.data.approvals = {};
    await this.save();
    return threads;
  }

  async clearApprovals() {
    this.data.approvals = {};
    await this.save();
  }

  async setMirroringPaused(paused) {
    this.data.paused.mirroring = Boolean(paused);
    await this.save();
  }

  async markDeletedThreadBaselines(threadIds, timestamp = new Date().toISOString()) {
    for (const threadId of threadIds) {
      this.data.deletedThreadBaselines[String(threadId)] = timestamp;
    }
    await this.save();
  }

  async recordError(message) {
    const text = String(message ?? '').trim();
    if (!text) return;
    this.data.lastErrors.push({ message: text, createdAt: new Date().toISOString() });
    this.data.lastErrors = this.data.lastErrors.slice(-20);
    await this.save();
  }

  async rememberApproval(callbackId, approval) {
    this.data.approvals[String(callbackId)] = {
      ...approval,
      createdAt: new Date().toISOString(),
    };
    await this.save();
  }

  async takeApproval(callbackId) {
    const key = String(callbackId);
    const approval = this.data.approvals[key] ?? null;
    delete this.data.approvals[key];
    await this.save();
    return approval;
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(tmpPath, this.filePath);
  }
}

function normalizeState(value) {
  return {
    boundChatId: value?.boundChatId == null ? null : String(value.boundChatId),
    threads: value?.threads && typeof value.threads === 'object' ? value.threads : {},
    topics: value?.topics && typeof value.topics === 'object' ? value.topics : {},
    approvals: value?.approvals && typeof value.approvals === 'object' ? value.approvals : {},
    paused: {
      mirroring: Boolean(value?.paused?.mirroring),
    },
    deletedThreadBaselines: value?.deletedThreadBaselines && typeof value.deletedThreadBaselines === 'object' ? value.deletedThreadBaselines : {},
    lastErrors: Array.isArray(value?.lastErrors) ? value.lastErrors.slice(-20) : [],
  };
}
