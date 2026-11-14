import 'dotenv/config';
import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { flushSecurityEvents } from './lib/security-events.js';
import { startWebhookWorker } from './modules/webhooks/service.js';

const env = getEnv();
const app = createApp();
const server = app.listen(env.PORT, () => logger().info({ port: env.PORT, env: env.NODE_ENV }, 'listening'));
const stopWebhooks = startWebhookWorker();

async function shutdown(signal: string): Promise<void> {
  logger().info({ signal }, 'shutting down');
  stopWebhooks();
  server.close(async () => {
    await flushSecurityEvents();
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
