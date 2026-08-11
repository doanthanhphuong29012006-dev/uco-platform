import { z } from 'zod';
import { ContainerState, EntityStatus, OrderStatus, Quality } from '@eco-oil/shared-types';

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

const coordinateSchema = z.number().finite();

export const merchantRegisterSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  lat: coordinateSchema.min(-90).max(90),
  lng: coordinateSchema.min(-180).max(180),
  ward_id: uuidSchema,
  avg_daily_liters: z.number().finite().nonnegative().max(100000).optional(),
});
export type MerchantRegisterInput = z.infer<typeof merchantRegisterSchema>;

export const merchantPatchSchema = merchantRegisterSchema.partial().superRefine((value, context) => {
  if (value.lat !== undefined && value.lng === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lng'], message: 'lng is required with lat' });
  }
  if (value.lng !== undefined && value.lat === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lat'], message: 'lat is required with lng' });
  }
});
export type MerchantPatchInput = z.infer<typeof merchantPatchSchema>;

export const entityStatusSchema = z.object({
  status: z.nativeEnum(EntityStatus),
});
export type EntityStatusInput = z.infer<typeof entityStatusSchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  include_inactive: z.coerce.boolean().default(false),
});

export const merchantListQuerySchema = paginationSchema.extend({
  ward_id: uuidSchema.optional(),
  status: z.nativeEnum(EntityStatus).optional(),
});
export type MerchantListQueryInput = z.infer<typeof merchantListQuerySchema>;

export const adminPersonCreateSchema = z.object({
  user_id: uuidSchema,
  display_name: z.string().trim().min(1).max(200),
  ward_id: uuidSchema,
});
export type AdminPersonCreateInput = z.infer<typeof adminPersonCreateSchema>;

export const adminPersonPatchSchema = adminPersonCreateSchema.partial();
export type AdminPersonPatchInput = z.infer<typeof adminPersonPatchSchema>;
export const personListQuerySchema = paginationSchema.extend({
  ward_id: uuidSchema.optional(),
  status: z.nativeEnum(EntityStatus).optional(),
});
export type PersonListQueryInput = z.infer<typeof personListQuerySchema>;

export const stationCreateSchema = z.object({
  user_id: uuidSchema,
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  lat: coordinateSchema.min(-90).max(90),
  lng: coordinateSchema.min(-180).max(180),
  ward_id: uuidSchema,
});
export type StationCreateInput = z.infer<typeof stationCreateSchema>;

export const stationPatchSchema = stationCreateSchema.partial().superRefine((value, context) => {
  if (value.lat !== undefined && value.lng === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lng'], message: 'lng is required with lat' });
  }
  if (value.lng !== undefined && value.lat === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lat'], message: 'lat is required with lng' });
  }
});
export type StationPatchInput = z.infer<typeof stationPatchSchema>;

export const containerCreateSchema = z.object({
  ward_code: z.string().trim().min(1).max(30).optional(),
  merchant_id: uuidSchema,
  qr_code: z.string().trim().min(1).max(100).optional(),
  capacity_liters: z.number().finite().positive().max(100000).optional(),
  state: z.nativeEnum(ContainerState).optional(),
});
export type ContainerCreateInput = z.infer<typeof containerCreateSchema>;

export const containerListQuerySchema = paginationSchema.extend({
  state: z.nativeEnum(ContainerState).optional(),
  merchant_id: uuidSchema.optional(),
});
export type ContainerListQueryInput = z.infer<typeof containerListQuerySchema>;

export const containerAssignSchema = z.object({
  merchant_id: uuidSchema,
});
export type ContainerAssignInput = z.infer<typeof containerAssignSchema>;

export const orderReadySchema = z.object({
  container_id: uuidSchema.optional(),
  expected_liters: z.number().finite().positive().max(100000).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type OrderReadyInput = z.infer<typeof orderReadySchema>;

export const orderListQuerySchema = paginationSchema.extend({
  status: z.nativeEnum(OrderStatus).optional(),
});
export type OrderListQueryInput = z.infer<typeof orderListQuerySchema>;

const optionalCoordinate = z.coerce.number().finite();
export const routeQuerySchema = z
  .object({
    lat: optionalCoordinate.min(-90).max(90).optional(),
    lng: optionalCoordinate.min(-180).max(180).optional(),
  })
  .superRefine((value, context) => {
    if (value.lat !== undefined && value.lng === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['lng'], message: 'lng is required with lat' });
    }
    if (value.lng !== undefined && value.lat === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['lat'], message: 'lat is required with lng' });
    }
  });
export type RouteQueryInput = z.infer<typeof routeQuerySchema>;

export const collectionCreateSchema = z.object({
  client_uuid: uuidSchema,
  order_id: uuidSchema,
  container_code: z.string().trim().min(1).max(100),
  actual_liters: z.number().finite().positive().max(100000),
  quality: z.nativeEnum(Quality),
  geo: z.object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  }),
  photos: z.array(z.string().url()).max(20).default([]),
  collected_at: z.coerce.date().optional(),
});
export type CollectionCreateInput = z.infer<typeof collectionCreateSchema>;

export const collectionListQuerySchema = paginationSchema.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type CollectionListQueryInput = z.infer<typeof collectionListQuerySchema>;
