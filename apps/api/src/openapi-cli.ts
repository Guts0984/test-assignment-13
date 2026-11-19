import { writeFile } from 'node:fs/promises';
import { buildApp } from './app.js';
import { loadApiConfig } from './config.js';
import { buildOpenApi } from './openapi.js';

/** `pnpm openapi:generate` → apps/api/openapi.json. Builds the routes without listening or needing the services. */
const target = process.argv[2] ?? 'openapi.json';
const { app, ctx } = await buildApp(loadApiConfig());
await app.init();
await writeFile(target, `${JSON.stringify(buildOpenApi(app), null, 2)}\n`);
await app.close();
await ctx.close();
process.stdout.write(`wrote ${target}\n`);
process.exit(0); // the socket adapter keeps its own Redis connection open
