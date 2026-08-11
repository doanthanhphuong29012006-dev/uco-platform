export enum Role {
  MERCHANT = 'MERCHANT',
  COLLECTOR = 'COLLECTOR',
  STATION = 'STATION',
  ADMIN = 'ADMIN',
}

export enum EntityStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export enum ContainerState {
  AT_MERCHANT = 'AT_MERCHANT',
  IN_TRANSIT = 'IN_TRANSIT',
  AT_STATION = 'AT_STATION',
}

export enum OrderStatus {
  READY = 'READY',
  ASSIGNED = 'ASSIGNED',
  COLLECTED = 'COLLECTED',
  CANCELLED = 'CANCELLED',
}

export enum OrderSource {
  MANUAL = 'MANUAL',
  PREDICTED = 'PREDICTED',
}

export enum Quality {
  PASS = 'PASS',
  FLAG = 'FLAG',
}

export enum DeliveryStatus {
  OK = 'OK',
  FLAGGED = 'FLAGGED',
}

export enum AlertType {
  GEO_MISMATCH = 'GEO_MISMATCH',
  DELIVERY_VARIANCE = 'DELIVERY_VARIANCE',
}

export enum AlertSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export type UserRole = Role;
export type QualityStatus = Quality;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
}

export interface PagedResponse<T> {
  data: T[];
  meta: PageMeta;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: unknown;
}

export interface AuthUser {
  id: string;
  zalo_id: string;
  phone: string;
  name: string | null;
  role: Role;
  merchantId: string | null;
  collectorId: string | null;
}

export interface MerchantContainerSummary {
  code: string;
  state: ContainerState;
  capacity_l: number | null;
  estimated_liters: number;
}

export interface MerchantDashboardResponse {
  containers: MerchantContainerSummary[];
  pending_orders: number;
  liters_this_month: number;
  last_collected_at: string | null;
}

export interface MerchantTransaction {
  id: string;
  client_uuid: string;
  order_id: string | null;
  container_id: string;
  container_code: string;
  merchant_id: string;
  collector_id: string;
  collector_name: string | null;
  actual_liters: number;
  quality: Quality;
  geo: { lat: number; lng: number } | null;
  photos: unknown;
  collected_at: string;
  created_at: string;
}

export interface CollectionOrderResponse {
  id: string;
  merchant_id: string;
  container_id: string | null;
  container_code: string | null;
  expected_liters: number | null;
  priority: number;
  status: OrderStatus;
  source: OrderSource;
  note: string | null;
  requested_at: string;
  cancelled_at: string | null;
  container_state: ContainerState | null;
  capacity_l: number | null;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RouteStop {
  seq: number;
  order_id: string;
  merchant: { name: string; address: string | null; phone?: string | null; lat: number; lng: number };
  container_code: string;
  expected_liters: number;
  priority: number;
  distance_m: number;
}

export interface CurrentRouteResponse {
  stops: RouteStop[];
  total_expected_liters: number;
  remaining_capacity_l: number;
}

export interface ContainerLookupResponse {
  id: string;
  qr_code: string;
  state: ContainerState;
  status: EntityStatus;
  capacity_liters: number | null;
  merchant: { id: string; name: string; address: string | null; lat?: number; lng?: number };
}

export interface CollectionCreateRequest {
  client_uuid: string;
  order_id: string;
  container_code: string;
  actual_liters: number;
  quality: Quality;
  geo: GeoPoint;
  photos: string[];
}

export interface CollectionTransactionResponse extends CollectionCreateRequest {
  id: string;
  container_id: string;
  merchant_id: string;
  collector_id: string;
  collected_at: string;
  created_at: string;
}
