import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncAiControlDiscordAgentChannelsFromEnv } from '../src/index.js';

test('Discord startup sync posts existing bot token and guild to AI Control', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, createdCount: 2, existingCount: 1, boundCount: 3 }),
    };
  };

  try {
    const result = await syncAiControlDiscordAgentChannelsFromEnv({
      DISCORD_BOT_TOKEN: 'discord-token',
      DISCORD_GUILD_ID: 'guild-1',
      AI_CONTROL_BASE_URL: 'http://ai-control.local/',
      AI_CONTROL_DISCORD_WEBHOOK_SECRET: 'shared-secret',
      AI_CONTROL_DISCORD_CATEGORY_NAME: 'Agents',
      AI_CONTROL_DISCORD_DEBUG_CATEGORY_NAME: 'Agents Debug',
      AI_CONTROL_TENANT_ID: 'naiom',
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://ai-control.local/api/ai-control/discord');
    assert.equal(calls[0].options.headers['x-ai-control-discord-secret'], 'shared-secret');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      action: 'sync_agent_session_channels',
      botToken: 'discord-token',
      guildId: 'guild-1',
      categoryName: 'Agents',
      debugCategoryName: 'Agents Debug',
      tenantId: 'naiom',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord startup sync skips safely without Discord config', async () => {
  const result = await syncAiControlDiscordAgentChannelsFromEnv({});
  assert.equal(result.ok, true);
  assert.match(result.skipped, /not configured/);
});
