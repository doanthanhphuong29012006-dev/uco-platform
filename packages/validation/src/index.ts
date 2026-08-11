import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const phoneSchema = z.string().min(8).max(20);

export const zaloAuthSchema = z.object({
  zalo_id: z.string().min(1),
  phone: phoneSchema,
  name: z.string().trim().min(1).max(120).optional(),
});

export type ZaloAuthInput = z.infer<typeof zaloAuthSchema>;

export const refreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
