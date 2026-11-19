import { envBoolean, envPositiveInt, parseEnv } from '@auction/shared';
import { z } from 'zod';

/**
 * Env for the db CLI (migrate + seed). It connects as the database OWNER (DATABASE_ADMIN_URL);
 * the API and worker use the restricted role from DATABASE_URL instead. URLs carry passwords,
 * so they have no default.
 */
const dbEnvSchema = z.object({
  DATABASE_ADMIN_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, { error: 'must be a postgres:// URL' }),
  SEED_ENABLED: envBoolean.default(true),
  SEED_USERS: envPositiveInt(10_000),
  SEED_LOTS: envPositiveInt(50_000),
  SEED_BIDS: envPositiveInt(500_000),
  SEED_RNG: envPositiveInt(13),
  SEED_PASSWORD: z.string().min(8).default('Passw0rd!'),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

export const loadDbEnv = (source: Record<string, string | undefined> = process.env): DbEnv =>
  parseEnv(dbEnvSchema, source);
