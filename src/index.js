import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { BridgeState } from './state.js';
import { TelegramClient } from './telegram.js';
import { DiscordClient } from './discord.js';
import { CodexAppServer } from './codex-app-server.js';
import { CodexTelegramTopicBridge } from './bridge.js';
import { CodexDiscordChannelBridge } from './discord-bridge.js';
import { CodexCliFallback } from './cli-fallback.js';
import { WatchApiServer, parseModuleStatusTargets, parseWatchProjects } from './watch-api.js';

export async function createBridge(options) {
  const state = await BridgeState.load(options.statePath);
  if (options.provider === 'discord') {
    return new CodexDiscordChannelBridge({
      state,
      discord: options.discord ?? new DiscordClient({ token: options.discordToken }),
      codex: options.codex ?? new CodexAppServer({
        command: options.codexCommand,
        args: options.codexArgs,
        cwd: options.cwd,
      }),
      pollMs: options.pollMs,
      allowedUserIds: options.allowedDiscordUserIds,
      projectName: options.discordProjectName,
      commandPrefix: options.discordCommandPrefix,
      guildId: options.discordGuildId,
      messageScope: options.discordMessageScope,
      aiControlBaseUrl: options.aiControlBaseUrl,
      aiControlDiscordSecret: options.aiControlDiscordSecret,
      aiControlTenantId: options.aiControlTenantId,
    });
  }
  return new CodexTelegramTopicBridge({
    state,
    telegram: options.telegram ?? new TelegramClient({
      token: options.telegramToken,
      minPrivateIntervalMs: options.telegramPrivateIntervalMs,
      minGroupIntervalMs: options.telegramGroupIntervalMs,
      minGlobalIntervalMs: options.telegramGlobalIntervalMs,
    }),
    codex: options.codex ?? new CodexAppServer({
      command: options.codexCommand,
      args: options.codexArgs,
      cwd: options.cwd,
    }),
    pollMs: options.pollMs,
    allowedUserIds: options.allowedUserIds,
    messageScope: options.telegramMessageScope,
  });
}

export function createBridgeFromEnv(env) {
  const statePath = env.CODEX_TOOLBOX_STATE || env.CODEX_TELEGRAM_STATE || join(homedir(), '.codex-toolbox.json');
  const codexCommand = env.CODEX_APP_SERVER_COMMAND || 'codex';
  const codexArgs = splitArgs(env.CODEX_APP_SERVER_ARGS || 'app-server proxy');
  const pollMs = Number(env.CODEX_TELEGRAM_POLL_MS || 5000);
  const telegramPrivateIntervalMs = Number(env.CODEX_TELEGRAM_PRIVATE_INTERVAL_MS || 1000);
  const telegramGroupIntervalMs = Number(env.CODEX_TELEGRAM_GROUP_INTERVAL_MS || 3200);
  const telegramGlobalIntervalMs = Number(env.CODEX_TELEGRAM_GLOBAL_INTERVAL_MS || 40);
  const allowedUserIds = splitCsv(env.TELEGRAM_ALLOWED_USER_IDS || '');
  const provider = env.CODEX_SYNC_PROVIDER || (env.DISCORD_BOT_TOKEN ? 'discord' : 'telegram');
  const allowedDiscordUserIds = splitCsv(env.DISCORD_ALLOWED_USER_IDS || '');
  const telegramMessageScope = normalizeMessageScope(env.CODEX_TELEGRAM_MESSAGE_SCOPE || env.CODEX_MESSAGE_SCOPE || 'conversation');
  const discordMessageScope = normalizeMessageScope(env.CODEX_DISCORD_MESSAGE_SCOPE || env.CODEX_MESSAGE_SCOPE || 'all');
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
        provider,
        statePath,
        codexCommand,
        codexArgs,
        cwd: env.CODEX_APP_SERVER_CWD || process.cwd(),
        telegramToken: env.TELEGRAM_BOT_TOKEN,
        discordToken: env.DISCORD_BOT_TOKEN,
        allowedDiscordUserIds,
        discordGuildId: env.DISCORD_GUILD_ID,
        discordProjectName: env.DISCORD_PROJECT_NAME || basename(resolve(env.CODEX_APP_SERVER_CWD || process.cwd())),
        discordCommandPrefix: env.DISCORD_COMMAND_PREFIX || '!codex',
        discordMessageScope,
        aiControlBaseUrl: env.AI_CONTROL_BASE_URL || env.ERP_AI_CONTROL_URL || 'http://localhost:11024',
        aiControlDiscordSecret: env.AI_CONTROL_DISCORD_WEBHOOK_SECRET || env.DISCORD_WEBHOOK_SECRET || '',
        aiControlTenantId: env.AI_CONTROL_TENANT_ID || env.ERP_TENANT_ID || '',
        pollMs,
        allowedUserIds,
        telegramMessageScope,
        telegramPrivateIntervalMs,
        telegramGroupIntervalMs,
        telegramGlobalIntervalMs,
      });
      await this.bridge.start();
      if (provider === 'discord') {
        await syncAiControlDiscordAgentChannelsFromEnv(env).catch((error) => {
          console.error(`AI Control Discord agent channel startup sync failed: ${error.message}`);
        });
      }
      if (env.CODEX_WATCH_API_PORT) {
        this.watchApi = new WatchApiServer({
          bridge: this.bridge,
          host: env.CODEX_WATCH_API_HOST || '127.0.0.1',
          port: Number(env.CODEX_WATCH_API_PORT),
          token: env.CODEX_WATCH_API_TOKEN || '',
          projects: parseWatchProjects(env.CODEX_WATCH_PROJECTS, env.CODEX_APP_SERVER_CWD || process.cwd()),
          moduleRoot: env.CODEX_MODULE_STATUS_ROOT,
          moduleStatusMode: env.CODEX_MODULE_STATUS_MODE,
          moduleTargets: parseModuleStatusTargets(env.CODEX_MODULE_STATUS_TARGETS),
          moduleHealthPath: env.CODEX_MODULE_STATUS_HEALTH_PATH,
          moduleHttpTimeoutMs: Number(env.CODEX_MODULE_STATUS_TIMEOUT_MS || 5000),
          moduleProcessPrefix: env.CODEX_MODULE_STATUS_PROCESS_PREFIX,
        });
        const url = await this.watchApi.start();
        console.error(`Codex Watch API listening on ${url}`);
      }
    },
    async stop() {
      await this.watchApi?.stop();
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

function normalizeMessageScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['all', 'everything', '*'].includes(normalized)) return 'all';
  if (['none', 'off', 'disabled', 'false', '0'].includes(normalized)) return 'none';
  if (['conversation', 'conversation_only', 'conversation-only', 'user_agent', 'user-agent', 'users_agents', 'users-agents', 'messages'].includes(normalized)) return 'conversation';
  return 'conversation';
}

