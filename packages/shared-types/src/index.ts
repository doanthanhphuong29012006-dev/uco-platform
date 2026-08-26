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

export enum MerchantApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
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

export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export enum AlertType {
  GEO_MISMATCH = 'GEO_MISMATCH',
  DELIVERY_VARIANCE = 'DELIVERY_VARIANCE',
  WARD_LOCATION_MISMATCH = 'WARD_LOCATION_MISMATCH',
  COLLECTION_LITERS_DEVIATION = 'COLLECTION_LITERS_DEVIATION',
  CONTAINER_TRANSIT_CANCELLED = 'CONTAINER_TRANSIT_CANCELLED',
  MASS_ESTIMATED_NOT_WEIGHED = 'MASS_ESTIMATED_NOT_WEIGHED',
  SUSPECTED_ADULTERATION = 'SUSPECTED_ADULTERATION',
  OIL_GRADE_C = 'OIL_GRADE_C',
}

export enum MassSource {
  SCALE = 'SCALE',
  ESTIMATED_FROM_VOLUME = 'ESTIMATED_FROM_VOLUME',
}

export enum OilGrade {
  A = 'A',
  B = 'B',
  C = 'C',
}

export type ImageGradeConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type GradeDecisionSource = 'MANUAL' | 'AI_SUGGESTION_ACCEPTED' | 'MANUAL_OVERRIDE_AI';

export interface OilImageAnalysisPayload {
  suggested_grade: OilGrade | null;
  confidence: ImageGradeConfidence;
  model_version: 'oil-image-heuristic-v1';
  analyzed_image_count: number;
  quality_status: 'USABLE' | 'RETAKE_RECOMMENDED' | 'UNSUPPORTED';
  reason_codes: string[];
  summary: string;
  features: Record<string, number | null>;
}

export enum PriceUnit {
  PER_LITER = 'PER_LITER',
  PER_KG = 'PER_KG',
}

export const DEFAULT_DENSITY_KG_PER_LITER = 0.91;

export enum AlertSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum AnomalyFeedbackVerdict {
  CONFIRMED_ANOMALY = 'CONFIRMED_ANOMALY',
  FALSE_POSITIVE = 'FALSE_POSITIVE',
  UNSURE = 'UNSURE',
}

export type AnomalyRiskLevel = 'NORMAL' | 'REVIEW' | 'HIGH_RISK';

export interface AdminAnomalyReason {
  code: string;
  label: string;
  description: string;
  contribution: number | null;
  evidence: Record<string, unknown>;
  severity: AlertSeverity;
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
  merchantApprovalStatus: MerchantApprovalStatus | null;
  merchantRejectionReason: string | null;
}

export interface DevAccount {
  id: string;
  zalo_id: string;
  phone: string | null;
  name: string | null;
  role: Role;
  wards: Array<{ code: string; name: string; district: string; city: string }>;
}

