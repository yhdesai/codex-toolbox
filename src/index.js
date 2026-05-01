import { homedir } from 'node:os';
import { join } from 'node:path';
import { BridgeState } from './state.js';
import { TelegramClient } from './telegram.js';
import { CodexAppServer } from './codex-app-server.js';
import { CodexTelegramTopicBridge } from './bridge.js';
import { CodexCliFallback } from './cli-fallback.js';

export async function createBridge(options) {
  const state = await BridgeState.load(options.statePath);
  return new CodexTelegramTopicBridge({
    state,
    telegram: options.telegram ?? new TelegramClient({ token: options.telegramToken }),
    codex: options.codex ?? new CodexAppServer({
      command: options.codexCommand,
      args: options.codexArgs,
      cwd: options.cwd,
    }),
    pollMs: options.pollMs,
    allowedUserIds: options.allowedUserIds,
  });
}

export function createBridgeFromEnv(env) {
  const statePath = env.CODEX_TELEGRAM_STATE || join(homedir(), '.codex-telegram-topic-sync.json');
  const codexCommand = env.CODEX_APP_SERVER_COMMAND || 'codex';
  const codexArgs = splitArgs(env.CODEX_APP_SERVER_ARGS || 'app-server proxy');
  const pollMs = Number(env.CODEX_TELEGRAM_POLL_MS || 5000);
  const allowedUserIds = splitCsv(env.TELEGRAM_ALLOWED_USER_IDS || '');
  return {
    async start() {
      if (env.CODEX_SYNC_MODE === 'cli') {
        const fallback = new CodexCliFallback({
          command: env.CODEX_CLI_COMMAND || 'codex',
          args: splitArgs(env.CODEX_CLI_ARGS || 'exec'),
          cwd: env.CODEX_APP_SERVER_CWD || process.cwd(),
        });
        console.error('CODEX_SYNC_MODE=cli selected. App-server topic sync is disabled; using one-shot codex exec fallback.');
        this.bridge = { stop() {} };
        this.fallback = fallback;
        return;
      }
      this.bridge = await createBridge({
        statePath,
        codexCommand,
        codexArgs,
        cwd: env.CODEX_APP_SERVER_CWD || process.cwd(),
        telegramToken: env.TELEGRAM_BOT_TOKEN,
        pollMs,
        allowedUserIds,
      });
      await this.bridge.start();
    },
    async stop() {
      await this.bridge?.stop();
    },
  };
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, '')) ?? [];
}

function splitCsv(value) {
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export { BridgeState } from './state.js';
export { TelegramClient } from './telegram.js';
export { CodexAppServer } from './codex-app-server.js';
export { CodexTelegramTopicBridge } from './bridge.js';
export { CodexCliFallback } from './cli-fallback.js';