export async function syncAiControlDiscordAgentChannelsFromEnv(env) {
  const token = env.DISCORD_BOT_TOKEN || '';
  const guildId = env.DISCORD_GUILD_ID || '';
  if (!token || !guildId) return { ok: true, skipped: 'Discord bot token or guild id is not configured' };
  if (String(env.AI_CONTROL_DISCORD_AGENT_CHANNEL_SYNC || 'true').toLowerCase() === 'false') {
    return { ok: true, skipped: 'AI Control Discord agent channel startup sync is disabled' };
  }

  const baseUrl = String(env.AI_CONTROL_BASE_URL || env.ERP_AI_CONTROL_URL || 'http://localhost:11024').replace(/\/+$/, '');
  const secret = env.AI_CONTROL_DISCORD_WEBHOOK_SECRET || env.DISCORD_WEBHOOK_SECRET || '';
  const response = await fetch(`${baseUrl}/api/ai-control/discord`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-ai-control-discord-secret': secret } : {}),
    },
    body: JSON.stringify({
      action: 'sync_agent_session_channels',
      botToken: token,
      guildId,
      categoryName: env.AI_CONTROL_DISCORD_CATEGORY_NAME || env.DISCORD_AGENT_CATEGORY_NAME || 'Agents',
      debugCategoryName: env.AI_CONTROL_DISCORD_DEBUG_CATEGORY_NAME || env.DISCORD_AGENT_DEBUG_CATEGORY_NAME || undefined,
      tenantId: env.AI_CONTROL_TENANT_ID || env.ERP_TENANT_ID || undefined,
      sessionId: env.AI_CONTROL_SESSION_ID || undefined,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `AI Control returned HTTP ${response.status}`);
  }
  console.error(
    `AI Control Discord agent channel startup sync complete: created ${result.createdCount || 0}, existing ${result.existingCount || 0}, bound ${result.boundCount || 0}.`,
  );
  return result;
}

export { BridgeState } from './state.js';
export { TelegramClient } from './telegram.js';
export { DiscordClient } from './discord.js';
export { CodexAppServer } from './codex-app-server.js';
export { CodexTelegramTopicBridge } from './bridge.js';
export { CodexDiscordChannelBridge } from './discord-bridge.js';
export { CodexCliFallback } from './cli-fallback.js';
export { WatchApiServer, parseModuleStatusTargets, parseWatchProjects } from './watch-api.js';
