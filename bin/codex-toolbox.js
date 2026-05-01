#!/usr/bin/env node
import { createBridgeFromEnv } from '../src/index.js';

const bridge = createBridgeFromEnv(process.env);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await bridge.stop();
    process.exit(0);
  });
}

bridge.start().catch((error) => {
  console.error(error);
  process.exit(1);
});
