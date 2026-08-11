import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const phoneSchema = z.string().min(8).max(20);

export const zaloAuthSchema = z.object({
  zaloId: z.string().min(1),
  phone: phoneSchema.optional(),
});

export type ZaloAuthInput = z.infer<typeof zaloAuthSchema>;