export interface MerchantRegistrationRequest {
  zalo_id: string;
  name: string;
  address: string;
  phone: string;
  business_type: string;
  lat: number;
  lng: number;
  ward_id: string;
  avg_daily_liters?: number;
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

export interface PaymentRecord {
  id: string;
  merchant_id: string;
  merchant_name: string;
  transaction_id: string;
  liters: number;
  kilograms: number | null;
  unit_price: number;
  unit: PriceUnit;
  amount: number;
  period: string;
  status: PaymentStatus;
  paid_at: string | null;
  created_at: string;
  collected_at: string;
}

export interface PaymentListResponse extends PagedResponse<PaymentRecord> {
  totals: { liters: number; amount: number };
}

export interface PaymentRunResponse {
  created: number;
  skipped: number;
  total_amount: number;
}

export interface OilPriceRecord {
  id: string;
  unit_price: number;
  unit: PriceUnit;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string;
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
  actual_kg: number | null;
  mass_source: MassSource;
  density_factor: number | null;
  grade: OilGrade | null;
  grade_photo_url: string | null;
  grade_note: string | null;
  suspected_adulteration: boolean;
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
    collector_available?: boolean;
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
  pickup_priority_score: number;
  pickup_priority_level: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW' | 'INSUFFICIENT_DATA';
  pickup_priority_reason_codes: string[];
  pickup_volume_forecast?: {
    predicted_liters: number | null;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
    sample_size: number;
    reason_codes: string[];
  };
  ward_center?: GeoPoint | null;
}

export interface CurrentRouteResponse {
  stops: RouteStop[];
  total_expected_liters: number;
  remaining_capacity_l: number;
  route_optimization?: {
    estimated_distance_before_m: number | null;
    estimated_distance_after_m: number | null;
    saved_distance_m: number | null;
    optimization_applied: boolean;
    reason_codes: Array<'ROUTE_OPTIMIZED' | 'ALREADY_OPTIMAL' | 'INSUFFICIENT_STOPS' | 'INVALID_ORIGIN' | 'INVALID_STOP_COORDINATES'>;
  };
  route_capacity_risk?: {
    predicted_total_liters: number | null;
    risk_adjusted_total_liters: number | null;
    risk_adjusted_remaining_liters: number | null;
    risk_utilization_pct: number | null;
    level: 'OVER_CAPACITY' | 'NEAR_CAPACITY' | 'BALANCED' | 'UNDERUTILIZED' | 'INSUFFICIENT_DATA';
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
    forecast_coverage_pct: number;
    reason_codes: string[];
  };
}

export interface ContainerLookupResponse {
  id: string;
  qr_code: string;
  state: ContainerState;
  status: EntityStatus;
  capacity_liters: number | null;
  merchant: { id: string; name: string; address: string | null; lat?: number; lng?: number };
}

export interface AdminContainerSummary {
  id: string;
  qr_code: string;
  state: ContainerState;
  status: EntityStatus;
  capacity_liters: number | null;
  last_seen_at: string | null;
  merchant: { id: string; name: string; address: string | null } | null;
}

export interface AdminContainerReturnRequest {
  merchant_id?: string;
  note?: string;
}

export interface AdminWardSummary {
  id: string;
  code: string;
  name: string;
  district: string;
  city: string;
  center_lat: number | null;
  center_lng: number | null;
  status: EntityStatus;
  is_active: boolean;
  merchant_count: number;
  container_count: number;
  collector_count: number;
}

export interface CollectionCreateRequest {
  client_uuid: string;
  order_id: string;
  container_code: string;
  actual_liters?: number;
  actual_kg?: number;
  grade?: OilGrade;
  grade_photo_url?: string;
  grade_note?: string;
  suspected_adulteration?: boolean;
  image_grade_suggestion?: OilGrade | null;
  image_grade_confidence?: ImageGradeConfidence | null;
  image_grade_model_version?: 'oil-image-heuristic-v1' | null;
  image_grade_analysis?: OilImageAnalysisPayload | null;
  grade_decision_source?: GradeDecisionSource;
  grade_ai_override_acknowledged?: boolean;
  quality: Quality;
  geo: GeoPoint;
  photos: string[];
  collected_at?: string;
}

export interface CollectionTransactionResponse extends Omit<CollectionCreateRequest, 'grade' | 'grade_photo_url' | 'grade_note' | 'suspected_adulteration' | 'image_grade_suggestion' | 'image_grade_confidence' | 'image_grade_model_version' | 'image_grade_analysis' | 'grade_decision_source' | 'grade_ai_override_acknowledged'> {
  id: string;
  actual_liters: number;
  container_id: string;
  merchant_id: string;
  collector_id: string;
  collected_at: string;
  created_at: string;
  mass_source: MassSource;
  density_factor: number | null;
  grade: OilGrade | null;
  grade_photo_url: string | null;
  grade_note: string | null;
  suspected_adulteration: boolean;
  image_grade_suggestion: OilGrade | null;
  image_grade_confidence: ImageGradeConfidence | null;
  image_grade_model_version: 'oil-image-heuristic-v1' | null;
  image_grade_analysis: OilImageAnalysisPayload | null;
  grade_decision_source: GradeDecisionSource | null;
  grade_ai_override_acknowledged: boolean;
}

export interface SyncBatchResult {
  client_uuid: string;
  status: 'created' | 'duplicate' | 'failed';
  id?: string;
  error?: { code: string; message: string };
}

export interface SyncBatchResponse {
  results: SyncBatchResult[];
  summary: { created: number; duplicate: number; failed: number };
}

export interface StationRecommendation {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  capacity_l: number;
  current_volume_l: number;
  remaining_capacity_l: number;
  distance_m: number;
}

export interface StationDeliveryCreateRequest {
  client_uuid: string;
  station_id: string;
  transaction_ids: string[];
  actual_liters: number;
  actual_kg?: number;
  delivered_at?: string;
  note?: string;
  photos?: string[];
}

export interface StationDeliveryResponse extends Omit<StationDeliveryCreateRequest, 'actual_kg'> {
  id: string;
  collector_id: string;
  expected_liters: number;
  expected_kg: number | null;
  actual_kg: number | null;
  variance_kg: number | null;
  mass_source: MassSource;
  has_estimated_mass: boolean;
  variance_l: number;
  variance_pct: number;
  status: DeliveryStatus;
  created_at: string;
}

export interface AdminRecentTransaction {
  id: string;
  merchant_name: string;
  collector_name: string | null;
  actual_liters: number;
  actual_kg: number | null;
  mass_source: MassSource;
  grade: OilGrade | null;
  suspected_adulteration: boolean;
  quality: Quality;
  collected_at: string;
  image_grade_suggestion?: OilGrade | null;
  image_grade_confidence?: ImageGradeConfidence | null;
  grade_decision_source?: GradeDecisionSource | null;
  image_grade_analysis?: OilImageAnalysisPayload | null;
}

export interface AdminStationSummary {
  id: string;
  name: string;
  address: string | null;
  current_volume_l: number;
  capacity_l: number;
  fill_pct: number;
}

export interface AdminMerchantSummary {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  distance_m: number | null;
  status: EntityStatus;
  approval_status: MerchantApprovalStatus;
  rejection_reason: string | null;
  business_type: string | null;
  phone: string | null;
  ward_code: string | null;
  ward_name: string | null;
  avg_daily_liters: number | null;
  last_collected_at: string | null;
  anomaly: boolean;
}

export interface AdminOverviewResponse {
  period: { from: string; to: string };
  totals: { liters: number; transactions: number; active_merchants: number; active_collectors: number };
  orders: { ready: number; assigned: number; collected: number; cancelled: number };
  containers: { at_merchant: number; in_transit: number; at_station: number };
  stations: AdminStationSummary[];
  alerts_open: number;
  daily_liters: Array<{ date: string; liters: number }>;
  recent_transactions: AdminRecentTransaction[];
}

export interface AdminTransactionAnomaly {
  score: number;
  level: AnomalyRiskLevel;
  reasons: string[];
  reason_details?: AdminAnomalyReason[];
  explanation_summary?: string;
  explanation: Record<string, unknown>;
  historySize: number;
}

export interface AdminAnomalyFeedback {
  id: string;
  verdict: AnomalyFeedbackVerdict;
  note: string | null;
  reviewer_user_id: string;
  risk_score_snapshot: number;
  risk_level_snapshot: AnomalyRiskLevel;
  reasons_snapshot: AdminAnomalyReason[];
  created_at: string;
  updated_at: string;
}

export interface AdminAiAnomalyItem {
  id: string;
  transaction_id: string;
  merchant_id: string;
  merchant_name: string;
  collector_name: string | null;
  actual_liters: number;
  actual_kg: number | null;
  quality: Quality;
  grade: OilGrade | null;
  collected_at: string;
  image_grade_suggestion?: OilGrade | null;
  image_grade_confidence?: ImageGradeConfidence | null;
  grade_decision_source?: GradeDecisionSource | null;
  image_grade_analysis?: OilImageAnalysisPayload | null;
  risk_score: number;
  risk_level: AnomalyRiskLevel;
  explanation_summary: string;
  reason_codes: AdminAnomalyReason[];
  history_size: number;
  feedback: AdminAnomalyFeedback | null;
}

export interface AdminAiAnomaliesResponse extends PagedResponse<AdminAiAnomalyItem> {
  window_days: 30 | 90 | 180;
}

export interface AdminAiAnomalyPerformanceResponse {
  window_days: 30 | 90 | 180;
  total_alerts: number;
  reviewed_count: number;
  unreviewed_count: number;
  feedback_coverage_percent: number;
  confirmed_count: number;
  false_positive_count: number;
  unsure_count: number;
  confirmed_rate_percent: number | null;
  false_positive_rate_percent: number | null;
  breakdown_by_risk_level: Array<{ risk_level: AnomalyRiskLevel; count: number }>;
  breakdown_by_reason_code: Array<{ code: string; count: number }>;
  recent_reviewed_items: AdminAiAnomalyItem[];
  explanation: string;
}

export interface AdminReconciliationTransaction {
  id: string;
  merchant_name: string;
  liters: number;
  kilograms: number | null;
  mass_source: MassSource;
  grade: OilGrade | null;
  suspected_adulteration: boolean;
  collected_at: string;
  anomaly?: AdminTransactionAnomaly;
  image_grade_suggestion?: OilGrade | null;
  image_grade_confidence?: ImageGradeConfidence | null;
  grade_decision_source?: GradeDecisionSource | null;
  image_grade_analysis?: OilImageAnalysisPayload | null;
}

export interface AdminReconciliationCollector {
  collector_id: string;
  name: string;
  collected_l: number;
  delivered_l: number;
  variance_l: number;
  collected_kg: number;
  delivered_kg: number;
  variance_kg: number;
  has_estimated_mass: boolean;
  status: 'OK' | 'FLAGGED';
  transactions: AdminReconciliationTransaction[];
}

export interface AdminReconciliationResponse {
  date: string;
  collected_liters: number;
  delivered_liters: number;
  variance_l: number;
  variance_pct: number;
  collected_kg: number;
  delivered_kg: number;
  variance_kg: number;
  variance_kg_pct: number;
  has_estimated_mass: boolean;
  by_collector: AdminReconciliationCollector[];
  undelivered_transactions: AdminReconciliationTransaction[];
}

export interface AdminAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity | null;
  message: string | null;
  details: unknown;
  created_at: string;
  resolved_at: string | null;
}

