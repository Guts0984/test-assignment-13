import { z } from 'zod';

/** One row of GET /me/favorites (the generated type is an open object, so it is parsed here). */
export const favoriteSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  currentPrice: z.number(),
  endsAt: z.string().nullable(),
});
export type Favorite = z.infer<typeof favoriteSchema>;

export const parseFavorites = (raw: readonly unknown[] | undefined): Favorite[] =>
  (raw ?? []).flatMap((r) => {
    const p = favoriteSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
