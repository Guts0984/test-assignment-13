import { z } from 'zod';

export const MAX_REPORT_DAYS = 366;

const isoDate = z.iso.date({ error: 'INVALID_DATE' });

/** Report period, inclusive dates in UTC (YYYY-MM-DD). */
export const reportQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, { path: ['to'], error: 'PERIOD_INVERTED' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MAX_REPORT_DAYS, {
    path: ['to'],
    error: 'PERIOD_TOO_LONG',
  });

export type ReportQuery = z.infer<typeof reportQuerySchema>;
