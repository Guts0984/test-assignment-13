import { SwaggerModule, DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { z } from 'zod';
import {
  bidInputSchema,
  errorResponseSchema,
  lotAppendDescriptionInputSchema,
  lotCreateInputSchema,
  lotRejectInputSchema,
  loginInputSchema,
  lotUpdateInputSchema,
  photoPresignInputSchema,
  registerInputSchema,
  searchQuerySchema,
  shipInputSchema,
  topUpInputSchema,
} from '@auction/shared';

/**
 * The OpenAPI document is generated from the code (routes) plus the Zod schemas that actually validate the
 * input and describe the output, so the generated web client can never drift from the server. Nothing here is
 * hand-written TypeScript for the client; it is derived data.
 */
const json = (schema: z.ZodType) => ({
  'application/json': {
    schema: z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    }) as object,
  },
});
const jsonOut = (schema: z.ZodType) => ({
  'application/json': {
    schema: z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'output',
      unrepresentable: 'any',
    }) as object,
  },
});

const user = z.object({
  id: z.string(),
  email: z.string().optional(),
  displayName: z.string(),
  role: z.enum(['user', 'moderator', 'finance']),
});
const bidResult = z.object({
  ok: z.literal(true),
  outcome: z.enum(['leading', 'outbid_by_autobid']),
  currentPrice: z.number().int(),
  bidCount: z.number().int(),
  endsAt: z.string(),
  extended: z.boolean(),
  reserveMet: z.boolean().nullable(),
  yourMax: z.number().int().nullable(),
  minNextBid: z.number().int(),
});
const lotView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  categoryId: z.number().int(),
  cityId: z.number().int(),
  condition: z.string(),
  status: z.string(),
  startPrice: z.number().int(),
  currentPrice: z.number().int(),
  bidCount: z.number().int(),
  minNextBid: z.number().int(),
  buyNowPrice: z.number().int().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  reserveMet: z.boolean().nullable(),
  seller: z.object({ displayName: z.string() }),
  eventSeq: z.number().int(),
  serverNow: z.number(),
  photos: z.array(
    z.object({
      id: z.string(),
      position: z.number().int(),
      status: z.string(),
      url: z.string().nullable(),
      previewUrl: z.string().nullable(),
    }),
  ),
  viewer: z.object({
    isSeller: z.boolean(),
    isBuyer: z.boolean(),
    isLeading: z.boolean(),
    yourMax: z.number().int().nullable(),
    mustPayBy: z.string().nullable(),
    priceToPay: z.number().int().nullable(),
    reservePrice: z.number().int().nullable(),
    rejectReason: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    winner: z.object({ displayName: z.string() }).nullable(),
  }),
});
const bids = z.object({
  serverNow: z.number(),
  items: z.array(
    z.object({
      id: z.number().int(),
      amount: z.number().int(),
      isAuto: z.boolean(),
      at: z.string(),
      bidder: z.string(),
      you: z.boolean(),
    }),
  ),
});
const events = z.object({
  serverNow: z.number(),
  latestSeq: z.number().int(),
  events: z.array(
    z.object({
      seq: z.number().int(),
      type: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
});
const wallet = z.object({
  balance: z.number().int(),
  held: z.number().int(),
  available: z.number().int(),
  history: z.array(
    z.object({
      at: z.string(),
      kind: z.string(),
      lotId: z.string().nullable(),
      availableDelta: z.number().int(),
      heldDelta: z.number().int(),
    }),
  ),
});
const facet = z.record(z.string(), z.number().int());
const searchResult = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      category_id: z.number().int(),
      city_id: z.number().int(),
      condition: z.string(),
      current_price: z.number().int(),
      bid_count: z.number().int(),
      has_bids: z.boolean(),
      ends_at: z.number(),
      created_at: z.number(),
      reserve_met: z.boolean().nullable(),
      photo: z.string().nullable(),
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  facets: z.object({ category: facet, city: facet, condition: facet }),
});
const named = z.array(
  z.object({
    id: z.number().int(),
    slug: z.string(),
    nameUk: z.string(),
    nameEn: z.string(),
    namePl: z.string(),
  }),
);
const topup = z.object({
  topupId: z.string(),
  amount: z.number().int(),
  status: z.string(),
  payUrl: z.string(),
});
const presign = z.object({
  photoId: z.string(),
  position: z.number().int(),
  upload: z.object({
    url: z.string(),
    fields: z.record(z.string(), z.string()),
    expiresInSeconds: z.number().int(),
  }),
});
const rows = z.array(z.record(z.string(), z.unknown()));
const any = z.record(z.string(), z.unknown());

type Doc = { body?: z.ZodType; query?: z.ZodObject; ok?: z.ZodType; status?: string };
const DOCS: Record<string, Doc> = {
  'POST /auth/register': { body: registerInputSchema, ok: user, status: '201' },
  'POST /auth/login': { body: loginInputSchema, ok: user },
  'GET /auth/me': {
    ok: z.object({ id: z.string(), role: z.string(), displayName: z.string(), locale: z.string() }),
  },
  'GET /search': { query: searchQuerySchema, ok: searchResult },
  'GET /categories': { ok: named },
  'GET /cities': { ok: named },
  'GET /time': { ok: z.object({ serverNow: z.number() }) },
  'GET /lots/{id}': { ok: lotView },
  'GET /lots/{id}/bids': { ok: bids },
  'GET /lots/{id}/events': { ok: events },
  'POST /lots/{id}/bids': { body: bidInputSchema, ok: bidResult },
  'POST /lots/{id}/buy-now': {
    ok: z.object({ ok: z.literal(true), price: z.number().int(), paymentDueAt: z.string() }),
  },
  'POST /lots/{id}/pay': {
    ok: z.object({ ok: z.literal(true), price: z.number().int(), paidAt: z.string() }),
  },
  'POST /lots/{id}/ship': { body: shipInputSchema, ok: z.object({ shippedAt: z.string() }) },
  'POST /lots/{id}/confirm': {
    ok: z.object({ commission: z.number().int(), sellerReceives: z.number().int() }),
  },
  'GET /me/wallet': { ok: wallet },
  'POST /me/topups': { body: topUpInputSchema, ok: topup, status: '201' },
  'GET /me/bids': { ok: rows },
  'GET /me/lots': { ok: z.object({ items: rows, pendingPayout: z.number().int() }) },
  'GET /me/wins': { ok: rows },
  'GET /me/favorites': { ok: rows },
  'GET /me/notifications': { ok: rows },
  'POST /lots': { body: lotCreateInputSchema, ok: z.object({ lotId: z.string() }), status: '201' },
  'PUT /lots/{id}': { body: lotUpdateInputSchema, ok: z.object({ status: z.string() }) },
  'POST /lots/{id}/description': {
    body: lotAppendDescriptionInputSchema,
    ok: z.object({ description: z.string() }),
  },
  'POST /lots/{id}/photos/presign': { body: photoPresignInputSchema, ok: presign, status: '201' },
  'POST /moderation/claim': { ok: z.object({ lotId: z.string(), expiresAt: z.string() }) },
  'GET /moderation/lots/{id}': { ok: any },
  'POST /moderation/lots/{id}/reject': {
    body: lotRejectInputSchema,
    ok: z.object({ status: z.string() }),
  },
  'POST /moderation/lots/{id}/remove': {
    body: lotRejectInputSchema,
    ok: z.object({ released: z.number().int() }),
  },
  'POST /moderation/lots/{id}/approve': { ok: z.object({ endsAt: z.string() }) },
  'GET /finance/report': { query: z.object({ from: z.string(), to: z.string() }), ok: any },
  'GET /finance/reconciliation': { ok: any },
};

export const buildOpenApi = (app: INestApplication): OpenAPIObject => {
  const config = new DocumentBuilder()
    .setTitle('Auction API')
    .setVersion('1.0.0')
    .setDescription(
      'Errors always have the shape { error: { code, message, details?, meta? }, requestId }.',
    )
    .addCookieAuth('sid')
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  const errorSchema = z.toJSONSchema(errorResponseSchema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as object;
  doc.components = {
    ...doc.components,
    schemas: { ...doc.components?.schemas, ErrorResponse: errorSchema as never },
  };
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const key = `${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`;
      const d = DOCS[key];
      const responses: Record<string, unknown> = {};
      const ok = d?.status ?? (method === 'post' || method === 'put' ? '200' : '200');
      responses[ok] = d?.ok ? { description: 'OK', content: jsonOut(d.ok) } : { description: 'OK' };
      for (const code of ['400', '401', '403', '404', '409', '422', '429', '500', '503']) {
        responses[code] = {
          description: 'Error',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        };
      }
      op['responses'] = responses;
      if (d?.body) op['requestBody'] = { required: true, content: json(d.body) };
      if (d?.query) {
        const props =
          (
            z.toJSONSchema(d.query, {
              target: 'draft-2020-12',
              io: 'input',
              unrepresentable: 'any',
            }) as { properties?: Record<string, object> }
          ).properties ?? {};
        op['parameters'] = [
          ...((op['parameters'] as unknown[] | undefined) ?? []).filter(
            (p) => (p as { in?: string }).in === 'path',
          ),
          ...Object.entries(props).map(([name, schema]) => ({
            name,
            in: 'query',
            required: false,
            schema,
          })),
        ];
      }
      if (
        ['POST', 'PUT'].includes(method.toUpperCase()) &&
        /\/(bids|buy-now|pay|topups)$/.test(path)
      ) {
        op['parameters'] = [
          ...((op['parameters'] as unknown[] | undefined) ?? []),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 8, maxLength: 128 },
          },
        ];
      }
    }
  }
  return doc;
};

export const setupOpenApi = async (app: INestApplication): Promise<void> => {
  const doc = buildOpenApi(app);
  SwaggerModule.setup('docs', app, doc, { jsonDocumentUrl: '/docs/json' });
};
