import { createPool } from './client.js';
import { loadDbEnv } from './env.js';
import { migrate } from './migrate.js';
import { applyAppGrants, ensureAppRole } from './roles.js';
import { seedDatabase } from './seed/index.js';
import { z } from 'zod';
import { parseEnv, secretSchema } from '@auction/shared';

/**
 * `db-init` container entry point:  node dist/cli.js init
 *   migrate → create/refresh the restricted application role → seed (once).
 * Output is plain lines on stdout/stderr: it runs once and is read by humans and `docker logs`.
 */
const log = (message: string): void => {
  process.stdout.write(`[db] ${message}\n`);
};

const appRoleEnv = z.object({
  APP_DB_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('auction_app'),
  APP_DB_PASSWORD: secretSchema,
});

const run = async (command: string): Promise<void> => {
  const env = loadDbEnv();
  const pool = createPool(env.DATABASE_ADMIN_URL, { max: 2, applicationName: 'db-init' });
  try {
    if (command === 'migrate' || command === 'init') {
      const result = await migrate(pool);
      log(
        `migrations: ${result.applied.length} applied, ${result.skipped.length} already up to date`,
      );
    }
    if (command === 'init') {
      const app = parseEnv(appRoleEnv, process.env);
      await ensureAppRole(pool, { user: app.APP_DB_USER, password: app.APP_DB_PASSWORD });
      await applyAppGrants(pool, app.APP_DB_USER);
      log(`application role "${app.APP_DB_USER}" ready`);
    }
    if (command === 'seed' || command === 'init') {
      if (!env.SEED_ENABLED) {
        log('seed disabled (SEED_ENABLED=false)');
      } else {
        const result = await seedDatabase(pool, {
          users: env.SEED_USERS,
          lots: env.SEED_LOTS,
          bids: env.SEED_BIDS,
          rng: env.SEED_RNG,
          password: env.SEED_PASSWORD,
        });
        log(
          result.seeded
            ? `seeded ${result.summary.users} users, ${result.summary.lots} lots, ${result.summary.bids} bids in ${(result.ms / 1000).toFixed(1)}s`
            : 'seed skipped: already seeded',
        );
      }
    }
    if (!['migrate', 'seed', 'init'].includes(command)) {
      throw new Error(`unknown command "${command}" (use: migrate | seed | init)`);
    }
  } finally {
    await pool.end();
  }
};

run(process.argv[2] ?? 'init').catch((error: unknown) => {
  process.stderr.write(`[db] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
