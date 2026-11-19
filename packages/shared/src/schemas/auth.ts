import { z } from 'zod';
import { textSchema } from './common.js';

export const emailSchema = z
  .email({ error: 'INVALID_EMAIL' })
  .max(254)
  .transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(8, { error: 'PASSWORD_TOO_SHORT' })
  .max(128, { error: 'PASSWORD_TOO_LONG' });

export const registerInputSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  displayName: textSchema(2, 40),
});

export const loginInputSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
