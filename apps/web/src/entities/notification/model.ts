import { z } from 'zod';

/** One row of GET /me/notifications (the generated type is an open object, so it is parsed here). */
export const notificationSchema = z.object({
  id: z.number(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  at: z.string(),
  read: z.boolean(),
});
export type AppNotification = z.infer<typeof notificationSchema>;

export const parseNotifications = (raw: readonly unknown[] | undefined): AppNotification[] =>
  (raw ?? []).flatMap((r) => {
    const p = notificationSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
