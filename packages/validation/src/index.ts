import { z } from 'zod';
import { AlertType, ContainerState, EntityStatus, MerchantApprovalStatus, OrderStatus, Quality } from '@eco-oil/shared-types';

export const uuidSchema = z.string().uuid();
export const phoneSchema = z.string().min(8).max(20);

export const zaloAuthSchema = z.object({
  zalo_id: z.string().min(1),
  phone: phoneSchema,
  name: z.string().trim().min(1).max(120).optional(),
});

export type ZaloAuthInput = z.infer<typeof zaloAuthSchema>;

export const adminLoginSchema = z.object({
  zalo_id: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  password: z.string().min(1).max(500),
});
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

export const refreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

const coordinateSchema = z.number().finite();
const vietnamLatitudeSchema = coordinateSchema.min(8, 'Vĩ độ phải nằm trong lãnh thổ Việt Nam').max(24, 'Vĩ độ phải nằm trong lãnh thổ Việt Nam');
const vietnamLongitudeSchema = coordinateSchema.min(102, 'Kinh độ phải nằm trong lãnh thổ Việt Nam').max(110, 'Kinh độ phải nằm trong lãnh thổ Việt Nam');

export const merchantRegisterSchema = z.object({
  zalo_id: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  phone: phoneSchema.optional(),
  business_type: z.string().trim().min(1).max(120).optional(),
  lat: vietnamLatitudeSchema,
  lng: vietnamLongitudeSchema,
  ward_id: uuidSchema,
  avg_daily_liters: z.number().finite().nonnegative().max(100000).optional(),
});
export type MerchantRegisterInput = z.infer<typeof merchantRegisterSchema>;

export const merchantPublicRegisterSchema = merchantRegisterSchema.extend({
  zalo_id: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  business_type: z.string().trim().min(1).max(120),
});
export type MerchantPublicRegisterInput = z.infer<typeof merchantPublicRegisterSchema>;

export const merchantApprovalSchema = z.object({
  lat: vietnamLatitudeSchema.optional(),
  lng: vietnamLongitudeSchema.optional(),
}).superRefine((value, context) => {
  if (value.lat !== undefined && value.lng === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['lng'], message: 'Kinh độ là bắt buộc khi nhập vĩ độ' });
  if (value.lng !== undefined && value.lat === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['lat'], message: 'Vĩ độ là bắt buộc khi nhập kinh độ' });
});
export type MerchantApprovalInput = z.infer<typeof merchantApprovalSchema>;

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
  ward_ids: z.array(uuidSchema).min(1).max(50),
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

export const adminContainerCreateSchema = z.object({
  ward_id: uuidSchema.optional(),
  ward_code: z.string().trim().min(1).max(30).optional(),
  qr_code: z.string().trim().min(1).max(100).optional(),
  capacity_liters: z.number().finite().positive().max(100000),
}).refine((value) => Boolean(value.ward_id || value.ward_code), { message: 'ward_id hoặc ward_code là bắt buộc', path: ['ward_id'] });
export type AdminContainerCreateInput = z.infer<typeof adminContainerCreateSchema>;

export const adminContainerListQuerySchema = paginationSchema.extend({
  state: z.nativeEnum(ContainerState).optional(),
  merchant_id: uuidSchema.optional(),
  unassigned: z.coerce.boolean().optional(),
});
export type AdminContainerListQueryInput = z.infer<typeof adminContainerListQuerySchema>;

const wardCodeSchema = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/, 'Mã phường chỉ được gồm chữ, số và dấu gạch ngang').transform((value) => value.toUpperCase());
const adminWardBaseSchema = z.object({
  code: wardCodeSchema,
  name: z.string().trim().min(1).max(200),
  district: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(200),
  center_lat: coordinateSchema.min(-90).max(90).optional(),
  center_lng: coordinateSchema.min(-180).max(180).optional(),
});
export const adminWardCreateSchema = adminWardBaseSchema.superRefine((value, context) => {
  if (value.center_lat !== undefined && value.center_lng === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['center_lng'], message: 'Cần nhập kinh độ cùng vĩ độ' });
  if (value.center_lng !== undefined && value.center_lat === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['center_lat'], message: 'Cần nhập vĩ độ cùng kinh độ' });
});
export type AdminWardCreateInput = z.infer<typeof adminWardCreateSchema>;

