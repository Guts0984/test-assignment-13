import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  readonly debug: (msg: string, fields?: Record<string, unknown>) => void;
  readonly info: (msg: string, fields?: Record<string, unknown>) => void;
  readonly warn: (msg: string, fields?: Record<string, unknown>) => void;
  readonly error: (msg: string, fields?: Record<string, unknown>) => void;
};

/** One JSON object per line on stdout, which is what `docker logs` and log shippers want. */
export const createLogger = (level: LogLevel, base: Record<string, unknown> = {}): Logger => {
  const write =
    (lvl: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (ORDER[lvl] < ORDER[level]) return;
      process.stdout.write(
        `${JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...base, ...fields })}\n`,
      );
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
};

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const errorFields = (e: unknown): Record<string, unknown> => ({
  error: e instanceof Error ? e.message : String(e),
});
