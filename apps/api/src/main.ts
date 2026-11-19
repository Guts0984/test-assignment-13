import { loadApiConfig } from './config.js';
import { startApp } from './app.js';

const config = loadApiConfig();
const running = await startApp(config);
process.stdout.write(
  `${JSON.stringify({ level: 'info', msg: 'api listening', node: config.nodeId, url: running.url })}\n`,
);