export const adminWardPatchSchema = adminWardBaseSchema.partial().extend({
  status: z.nativeEnum(EntityStatus).optional(),
  is_active: z.boolean().optional(),
});
export type AdminWardPatchInput = z.infer<typeof adminWardPatchSchema>;

export const adminWardListQuerySchema = z.object({
  include_inactive: z.coerce.boolean().default(true),
});
export type AdminWardListQueryInput = z.infer<typeof adminWardListQuerySchema>;

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

export const syncBatchSchema = z.object({
  items: z.array(z.unknown()),
});
export type SyncBatchInput = z.infer<typeof syncBatchSchema>;

export const stationDeliveryCreateSchema = z.object({
  client_uuid: uuidSchema,
  station_id: uuidSchema,
  transaction_ids: z.array(uuidSchema).min(1).max(100).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'transaction_ids must be unique' });
    }
  }),
  actual_liters: z.number().finite().positive().max(100000),
  delivered_at: z.coerce.date().optional(),
  note: z.string().trim().max(1000).optional(),
  photos: z.array(z.string().url()).max(20).default([]),
});
export type StationDeliveryCreateInput = z.infer<typeof stationDeliveryCreateSchema>;

export const stationRecommendSchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  liters: z.coerce.number().finite().positive().max(100000),
});
export type StationRecommendInput = z.infer<typeof stationRecommendSchema>;

const dateRangeRefinement = (value: { from?: Date; to?: Date }, context: z.RefinementCtx) => {
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be on or after from' });
  }
};

export const adminOverviewQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).superRefine(dateRangeRefinement);
export type AdminOverviewQueryInput = z.infer<typeof adminOverviewQuerySchema>;

export const adminReconciliationQuerySchema = z.object({
  date: z.coerce.date(),
});
export type AdminReconciliationQueryInput = z.infer<typeof adminReconciliationQuerySchema>;

export const adminAlertListQuerySchema = paginationSchema.extend({
  type: z.nativeEnum(AlertType).optional(),
  resolved: z.coerce.boolean().optional(),
});
export type AdminAlertListQueryInput = z.infer<typeof adminAlertListQuerySchema>;

export const adminMerchantListQuerySchema = merchantListQuerySchema.extend({
  status: z.nativeEnum(MerchantApprovalStatus).optional(),
  search: z.string().trim().max(120).optional(),
  anomaly: z.coerce.boolean().optional(),
});
export type AdminMerchantListQueryInput = z.infer<typeof adminMerchantListQuerySchema>;

export const adminCollectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: phoneSchema,
  zalo_id: z.string().trim().min(1).max(120),
  vehicle_type: z.string().trim().min(1).max(120),
  max_capacity_l: z.number().finite().positive().max(100000),
  ward_ids: z.array(uuidSchema).min(1).max(50),
});
export type AdminCollectorCreateInput = z.infer<typeof adminCollectorCreateSchema>;

export const adminCollectorPatchSchema = adminCollectorCreateSchema.partial().extend({
  status: z.nativeEnum(EntityStatus).optional(),
});
export type AdminCollectorPatchInput = z.infer<typeof adminCollectorPatchSchema>;

export const merchantRejectSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type MerchantRejectInput = z.infer<typeof merchantRejectSchema>;

export const adminCollectorListQuerySchema = personListQuerySchema;
export type AdminCollectorListQueryInput = z.infer<typeof adminCollectorListQuerySchema>;

export const adminStationListQuerySchema = personListQuerySchema;
export type AdminStationListQueryInput = z.infer<typeof adminStationListQuerySchema>;