export type PickupForecastBacktestReliability = 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface AdminPickupForecastBacktestPoint {
  merchant_id: string;
  merchant_name: string;
  collected_at: string;
  predicted_liters: number;
  actual_liters: number;
  absolute_error_liters: number;
  error_percentage_pct: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
  history_sample_size: number;
  direction: 'HIGHER_THAN_ACTUAL' | 'LOWER_THAN_ACTUAL' | 'MATCH';
}

export interface AdminPickupForecastPerformanceResponse {
  window_days: 30 | 90 | 180;
  window_start: string;
  window_end: string;
  sample_count: number;
  mae_liters: number | null;
  wape_pct: number | null;
  bias_liters: number | null;
  accuracy_pct: number | null;
  within_10_pct_count: number;
  within_20_pct_count: number;
  reliability: PickupForecastBacktestReliability;
  points: AdminPickupForecastBacktestPoint[];
  explanation: {
    method: 'ROLLING_ORIGIN';
    summary: string;
    data_leakage_prevention: string;
  };
}

export interface AdminImageGradingPerformanceResponse {
  window_days: 30 | 90 | 180;
  window_start: string;
  window_end: string;
  analyzed_count: number;
  accepted_count: number;
  override_count: number;
  low_confidence_count: number;
  retake_recommended_count: number;
  agreement_count: number;
  agreement_rate_percent: number | null;
  reliability: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
  breakdown_by_confidence: Array<{ confidence: 'LOW' | 'MEDIUM' | 'HIGH'; count: number }>;
  breakdown_by_decision_source: Array<{ source: 'MANUAL' | 'AI_SUGGESTION_ACCEPTED' | 'MANUAL_OVERRIDE_AI'; count: number }>;
  recent_disagreements: Array<{
    transaction_id: string;
    merchant_id: string;
    merchant_name: string;
    collected_at: string;
    suggested_grade: OilGrade | null;
    selected_grade: OilGrade | null;
    confidence: ImageGradeConfidence | null;
    reason_codes: string[];
  }>;
  explanation: string;
}

export interface AdminCollectorSummary {
  id: string;
  display_name: string;
  status: EntityStatus;
  is_active: boolean;
  last_seen_at: string | null;
  wards: Array<{ id: string; code: string; name: string }>;
  user: { id: string; name: string | null; phone: string | null };
  vehicle_type?: string | null;
  max_capacity_l?: number;
  ward_ids?: string[];
}

export interface AdminCollectorPerformance {
  collector_id: string;
  display_name: string;
  liters_7d: number;
  collections_7d: number;
  delivered_liters_7d: number;
  variance_l: number;
  variance_pct: number;
  status: 'OK' | 'FLAGGED';
}
