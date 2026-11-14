import 'dotenv/config';
import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';

const env = getEnv();
const app = createApp();
const server = app.listen(env.PORT, () => logger().info({ port: env.PORT, env: env.NODE_ENV }, 'listening'));

async function shutdown(signal: string): Promise<void> {
  logger().info({ signal }, 'shutting down');
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
