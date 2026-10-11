import { ConfigError, loadDotEnv } from './config';
import { Runtime } from './runtime';

loadDotEnv();

const runtime = new Runtime(process.env);
try {
  await runtime.start();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\nConfiguration error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const shutdown = async (signal: string) => {
  console.info(`${signal} received, shutting down`);
  await runtime.shutdown();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
