import { z } from 'zod';
import { csvArray, pageSchema, pageSizeSchema, queryBooleanSchema, queryInt } from './common.js';
import { categoryIdQuerySchema, cityIdQuerySchema, itemConditionSchema } from './lot.js';

export const SEARCH_SORTS = [
  'relevance',
  'ending_soon',
  'newest',
  'price_asc',
  'price_desc',
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** "Ending soon" filter window. */
export const ENDING_SOON_MS = 60 * 60 * 1000;

/** Catalog query. Every field round-trips through the URL. Prices are kopecks. */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    category: csvArray(categoryIdQuerySchema),
    city: csvArray(cityIdQuerySchema),
    condition: csvArray(itemConditionSchema),
    priceMin: queryInt(0, 10_000_000_000).optional(),
    priceMax: queryInt(0, 10_000_000_000).optional(),
    noBids: queryBooleanSchema,
    endingSoon: queryBooleanSchema,
    sort: z.enum(SEARCH_SORTS).default('relevance'),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .refine((v) => v.priceMin === undefined || v.priceMax === undefined || v.priceMin <= v.priceMax, {
    path: ['priceMax'],
    error: 'PRICE_RANGE_INVERTED',
  });

export type SearchQuery = z.infer<typeof searchQuerySchema>;
