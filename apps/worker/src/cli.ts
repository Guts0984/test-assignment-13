import { initInfrastructure, reindexCommand } from './bootstrap.js';
import { loadWorkerConfig } from './env.js';
import { createLogger } from './log.js';

/** `node dist/cli.js init | reindex` */
const command = process.argv[2];
const config = loadWorkerConfig();
const log = createLogger(config.logLevel, { service: 'worker-cli' });

try {
  if (command === 'init') await initInfrastructure(config, log);
  else if (command === 'reindex') await reindexCommand(config, log);
  else throw new Error(`unknown command "${command ?? ''}" (use: init | reindex)`);
} catch (e) {
  log.error('command failed', { error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
}
